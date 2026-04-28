/**
 * content.js — Link Opportunities v4.3
 *
 * Usage:
 *   Google Docs  → click 🔗 → type anchor text in sidebar → copy URL → ⌘K to insert
 *   Contentful   → highlight text + click 🔗, OR right-click → Find link opportunities
 *   WordPress    → right-click selected text → Find link opportunities
 *   Other        → highlight anchor text → click 🔗 or ⌘⇧L
 *
 * Architecture:
 *   All IndexedDB reads + similarity scoring happen in background.js (extension origin).
 *   Content scripts run under the host page's origin and cannot access extension IndexedDB.
 *
 * Google Docs note:
 *   GDocs renders in a canvas and overrides the native context menu. getSelection() is
 *   always empty. We skip selection detection entirely and use a manual text input instead.
 *
 * Slate.js (Contentful) note:
 *   execCommand is ignored by Slate's virtual DOM. We copy URL + show ⌘K hint instead.
 */

// ── Config ─────────────────────────────────────────────────────────────────────
const MIN_ANCHOR_CHARS = 3;
const MAX_RESULTS      = 6;

// ── Platform detection ─────────────────────────────────────────────────────────
/**
 * Returns a stable platform string used to adapt UI copy and trigger behaviour.
 *   'googledocs'  — docs.google.com (selection unreadable; use text input)
 *   'contentful'  — app.contentful.com (Slate editor; right-click + highlight both work)
 *   'wordpress'   — /wp-admin or Gutenberg block editor (right-click works best)
 *   'other'       — everything else
 */
function detectPlatform() {
  const host = window.location.hostname;
  if (host === 'docs.google.com')        return 'googledocs';
  if (host.includes('contentful.com'))   return 'contentful';
  if (
    window.location.pathname.startsWith('/wp-admin') ||
    !!document.getElementById('wpadminbar') ||
    !!document.querySelector('.block-editor, .wp-block-editor-page')
  ) return 'wordpress';
  return 'other';
}

// ── State ──────────────────────────────────────────────────────────────────────
let sidebar               = null;
let _savedSelection       = null;
let _textareaSelection    = null;  // tracked via selectionchange
let _gdocsSelection       = null;  // tracked via mouseup + iframe traversal
let _contentEditableSel   = null;  // tracked via selectionchange for all other editors
let _trafficData          = null;  // { '/path/': { sessions, conversions } } — loaded lazily
let _trafficThresholds    = null;  // { sessionsP75, conversionsP75 }

// ── Context menu message listener ──────────────────────────────────────────────
// background.js receives selectionText from Chrome's contextMenus API (which
// captures it before the menu appears) and forwards it here.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'contextMenuTrigger' || !msg.text) return;

  const anchorText = msg.text.trim();

  // After the context menu closes, the editor's selection is often still active.
  // Try to capture a full selection object (with Range) so Apply Link works too.
  const liveSel = captureSelection();
  _savedSelection = (liveSel && liveSel.anchorText.length >= MIN_ANCHOR_CHARS)
    ? liveSel
    : { type: 'static', anchorText };

  showSidebar('loading', anchorText);
  triggerSuggestions(anchorText);
});

// ── Boot ───────────────────────────────────────────────────────────────────────
// Guard against double-initialisation, but allow a forced re-init when the
// extension was reloaded (which silently invalidates old content script contexts).
// popup.js / background.js set window.__loForceReinit = true just before
// re-injecting after a successful import so the fresh script takes over cleanly.
{
  const forceReinit = !!window.__loForceReinit;
  window.__loForceReinit = false; // consume the flag

  if (!window.__loInitialized || forceReinit) {
    // Remove any stale UI left by a previous (now-invalidated) content script.
    document.getElementById('lo-float-btn')?.remove();
    const staleSidebar = document.getElementById('lo-sidebar');
    if (staleSidebar) { staleSidebar.remove(); sidebar = null; }

    window.__loInitialized = true;
    init();
  }
}

function init() {
  // ── Continuous selection tracking via selectionchange ─────────────────────
  // We track selection here rather than only at click time because clicking the
  // float button can clear the editor selection before our mousedown handler runs.
  // By keeping a saved copy, we always have the last known anchor text ready.
  document.addEventListener('selectionchange', () => {
    const active = document.activeElement;

    // ── Textarea ─────────────────────────────────────────────────────────────
    if (active && active.tagName === 'TEXTAREA' && !active.closest('#lo-sidebar')) {
      const text = active.value.slice(active.selectionStart, active.selectionEnd).trim();
      _textareaSelection = text.length >= MIN_ANCHOR_CHARS
        ? { element: active, start: active.selectionStart, end: active.selectionEnd, text }
        : null;
      return;
    }

    // ── All contenteditable editors (Gutenberg, TinyMCE main doc, etc.) ──────
    // Google Docs is handled separately via mouseup; skip it here.
    if (window.location.hostname === 'docs.google.com') return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < MIN_ANCHOR_CHARS) return;

    try {
      const range     = sel.getRangeAt(0).cloneRange();
      const container = range.commonAncestorContainer;
      const el        = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
      const editable  = el.closest('[contenteditable="true"]');
      if (!editable || editable.closest('#lo-sidebar')) return;

      const isSlate = editable.hasAttribute('data-slate-editor')
        || !!editable.closest('[data-slate-editor]');

      _contentEditableSel = { type: isSlate ? 'slate' : 'contenteditable', anchorText: text, range, element: editable };
    } catch { /* selection across shadow DOM or detached nodes — ignore */ }
  });

  // ── Google Docs: track via capture-phase pointer/mouse/key events ──────────
  // GDocs calls stopPropagation on its own handlers, so bubble-phase listeners
  // on document never fire. capture:true fires before GDocs can suppress us.
  if (window.location.hostname === 'docs.google.com') {
    const snapshotGdocs = () => {
      // Small delay so the browser can finalize the selection after pointer release
      setTimeout(() => {
        const text = readGdocsSelection();
        if (text) _gdocsSelection = { type: 'googledocs', anchorText: text };
        // Never clear on empty — GDocs fires many spurious selection events
      }, 60);
    };
    // Use { capture: true } so we fire before GDocs' own handlers stop propagation
    document.addEventListener('pointerup', snapshotGdocs, { capture: true });
    document.addEventListener('mouseup',   snapshotGdocs, { capture: true });
    // Keyboard selection (Shift+Arrow, Shift+Home/End, etc.)
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey) snapshotGdocs();
    }, { capture: true });
    // Also listen inside any accessible iframes GDocs uses for its editor
    setTimeout(() => {
      for (const iframe of document.querySelectorAll('iframe')) {
        try {
          iframe.contentDocument?.addEventListener('pointerup', snapshotGdocs);
          iframe.contentDocument?.addEventListener('mouseup',   snapshotGdocs);
        } catch { /* cross-origin */ }
      }
    }, 2000); // wait for GDocs to finish rendering its iframes
  }

  // ── Keyboard shortcut ──────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'l') {
      e.preventDefault();
      _savedSelection = captureSelection();
      triggerWithSavedSelection();
    }
  });

  createFloatButton();
}

// ── Google Docs selection reader ───────────────────────────────────────────────
/**
 * Reads selected text from the main document OR any same-origin iframe.
 * GDocs uses a hidden iframe for keyboard/cursor capture; the text selection
 * may live there rather than in the main document.
 */
function readGdocsSelection() {
  // Main document
  const mainSel  = window.getSelection();
  const mainText = mainSel ? mainSel.toString().trim() : '';
  if (mainText.length >= MIN_ANCHOR_CHARS) return mainText;

  // Same-origin iframes
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const iSel  = iframe.contentDocument?.getSelection();
      const iText = iSel ? iSel.toString().trim() : '';
      if (iText.length >= MIN_ANCHOR_CHARS) return iText;
    } catch { /* cross-origin — skip */ }
  }
  return '';
}

// ── Selection capture ──────────────────────────────────────────────────────────
/**
 * Snapshot the current selection into a typed object:
 *
 *  'googledocs'      → tracked via mouseup; Copy URL + ⌘K hint
 *  'slate'           → Contentful/Slate editor; execCommand ignored; Copy URL + ⌘K hint
 *  'textarea'        → tracked via selectionchange; inserts Markdown [text](url)
 *  'contenteditable' → standard WYSIWYG; document.execCommand('createLink')
 *  'static'          → read-only page; Copy URL only
 */
function captureSelection() {
  // ── Google Docs ────────────────────────────────────────────────────────────
  if (window.location.hostname === 'docs.google.com') {
    const liveText = readGdocsSelection();
    if (liveText.length >= MIN_ANCHOR_CHARS) {
      return { type: 'googledocs', anchorText: liveText };
    }
    return _gdocsSelection || null;
  }

  // ── Textarea ───────────────────────────────────────────────────────────────
  if (_textareaSelection && _textareaSelection.text.length >= MIN_ANCHOR_CHARS) {
    return {
      type:       'textarea',
      anchorText: _textareaSelection.text,
      element:    _textareaSelection.element,
      start:      _textareaSelection.start,
      end:        _textareaSelection.end,
    };
  }

  // ── Window selection (live) ────────────────────────────────────────────────
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    const anchorText = sel.toString().trim();
    if (anchorText.length >= MIN_ANCHOR_CHARS) {
      try {
        const range     = sel.getRangeAt(0).cloneRange();
        const container = range.commonAncestorContainer;
        const el        = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
        const editable  = el.closest('[contenteditable="true"]');
        if (editable && !editable.closest('#lo-sidebar')) {
          const isSlate = editable.hasAttribute('data-slate-editor')
            || !!editable.closest('[data-slate-editor]');
          return { type: isSlate ? 'slate' : 'contenteditable', anchorText, range, element: editable };
        }
        // No contenteditable found via live DOM — prefer the selection captured by
        // selectionchange (which ran before the right-click cleared editor focus).
        if (_contentEditableSel) return _contentEditableSel;
        return { type: 'static', anchorText };
      } catch { /* ignore malformed range */ }
    }
  }

  // ── Fallback: last selection saved by selectionchange ─────────────────────
  // The live selection may have already cleared by the time mousedown fires.
  // _contentEditableSel captures it earlier, before the click reached the button.
  if (_contentEditableSel) return _contentEditableSel;

  return null;
}

// ── Trigger ────────────────────────────────────────────────────────────────────
function triggerWithSavedSelection() {
  // Google Docs: selection is never readable — go straight to text input every time.
  if (detectPlatform() === 'googledocs') {
    showSidebar('prompt');
    return;
  }

  if (!_savedSelection) {
    // No selection detected on other platforms — show text input as fallback.
    showSidebar('prompt');
    return;
  }
  showSidebar('loading', _savedSelection.anchorText);
  triggerSuggestions(_savedSelection.anchorText);
}

// ── Core suggestion pipeline ───────────────────────────────────────────────────
async function triggerSuggestions(anchorText) {
  // When Chrome reloads an extension, previously-injected content scripts keep
  // running but lose their background connection — chrome.runtime.id becomes
  // undefined. sendMessage never calls back, leaving the spinner frozen forever.
  // Catch this upfront and direct the user to refresh instead of hanging.
  if (!chrome.runtime?.id) {
    showSidebar('error', '⚠️ Extension was reloaded.<br><small>Refresh this page to reconnect.</small>');
    return;
  }

  const stored = await chrome.storage.local.get(['lo_apiKey', 'lo_model', 'lo_dbStats', 'lo_trafficData', 'lo_trafficThresholds']);

  // Cache traffic data in module-level vars so renderCard() can use them
  if (stored.lo_trafficData)       _trafficData       = stored.lo_trafficData;
  if (stored.lo_trafficThresholds) _trafficThresholds = stored.lo_trafficThresholds;

  if (!stored.lo_apiKey) {
    showSidebar('error', 'No API key set.<br><small>Click the extension icon and add your OpenAI API key.</small>');
    return;
  }
  if (!stored.lo_dbStats) {
    showSidebar('error', 'No pages indexed.<br><small>Click the extension icon and import your pages CSV.</small>');
    return;
  }

  let results;
  try {
    results = await new Promise((resolve, reject) => {
      // 15-second safety timeout — catches edge cases where the background
      // service worker starts up but never calls sendResponse (e.g. a crash
      // mid-startup). Without this the spinner would hang indefinitely.
      const timer = setTimeout(() =>
        reject(new Error('No response from extension background. Try clicking 🔗 again.')), 15000);

      chrome.runtime.sendMessage(
        {
          action:     'findLinks',
          text:       anchorText,
          apiKey:     stored.lo_apiKey,
          model:      stored.lo_model || 'text-embedding-3-small',
          topK:       MAX_RESULTS,
          currentUrl: window.location.href,
        },
        (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (res.error)                return reject(new Error(res.error));
          resolve(res.results);
        }
      );
    });
  } catch (err) {
    showSidebar('error', '⚠️ ' + err.message);
    return;
  }

  showSidebar('results', null, results, stored.lo_dbStats.pages || 0);
}

// ── URL search pipeline ────────────────────────────────────────────────────────
async function searchByUrl(query) {
  const stored = await chrome.storage.local.get(['lo_apiKey', 'lo_model', 'lo_dbStats']);
  if (!stored.lo_dbStats) return [];

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'searchByUrl', query, topK: MAX_RESULTS },
      (res) => {
        if (chrome.runtime.lastError || res.error) { resolve([]); return; }
        resolve(res.results);
      }
    );
  });
}

// ── Traffic label helper ───────────────────────────────────────────────────────
function getTrafficLabel(url) {
  if (!_trafficData || !_trafficThresholds) return '';
  try {
    let path = new URL(url).pathname;
    if (!path.endsWith('/')) path += '/';
    const data = _trafficData[path];
    if (!data) return '';
    const highTraffic = data.sessions    >= _trafficThresholds.sessionsP75;
    const convDriver  = data.conversions >= _trafficThresholds.conversionsP75;
    if (highTraffic && convDriver)
      return '<span class="lo-traffic-label lo-tl-top">🏆 Top performer</span>';
    if (highTraffic)
      return '<span class="lo-traffic-label lo-tl-traffic">📈 High traffic</span>';
    if (convDriver)
      return '<span class="lo-traffic-label lo-tl-conv">💰 Conversion driver</span>';
  } catch { /* ignore malformed URL */ }
  return '';
}

// ── Card renderer ──────────────────────────────────────────────────────────────
function renderCard(s) {
  const pct        = Math.min(100, Math.round(s.sim * 200));
  const badgeClass = pct >= 70 ? 'lo-badge-green' : pct >= 40 ? 'lo-badge-amber' : 'lo-badge-gray';
  const safeUrl    = escapeHtml(s.url);
  const safeTitle  = escapeHtml(s.title);
  const displayUrl = s.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  const trafficLabel = getTrafficLabel(s.url);

  return '<div class="lo-card">'
    + '<div class="lo-card-top">'
    +   '<span class="lo-badge ' + badgeClass + '">' + pct + '%&nbsp;match</span>'
    +   trafficLabel
    + '</div>'
    + '<a class="lo-title" href="' + safeUrl + '" target="_blank" rel="noopener">' + safeTitle + '</a>'
    + '<div class="lo-url-display">' + escapeHtml(displayUrl) + '</div>'
    + '<div class="lo-card-actions">'
    +   '<button class="lo-copy-url lo-btn-primary" data-url="' + safeUrl + '">📋 Copy URL</button>'
    +   '<button class="lo-copy-md lo-btn-secondary" data-url="' + safeUrl + '" data-title="' + safeTitle + '">⬇ Markdown</button>'
    + '</div>'
    + '</div>';
}

// ── Floating button ────────────────────────────────────────────────────────────
function createFloatButton() {
  if (document.getElementById('lo-float-btn')) return; // already exists

  const platform = detectPlatform();
  const tooltips = {
    googledocs: 'Find link opportunities — type anchor text in the sidebar',
    contentful: 'Find link opportunities — highlight text or right-click selection',
    wordpress:  'Find link opportunities — right-click selected text, or highlight + click',
    other:      'Find link opportunities (⌘⇧L) — highlight text first',
  };
  const btn = document.createElement('button');
  btn.id    = 'lo-float-btn';
  btn.title = tooltips[platform] || tooltips.other;
  btn.textContent = '🔗';

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    _savedSelection = captureSelection();
  });

  btn.addEventListener('click', () => {
    if (!_savedSelection) _savedSelection = captureSelection();
    triggerWithSavedSelection();
  });

  document.body.appendChild(btn);

  // Show a one-time onboarding tooltip if the user has an index but hasn't
  // used the tool on this browser yet.
  showOnboardingTooltip(platform);
}

// ── First-time onboarding tooltip ─────────────────────────────────────────────
function showOnboardingTooltip(platform) {
  chrome.storage.local.get(['lo_dbStats', 'lo_tooltipDismissed'], (stored) => {
    // Only show if index is loaded and user hasn't dismissed before
    if (!stored.lo_dbStats || stored.lo_tooltipDismissed) return;

    const messages = {
      googledocs: '<strong>New here?</strong> Click 🔗 and type your anchor text in the sidebar to find link suggestions.',
      contentful: '<strong>New here?</strong> Highlight text in the editor, then click 🔗 — or right-click selected text.',
      wordpress:  '<strong>New here?</strong> Highlight text in the editor, then right-click → <em>Find link opportunities</em>.',
      other:      '<strong>New here?</strong> Highlight anchor text on the page, then click 🔗.',
    };
    const msg = messages[platform] || messages.other;

    const tip = document.createElement('div');
    tip.id = 'lo-onboarding-tip';
    tip.innerHTML = msg + '<button id="lo-tip-dismiss" title="Dismiss">✕</button>';
    document.body.appendChild(tip);

    // Auto-dismiss after 12 seconds
    const autoDismiss = setTimeout(dismissTooltip, 12000);

    document.getElementById('lo-tip-dismiss').addEventListener('click', () => {
      clearTimeout(autoDismiss);
      dismissTooltip();
    });
  });
}

function dismissTooltip() {
  const tip = document.getElementById('lo-onboarding-tip');
  if (tip) tip.remove();
  chrome.storage.local.set({ lo_tooltipDismissed: true });
}

// ── Platform-aware welcome hint ────────────────────────────────────────────────
function platformWelcomeHint() {
  const platform = detectPlatform();
  const hints = {
    googledocs: '<p class="lo-hint">Click 🔗 and type your anchor text to find link suggestions.<br>'
      + '<small>After copying a URL, highlight text in Docs and press <kbd>⌘K</kbd> to insert.</small></p>',
    contentful: '<p class="lo-hint">Highlight text then click 🔗 — or right-click selected text → <em>Find link opportunities</em>.<br>'
      + '<small>Links are inserted via <kbd>⌘K</kbd> in Contentful.</small></p>',
    wordpress:  '<p class="lo-hint">Right-click highlighted text → <em>Find link opportunities</em>.<br>'
      + '<small>Or highlight text and click 🔗.</small></p>',
    other:      '<p class="lo-hint">Highlight anchor text, then click 🔗 or press <kbd>⌘⇧L</kbd>.</p>',
  };
  return hints[platform] || hints.other;
}

// ── Sidebar UI ─────────────────────────────────────────────────────────────────
function buildTipsHtml() {
  const platform = detectPlatform();
  const shared = `
    <div class="lo-tips-section">
      <div class="lo-tips-section-title">🗺 Embedding Map</div>
      <p>Click the map icon (⊞) in the header to see all your indexed pages plotted by topic. Pages that cluster together are semantically similar.</p>
    </div>
    <div class="lo-tips-section">
      <div class="lo-tips-section-title">🔎 Search Index</div>
      <p>Use the search bar at the top to look up any page by URL path or title — useful for confirming a specific page is in your index before linking to it.</p>
    </div>
    <div class="lo-tips-section">
      <div class="lo-tips-section-title">🔄 Updating Your Index</div>
      <p>Re-import your pages CSV after publishing significant new content or updating titles and meta descriptions. Traffic data can be re-imported at any time without clearing your page index.</p>
    </div>`;

  const platformTips = {
    googledocs: `
      <div class="lo-tips-section">
        <div class="lo-tips-section-title">Google Docs</div>
        <p>Google Docs doesn't expose text selections to browser extensions. Instead:</p>
        <ol class="lo-tips-list">
          <li>Click 🔗 and type your anchor text in the sidebar</li>
          <li>Click <em>Find links →</em> to get suggestions</li>
          <li>Copy a URL from the results</li>
          <li>In Docs, highlight your anchor text → press <kbd>⌘K</kbd> → paste → Apply</li>
        </ol>
      </div>`,
    contentful: `
      <div class="lo-tips-section">
        <div class="lo-tips-section-title">Contentful</div>
        <ol class="lo-tips-list">
          <li>Highlight text in the editor, then click 🔗 — or right-click highlighted text → <em>Find link opportunities</em></li>
          <li>Click <em>📋 Copy URL</em> next to your best match</li>
          <li>In Contentful, highlight your anchor text → press <kbd>⌘K</kbd> → paste URL → confirm</li>
        </ol>
      </div>`,
    wordpress: `
      <div class="lo-tips-section">
        <div class="lo-tips-section-title">WordPress</div>
        <ol class="lo-tips-list">
          <li>Highlight text in the editor</li>
          <li>Right-click → <em>Find link opportunities</em></li>
          <li>Click <em>📋 Copy URL</em> next to your best match, then paste using the editor's link tool</li>
        </ol>
      </div>`,
    other: `
      <div class="lo-tips-section">
        <div class="lo-tips-section-title">Any Page or CMS</div>
        <ol class="lo-tips-list">
          <li>Highlight your anchor text</li>
          <li>Click 🔗 or press <kbd>⌘⇧L</kbd></li>
          <li>Click <em>📋 Copy URL</em> and paste the link using your editor's link tool</li>
        </ol>
      </div>`,
  };

  return (platformTips[platform] || platformTips.other) + shared;
}

function createSidebar() {
  const el = document.createElement('div');
  el.id = 'lo-sidebar';
  el.innerHTML =
    '<div id="lo-header">'
    + '<span id="lo-title">🔗 Link Suggestions</span>'
    + '<div id="lo-header-actions">'
    +   '<button id="lo-tips-btn" title="Tips">Tips</button>'
    +   '<button id="lo-map-btn" title="Embedding map">🗺</button>'
    +   '<button id="lo-refresh" title="Re-run for current selection">↻</button>'
    +   '<button id="lo-toggle"  title="Minimize">−</button>'
    +   '<button id="lo-close"   title="Close">✕</button>'
    + '</div></div>'
    + '<div id="lo-tips-panel" style="display:none"></div>'
    + '<div id="lo-body">'
    +   '<div id="lo-search-wrap">'
    +     '<div class="lo-search-inner">'
    +       '<input id="lo-url-search" type="text" placeholder="🔎 Search index by URL or title…" autocomplete="off">'
    +       '<button id="lo-search-clear" class="lo-search-clear" title="Clear search" style="display:none">✕</button>'
    +     '</div>'
    +   '</div>'
    +   '<div id="lo-content">'
    +     platformWelcomeHint()
    +   '</div>'
    + '</div>';

  document.body.appendChild(el);

  el.querySelector('#lo-close').addEventListener('click', () => { el.style.display = 'none'; });

  let minimized = false;
  el.querySelector('#lo-toggle').addEventListener('click', () => {
    minimized = !minimized;
    el.querySelector('#lo-body').style.display   = minimized ? 'none' : 'block';
    const tipsPanel = el.querySelector('#lo-tips-panel');
    if (minimized) tipsPanel.style.display = 'none';
    el.querySelector('#lo-toggle').textContent = minimized ? '+' : '−';
  });

  el.querySelector('#lo-refresh').addEventListener('click', () => {
    _savedSelection = captureSelection();
    triggerWithSavedSelection();
  });

  el.querySelector('#lo-map-btn').addEventListener('click', () => {
    const url = chrome.runtime.getURL('visualize.html') + '?current=' + encodeURIComponent(window.location.href);
    window.open(url, '_blank');
  });

  // 💡 Tips panel toggle
  const tipsBtn   = el.querySelector('#lo-tips-btn');
  const tipsPanel = el.querySelector('#lo-tips-panel');
  tipsPanel.innerHTML = buildTipsHtml();
  tipsBtn.addEventListener('click', () => {
    const open = tipsPanel.style.display !== 'none';
    tipsPanel.style.display = open ? 'none' : 'block';
    tipsBtn.classList.toggle('lo-tips-btn-active', !open);
  });

  // URL search — lets users find pages by URL/title text (e.g. "/prescription/")
  // independently of semantic similarity score.
  let searchTimer = null;
  const urlSearchInput = el.querySelector('#lo-url-search');
  const urlSearchClear = el.querySelector('#lo-search-clear');

  urlSearchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    urlSearchClear.style.display = q ? 'flex' : 'none';
    if (!q) {
      // Restore the default hint when search is cleared
      document.getElementById('lo-content').innerHTML = platformWelcomeHint();
      return;
    }
    searchTimer = setTimeout(async () => {
      const content = document.getElementById('lo-content');
      content.innerHTML = '<div class="lo-loading"><div class="lo-spinner"></div><span>Searching…</span></div>';
      const results = await searchByUrl(q);
      renderResults(results, 0, '"' + escapeHtml(q) + '"');
    }, 400);
  });

  urlSearchClear.addEventListener('click', () => {
    urlSearchInput.value = '';
    urlSearchClear.style.display = 'none';
    document.getElementById('lo-content').innerHTML = platformWelcomeHint();
    urlSearchInput.focus();
  });

  makeDraggable(el, el.querySelector('#lo-header'));
  return el;
}

function showSidebar(state, messageOrAnchor, suggestions, totalIndexed) {
  suggestions  = suggestions  || [];
  totalIndexed = totalIndexed || 0;

  if (!sidebar) sidebar = createSidebar();
  sidebar.style.display = 'flex';
  const content = document.getElementById('lo-content');

  if (state === 'prompt') {
    // Shown when no text is selected (or always on Google Docs).
    // Primary path for Google Docs; useful fallback everywhere else.
    const platform   = detectPlatform();
    const promptCopy = {
      googledocs:  'Type the anchor text to find link suggestions:',
      contentful:  'Enter the anchor text to find link suggestions:',
      wordpress:   'Enter the anchor text to find link suggestions:',
      other:       'Enter the anchor text to find link suggestions for:',
    };
    const subhintCopy = {
      googledocs:  'After copying a URL, highlight your text in Docs and press <strong>⌘K</strong> to insert the link.',
      contentful:  'Or highlight text on the page first, then click 🔗 or right-click → <em>Find link opportunities</em>.',
      wordpress:   'Or right-click highlighted text → <em>Find link opportunities</em>.',
      other:       'Or highlight text on the page first, then click 🔗.',
    };

    content.innerHTML =
      '<p class="lo-hint" style="text-align:left;padding:8px 0 6px;">' + promptCopy[platform] + '</p>'
      + '<div class="lo-prompt-wrap">'
      +   '<input type="text" id="lo-prompt-input" class="lo-prompt-input" placeholder="e.g. birds aren\'t real" autocomplete="off">'
      +   '<button id="lo-prompt-submit" class="lo-btn-primary lo-prompt-btn">Find links →</button>'
      + '</div>'
      + '<p class="lo-subhint" style="margin-top:6px;">' + subhintCopy[platform] + '</p>';

    const input  = content.querySelector('#lo-prompt-input');
    const submit = content.querySelector('#lo-prompt-submit');
    const doSearch = () => {
      const text = input.value.trim();
      if (text.length < MIN_ANCHOR_CHARS) return;
      _savedSelection = { type: 'static', anchorText: text };
      showSidebar('loading', text);
      triggerSuggestions(text);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    submit.addEventListener('click', doSearch);
    setTimeout(() => input.focus(), 50);
    return;

  } else if (state === 'loading') {
    const preview = messageOrAnchor
      ? '<p class="lo-anchor-preview">🔍 <em>"'
          + escapeHtml(messageOrAnchor.slice(0, 80))
          + (messageOrAnchor.length > 80 ? '…' : '') + '"</em></p>'
      : '';
    content.innerHTML = preview
      + '<div class="lo-loading"><div class="lo-spinner"></div><span>Finding link opportunities…</span></div>';

  } else if (state === 'error') {
    content.innerHTML = '<p class="lo-error">⚠️ ' + messageOrAnchor + '</p>';

  } else if (state === 'results') {
    const anchorPreview = _savedSelection?.anchorText
      ? '<p class="lo-anchor-preview">🔍 <em>"'
          + escapeHtml(_savedSelection.anchorText.slice(0, 80))
          + (_savedSelection.anchorText.length > 80 ? '…' : '')
          + '"</em> <button id="lo-new-search" class="lo-new-search-btn" title="Clear and search new text">× New search</button></p>'
      : '';
    renderResults(suggestions, totalIndexed, null, anchorPreview);
  }
}

function renderResults(suggestions, totalIndexed, searchLabel, anchorPreview) {
  const content = document.getElementById('lo-content');
  anchorPreview = anchorPreview || '';

  if (!suggestions.length) {
    content.innerHTML = anchorPreview
      + '<p class="lo-hint">No pages matched — try a shorter phrase or different keyword.</p>'
      + (totalIndexed
          ? '<p class="lo-subhint">' + totalIndexed.toLocaleString() + ' pages indexed — or search by URL path using the field above.</p>'
          : '<p class="lo-subhint">Try searching by URL or title using the field above.</p>');
    return;
  }

  const metaText = searchLabel
    ? 'Search: ' + searchLabel + ' · ' + suggestions.length + ' found'
    : (totalIndexed ? totalIndexed.toLocaleString() + ' pages · ' + suggestions.length + ' opportunities' : suggestions.length + ' results');

  const editorNote = (_savedSelection?.type === 'slate')
    ? '<div class="lo-editor-steps"><strong>To insert a link in Contentful:</strong><ol><li>Click <em>📋 Copy URL</em> below</li><li>In Contentful, highlight your anchor text</li><li>Press <strong>⌘K</strong> → paste URL → confirm</li></ol></div>'
    : (_savedSelection?.type === 'googledocs')
    ? '<div class="lo-editor-steps"><strong>To insert a link in Google Docs:</strong><ol><li>Click <em>📋 Copy URL</em> below</li><li>In Docs, keep your text highlighted</li><li>Press <strong>⌘K</strong> → paste URL → Apply</li></ol></div>'
    : '';

  content.innerHTML = anchorPreview
    + '<p class="lo-meta">' + escapeHtml(metaText) + '</p>'
    + editorNote
    + suggestions.map(renderCard).join('');

  wireCardButtons(content);

  // "× New search" button — clears saved selection and opens the text prompt
  const newSearchBtn = content.querySelector('#lo-new-search');
  if (newSearchBtn) {
    newSearchBtn.addEventListener('click', () => {
      _savedSelection = null;
      showSidebar('prompt');
    });
  }
}

function wireCardButtons(content) {
  // Copy URL
  content.querySelectorAll('.lo-copy-url').forEach(btn => {
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(btn.dataset.url).then(() => {
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy URL'; }, 1800);
      });
    });
  });

  // Markdown
  content.querySelectorAll('.lo-copy-md').forEach(btn => {
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText('[' + btn.dataset.title + '](' + btn.dataset.url + ')').then(() => {
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = '⬇ Markdown'; }, 1800);
      });
    });
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeDraggable(el, handle) {
  let startX, startY, startLeft, startTop;
  handle.style.cursor = 'move';
  handle.addEventListener('mousedown', function (e) {
    startX = e.clientX; startY = e.clientY;
    const r = el.getBoundingClientRect();
    startLeft = r.left; startTop = r.top;
    function onMove(e) {
      el.style.left  = (startLeft + (e.clientX - startX)) + 'px';
      el.style.top   = (startTop  + (e.clientY - startY)) + 'px';
      el.style.right = 'auto';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}
