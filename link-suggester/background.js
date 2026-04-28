/**
 * background.js — Service Worker
 *
 * Handles two jobs:
 *   1. Proxy OpenAI embedding requests (content scripts may be blocked by page CSPs)
 *   2. Read from the extension's IndexedDB and compute similarity — content scripts
 *      cannot access the extension's IndexedDB (they run under the page's origin).
 *
 * Message actions:
 *   embed     → { text, apiKey, model }                    → { embedding }
 *   findLinks → { text, apiKey, model, topK, currentUrl }  → { results: [{url, title, sim}] }
 */

// ── IndexedDB helpers (extension origin — same DB the popup writes to) ─────────
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
        db.createObjectStore(META_STORE,  { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── In-memory cache (lives as long as the service worker stays warm) ───────────
let _cachedPages    = null;
let _cachedCentroid = null;
let _cacheKey       = null; // importDate string — refreshed when user re-imports

async function loadIndex() {
  const db       = await openDB();
  const settings = await dbGet(db, META_STORE, 'settings');
  const importDate = settings?.data
    ? JSON.parse(settings.data).importDate
    : '';

  if (_cachedPages && _cacheKey === importDate) {
    return { pages: _cachedPages, centroid: _cachedCentroid };
  }

  const [rawPages, centroidMeta] = await Promise.all([
    dbGetAll(db, PAGES_STORE),
    dbGet(db, META_STORE, 'centroid'),
  ]);

  if (!rawPages.length)
    throw new Error('Index is empty. Re-import your embeddings.csv from the extension popup.');
  if (!centroidMeta)
    throw new Error('Centroid missing. Re-import your embeddings.csv from the extension popup.');

  _cachedPages = rawPages.map(p => ({
    url:           p.url,
    title:         p.title,
    embedding:     new Float32Array(p.embedding),
    // internalLinks is only present if the import CSV had an inlinks column
    internalLinks: p.internalLinks ?? null,
  }));
  _cachedCentroid = new Float32Array(centroidMeta.data);
  _cacheKey       = importDate;

  return { pages: _cachedPages, centroid: _cachedCentroid };
}

// ── Context menu ───────────────────────────────────────────────────────────────
// Chrome captures selectionText before the menu appears — no getSelection() needed.
// This is the most reliable way to read selected text in Google Docs, WordPress, etc.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'lo-find-links',
    title:    'Find link opportunities for "%s"',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'lo-find-links' && info.selectionText && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'contextMenuTrigger',
      text:   info.selectionText.trim(),
    });
  }
});

// ── Keepalive alarm ─────────────────────────────────────────────────────────────
// MV3 service workers terminate after ~30s of inactivity. During a long import
// (1–3 minutes) we create an alarm that fires every 20s to keep the SW alive.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'lo_keepalive') { /* no-op — firing the alarm keeps the SW alive */ }
});

// ── Message router ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'embed') {
    embedText(msg.text, msg.apiKey, msg.model)
      .then(embedding => sendResponse({ embedding }))
      .catch(err      => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === 'findLinks') {
    findLinks(msg.text, msg.apiKey, msg.model, msg.topK || 6, msg.currentUrl)
      .then(results => sendResponse({ results }))
      .catch(err    => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === 'searchByUrl') {
    searchByUrl(msg.query, msg.topK || 6)
      .then(results => sendResponse({ results }))
      .catch(err    => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === 'startImport') {
    // Kick off import in background — popup can close safely after this.
    runImport(msg.pages, msg.apiKey, msg.model, msg.tabId)
      .catch(err => chrome.storage.local.set({
        lo_importProgress: { status: 'error', message: err.message }
      }));
    sendResponse({ ok: true });
    return true;
  }
});

// ── OpenAI embed ───────────────────────────────────────────────────────────────
async function embedText(text, apiKey, model) {
  if (!apiKey) throw new Error('No OpenAI API key set. Add it in the extension popup.');

  const input = text.slice(0, 32000);

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input, model: model || 'text-embedding-3-small' }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg  = body.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('Invalid API key — update it in the extension popup.');
    if (res.status === 429) throw new Error('OpenAI rate limit. Wait a moment and try again.');
    throw new Error(`OpenAI error: ${msg}`);
  }

  const data = await res.json();
  return data.data[0].embedding; // float[]
}

// ── Full pipeline: embed → center → score → return top K ──────────────────────
async function findLinks(text, apiKey, model, topK, currentUrl) {
  // 1. Embed anchor text
  const rawEmbedding = await embedText(text, apiKey, model);

  // 2. Load pages + centroid from extension's IndexedDB
  const { pages, centroid } = await loadIndex();

  // 3. Load optional traffic data — boost is skipped entirely if not imported
  const trafficStored = await chrome.storage.local.get(['lo_trafficData', 'lo_trafficThresholds']);
  const trafficData   = trafficStored.lo_trafficData   || null;
  const thresholds    = trafficStored.lo_trafficThresholds || null;

  // 4. Center + L2-normalize query (same transform applied to docs at import time)
  const dim    = rawEmbedding.length;
  const qVec   = new Float32Array(dim);
  let   normSq = 0;
  for (let i = 0; i < dim; i++) {
    qVec[i]  = rawEmbedding[i] - centroid[i];
    normSq  += qVec[i] * qVec[i];
  }
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < dim; i++) qVec[i] /= norm;

  // 5. Score all pages — dot product = cosine similarity on pre-normalized vecs.
  // No positive-only threshold: some valid pages (e.g. tightly clustered
  // /prescription/ drug pages) sit in a direction that produces slightly negative
  // centered cosine values even when genuinely relevant. Sort order handles quality.
  const normalizedCurrent = normalizeUrl(currentUrl || '');
  const scores = [];

  for (const page of pages) {
    if (normalizedCurrent && page.url === normalizedCurrent) continue;
    const emb = page.embedding;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += qVec[i] * emb[i];

    // Optional inlink boost: pages with fewer internal links pointing to them
    // get a small score boost — surfaces underlinked pages that deserve more equity.
    // Boost = 0 when internalLinks data is absent (column not in import CSV).
    // Uses log scale so impact tapers off smoothly: ~15% at 0 links → ~0% at 50 links.
    const iBoost = inlinkBoost(page.internalLinks);

    // Optional traffic/conversion boost — only applied when traffic data has been imported.
    // Semantic relevance remains the primary signal; these are small secondary adjustments.
    const tBoost = getTrafficBoost(page.url, trafficData, thresholds);

    scores.push({ url: page.url, title: page.title, sim: dot * (1 + iBoost + tBoost) });
  }

  scores.sort((a, b) => b.sim - a.sim);
  return scores.slice(0, topK);
}

// ── Inlink boost ───────────────────────────────────────────────────────────────
/**
 * Returns a small additive multiplier (0–0.15) based on internal link count.
 * Reaches zero at CEILING inlinks so well-linked pages get no artificial boost.
 * Returns 0 if internalLinks is null (data not available — silently skipped).
 */
function inlinkBoost(internalLinks) {
  if (internalLinks === null || internalLinks === undefined) return 0;
  const CEILING = 50;  // pages with 50+ inlinks get no boost
  const MAX     = 0.15; // max 15% boost for a page with 0 inlinks
  return Math.max(0, MAX * (1 - Math.log1p(internalLinks) / Math.log1p(CEILING)));
}

// ── Traffic / conversion boost ─────────────────────────────────────────────────
/**
 * Returns a small additive multiplier based on traffic/conversion data.
 * Only applied when traffic data has been imported — returns 0 if not available.
 * Boosts are intentionally modest so semantic relevance stays the primary signal:
 *   Top performer  (high traffic + high conversions) → +15%
 *   Conversion driver (conversions above threshold)  → +10%
 *   High traffic  (sessions above threshold)         → +8%
 */
function getTrafficBoost(url, trafficData, thresholds) {
  if (!trafficData || !thresholds) return 0;
  try {
    let path = new URL(url).pathname;
    if (!path.endsWith('/')) path += '/';
    const data = trafficData[path];
    if (!data) return 0;
    const highTraffic = data.sessions    >= thresholds.sessionsP75;
    const convDriver  = data.conversions >= thresholds.conversionsP75;
    if (highTraffic && convDriver) return 0.15;
    if (convDriver)                return 0.10;
    if (highTraffic)               return 0.08;
  } catch { /* ignore malformed URL */ }
  return 0;
}

// ── Text search across index (URL / title substring match) ────────────────────
/**
 * Lets users find pages by URL path or title regardless of similarity score.
 * Useful for verifying a directory (e.g. "/prescription/") is indexed.
 */
async function searchByUrl(query, topK) {
  const { pages } = await loadIndex();
  const q = query.toLowerCase();
  const matches = pages
    .filter(p => p.url.toLowerCase().includes(q) || p.title.toLowerCase().includes(q))
    .slice(0, topK)
    .map(p => ({ url: p.url, title: p.title, sim: 0 }));
  return matches;
}

// ── Import pipeline (runs in SW — survives popup close) ───────────────────────
/**
 * Full import pipeline: embed → centroid → normalize → IndexedDB → projection.
 * Progress is written to chrome.storage.local so the popup can poll it even
 * after it has been closed and reopened.
 */
async function runImport(pages, apiKey, model, tabId) {
  // Keep the service worker alive for the duration of the import.
  chrome.alarms.create('lo_keepalive', { periodInMinutes: 0.33 });

  try {
    const total     = pages.length;
    const BATCH     = 100;
    const embeddings = new Array(total);
    let   done      = 0;
    const t0        = Date.now();

    await setProgress({ done: 0, total, eta: 0, message: `Generating embeddings for ${total.toLocaleString()} pages…` });

    for (let start = 0; start < total; start += BATCH) {
      // Check for cancellation at the top of every batch
      const cancelCheck = await chrome.storage.local.get('lo_importProgress');
      if (cancelCheck.lo_importProgress?.status === 'cancelled') return;

      const batch   = pages.slice(start, start + BATCH);
      const texts   = batch.map(p => p.text);
      const indexes = batch.map((_, i) => start + i);

      let attempt = 0;
      while (attempt < 3) {
        try {
          const res = await fetch('https://api.openai.com/v1/embeddings', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body:    JSON.stringify({ input: texts, model }),
          });
          if (res.status === 429) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
            attempt++; continue;
          }
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            const errMsg = body.error?.message || `HTTP ${res.status}`;
            if (res.status === 401) throw new Error('Invalid API key — update it in the extension popup.');
            throw new Error(`OpenAI error: ${errMsg}`);
          }
          const data = await res.json();
          for (const item of data.data) embeddings[indexes[item.index]] = item.embedding;
          done += batch.length;
          break;
        } catch (err) {
          if (attempt >= 2) throw err;
          attempt++;
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      const elapsed = (Date.now() - t0) / 1000;
      const eta     = done > 0 ? Math.round((elapsed / done) * (total - done)) : 0;
      const etaStr  = eta > 0 ? ` · ~${eta}s left` : '';
      await setProgress({ done, total, eta, message: `Embedding ${done.toLocaleString()} / ${total.toLocaleString()}${etaStr}…` });

      if (start + BATCH < total) {
        await new Promise(r => setTimeout(r, 150));
        // Check for user cancellation between batches
        const check = await chrome.storage.local.get('lo_importProgress');
        if (check.lo_importProgress?.status === 'cancelled') return; // clean exit
      }
    }

    await setProgress({ done: total, total, eta: 0, message: 'Computing centroid…' });
    const embArrays = embeddings.map(e => new Float32Array(e));
    const centroid  = bgComputeCentroid(embArrays);

    await setProgress({ done: total, total, eta: 0, message: 'Centering & normalizing vectors…' });
    const pagesWithEmb = pages.map((p, i) => ({ ...p, embedding: embArrays[i] }));
    const centered     = bgCenterAndNormalize(pagesWithEmb, centroid);

    await setProgress({ done: total, total, eta: 0, message: 'Writing to IndexedDB…' });
    const dimension = embArrays[0].length;
    await bgWriteToIndexedDB(centered, centroid, dimension, model);

    await setProgress({ done: total, total, eta: 0, message: 'Computing 2D projection…' });
    const projection = bgComputeRandomProjection(centered);
    await bgWriteProjection(projection);

    const stats = { pages: total, dimension, model, date: new Date().toISOString() };
    await chrome.storage.local.set({ lo_apiKey: apiKey, lo_model: model, lo_dbStats: stats });

    // Invalidate in-memory page cache so the next findLinks call reads fresh data.
    _cachedPages = null; _cachedCentroid = null; _cacheKey = null;

    // Inject content script into the originating tab so the 🔗 button appears
    // without a page refresh (best-effort — tab may have navigated away).
    if (tabId) {
      try {
        // Set __loForceReinit so the fresh content.js replaces any stale UI
        // from a previously-invalidated context rather than no-oping on __loInitialized.
        await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__loForceReinit = true; } });
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch { /* tab may have closed or navigated — silently ignore */ }
    }

    const doneProgress = { status: 'done', done: total, total };
    await chrome.storage.local.set({ lo_importProgress: doneProgress });
    // Explicitly send a runtime message so an open popup receives the 'done' state immediately.
    // (setProgress() is only used for 'running' updates; 'done' was previously silent.)
    try { chrome.runtime.sendMessage({ action: 'importProgress', progress: doneProgress }); } catch {}

  } finally {
    chrome.alarms.clear('lo_keepalive');
  }
}

async function setProgress(fields) {
  // Never overwrite a user-initiated cancellation
  const check = await chrome.storage.local.get('lo_importProgress');
  if (check.lo_importProgress?.status === 'cancelled') return;

  const progress = { status: 'running', ...fields };
  await chrome.storage.local.set({ lo_importProgress: progress });

  // Also send directly to the popup if it happens to be open —
  // storage.onChanged in a popup can be unreliable; a direct message is instant.
  try { chrome.runtime.sendMessage({ action: 'importProgress', progress }); } catch { /* popup closed — fine */ }
}

// ── Math helpers (mirror of popup.js versions — run in SW context) ─────────────
function bgComputeCentroid(embeddings) {
  const dim      = embeddings[0].length;
  const centroid = new Float32Array(dim);
  for (const e of embeddings) for (let i = 0; i < dim; i++) centroid[i] += e[i];
  for (let i = 0; i < dim; i++) centroid[i] /= embeddings.length;
  return centroid;
}

function bgCenterAndNormalize(pages, centroid) {
  return pages.map(p => {
    const dim      = p.embedding.length;
    const centered = new Float32Array(dim);
    let normSq     = 0;
    for (let i = 0; i < dim; i++) { centered[i] = p.embedding[i] - centroid[i]; normSq += centered[i] * centered[i]; }
    const norm = Math.sqrt(normSq) || 1;
    for (let i = 0; i < dim; i++) centered[i] /= norm;
    return { ...p, centeredEmbedding: centered };
  });
}

function bgComputeRandomProjection(pages) {
  if (!pages.length) return [];
  const dim = pages[0].centeredEmbedding.length;
  let seed  = 42;
  function rand() { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; }
  const v1 = new Float32Array(dim), v2 = new Float32Array(dim);
  let n1 = 0, n2 = 0;
  for (let i = 0; i < dim; i++) { v1[i] = rand() * 2 - 1; n1 += v1[i] * v1[i]; v2[i] = rand() * 2 - 1; n2 += v2[i] * v2[i]; }
  n1 = Math.sqrt(n1); n2 = Math.sqrt(n2);
  for (let i = 0; i < dim; i++) { v1[i] /= n1; v2[i] /= n2; }
  return pages.map(p => {
    const e = p.centeredEmbedding; let x = 0, y = 0;
    for (let i = 0; i < dim; i++) { x += e[i] * v1[i]; y += e[i] * v2[i]; }
    return { url: p.url, title: p.title, x, y };
  });
}

async function bgWriteToIndexedDB(pages, centroid, dimension, model) {
  const db    = await openDB();
  const BATCH = 500;
  for (let start = 0; start < pages.length; start += BATCH) {
    const batch = pages.slice(start, start + BATCH);
    await new Promise((resolve, reject) => {
      const tx    = db.transaction(PAGES_STORE, 'readwrite');
      const store = tx.objectStore(PAGES_STORE);
      for (const p of batch) {
        const record = { url: p.url, title: p.title, embedding: p.centeredEmbedding.buffer.slice(0) };
        if (p.internalLinks !== null && p.internalLinks !== undefined) record.internalLinks = p.internalLinks;
        store.put(record);
      }
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }
  await new Promise((resolve, reject) => {
    const tx    = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    store.put({ key: 'centroid', data: centroid.buffer.slice(0) });
    store.put({ key: 'settings', data: JSON.stringify({ dimension, model, count: pages.length, importDate: new Date().toISOString() }) });
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function bgWriteProjection(points) {
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
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (!path.endsWith('/')) path += '/';
    return u.origin + path;
  } catch { return url; }
}
