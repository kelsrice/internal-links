/**
 * visualize.js — Embedding Map
 *
 * Reads the pre-computed 2D random projection stored in IndexedDB
 * by popup.js at import time. No backend required.
 *
 * The projection is approximate (random projection from the full
 * embedding space) — it shows topical clustering, not exact distances.
 */

// ── Config ─────────────────────────────────────────────────────────────────────
const params      = new URLSearchParams(location.search);
const CURRENT_URL = params.get('current') || '';

// ── State ──────────────────────────────────────────────────────────────────────
let allPoints    = [];
let sections     = {};
let filterQuery  = '';
let hoveredIdx   = -1;
let panX = 0, panY = 0, scale = 1;
let isPanning = false, panStartX = 0, panStartY = 0, panStartPanX = 0, panStartPanY = 0;
let minX, maxX, minY, maxY, rangeX, rangeY;
let activeSection  = null;
let showOutliers   = false;
let outlierCount   = 0;

const canvas  = document.getElementById('canvas');
const ctx     = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const overlay = document.getElementById('overlay');

// ── IndexedDB helpers ──────────────────────────────────────────────────────────
const DB_NAME    = 'LinkOpportunities';
const DB_VERSION = 1;
const META_STORE = 'meta';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'url' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function getMetaValue(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── Load data from IndexedDB ───────────────────────────────────────────────────
async function loadData() {
  overlay.innerHTML = '<div class="spinner"></div><span>Loading embedding map…</span>';
  overlay.style.display = 'flex';

  try {
    const db         = await openDB();
    const projMeta   = await getMetaValue(db, 'projection');
    const settsMeta  = await getMetaValue(db, 'settings');

    if (!projMeta?.data) {
      overlay.innerHTML = '<span>⚠️ No index loaded.<br><small>Import your pages CSV from the extension popup first.</small></span>';
      return;
    }

    const points  = JSON.parse(projMeta.data);
    const setts   = settsMeta?.data ? JSON.parse(settsMeta.data) : {};

    if (!points.length) {
      overlay.innerHTML = '<span>⚠️ Projection is empty. Re-import your pages CSV.</span>';
      return;
    }

    allPoints = points.map(p => ({ ...p, _isCurrent: CURRENT_URL && normalizeUrl(p.url) === normalizeUrl(CURRENT_URL) }));
    buildSections();
    outlierCount = computeOutliers();
    computeBounds();
    resetView();
    updateStats(setts);
    buildLegend();
    overlay.style.display = 'none';
    draw();

  } catch (e) {
    overlay.innerHTML = '<span>❌ Failed to load index.<br><small>' + e.message + '</small></span>';
  }
}

function normalizeUrl(url) {
  try { const u = new URL(url); return u.origin + u.pathname.replace(/\/$/, ''); } catch { return url; }
}

// ── Section coloring ───────────────────────────────────────────────────────────
function getSection(url) {
  try {
    const path = new URL(url).pathname;
    const seg  = path.split('/').filter(Boolean)[0];
    return seg ? '/' + seg + '/' : '/ (root)';
  } catch { return '(other)'; }
}

function sectionColor(label) {
  let hash = 5381;
  for (let i = 0; i < label.length; i++) hash = ((hash << 5) + hash) ^ label.charCodeAt(i);
  return 'hsl(' + (Math.abs(hash) % 360) + ', 65%, 52%)';
}

function buildSections() {
  sections = {};
  for (const p of allPoints) {
    const sec = getSection(p.url);
    if (!sections[sec]) sections[sec] = { color: sectionColor(sec), count: 0 };
    sections[sec].count++;
    p._section = sec;
    p._color   = sections[sec].color;
  }
}

// ── Outlier detection ──────────────────────────────────────────────────────────
/**
 * Flags points whose distance from the 2D centroid exceeds mean + 2 std deviations.
 * These are pages whose embeddings placed them far from the main topic clusters.
 */
function computeOutliers() {
  if (!allPoints.length) return 0;
  const cx = allPoints.reduce((s, p) => s + p.x, 0) / allPoints.length;
  const cy = allPoints.reduce((s, p) => s + p.y, 0) / allPoints.length;
  const dists = allPoints.map(p => Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2));
  const mean  = dists.reduce((s, d) => s + d, 0) / dists.length;
  const std   = Math.sqrt(dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length);
  const threshold = mean + 2 * std;
  let count = 0;
  for (let i = 0; i < allPoints.length; i++) {
    allPoints[i]._isOutlier = dists[i] > threshold;
    if (allPoints[i]._isOutlier) count++;
  }
  return count;
}

// ── Bounds & view ──────────────────────────────────────────────────────────────
function computeBounds() {
  const xs = allPoints.map(p => p.x), ys = allPoints.map(p => p.y);
  minX = Math.min(...xs); maxX = Math.max(...xs);
  minY = Math.min(...ys); maxY = Math.max(...ys);
  const padX = (maxX - minX) * 0.1, padY = (maxY - minY) * 0.1;
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;
  rangeX = maxX - minX || 1; rangeY = maxY - minY || 1;
}

function resetView() { panX = 0; panY = 0; scale = 1; }

function toCanvas(dx, dy) {
  const W = canvas.width, H = canvas.height;
  const bx = ((dx - minX) / rangeX) * W, by = ((dy - minY) / rangeY) * H;
  return [(bx - W/2) * scale + W/2 + panX, (by - H/2) * scale + H/2 + panY];
}

// ── Stats / legend ─────────────────────────────────────────────────────────────
function updateStats(setts) {
  const visible = visiblePoints().length;
  document.getElementById('stat-pages').textContent    = allPoints.length;
  document.getElementById('stat-filter').textContent   = visible;
  document.getElementById('stat-sections').textContent = Object.keys(sections).length;
  // Show model instead of variance (no backend)
  const varEl = document.getElementById('stat-variance');
  if (varEl) varEl.textContent = setts.model || 'text-embedding-3-small';
  const fillEl = document.getElementById('variance-fill');
  if (fillEl) fillEl.style.width = '100%';
}

function buildLegend() {
  const container = document.getElementById('legend-items');
  container.innerHTML = '';
  const sorted = Object.entries(sections).sort((a,b) => b[1].count - a[1].count);
  for (const [label, {color, count}] of sorted) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = '<div class="legend-dot" style="background:'+color+'"></div>'
      + '<span class="legend-label" title="'+label+'">'+label+'</span>'
      + '<span class="legend-count">'+count+'</span>';
    item.addEventListener('click', () => {
      activeSection = activeSection === label ? null : label;
      item.style.background = activeSection === label ? '#fde7d8' : '';
      document.getElementById('search').value = '';
      filterQuery = '';
      draw(); updateFilterCount();
    });
    container.appendChild(item);
  }
}

function visiblePoints() {
  const q = filterQuery.toLowerCase();
  return allPoints.filter(p => {
    if (activeSection && p._section !== activeSection) return false;
    if (!q) return true;
    return p.title.toLowerCase().includes(q) || p.url.toLowerCase().includes(q);
  });
}

function updateFilterCount() {
  document.getElementById('stat-filter').textContent = visiblePoints().length;
}

// ── Draw ───────────────────────────────────────────────────────────────────────
const DOT_R = 6;

function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#f1f5f9'; ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = i/10*W, y = i/10*H;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
  }

  const visible = new Set(visiblePoints().map(p => p.url));

  for (let i = 0; i < allPoints.length; i++) {
    const p = allPoints[i];
    const [cx, cy] = toCanvas(p.x, p.y);
    if (cx < -20 || cx > W+20 || cy < -20 || cy > H+20) continue;

    const isVisible = visible.has(p.url);
    const isHovered = i === hoveredIdx;
    const isCurrent = p._isCurrent;
    const r = isHovered ? DOT_R+3 : isCurrent ? DOT_R+2 : DOT_R;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI*2);

    // In outlier-highlight mode, dim non-outlier points so outliers stand out
    const isOutlier = showOutliers && p._isOutlier;
    const isDimmed  = showOutliers && !p._isOutlier && !isCurrent;

    if (!isVisible || isDimmed) {
      ctx.fillStyle = isDimmed ? 'rgba(200,210,220,0.25)' : 'rgba(200,210,220,0.2)';
      ctx.fill(); continue;
    }

    if (isCurrent) {
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = '#F15722'; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r-3, 0, Math.PI*2);
      ctx.fillStyle = '#F15722'; ctx.fill();
    } else if (isOutlier) {
      // Outlier: rose-red fill with white ring
      ctx.fillStyle = isHovered ? '#fb7185' : '#e11d48'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      // Extra pulse ring
      ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(225,29,72,0.35)'; ctx.lineWidth = 2; ctx.stroke();
    } else {
      ctx.fillStyle = isHovered ? lighten(p._color) : p._color; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = isHovered ? 2 : 1.5; ctx.stroke();
    }

    if (isHovered || allPoints.length <= 12) {
      const label = p.title.length > 32 ? p.title.slice(0,32)+'…' : p.title;
      ctx.font = (isHovered ? '600' : '400') + ' 11px Poppins, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(cx+r+3, cy-9, tw+6, 14);
      ctx.fillStyle = isHovered ? '#F15722' : '#1e293b';
      ctx.textAlign = 'left';
      ctx.fillText(label, cx+r+6, cy+1);
    }
  }
}

function lighten(color) { return color.replace(/(\d+)%\)$/, (_,l) => Math.min(Number(l)+15,90)+'%)'); }

// ── Resize ─────────────────────────────────────────────────────────────────────
function resize() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight; draw();
}
window.addEventListener('resize', resize);

// ── Interaction ────────────────────────────────────────────────────────────────
function hitTest(mx, my) {
  for (let i = 0; i < allPoints.length; i++) {
    const [cx, cy] = toCanvas(allPoints[i].x, allPoints[i].y);
    const dx = cx-mx, dy = cy-my;
    if (dx*dx + dy*dy <= (DOT_R+4)**2) return i;
  }
  return -1;
}

canvas.addEventListener('mousemove', (e) => {
  if (isPanning) {
    panX = panStartPanX + (e.clientX - panStartX);
    panY = panStartPanY + (e.clientY - panStartY);
    draw(); return;
  }
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const idx = hitTest(mx, my);
  if (idx !== hoveredIdx) { hoveredIdx = idx; canvas.style.cursor = idx >= 0 ? 'pointer' : 'crosshair'; draw(); }
  if (idx >= 0) {
    const p = allPoints[idx];
    tooltip.innerHTML = '<div class="tt-title">'+p.title+'</div><div class="tt-url">'+p.url+'</div><div class="tt-coords">proj: ('+p.x.toFixed(3)+', '+p.y.toFixed(3)+')</div>';
    let tx = e.clientX+16, ty = e.clientY-20;
    if (tx+290 > window.innerWidth)  tx = e.clientX-300;
    if (ty+100 > window.innerHeight) ty = window.innerHeight-110;
    tooltip.style.left = tx+'px'; tooltip.style.top = ty+'px';
    tooltip.classList.add('visible');
  } else { tooltip.classList.remove('visible'); }
});

canvas.addEventListener('mouseleave', () => { hoveredIdx = -1; tooltip.classList.remove('visible'); draw(); });
canvas.addEventListener('click', (e) => {
  if (Math.abs(e.clientX - panStartX) > 4) return;
  const rect = canvas.getBoundingClientRect();
  const idx  = hitTest(e.clientX-rect.left, e.clientY-rect.top);
  if (idx >= 0) window.open(allPoints[idx].url, '_blank');
});
canvas.addEventListener('mousedown', (e) => {
  isPanning = true;
  panStartX = e.clientX; panStartY = e.clientY;
  panStartPanX = panX; panStartPanY = panY;
  canvas.style.cursor = 'grabbing';
});
window.addEventListener('mouseup', () => { isPanning = false; canvas.style.cursor = hoveredIdx >= 0 ? 'pointer' : 'crosshair'; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX-rect.left, my = e.clientY-rect.top;
  const delta = e.deltaY > 0 ? 0.85 : 1.18;
  panX = mx + (panX-mx)*delta; panY = my + (panY-my)*delta;
  scale = Math.max(0.2, Math.min(scale*delta, 30)); draw();
}, { passive: false });

// ── Controls ───────────────────────────────────────────────────────────────────
document.getElementById('search').addEventListener('input', (e) => {
  filterQuery = e.target.value; activeSection = null;
  document.querySelectorAll('.legend-item').forEach(el => el.style.background = '');
  draw(); updateFilterCount();
});
document.getElementById('outlier-btn').addEventListener('click', () => {
  showOutliers = !showOutliers;
  const btn = document.getElementById('outlier-btn');
  btn.classList.toggle('active', showOutliers);
  btn.textContent = showOutliers
    ? '◎ Outliers: ' + outlierCount + ' found'
    : '◎ Show outliers';
  draw();
});
document.getElementById('refresh-btn').addEventListener('click', () => { allPoints = []; loadData(); });
document.getElementById('reset-btn').addEventListener('click',   () => { resetView(); draw(); });

// ── Boot ───────────────────────────────────────────────────────────────────────
resize();
loadData();
