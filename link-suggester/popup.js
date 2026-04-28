/**
 * popup.js — Link Opportunities
 *
 * Imports embeddings.csv from Screaming Frog into IndexedDB:
 *   1. Parses URL + embedding vector per row
 *   2. Computes the site-wide centroid (mean embedding)
 *   3. Centers and normalizes every vector so query-time similarity is just a dot product
 *   4. Stores pre-centered vectors + norms in IndexedDB (no size limit)
 *   5. Saves API key + model to chrome.storage.local
 */

// ── IndexedDB helpers ──────────────────────────────────────────────────────────
const DB_NAME     = 'LinkOpportunities';
const DB_VERSION  = 1;
const PAGES_STORE = 'pages';
const META_STORE  = 'meta';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(PAGES_STORE))
        db.createObjectStore(PAGES_STORE, { keyPath: 'url' });
      if (!db.objectStoreNames.contains(META_STORE))
        db.createObjectStore(META_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── DOM refs ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput    = document.getElementById('apiKey');
  const toggleKey      = document.getElementById('toggleKey');
  const modelSelect    = document.getElementById('model');
  const dimBadge       = document.getElementById('dim-badge');
  const fileDrop       = document.getElementById('file-drop');
  const csvInput       = document.getElementById('csvFile');
  const fileLabel      = document.getElementById('file-label');
  const importBtn      = document.getElementById('importBtn');
  const cancelBtn      = document.getElementById('cancelBtn');
  const clearBtn       = document.getElementById('clearBtn');
  const statusEl       = document.getElementById('status');
  const progressWrap   = document.getElementById('progress-wrap');
  const progressFill   = document.getElementById('progress-fill');
  const progressLabel  = document.getElementById('progress-label');
  const progressHint   = document.getElementById('progress-hint');
  const statsSection   = document.getElementById('stats-section');

  // Traffic data UI refs
  const trafficFileDrop      = document.getElementById('traffic-file-drop');
  const trafficFileInput     = document.getElementById('trafficFile');
  const trafficFileLabel     = document.getElementById('traffic-file-label');
  const trafficImportBtn     = document.getElementById('trafficImportBtn');
  const trafficStatusEl      = document.getElementById('traffic-status');
  const trafficStatsSection  = document.getElementById('traffic-stats-section');
  const sensitivityField     = document.getElementById('sensitivity-field');
  const sensitivitySelect    = document.getElementById('trafficSensitivity');

  // ── Load saved settings ──────────────────────────────────────────────────────
  const saved = await chrome.storage.local.get(['lo_apiKey', 'lo_model', 'lo_dbStats', 'lo_trafficStats', 'lo_importProgress', 'lo_allTrafficThresholds', 'lo_trafficThresholds']);
  if (saved.lo_apiKey) { apiKeyInput.value = saved.lo_apiKey; checkImportReady(); }
  if (saved.lo_model)  modelSelect.value = saved.lo_model;
  if (saved.lo_dbStats) showStats(saved.lo_dbStats);
  if (saved.lo_trafficStats) showTrafficStats(saved.lo_trafficStats);
  if (saved.lo_allTrafficThresholds) {
    sensitivityField.style.display = 'block';
    // Restore which level is active by matching sessionsP75
    if (saved.lo_trafficThresholds) {
      const active = Object.keys(saved.lo_allTrafficThresholds).find(
        k => saved.lo_allTrafficThresholds[k].sessionsP75 === saved.lo_trafficThresholds.sessionsP75
      ) || '0.50';
      sensitivitySelect.value = active;
    }
  }

  // Resume or finalise any in-progress or just-completed import.
  // On reopen the popup reads storage directly — runtime messages sent while it
  // was closed are gone, so we must handle all terminal states here too.
  if (saved.lo_importProgress) {
    const p = saved.lo_importProgress;
    if (p.status === 'running') {
      importBtn.disabled = true;
      if (p.filename) fileLabel.textContent = p.filename;
      setProgress(progressPct(p), p.message || 'Import in progress…');
      showCancelBtn(true);
      startProgressListener();
    } else {
      // 'done', 'error', or 'cancelled' — finalise immediately
      handleProgressValue(p);
    }
  }

  // ── API key visibility toggle ────────────────────────────────────────────────
  toggleKey.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    toggleKey.textContent = apiKeyInput.type === 'password' ? '👁' : '🙈';
  });

  apiKeyInput.addEventListener('input', checkImportReady);

  // ── File picker + drag & drop ────────────────────────────────────────────────
  fileDrop.addEventListener('click', () => csvInput.click());
  csvInput.addEventListener('change', () => {
    if (csvInput.files.length) { fileLabel.textContent = csvInput.files[0].name; checkImportReady(); }
  });
  fileDrop.addEventListener('dragover',  (e) => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
  fileDrop.addEventListener('dragleave', ()  => fileDrop.classList.remove('drag-over'));
  fileDrop.addEventListener('drop', (e) => {
    e.preventDefault(); fileDrop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith('.csv')) {
      const dt = new DataTransfer(); dt.items.add(file); csvInput.files = dt.files;
      fileLabel.textContent = file.name; checkImportReady();
    }
  });

  function checkImportReady() {
    importBtn.disabled = !(apiKeyInput.value.trim() && csvInput.files.length);
  }

  // ── Traffic file picker + drag & drop ───────────────────────────────────────
  trafficFileDrop.addEventListener('click', () => trafficFileInput.click());
  trafficFileInput.addEventListener('change', () => {
    if (trafficFileInput.files.length) {
      trafficFileLabel.textContent = trafficFileInput.files[0].name;
      trafficImportBtn.disabled = false;
    }
  });
  trafficFileDrop.addEventListener('dragover',  (e) => { e.preventDefault(); trafficFileDrop.classList.add('drag-over'); });
  trafficFileDrop.addEventListener('dragleave', ()  => trafficFileDrop.classList.remove('drag-over'));
  trafficFileDrop.addEventListener('drop', (e) => {
    e.preventDefault(); trafficFileDrop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith('.csv')) {
      const dt = new DataTransfer(); dt.items.add(file); trafficFileInput.files = dt.files;
      trafficFileLabel.textContent = file.name; trafficImportBtn.disabled = false;
    }
  });

  // ── Traffic import button ────────────────────────────────────────────────────
  trafficImportBtn.addEventListener('click', async () => {
    const file = trafficFileInput.files[0];
    if (!file) return;
    trafficImportBtn.disabled = true;
    trafficStatusEl.innerHTML = '<span style="font-size:12px;color:#64748b;">Parsing…</span>';
    try {
      const text   = await file.text();
      const result = parseTrafficCSV(text);
      if (result.count === 0) throw new Error('No matching rows found. Make sure the CSV has URL, Sessions, and Conversions columns.');

      // Default to the balanced 50% level; user can switch via dropdown after import
      const activeLevel = sensitivitySelect.value || '0.50';
      const thresholds  = result.allThresholds[activeLevel];
      const stats       = { pages: result.count, sessionsP75: thresholds.sessionsP75, conversionsP75: thresholds.conversionsP75, date: new Date().toISOString() };
      await chrome.storage.local.set({
        lo_trafficData:          result.data,
        lo_trafficThresholds:    thresholds,
        lo_allTrafficThresholds: result.allThresholds,
        lo_trafficStats:         stats,
      });

      sensitivityField.style.display = 'block';
      sensitivitySelect.value        = activeLevel;
      showTrafficStats(stats);
      trafficStatusEl.innerHTML = '<span class="badge badge-green">✅ Imported ' + result.count.toLocaleString() + ' pages</span>';
    } catch (err) {
      trafficStatusEl.innerHTML = '<span class="badge badge-red">❌ Error</span> ' + err.message;
      console.error('[LinkOpportunities traffic]', err);
    }
    trafficImportBtn.disabled = false;
  });

  // ── Sensitivity dropdown ──────────────────────────────────────────────────────
  sensitivitySelect.addEventListener('change', async () => {
    const level   = sensitivitySelect.value;
    const stored  = await chrome.storage.local.get(['lo_allTrafficThresholds', 'lo_trafficStats']);
    if (!stored.lo_allTrafficThresholds) return;
    const thresholds = stored.lo_allTrafficThresholds[level];
    if (!thresholds) return;
    const stats = { ...(stored.lo_trafficStats || {}), sessionsP75: thresholds.sessionsP75, conversionsP75: thresholds.conversionsP75 };
    await chrome.storage.local.set({ lo_trafficThresholds: thresholds, lo_trafficStats: stats });
    showTrafficStats(stats);
  });

  // ── Import button ────────────────────────────────────────────────────────────
  // Parsing happens in the popup (fast, synchronous). Everything else —
  // embedding API calls, centroid math, IndexedDB writes — runs in the
  // background service worker so the import survives the popup being closed.
  importBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const model  = modelSelect.value;
    const file   = csvInput.files[0];
    if (!apiKey || !file) return;

    importBtn.disabled = true;
    setProgress(2, 'Reading file…');

    try {
      const text  = await file.text();
      setProgress(5, 'Parsing CSV…');
      const pages = parsePagesCSV(text);
      if (pages.length === 0)
        throw new Error('No valid rows found. Make sure the CSV has URL and Title columns.');

      // Save API key + model immediately so they're restored if the popup closes
      // before the import finishes (background saves them again on completion).
      await chrome.storage.local.set({ lo_apiKey: apiKey, lo_model: model });

      // Get the current tab ID so the background can inject the content script
      // once the import finishes (best-effort).
      let tabId;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && tab.url?.startsWith('http')) tabId = tab.id;
      } catch { /* ignore */ }

      // Signal background to start — it will write lo_importProgress to storage
      // as it goes; we poll that below. The popup can close without losing work.
      await chrome.storage.local.set({
        lo_importProgress: { status: 'running', done: 0, total: pages.length, eta: 0, message: `Starting…`, filename: file.name }
      });
      chrome.runtime.sendMessage({ action: 'startImport', pages, apiKey, model, tabId });

      setProgress(8, 'Starting…');
      showCancelBtn(true);
      startProgressListener();

    } catch (err) {
      setStatus('error', `<span class="badge badge-red">❌ Error</span> ${err.message}`);
      console.error('[LinkOpportunities]', err);
      importBtn.disabled = false;
      hideProgress();
    }
  });

  // ── Cancel button ─────────────────────────────────────────────────────────────
  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling…';
    // Signal the background to stop after the current batch finishes.
    await chrome.storage.local.set({ lo_importProgress: { status: 'cancelled' } });
  });

  // ── Real-time progress via chrome.storage.onChanged ───────────────────────────
  // Fires the instant the background worker writes a new progress value — no
  // polling delay, no frozen bar. Falls back to a one-time read on open so the
  // correct state is shown before any new writes arrive.
  function progressPct(p) {
    if (!p || !p.total) return 8;
    return Math.round(8 + (p.done / p.total) * 80);
  }

  // Direct runtime message from background — fires instantly as each batch completes.
  // This is more reliable than storage.onChanged in popup contexts.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'importProgress') handleProgressValue(msg.progress);
  });

  function startProgressListener() {
    // Show the "safe to close" hint after a short delay
    setTimeout(() => { if (progressHint) progressHint.style.display = 'block'; }, 3000);
  }

  function stopProgressListener() {
    if (progressHint) progressHint.style.display = 'none';
  }

  async function handleProgressValue(p) {
    if (!p) return;

    if (p.status === 'running') {
      setProgress(progressPct(p), p.message || 'Working…');

    } else if (p.status === 'done') {
      stopProgressListener();
      showCancelBtn(false);
      setProgress(100, 'Done!');
      const stored = await chrome.storage.local.get('lo_dbStats');
      const stats  = stored.lo_dbStats;
      if (stats) {
        if (stats.dimension === 3072) modelSelect.value = 'text-embedding-3-large';
        dimBadge.textContent   = `${stats.dimension}-d`;
        dimBadge.style.display = 'inline';
        showStats(stats);
        setStatus('success', `<span class="badge badge-green">✅ Indexed ${stats.pages.toLocaleString()} pages</span>`);
        clearBtn.style.display = 'block';
        document.getElementById('clear-divider').style.display = 'block';
      }
      importBtn.disabled = false;
      // Inject the content script into the active tab so the 🔗 button appears
      // immediately — covers cases where the background's injection attempt failed.
      injectContentScriptIntoActiveTab();
      setTimeout(async () => { hideProgress(); await chrome.storage.local.remove('lo_importProgress'); }, 1500);

    } else if (p.status === 'error') {
      stopProgressListener();
      showCancelBtn(false);
      setStatus('error', `<span class="badge badge-red">❌ Error</span> ${p.message}`);
      importBtn.disabled = false;
      hideProgress();
      await chrome.storage.local.remove('lo_importProgress');

    } else if (p.status === 'cancelled') {
      stopProgressListener();
      showCancelBtn(false);
      setStatus('', '<span style="color:#64748b;font-size:12px;">Import cancelled.</span>');
      importBtn.disabled = false;
      hideProgress();
      await chrome.storage.local.remove('lo_importProgress');
    }
  }

  function showCancelBtn(show) {
    cancelBtn.style.display = show ? 'inline-flex' : 'none';
    cancelBtn.disabled      = false;
    cancelBtn.textContent   = '✕ Cancel';
  }

  // ── Clear button ─────────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', async () => {
    const db = await openDB();
    const tx = db.transaction([PAGES_STORE, META_STORE], 'readwrite');
    tx.objectStore(PAGES_STORE).clear();
    tx.objectStore(META_STORE).clear();
    await chrome.storage.local.remove(['lo_dbStats']);
    statsSection.style.display = 'none';
    clearBtn.style.display = 'none';
    document.getElementById('clear-divider').style.display = 'none';
    fileLabel.textContent = 'Click to select or drag & drop';
    checkImportReady();
    setStatus('', '');
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function setProgress(pct, label) {
    progressWrap.style.display = 'flex';
    progressFill.style.width   = pct + '%';
    progressLabel.textContent  = label;
  }
  function hideProgress() {
    progressWrap.style.display = 'none';
    progressFill.style.width   = '0%';
  }
  function setStatus(type, html) { statusEl.innerHTML = html; }

  function showStats(stats) {
    statsSection.style.display = 'block';
    document.getElementById('stat-pages').textContent =
      (stats.pages || 0).toLocaleString();
    document.getElementById('stat-model').textContent =
      stats.model || '—';
    document.getElementById('stat-date').textContent = stats.date
      ? new Date(stats.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    clearBtn.style.display = 'block';
    document.getElementById('clear-divider').style.display = 'block';
  }

  function showTrafficStats(stats) {
    trafficStatsSection.style.display = 'block';
    document.getElementById('stat-traffic-pages').textContent  = (stats.pages || 0).toLocaleString();
    document.getElementById('stat-sessions-p75').textContent   = stats.sessionsP75 != null ? stats.sessionsP75.toLocaleString() : '—';
    document.getElementById('stat-conv-p75').textContent       = stats.conversionsP75 != null ? stats.conversionsP75.toLocaleString() : '—';
    document.getElementById('stat-traffic-date').textContent   = stats.date
      ? new Date(stats.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    // Update label to reflect active sensitivity level
    const level  = sensitivitySelect.value || '0.50';
    const pctMap = { '0.25': '25%', '0.50': '50%', '0.75': '75%' };
    const pct    = pctMap[level] || '50%';
    const sessLabelEl = document.getElementById('stat-sessions-label');
    const convLabelEl = document.getElementById('stat-conv-label');
    if (sessLabelEl) sessLabelEl.textContent = `📈 High traffic (top ${pct} vol.)`;
    if (convLabelEl) convLabelEl.textContent = `💰 Conversion driver (top ${pct} vol.)`;
  }
});

// ── CSV parsing ────────────────────────────────────────────────────────────────
/**
 * Parses a simple pages CSV with URL, Title, and (optionally) Meta Description.
 * Column names are auto-detected — works with exports from GSC, Ahrefs,
 * Screaming Frog (standard crawl export), or any SEO tool.
 *
 * Returns: [{ url, title, text }]
 *   text = the string that will be sent to OpenAI for embedding
 */
function parsePagesCSV(csvText) {
  csvText = csvText.replace(/^﻿/, ''); // strip UTF-8 BOM

  const lines = csvText.split('\n');
  if (lines.length < 2) throw new Error('CSV appears to be empty.');

  // Find header row (scan first 5 rows in case of GA4-style preamble rows)
  let headerIdx = -1;
  let headers;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const cols    = parseCSVRow(lines[i]);
    const cleaned = cols.map(h => h.trim().replace(/^﻿?"?|"?$/g, '').toLowerCase());
    if (cleaned.some(h => /^(address|url|page|full url|landing page|page path)/.test(h))) {
      headerIdx = i; headers = cleaned; break;
    }
  }
  if (headerIdx === -1) throw new Error('No URL column found. Make sure the CSV has a column named Address, URL, or Page.');

  const urlIdx     = headers.findIndex(h => /^(address|url|full url|page path|page|landing page)/.test(h));
  const titleIdx   = headers.findIndex(h => /^(title|page title|title 1|meta title|og.?title|h1)/.test(h));
  const metaIdx    = headers.findIndex(h => /^(meta description|description|meta desc|description 1)/.test(h));
  const inlinksIdx = headers.findIndex(h => /^(inlinks|internal links|in links|internal inlinks|inbound internal links)/.test(h));
  // Collect up to the first two H2 columns (H2-1, H2-2, h2, etc.) — optional
  const h2Indexes  = headers
    .map((h, i) => (/^h2/.test(h) ? i : -1))
    .filter(i => i >= 0)
    .slice(0, 2);

  if (urlIdx === -1) throw new Error('No URL/Address column found.');

  const pages = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const row    = parseCSVRow(line);
    const rawUrl = (row[urlIdx] || '').trim().replace(/^"|"$/g, '');
    if (!rawUrl || rawUrl.startsWith('#')) continue;

    const url = normalizeUrl(rawUrl);
    if (!url) continue;

    const rawTitle   = titleIdx   >= 0 ? (row[titleIdx]   || '').trim().replace(/^"|"$/g, '') : '';
    const rawMeta    = metaIdx    >= 0 ? (row[metaIdx]    || '').trim().replace(/^"|"$/g, '') : '';
    const rawInlinks = inlinksIdx >= 0 ? (row[inlinksIdx] || '').trim().replace(/^"|"$/g, '') : null;

    // Collect up to two H2 values, skipping blanks
    const h2Values = h2Indexes
      .map(i => (row[i] || '').trim().replace(/^"|"$/g, ''))
      .filter(Boolean);

    // Derive a human-readable title from the URL slug if no title column present
    const title = rawTitle || slugToTitle(url);

    // Build the text to embed: title + H2s (if present) + meta description + slug cue
    // Keeping it short (~50–150 tokens) is fast and cheap without losing semantic quality.
    const slug  = slugToReadable(url);
    const parts = [title];
    if (h2Values.length) parts.push(...h2Values);
    if (rawMeta && rawMeta !== title) parts.push(rawMeta);
    else if (!h2Values.length && slug && slug.toLowerCase() !== title.toLowerCase()) parts.push(slug);
    const text = parts.join('. ').slice(0, 600); // cap at 600 chars (~150 tokens)

    // Parse inlinks — null means column not present (boost won't be applied)
    const internalLinks = rawInlinks !== null ? (parseInt(rawInlinks.replace(/,/g, ''), 10) || 0) : null;

    pages.push({ url, title, text, internalLinks });
  }

  return pages;
}

// ── OpenAI batch embedding ──────────────────────────────────────────────────────
/**
 * Sends texts to OpenAI embeddings API in batches of BATCH_SIZE.
 * Returns a flat array of float[] embeddings in the same order as the input.
 *
 * onProgress(pct 0–1, etaSeconds)
 */
async function generateEmbeddings(texts, apiKey, model, onProgress) {
  const BATCH_SIZE = 100; // safe for rate limits; ~10k tokens per request
  const results    = new Array(texts.length);
  const total      = texts.length;
  let   done       = 0;
  const startTime  = Date.now();

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch   = texts.slice(start, start + BATCH_SIZE);
    const indexes = batch.map((_, i) => start + i);

    // Retry once on 429 with exponential backoff
    let attempt = 0;
    while (attempt < 3) {
      try {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body:    JSON.stringify({ input: batch, model }),
        });

        if (res.status === 429) {
          const wait = Math.pow(2, attempt) * 2000;
          await new Promise(r => setTimeout(r, wait));
          attempt++; continue;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg  = body.error?.message || `HTTP ${res.status}`;
          if (res.status === 401) throw new Error('Invalid API key — update it in the extension popup.');
          throw new Error(`OpenAI error: ${msg}`);
        }

        const data = await res.json();
        // data.data is [{index, embedding}] — preserve order
        for (const item of data.data) {
          results[indexes[item.index]] = item.embedding;
        }
        done += batch.length;
        break; // success — exit retry loop

      } catch (err) {
        if (attempt >= 2) throw err;
        attempt++;
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    const pct     = done / total;
    const elapsed = (Date.now() - startTime) / 1000;
    const eta     = done > 0 ? Math.round((elapsed / done) * (total - done)) : 0;
    onProgress?.(pct, eta);

    // Small pause between batches to stay well inside rate limits
    if (start + BATCH_SIZE < texts.length) await new Promise(r => setTimeout(r, 150));
  }

  return results;
}

// ── Math helpers ───────────────────────────────────────────────────────────────
function computeCentroid(embeddings) {
  const dim      = embeddings[0].length;
  const centroid = new Float32Array(dim);
  for (const e of embeddings) for (let i = 0; i < dim; i++) centroid[i] += e[i];
  for (let i = 0; i < dim; i++) centroid[i] /= embeddings.length;
  return centroid;
}

/**
 * Subtract centroid and L2-normalize each vector.
 * Pre-normalizing means query-time similarity = just a dot product.
 */
function centerAndNormalize(pages, centroid) {
  return pages.map(p => {
    const dim = p.embedding.length;
    const centered = new Float32Array(dim);
    let normSq = 0;
    for (let i = 0; i < dim; i++) {
      centered[i] = p.embedding[i] - centroid[i];
      normSq     += centered[i] * centered[i];
    }
    const norm = Math.sqrt(normSq) || 1;
    for (let i = 0; i < dim; i++) centered[i] /= norm;
    return { ...p, centeredEmbedding: centered, norm };
  });
}

/**
 * Random projection: 1536-d → 2-d for visualization.
 * Uses a fixed seed so the layout is stable across re-imports.
 */
function computeRandomProjection(pages) {
  if (!pages.length) return [];
  const dim = pages[0].centeredEmbedding.length;

  // Generate two random unit vectors (seeded via a simple LCG)
  let seed = 42;
  function rand() { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; }

  const v1 = new Float32Array(dim), v2 = new Float32Array(dim);
  let n1 = 0, n2 = 0;
  for (let i = 0; i < dim; i++) {
    v1[i] = rand() * 2 - 1; n1 += v1[i] * v1[i];
    v2[i] = rand() * 2 - 1; n2 += v2[i] * v2[i];
  }
  n1 = Math.sqrt(n1); n2 = Math.sqrt(n2);
  for (let i = 0; i < dim; i++) { v1[i] /= n1; v2[i] /= n2; }

  return pages.map(p => {
    const e = p.centeredEmbedding;
    let x = 0, y = 0;
    for (let i = 0; i < dim; i++) { x += e[i] * v1[i]; y += e[i] * v2[i]; }
    return { url: p.url, title: p.title, x, y };
  });
}

// ── IndexedDB writes ───────────────────────────────────────────────────────────
async function writeToIndexedDB(pages, centroid, dimension, model) {
  const db = await openDB();

  // Write pages in batches of 500 to avoid transaction timeouts
  const BATCH = 500;
  for (let start = 0; start < pages.length; start += BATCH) {
    const batch = pages.slice(start, start + BATCH);
    await new Promise((resolve, reject) => {
      const tx    = db.transaction(PAGES_STORE, 'readwrite');
      const store = tx.objectStore(PAGES_STORE);
      for (const p of batch) {
        const record = {
          url:       p.url,
          title:     p.title,
          // Store as ArrayBuffer — efficient binary storage
          embedding: p.centeredEmbedding.buffer.slice(0),
        };
        // Only store internalLinks if the column was present in the CSV
        if (p.internalLinks !== null && p.internalLinks !== undefined)
          record.internalLinks = p.internalLinks;
        store.put(record);
      }
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  // Write metadata
  await new Promise((resolve, reject) => {
    const tx    = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    store.put({ key: 'centroid',  data: centroid.buffer.slice(0) });
    store.put({ key: 'settings',  data: JSON.stringify({ dimension, model, count: pages.length, importDate: new Date().toISOString() }) });
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function writeProjection(points) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx    = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    store.put({ key: 'projection', data: JSON.stringify(points) });
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  raw = raw.trim().replace(/^["']|["']$/g, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    let path = u.pathname;
    if (!path.endsWith('/')) path += '/';
    return u.origin + path;
  } catch { return raw; }
}

function slugToTitle(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const slug  = parts[parts.length - 1] || parts[parts.length - 2] || '';
    return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || url;
  } catch { return url; }
}

/** Returns the last meaningful path segment as readable words (lowercase). */
function slugToReadable(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const slug  = parts[parts.length - 1] || parts[parts.length - 2] || '';
    return slug.replace(/-/g, ' ').trim();
  } catch { return ''; }
}

function parseCSVRow(row) {
  const result = []; let current = '', inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else current += ch;
  }
  result.push(current);
  return result;
}

// ── Traffic CSV parsing ────────────────────────────────────────────────────────
/**
 * Parses a GA4 traffic export CSV.
 * Auto-detects URL, Sessions, and Conversions columns.
 *
 * Returns:
 *   data:       { [pathname]: { sessions, conversions } }
 *   thresholds: { sessionsP75, conversionsP75 }
 *   count:      number of valid rows
 */
function parseTrafficCSV(csvText) {
  csvText = csvText.replace(/^﻿/, ''); // strip BOM

  // GA4 sometimes prepends junk rows before the header — find the header row
  const lines = csvText.split('\n');
  let headerIdx = -1;
  let headers;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const cols = parseCSVRow(lines[i]);
    const cleaned = cols.map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
    const hasUrl  = cleaned.some(h => /^(address|url|page|landing page|page path|page path and screen class)/.test(h));
    const hasSess = cleaned.some(h => /session|visit|user/.test(h));
    if (hasUrl && hasSess) { headerIdx = i; headers = cleaned; break; }
  }
  if (headerIdx === -1) throw new Error('Could not find URL + Sessions columns. Export from GA4 with Page, Sessions, and Conversions.');

  const clean   = h => h.trim().replace(/^"|"$/g, '').toLowerCase();
  const urlIdx  = headers.findIndex(h => /^(address|url|page|landing page|page path|page path and screen class)/.test(h));
  const sessIdx = headers.findIndex(h => /session|visit/.test(h) && !/per|duration/.test(h));
  const convIdx = headers.findIndex(h => /conversion|goal|key event/.test(h) && !/rate/.test(h));

  if (urlIdx  === -1) throw new Error('No URL/Page column found.');
  if (sessIdx === -1) throw new Error('No Sessions column found.');
  // Conversions column is optional — we'll still show High Traffic without it

  const data = {};
  const sessionValues    = [];
  const conversionValues = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row  = parseCSVRow(line);
    const raw  = (row[urlIdx] || '').trim().replace(/^"|"$/g, '');
    if (!raw) continue;

    // Normalize to pathname with trailing slash
    let path;
    try {
      const u = raw.startsWith('http') ? new URL(raw) : new URL('https://placeholder.com' + raw);
      path = u.pathname;
      if (!path.endsWith('/')) path += '/';
    } catch { continue; }

    const sessions    = parseInt((row[sessIdx] || '0').replace(/,/g, ''), 10) || 0;
    const conversions = convIdx >= 0 ? (parseInt((row[convIdx] || '0').replace(/,/g, ''), 10) || 0) : 0;

    data[path] = { sessions, conversions };
    sessionValues.push(sessions);
    if (convIdx >= 0) conversionValues.push(conversions);
  }

  const count = Object.keys(data).length;
  if (count === 0) throw new Error('No valid rows found in the CSV.');

  // Pre-compute thresholds for all three sensitivity levels so the user can
  // switch between them instantly without re-importing the CSV.
  // Keys must match the <option value="..."> strings in popup.html exactly.
  const allThresholds = {
    '0.25': { sessionsP75: volumeThreshold(sessionValues, 0.25), conversionsP75: conversionValues.length ? volumeThreshold(conversionValues, 0.25) : 0 },
    '0.50': { sessionsP75: volumeThreshold(sessionValues, 0.50), conversionsP75: conversionValues.length ? volumeThreshold(conversionValues, 0.50) : 0 },
    '0.75': { sessionsP75: volumeThreshold(sessionValues, 0.75), conversionsP75: conversionValues.length ? volumeThreshold(conversionValues, 0.75) : 0 },
  };
  // Default active threshold (balanced 50%)
  const thresholds = allThresholds['0.50'];

  return { data, thresholds, allThresholds, count };
}

/**
 * Volume-based threshold: returns the minimum session/conversion count a page
 * needs to be in the group of pages that collectively drive the top SHARE of
 * total volume. E.g. share=0.50 → the pages that together account for 50% of
 * all sessions; the lowest value in that group becomes the threshold.
 *
 * This is more meaningful than a percentile for right-skewed traffic data —
 * it identifies pages with genuinely outsized impact rather than pages that
 * are merely above the median.
 */
function volumeThreshold(values, share) {
  if (!values.length) return 0;
  const sorted     = [...values].sort((a, b) => b - a); // descending
  const totalVol   = sorted.reduce((s, v) => s + v, 0);
  const target     = totalVol * share;
  let   cumulative = 0;
  for (const v of sorted) {
    cumulative += v;
    if (cumulative >= target) return v; // minimum value in the top-share group
  }
  return sorted[sorted.length - 1];
}

// ── Post-import injection ──────────────────────────────────────────────────────
/**
 * After a successful import, inject content.js + styles.css into the active tab
 * so the 🔗 button appears immediately without a page refresh.
 * The window.__loInitialized guard in content.js makes re-injection a safe no-op
 * if the script is already running.
 */
function injectContentScriptIntoActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    // Skip chrome://, edge://, about: etc. — scripting API can't touch these
    if (!tab.url || !/^https?:\/\//.test(tab.url)) return;

    // Set __loForceReinit BEFORE injecting content.js so the fresh script
    // removes any stale UI and re-registers its event listeners, even when
    // window.__loInitialized is already true from a now-invalidated old context.
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   () => { window.__loForceReinit = true; },
    }).then(() => {
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }).catch(() => {});
  });
}
