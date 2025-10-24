

// --- OpenAI direct-from-browser (local use only) ---
// Where your proxy is running:
const FETCH_PROXY = 'http://localhost:8787';
// Default power for any newly created dimension tool
const DEFAULT_DIM_POWER = 0;
// Dimension search (UI state)

// --- Splash images ---
let splashImg = null;        // Icons/Splash.png
let splashDemoImg = null;    // Icons/Splash_Demo.png
let _splashEnabled = true;

// ==== Node size UI ranges (tweak to taste) ====
let NODE_SIZE_MIN = 2;      // min circle radius (px)
let NODE_SIZE_MAX = 10;     // max circle radius (px)

let FULLTEXT_SIZE_MIN = 0.6;  // min multiplier for square nodes (× circle diameter)
let FULLTEXT_SIZE_MAX = 2.4;  // max multiplier for square nodes

// Live UI-controlled scales (1.0 = current defaults)
let nodeSizeScale = 1.0;        // effective circle radius = (n.r || NODE_R) * nodeSizeScale
let fulltextSizeScale = 1.0;    // effective square mult   = FULLTEXT_BOX_SIZE_MULT * fulltextSizeScale

// Tiny helpers for mapping slider->value and back
const lerp01    = (a,b,t) => a + (b - a) * t;
const invLerp01 = (a,b,v) => (v - a) / (b - a);

// Current effective square multiplier
function getFulltextBoxMult() {
  return FULLTEXT_BOX_SIZE_MULT * fulltextSizeScale;
}

// ==== Motion Parallax (subtle, citation-based) ====
// Turn on/off quickly while testing

// ==== Motion Parallax (subtle, citation-based) ====
// Turn on/off quickly while testing
let PARALLAX_ENABLED   = true;

// Max extra response, as fractions (10% recommended)
// - panning: how much extra the camera translation influences close nodes
// - zooming: how much extra the camera scale influences close nodes
const PARALLAX_PAN_FRAC  = 0.10;   // 0.0 … 0.15 feels good
const PARALLAX_ZOOM_FRAC = 0.20;   // 0.0 … 0.15 feels good

// Map cited_by_count -> depth in [0..1], using robust percentiles if available
function parallaxDepthForNode(i) {
  const n = nodes[i] || {};

  // Prefer internal in-degree if available; else fall back to cited_by_count
  const useInt = Number.isFinite(Number(n.intIn));
  const val    = useInt ? Math.max(0, n.intIn|0) : Math.max(0, Number(n.cbc || 0));

  // Robust bounds
  const p5  = useInt ? intInP5  : (Number.isFinite(cbcP5)  ? cbcP5  : cbcMin);
  const p95 = useInt ? intInP95 : (Number.isFinite(cbcP95) ? cbcP95 : cbcMax);
  const lo  = Math.max(0, Math.min(p5,  p95));
  const hi  = Math.max(lo + 1e-9, Math.max(p5, p95));

  // Log mapping for stability on heavy-tailed counts
  const L = (x) => Math.log1p(Math.max(0, x));
  const t = (L(val) - L(lo)) / Math.max(1e-9, (L(hi) - L(lo)));
  return Math.max(0, Math.min(1, t));
}

// --- Centre-aware helpers (add) ---
function worldCenterFromCamera() {
  // world point currently under the screen centre
  return {
    x: (width  * 0.5 - cam.x) / (cam.scale || 1),
    y: (height * 0.5 - cam.y) / (cam.scale || 1)
  };
}

// Keep previous camera to estimate pan delta (for nicer pan parallax)
let __prevCam = { x: 0, y: 0, scale: 1 };

// Return a *world* position that, after the normal cam transform,
// yields a slightly different screen position depending on "depth".
function parallaxWorldPos(i) {
  const base = nodeDrawPos(i);                  // your dimension-influenced world pos
  if (!PARALLAX_ENABLED) return base;

  const d = parallaxDepthForNode(i);            // 0..1 based on cited_by_count
  if (d <= 0) return base;

  // Centre-aware anchor: world point currently at screen centre
  const C = worldCenterFromCamera();

  // How strongly depth affects "zoom push" and "pan slip"
  const kZ = PARALLAX_ZOOM_FRAC * d;            // expand away from centre when zooming
  const kP = PARALLAX_PAN_FRAC  * d;            // slight extra slide during pans

  // Vector from centre to node (world space)
  const dx = base.x - C.x;
  const dy = base.y - C.y;

  // Optional: estimate pan delta in world units this frame (camera movement)
  const scaleNow  = (cam.scale || 1);
  const scalePrev = (__prevCam.scale || 1);
  const zooming   = Math.abs(scaleNow - scalePrev) > 1e-6;

  // If zoom changed, don't apply pan slip this frame (avoids jitter)
  const panDxWorld = zooming ? 0 : (cam.x - __prevCam.x) / scaleNow;
  const panDyWorld = zooming ? 0 : (cam.y - __prevCam.y) / scaleNow;

  // Apply:
  // 1) Zoom-parallax: expand about the centre by (1 + kZ)
  // 2) Pan-parallax: let closer (high-d) nodes overshoot slightly with camera motion
  return {
    x: C.x + dx * (1 + kZ) + panDxWorld * kP,
    y: C.y + dy * (1 + kZ) + panDyWorld * kP
  };
}


// Screen helper (useful for tooltips/hits)
function nodeScreenPos(i) {
  const pw = parallaxWorldPos(i);
  return worldToScreen(pw.x, pw.y);
}



// ---- Viewer (remote-lazy) support ----
let REMOTE_DETAILS_BASE = null;
let REMOTE_AI_BASE = null;

// --- Demo Mode ---------------------------------------------------------------
// Toggle to present a non-destructive demo build.
// false = normal; true = disable Save & Publish and grey out their icons.
let DEMO_MODE = !!(window.DEMO_MODE ?? false);
const SELECT_SQUARE_MULT = 1.0;
let poweredByImg;

// --- Bug/Feature Tracking ----------------------------------------------------
// Toggle to show a bug icon in the top-right control bar
let BUG_MODE = false;  // set true to enable

// Your Formspree endpoint (replace with your form ID URL, e.g. https://formspree.io/f/abcdjklm)
const FORM_ENDPOINT = 'https://formspree.io/f/mwprdqjw';

let bugIconImg = null;          // preloaded icon (optional, for future use)
let __bugDialogDiv = null;      // modal root reference



// Optional Unpaywall assist (recommended): enter your email
const UNPAYWALL_EMAIL = 'martyn.dade-robertson@northumbria.ac.uk'; // e.g. 'you@example.com'

// --- Frame-local visibility (screen culling) ---
let inView = [];            // boolean per node: on-screen this frame
let edgesOnscreen = [];     // culled edge list for this frame

const EDGE_CAP_LOW_ZOOM   = 18000;  // total edges per frame when zoomed out
const EDGE_CAP_WHILE_PAN  = 8000;   // total edges per frame while panning
const LOD_ZOOM_THRESHOLD  = 2.6;    // below this → cap edges

var clusterSelectId = -1;   // persists after click until cleared

window.escapeHtml = window.escapeHtml || function (s) { return esc(s); };
// Wrap a remote URL to go via the proxy
let __proxyAvailable = true;
function viaProxy(url) {
  if (!FETCH_PROXY || !__proxyAvailable) return url;
  return `${FETCH_PROXY}/fetch?url=${encodeURIComponent(url)}`;
}

// Add immediately after (new code):
async function probeProxyOnce() {
  if (!FETCH_PROXY || !__proxyAvailable) return;
  try {
    const testUrl = `${FETCH_PROXY}/fetch?url=${encodeURIComponent('https://example.com/')}`;
    // HEAD is enough and fast
    const r = await fetch(testUrl, { method: 'HEAD' });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    console.warn('Fetch proxy unavailable — falling back to direct requests.');
    __proxyAvailable = false;
  }
}
function fetchWithTimeout(resource, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(resource, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}


probeProxyOnce();

// --- Project meta (shown on right, under the top-right icons) ---
let projectMeta = { title: '', text: '', created: '' };
let projectMetaPanel = null;

function createProjectMetaPanel() {
  if (projectMetaPanel) return projectMetaPanel;
  const panel = createDiv('');
  panel.id('project-meta-panel');
  panel.style('position','fixed');
  panel.style('right','12px');
  panel.style('top','72px'); // will be re-positioned under the save/load bar if present
  panel.style('width','250px');
  panel.style('background','rgba(0,0,0,0.55)');
  panel.style('border','1px solid rgba(255,255,255,0.12)');
  panel.style('border-radius','12px');
  panel.style('box-shadow','0 8px 24px rgba(0,0,0,0.25)');
  panel.style('backdrop-filter','blur(2px)');
  panel.style('padding','10px 12px');
  panel.style('color','#fff');
  panel.style('z-index','10035');
  panel.hide();
  if (typeof captureUI === 'function') captureUI(panel.elt);
  projectMetaPanel = panel;
  return projectMetaPanel;
}

function positionProjectMetaPanel() {
  try {
    const bar = (typeof saveLoadBar !== 'undefined') ? saveLoadBar : null;
    if (bar?.elt) {
      const r = bar.elt.getBoundingClientRect();
      // 8px gap below the save/load bar
      projectMetaPanel.style('top', `${Math.round(r.bottom + 8)}px`);
      projectMetaPanel.style('right', '12px');
    }
  } catch {}
}

function renderProjectMetaPanel() {
  if (!projectMetaPanel) createProjectMetaPanel();
  const { title, text, created } = projectMeta || {};
  const when = created ? new Date(created).toLocaleString() : '';
  const safeTitle = (String(title||'').trim() || 'Untitled export');
  const safeText  = String(text||'').trim();

  const html = `
    <div style="font-weight:700; font-size:13px; margin-bottom:4px;">${safeTitle}</div>
    <div style="opacity:.75; font-size:11px; margin-bottom:8px;">Created ${when || ''}</div>
    <div style="white-space:pre-wrap; font-size:12px; line-height:1.45;">${safeText ? safeText : '<span style="opacity:.7">No description.</span>'}</div>
  `;
  projectMetaPanel.html(html);
  positionProjectMetaPanel();
  projectMetaPanel.show();
}

function hideProjectMetaPanel() {
  if (projectMetaPanel) projectMetaPanel.hide();
}







// ---- Camera / interactions ----

// Minimal toast (safe no-op if redefined elsewhere)
window.showToast = window.showToast || function (msg) {
  try {
    // simple ephemeral banner
    const el = document.createElement('div');
    el.textContent = String(msg || '');
    Object.assign(el.style, {
      position:'fixed', left:'50%', bottom:'24px', transform:'translateX(-50%)',
      background:'rgba(0,0,0,0.85)', color:'#fff', padding:'8px 12px',
      borderRadius:'8px', font:'12px/1.2 system-ui, -apple-system, Segoe UI, Roboto',
      zIndex:'10080', pointerEvents:'none'
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  } catch { console.log('Toast:', msg); }
};

const CITED_BY_CAPS_STORAGE = 'citedByCaps_v1';


function loadCitedByCaps() {
  try {
    const raw = localStorage.getItem(CITED_BY_CAPS_STORAGE);
    const parsed = raw ? JSON.parse(raw) : null;
    const l2PerParent = Math.max(1, Math.min(2000, Number(parsed?.l2PerParent ?? 120)));
    const l2GlobalCap = Math.max(l2PerParent, Math.min(20000, Number(parsed?.l2GlobalCap ?? 4000)));
    return { l2PerParent, l2GlobalCap };
  } catch { return { l2PerParent: 120, l2GlobalCap: 4000 }; }
}

function saveCitedByCaps(caps) {
  const clean = {
    l2PerParent: Math.max(1, Math.min(2000, Number(caps.l2PerParent || 120))),
    l2GlobalCap: Math.max(1, Math.min(20000, Number(caps.l2GlobalCap || 4000))),
  };
  if (clean.l2GlobalCap < clean.l2PerParent) clean.l2GlobalCap = clean.l2PerParent;
  localStorage.setItem(CITED_BY_CAPS_STORAGE, JSON.stringify(clean));
  window.CITED_BY_CAPS = clean;
  return clean;
}

window.CITED_BY_CAPS = loadCitedByCaps();

let OPENAI_API_KEY = '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';                     // set via modal; not persisted
let OPENAI_MODEL   = 'gpt-4o-mini';          // adjust if you prefer another model

let filtersPanel = null;

let importBtn, hiddenFileInput, infoSpan;
let nodes = [];  // [{idx, x, y, r}]
let edges = [];  // [{source, target}]
let msg = "";

// ---- Force layout state & params ----
let layoutRunning = false;
let vx = [], vy = [];       // velocities per node
let adj = [];               // adjacency list (built from edges)

// ===== Visual tuning (global knobs) =====
const NODE_IDLE_ALPHA    = 100; // 0–255: default opacity when NOT highlighted
const NODE_HILITE_ALPHA  = 255; // 0–255: opacity when hovered/selected/neighbor
const NODE_R = 8; 
const FULLTEXT_BOX_SIZE_MULT = 1.0;


// Cluster palette in HSB (affects node colour when clusters lens is on)
const CLUSTER_SAT        = 80;  // 0–100: increase to boost saturation
const CLUSTER_BRIGHT     = 85;  // 0–100: increase to make brighter

// Base tints (used when clusters lens is off / OA hint)
const BASE_NODE_RGB      = [210, 215, 225]; // neutral node colour
const OA_NODE_RGB        = [150, 200, 160]; // gentle OA green

// When something is SELECTED (node/dimension/AI summary), fade all other nodes/edges to this alpha.
const SELECT_DIM_NODE_ALPHA = Math.round(255 * 0.10); // ≈ 26 → 10% opacity for non-highlighted nodes
const SELECT_DIM_EDGE_ALPHA = Math.round(255 * 0.10); // ≈ 26 → 10% opacity for non-highlighted edges

const EDGE_IDLE_ALPHA       = 110;
const EDGE_IDLE_DIM_ALPHA   = 90;   // when hovering but an edge isn't part of the focus
const EDGE_HILITE_ALPHA     = 255;  // fully opaque when an edge is in focus

// --- Open Question (scalable) tuning ---
const OQ_MAX_DOCS_DEFAULT = 1200;   // cap; you can raise later
const OQ_CHUNK_SIZE       = 24;     // ↓ from 60 (smaller bursts)
const OQ_EXCERPT_CHARS    = 600;    // ↓ from 1400 (smaller payloads)
const OQ_BODY_TOKENS      = 1100;   // ↓ from 1700
const OQ_MERGE_TOKENS     = 2900;   // ↓ from 2800

// Throttling/retries (helps with 429/502)
const OQ_INTER_CALL_DELAY_MS = 400; // delay after each *successful* call
const OQ_MAX_RETRIES         = 6;   // attempt budget per call

// --- Open Question: relevance screening (Stage 1) ---
const OQ_SCREEN_CAP        = 1500;  // hard cap of visible docs to screen
const OQ_SCREEN_CHUNK      = 60;    // docs per screening call
const OQ_SCREEN_EXCERPT    = 420;   // chars per doc (title + abstract snippet)
const OQ_SCREEN_MAX_TOKENS = 500;   // tiny response (just keys)
const OQ_SCREEN_KEEP_TOPN  = 350;   // target relevant docs after LLM screen (fallback to lexical)


// near CLUSTER_TITLE_MIN_SIZE
const AI_CLUSTER_MIN_SIZE = 10;  // was 11; tweak to taste
const COLOR_CLUSTER_MIN_SIZE = 10;


// Global rate limiter: minimum spacing between *any* OpenAI calls
const OPENAI_MIN_INTERVAL_MS = 1100; // hard gap between requests (ms)

let __OPENAI_NEXT_OK_TS = 0; 
let clusterSizesTotal = [];

const physics = {
  repulsion: 1400,   // charge strength (bigger = push apart more)
  repelRadius: 220,  // consider neighbors only within this radius
  cellSize: 120,     // spatial grid cell size (≈ repelRadius/2..cell)
  springK: 0.06,     // spring strength along edges
  restLength: 100,    // desired edge length
  centerPull: 0.03,  // gravity to canvas center
  damping: 0.86,     // 0..1 velocity damping
  timeStep: 0.3,     // integration step
  maxSpeed: 8        // clamp velocity per tick
};

let layoutBtn; // (optional) UI button
// ---- Camera / interactions ----
let cam = { x: 0, y: 0, scale: 1 };
let zoomLevel = 0; 
let isPanning = false;
let panStart = null;
let hoverIndex = -1;   // node under the cursor, -1 if none


let loadingPct = 0;   // 0..1 (no animation)

// --- Cluster labelling (AI) ---
let labelClustersBtn;
const LABEL_ABS_PER_CLUSTER = 60;   // how many abstracts to sample per cluster
const LABEL_ABS_CHARS       = 700;  // per-abstract char cap (token safety)

let ftFileInput = null;
let pendingFTIndex = -1; // which node we’re extracting fulltext for (local file path)


// ---- Lenses ----

clusterOf = [];        // cluster index per node
let clusterColors = [];    // array of [r,g,b] per cluster
let clusterCount = 0;

// citation stats for lens
let cbcMin = 0, cbcMax = 1; // cited_by_count min/max

// ---- Data + selection ----
let itemsData = [];          // holds payload.items
let selectedIndex = -1;      // currently selected node index

// ---- Info panel ----
let infoPanel;               // instance of InfoPanel (defined below)

const PANEL_WIDTH = 250;
const PANEL_MARGIN = 10; // all sides if you like; we’ll use it on right/top/bottom

const LENS_ICON_SIZE = 50; // was 100
const INFO_PANEL_RIGHT_OFFSET = 12;   // px from the right edge (increase → move left, decrease → move right)




let PANEL_HEIGHT = 800;      // ← change me (e.g., 300, 520, etc.)
const MAX_PANEL_HEIGHT = 600;

const INFO_PANEL_TOP_SHIFT = 200;  // move panel down by this many pixels

// --- Save/Load UI ---
let saveLoadBar, saveBtn, loadBtn, projectFileInput;

// --- Node Visibility (global multipliers, 0..1) ---
let visAllPubs = 1.0;      // scales ALL publication node alphas
let visDims    = 1.0;      // scales nodes in *non-AI* dimensions + their handles + their spokes
let visAIDims  = 1.0;      // scales nodes in *AI* dimensions + their handles + their spokes
let visEdges   = 1.0;

let ovAbstracts = 0;     // outline ring on docs that have abstracts
let ovOpenAccess = 0;    // green halo on OA docs
let ovClusterColors = 0; // node tint saturation for clusters
let ovClusterLabels = 0; // label pill opacity for clusters

// Panel handle
let overlaysPanel = null;


// ───── Touch / Pointer gestures for mobile (pinch-to-zoom + two-finger pan) ─────
let _activePointers = new Map();
let _gestureInit = null;   // { mid, dist, midWorld, scale }

function enableTouchGestures(p5Canvas){
  const el = (p5Canvas && p5Canvas.elt) ? p5Canvas.elt : p5Canvas;

  // Ensure the canvas owns the gesture on iOS Safari
  if (el && el.style) el.style.touchAction = 'none';

  // Block old iOS "gesture*" events from zooming the page
  el.addEventListener('gesturestart',  (e)=>e.preventDefault());
  el.addEventListener('gesturechange', (e)=>e.preventDefault());
  el.addEventListener('gestureend',    (e)=>e.preventDefault());

  // Prevent double-tap zoom
  el.addEventListener('touchstart', (e)=>{ e.preventDefault(); }, { passive:false });

  // Pointer Events (work for mouse, pen, touch)
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove, { passive:false });
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
}

function onPointerDown(e){
  if (pointerOverUI?.()) return;
  if (e.pointerType === 'mouse') return;      // ← let p5 mousePressed handle clicks
  e.preventDefault();
  e.target.setPointerCapture?.(e.pointerId);
  _activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

  if (_activePointers.size === 1){
    panStart = { x:e.clientX, y:e.clientY, camX:cam.x, camY:cam.y };
    isPanning = true;
  } else if (_activePointers.size === 2){
    _gestureInit = computePinchState();
  }
}

function onPointerMove(e){
  if (pointerOverUI?.()) return;
  if (e.pointerType === 'mouse') return;      // ← mouse uses p5 mouseDragged/moved
  if (!_activePointers.has(e.pointerId)) return;
  e.preventDefault();
  _activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

  if (_activePointers.size === 1 && isPanning && panStart){
    const p = _activePointers.values().next().value;
    cam.x = panStart.camX + (p.x - panStart.x);
    cam.y = panStart.camY + (p.y - panStart.y);
    redraw();
  } else if (_activePointers.size === 2){
    const now = computePinchState();
    if (_gestureInit){
      const zoom = now.dist / Math.max(1e-3, _gestureInit.dist);
      const newScale = clamp(_gestureInit.scale * zoom, 0.1, 64);
      const mid0 = _gestureInit.midWorld;
      cam.scale = newScale;
      cam.x = now.mid.x - mid0.x * cam.scale;
      cam.y = now.mid.y - mid0.y * cam.scale;
      redraw();
    }
  }
}

function onPointerUp(e){
  if (e.pointerType === 'mouse') return;      // ← mouse uses p5 mouseReleased
  _activePointers.delete(e.pointerId);
  if (_activePointers.size < 2) _gestureInit = null;
  if (_activePointers.size === 0){ isPanning = false; panStart = null; }
}

function computePinchState(){
  const pts = Array.from(_activePointers.values());
  const a = pts[0], b = pts[1];
  const mid = { x:(a.x + b.x)/2, y:(a.y + b.y)/2 };
  const dx = a.x - b.x, dy = a.y - b.y;
  const dist = Math.hypot(dx, dy);
  const midWorld = { x:(mid.x - cam.x) / (cam.scale||1), y:(mid.y - cam.y) / (cam.scale||1) };
  return { mid, dist, midWorld, scale: cam.scale || 1 };
}



function refreshDimMembershipFlags() {
  nodeInAnyDim   = new Array(nodes.length).fill(false);
  nodeInAnyAIDim = new Array(nodes.length).fill(false);

  for (const d of (dimTools || [])) {
    if (!d || !d.nodes) continue;        // supports Array or Set
    const isAI = (d.type === 'ai');
    for (const idx of d.nodes) {
      const i = idx | 0;
      if (i >= 0 && i < nodes.length) {
        if (isAI) nodeInAnyAIDim[i] = true;
        else      nodeInAnyDim[i]   = true;
      }
    }
  }
  dimMembershipDirty = false;
}


// Highest-wins scale used for NODE opacity and "is on" state
function visScaleForNode(i) {
  const sAll = visAllPubs;
  const sDim = nodeInAnyDim[i]   ? visDims   : 0;
  const sAI  = nodeInAnyAIDim[i] ? visAIDims : 0;
  return Math.max(sAll, sDim, sAI);
}



// Fast lookup for “is this node in a (AI|non-AI) dimension?”
let nodeInAnyDim   = [];   // boolean per node
let nodeInAnyAIDim = [];   // boolean per node
let dimMembershipDirty = true;


// ────────────────────────────────────────────────────────────────────────────
// Node Visibility panel (left column, above Filters)
// ────────────────────────────────────────────────────────────────────────────
let nodeVisPanel, allPubsSlider, dimsSlider, aiDimsSlider;

function buildNodeVisibilityPanelInto(containerBody) {
  // helper: row with label + short slider
  const mkSlider = (label, init, onInput) => {
    const row = createDiv('');
    row.parent(containerBody);
    row.style('display','flex');
    row.style('align-items','center');
    row.style('justify-content','space-between');
    row.style('gap','10px');
    row.style('margin','0 0 8px');

    const lab = createDiv(label);
    lab.parent(row);
    lab.style('color','#eaeaea');
    lab.style('font-size','12px');

    const slWrap = createDiv('');
    slWrap.parent(row);

    const sl = createSlider(0, 100, init|0, 1);
    sl.parent(slWrap);
    sl.style('width','120px');
    captureUI?.(sl.elt);

    // NEW: set initial zero-state class (white circle with black fill)
    markZeroClass?.(sl, (init|0) === 0);

    if (onInput) sl.input(onInput);
    return sl;
  };

  // All Publications
allPubsSlider = mkSlider('All Publications', Math.round(visAllPubs*100), (e) => {
  visAllPubs = Number(e.target.value)/100;
  markZeroClass?.({elt:e.target}, visAllPubs===0);
  scheduleVisRecompute(); // was: recomputeVisibility(); redraw();
});

  // Dimensions
dimsSlider = mkSlider('Dimensions', Math.round(visDims*100), (e) => {
  visDims = Number(e.target.value)/100;
  markZeroClass?.({elt:e.target}, visDims===0);
  scheduleVisRecompute(); // was: recomputeVisibility(); redraw();
});
  // AI Dimensions
aiDimsSlider = mkSlider('AI Dimensions', Math.round(visAIDims*100), (e) => {
  visAIDims = Number(e.target.value)/100;
  markZeroClass?.({elt:e.target}, visAIDims===0);
  recomputeVisibility(); 
  redraw();
});

// Citation Network (edge visibility)
edgesSlider = mkSlider('Citation Network', Math.round(visEdges*100), (e) => {
  visEdges = Number(e.target.value)/100;
  markZeroClass?.({elt:e.target}, visEdges===0);
  // No need to recompute visibility for nodes; just redraw with new edge alpha
  redraw();
});
// ── Node Size (circles) ─────────────────────────────────────────────
(() => {
  // initial % so that default radius (= NODE_R) lands correctly within [min..max]
  const initR   = (NODE_R * nodeSizeScale);
  const initPct = Math.round(
    Math.max(0, Math.min(100, invLerp01(NODE_SIZE_MIN, NODE_SIZE_MAX, initR) * 100))
  );
  const sl = mkSlider('Node Size', initPct, (e) => {
    const t = Number(e.target.value) / 100; // 0..1
    const targetR = lerp01(NODE_SIZE_MIN, NODE_SIZE_MAX, t);
    // scale is relative to NODE_R baseline (so n.r continues to work)
    nodeSizeScale = targetR / NODE_R;
    redraw();
  });
})();

}




// --- World (virtual canvas) ---
let world = { w: 4000, h: 3000 };   // will be resized per dataset

const BASE_WORLD_SIDE = 4000;       // minimum side length (px)
const AREA_PER_NODE   = 4500;       // ~space budget per node (px^2) -> adjust for density

// --- Full-text extraction (local-only) ---
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25MB safety cap

// --- AI footprints (clickable outlines for AI outputs) ---
window.aiFootprints = Array.isArray(window.aiFootprints) ? window.aiFootprints : [];
var aiFootprints = window.aiFootprints;
 // { id, type, nodeIds:number[], title, content, createdAt, _markerScreen? }
let aiMarkerImg = null;
const AI_MARKER_PATH = 'Icons/AI_Marker_50.png';

// --- Dimension handle icons ---
let dimHandleImg = null;    // normal Dimensions
let aiDimHandleImg = null;  // AI Dimensions
let DIM_HANDLE_ICON_PX   = 50;  // non-AI Dimensions (Authors, Venues, Concepts, Institutions, Clusters)
let AI_DIM_HANDLE_ICON_PX = 50; // AI Lenses (Lit Review, Abstracts, Chrono, Open Question)


let dimIcons = {};
// --- AI Lens handle icons (per lens type) ---
let aiLensIcons = {}; // { lit, abstracts, chrono, question, default }


const AI_DIM_JITTER = 28;

// --- AI footprints (clickable outlines for AI outputs) ---
window.aiFootprints = Array.isArray(window.aiFootprints) ? window.aiFootprints : [];
var aiFootprints = window.aiFootprints;

// Hover/active state used by highlight + draw cycles
var aiHoverFootprint = null;
var aiActiveFootprint = null;
var clusterHoverId = -1;

// ---- Selected-node “Citations UI” (zoom 3→4 fade-in) ----
const ZOOM_FADE_START = 3;
const ZOOM_FADE_END   = 4;

const CITE_BTN_DIAM          = 40;   // px (outer diameter of the little circles)
const CITE_BTN_RADIUS        = CITE_BTN_DIAM / 2;
const CITE_BTN_GAP_FROM_NODE = 0;   // px from node boundary to first (L1) button
const CITE_BTN_CONNECTOR     = 18;   // px centre-to-centre spacing between L1 and L2 on each side

// Later fade for the counts text
const ZOOM_LABEL_FADE_START = 5.0;
const ZOOM_LABEL_FADE_END   = 5.5;

// Extra px between the L1/L2 buttons and the labels
const LABEL_BTN_EXTRA_MARGIN = 10;

// How far L1 sits inside the node edge (in screen px, scaled by button size)
const L1_OVERLAY_INSET_MAX  = 14;   // px cap
const L1_OVERLAY_INSET_FRAC = 0.25; // ~25% of button radius

// near your UNPAYWALL_EMAIL definition in sketch.js
window.OPENALEX_MAILTO = UNPAYWALL_EMAIL;   // e.g. 'martyn.dade-robertson@northumbria.ac.uk'

// ---- Publication indexes for de-duplication ----
//const oaIdToNode = new Map();   // "https://openalex.org/W123…" -> node idx
const doiToNode  = new Map();   // "10.1234/xyz" (normalized)  -> node idx
const titleToNode= new Map();   // normalized title             -> node idx

function normOA(id) {
  if (!id) return null;
  const m = String(id).match(/W\d+/i);
  return m ? `https://openalex.org/${m[0].toUpperCase()}` : null;
}
function normDOI(doi) {
  if (!doi) return null;
  let s = String(doi).trim().toLowerCase();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  return s || null;
}
function normTitle(t) {
  if (!t) return null;
  return String(t).toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim() || null;
}
function inferVenueNameFromWork(w, fallback = '') {
  if (!w) return fallback;
  // Strong signals
  const v1 = w.host_venue?.display_name;
  const v2 = w.primary_location?.source?.display_name;
  if (v1) return v1;
  if (v2) return v2;

  // NEW: scan any location records that carry a source
  const locs = Array.isArray(w.locations) ? w.locations : [];
  for (const L of locs) {
    const name = L?.source?.display_name;
    if (name) return name;
  }

  // Compact/previous fallbacks
  return w.venue_name || fallback || '';
}





function indexExistingPubKeys() {
  oaIdToNode.clear(); doiToNode.clear(); titleToNode.clear();
  for (let i = 0; i < itemsData.length; i++) {
    const item = itemsData[i];
    const oa   = normOA(item?.openalex?.id);
    const doi  = normDOI(item?.openalex?.doi || item?.doi);
    const ttl  = normTitle(item?.label || item?.openalex?.title || item?.openalex?.display_name);
    if (oa   != null) oaIdToNode.set(oa, nodes.findIndex(n => n && n.idx === i));
    if (doi  != null) doiToNode.set(doi, nodes.findIndex(n => n && n.idx === i));
    if (ttl  != null) titleToNode.set(ttl, nodes.findIndex(n => n && n.idx === i));
  }
}



let citeUi = {
  buttons: [],   // [{side:'left'|'right', level:1|2, sx, sy, r, tip}]
  hover: -1,     // index into buttons (or -1)
  visible: false // currently being drawn this frame
};

// --- Citation button icons ---
let iconLeftL1, iconLeftL2, iconRightL1, iconRightL2;



function preload() {
  // AI marker
  aiMarkerImg = loadImage(
    AI_MARKER_PATH,
    () => {},
    () => console.warn('AI marker not found at', AI_MARKER_PATH)
  );

  poweredByImg = loadImage(
  'Icons/Powered_By.png',
  () => {},
  () => console.warn('Missing Icons/Powered_By.png')
);

splashImg = loadImage(
  'Icons/Splash.png',
  () => {},
  () => console.warn('Missing Icons/Splash.png')
);
splashDemoImg = loadImage(
  'Icons/Splash_Demo.png',
  () => {},
  () => console.warn('Missing Icons/Splash_Demo.png')
);
// Bug icon (case-sensitive on GitHub Pages; make sure filename matches!)
bugIconImg = loadImage(
  'Icons/bug.png', // or 'Icons/Bug.png' if that’s your filename
  () => {},
  () => console.warn('Missing Icons/bug.png')
);

  // Category-specific handle icons
  dimIcons = {
    authors:  loadImage('Icons/Dim_Author.png',       () => {}, () => console.warn('Missing Icons/Dim_Author.png')),
    clusters: loadImage('Icons/Dim_Cluster.png',      () => {}, () => console.warn('Missing Icons/Dim_Cluster.png')),
    concepts: loadImage('Icons/Dim_Concept.png',      () => {}, () => console.warn('Missing Icons/Dim_Concept.png')),
    venues:   loadImage('Icons/Dim_Venue.png',        () => {}, () => console.warn('Missing Icons/Dim_Venue.png')),
    default:  loadImage('Icons/Dimensions_Handle.png',() => {}, () => console.warn('Missing Icons/Dimensions_Handle.png')),
    institutions: loadImage('Icons/Dim_Inst.png',         () => {}, () => console.warn('Missing Icons/Dim_Inst.png')),
  institution:  loadImage('Icons/Dim_Inst.png',         () => {}, () => console.warn('Missing Icons/Dim_Inst.png')), // alias
    ai:       loadImage('Icons/AI_Dim_Handle.png',    () => {}, () => console.warn('Missing Icons/AI_Dim_Handle.png')),
  };

  aiLensIcons = {
    lit:       loadImage('Icons/Lens_Lit.png',        () => {}, () => console.warn('Missing Icons/Lens_Lit.png')),
    abstracts: loadImage('Icons/Lens_Abstracts.png',  () => {}, () => console.warn('Missing Icons/Lens_Abstracts.png')),
    chrono:    loadImage('Icons/Lens_Chrono.png',     () => {}, () => console.warn('Missing Icons/Lens_Chrono.png')),
    question:  loadImage('Icons/Lens_Question.png',   () => {}, () => console.warn('Missing Icons/Lens_Question.png')),
    // fallback to the generic AI handle if a specific icon is missing
    default:   dimIcons.ai || loadImage('Icons/AI_Dim_Handle.png', () => {}, () => {})
  }; 

  // Citation buttons
  iconLeftL1  = loadImage('Icons/Cited_1.png',     () => {}, () => console.warn('Missing Icons/Cited_1.png'));
  iconLeftL2  = loadImage('Icons/Cited_2.png',     () => {}, () => console.warn('Missing Icons/Cited_2.png'));
  iconRightL1 = loadImage('Icons/Cited_By_1.png',  () => {}, () => console.warn('Missing Icons/Cited_By_1.png'));
  iconRightL2 = loadImage('Icons/Cited_By_2.png',  () => {}, () => { 
    console.warn('Missing Icons/Cited_By_2.png; falling back to Cited_By_1.png');
    iconRightL2 = iconRightL1;
  });
}



function pickOaFulltextUrl(w) {
  const best = w?.best_oa_location || {};
  const prim = w?.primary_location || {};
  const cand = [
    best.url_for_pdf,
    best.pdf_url,
    prim.pdf_url,
    best.landing_page_url,
    prim.landing_page_url
  ].filter(u => typeof u === 'string' && u.startsWith('http'));
  return cand[0] || '';
}

function extractTextFromHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.querySelector('article, main, .article, .Article, .content, .Content, [role="main"]') || doc.body;
    root.querySelectorAll('script,style,noscript,header,footer,nav,aside,form').forEach(n => n.remove());
    return (root.innerText || root.textContent || '').replace(/\s+/g,' ').trim();
  } catch { return ''; }
}


async function extractTextFromPdfBuffer(arrayBuffer) {
  if (typeof pdfjsLib === 'undefined' || !pdfjsLib?.getDocument) {
    throw new Error('PDF.js not available. Include pdfjs-dist and worker in index.html.');
  }
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  let out = '';
  try {
    const N = pdf.numPages;
    for (let p = 1; p <= N; p++) {
      setLoadingProgress(0.05 + 0.9 * (p / N), `Extracting text… page ${p}/${N}`);
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const strings = content.items.map(it => it.str);
      out += strings.join(' ') + '\n\n';
      await nextTick();            // yield to UI
    }
    return out.replace(/\s+/g, ' ').trim();
  } finally {
    try { await pdf.cleanup?.(); } catch {}
    try { await pdf.destroy?.(); } catch {}
    try { loadingTask.destroy?.(); } catch {}
    // encourage GC
    // (call site will drop references to buffers; we just avoid holding onto them)
  }
}


// Add/replace this whole function
async function extractFullTextForIndex(i, ftContainerId = null, opts = {}) {
  const silent = !!opts.silent;

  const item = itemsData?.[i] || {};
  const w    = item.openalex || {};
  const doi  = cleanDOI(String(w.doi || ''));
  const doiUrl = doi ? `https://doi.org/${doi}` : '';


  // inside extractFullTextForIndex, just after you compute doi/doiUrl:


if (!doi) {
  const found = await discoverDoiForIndex(i);
  if (found) {
    doi = cleanDOI(found);
    doiUrl = `https://doi.org/${doi}`;
  }
}

// rebuild candidates now that DOI might exist
let cand = fulltextCandidatesFromWork(w, doiUrl);


  // 2) Ask Unpaywall for stronger OA links (optional, if email set)
  if (doi && UNPAYWALL_EMAIL) {
    const up = await fetchUnpaywall(doi);
    cand = mergeUnpaywallCandidates(up, cand);
  }

  const setFtPanel = (html) => {
    if (!ftContainerId) return;
    const el = document.getElementById(ftContainerId);
    if (el) el.innerHTML = html;
  };

  if (!cand.length) {
    setFtPanel(`<div style="opacity:.85">No OA links found. Try ${doiUrl ? `<a href="${doiUrl}" target="_blank" style="color:#8ecbff">DOI</a>` : 'DOI'} or use local PDF.</div>`);
    if (!silent) { msg = 'No open-access fulltext URL found.'; updateInfo(); redraw(); }
    return false;
  }

  if (!silent) {
    showLoading('Fetching full text…', 0.05);
    setFtPanel(`<div style="opacity:.9">Fetching full text…</div>`);
  }

  const MAX_PDF_BYTES = 25 * 1024 * 1024;
  let lastErr = null;

  for (let idx = 0; idx < Math.min(cand.length, 8); idx++) {
    const url = cand[idx];
    try {
      // *** THE IMPORTANT CHANGE: always go via the proxy ***
      const resp = await fetchWithTimeout(viaProxy(url), { redirect: 'follow' }, 20000);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const ctype = (resp.headers.get('content-type') || '').toLowerCase();
      const looksPdf = ctype.includes('pdf') || /\.pdf(\?|$)/i.test(url);

      if (looksPdf) {
        const blob = await resp.blob();
        if (blob.size > MAX_PDF_BYTES) throw new Error('PDF too large (>25MB).');
        const buf  = await blob.arrayBuffer();
        const text = await extractTextFromPdfBuffer(buf);
        if (!text || text.length < 80) throw new Error('No text extracted (scanned PDF?).');
        item.fulltext = text;
      } else {
        const html = await resp.text();
        const text = extractTextFromHtml(html);
        if (!text || text.length < 80) throw new Error('No readable text found on HTML page.');
        item.fulltext = text;
      }

      // success → cache + UI
      item.fulltext_source       = url;
      item.fulltext_extracted_at = new Date().toISOString();
      if (nodes[i]) nodes[i].hasFullText = true;

      if (!silent) {
        msg = 'Full text extracted and cached.';
        setFtPanel(`<div style="opacity:.95">Cached ✓</div>`);
        if (infoPanel && infoPanel.index === i) infoPanel.setItemIndex(i);
        hideLoading(); updateInfo(); redraw();
      }
      return true;

    } catch (err) {
      if (err?.name === 'AbortError') {
    lastErr = new Error('Network timeout (host slow or blocked).');
  } else {
    lastErr = err;
  }
      // keep trying
    }
  }

  if (!silent) {
    const doiLink = doiUrl ? `<a href="${doiUrl}" target="_blank" style="color:#8ecbff">open DOI</a>` : 'open source';
    setFtPanel(`
      <div style="opacity:.95">
        Extraction failed (${lastErr?.message || 'blocked'}).
        You can ${doiLink} and <a href="#" id="ftLocalPick" style="color:#8ecbff">use local PDF…</a>
      </div>
    `);
    document.getElementById('ftLocalPick')?.addEventListener('click', (ev) => {
      ev.preventDefault(); promptLocalPdfForIndex(i);
    });
    msg = `Full text extraction failed: ${lastErr?.message || 'blocked'}`;
    hideLoading(); updateInfo(); redraw();
  }
  return false;
}



function setWorldSizeForN(n) {
  const minArea = BASE_WORLD_SIDE * BASE_WORLD_SIDE;
  const targetArea = Math.max(minArea, n * AREA_PER_NODE);
  const side = Math.ceil(Math.sqrt(targetArea));
  world.w = side;
  world.h = side;
}

function centerCameraOnWorld() {
  // center the world in the viewport at current zoom
  const sx = width  * 0.5;
  const sy = height * 0.5;
  cam.x = sx - (world.w * 0.5) * cam.scale;
  cam.y = sy - (world.h * 0.5) * cam.scale;
}

function adjustWorldToContent(margin = 50) {
  // expands world to fit existing node positions (useful on restore)
  if (!nodes.length) return;
  let minX =  1e9, minY =  1e9, maxX = -1e9, maxY = -1e9;
  for (const n of nodes) { if (!n) continue;
    if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y;
  }
  const w = Math.max(world.w, (maxX - minX) + margin * 2);
  const h = Math.max(world.h, (maxY - minY) + margin * 2);
  world.w = w; world.h = h;
}



// ---- Lenses ---- sets the default starting state for the lenses
let lenses = { citationShade: false, 
  showEdges: true, 
  domainClusters: false, 
  openAccess: false, 
  hideNonDim: false,
 onlyAbstracts: false,
 aiDocs: false};
let lensButtons = {};
let dimFilterLock = null;





// ---- Filters: internal degree ----
let degSlider, degLabel;
let degree = [];          // degree[i] = adj[i].length (undirected)
let degreeMax = 0;
let degThreshold = 0;     // current threshold
let visibleMask = [];     // visibleMask[i] = true if node passes filter
let edgesFiltered = [];   // edges to draw after filtering

// ---- External citations (OpenAlex total) filter ----
let extCitesSlider, extCitesLabel;
let extCitesThreshold = 0;  // nodes must have cbc >= this

// NEW: Cluster-size filter (UI + state)
let clusterSizeSlider, clusterSizeLabel;
let clusterSizeThreshold = 0;   // show only clusters with size >= this
// Inline numeric inputs (refs set in buildFiltersInto)
let extCitesInput, degInput, clusterSizeInput, yearLoInput, yearHiInput;



// ---- Date-range filter ----
let yearSliderMin, yearSliderMax, yearLabel;
let yearMin = 0, yearMax = 0;   // dataset bounds
let yearLo = 0, yearHi = 0;     // current selection


function createSaveLoadBar() {
  // Container (top-right). Adjust 'top' if you want it below your logo.
  saveLoadBar = createDiv('');
  saveLoadBar.style('position','fixed');
  saveLoadBar.style('right','12px');
  saveLoadBar.style('top','12px');
  saveLoadBar.style('display','flex');
  saveLoadBar.style('gap','8px');
  saveLoadBar.style('z-index','10020');
  captureUI(saveLoadBar.elt); // prevent canvas pan when clicking here

  // Save
saveBtn = createImg('./Icons/Save.png', 'Save');
saveBtn.parent(saveLoadBar);
saveBtn.size(40, 40);
saveBtn.style('display','block');
saveBtn.style('cursor','pointer');
saveBtn.attribute('draggable','false');
saveBtn.attribute('title', 'Save'); 
attachTooltip(saveBtn, 'Save');  
if (typeof captureUI === 'function') captureUI(saveBtn.elt);
saveBtn.mousePressed(saveProject);

  if (DEMO_MODE) {
    saveBtn.style('opacity', '0.1');
    saveBtn.style('pointer-events', 'none');
    saveBtn.style('cursor', 'default');
    saveBtn.attribute('title', 'Save (disabled in Demo mode)');
  }

  // Load
loadBtn = createImg('./Icons/Load.png', 'Load');
loadBtn.parent(saveLoadBar);
loadBtn.size(40, 40);
loadBtn.style('display','block');
loadBtn.style('cursor','pointer');
loadBtn.attribute('draggable','false');
loadBtn.attribute('title', 'Load');  
attachTooltip(loadBtn, 'Load');       
if (typeof captureUI === 'function') captureUI(loadBtn.elt);
loadBtn.mousePressed(() => {
  if (DEMO_MODE) {
    showDemoDatasetMenu();  // new function (added below)
  } else {
    if (!projectFileInput) {
      projectFileInput = createFileInput(handleProjectFileSelected, false);
      projectFileInput.hide();
    }
    projectFileInput.elt.value = '';
    projectFileInput.elt.click();
  }
});
// Bug / Feature icon (right side)
if (BUG_MODE) {
  const bugBtn = createImg('./Icons/bug.png', 'Report bug / suggest feature');
  bugBtn.parent(saveLoadBar);
  bugBtn.size(40, 40);
  bugBtn.style('display','block');
  bugBtn.style('cursor','pointer');
  bugBtn.attribute('draggable','false');
  bugBtn.attribute('title', 'Report bug / suggest feature');
  attachTooltip?.(bugBtn, 'Report bug / suggest feature'); // matches your pattern
  captureUI?.(bugBtn.elt);
  bugBtn.mousePressed(openBugDialog);
}


// After you create Save/Load buttons:
// Export Viewer (using image instead of text)
const exportViewerBtn = createImg('./Icons/Publish.png', 'Export Viewer');
exportViewerBtn.parent(saveLoadBar);
exportViewerBtn.size(40, 40);
exportViewerBtn.style('display', 'block');
exportViewerBtn.style('cursor', 'pointer');
exportViewerBtn.attribute('draggable', 'false');
exportViewerBtn.attribute('title', 'Export Viewer');
attachTooltip(exportViewerBtn, 'Publish');
if (typeof captureUI === 'function') captureUI(exportViewerBtn.elt);

exportViewerBtn.mousePressed(() => {
  if (DEMO_MODE) return;
  openPublishDialog(({ name, title, text }) => {
    exportViewerPackageZip({ fileName: name, userTitle: title, userText: text });
  });
});


  if (DEMO_MODE) {
    exportViewerBtn.style('opacity', '0.1');
    exportViewerBtn.style('pointer-events', 'none');
    exportViewerBtn.style('cursor', 'default');
    exportViewerBtn.attribute('title', 'Publish (disabled in Demo mode)');
  }
}

// Cache for the demo list to avoid refetching
let __demoDatasetList = null;
let __demoMenuDiv = null;

async function showDemoDatasetMenu() {
  try {
    // Fetch / cache the dataset list
    if (!__demoDatasetList) {
      const r = await fetch('Test_Data/datasets.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`Failed to read Test_Data/datasets.json (HTTP ${r.status})`);
      __demoDatasetList = await r.json();
      if (!Array.isArray(__demoDatasetList)) throw new Error('datasets.json must be an array');
    }

    // Build a lightweight overlay menu
    if (!__demoMenuDiv) {
      __demoMenuDiv = createDiv('');
      __demoMenuDiv.id('demoDatasetMenu');
      __demoMenuDiv.style('position', 'fixed');
      __demoMenuDiv.style('top', '80px');
      __demoMenuDiv.style('right', '20px');
      __demoMenuDiv.style('width', '320px');
      __demoMenuDiv.style('max-height', '60vh');
      __demoMenuDiv.style('overflow', 'auto');
      __demoMenuDiv.style('padding', '12px');
      __demoMenuDiv.style('background', 'rgba(0,0,0,0.8)');
      __demoMenuDiv.style('color', '#fff');
      __demoMenuDiv.style('border-radius', '12px');
      __demoMenuDiv.style('box-shadow', '0 8px 24px rgba(0,0,0,0.35)');
      __demoMenuDiv.style('z-index', '9999');
    } else {
      __demoMenuDiv.html(''); // clear
      __demoMenuDiv.show();
    }

    // Title + close
    const header = createDiv('<b>Open Demo Dataset</b>');
    header.parent(__demoMenuDiv);
    header.style('margin-bottom', '8px');

    const closeBtn = createButton('Close');
    closeBtn.parent(__demoMenuDiv);
    closeBtn.mousePressed(() => __demoMenuDiv.hide());
    closeBtn.style('float', 'right');
    closeBtn.style('margin-top', '-28px');

    // List entries
    const list = createDiv('');
    list.parent(__demoMenuDiv);
    list.style('margin-top', '8px');

    __demoDatasetList.forEach(entry => {
      const row = createDiv('');
      row.parent(list);
      row.style('display', 'flex');
      row.style('justify-content', 'space-between');
      row.style('align-items', 'center');
      row.style('padding', '8px 10px');
      row.style('margin', '6px 0');
      row.style('border', '1px solid rgba(255,255,255,0.15)');
      row.style('border-radius', '10px');
      row.style('cursor', 'pointer');

      const label = createDiv(entry.title || entry.slug);
      label.parent(row);
      label.style('pointer-events', 'none');

      const open = createButton('Open');
      open.parent(row);
      open.mousePressed(async (e) => {
        e.stopPropagation();
        __demoMenuDiv.hide();
        await demoOpenDataset(entry.slug);
      });

      // Click row for convenience
      row.mousePressed(async () => {
        __demoMenuDiv.hide();
        await demoOpenDataset(entry.slug);
      });
    });

  } catch (err) {
    console.error(err);
    showToast?.(err.message || String(err));
  }
}

// Load a chosen demo dataset from Test_Data/<slug>/data/index.json
async function demoOpenDataset(slug) {
  try {
    if (!slug) throw new Error('Dataset slug missing');
    // Point shard lookups to this hosted demo folder (relative to app root)
    window.DATA_BASE_PREFIX = `Test_Data/${slug}/`;

    // Load the manifest
    showLoading?.(`Opening ${slug}…`, 0.05);
    const r = await fetch(`${window.DATA_BASE_PREFIX}data/index.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Failed to load index.json (HTTP ${r.status})`);
    const indexObj = await r.json();

    // This sets REMOTE_DETAILS_BASE / REMOTE_AI_BASE using index.meta.paths (+ prefix)
    await restoreFromViewerIndex(indexObj);

    hideLoading?.();
    msg = `Opened demo: ${slug}`;
    updateInfo?.(); redraw?.();
  } catch (e) {
    hideLoading?.();
    console.error(e);
    showToast?.(e.message || String(e));
  }
}



// ---------- Dimensions data & UI ----------
let dimsIndex = { authors: new Map(), venues: new Map(), concepts: new Map(), institutions: new Map(), clusters: new Map()};
let dimSections = {};   // UI <details> per section
let dimTools = [];      // active handles
let dimByKey = new Map(); // "type|name" -> index in dimTools
let selectedDim = -1;   // which handle is selected (-1 none)
let dimHover = -1;      // which handle is hovered (-1 none)
let dimDrag = { active:false, idx:-1, dx:0, dy:0, sx:0, sy:0 };


// clickable hit-areas for cluster labels (screen space)
let clusterLabelHits = [];   // [{ cid, rx, ry, rr }]


// Left-column placement
const LEFT_PANEL_X = 12;
// Put the Dimensions sidebar below your Filters; tweak if needed
const DIM_SIDEBAR_TOP = 425;
// Extra spacing between the Dimensions title and the tools (accordion)
const DIM_SIDEBAR_SHIFT = 8;  // ← change this to move tools down/up
 

let dimSidebar = null;   // scrollable container for all Dimensions sections
const DIM_MAX_ROWS_EMPTY    = 120;   // cap when no/very short query
const DIM_MAX_ROWS_FILTERED = 300;   // cap when filtering
let dimSearchQuery = '';
let dimSectionsWrap = null;
let dimSearchInput = null;

function runDimSearch() {
  const inp = dimSearchInput?.value ? dimSearchInput : null;
  dimSearchQuery = (inp ? inp.value() : '').trim().toLowerCase();
  updateDimSections();
  if (inp && inp.elt) inp.elt.focus();
}

// ─────────────────────────────────────────────────────────────
// Accordion helpers for left column (collapsed by default)
// ─────────────────────────────────────────────────────────────
const LEFT_COLUMN_X = 12;
const LEFT_COLUMN_TOP = 96;  // under your top bar
const LEFT_PANEL_WIDTH = 260;
const LEFT_PANEL_GAP = 12;

function createAccordionPanel(title, id) {
  // Root
  const root = createDiv('');
  root.id(id);
  root.style('position', 'fixed');
  root.style('left', `${LEFT_COLUMN_X}px`);
  root.style('width', `${LEFT_PANEL_WIDTH}px`);
  root.style('z-index','9980');
  root.style('background','rgba(0,0,0,0.55)');
  root.style('border','1px solid rgba(255,255,255,0.12)');
  root.style('border-radius','12px');
  root.style('box-shadow','0 8px 24px rgba(0,0,0,0.25)');
  root.style('backdrop-filter','blur(2px)');

  // Header
  const header = createDiv(title);
  header.parent(root);
  header.style('color','#fff');
  header.style('font-weight','600');
  header.style('letter-spacing','0.2px');
  header.style('padding','10px 16px 10px 12px');
  header.style('cursor','pointer');
  header.style('user-select','none');
  header.mousePressed(() => toggleAccordion(id));

  // Body (starts hidden)
  const body = createDiv('');
  body.parent(root);
  body.addClass('accordion-body');
  body.style('display','none');
  body.style('padding','0 16px 12px 12px');

  // API
  const api = {
    id, root, header, body,
    isOpen: false,
    setOpen(open) {
      api.isOpen = !!open;
      body.style('display', open ? 'block' : 'none');
      relayoutLeftColumn();
    }
  };

  if (!window.__ACCORDIONS__) window.__ACCORDIONS__ = [];
  window.__ACCORDIONS__.push(api);
  return api;
}

function toggleAccordion(id) {
  const a = (window.__ACCORDIONS__||[]).find(p => p.id === id);
  if (!a) return;
  a.setOpen(!a.isOpen);
}

function relayoutLeftColumn() {
  // Stack all registered accordions top→bottom with gaps.
  const list = (window.__ACCORDIONS__||[]);
  let y = LEFT_COLUMN_TOP;
  for (const a of list) {
    a.root.style('top', `${Math.round(y)}px`);
    // Height = header + (body if open)
    const rect = a.root.elt.getBoundingClientRect();
    const hdrH = a.header.elt.getBoundingClientRect().height || 40;
    let bodyH = 0;
    if (a.isOpen) {
      // force measurement by temporarily ensuring body is block
      a.body.style('display','block');
      bodyH = a.body.elt.getBoundingClientRect().height || 0;
      a.body.style('display','block'); // keep it open
    }
    const total = Math.max(hdrH + (a.isOpen ? bodyH : 0), 40);
    y += total + LEFT_PANEL_GAP;
  }
}



let lensBar;                 // container DIV for the icon row       // key -> p5.Element <img>

let topBar;                 // container for "Import JSON" + "Run Layout" icons
const CONTROL_ICON_SIZE = 40;
let ctrlIcons = { load:null, layout:null };

// Color per dimension type (RGB)
const DIM_COLORS = {
  authors: [140, 200, 255],
  venues: [255, 180, 110],
  concepts: [195, 160, 255],
  institutions: [140, 255, 170],
  clusters: [255, 230, 100] 



};
// Robust citation shading
let cbcP5 = 0, cbcP95 = 1;      // 5th/95th percentiles
let cbcLogMin = 0, cbcLogMax = 1;

// Robust internal in-degree shading (citations received within the graph)
let intInP5 = 0, intInP95 = 1;
let intInLogMin = 0, intInLogMax = 1;

function computeIntInRobustStats() {
  if (!nodes || !nodes.length) {
    intInP5 = 0; intInP95 = 1; intInLogMin = 0; intInLogMax = 1;
    return;
  }
  const vals = nodes.map(n => Math.max(0, Number(n.intIn || 0))).sort((a,b)=>a-b);
  if (!vals.length) { intInP5 = 0; intInP95 = 1; intInLogMin = 0; intInLogMax = 1; return; }
  const pick = (p) => vals[Math.max(0, Math.min(vals.length-1, Math.floor(p*(vals.length-1))))];
  if (vals.length < 10) { intInP5 = vals[0]; intInP95 = vals[vals.length-1]; }
  else {
    intInP5 = pick(0.05); intInP95 = pick(0.95);
    if (intInP95 <= intInP5) { intInP5 = vals[0]; intInP95 = vals[vals.length-1]; }
  }
  intInLogMin = Math.log1p(intInP5);
  intInLogMax = Math.log1p(intInP95);
  if (intInLogMax <= intInLogMin) { intInLogMin = Math.log1p(vals[0]||0); intInLogMax = Math.log1p(vals[vals.length-1]||1); }
}



// --- Synthesis UI ---
let synthBtn, synthPanel, synthBody, synthCloseBtn, synthCopyBtn, synthDownloadBtn;
const MAX_SYNTH_ITEMS = 200;      // safety cap (visible items only)
const MAX_ABSTRACT_CHARS = 2000;  // truncate each abstract for token budget


// --- Cluster labels ---
let clusterLabels = [];                 // clusterId -> "three word title"
const CLUSTER_TITLE_MIN_SIZE = 5;      // strictly > 10 items to label


// --- Section titles ---


const TITLE_WIDTH = 150;
const TITLE_FONT_SIZE = 14;
const TITLE_LINE_PX = 2;
const TITLE_GAP_PX  = 5;

const LENSES_TITLE_TOP     = 56;        // sits above the lens icon row
const FILTERS_TITLE_TOP    = 220;       // same place you had before (with underline now)

// --- Loading overlay ---
let isLoading = false;
let loadingMsg = '';
let loadingPhase = 0;   // animation phase

// screen-space label centers, filled each frame by drawClusterLabels()
let clusterLabelCenters = []; // [cid] -> { sx, sy, h }

// --- Synthesis (large-scale) tuning ---
const SYNTH_CHUNK_SIZE      = 80;    // abstracts per API call (safe for 4o-mini)
const SYNTH_MAX_PARALLEL    = 1;     // run chunks serially (keep it 1 in browser)
const SYNTH_BODY_MAX_TOKENS = 2200;  // per chunk output cap
const SYNTH_META_MAX_TOKENS = 2600;  // final merge output cap
const USE_INLINE_CITATIONS  = true; // large-scale: omit inline [n] to avoid conflicts



// --- p5 lifecycle ------------------------------------------------------------
function setup() {
  //createCanvas(windowWidth, windowHeight);
  const cnv = createCanvas(windowWidth, windowHeight);
  noLoop(); // draw only when we have data or on resize
cnv.style('position','fixed');
cnv.style('left','0');
cnv.style('top','0');
cnv.style('z-index','0');
enableTouchGestures(cnv);


  // Hook up the HTML controls that are already in index.html
  importBtn = select("#importBtn");
  infoSpan  = select("#info");

if (infoSpan) {
  infoSpan.style('position','fixed');
  infoSpan.style('right','12px');
  infoSpan.style('bottom','12px');
  infoSpan.style('color','#eaeaea');
  infoSpan.style('font-size','12px');
  infoSpan.style('background','rgba(0,0,0,0.35)');
  infoSpan.style('padding','4px 6px');
  infoSpan.style('border-radius','6px');
  infoSpan.style('z-index','9996');
}

// Build left-column accordion shells (all collapsed initially)
const accVisibility = createAccordionPanel('Visibility', 'acc-visibility');
const accFilters    = createAccordionPanel('Filters',    'acc-filters');
const accOverlays   = createAccordionPanel('Overlays',   'acc-overlays');
const accDims       = createAccordionPanel('Dimensions', 'acc-dimensions');

// If you want any to start open, setOpen(true) on that one.
// e.g. accVisibility.setOpen(true);
relayoutLeftColumn();


// --- Section headers ---
// --- Section headers ---
lensesTitle  = createSectionHeader('Lenses',  12, LENSES_TITLE_TOP);
//filtersTitle = createSectionHeader('Filters', 12, FILTERS_TITLE_TOP);

// Dimensions: compute top with its real 1px line + 10px gap, then drop +5px
const DIMS_LINE = 1, DIMS_GAP = 10;
const dimsTitleTop = DIM_SIDEBAR_TOP - (TITLE_FONT_SIZE + DIMS_LINE + DIMS_GAP + 2) + 5;
//dimensionsTitle = createSectionHeader('Dimensions', 12, Math.max(0, dimsTitleTop));

// + Add (or keep if you already have)
DIM_COLORS.ai = [130, 210, 255]; // soft cyan for AI dimensions

// Per-title style overrides
//filtersTitle.style('border-bottom','1px solid #fff');
//filtersTitle.style('padding-bottom','10px');

//dimensionsTitle.style('border-bottom','1px solid #fff');
//dimensionsTitle.style('padding-bottom','10px');

// Reduce Lenses underline to 1px (gap stays at the default 5px)
lensesTitle.style('border-bottom','1px solid #fff');


importBtn = select("#importBtn");
if (importBtn) importBtn.hide();

  // Hidden file input driven by the button
// Use a hidden file input (we trigger it from our top bar)
hiddenFileInput = createFileInput(handleAnyImportSelected, false);
hiddenFileInput.elt.style.display = 'none';
hiddenFileInput.elt.setAttribute('accept', '.json,application/json,application/pdf,.pdf');

// 🔧 Add these:
createTopControlBar();   // top-left icon bar (Import JSON & Force Layout)
createSaveLoadBar();     // top-right Save/Load project panel
createProjectMetaPanel();

  // Initial UI text
  updateInfo();    // ← ADD THIS
// after createLensesMenuButton(), createAIMenuButton(), etc.

recomputeVisibility?.();
redraw();


// Lens buttons on the left side

createSynthesisUI();      // keep the panel – the dropdown will open it when needed
createAIMenuButton();

// Right-side info panel (x, y, w, h) — h is capped at 800 inside the class
// Right-side info panel (x, y, w, h)
document.querySelectorAll('.info-panel').forEach(el => el.remove());

infoPanel = new InfoPanel(
  windowWidth - PANEL_WIDTH - PANEL_MARGIN,
  PANEL_MARGIN + INFO_PANEL_TOP_SHIFT,
  PANEL_WIDTH,
  computePanelHeight()
);

showCanvasOverviewIfNoneSelected(); // start hidden if you prefer

// Internal degree slider label

buildNodeVisibilityPanelInto(select('#acc-visibility')?.elt
  ? select('#acc-visibility').elt.querySelector('.accordion-body')
  : null);

buildFiltersInto(select('#acc-filters')?.elt
  ? select('#acc-filters').elt.querySelector('.accordion-body')
  : null);
buildOverlaysInto(select('#acc-overlays')?.elt
  ? select('#acc-overlays').elt.querySelector('.accordion-body')
  : null);

 mountDimensionsInto(select('#acc-dimensions')?.elt
  ? select('#acc-dimensions').elt.querySelector('.accordion-body')
  : null); 
// ────────────────────────────────────────────────────────────────────────────
// Filters panel: wrap existing controls in a styled box (like the Info panel)
// and move the whole block up under the top controls
// ────────────────────────────────────────────────────────────────────────────



//createApiKeyUI();
//createSynthesisUI();

  // <- re-add the abstracts button

// at end of setup() after other inputs:
ftFileInput = createFileInput(handleFtFileSelected, false);
ftFileInput.hide();
// Use a hidden file input (we trigger it from our top bar)

// Filters (degree + year sliders)

(function injectZeroThumbCSS(){
  if (document.getElementById('zero-thumb-css')) return;
  const css = `
    /* Base track */
    #acc-visibility input[type="range"]{
      -webkit-appearance: none !important;
      appearance: none !important;
      height: 6px !important;
      background: rgba(255,255,255,0.15) !important;
      border-radius: 6px !important;
      outline: none !important;
    }
    /* WebKit thumb */
    #acc-visibility input[type="range"]::-webkit-slider-thumb{
      -webkit-appearance: none !important;
      appearance: none !important;
      width: 14px !important;
      height: 14px !important;
      border-radius: 50% !important;
      background: #e5e5ea !important;           
      border: 2px solid rgba(255,255,255,0.7) !important;
    }
    /* Firefox thumb */
    #acc-visibility input[type="range"]::-moz-range-thumb{
      width: 14px !important;
      height: 14px !important;
      border-radius: 50% !important;
      background: #e5e5ea !important;           
      border: 2px solid rgba(255,255,255,0.7) !important;
    }
    /* 0-state: white outline + black fill */
    #acc-visibility input[type="range"].is-zero::-webkit-slider-thumb{
      background: #000 !important;
      border: 2px solid #fff !important;
    }
    #acc-visibility input[type="range"].is-zero::-moz-range-thumb{
      background: #000 !important;
      border: 2px solid #fff !important;
    }
  `;
  const tag = document.createElement('style');
  tag.id = 'zero-thumb-css';
  tag.textContent = css;
  document.head.appendChild(tag);
})();

(function killScrollbars(){
  if (document.getElementById('no-scroll-css')) return;
const css = `
    html, body { margin:0; padding:0; height:100%; overflow:hidden; }
    /* Make the canvas own the gesture on touch devices */
    canvas { display:block; touch-action:none; -ms-touch-action:none; }
    /* Avoid pull-to-refresh/bounce */
    html, body { overscroll-behavior: none; }
  `;
  const s = document.createElement('style');
  s.id = 'no-scroll-css';
  s.textContent = css;
  document.head.appendChild(s);
})();

}

function markZeroClass(slider, isZero) {
  try { slider.elt.classList.toggle('is-zero', !!isZero); } catch {}
}

function windowResized() {
  // remember which world point is at the screen center
  const worldCx = (width  * 0.5 - cam.x) / cam.scale;
  const worldCy = (height * 0.5 - cam.y) / cam.scale;

  // resize the canvas to the new window size
  resizeCanvas(windowWidth, windowHeight);

  // keep the same world point at the center after resize
  cam.x = width  * 0.5 - worldCx * cam.scale;
  cam.y = height * 0.5 - worldCy * cam.scale;

  // refresh right-side panel height & position to the new viewport
  if (infoPanel && typeof infoPanel.dockRight === 'function') {
    infoPanel.dockRight(12, PANEL_MARGIN + INFO_PANEL_TOP_SHIFT, PANEL_WIDTH, computePanelHeight());
  }
relayoutLeftColumn();
  updateInfo();
  redraw();
}



function computeHighlightMask() {
  const mask = new Array(nodes.length).fill(false);
  const addNode = (i) => { if (i >= 0 && i < nodes.length) mask[i] = true; };
  const addSet  = (iterable) => { if (!iterable) return; for (const i of iterable) addNode(i|0); };

  // Node hover + neighbors
  if (hoverIndex >= 0) {
    addNode(hoverIndex);
    const nbrs = adj?.[hoverIndex] || [];
    for (const j of nbrs) addNode(j);
  }

  // Node selection + neighbors
  if (selectedIndex >= 0) {
    addNode(selectedIndex);
    const nbrs = adj?.[selectedIndex] || [];
    for (const j of nbrs) addNode(j);
  }

  // Dimension hover/selection
  if (dimHover >= 0 && dimTools?.[dimHover]?.nodes) addSet(dimTools[dimHover].nodes);
  if (selectedDim >= 0 && dimTools?.[selectedDim]?.nodes) addSet(dimTools[selectedDim].nodes);

  // Cluster label hover
 if (clusterHoverId >= 0 && Array.isArray(clusterOf)) {
  for (let i = 0; i < clusterOf.length; i++) if (clusterOf[i] === clusterHoverId) mask[i] = true;
}

// ✅ Cluster label selection (persistent until changed)
if (clusterSelectId >= 0 && Array.isArray(clusterOf)) {
  for (let i = 0; i < clusterOf.length; i++) if (clusterOf[i] === clusterSelectId) mask[i] = true;
}

  // AI summary hover or active (opened) footprint
  const aiSets = [];
  if (aiHoverFootprint?.nodeIds) aiSets.push(aiHoverFootprint.nodeIds);
  if (aiActiveFootprint?.nodeIds) aiSets.push(aiActiveFootprint.nodeIds);
  for (const arr of aiSets) for (const i of arr) addNode(i|0);

  return mask;
}

function currentSelectOutlineColor() {
  // If a dimension is currently selected, use that dim’s color (yellow for clusters)
  if (selectedDim >= 0 && dimTools && dimTools[selectedDim]) {
    const d = dimTools[selectedDim];
    const col = (DIM_COLORS && DIM_COLORS[d.type]) || [255, 230, 100]; // clusters default yellow
    return col;
  }
  // default white
  return [255, 255, 255];
}

function draw() {
  if (layoutRunning) {
    // advance physics
    forceTick();
  }

  background(14);
 if (drawSplashIfNeeded()) return;
  // If a blocking load is happening, show overlay and bail before any push()
  if (isLoading) {
    drawLoadingOverlay();
    return;
  }

  // Safety: if the visibility mask isn't ready/valid, default to all visible
  if (!visibleMask || visibleMask.length !== nodes.length) {
    visibleMask = new Array(nodes.length).fill(true);
  }

  // Hover detection (in world coords)
  const wm = screenToWorld(mouseX, mouseY);
  const hit = findHoverNode(wm.x, wm.y);
  if (hit !== hoverIndex) hoverIndex = hit;

 // NEW: compute on-screen nodes/edges for this frame
recomputeViewportCulling(96); // padding in px 

  // ---------------------- WORLD SPACE ----------------------
  push();
  translate(cam.x, cam.y);
  scale(cam.scale);

  // ---------- EDGES ----------
  const H = computeHighlightMask();
  const anyHi = H.some(Boolean);

  // “selected mode” dim toggle
  const hasSelection =
    (selectedIndex >= 0) ||
    (selectedDim >= 0)   ||
    (aiActiveFootprint != null);

  // Identify focused hub/set
  const hubHover     = (hoverIndex >= 0) ? hoverIndex : -1;
  const hubSelected  = (selectedIndex >= 0) ? selectedIndex : -1;
  const dimHoverSet  = (dimHover   >= 0 && dimTools?.[dimHover]?.nodes)   ? dimTools[dimHover].nodes   : null;
  const dimSelectSet = (selectedDim>= 0 && dimTools?.[selectedDim]?.nodes)? dimTools[selectedDim].nodes: null;

  // helper: test membership for Set or array
  const inDim = (S, i) => S ? (typeof S.has === 'function' ? S.has(i) : S.includes?.(i)) : false;

if (visEdges > 0 && edgesOnscreen.length) {
    strokeWeight(1 / cam.scale);

    let drawEdgesList = edgesOnscreen;            // ← if you've done step 1D, set this to edgesOnscreen instead
  const panOrZooming = isPanning || Math.abs(movedX) + Math.abs(movedY) > 0;

  let cap = Infinity;
  if (zoomLevel < LOD_ZOOM_THRESHOLD) cap = Math.min(cap, EDGE_CAP_LOW_ZOOM);
  if (panOrZooming)                     cap = Math.min(cap, EDGE_CAP_WHILE_PAN);

  if (cap !== Infinity && drawEdgesList.length > cap) {
    const step = Math.ceil(drawEdgesList.length / cap);
    const sampled = [];
    for (let i = 0; i < drawEdgesList.length; i += step) sampled.push(drawEdgesList[i]);
    drawEdgesList = sampled;
  }
  // ────────────────────────────────────────────────────────────────

  for (const e of drawEdgesList) {
      const a = e.source|0, b = e.target|0;
      if (lenses.openAccess && !(nodes[a]?.oa && nodes[b]?.oa)) continue; // skip non-OA edges
      const p1 = parallaxWorldPos(a), p2 = parallaxWorldPos(b);

      // Focus rule (no “neighbors’ neighbors”)
      let focused = false;
      if (hubHover >= 0) {
        focused = (a === hubHover || b === hubHover);
      } else if (hubSelected >= 0) {
        focused = (a === hubSelected || b === hubSelected);
      } else if (dimHoverSet) {
        focused = inDim(dimHoverSet, a) && inDim(dimHoverSet, b);
      } else if (dimSelectSet) {
        focused = inDim(dimSelectSet, a) && inDim(dimSelectSet, b);
      } else if (anyHi) {
        // fall back: only edges whose BOTH ends are in the highlight mask
        focused = H[a] && H[b];
      }

      // Alpha logic (uses your global knobs)
      let edgeAlpha;
      if (hasSelection) {
        edgeAlpha = focused ? (EDGE_HILITE_ALPHA || 255) : SELECT_DIM_EDGE_ALPHA;
      } else if (anyHi) {
        edgeAlpha = focused ? (EDGE_HILITE_ALPHA || 255) : (EDGE_IDLE_DIM_ALPHA || 90);
      } else {
        edgeAlpha = EDGE_IDLE_ALPHA || 110;
      }
      edgeAlpha = Math.round(edgeAlpha * visEdges);
if (edgeAlpha <= 0) continue;


      stroke(120, 120, 140, edgeAlpha);
      line(p1.x, p1.y, p2.x, p2.y);
    }
  }

  // ---------- NODES ----------
  for (let i = 0; i < nodes.length; i++) {
    if (!visibleMask[i] || !inView[i]) continue; 

    const n = nodes[i];
    if (!n) continue;
    const p = parallaxWorldPos(i);

  let r = (n.r || NODE_R) * nodeSizeScale;
const isSquare = !!n.hasFullText;

    // Base colour (cluster tint + OA hint)
let base = BASE_NODE_RGB;

// Show cluster colours whenever the slider is > 0 (or if the old lens is on)
const wantClusters =
  (ovClusterColors > 0 || lenses.domainClusters) &&
  Array.isArray(clusterOf) && clusterOf.length === nodes.length &&
  Array.isArray(clusterColors) && clusterColors.length > 0;

if (wantClusters) {
  const c = clusterOf[i];
  const size = (c != null && c >= 0 && Array.isArray(clusterSizesTotal)) ? (clusterSizesTotal[c] || 0) : 0;
  if (c != null && c >= 0 && size >= COLOR_CLUSTER_MIN_SIZE) {
    const clusterRGB = clusterColors[c % clusterColors.length];
    base = mixRGB(clusterRGB, BASE_NODE_RGB, Math.max(0, Math.min(1, ovClusterColors)));
  }
}


    // Alpha: idle vs highlighted; selection dims non-focused
    let alpha;
    if (H[i]) {
      alpha = NODE_HILITE_ALPHA;
    } else if (selectedIndex >= 0 || selectedDim >= 0 || aiActiveFootprint != null) {
      alpha = SELECT_DIM_NODE_ALPHA;
    } else {
      alpha = NODE_IDLE_ALPHA;
    }

    // Ensure membership flags are up-to-date (cheap unless a change happened)
// Ensure membership flags are up-to-date once per frame if needed
if (dimMembershipDirty) refreshDimMembershipFlags();

// ── Node-visibility override logic ──
// All Publications overrides the others for NODE DISPLAY:
//
// - If visAllPubs > 0: show ALL nodes, scaled only by visAllPubs
// - If visAllPubs = 0: show ONLY nodes that belong to a dim or AI-dim,
//   scaled by that respective slider (max if a node is in both)

const sAll = visAllPubs;
const sDim = nodeInAnyDim[i]   ? visDims   : 0;
const sAI  = nodeInAnyAIDim[i] ? visAIDims : 0;
const scale = Math.max(sAll, sDim, sAI);

// Apply scale; if 0, the node vanishes
alpha = Math.round(alpha * scale);
alpha = Math.max(0, Math.min(255, alpha));


    // OA lens hides non-OA
    if (lenses.openAccess && !n.oa) alpha = 0;

    const nodeIsHiddenByOA = (lenses.openAccess && !n.oa);
if (!nodeIsHiddenByOA &&
    !(selectedIndex >= 0 || selectedDim >= 0 || aiActiveFootprint != null) &&
    lenses.citationShade) {
  const shade = alphaForCBC(n.cbc || 0);
  alpha = Math.max(alpha, Math.max(NODE_IDLE_ALPHA, shade));
}

    // Optional citation shading (never below idle alpha, and only when nothing is selected)
    if (!(selectedIndex >= 0 || selectedDim >= 0 || aiActiveFootprint != null) && lenses.citationShade) {
      const shade = alphaForCBC(n.cbc || 0);
      alpha = Math.max(alpha, Math.max(NODE_IDLE_ALPHA, shade));
    }

    // --- Filled vs Hollow (Contains Abstracts lens) ---
    const hollow = (lenses.onlyAbstracts && !n.hasAbs);

    if (hollow) {
      // Hollow: faint outline only; respect OA lens hiding
      if (!lenses.openAccess || n.oa) {
        noFill();
        stroke(base[0], base[1], base[2], Math.max(40, Math.round(alpha * 0.7)));
        strokeWeight(1.2 / cam.scale);
        if (isSquare) {
          rectMode(CENTER);
// square width/height matches circle diameter (r*2)
rect(p.x, p.y, (r * 2 * getFulltextBoxMult()), (r * 2 * getFulltextBoxMult()), 2 / cam.scale);

        } else {
          circle(p.x, p.y, r * 2);
        }
      }
    } else {
      // Filled (default)
      noStroke();
      fill(base[0], base[1], base[2], alpha);
      if (isSquare) {
        rectMode(CENTER);
// square width/height matches circle diameter (r*2)
rect(p.x, p.y, (r * 2 * FULLTEXT_BOX_SIZE_MULT), (r * 2 * FULLTEXT_BOX_SIZE_MULT), 2 / cam.scale);
      } else {
        circle(p.x, p.y, r * 2);
      }
    }
    // --- Abstracts overlay ring (2px @ 100%) ---
if (ovAbstracts > 0 && alpha > 0 && n.hasAbs) {
  noFill();
  stroke(255, Math.round(255 * ovAbstracts));
  strokeWeight(2 / cam.scale);

  if (isSquare) {
    rectMode(CENTER);
    // small outward pad so it reads even on bright fills
    rect(p.x, p.y, (r * 2 * getFulltextBoxMult()) + (2 / cam.scale),
                 (r * 2 * getFulltextBoxMult()) + (2 / cam.scale), 2 / cam.scale);


  } else {
    circle(p.x, p.y, (r * 2) + (2 / cam.scale));
  }
}


// Selection / hover rings (full opacity; also respect OA lens)
    if ((i === selectedIndex || i === hoverIndex) && (!lenses.openAccess || n.oa)) {
      noFill();
     const [sr, sg, sb] = currentSelectOutlineColor();
stroke(sr, sg, sb, 245);
      strokeWeight((i === selectedIndex ? 3 : 2) / cam.scale);
 if (isSquare) {
   rectMode(CENTER);
const side = (r * 2 * getFulltextBoxMult()) * SELECT_SQUARE_MULT;
   rect(p.x, p.y, side, side, 3 / cam.scale);
      } else {
        circle(p.x, p.y, (r * 2) + (6 / cam.scale));
      }
    }
// --- OA halo (under node) ---
if (ovOpenAccess > 0 && n.oa) {
  const stw   = 4 / cam.scale;                          // 4pt screen-space
  const bump  = (2 / cam.scale) + (stw * 0.5);          // extends beyond 2pt abstracts ring
  const oaA   = Math.round(255 * ovOpenAccess);         // slider → opacity 0..255

  noFill();
  stroke(90, 200, 130, oaA);
  strokeWeight(stw);

  if (isSquare) {
    rectMode(CENTER);
const w = (r * 2 * getFulltextBoxMult()) + bump;
const h = (r * 2 * getFulltextBoxMult()) + bump;
rect(p.x, p.y, w, h, 2 / cam.scale);
  } else {
    const d = (r * 2) + bump;
    circle(p.x, p.y, d);
  }
}





  }

  // Dimension edges in world space (doesn't use push/pop)
  if (typeof drawDimEdges === 'function') drawDimEdges();

  pop();
  // -------------------- END WORLD SPACE --------------------

  // ---------------------- SCREEN SPACE overlays ----------------------


  // Tooltip for dimension handle hover
  if (dimHover >= 0 && dimTools && dimTools[dimHover]) {
    const d = dimTools[dimHover];
    const s = worldToScreen(d.x, d.y);
    drawTooltip(s.x, s.y - 10, `${d.type}: ${d.label}`);
  }

  // Node hover tooltip (only if not over a handle)
  if (hoverIndex >= 0 && dimHover < 0) {
    const n = nodes[hoverIndex];
    if (n && (!lenses.openAccess || n.oa)) {
      const pw = parallaxWorldPos(hoverIndex);
      const ps = worldToScreen(pw.x, pw.y);
      drawTooltip(ps.x, ps.y - 10, n.label);
    }
  }

  // Cluster labels (screen-space)
if (typeof drawClusterLabels === 'function') drawClusterLabels();


// bottom-left "Powered by" image (replaces the text legend)
// bottom-corner "Powered by" image (clickable → semanticspace.ai)
if (poweredByImg && poweredByImg.width > 0) {
  push();
  const PAD = 12;
  const targetW = 140;
  const ratio   = poweredByImg.height / poweredByImg.width;
  const targetH = Math.max(1, Math.round(targetW * ratio));

  // Choose corner: bottom-left (current). If you truly want bottom-right,
  // change px to: const px = width - targetW - PAD;
  const px = PAD;
  const py = height - targetH - PAD;

  // draw
  tint(255, 128);
  image(poweredByImg, px, py, targetW, targetH);
  noTint();

  // record hit-box for click detection
  window.poweredByHit = { x: px, y: py, w: targetW, h: targetH };

  // pointer cursor on hover
  const over =
    mouseX >= px && mouseX <= px + targetW &&
    mouseY >= py && mouseY <= py + targetH;
  document.body.style.cursor = (over ? 'pointer' : '');
  pop();
} else {
  // if image missing, clear any stale hit-box and cursor
  window.poweredByHit = null;
  if (document.body.style.cursor === 'pointer') document.body.style.cursor = '';
}


drawSelectedNodeCitationsUI();
  // Draw dimension handles ABOVE labels (world space)
  push();
  translate(cam.x, cam.y);
  scale(cam.scale);
  if (typeof drawDimHandles === 'function') drawDimHandles();
  pop();

  // Bottom-right HUD
noStroke();
fill(220);
textSize(11);
textAlign(RIGHT, BOTTOM);

// compute zoom level from current camera scale
zoomLevel = Math.log2(cam.scale || 1);

// draw Zoom above the nodes/edges count (infoSpan is fixed at bottom:12px)
const zoomLabel = `Zoom ${(zoomLevel >= 0 ? '+' : '')}${zoomLevel.toFixed(1)}`;
text(zoomLabel, width - 12, height - 60);   // <- sits just above the counts

// keep any transient status message slightly higher (optional)
if (msg) text(msg, width - 12, height - 44);

  drawAIFootprints();
// keep last camera for pan-delta parallax
__prevCam.x = cam.x;
__prevCam.y = cam.y;
__prevCam.scale = cam.scale;


}




// --- UI handlers -------------------------------------------------------------
function openFileDialog() {
  hiddenFileInput.elt.value = ""; // reset so selecting the same file works
  hiddenFileInput.elt.click();
}

async function handleFileSelected(p5file) {
  const native = p5file?.file || p5file;
  const name = (native?.name || '').toLowerCase();
  const type = (native?.type || '').toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) {
    return handleAnyImportSelected(p5file);
  }

  if (!native) {
    msg = "Could not access the file.";
    updateInfo(); redraw(); return;
  }

  showLoading('Reading file…', 0.02);

  const reader = new FileReader();

  reader.onprogress = (e) => {
    if (e.lengthComputable) {
      const frac = e.total ? e.loaded / e.total : 0;
      // Reserve 0–0.60 for reading
      setLoadingProgress(0.60 * frac, `Reading file… ${Math.round(frac * 100)}%`);
    }
  };

  reader.onerror = () => {
    hideLoading();
    msg = "Failed to read file.";
    updateInfo(); redraw();
  };

  reader.onload = async () => {
    const text = String(reader.result || "");
    setLoadingProgress(0.65, 'Parsing JSON…');
    await nextTick(); // let UI paint

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error(e);
      hideLoading();
      msg = "Invalid JSON.";
      updateInfo(); redraw();
      return;
    }

    // Build graph with chunked progress updates
    try {
      await buildGraphFromPayloadAsync(data);
    } finally {
      hideLoading();
    }
  };

  reader.readAsText(native, "utf-8");
}




function keyPressed() {
  //if (key === 'l' || key === 'L') toggleLayout();
}

// --- Graph build -------------------------------------------------------------

function buildEdgesFromItems(items) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const arr = Array.isArray(items[i]?.cites_internal) ? items[i].cites_internal : [];
    for (const j of arr) {
      const t = toInt(j);
      if (!Number.isInteger(t) || t < 0 || t >= items.length) continue;
      const key = i + ">" + t;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source: i, target: t });
    }
  }

  return out;
}

// --- tiny helpers ------------------------------------------------------------
function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function updateInfo() {
  if (!infoSpan) return;
  const totalN = nodes.length | 0;
  const totalE = edges.length | 0;
  const visN = visibleMask.length ? visibleMask.reduce((a,b)=>a+(b?1:0),0) : totalN;
  const visE = edgesFiltered.length ? edgesFiltered.length : totalE;
  if (infoSpan) infoSpan.hide();
}





// ---------- Build adjacency list from edge list ----------
function buildAdjacency(n, es) {
  adj = Array.from({ length: n }, () => []);
  for (const e of es) {
    const s = e.source|0, t = e.target|0;
    if (s>=0 && t>=0 && s<n && t<n && s!==t) {
      adj[s].push(t);
      adj[t].push(s);
    }
  }
}

// ---------- Initialize velocities & (re)start if desired ----------
function initForceLayout() {
  vx = new Array(nodes.length).fill(0);
  vy = new Array(nodes.length).fill(0);
}

function ensureVelArrays() {
  if (!Array.isArray(vx)) vx = [];
  if (!Array.isArray(vy)) vy = [];
  while (vx.length < nodes.length) vx.push(0);
  while (vy.length < nodes.length) vy.push(0);
}


// ---------- Start/stop ----------
function toggleLayout() {
  layoutRunning = !layoutRunning;
  updateLayoutIconState();          // reflect state in the icon
  if (layoutRunning) loop(); else noLoop();
}


// ---------- One simulation tick ----------
function forceTick() {
  if (!nodes.length) return;
    ensureVelArrays();

  const cellSize = physics.cellSize;
  const grid = new Map(); // key "cx,cy" -> array of node indices

  // Build spatial grid from current positions (skip bad nodes)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    const cx = Math.floor(n.x / cellSize), cy = Math.floor(n.y / cellSize);
    const key = cx + "," + cy;
    let bin = grid.get(key);
    if (!bin) grid.set(key, bin = []);
    bin.push(i);
  }

  const R2 = physics.repelRadius * physics.repelRadius;
  const cxMid = world.w * 0.5, cyMid = world.h * 0.5;

  // Accumulate forces & update velocities
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) { vx[i] = 0; vy[i] = 0; continue; }

    let fx = 0, fy = 0;

    // --- Repulsion from nearby nodes (grid neighborhood) ---
    const ccx = Math.floor(a.x / cellSize), ccy = Math.floor(a.y / cellSize);
    for (let gx = ccx - 1; gx <= ccx + 1; gx++) {
      for (let gy = ccy - 1; gy <= ccy + 1; gy++) {
        const bin = grid.get(gx + "," + gy);
        if (!bin) continue;
        for (const j of bin) {
          if (j === i) continue;
          const b = nodes[j];
          if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx*dx + dy*dy;
          if (d2 > 0 && d2 < R2) {
            const inv = 1.0 / Math.max(36, d2);
            const F = physics.repulsion * inv;
            const d = Math.sqrt(d2) || 1;
            fx += (dx / d) * F;
            fy += (dy / d) * F;
          }
        }
      }
    }

    // --- Springs along edges (Hooke's law) ---
    const nbrs = adj[i] || [];
    for (const j of nbrs) {
      const b = nodes[j];
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const stretch = dist - physics.restLength;
      const F = physics.springK * stretch;
      fx += (dx / dist) * F;
      fy += (dy / dist) * F;
    }

    // --- Centering force (weak gravity) ---
    fx += (cxMid - a.x) * physics.centerPull;
    fy += (cyMid - a.y) * physics.centerPull;

    // Integrate velocity
    vx[i] = (vx[i] + fx * physics.timeStep) * physics.damping;
    vy[i] = (vy[i] + fy * physics.timeStep) * physics.damping;

    // Clamp speed
    const sp2 = vx[i]*vx[i] + vy[i]*vy[i];
    const maxV = physics.maxSpeed;
    if (sp2 > maxV*maxV) {
      const s = maxV / Math.sqrt(sp2);
      vx[i] *= s; vy[i] *= s;
    }
  }

  // Integrate position (once) and clamp to WORLD bounds (skip bad nodes)
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    a.x = constrain(a.x + vx[i] * physics.timeStep, 8, world.w - 8);
    a.y = constrain(a.y + vy[i] * physics.timeStep, 8, world.h - 8);
  }
}





function worldToScreen(wx, wy) {
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}
function screenToWorld(sx, sy) {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function findHoverNode(wx, wy) {
  if (!nodes.length) return -1;

  // Convert the world point (mouse) back to screen so we can compare in screen space
  const m = worldToScreen(wx, wy);

  // Keep a small screen-space padding so tiny nodes are still clickable.
  const padPx = 3;

  let best = -1, bestD2 = Infinity;

  for (let i = 0; i < nodes.length; i++) {
    const ni = nodes[i];
    if (!ni) continue;
    if (visibleMask.length && !visibleMask[i]) continue;
    if (lenses.openAccess && !ni.oa) continue;

    // where the node is *drawn* this frame
    const ps = nodeScreenPos(i);
    const dx = ps.x - m.x, dy = ps.y - m.y;

    // radii in *screen* px
    const rWorld = (ni.r || NODE_R) * nodeSizeScale;
    const isSquare = !!ni.hasFullText;

    if (isSquare) {
      const half = (rWorld * FULLTEXT_BOX_SIZE_MULT) * cam.scale + padPx;
      if (Math.abs(dx) <= half && Math.abs(dy) <= half) {
        const d2 = dx*dx + dy*dy;
        if (d2 < bestD2) { best = i; bestD2 = d2; }
      }
    } else {
      const R = (rWorld * cam.scale) + padPx;
      const d2 = dx*dx + dy*dy;
      if (d2 <= R*R && d2 < bestD2) { best = i; bestD2 = d2; }
    }
  }
  return best;
}





function drawTooltip(sx, sy, textStr) {
  const pad = 6;
  textSize(13);
  const lines = wrapLines(textStr, 46);         // quick soft wrap
  const w = 7.2 * Math.max(...lines.map(l => l.length)) + pad*2;
  const h = lines.length * 16 + pad*2;

  push();
  rectMode(CORNER);
  noStroke();
  fill(0, 180);
  const x = clamp(sx + 10, 8, width - w - 8);
  const y = clamp(sy - h, 8, height - h - 8);
  rect(x, y, w, h, 6);

  fill(255);
  textAlign(LEFT, TOP);
  let ty = y + pad;
  for (const line of lines) {
    text(line, x + pad, ty);
    ty += 16;
  }
  pop();
}

// tiny word-wrap for tooltips
function wrapLines(s, maxChars) {
  const words = String(s || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur ? cur + " " : "") + w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [String(s || "")];
}

// --- Pan with left mouse drag ---
function mousePressed() {
    if (uiCapture || pointerOverUI()) return; 

  const k = hitHandleAtScreen(mouseX, mouseY);
  if (k >= 0) {
    dimHover = k;
    dimDrag.active = true; dimDrag.idx = k;
    dimDrag.sx = mouseX;   // <-- add
    dimDrag.sy = mouseY;   // <-- add

    const d = dimTools[k];
    const w = screenToWorld(mouseX, mouseY);
    dimDrag.dx = d.x - w.x;
    dimDrag.dy = d.y - w.y;
    isPanning = false;
    loop();
    return;
  }
  if (mouseY < 40) return;  // adjust if your UI height changes
  isPanning = true;
  panStart = { x: mouseX, y: mouseY, camX: cam.x, camY: cam.y };
  loop(); // ensure draw runs during pan
}



function mouseDragged() {
  if (uiCapture || pointerOverUI()) return; 

  if (dimDrag.active) {
    const w = screenToWorld(mouseX, mouseY);
    const d = dimTools[dimDrag.idx];
    d.x = w.x + dimDrag.dx;
    d.y = w.y + dimDrag.dy;
    d.userMoved = true; 
    redraw();
    return false;
  }
  
    if (!isPanning) return;
  const dx = mouseX - panStart.x;
  const dy = mouseY - panStart.y;
  cam.x = panStart.camX + dx;
  cam.y = panStart.camY + dy;
}


function mouseReleased() {
if (uiCapture) { uiCapture = false; return; }
// Always end any pan first (even if release happens over UI)
  const start = panStart;      // keep for click-vs-drag test
  isPanning = false;
const moved = start ? dist(mouseX, mouseY, start.x, start.y) : 999;
  const clickLike = moved < 5;
  // If a UI element captured the interaction, just release it and stop.
  if (uiCapture) { uiCapture = false; return; }
  if (pointerOverUI()) return;
  // Treat as a click if the pointer barely moved


  // Click on the Powered By image → open semanticspace.ai
  if (clickLike && window.poweredByHit) {
    const hb = window.poweredByHit;
    if (mouseX >= hb.x && mouseX <= hb.x + hb.w &&
        mouseY >= hb.y && mouseY <= hb.y + hb.h) {
      window.open('https://semanticspace.ai', '_blank', 'noopener');
      return; // consume the click
    }
  }



  // Click on cluster label radios (when clusters lens is on)
if (lenses.domainClusters && ovClusterLabels > 0 && Array.isArray(clusterLabelHits) && clusterLabelHits.length) {
  // We consider it a click if the mouse didn’t move much
  const moved = start ? dist(mouseX, mouseY, start.x, start.y) : 999;
  const clickLike = moved < 5;

  if (clickLike) {
    // Prefer the small box if both overlap
    const inRect = (h) =>
      Math.abs(mouseX - h.cx) <= (h.hw || 0) &&
      Math.abs(mouseY - h.cy) <= (h.hh || 0);

    // 1) box → create/toggle Dimension
    const hitBox = clusterLabelHits.find(h => h.type === 'box' && inRect(h));
    if (hitBox) {
      const cid = hitBox.clusterId;
      const label = (clusterLabels[cid] && clusterLabels[cid].trim()) ? clusterLabels[cid] : `Cluster ${cid+1}`;
      ensureClusterDimension(cid, label, true);
      return;
    }

    // 2) label → select all nodes in cluster (no Dimension)
    const hitLabel = clusterLabelHits.find(h => h.type === 'label' && inRect(h));
    if (hitLabel) {
      const cid = hitLabel.clusterId;
      clusterSelectId = (clusterSelectId === cid) ? -1 : cid; // toggle
      // clear any node or dimension selection
      if (selectedIndex !== -1) deselectNode();
      if (selectedDim   !== -1) deselectDimension();
      redraw();
      return;
    }
  }
}


 if (uiCapture) {                 // <-- add
    uiCapture = false;             // release any stray capture
    return;
  }



  if (dimDrag.active) {
    const moved = dist(mouseX, mouseY, dimDrag.sx, dimDrag.sy);
    const clicked = moved < 5;  // threshold for click vs. drag
  if (clicked && citeUi.visible && citeUi.hover >= 0) {
    onCiteButtonClicked(citeUi.buttons[citeUi.hover]);
    if (!layoutRunning) noLoop();
    redraw();
    return;
  }

    const k = dimDrag.idx;

    dimDrag.active = false;

    if (clicked && k >= 0) {
      // clear any selected node and focus this handle
      if (selectedIndex !== -1) deselectNode();
      if (selectedDim !== -1)   deselectDimension();
      selectDimension(k);   // <-- opens the Dimension power panel
    }

    if (!layoutRunning) noLoop();
    redraw();
    return;
  }

  // Always allow selecting a handle on release (even if panStart was never set)
const k = hitHandleAtScreen(mouseX, mouseY);
if (k >= 0) {
  // clear any selected node
  if (selectedIndex !== -1) deselectNode();

  // always select/focus this handle
  selectDimension(k);

  if (!layoutRunning) noLoop();
  redraw();
  return;
}


  //const moved = start ? dist(mouseX, mouseY, start.x, start.y) : 999;
  //const clickLike = moved < 5;
  isPanning = false;


  // Ignore clicks on the (visible) info panel so links remain clickable
  // ---- Citations button click? (intercept before node selection toggles) ----
if (clickLike) {
  const hit = hitCiteButtonAtScreen(mouseX, mouseY); // uses current mouseX, mouseY
  if (hit >= 0 && citeUi?.buttons?.[hit]) {
    onCiteButtonClicked(citeUi.buttons[hit]); // will handle L1/L2 for left/right
    if (!layoutRunning) noLoop();
    redraw();
    return; // IMPORTANT: stop the deselect/select logic
  }
}

  
  
  if (clickLike && !(infoPanel && infoPanel.visible && infoPanel.containsScreenPoint(mouseX, mouseY))) {
    const wm = screenToWorld(mouseX, mouseY);
    const idx = findHoverNode(wm.x, wm.y);
    if (idx >= 0) {
      if (idx === selectedIndex) deselectNode(); // toggle off
      else selectNode(idx);
    } else {
      // clicked empty space => deselect
      if (selectedIndex !== -1) deselectNode();
      if (selectedDim !== -1)   deselectDimension();
    }
  }
// Click on AI footprint marker? 
const fHit = hitAIFootprintMarker(mouseX, mouseY);
 if (fHit) { openAIDocFootprint(fHit); return; }
 // empty click: clear any active AI selection so we exit "selected dim" mode
 aiActiveFootprint = null;

  if (!layoutRunning) noLoop();
  redraw();
}


// --- Zoom with trackpad/wheel (pinch or scroll) ---
function mouseWheel(evt) {
  // Allow wheel on form controls
  const t = evt.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
    return;
  }
 if (pointerOverUI()) return; 
  // Allow wheel inside info panel and Dimensions areas
  let el = evt.target;
  while (el) {
    if (infoPanel && el === infoPanel.div.elt) return;            // panel scroll
    if (el.classList && (el.classList.contains('dim-scroll') ||   // list body
                         el.classList.contains('dim-sidebar-scroll'))) { // sidebar
      return;
    }
    el = el.parentElement;
  }

  // Otherwise: zoom towards the cursor (your existing code)
  const delta = -evt.deltaY;
  const zoom = Math.exp(delta * 0.0012);
const newScale = clamp(cam.scale * zoom, 0.1, 64);

  const wx = (mouseX - cam.x) / cam.scale;
  const wy = (mouseY - cam.y) / cam.scale;

  cam.scale = newScale;
  cam.x = mouseX - wx * cam.scale;
  cam.y = mouseY - wy * cam.scale;

  redraw();
  return false;               // prevent page scroll when zooming canvas
}


// Update hover without animating constantly
function mouseMoved() {
  let need = false;

  const hitHandle = hitHandleAtScreen(mouseX, mouseY);
  if (hitHandle !== dimHover) { dimHover = hitHandle; need = true; }
    // Hover over the new cite buttons (screen-space)
  const citeHit = hitCiteButtonAtScreen(mouseX, mouseY);
  if (citeHit !== citeUi.hover) { citeUi.hover = citeHit; need = true; }


  // Only compute node hover when NOT over a handle
  let newHover = -1;
  if (dimHover < 0) {
    const wm = screenToWorld(mouseX, mouseY);
    newHover = findHoverNode(wm.x, wm.y);
  }
  if (newHover !== hoverIndex) { hoverIndex = newHover; need = true; }

  // --- NEW: AI icon hover
  const newAIHover = hoverAIFootprintMarker(mouseX, mouseY);
  if (newAIHover !== aiHoverFootprint) { aiHoverFootprint = newAIHover; need = true; }

  // --- NEW: Cluster label hover (uses clusterLabelHits you fill in drawClusterLabels)
let newClusterHover = -1;

if (Array.isArray(clusterLabelHits) && clusterLabelHits.length) {
  for (const h of clusterLabelHits) {
    const within = Math.abs(mouseX - h.cx) <= (h.hw || 0) &&
                   Math.abs(mouseY - h.cy) <= (h.hh || 0);
    if (within) { newClusterHover = h.clusterId; break; }
  }
}
if (newClusterHover !== clusterHoverId) { clusterHoverId = newClusterHover; need = true; }

  if (need) redraw();
}

function alphaForCBC(c) {
  // Robust log scaling with percentile clipping -> [minAlpha..maxAlpha]
  const minAlpha = 60, maxAlpha = 255; // tweak if you want stronger/weaker overall
  const L = Math.log1p(Math.max(0, Number(c||0)));
  const Lmin = cbcLogMin, Lmax = cbcLogMax;
  if (!(Lmax > Lmin)) return (c > 0) ? maxAlpha : minAlpha;
  const t = Math.max(0, Math.min(1, (L - Lmin) / (Lmax - Lmin)));
  return Math.round(minAlpha + (maxAlpha - minAlpha) * t);
}

/* ===================== COMMUNITY DETECTION (Label Propagation) ===================== */
// Fast, parameter-free community detection.
// Uses `adj` (your existing adjacency list). Writes to `clusterOf` & returns cluster count.


// Uses `adj` (your existing adjacency list). Writes to clusterOf/clusterCount etc.
function computeDomainClusters(maxIters = 50) {
  // Snapshot *before* we mutate so we can carry labels/colours forward
  const prevCluster = Array.isArray(clusterOf)     ? clusterOf.slice()     : null;
  const prevLabels  = Array.isArray(clusterLabels) ? clusterLabels.slice() : null;
  const prevColors  = Array.isArray(clusterColors) ? clusterColors.slice() : null;

  const n = nodes.length | 0;
  clusterOf = new Array(n).fill(-1);
  if (!n) {
    clusterCount   = 0;
    clusterLabels  = [];
    clusterColors  = [];
    clusterSizesTotal = [];
    return 0;
  }

  // --- Label propagation (majority of neighbours)
  const label = new Array(n);
  for (let i = 0; i < n; i++) label[i] = i;

  let order = [...Array(n).keys()];
  let changed = true;
  for (let iter = 0; iter < maxIters && changed; iter++) {
    // Fisher–Yates shuffle
    for (let k = n - 1; k > 0; k--) { const r = (Math.random() * (k + 1)) | 0; [order[k], order[r]] = [order[r], order[k]]; }

    changed = false;
    for (const i of order) {
      const nbrs = adj[i] || [];
      if (!nbrs.length) continue;
      const counts = new Map();
      for (const j of nbrs) { const lj = label[j]; counts.set(lj, (counts.get(lj) || 0) + 1); }
      let bestLab = label[i], bestCnt = -1;
      for (const [lab, cnt] of counts.entries()) {
        if (cnt > bestCnt || (cnt === bestCnt && lab < bestLab)) { bestLab = lab; bestCnt = cnt; }
      }
      if (bestLab !== label[i]) { label[i] = bestLab; changed = true; }
    }
  }

  // Compress labels to 0..k-1 cluster ids
  const uniq = Array.from(new Set(label)).sort((a,b)=>a-b);
  const map  = new Map(uniq.map((lab, idx) => [lab, idx]));
  for (let i = 0; i < n; i++) clusterOf[i] = map.get(label[i]);
  clusterCount = uniq.length;

  // Sizes (for UI thresholds/sliders)
  clusterSizesTotal = new Array(clusterCount).fill(0);
  for (let i = 0; i < n; i++) {
    const c = clusterOf[i];
    if (c != null && c >= 0) clusterSizesTotal[c]++;
  }

  // --- Preserve labels & colours across reclusterings by overlap
  if (prevCluster && prevLabels) {
    const carried = remapClusterLabels(prevCluster, clusterOf, prevLabels, 0.25);
    clusterLabels = carried;
  } else {
    clusterLabels = new Array(clusterCount).fill('');
  }

  const colCarry = remapClusterColors(prevCluster, clusterOf, prevColors, 0.25);
  clusterColors = colCarry || makeClusterColors(clusterCount);

  // Only fill *blank* labels from abstracts (TF-IDF). AI/manual names persist.
  computeClusterLabels();

  // Any UI that depends on sizes/labels
  initClusterFilterUI?.();
  return clusterCount;
}



function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
}

// Generate visually-distinct colors in HSB, return as [r,g,b] arrays
// --- Softer cluster palette ---
function makeClusterColors(n = 1) {
  colorMode(HSB, 360, 100, 100, 255);
  const cols = [];
  for (let i = 0; i < n; i++) {
    const h = (i * 360 / Math.max(1, n)) % 360;
    const c = color(h, CLUSTER_SAT, CLUSTER_BRIGHT, 255);
    cols.push([ red(c), green(c), blue(c) ]);
  }
  colorMode(RGB, 255);
  return cols;
}




// --- small fallbacks (remove if you already have them) ---
function esc(s){ return String(s||''); }
function safe(s){ return esc(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

function getAuthors(w){
  if (Array.isArray(w?.authorships)) {
    const names = [];
    for (const a of w.authorships) {
      const p = a?.author;
      const n = p?.display_name || a?.author?.display_name || a?.institutions?.[0]?.display_name;
      if (n) names.push(n);
    }
    return names;
  }
  // NEW: support compact OpenAlex
  if (Array.isArray(w?.authorship_names)) {
    return w.authorship_names.filter(Boolean);
  }
 
  // NEW: ultra-compact fallback (our compactOA authors list)
  if (Array.isArray(w?.authors)) {
    return w.authors.filter(Boolean);
  }
 return [];


}


//================== InfoPanel (drop-in) ===================
class InfoPanel {
  constructor(x = null, y = null, w = 300, h = 600) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.index = -1;
    this.visible = false;

    this.div = createDiv('');
    this.div.addClass('info-panel');
    this.div.style('position','fixed');

    // default position (can be overridden via setRect / updatePosition)
    const right = 10;      // start 10px from right
    const top   = 200;
    this.div.style('right', `${right}px`);
    this.div.style('top',   `${top}px`);

    this.div.style('width', `${w}px`);
    this.div.style('max-height', `${h}px`);
    this.div.style('overflow-y','auto');
    this.div.style('overflow-x','hidden');     // ← NEW: no horizontal scroll
    this.div.style('word-break','break-word'); // ← NEW: wrap long words/URLs
    this.div.style('white-space','normal');    // ← NEW: allow wrapping

    this.div.style('padding','10px 12px');
    this.div.style('background','rgba(0,0,0,0.6)');
    this.div.style('color','#fff');
    this.div.style('backdrop-filter','blur(3px)');
    this.div.style('border','1px solid rgba(255,255,255,0.25)');
    this.div.style('border-radius','10px');
    this.div.style('z-index','10040');
    this.div.hide();

    if (typeof captureUI === 'function') captureUI(this.div.elt);
  }
dockRight(rightPx = 12, topPx = 200, widthPx = 300, heightPx = 600) {
  this.w = widthPx; this.h = heightPx;
  this.div.style('left','');                      // clear left anchor
  this.div.style('right', `${rightPx}px`);        // anchor to right
  this.div.style('top',   `${topPx}px`);
  this.div.style('width', `${widthPx}px`);
  this.div.style('max-height', `${heightPx}px`);
}

destroy() {
  if (this.div) this.div.remove();
  this.visible = false;
  this.index = -1;
}

setCanvasOverview() {
  if (!this.div) return;

  const stats = computeCanvasStats();
  const meta  = (typeof projectMeta !== 'undefined' && projectMeta) ? projectMeta : {};
  const when  = meta.created ? new Date(meta.created).toLocaleString() : '';

  const hasMeta = !!(meta.title || meta.text || meta.created);
  const title   = String(meta.title || '').trim() || 'Untitled export';
  const text    = String(meta.text  || '').trim();

  // Overview header (published-only bits shown when available)
  const metaBlock = hasMeta ? `
    <div style="font-weight:700; font-size:13px; margin-bottom:4px;">${escapeHtml(title)}</div>
    <div style="opacity:.75; font-size:11px; margin-bottom:8px;">Created ${when || ''}</div>
    <div style="white-space:pre-wrap; font-size:12px; line-height:1.45; margin-bottom:10px;">
      ${text ? escapeHtml(text) : '<span style="opacity:.7">No description.</span>'}
    </div>
  ` : '';

  const stat = (label, value) =>
    `<div style="opacity:.7">${label}</div><div>${value}</div>`;

  const statsGrid = `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px;margin-bottom:10px">
      ${stat('Total nodes',    stats.totalNodes)}
      ${stat('Nodes visible',  stats.visibleNodes)}
      ${stat('Total edges',    stats.totalEdges)}
      ${stat('Edges visible',  stats.visibleEdges)}
      ${stat('With abstracts', stats.withAbs)}
      ${stat('Full texts',     stats.withFT)}
      ${stat('Clusters',       stats.clusters)}
    </div>
  `;

  const chart = svgYearBars(stats.years, 226, 70, 6);

  this.div.html(`
    ${metaBlock}
    <div style="font-weight:600;font-size:13px;margin:0 0 6px;">Network Overview</div>
    ${statsGrid}
    <div style="font-weight:600;font-size:13px;margin:8px 0 4px;">Publications by year</div>
    ${chart}
  `);
}



  _renderDimensionPanel(k) {
  const d = dimTools?.[k];
  if (!d) { this.hide(); return; }

  const title = d.label || d.key || '(unnamed dimension)';
  const matchCount = (d.nodes && typeof d.nodes.size === 'number') ? d.nodes.size
                    : (Array.isArray(d.nodes) ? d.nodes.length : 0);
  const power = Math.round(d.power || 0);

  // ids for wiring
  const powId = `dimPow_${k}_${Date.now()}`;
  const delId = `dimDel_${k}_${Date.now()}`;

  const safe = s => String(s ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));


  const delLabel = (String(d.type).toLowerCase() === 'ai') ? 'Delete Lens' : 'Delete Dimension';
  this.div.html(`
    <div style="font-weight:600;font-size:16px;margin-bottom:6px">${safe(title)}</div>

    <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px;margin-bottom:12px">
      <div style="opacity:.7">Type</div><div>${safe(d.type || 'dimension')}</div>
      <div style="opacity:.7">Matches</div><div>${matchCount}</div>
    </div>

    <div style="font-weight:600;font-size:13px;margin:6px 0 4px;">Power</div>
    <input id="${powId}" type="range" min="0" max="100" step="1" value="${power}"
           style="width:100%; accent-color:#8ecbff">

    <div style="margin-top:10px">
      <button id="${delId}" style="background:rgba(255,255,255,0.08);
        border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 10px;
        border-radius:6px;cursor:pointer;font-size:12px"
        aria-label="${delLabel}" title="${delLabel}">
       ${delLabel}
     </button>
         </div>
  `);

  const powEl = document.getElementById(powId);
  if (powEl) {
    captureUI?.(powEl);
    powEl.addEventListener('input', (e) => {
      const v = Number(e.target.value || 0);
      d.power = v;
       d.userMoved = true; 
      // If your layout uses power to reposition, you may want to kick it here:
      // layoutRunning = true; loop();
      if (lenses?.hideNonDim) recomputeVisibility?.();
      redraw();
    });
  }

  const delEl = document.getElementById(delId);
  if (delEl) {
    captureUI?.(delEl);
    delEl.addEventListener('click', () => {
      deleteDimension?.(k);
    });
  }
// --- extra content for AI dimensions ---
if (d.type === 'ai') {
  const bodyId = `aiBody_${Date.now()}`;
  const dlId   = `aiDL_${Date.now()}`;
  const fullId = `aiOpen_${Date.now()}`;
  const when   = d.aiCreatedAt ? new Date(d.aiCreatedAt).toLocaleString() : '';
  const html = `
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12)">
      <div style="font-weight:600;font-size:13px;margin:0 0 4px;">Summary${when ? ` <span style="opacity:.6;font-weight:400">• ${when}</span>` : ''}</div>
      <div id="${bodyId}" style="white-space:pre-wrap;font-size:12px;line-height:1.5;
           max-height:200px;overflow:auto;border:1px solid rgba(255,255,255,0.12);
           background:rgba(255,255,255,0.03);padding:8px;border-radius:6px;"></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button id="${dlId}"   style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px">Download .md</button>
        <button id="${fullId}" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px">Open full view</button>
      </div>
    </div>
  `;
  // append to the existing panel DOM
  this.div.elt.insertAdjacentHTML('beforeend', html);

 const bodyEl = document.getElementById(bodyId);
if (bodyEl) {
  ensureReviewStyles(); // once-only CSS for clean headings/typography
  bodyEl.innerHTML = `<div class="review-container">${formatMarkdownToHTML(String(d.aiContent||''))}</div>`;
}

  if (bodyEl && (!d.aiContent || !d.aiContent.trim()) && REMOTE_AI_BASE && d.summaryRef) {
  (async () => {
    try {
      const r = await fetch(`${REMOTE_AI_BASE}${d.summaryRef}`);
      if (r.ok) {
        const j = await r.json();
        d.aiContent = String(j.body || '');
        ensureReviewStyles();
bodyEl.innerHTML = `<div class="review-container">${formatMarkdownToHTML(d.aiContent)}</div>`;
      }
    } catch {}
  })();
}

  const dlEl = document.getElementById(dlId);
  if (dlEl) {
    captureUI?.(dlEl);
    dlEl.addEventListener('click', () => {
      const blob = new Blob([d.aiContent || ''], { type: 'text/markdown' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const fname = `${(d.aiTitle || 'ai')}.md`;
      a.href = url; a.download = fname; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2500);
    });
  }

  const fullEl = document.getElementById(fullId);
  if (fullEl) {
    captureUI?.(fullEl);
    fullEl.addEventListener('click', async () => {
  const heading = `${d.aiTitle || 'AI summary'}${when ? ' • ' + when : ''}`;
  openSynthPanel?.(heading);

  if ((!d.aiContent || !d.aiContent.trim()) && REMOTE_AI_BASE && d.summaryRef) {
    try {
      const r = await fetch(`${REMOTE_AI_BASE}${d.summaryRef}`);
      if (r.ok) {
        const j = await r.json();
        d.aiContent = String(j.body || '');
        ensureReviewStyles();
bodyEl.innerHTML = `<div class="review-container">${formatMarkdownToHTML(d.aiContent)}</div>`;
      }
    } catch { /* ignore */ }
  }
  setSynthBodyText?.(d.aiContent || '', `${(d.aiTitle || 'ai')}.md`);
});
  }
}

}

setDimensionIndex(k) {
  this.index = -1;          // clear any node selection in the panel
  this.dimIndex = k;        // remember active dimension (optional field)
  this.show();
  this._renderDimensionPanel(k);
}


  // --- visibility helpers expected by your code ---
  show() { this.setVisible(true); }
  hide() { this.setVisible(false); }

  setVisible(on) {
    this.visible = !!on;
    if (on) this.div.show(); else this.div.hide();
  }

  // keep for backwards compatibility (you had this earlier)
  updatePosition({rightPx = 10, topPx = 200, widthPx = 300, heightPx = 600} = {}) {
    this.div.style('right', `${rightPx}px`);
    this.div.style('top',   `${topPx}px`);
    this.div.style('width', `${widthPx}px`);
    this.div.style('max-height', `${heightPx}px`);
  }

  // used by your windowResized() call
  if (infoPanel) {
  infoPanel.dockRight(
    INFO_PANEL_RIGHT_OFFSET,
    PANEL_MARGIN + INFO_PANEL_TOP_SHIFT,
    PANEL_WIDTH,
    computePanelHeight()
  );
}


  // hit test in screen space (used in mouseReleased)
  containsScreenPoint(sx, sy) {
    const r = this.div.elt.getBoundingClientRect();
    return sx >= r.left && sx <= r.right && sy >= r.top && sy <= r.bottom;
  }

  setItemIndex(i) {
  this.index = i;
  if (i == null || i < 0) { this.hide(); return; }

  // NEW: if we loaded a Viewer manifest, the item may be a stub.
  const stub = !(itemsData?.[i]?.openalex && (itemsData[i].openalex.display_name || itemsData[i].openalex.title));
  if (stub && REMOTE_DETAILS_BASE && nodes?.[i]?.idStr) {
    this.show();
    this.div.html('<div style="opacity:.9">Loading details…</div>');
    this._renderRemoteNode(i);   // async helper below
    return;
  }
    this.show();

    // --- helpers (local fallbacks)
    const esc  = s => String(s||'');
    const safe = s => esc(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    const _hasFTCand = (typeof hasFulltextCandidate === 'function')
      ? hasFulltextCandidate
      : function(w, doiUrl='') {
          const best = w?.best_oa_location || {};
          const prim = w?.primary_location || {};
          const cand = [
            prim.landing_page_url, best.landing_page_url,
            prim.pdf_url,          best.url_for_pdf, best.pdf_url,
            w?.host_venue?.url,    w?.id,            doiUrl
          ].filter(u => typeof u === 'string' && u.startsWith('http'));
          return cand.length > 0;
        };

    const item = itemsData[i] || {};
    const w = item.openalex || {};
    const title = w.display_name || w.title || item.title || 'Untitled';
    const authorsArr = getAuthors(w);
    const authors = authorsArr.join(', ');
    const year = w.publication_year || '';
    const venue = inferVenueNameFromWork(w, item.venue || '');

    const citedBy = Number(w.cited_by_count || 0);
    const citing = Array.isArray(adj?.[i]) ? adj[i].length : 0;
// Total references in the publication (OpenAlex fields + fallbacks)
const refsTotal = Array.isArray(w.referenced_works)
  ? w.referenced_works.length
  : Number(
      (w.referenced_works_count ??             // OpenAlex sometimes provides this
       w.biblio?.reference_count ??            // rare alternate
       w.biblio?.references_count ??           // another possible variant
       (itemsData[i]?.refsCount) ??            // your own cached count if present
       0)
    );



    const doi = (w.doi || '').toString();
    const clean = typeof cleanDOI === 'function' ? cleanDOI(doi) : doi.replace(/^https?:\/\/doi\.org\//,'');
    const doiUrl = clean ? `https://doi.org/${clean}` : '';
    const bestUrl = typeof pickBestUrl === 'function' ? pickBestUrl(w, doiUrl) : (doiUrl || w?.id || '');

    const oaObj = w.open_access || {};
    const isOA = !!oaObj.is_oa;
    const oaStatus = isOA ? (oaObj.oa_status ? ` (${oaObj.oa_status})` : '') : '';

    const abstractText = (item.openalex_abstract || (typeof getAbstract==='function' ? getAbstract(w) : '') || '').toString();
    const hasAbstract = abstractText.trim().length > 0;
    const abstractFull = abstractText;
    const abstractShort = abstractFull.length > 1000 ? abstractFull.slice(0,1000) + '…' : abstractFull;

    const hasFullText = typeof item.fulltext === 'string' && item.fulltext.trim().length > 0;
    const canExtract  = _hasFTCand(w, doiUrl);

    // IDs
    const absId       = `abs_${i}_${Date.now()}`;
    const absToggleId = `absT_${i}_${Date.now()}`;
    const ftId        = `ft_${i}_${Date.now()}`;
    const ftBtnId     = `ftBtn_${i}_${Date.now()}`;
    const ftLocalId   = `ftLocal_${i}_${Date.now()}`;

    // --- HTML
    this.div.html(`
      <div style="font-weight:600;font-size:16px;margin-bottom:6px">${safe(title)}</div>

      <div style="opacity:.85;margin-bottom:10px">${authors ? safe(authors) : 
        '<span style="opacity:.6">Unknown authors</span>'}</div>

      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px;margin-bottom:12px">
        <div style="opacity:.7">Year</div><div>${year || '-'}</div>
        <div style="opacity:.7">Venue</div><div>${safe(venue || '-')}</div>
        <div style="opacity:.7">Cited by</div><div>${citedBy}</div>
<div style="opacity:.7">Network Citations</div><div>${citing}</div>
<div style="opacity:.7">References</div><div>${refsTotal}</div>
        <div style="opacity:.7">Open access</div>
        <div>${
          isOA ? ('Yes' + oaStatus)
               : (canExtract ? 'Unknown (link found)' : 'No / unknown')
        }</div>
        <div style="opacity:.7">DOI</div><div>${clean ? `<a href="${doiUrl}" target="_blank" style="color:#8ecbff;text-decoration:none">${clean}</a>` : '-'}</div>
        <div style="opacity:.7">URL</div><div>${bestUrl ? `<a href="${bestUrl}" target="_blank" style="color:#8ecbff;text-decoration:none">${safe(bestUrl)}</a>` : '-'}</div>
      </div>

      <div style="font-weight:600;font-size:13px;margin:6px 0 4px;">Abstract</div>
      ${
        hasAbstract
          ? `
            <div id="${absId}" style="white-space:pre-wrap; font-size:13px; line-height:1.35;">
              ${safe(abstractShort)}
            </div>
            ${
              abstractFull.length > 1000
                ? `<div style="margin-top:6px">
                     <button id="${absToggleId}" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px">
                       Show more
                     </button>
                   </div>`
                : ``
              }`
          : `<div style="opacity:.6;font-size:13px">No abstract</div>`
      }

      <div style="font-weight:600;font-size:13px;margin:10px 0 4px;">Full text</div>
      ${
        hasFullText
          ? `<div id="${ftId}" style="opacity:.95">Cached ✓</div>`
          : (canExtract
              ? `<div id="${ftId}">
                   <button id="${ftBtnId}" style="background:rgba(255,255,255,0.08);
                     border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 10px;
                     border-radius:6px;cursor:pointer;font-size:12px;margin-right:8px">
                     Extract full text
                   </button>
                   <button id="${ftLocalId}" style="background:rgba(255,255,255,0.05);
                     border:1px solid rgba(255,255,255,0.15);color:#fff;padding:6px 10px;
                     border-radius:6px;cursor:pointer;font-size:12px">
                     Use local PDF…
                   </button>
                 </div>`
              : `<div id="${ftId}" style="opacity:.75">
                   No candidate links. You can still use a local PDF…
                   <div style="margin-top:6px">
                     <button id="${ftLocalId}" style="background:rgba(255,255,255,0.05);
                       border:1px solid rgba(255,255,255,0.15);color:#fff;padding:6px 10px;
                       border-radius:6px;cursor:pointer;font-size:12px">Use local PDF…</button>
                   </div>
                 </div>`
            )
      }
    `);

    // Abstract toggle
    const absToggle = document.getElementById(absToggleId);
    if (absToggle) {
      if (typeof captureUI === 'function') captureUI(absToggle);
      absToggle.addEventListener('click', () => {
        const el = document.getElementById(absId);
        if (!el) return;
        const isShort = el.textContent && el.textContent.endsWith('…') && abstractFull.length > 1000;
        if (isShort) { el.textContent = abstractFull; absToggle.textContent = 'Show less'; }
        else         { el.textContent = abstractShort; absToggle.textContent = 'Show more'; }
      });
    }

    // Full-text actions
    const ftBtn = document.getElementById(ftBtnId);
    if (ftBtn) {
      if (typeof captureUI === 'function') captureUI(ftBtn);
      ftBtn.addEventListener('click', () => extractFullTextForIndex(i, ftId)); // pass ftId so inline panel updates
    }
    const ftLocalBtn = document.getElementById(ftLocalId);
    if (ftLocalBtn) {
      if (typeof captureUI === 'function') captureUI(ftLocalBtn);
      ftLocalBtn.addEventListener('click', () => promptLocalPdfForIndex(i));
    }
  }
async _renderRemoteNode(i) {
  try {
    // Resolve shard URL from node ID
    const raw = String(nodes?.[i]?.idStr || '');
    const wid = (raw.match(/W\d+/i) || [raw])[0];
    const url = `${REMOTE_DETAILS_BASE}${wid}.json`;
    console.log('Loading details:', url);

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const d = await resp.json();

// --- push numeric counts into itemsData so node pills update ---
const it = (itemsData[i] ||= {});
// total references for “Cited:”
if (Number.isFinite(+d.references)) it.refsCount = (+d.references)|0;

// “Cited by:” (prefer value inside shard.network if present)
const cBy = Number.isFinite(+d?.network?.cited_by_count) ? +d.network.cited_by_count
          : Number.isFinite(+d?.cited_by_count)          ? +d.cited_by_count
          : null;
if (cBy != null) it.cbc = cBy|0;

// keep openalex subobject coherent (optional, but tidy)
(it.openalex ||= {}).cited_by_count = it.cbc|0;

if (Array.isArray(d?.openalex?.authorships)) {
  const names = d.openalex.authorships.map(a => a?.author?.display_name).filter(Boolean);
  if (names.length) it.authors = names;
}
const oa = d.openalex || {};
const vname =
  oa?.host_venue?.display_name ||
  oa?.primary_location?.source?.display_name ||
  (typeof d.venue === 'string' ? d.venue : null);
if (vname) it.venue = vname;

// optional quality-of-life flags some overlays use
nodes[i].hasAbs = !!(d.abstract && String(d.abstract).trim());
nodes[i].oa     = !!d.is_oa;

// debug
console.log('Pill counts updated', { i, refs: it.refsCount, citedBy: it.cbc });




    // --- helpers consistent with local path
    const esc  = s => String(s||'');
    const safe = s => esc(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

    // --- map shard -> view model (match local variables)
    const title     = d.title || wid;
    const authors   = Array.isArray(d.authors) ? d.authors.join(', ') : '';
    const venue     = d.venue || '';
    const year      = d.year || '';
    const citedBy   = (d.network?.cited_by_count ?? 0) | 0;
    const citing    = (d.networkCitations ?? d.network?.internal_citations ?? 0) | 0;
    const refsTotal = (d.references ?? '-') ;

    const clean     = (d.doi || '').toString().replace(/^https?:\/\/doi\.org\//,'').trim();
    const doiUrl    = clean ? `https://doi.org/${clean}` : '';
    const bestUrl   = d.url || d.openalex || doiUrl || '';

    const isOA      = !!d.is_oa;
    const oaStatus  = isOA && d.oa_status ? ` (${d.oa_status})` : '';

    const abstractFull  = (d.abstract || '').toString();
    const hasAbstract   = abstractFull.trim().length > 0;
    const abstractShort = abstractFull.length > 1000 ? abstractFull.slice(0,1000)+'…' : abstractFull;

    const absId      = `abs_${i}_${Date.now()}`;
    const absToggleId= `absTgl_${i}_${Date.now()}`;

    // --- HTML (copied from local renderer for consistency)
    this.div.html(`
      <div style="font-weight:600;font-size:16px;margin-bottom:6px">${safe(title)}</div>

      <div style="opacity:.85;margin-bottom:10px">${authors ? safe(authors) :
        '<span style="opacity:.6">Unknown authors</span>'}</div>

      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px;margin-bottom:12px">
        <div style="opacity:.7">Year</div><div>${year || '-'}</div>
        <div style="opacity:.7">Venue</div><div>${safe(venue || '-')}</div>
        <div style="opacity:.7">Cited by</div><div>${citedBy}</div>
        <div style="opacity:.7">Network Citations</div><div>${citing}</div>
        <div style="opacity:.7">References</div><div>${refsTotal}</div>
        <div style="opacity:.7">Open access</div>
        <div>${isOA ? ('Yes' + oaStatus) : 'No / unknown'}</div>
        <div style="opacity:.7">DOI</div><div>${clean ? `<a href="${doiUrl}" target="_blank" style="color:#8ecbff;text-decoration:none">${clean}</a>` : '-'}</div>
        <div style="opacity:.7">URL</div><div>${bestUrl ? `<a href="${safe(bestUrl)}" target="_blank" style="color:#8ecbff;text-decoration:none">${safe(bestUrl)}</a>` : '-'}</div>
      </div>

      <div style="font-weight:600;font-size:13px;margin:6px 0 4px;">Abstract</div>
      ${
        hasAbstract
          ? `
            <div id="${absId}" style="white-space:pre-wrap; font-size:13px; line-height:1.35;">
              ${safe(abstractShort)}
            </div>
            ${
              abstractFull.length > 1000
                ? `<div style="margin-top:6px">
                     <button id="${absToggleId}" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 8px;font-size:12px">Show full abstract</button>
                   </div>`
                : ''
            }
          `
          : `<div style="opacity:.7;font-size:13px">No abstract available</div>`
      }
    `);

    // expand/collapse abstract (same behaviour as local)
    if (hasAbstract && abstractFull.length > 1000) {
      const btn = document.getElementById(absToggleId);
      const el  = document.getElementById(absId);
      if (btn && el) {
        btn.addEventListener('click', () => {
          el.textContent = el.textContent.endsWith('…') ? abstractFull : abstractShort;
          btn.textContent = btn.textContent.includes('full') ? 'Show less' : 'Show full abstract';
        });
      }
    }
  } catch (e) {
    this.div.html(`<div style="opacity:.9">Failed to load details: ${e.message ? String(e.message).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) : 'Unknown error'}</div>`);
  }
}



  destroy() { this.div?.remove(); }
}






// ---------- Info helpers ----------


function getAbstract(work) {
  if (typeof work.abstract === 'string' && work.abstract.trim()) {
    return work.abstract;
  }
  if (work.abstract_inverted_index && typeof work.abstract_inverted_index === 'object') {
    return rebuildAbstract(work.abstract_inverted_index);
  }
  return '';
}

function rebuildAbstract(inv) {
  // OpenAlex inverted index -> text
  const positions = [];
  for (const arr of Object.values(inv)) { for (const p of arr) positions.push(p); }
  if (!positions.length) return '';
  const maxPos = Math.max(...positions);
  const arr = new Array(maxPos + 1);
  for (const [word, posArr] of Object.entries(inv)) {
    for (const p of posArr) arr[p] = word;
  }
  return arr.join(' ').replace(/\s+/g, ' ').trim();
}

function pickBestUrl(w, doiUrl = '') {
  const pl = w.primary_location || {};
  const cand = [
    pl.landing_page_url,
    pl.pdf_url,
    (pl.source && pl.source.homepage_url),
    w.id,             // OpenAlex page
    doiUrl
  ].filter(Boolean);
  return cand[0] || '';
}

// Normalize a DOI string (accepts raw DOI, "doi:...", or https://doi.org/...)
function cleanDOI(s) {
  let doi = String(s || "").trim();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  doi = doi.replace(/^doi:\s*/i, "");
  doi = doi.replace(/\s+/g, "");
  return doi;
}



function deselectNode() {
  selectedIndex = -1;
  showCanvasOverviewIfNoneSelected(); // remove the panel completely
  redraw();
}

function computePanelHeight() {
  const available = windowHeight - (PANEL_MARGIN + INFO_PANEL_TOP_SHIFT) - PANEL_MARGIN;
  const desired = (typeof PANEL_HEIGHT === "number" && PANEL_HEIGHT > 0)
    ? PANEL_HEIGHT
    : available;
  return Math.min(desired, Math.max(120, available), MAX_PANEL_HEIGHT);
}

// Build degree[] from your existing, undirected adj list
function computeDegreesFromAdj() {
  const n = nodes.length | 0;
  degree = new Array(n).fill(0);
  degreeMax = 0;
  for (let i = 0; i < n; i++) {
    const d = (adj[i] || []).length | 0;
    degree[i] = d;
    if (d > degreeMax) degreeMax = d;
  }
}

// Update slider bounds & label once a dataset is loaded
function initDegreeFilterUI() {
  if (!degSlider) return;
  degSlider.elt.min = 0;
  degSlider.elt.max = String(degreeMax);
  degThreshold = Math.min(degThreshold, degreeMax);
  degSlider.elt.value = String(degThreshold);
  updateDegLabel();
  if (degInput) {                          // NEW
    degInput.attribute('max', String(degreeMax));
    degInput.elt.value = String(degThreshold);
  }
}


// Apply the visibility mask and rebuild filtered edges
function applyDegreeFilter(threshold) {
  const n = nodes.length | 0;
  degThreshold = Number(threshold || 0);
  recomputeVisibility();
  
  visibleMask = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    visibleMask[i] = (degree[i] >= threshold);
  }

  // Rebuild edgesFiltered with only edges whose both endpoints are visible
  edgesFiltered = [];
  for (const e of edges) {
    const s = e.source | 0, t = e.target | 0;
    if (visibleMask[s] && visibleMask[t]) edgesFiltered.push(e);
  }

  // If selected node became invisible, deselect and hide the panel
  if (selectedIndex >= 0 && !visibleMask[selectedIndex]) {
    deselectNode?.();
  }

  // Update UI text and redraw
  updateInfo();
  updateDegLabel();
  updateDimSections?.();
  redraw();
}

function updateDegLabel() {
  if (!degLabel) return;
  degLabel.html(`Internal citations ≥ ${degThreshold} (max ${degreeMax})`);
}

// --- Year bounds from nodes[] ---
function computeYearBounds() {
  let minY =  9999, maxY = -9999, found = false;
  for (const n of nodes) {
    if (Number.isFinite(n.year)) {
      found = true;
      if (n.year < minY) minY = n.year;
      if (n.year > maxY) maxY = n.year;
    }
  }
  if (!found) { // fallback if no years present
    const now = new Date().getFullYear();
    minY = now; maxY = now;
  }
  yearMin = minY; yearMax = maxY;
  yearLo = minY; yearHi = maxY;
}

// --- Setup/refresh the sliders to current bounds ---
function initYearFilterUI() {
  if (!yearSliderMin || !yearSliderMax) return;
  yearSliderMin.elt.min = String(yearMin);
  yearSliderMin.elt.max = String(yearMax);
  yearSliderMax.elt.min = String(yearMin);
  yearSliderMax.elt.max = String(yearMax);
  yearSliderMin.elt.value = String(yearLo);
  yearSliderMax.elt.value = String(yearHi);
  updateYearLabel();
  if (yearLoInput) {                       // NEW
    yearLoInput.attribute('min', String(yearMin));
    yearLoInput.attribute('max', String(yearMax));
    yearLoInput.elt.value = String(yearLo);
  }
  if (yearHiInput) {                       // NEW
    yearHiInput.attribute('min', String(yearMin));
    yearHiInput.attribute('max', String(yearMax));
    yearHiInput.elt.value = String(yearHi);
  }
}


// --- Apply current slider values ---
function applyYearFilter() {
  // Keep label in sync and recompute overall visibility
  updateYearLabel();
  recomputeVisibility();
}

function updateYearLabel() {
  if (!yearLabel) return;
  yearLabel.html(`Year range: ${yearLo} – ${yearHi}`);
}

// --- Central visibility recompute (combines ALL filters) ---
// sketch.js — recomputeVisibility (replaced)

// --- Central visibility recompute (combines ALL filters) ---
// --- Central visibility recompute (combines ALL filters) ---
function recomputeVisibility() {
  const n = nodes.length | 0;
  if (!visibleMask || visibleMask.length !== n) visibleMask = new Array(n).fill(true);

  // Keep dimension membership flags fresh for visScaleForNode()
  if (dimMembershipDirty) refreshDimMembershipFlags();

  const aiLensOn  = !!(lenses && lenses.aiDocs);
  const dimLensOn = !!(lenses && lenses.hideNonDim);

  let whichTypes = null;
  let needDimFilter = false;
  if (aiLensOn || dimLensOn) {
    whichTypes    = (aiLensOn && dimLensOn) ? 'all' : (aiLensOn ? 'ai' : 'nonai');
    needDimFilter = true;
  }

  let dimHits = null;
  if (needDimFilter) {
    const anyDimsOfType = dimTools.some(d => d && (
      whichTypes === 'all' ? true :
      (whichTypes === 'ai' ? d.type === 'ai' : d.type !== 'ai')
    ));
    dimHits = anyDimsOfType ? computeDimMatches(false, whichTypes)
                            : new Array(n).fill(false);
  }

  for (let i = 0; i < n; i++) {
    const passDeg  = (degree[i] ?? 0) >= (degThreshold ?? 0);
    const y        = nodes[i].year;
    const passYear = Number.isFinite(y) ? (y >= yearLo && y <= yearHi)
                                        : (yearLo === yearMin && yearHi === yearMax);
    const passDim  = needDimFilter ? !!dimHits[i] : true;
    const passOA   = !lenses.openAccess || !!nodes[i]?.oa;
    const passExt  = (nodes[i]?.cbc || 0) >= (extCitesThreshold || 0);

    // NEW: cluster-size filter (0 = off)
  const cid = (Array.isArray(clusterOf) ? clusterOf[i] : -1);
  const csz = (cid != null && cid >= 0 && Array.isArray(clusterSizesTotal)) ? (clusterSizesTotal[cid] || 0) : 0;
  const passCluster = (clusterSizeThreshold <= 0) ? true : (csz >= clusterSizeThreshold);

    // NEW: viability — highest-wins scale; 0 means OFF
    const passViab = visScaleForNode(i) > 0;

  visibleMask[i] = passDeg && passYear && passDim && passOA && passExt && passViab && passCluster;
  }

  // Drop hover immediately if its node just turned invisible
  if (hoverIndex >= 0 && !visibleMask[hoverIndex]) hoverIndex = -1;

  // Rebuild filtered edges
  edgesFiltered = [];
  for (const e of edges) {
    const s = e.source|0, t = e.target|0;
    if (visibleMask[s] && visibleMask[t]) edgesFiltered.push(e);
  }

  if (selectedIndex >= 0 && !visibleMask[selectedIndex]) deselectNode?.();

  updateInfo?.();
  updateDimSections?.();
showCanvasOverviewIfNoneSelected();

  redraw();
}



function buildDimensionsIndex() {
  dimsIndex.authors.clear();
  dimsIndex.venues.clear();
  dimsIndex.concepts.clear();
  dimsIndex.institutions.clear();
  // NOTE: dimsIndex.clusters is rebuilt separately at the end.

  const push = (map, key, idx) => {
    if (!key) return;
    const k = String(key);
    let rec = map.get(k);
    if (!rec) { rec = { key:k, count:0, nodes: new Set() }; map.set(k, rec); }
    if (!rec.nodes.has(idx)) { rec.nodes.add(idx); rec.count++; }
  };

  for (let i = 0; i < itemsData.length; i++) {
    const item = itemsData[i] || {};
    const oa   = item.openalex || {};

    // Authors + Institutions
if (Array.isArray(oa.authorships)) {
  for (const a of oa.authorships) {
    const name = a?.author?.display_name || a?.author?.id || null;
    if (name) push(dimsIndex.authors, name, i);
    if (Array.isArray(a?.institutions)) {
      for (const inst of a.institutions) {
        const iname = inst?.display_name || inst?.id || null;
        if (iname) push(dimsIndex.institutions, iname, i);
      }
    }
  }
} else {
  // lite fallbacks
  for (const name of (item.authors || oa.authorship_names || [])) {
    if (name) push(dimsIndex.authors, name, i);
  }
  for (const iname of ( (item.institutions?.map(x=>x?.display_name).filter(Boolean)) || oa.institution_names || [] )) {
    if (iname) push(dimsIndex.institutions, iname, i);
  }
}
    // Venue
const venue = inferVenueNameFromWork(oa, item.venue || null);
if (venue) push(dimsIndex.venues, venue, i);

    // Concepts
    if (Array.isArray(oa.concepts)) {
      for (const c of oa.concepts) {
        const cname = c?.display_name || null;
        if (cname) push(dimsIndex.concepts, cname, i);
      }
    }
  }

  // ---- Clusters (from computed clusterOf + clusterLabels) ----
  dimsIndex.clusters.clear();
  if (Array.isArray(clusterOf) && clusterOf.length === itemsData.length && (clusterCount|0) > 0) {
    const byCid = new Map(); // cid -> { cid, key(label), label, count, nodes:Set }
    for (let i = 0; i < itemsData.length; i++) {
      const cid = clusterOf[i]; if (cid == null || cid < 0) continue;
      const label = (clusterLabels[cid] && clusterLabels[cid].trim())
        ? clusterLabels[cid] : `Cluster ${cid+1}`;
      let rec = byCid.get(cid);
      if (!rec) { rec = { cid, key: label, label, count: 0, nodes: new Set() }; byCid.set(cid, rec); }
      if (!rec.nodes.has(i)) { rec.nodes.add(i); rec.count++; }
    }
    for (const rec of byCid.values()) {
      if (rec.count > 10) dimsIndex.clusters.set(rec.label, rec); // keep your size threshold
    }
  }
}


function renderDimensionsUI() {
  // --- Layout anchors ---
  const baseRect = overlaysPanel?.elt?.getBoundingClientRect?.()
                || filtersPanel?.elt?.getBoundingClientRect?.();
  const topY = (baseRect ? (baseRect.bottom + 12) : 96);
  const maxH = windowHeight - topY - PANEL_MARGIN;

  // Helper: are we already living inside the accordion body?
  const isInsideAccordion = () => {
    const acc = document.getElementById('acc-dimensions');
    return !!(acc && dimSidebar?.elt && acc.contains(dimSidebar.elt));
  };

  // Helper: switch to "flow in accordion" styles (remove inner panel chrome)
  const applyAccordionStyles = () => {
    dimSidebar.style('position', 'static');
    dimSidebar.style('left', '');
    dimSidebar.style('top', '');
    dimSidebar.style('width', '100%');

    dimSidebar.style('background', 'transparent');
    dimSidebar.style('border', 'none');
    dimSidebar.style('box-shadow', 'none');
    dimSidebar.style('backdrop-filter', 'none');
    dimSidebar.style('padding', '0');

    dimSidebar.style('max-height', '400px');
    dimSidebar.style('overflow', 'auto');
  };

  // Helper: switch to legacy floating panel styles
  const applyFloatingStyles = () => {
    dimSidebar.style('position', 'fixed');
    dimSidebar.style('left', '12px');
    dimSidebar.style('top', `${topY}px`);
    dimSidebar.style('width', '260px');
    dimSidebar.style('z-index', '9980');

    // info-panel look
    dimSidebar.style('background', 'rgba(0,0,0,0.55)');
    dimSidebar.style('border', '1px solid rgba(255,255,255,0.12)');
    dimSidebar.style('border-radius', '12px');
    dimSidebar.style('box-shadow', '0 8px 24px rgba(0,0,0,0.25)');
    dimSidebar.style('backdrop-filter', 'blur(2px)');
    dimSidebar.style('padding', '10px 16px 12px 12px');

    dimSidebar.style('max-height', `${Math.max(120, maxH)}px`);
    dimSidebar.style('overflow-y', 'auto');
  };

  if (!dimSidebar) {
    // ---- Create container ----
    dimSidebar = createDiv('');
    dimSidebar.addClass('dim-scroll');

    // Default to floating look on first creation (it may be re-styled if mounted)
    applyFloatingStyles();

    captureUI(dimSidebar.elt);

    // Hide any legacy outside title if it exists
    try { dimensionsTitle?.hide?.(); } catch {}

    // ---- Header (built once) ----
    const hdr = createDiv('');
    hdr.parent(dimSidebar);
    hdr.style('display','flex');
    hdr.style('gap','6px');
    hdr.style('align-items','center');
    hdr.style('padding','6px 6px 8px 6px');
    hdr.style('border-bottom','1px solid rgba(255,255,255,0.08)');
    captureUI(hdr.elt);

    // Search input
    dimSearchInput = createInput(dimSearchQuery || '', 'text');
    dimSearchInput.parent(hdr);
    dimSearchInput.attribute('placeholder','Search dimensions…');
    dimSearchInput.style('width','100%');
    dimSearchInput.style('padding','6px 8px');
    dimSearchInput.style('font-size','12px');
    dimSearchInput.style('background','rgba(255,255,255,0.08)');
    dimSearchInput.style('border','1px solid rgba(255,255,255,0.15)');
    dimSearchInput.style('border-radius','8px');
    dimSearchInput.style('color','#eaeaea');
    captureUI(dimSearchInput.elt);

    // (Optional) Enter to search wiring conserved in case you re-enable it
    if (dimSearchInput?.elt) {
      dimSearchInput.elt.addEventListener('keydown', (e) => {
        // if (e.key === 'Enter') runDimSearch();
      });
    }

    // Search button
    const searchBtn = createButton('Search');
    searchBtn.parent(hdr);
    searchBtn.style('padding','6px 10px');
    searchBtn.style('font-size','12px');
    searchBtn.style('border-radius','6px');
    searchBtn.style('background','rgba(255,255,255,0.10)');
    searchBtn.style('border','1px solid rgba(255,255,255,0.25)');
    searchBtn.mousePressed(runDimSearch);
    captureUI(searchBtn.elt);

    // Clear button
    const clearBtn = createButton('×');
    clearBtn.parent(hdr);
    clearBtn.style('color','#fff');
    clearBtn.style('background','#000');
    clearBtn.style('border','1px solid rgba(255,255,255,0.15)');
    clearBtn.style('border-radius','6px');
    clearBtn.style('width','28px');
    clearBtn.style('height','28px');
    clearBtn.style('display','flex');
    clearBtn.style('align-items','center');
    clearBtn.style('justify-content','center');
    clearBtn.style('line-height','0');
    clearBtn.style('font-size','18px');
    clearBtn.style('cursor','pointer');
    clearBtn.mousePressed(() => {
      dimSearchQuery = '';
      dimSearchInput?.value('');
      updateDimSections(); // refresh list only
      dimSearchInput?.elt?.focus();
    });
    captureUI(clearBtn.elt);

    // Sections container (rebuilt by updateDimSections)
    dimSectionsWrap = createDiv('');
    dimSectionsWrap.parent(dimSidebar);
    dimSectionsWrap.style('padding','8px 6px 6px 6px');
    captureUI(dimSectionsWrap.elt);
  } else {
    // Re-render pass: choose styles based on where we live
    if (isInsideAccordion()) {
      applyAccordionStyles();
    } else {
      applyFloatingStyles();
    }
  }

  // If we are now inside the accordion, ensure we show only one visual layer
  if (isInsideAccordion()) {
    // Remove inner chrome (in case we were just moved here)
    applyAccordionStyles();
    // Also hide any legacy external title banner
    try { dimensionsTitle?.hide?.(); } catch {}
  }

  // Build/refresh the sections list
  try { dimensionsTitle?.hide?.(); } catch {}
  if (typeof updateDimSections === 'function') updateDimSections();
}







function updateDimSections() {
  if (!dimSectionsWrap) return;

  // remember which accordion section was open
  const openStates = {};
  dimSectionsWrap.elt.querySelectorAll('details').forEach((el) => {
    openStates[el.getAttribute('data-type') || ''] = el.open;
  });

  dimSectionsWrap.html('');  // clear only the lists area
  dimSections = {};

  const sections = [
    ['Authors',      'authors',      dimsIndex.authors],
    ['Venues',       'venues',       dimsIndex.venues],
    ['Concepts',     'concepts',     dimsIndex.concepts],
    ['Institutions', 'institutions', dimsIndex.institutions],
    ['Clusters',     'clusters',     dimsIndex.clusters],
  ];

  // Tokenize the query (AND match)
  const tokens = (dimSearchQuery ? dimSearchQuery.split(/\s+/).filter(Boolean) : []);

  const built = [];
  for (const [title, type, map] of sections) {
    const det = makeDimSection(title, type, map, tokens);
    det.parent(dimSectionsWrap);
    det.elt.setAttribute('data-type', type);
    // restore previous open/closed state
    if (openStates.hasOwnProperty(type)) det.elt.open = !!openStates[type];
    dimSections[type] = det;
    built.push(det);
  }

  // simple accordion: opening one closes the others
  for (const det of built) {
    det.elt.addEventListener('toggle', () => {
      if (det.elt.open) {
        for (const other of built) if (other !== det) other.elt.open = false;
      }
    });
  }
try { themeDimensionsScrollbars(); } catch {}

}




function makeDimSection(title, type, map, tokens = []) {
  const det = createElement('details');
  det.style('width', '100%');
  det.style('margin', '0 0 10px 0');
  det.style('color', '#eaeaea');
  det.attribute('open', '');

  const sum = createElement('summary', title);
  sum.parent(det);
  sum.style('cursor', 'pointer');
  captureUI(sum.elt);

  // Scrollable list body
  const box = createDiv('');
  box.parent(det);
  box.style('font-size','12px');
  box.style('max-height','160px');
  box.style('overflow-y','auto');
  box.style('padding-right','6px');
  box.addClass('dim-scroll');
  captureUI(box.elt);

  // Build items and filter by tokens (AND, case-insensitive)
  const items = Array.from(map.values()).sort((a,b)=> b.count - a.count);

  // If the query is 0–1 characters, treat as "empty" to avoid rendering thousands
  const shortQuery = (tokens.length === 0) ||
                     (tokens.length === 1 && tokens[0].length < 2);

  const tokenFiltered = shortQuery
    ? items
    : items.filter(rec => {
        const hay = (rec.key || rec.label || '').toLowerCase();
        return tokens.every(t => hay.includes(t));
      });

  // Safety: if visibleMask isn’t ready, treat all nodes as visible
  const vm = (Array.isArray(visibleMask) && visibleMask.length === nodes.length)
    ? visibleMask
    : new Array(nodes.length).fill(true);

  // Keep only dimensions that touch at least one *visible* node,
  // and compute a visible count for display.
  const visFiltered = [];
  for (const rec of tokenFiltered) {
    const iter = rec.nodes;
    let visCount = 0;
    if (iter && typeof iter[Symbol.iterator] === 'function') {
      for (const idx of iter) {
        const j = idx | 0;
        if (j >= 0 && j < vm.length && vm[j]) visCount++;
      }
    }
    if (visCount > 0) {
      visFiltered.push({ rec, visCount });
    }
  }

  // Optional empty state
  if (visFiltered.length === 0) {
    const empty = createDiv('<span style="opacity:.6">No matches for current filters</span>');
    empty.parent(box);
    empty.style('padding','6px 6px 8px 6px');
    return det;
  }

  // Cap long lists for responsiveness
  const cap   = shortQuery ? DIM_MAX_ROWS_EMPTY : DIM_MAX_ROWS_FILTERED;
  const shown = visFiltered.slice(0, cap);

  // Render rows using *visible* counts

for (const { rec, visCount } of shown) {
  // Build a dot + label

  // If it exists, find the tool + state to colour the dot
  // inside makeDimSection(...) when rendering each row
const exists = dimExists(type, rec);
let active = false;

// If it exists, find the tool and decide active state
if (exists && dimByKey) {
  const k = dimByKey.get(dimKeyFor(type, rec));
  const d = (k != null) ? dimTools[k] : null;
  if (d) active = !!(d.selected || d.power > 0);
}

const row = createDiv('');
row.parent(box);
row.style('display','flex');
row.style('align-items','center');
row.style('gap','8px');
row.style('padding','4px 6px');

// dot
const dot = createDiv('');
dot.parent(row);
dot.style('width','8px');
dot.style('height','8px');
dot.style('border-radius','50%');
dot.style('flex','0 0 auto');
// Yellow when active, faint when not. Placeholder grey if it doesn't exist yet.
dot.style('background', exists
  ? (active ? '#FFD400' : 'rgba(255,255,255,0.25)')
  : 'rgba(255,255,255,0.15)');

// label (+ count)
const label = createDiv(`${esc(rec.key)} <span style="opacity:.7">(${visCount})</span>`);
label.parent(row);
label.style('flex','1 1 auto');

// Grey/disable when a handle already exists (prevents duplicates)
row.style('cursor', exists ? 'default' : 'pointer');
row.style('opacity', exists ? '0.45' : '1');
row.style('filter', exists ? 'grayscale(80%)' : 'none');

// Only add a handle when it doesn't already exist
if (!exists) row.mousePressed(()=>toggleDimensionTool(type, rec));

captureUI(row.elt);

}



  // “…more” indicator
  if (visFiltered.length > shown.length) {
    const more = createDiv(`<span style="opacity:.7">… ${visFiltered.length - shown.length} more</span>`);
    more.parent(box);
    more.style('padding','4px 6px');
  }

  return det;
}


// Place this right after esc(s) and before the UI that calls it.
function toggleDimensionTool(type, rec) {
  const displayLabel = rec.label || rec.key;

  // Use a stable key so clusters don't duplicate (cid:###)
  const stableId = (type === 'clusters' && rec.cid != null) ? `cid:${rec.cid}` : rec.key;
  const toolKey  = `${type}|${stableId}`;
  let idx = dimByKey.get(toolKey);

dimMembershipDirty = true;



  if (idx == null) {
    // park the handle near the left side (in WORLD coords)
    const p = nextHandleSpawnPos();

    // IMPORTANT: clusters start at 0 so nothing jumps off-screen
    const tool = {
      type,
      key: toolKey,
      label: displayLabel,
      cid: (type === 'clusters' ? rec.cid : undefined),
      nodes: rec.nodes,
      power: DEFAULT_DIM_POWER,      // keep this 0 by default
      x: p.x, y: p.y,
      selected: true,
      ...(type === 'clusters' ? { userMoved: false } : {}),
      color: DIM_COLORS[type] || [220,220,220]
    };

    idx = dimTools.push(tool) - 1;
    dimByKey.set(toolKey, idx);
    selectDimension(idx);
  } else {
    // toggle selection if it already exists
    if (selectedDim === idx) deselectDimension();
    else selectDimension(idx);
  }

  if (lenses && lenses.hideNonDim) recomputeVisibility();
  redraw();
}

// If your script is running as a module, make it globally reachable for UI callbacks:
if (typeof window !== 'undefined') window.toggleDimensionTool = toggleDimensionTool;




function esc(s){ return String(s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }


function nodeDrawPos(i) {
  const base = nodes[i];
  if (!base) return { x: 0, y: 0 };

  let count = 0, sumPow = 0, sumX = 0, sumY = 0, sumPowForCentroid = 0;

  for (const d of dimTools) {
    if (!d) continue;
    if (!d.nodes || !d.nodes.has || !d.nodes.has(i)) continue;

    // ⬅️ Gate clusters: no influence until the user moves the handle or slider
    const effective = (d.type === 'clusters' && !d.userMoved) ? 0 : (d.power || 0);
    if (effective <= 0) continue;

    count++;
    sumPow += effective;
    sumPowForCentroid += effective;
    sumX += d.x * effective;
    sumY += d.y * effective;
  }

  if (count === 0 || sumPowForCentroid <= 0) return { x: base.x, y: base.y };

  const cx = sumX / sumPowForCentroid;
  const cy = sumY / sumPowForCentroid;
  const t  = Math.max(0, Math.min(1, (sumPow / count) / 100));
  return { x: base.x + (cx - base.x) * t, y: base.y + (cy - base.y) * t };
}



// Hardcoded, simple hit areas per type:
// - non-AI Dimensions: 45x45 square (centered)
// - AI Lenses: 22px radius circle
function hitHandleAtScreen(sx, sy) {
  if (!Array.isArray(dimTools) || !dimTools.length) return -1;

  let best = -1;
  let bestD2 = Infinity;

  for (let k = 0; k < dimTools.length; k++) {
    const d = dimTools[k];
    if (!d) continue;

    const { x, y } = worldToScreen(d.x, d.y);
    const dx = sx - x, dy = sy - y;

    const isAI = (d.type === 'ai');  // treat all AI as circular “lens”
    let hit = false;

    if (isAI) {
      // Circle hit area: radius 22px
      const R = 22;
      hit = (dx*dx + dy*dy) <= R*R;
    } else {
      // Square hit area: 45x45px centered
      const half = 45 * 0.5;
      hit = Math.abs(dx) <= half && Math.abs(dy) <= half;
    }

    if (hit) {
      // prefer the closest if overlaps
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = k; }
    }
  }

  return best;
}


function selectDimension(k) {
  if (selectedIndex !== -1) selectedIndex = -1;
  selectedDim = k;
  for (let i = 0; i < dimTools.length; i++) {
    if (dimTools[i]) dimTools[i].selected = (i === k);
  }
  if (infoPanel) {
    infoPanel.show();
    infoPanel.setDimensionIndex(k);
  }

  // NEW: if the lens is active, remember this dimension/cluster for filtering
  if (lenses && lenses.hideNonDim && dimTools[k]) {
    dimFilterLock = dimTools[k].key || null;
  }

  if (lenses?.hideNonDim) recomputeVisibility?.();
  updateDimSections?.();  
  redraw();
}



function deselectDimension() {
  // clear selected handle state
  selectedDim = -1;
  for (const d of dimTools) if (d) d.selected = false;

  // clear info panel
  showCanvasOverviewIfNoneSelected();

  // no active AI footprint when no dimension is selected
  aiActiveFootprint = null;
  aiHoverFootprint  = null;

  // unlock any “hide non-dimension” lock
  dimFilterLock = null;

  if (lenses && lenses.hideNonDim) recomputeVisibility();
  updateDimSections?.();
  redraw();
}





function deleteDimension(k) {
  const d = dimTools[k];
  if (!d) return;

  // 1) If this was an AI dimension, remove its footprint(s)
  if (d.type === 'ai') {
    try {
      if (d.aiSig && Array.isArray(aiFootprints)) {
        const idxF = aiFootprints.findIndex(f => f && f.sig === d.aiSig);
        if (idxF >= 0) aiFootprints.splice(idxF, 1);
      }
      if (aiActiveFootprint && aiActiveFootprint.sig === d.aiSig) aiActiveFootprint = null;
      if (aiHoverFootprint  && aiHoverFootprint.sig  === d.aiSig) aiHoverFootprint  = null;
    } catch (e) {
      console.warn('AI footprint cleanup on delete failed:', e);
    }
  }

  // 2) If this was a Cluster dimension, clear any sticky label selection
  if (d.type === 'clusters' && typeof clusterSelectId === 'number') {
    if (d.cid === clusterSelectId) clusterSelectId = -1;
  }

  // 3) Drop from arrays
  dimTools.splice(k, 1);

  // 4) Rebuild the key->index map (indices after k changed!)
  if (dimByKey) {
    dimByKey.clear();
    for (let i = 0; i < dimTools.length; i++) {
      const di = dimTools[i];
      if (di && di.key) dimByKey.set(di.key, i);
    }
  }

  // 5) Fix selection/hover/drag indices that pointed at or after k
  if (selectedDim === k) selectedDim = -1; else if (selectedDim > k) selectedDim--;
  if (dimHover   === k) dimHover   = -1;   else if (dimHover   > k) dimHover--;
  if (dimDrag?.idx === k) { dimDrag.active = false; dimDrag.idx = -1; }
  else if (dimDrag?.idx > k) dimDrag.idx--;

  // Clear any filter lock tied to this dim
  if (dimFilterLock && d.key && dimFilterLock === d.key) dimFilterLock = null;

  // 6) Force membership + visibility recompute so ghost highlights/links disappear
  dimMembershipDirty = true;           // ensures refreshDimMembershipFlags() runs (used by visScaleForNode)
  recomputeVisibility?.();             // rebuild masks/edges based on current sliders and flags

  // 7) Refresh UI and redraw
  renderDimensionsUI?.();
  updateDimSections?.();
  showCanvasOverviewIfNoneSelected();
  hoverIndex = -1;                     // drop any transient hover highlight
  redraw();
}


// If requireActivation is true -> a dim is active if (selected || power>0)
// whichTypes: 'ai' | 'nonai' | 'all' | null
function computeDimMatches(requireActivation = true, whichTypes = null) {
  const n = nodes.length | 0;
  const hits = new Array(n).fill(false);
  const wantAI    = (whichTypes === 'ai');
  const wantNonAI = (whichTypes === 'nonai');
  const wantAll   = (whichTypes == null || whichTypes === 'all');

  for (const d of dimTools) {
    if (!d) continue;
    if (requireActivation && !(d.selected || d.power > 0)) continue;
    if (!wantAll) {
      if (wantAI && d.type !== 'ai') continue;
      if (wantNonAI && d.type === 'ai') continue;
    }
    for (const idx of d.nodes) if (idx >= 0 && idx < n) hits[idx] = true;
  }
  return hits;
}



// Prevent canvas pan/zoom while interacting with UI controls
let uiCapture = false;

function captureUI(el) {
  if (!el) return;
  // mark that UI has the pointer so canvas shouldn't pan
  const onDown  = (e) => { uiCapture = true; e.stopPropagation(); };
  const onUp    = (e) => { uiCapture = false; e.stopPropagation(); };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('mousedown',   onDown);
  el.addEventListener('touchstart',  onDown, {passive:true});

  el.addEventListener('pointerup',   onUp);
  el.addEventListener('mouseup',     onUp);
  el.addEventListener('touchend',    onUp);
  el.addEventListener('touchcancel', onUp);

  // don't let wheel events bubble to the canvas zoom
  el.addEventListener('wheel', (e) => { e.stopPropagation(); }, {passive:true});


}

function selectNode(i) {
  // Clear any active dimension so lines drop to faint immediately
  if (selectedDim !== -1) deselectDimension();
  // Keep clusters at power 0 until the user intentionally moves them
if (lenses?.hideNonDim || lenses?.domainClusters) {
  for (const d of dimTools) {
    if (!d) continue;
    if (d.type === 'clusters' && !d.userMoved) d.power = 0;
  }
}


  selectedIndex = i;

  if (infoPanel) {
    infoPanel.show();
    infoPanel.setItemIndex(i);
  }

  redraw();
}



function createDimensionsSidebar() {
  renderDimensionsUI();
}


// Helper builds Icons/<Stem>_On.png or _Off.png
function iconPath(stem, isOn) {
  // Special-case the new lens filenames
  if (stem === 'Only Abstracts') {
    return isOn
      ? 'Icons/Only_Abstracts_On.png'     // exact name
      : 'Icons/Only_Abstracts_Off.png';   // exact name (with underscore + typo)
  }
  // Default for the existing lenses
  return `Icons/${stem}_${isOn ? 'On' : 'Off'}.png`;
}


function createTopControlBar() {
  // container
  topBar = createDiv('');
  topBar.style('position','fixed');
  topBar.style('left','12px');
  topBar.style('top','12px');
  topBar.style('display','flex');
  topBar.style('gap','10px');
  topBar.style('align-items','center');
  topBar.style('height', `${CONTROL_ICON_SIZE}px`);
  topBar.style('z-index','9995');
  captureUI(topBar.elt);

  // Import JSON icon
  const load = createImg('./Icons/Load_JSON.png', 'Import JSON');
  load.parent(topBar);
  load.size(CONTROL_ICON_SIZE, CONTROL_ICON_SIZE);
  load.style('display','block');
  load.style('cursor','pointer');
  load.attribute('draggable','false');
  load.attribute('title', 'Load JSON or PDF'); 
  load.mousePressed(openFileDialog);
  attachTooltip(load, 'Load JSON or PDF');
  captureUI(load.elt);

  // Run Layout icon
  const lay = createImg('./Icons/Force_Icon.png', 'Run layout');
  lay.parent(topBar);
  window.topToolbar = topBar;
  lay.size(CONTROL_ICON_SIZE, CONTROL_ICON_SIZE);
  lay.style('display','block');
  lay.style('cursor','pointer');
  lay.attribute('draggable','false');
  lay.attribute('title', 'Run Force Directed Graph'); 
  attachTooltip(lay, 'Run Force Directed Graph'); 
  lay.mousePressed(toggleLayout);
  captureUI(lay.elt);

  // Auto-cache button (parent to topBar, not 'bar')
  const autoBtn = createButton('Retrieve Full Texts');
  autoBtn.parent(topBar);
  autoBtn.style('margin-left', '8px');
  autoBtn.style('padding', '6px 10px');
  autoBtn.style('font-size', '12px');
  autoBtn.style('background', 'rgba(255,255,255,0.08)');
  autoBtn.style('border', '1px solid rgba(255,255,255,0.2)');
  autoBtn.style('color', '#fff');
  autoBtn.style('border-radius', '8px');
  autoBtn.mousePressed(() => { autoCacheVisible(); });
  autoBtn.style('display','none');//hide for now
  captureUI?.(autoBtn.elt);

  if (DEMO_MODE) {
  // Disable: Load JSON/PDF
  load.style('opacity','0.1');
  load.style('pointer-events','none');
  load.style('cursor','default');
  load.attribute('title', 'Load JSON/PDF (disabled in Demo mode)');

  // Disable: Run Force Directed Graph
  lay.style('opacity','0.1');
  lay.style('pointer-events','none');
  lay.style('cursor','default');
  lay.attribute('title', 'Run Force Directed Graph (disabled in Demo mode)');
}


  // keep references for visual feedback
  ctrlIcons.load = load;
  ctrlIcons.layout = lay;
  updateLayoutIconState();

  // New: dropdowns
  createDataMenuButton();


  // --- Force default lens states after menus are built ---
// after createLensesMenuButton(), createAIMenuButton(), etc.                    // AI Dimensions lens OFF by default
forceDefaultLensStates(); 
if (typeof recomputeVisibility === 'function') recomputeVisibility();
if (typeof redraw === 'function') redraw();


  // Hide the old "Lenses" header if it exists
  try { lensesTitle?.hide(); } catch(_) {}


}

// ============= AI MODES DROPDOWN =============
let aiMenuBtn = null;
let aiMenu    = null;
let aiMenuOpen = false;

function createAIMenuButton() {
  const parent = (typeof topBar !== 'undefined' && topBar) ? topBar : document.body;

  // Button (icon)
  aiMenuBtn = createImg('Icons/AI_Icon_100.png', 'AI');
  aiMenuBtn.parent(parent);
  aiMenuBtn.style('width','40px');
  aiMenuBtn.style('height','40px');
  aiMenuBtn.style('margin-left','8px');
  aiMenuBtn.style('cursor','pointer');
  aiMenuBtn.style('user-select','none');
  aiMenuBtn.attribute('draggable', 'false');
  aiMenuBtn.attribute('title', 'AI Lenses'); 
  attachTooltip(aiMenuBtn, 'AI Lenses'); 
  if (typeof captureUI === 'function') captureUI(aiMenuBtn.elt);

  // Fallback to .svg if .png is not there
  aiMenuBtn.elt.addEventListener('error', () => {
    if (!aiMenuBtn.elt.dataset.triedSvg) {
      aiMenuBtn.elt.dataset.triedSvg = '1';
      aiMenuBtn.elt.src = 'Icons/AI_Icon_50.svg';
    }
  });

  // Dropdown panel
  aiMenu = createDiv('');
  aiMenu.parent(parent);
  aiMenu.style('position','absolute');
  aiMenu.style('background','rgba(0,0,0,0.9)');
  aiMenu.style('border','1px solid rgba(255,255,255,0.18)');
  aiMenu.style('border-radius','10px');
  aiMenu.style('backdrop-filter','blur(6px)');
  aiMenu.style('padding','6px');
  aiMenu.style('z-index','99999');
  aiMenu.hide();

  if (DEMO_MODE) {
  aiMenuBtn.style('opacity', '0.1');
  aiMenuBtn.style('pointer-events', 'none');
  aiMenuBtn.style('cursor', 'default');
  aiMenuBtn.attribute('title', 'AI Lenses (disabled in Demo mode)');
}
  if (typeof captureUI === 'function') captureUI(aiMenu.elt);

  const addItem = (label, onClick) => {
    const it = createDiv(label);
    it.parent(aiMenu);
    it.style('padding','8px 12px');
    it.style('font-size','12px');
    it.style('white-space','nowrap');
    it.style('border-radius','8px');
    it.style('cursor','pointer');
    it.mouseOver(() => it.style('background','rgba(255,255,255,0.08)'));
    it.mouseOut(()  => it.style('background','transparent'));
    it.mousePressed(() => { closeAIMenu(); onClick?.(); });
    if (typeof captureUI === 'function') captureUI(it.elt);
  };

  // Wire existing actions
  // (All three exist already in your file)
  addItem('Reader (full text)', () => runReaderFulltext?.());
  addItem('Full Text Lit Review', () => runFullTextLitReview?.());
  addItem('Multi Cluster Review', () => openMultiClusterLitDialog?.());
  addItem('Label clusters',     () => runLabelClustersAI?.());
  addItem('Synthesise abstracts',() => runSynthesisAbstracts?.());
  addItem('Chronological review',() => runChronologicalReview?.());
  addItem('Open question…',          () => runOpenQuestion?.());

  aiMenuBtn.mousePressed(toggleAIMenu);

  // Global close handlers
  document.addEventListener('click', (e) => {
    if (!aiMenuOpen) return;
    const inBtn  = aiMenuBtn?.elt?.contains(e.target);
    const inMenu = aiMenu?.elt?.contains(e.target);
    if (!inBtn && !inMenu) closeAIMenu();
  });
  document.addEventListener('keydown', (e) => {
    //if (e.key === 'Escape') closeAIMenu();
  });
}

function toggleAIMenu() {
  if (!aiMenu || !aiMenuBtn) return;
  aiMenuOpen = !aiMenuOpen;
  if (aiMenuOpen) {
    // Position the menu just under the icon
    const r = aiMenuBtn.elt.getBoundingClientRect();
    aiMenu.style('left', (r.left) + 'px');
    aiMenu.style('top',  (r.bottom + 6) + 'px');
    aiMenu.show();
  } else {
    aiMenu.hide();
  }
}

function closeAIMenu() {
  if (!aiMenu) return;
  aiMenuOpen = false;
  aiMenu.hide();
}
// =========== END AI MODES DROPDOWN ============



function updateLayoutIconState() {
  if (!ctrlIcons.layout) return;
  // subtle “active” glow while layout is running
  ctrlIcons.layout.style('filter', layoutRunning ? 'drop-shadow(0 0 6px rgba(120,220,255,.9))' : 'none');
  ctrlIcons.layout.style('opacity', layoutRunning ? '1' : '0.95');
    if (DEMO_MODE) {
    ctrlIcons.layout.style('filter', 'none');
    ctrlIcons.layout.style('opacity', '0.1');
    ctrlIcons.layout.style('pointer-events', 'none');
    ctrlIcons.layout.style('cursor', 'default');
    ctrlIcons.layout.attribute('title', 'Run Force Directed Graph (disabled in Demo mode)');
    return; // ← prevent normal styling from re-applying
  }
}



function createSectionHeader(text, left, top) {
  const el = createDiv(text);
  el.style('position', 'fixed');
  el.style('left', `${left}px`);
  el.style('top', `${top}px`);
  el.style('width', `${TITLE_WIDTH}px`);
  el.style('color', '#eaeaea');
  el.style('font-weight', '600');
  el.style('font-size', `${TITLE_FONT_SIZE}px`);
  // 2px underline of 150px + 5px space below
  el.style('border-bottom', '2px solid #fff');
  el.style('padding-bottom', `${TITLE_GAP_PX}px`);
  el.style('user-select', 'none');
  return el;
}


function showLoading(msg = 'Loading…', pct = 0) {
  isLoading   = true;
  loadingMsg  = msg;
  loadingPct  = Math.max(0, Math.min(1, pct));
  loop();     // ensure draw runs to paint overlay
  redraw();
}

function setLoadingProgress(pct, msg) {
  loadingPct = Math.max(0, Math.min(1, Number(pct) || 0));
  if (msg) loadingMsg = msg;
  redraw();
}

function hideLoading() {
  isLoading  = false;
  loadingMsg = '';
  loadingPct = 0;
  if (!layoutRunning) noLoop();
  redraw();
}


function drawLoadingOverlay() {
  const cx = width / 2, cy = height / 2;

  // backdrop
  push();
  noStroke();
  fill(0, 160);
  rectMode(CENTER);
    // Optional centred splash (Demo vs Normal)
  const splash = (typeof DEMO_MODE !== 'undefined' && DEMO_MODE) ? splashDemoImg : splashImg;
  let yCenter = cy; // we may shift UI down if the splash is drawn
  if (splash && splash.width && splash.height) {
    push();
    imageMode(CENTER);

    // Fit splash to ~60% of viewport while preserving aspect
    const maxW = width * 0.6;
    const maxH = height * 0.6;
    const sc = Math.min(maxW / splash.width, maxH / splash.height, 1);

    // Draw splash a bit above true centre so bar/message can sit below it
    const splashH = splash.height * sc;
    const splashY = cy - 20;  // slight lift
    image(splash, cx, splashY, splash.width * sc, splashH);

    // Move the status box underneath the splash
    yCenter = splashY + (splashH / 2) + 48;
    pop();
  }



  // status box
  const W = 360, H = 76, R = 10;
  rect(cx, yCenter, W, H, R);

  // message
  fill(255);
  textAlign(CENTER, BOTTOM);
  textSize(14);
  text(loadingMsg || 'Loading…', cx, yCenter - 6);

  // progress track
  const bw = 300, bh = 12;
  const bx = cx - bw / 2, by = yCenter + 8;

  fill(35, 35, 45, 230);
  rectMode(CORNER);
  rect(bx, by, bw, bh, 6);

  // progress fill (no animation; reflects loadingPct)
  const w = Math.round(bw * Math.max(0, Math.min(1, loadingPct)));
  fill(120, 200, 255, 230);
  rect(bx, by, w, bh, 6);

  pop();
}

function nextTick() { return new Promise(res => setTimeout(res, 0)); }

// tiny “string-art” spinner evocative of your logo
function drawLogoSpinnerAt(cx, cy) {
  push();
  noFill();
  strokeWeight(1.5);

  const size = 120;
  const R = 28;           // circle radius
  const SEP = 120;        // distance between circle centers
  const L = 28;           // number of “spokes”

  // colors (orange -> blue)
  const cL = color(255, 176, 58);
  const cR = color(88, 172, 255);

  // rotating offset for the right circle
  const off = loadingPhase * 0.9;

  for (let i = 0; i < L; i++) {
    const a = (i / L) * TWO_PI;
    const x1 = cx - SEP / 2 + R * Math.cos(a);
    const y1 = cy + R * Math.sin(a);

    const a2 = -a + off;
    const x2 = cx + SEP / 2 + R * Math.cos(a2);
    const y2 = cy + R * Math.sin(a2);

    const t = i / (L - 1);
    const cc = lerpColor(cL, cR, t);
    stroke(red(cc), green(cc), blue(cc), 220);
    line(x1, y1, x2, y2);
  }

  // subtle circle outlines
  stroke(220, 220, 230, 160);
  ellipse(cx - SEP / 2, cy, R * 2, R * 2);
  ellipse(cx + SEP / 2, cy, R * 2, R * 2);

  pop();
}

// Minimal English stopword set (tunable)
const STOP = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','how','if','in','into',
  'is','it','its','of','on','or','that','the','their','this','to','was','were','what',
  'when','where','which','who','why','with','we','you','your','our','they','them',
  'i','he','she','it','my','me','us'
]);

function tokenize(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  // keep letters + digits, turn everything else into space
  const parts = s.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
  for (const w of parts) {
    if (w.length < 3) continue;      // drop very short tokens
    if (STOP.has(w)) continue;
    if (/^\d+$/.test(w)) continue;   // drop pure numbers
    out.push(w);
  }
  return out;
}

// Prefer plain-text abstract from export; fall back to OpenAlex
function abstractForIndex(i) {
  const item = itemsData?.[i] || {};
  const w = item.openalex || {};
  const a = item.openalex_abstract || getAbstract(w) || '';
  // fallback: fold title + concepts if abstract missing
  if (!a) {
    const title = w.display_name || w.title || '';
    const concepts = Array.isArray(w.concepts) ? w.concepts.map(c=>c?.display_name||'').join(' ') : '';
    return `${title} ${concepts}`.trim();
  }
  return a;
}

/**
 * Compute a compact 3-word label for each cluster via TF-IDF.
 * Uses unigrams only (fast, robust). If you want phrases later we can extend.
 */
function computeClusterLabels() {
  const n = nodes.length | 0;
  if (!clusterOf || clusterOf.length !== n) { clusterLabels = []; return; }

  // Build per-doc tokens + global DF
  const docTokens = new Array(n);
  const DF = new Map();
  for (let i = 0; i < n; i++) {
    const toks = tokenize(abstractForIndex(i));
    docTokens[i] = toks;
    const seen = new Set();
    for (const t of toks) { if (seen.has(t)) continue; seen.add(t); DF.set(t, (DF.get(t) || 0) + 1); }
  }

  // Group docs by cluster
  const byCluster = new Map(); // cid -> [idx...]
  for (let i = 0; i < n; i++) {
    const cid = clusterOf[i];
    if (cid == null || cid < 0) continue;
    let arr = byCluster.get(cid);
    if (!arr) byCluster.set(cid, arr = []);
    arr.push(i);
  }

  const prev = Array.isArray(clusterLabels) ? clusterLabels.slice() : [];
  const next = new Array(clusterCount).fill('');

  const Ndocs = n || 1;
  const setAuto = (cid, text) => {
    // keep existing AI/manual label
    if (prev[cid] && String(prev[cid]).trim()) return;
    next[cid] = String(text || '').trim();
  };

  for (const [cid, idxs] of byCluster.entries()) {
    // keep existing label as-is
    if (prev[cid] && String(prev[cid]).trim()) { next[cid] = prev[cid]; continue; }

    if ((idxs?.length || 0) < CLUSTER_TITLE_MIN_SIZE) { next[cid] = ''; continue; }

    // TF-IDF within this cluster
    const TF = new Map(); let tot = 0;
    for (const i of idxs) { for (const t of docTokens[i]) { TF.set(t, (TF.get(t) || 0) + 1); tot++; } }
    if (tot === 0) { next[cid] = ''; continue; }

    const scored = [];
    for (const [t, tf] of TF.entries()) {
      const df = DF.get(t) || 1;
      const tfNorm = tf / tot;
      const idf = Math.log((Ndocs + 1) / (df + 1));
      scored.push([t, tfNorm * idf]);
    }
    scored.sort((a,b)=>b[1]-a[1]);

    const top3 = scored.slice(0, 3).map(([t]) => t);
    setAuto(cid, top3.join(' '));
  }

  // Carry through any remaining prev labels not in byCluster (edge cases)
  for (let cid = 0; cid < clusterCount; cid++) {
    if (!next[cid] && prev[cid] && String(prev[cid]).trim()) next[cid] = prev[cid];
  }

  clusterLabels = next;
}

function drawClusterLabels() {
  if (!nodes.length || !clusterLabels || !clusterLabels.length) return;

  // Opacity from the Cluster Labels slider
  const clusterAlpha = Math.max(0, Math.min(1, ovClusterLabels));

  // When labels are off, clear hits so hover/click are disabled
  if (clusterAlpha <= 0) {
    clusterLabelHits = [];
    return;
  }

  clusterLabelHits = []; // reset hit areas each frame
  textFont('sans-serif');
  textSize(13);
  textAlign(CENTER, CENTER);

  for (let cid = 0; cid < clusterCount; cid++) {
    const label = clusterLabels[cid] || '';
    if (!label) continue;

    // Centroid of VISIBLE nodes in this cluster
    let sx = 0, sy = 0, k = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (clusterOf[i] !== cid) continue;
      if (visibleMask.length && !visibleMask[i]) continue;
      const p = parallaxWorldPos(i);
      const s = worldToScreen(p.x, p.y);
      sx += s.x; sy += s.y; k++;
    }

    // Use TOTAL cluster size for gating, not the visible count
    const total = (clusterSizesTotal && clusterSizesTotal[cid] != null) ? clusterSizesTotal[cid] : k;
    const minReq = Math.max(CLUSTER_TITLE_MIN_SIZE, clusterSizeThreshold || 0);
    if (total < minReq || k === 0) continue;

    sx /= k; sy /= k;

    // Pill
    const col = clusterColors[cid] || [220,220,220];
    const bg  = color(col[0], col[1], col[2], Math.round(60  * clusterAlpha));
    const padX = 10;
    const w = textWidth(label) + padX * 2 + 18;  // room for radio
    const h = 22;

    push();
    noStroke(); rectMode(CENTER);
    fill(0, Math.round(130 * clusterAlpha));
    rect(sx, sy, w + 4, h + 4, 0);

    fill(bg);
    rect(sx, sy, w, h, 0);

    // Text
    fill(255, Math.round(255 * clusterAlpha));
    textAlign(LEFT, CENTER);
    const textX = sx - w / 2 + padX;
    text(label, textX, sy + 1);

    // Right-hand "radio" dot hit target (optional)
// Right-hand “radio” square hit target
const rx = sx + w / 2 - padX - 8, ry = sy, rr = 8;
const sq = rr; // ≈ circle diameter

// Is there an existing Dimension for this cluster?
const key = `clusters|cid:${cid}`;
let dimIdx = dimByKey?.get ? dimByKey.get(key) : null;

// Fallback scan in case maps aren’t hydrated yet
if ((dimIdx == null || dimIdx < 0) && Array.isArray(dimTools)) {
  dimIdx = dimTools.findIndex(d => d && d.type === 'clusters' && d.cid === cid);
}
const hasDim = Number.isInteger(dimIdx) && dimIdx >= 0 && dimTools?.[dimIdx];
const isSelectedDim = hasDim && (selectedDim === dimIdx);

// Draw the radio: outlined when off, filled yellow when on.
// If selected, make it a touch brighter and a hair thicker.
rectMode(CENTER);
if (hasDim) {
  // fill matches the non-AI dimension (edge) color = yellow
  const col = (DIM_COLORS && DIM_COLORS.clusters) ? DIM_COLORS.clusters : [255, 230, 100];
  noStroke();
  fill(col[0], col[1], col[2], Math.round(240 * clusterAlpha));
  rect(rx, ry, sq, sq, 0);

  // subtle focus ring
  stroke(col[0], col[1], col[2], isSelectedDim ? 255 : Math.round(230 * clusterAlpha));
  strokeWeight(isSelectedDim ? 2 : 1.5);
  noFill();
  rect(rx, ry, sq + (isSelectedDim ? 2 : 0), sq + (isSelectedDim ? 2 : 0), 0);
} else {
  // off state: empty square
  stroke(240, 240, 255, Math.round(230 * clusterAlpha));
  strokeWeight(1.5);
  noFill();
  rect(rx, ry, sq, sq, 0);
}



    // keep a screen-space anchor so we can spawn the handle just above the pill
clusterLabelCenters[cid] = { sx, sy, h };

// emit hit record with both legacy and current field names (for hover + click)
clusterLabelHits.push({
  type: 'label',
  clusterId: cid,
  cx: sx, cy: sy, hw: w * 0.5, hh: h * 0.5
});
clusterLabelHits.push({
  type: 'box',
  clusterId: cid,
  cx: rx, cy: ry, hw: (sq * 0.6) * 0.5, hh: (sq * 0.6) * 0.5
});
    pop();
  }
}



function ensureClusterDimension(cid, label, powerZero = true) {
  // Build a stable key from the cluster id
  const stableId = `cid:${cid}`;
  const toolKey  = `clusters|${stableId}`;

  let idx = dimByKey.get(toolKey);
  if (idx == null) {
    // Build node set
    const ns = new Set();
    for (let i = 0; i < nodes.length; i++) if (clusterOf[i] === cid) ns.add(i);

    // Initial placement: cluster centroid in *world* coords
    let wx, wy;
const box = clusterLabelCenters[cid];
if (box) {
  const targetSX = box.sx;
  const targetSY = box.sy - (box.h * 0.5 + 6);
  const wpos = screenToWorld(targetSX, targetSY);
  wx = wpos.x; wy = wpos.y;
} else {
  // fallback: world centroid of nodes
  let sx = 0, sy = 0, k = 0;
  for (let i = 0; i < nodes.length; i++) if (clusterOf[i] === cid) { sx += nodes[i].x; sy += nodes[i].y; k++; }
  wx = k ? (sx / k) : width * 0.5;
  wy = k ? (sy / k) : height * 0.5;
}

const tool = {
  type: 'clusters',
  key: toolKey,
  cid,
  label: (label && label.trim()) ? label : `Cluster ${cid+1}`,
  nodes: ns,
  power: DEFAULT_DIM_POWER,   // should be 0
  x: wx, y: wy,
  selected: true,
  userMoved: false,
  color: DIM_COLORS.clusters || [255,230,100]
};

    idx = dimTools.push(tool) - 1;
    dimByKey.set(toolKey, idx);
dimMembershipDirty = true;


  }
  selectDimension(idx);
  if (lenses.hideNonDim) recomputeVisibility();
  redraw();
}

function drawDimEdges() {
  if (!Array.isArray(dimTools) || !dimTools.length) return;

  const aiOn  = !!(lenses && lenses.aiDocs);      // “AI Dimensions” lens
  const dimOn = !!(lenses && lenses.hideNonDim);  // “Dimensions” lens (non-AI)

  // Colour spec (non-AI = yellow; AI = cyan)
  const COL_NONAI = [255, 230, 100];
  const COL_AI    = (typeof DIM_COLORS !== 'undefined' && DIM_COLORS.ai) ? DIM_COLORS.ai : [130, 210, 255];

  for (let k = 0; k < dimTools.length; k++) {
    const d = dimTools[k];
    if (!d) continue;

    const isAI = (d.type === 'ai');

    // ── Lens gating rules ─────────────────────────────────────
    // Default (both OFF): show BOTH AI & non-AI
    // AI ON only: show AI ONLY
    // Dimensions ON only: show non-AI ONLY
    // Both ON: show BOTH
    if (aiOn && !dimOn) {
      if (!isAI) continue;
    } else if (!aiOn && dimOn) {
      if (isAI) continue;
    }
    // else: both off OR both on → show both

    // ── Styling (semi-transparent when not selected; opaque when selected) ──
    const isSelected = (k === selectedDim);
    const [r, g, b]  = isAI ? COL_AI : COL_NONAI;
const alphaBase = isSelected ? (EDGE_HILITE_ALPHA || 255) : (SELECT_DIM_EDGE_ALPHA || 36);

// NEW: visibility scaling (note: spokes are NOT affected by visAllPubs per spec)
const vK = isAI ? visAIDims : visDims;
const alpha = Math.round(alphaBase * vK);

// and use `alpha` below:
stroke(r, g, b, alpha);
    strokeWeight((isSelected ? 2 : 1.25) / cam.scale);

    // ── Connect handle → publications (works for Set or Array) ─────────────
    const iter = (d.nodes && typeof d.nodes[Symbol.iterator] === 'function') ? d.nodes : [];
    for (const idxRaw of iter) {
      const i = (idxRaw|0);
      if (i < 0 || i >= nodes.length) continue;
      if (!visibleMask[i]) continue;
      if (lenses.openAccess && !nodes[i]?.oa) continue; // respect OA lens
      const p = parallaxWorldPos(i);
      line(d.x, d.y, p.x, p.y);
    }
  }
}



function drawDimHandles() {
  if (!Array.isArray(dimTools) || !dimTools.length) return;

  const aiOn  = !!(lenses && lenses.aiDocs);
  const dimOn = !!(lenses && lenses.hideNonDim);

  for (let k = 0; k < dimTools.length; k++) {
    const d = dimTools[k];
    if (!d) continue;

    const isAI = (d.type === 'ai');

    // Lens gating (same rules as drawDimEdges)
    if (aiOn && !dimOn) {
      if (!isAI) continue;
    } else if (!aiOn && dimOn) {
      if (isAI) continue;
    }

    // Opacity from the sliders (Dimensions vs AI Dimensions)
    const vK    = isAI ? visAIDims : visDims;
    const alpha = Math.round(255 * vK);
    if (alpha <= 0) continue;

    // --- Size: pick px size per type, then convert to world units
    const SIZE_PX    = isAI ? (AI_DIM_HANDLE_ICON_PX || DIM_HANDLE_ICON_PX || 28)
                            : (DIM_HANDLE_ICON_PX || 28);
    const SIZE_WORLD = SIZE_PX / cam.scale;

    // --- Glow on hover/selection (before drawing the icon)
    const isHot = (k === dimHover) || (k === selectedDim) || !!d.selected; // hover OR selected persists. :contentReference[oaicite:1]{index=1}
    if (isHot) {
      // Pick colour by type (AI = cyan/blue, non-AI = yellow)
      const col = (DIM_COLORS && DIM_COLORS[d.type])
        ? DIM_COLORS[d.type]
        : (isAI
            ? ((DIM_COLORS && DIM_COLORS.ai) ? DIM_COLORS.ai : [130,210,255])
            : [255,230,100]);

      // Multi-ring soft glow
      const G = 6 / cam.scale; // base ring growth
      push();
      noFill();
      // three rings, fading outwards
      for (let ring = 1; ring <= 3; ring++) {
        const a = Math.round(alpha * (ring === 1 ? 0.55 : ring === 2 ? 0.35 : 0.20));
        stroke(col[0], col[1], col[2], a);
        strokeWeight((ring * 2) / cam.scale);

        if (isAI) {
          // Circle glow for AI lenses
          circle(d.x, d.y, (SIZE_WORLD + ring * G * 2));
        } else {
          // Square glow for Dimensions
          rectMode(CENTER);
          rect(d.x, d.y, (SIZE_WORLD + ring * G * 2), (SIZE_WORLD + ring * G * 2), 2 / cam.scale);
        }
      }
      pop();
    }

    // ── Icon selection ─────────────────────────────────────────────
    let icon = null;
    if (isAI) {
      const kind = (typeof aiKindOf === 'function') ? aiKindOf(d) : null;
      if (kind && aiLensIcons && aiLensIcons[kind]) {
        icon = aiLensIcons[kind];
      } else if (aiLensIcons && aiLensIcons.default) {
        icon = aiLensIcons.default;
      } else if (dimIcons && dimIcons.ai) {
        icon = dimIcons.ai; // last-resort fallback
      }
    } else {
      const key = (d.type === 'institution') ? 'institutions' : d.type;
      icon = (dimIcons && (dimIcons[key] || dimIcons.default)) ? (dimIcons[key] || dimIcons.default) : null;
    }
    // ───────────────────────────────────────────────────────────────

    if (icon) {
      // Draw the icon itself (tinted to slider alpha)
      push();
      noStroke();
      tint(255, alpha);
      image(icon, d.x - SIZE_WORLD / 2, d.y - SIZE_WORLD / 2, SIZE_WORLD, SIZE_WORLD);
      pop();
    } else {
      // Vector fallback glyph (if no PNG available) — keep existing look
      const R   = 6  / cam.scale;
      const ARM = 12 / cam.scale;
      const STW = ((k === dimHover || k === selectedDim) ? 2 : 1.5) / cam.scale;
      const [r,g,b] = isAI
        ? ((typeof DIM_COLORS !== 'undefined' && DIM_COLORS.ai) ? DIM_COLORS.ai : [130,210,255])
        : [255,230,100];

      stroke(r, g, b, alpha);
      strokeWeight(STW);
      noFill();
      line(d.x - ARM, d.y, d.x + ARM, d.y);
      line(d.x, d.y - ARM, d.x, d.y + ARM);
      noStroke();
      fill(r, g, b, alpha);
      circle(d.x, d.y, R * 2);
      noFill();
      stroke(r, g, b, alpha);
      strokeWeight(STW);
      circle(d.x, d.y, R * 2 + (4 / cam.scale));
    }
  }
}


async function buildGraphFromPayloadAsync(payload) {
  const items = Array.isArray(payload?.items) ? payload.items
              : (Array.isArray(payload) ? payload : []);
  itemsData = items;
  selectedIndex = -1;

  if (!items.length) {
    msg = "No items found in JSON.";
    nodes = []; edges = [];
    updateInfo(); redraw();
    return;
  }

  // ---- Edges (0.65 -> 0.85) ----
  setLoadingProgress(0.68, 'Building edges…');
  await nextTick();

  const esRaw = Array.isArray(payload?.edges) ? payload.edges : buildEdgesFromItems(items);

  const normEdges = [];
  const seen = new Set();
  const E = esRaw.length;
  const B1 = 5000; // batch size
  for (let off = 0; off < E; off += B1) {
    const end = Math.min(E, off + B1);
    for (let a = off; a < end; a++) {
      const e = esRaw[a] || {};
      const s = toInt(e.source), t = toInt(e.target);
      if (!Number.isInteger(s) || !Number.isInteger(t)) continue;
      if (s < 0 || t < 0 || s >= items.length || t >= items.length) continue;
      const key = s + ">" + t;
      if (seen.has(key)) continue;
      seen.add(key);
      normEdges.push({ source: s, target: t });
    }
    const frac = E ? (end / E) : 1;
    setLoadingProgress(0.68 + 0.17 * frac, `Building edges… ${Math.round(100 * frac)}%`);
    await nextTick();
  }

  // ---- Nodes (0.85 -> 1.00) ----
  setLoadingProgress(0.85, 'Building nodes…');
  await nextTick();

  const n = items.length;

  // Set a large virtual world size for big graphs, then spawn near the centre
  setWorldSizeForN(n);

  nodes = new Array(n);
  cbcMin = Infinity; cbcMax = -Infinity;

  // centred spawn window (~60% of world side)
  const cx = world.w * 0.5, cy = world.h * 0.5;
  const span = Math.min(world.w, world.h) * 0.6;
  const half = span * 0.5;

  const B2 = 1000;
  for (let i = 0; i < n; i++) {
    //
    const item  = items[i] || {};
    const oa    = item.openalex || {};
    const isOA  = normalizeIsOA ? normalizeIsOA(item) 
            : !!(oa.open_access && oa.open_access.is_oa === true); 
    const label = oa.display_name || oa.title || item.title || item.shortTitle || "Untitled";
    const cbc   = Number(oa.cited_by_count ?? 0);
    //const isOA  = !!(oa.open_access && oa.open_access.is_oa === true);
    const ypub  = Number(oa.publication_year);
    

    // abstract presence (plain text you stored, or rebuild from OA)
    const absText = (typeof item.openalex_abstract === 'string' ? item.openalex_abstract : '') || getAbstract(oa) || '';
   const hasAbs  = absText.trim().length > 0;

    const hasFT  = typeof item.fulltext === 'string' && item.fulltext.trim().length > 0;

    nodes[i] = {
      idx: i,
      x: random(cx - half, cx + half),
      y: random(cy - half, cy + half),
      r: 3,
      label,
      cbc,
      oa: isOA,
      year: Number.isFinite(ypub) ? ypub : NaN,
      hasAbs,
      hasFullText: hasFT 
    };

    if (cbc < cbcMin) cbcMin = cbc;
    if (cbc > cbcMax) cbcMax = cbc;

    if ((i + 1) % B2 === 0 || i === n - 1) {
      setLoadingProgress(0.85 + 0.15 * ((i + 1) / n), `Building nodes… ${Math.round(100 * (i + 1) / n)}%`);
      await nextTick();
    }
  }
  computeCbcRobustStats();
  initExtCitesFilterUI?.();

  // ---- Finish: compute derived structures (quick) ----
  edges = normEdges;
{
  const inDeg = new Array(n).fill(0);
  for (const e of normEdges) {
    const t = (e.target|0);
    if (t>=0 && t<n) inDeg[t]++;
  }
  for (let i=0;i<n;i++) nodes[i].intIn = inDeg[i]|0;
}

  buildAdjacency(n, edges);
  computeDegreesFromAdj();
  initDegreeFilterUI();
  applyDegreeFilter(0);
  computeIntInRobustStats();

  computeYearBounds();
  initYearFilterUI();
  recomputeVisibility();

  computeDomainClusters();
  buildDimensionsIndex();
  renderDimensionsUI();

  msg = `Loaded ${items.length} items and ${edges.length} edges.`;
  updateInfo();

  initForceLayout();

  // Show the whole world immediately
  fitWorldInView(60);

  redraw();
  layoutRunning = true;
  loop();
}



function computeCbcRobustStats() {
  if (!nodes || !nodes.length) {
    cbcP5 = 0; cbcP95 = 1; cbcLogMin = 0; cbcLogMax = 1; 
    return;
  }
  const vals = nodes.map(n => Math.max(0, Number(n.cbc||0))).sort((a,b)=>a-b);
  const pick = (p) => vals[Math.max(0, Math.min(vals.length-1, Math.floor(p*(vals.length-1))))];
  // If very few points, fall back to min/max
  if (vals.length < 10) {
    cbcP5  = vals[0];
    cbcP95 = vals[vals.length-1];
  } else {
    cbcP5  = pick(0.05);
    cbcP95 = pick(0.95);
    if (cbcP95 <= cbcP5) { cbcP5 = vals[0]; cbcP95 = vals[vals.length-1]; }
  }
  // Precompute log bounds
  cbcLogMin = Math.log1p(cbcP5);
  cbcLogMax = Math.log1p(cbcP95);
  if (cbcLogMax <= cbcLogMin) { cbcLogMin = Math.log1p(vals[0]||0); cbcLogMax = Math.log1p(vals[vals.length-1]||1); }
}





function createSynthesisUI() {
  // Create once
  if (synthPanel) return;

  synthPanel = createDiv('');
  synthPanel.style('position','fixed');
  synthPanel.style('left','50%');
  synthPanel.style('top','50%');
  synthPanel.style('transform','translate(-50%, -50%)');
  synthPanel.style('width','62vw');
  synthPanel.style('height','72vh');
  synthPanel.style('background','rgba(0,0,0,0.78)');
  synthPanel.style('color','#fff');
  synthPanel.style('border','1px solid rgba(255,255,255,0.25)');
  synthPanel.style('border-radius','10px');
  synthPanel.style('box-shadow','0 10px 30px rgba(0,0,0,0.45)');
  synthPanel.style('z-index','99999');        // ensure it’s on top
  synthPanel.style('pointer-events','auto');  // clickable
  synthPanel.hide();
  if (typeof captureUI === 'function') captureUI(synthPanel.elt);

  const header = createDiv(`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.2)">
      <div style="font-weight:600">Synthesis</div>
      <div style="display:flex;gap:8px">
        <button id="synCopy"      style="background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.25);color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px">Copy</button>
        <button id="synDownload"  style="background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.25);color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px">Download</button>
        <button id="synClose"     style="background:#ff5a5a;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px">Close</button>
      </div>
    </div>
  `);
  header.parent(synthPanel);

  synthBody = createDiv('<div style="opacity:.8">Ready.</div>');
  synthBody.parent(synthPanel);
  synthBody.style('padding','12px 12px 16px');
  synthBody.style('overflow-y','auto');
  synthBody.style('height','calc(72vh - 50px)');
  synthBody.style('box-sizing','border-box');
  synthBody.style('height','calc(72vh - 64px)');
  synthPanel.style('overflow', 'hidden');
  //

  // Initial wire-up
  wireSynthButtons();
}

function wireSynthButtons() {
  // Always (re)bind to current DOM elements
  const closeBtn = document.getElementById('synClose');
  const copyBtn  = document.getElementById('synCopy');
  const dlBtn    = document.getElementById('synDownload');

  if (closeBtn) {
    closeBtn.onclick = (e) => { e.preventDefault(); synthPanel.hide(); };
    captureUI?.(closeBtn);
  }
  if (copyBtn) {
    copyBtn.onclick = (e) => { e.preventDefault(); copySynthesisToClipboard(); };
    captureUI?.(copyBtn);
  }
  if (dlBtn) {
    dlBtn.onclick = (e) => { e.preventDefault(); downloadSynthesisAsMarkdown(); };
    captureUI?.(dlBtn);
  }
}

function openSynthPanel(msg = 'Preparing…') {
  if (!synthPanel) createSynthesisUI();
  if (synthBody) {
    synthBody.html(`<div style="opacity:.8">${esc(msg)}</div>`);
    synthBody.elt.scrollTop = 0;
  }
  synthPanel.show();
}

// ---- [ADD] Markdown → HTML formatter for review text ----
function formatMarkdownToHTML(md) {
  md = String(md ?? '');

  // Normalize newlines
  md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Escape basic HTML then selectively re-enable formatting we support
  const escapeMap = {'&':'&amp;','<':'&lt;','>':'&gt;'};
  md = md.replace(/[&<>]/g, c => escapeMap[c]);

  // Headings:
  // #### -> subheading small
  md = md.replace(/^####\s+(.*)$/gm, '<div class="review-subheading-sm">$1</div>');
  // ### -> subheading
  md = md.replace(/^###\s+(.*)$/gm, '<div class="review-subheading">$1</div>');
  // ##  -> main section heading (bold line with divider)
  md = md.replace(/^##\s+(.*)$/gm, '<div class="review-heading">$1</div>');
  // #   -> document title (rare in your output but supported)
  md = md.replace(/^#\s+(.*)$/gm, '<div class="review-title">$1</div>');

  // Bold **text**
  md = md.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Italic *text* or _text_  (avoid ** already handled)
  md = md
    .replace(/(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)([^*]|$)/g, '$1<em>$2</em>$3')
    .replace(/(^|[^_])_([^_\n]+)_([^_]|$)/g, '$1<em>$2</em>$3');

  // Inline code `code`
  md = md.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Fenced code blocks ```lang ... ```
  md = md.replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, (m, code) => {
    return `<pre class="review-code"><code>${code.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`;
  });

  // Numbered lists 1. 2. ...
  // Convert each contiguous block into <ol>…</ol>

// Ordered (numbered) lists: robust, ignores whitespace-only "items", preserves start number
md = md.replace(
  /(^|\n)(?:\s*(\d+)\.\s+[^\n]*(?:\n(?!\s*\d+\.\s)[^\n]*)*(?:\n{1,2}(?=\s*\d+\.\s))?)+/g,
  (m, p1) => {
    // Split the contiguous block into numbered entries
    const blocks = m.trim().split(/\n(?=\s*\d+\.\s)/);

    // Parse each entry, drop whitespace-only ones
    const items = blocks.map(b => {
      const m2 = b.match(/^\s*(\d+)\.\s+([\s\S]*)/);
      if (!m2) return null;
      const num  = parseInt(m2[1], 10);
      const text = (m2[2] || '').trim();
      if (!text || text.replace(/\s+/g, '').length === 0) return null; // skip blanks
      // preserve internal single newlines; collapse multiple blank lines
      const safe = text
        .replace(/\n{2,}/g, '\n')       // collapse multi-blank into single
        .replace(/\n[ \t]+$/gm, '\n')   // strip trailing spaces
        .replace(/\n/g, '<br/>');       // keep soft breaks inside an item
      return { num, html: `<li>${safe}</li>` };
    }).filter(Boolean);

    if (items.length === 0) return `${p1}${m}`; // fallback if nothing parsed

    const start = items[0].num || 1;
    const startAttr = start !== 1 ? ` start="${start}"` : '';
    return `${p1}<ol${startAttr}>${items.map(i => i.html).join('')}</ol>`;
  }
);


  // Bullet lists - … (also supports • or * as bullets at start of line)
  md = md.replace(/(^|\n)(\s*[-*•]\s+[^\n]+(\n(?!\n|\s*[-*•]\s).+)*)/g, (m, p1, block) => {
    const items = block
      .split('\n')
      .filter(line => /^\s*[-*•]\s+/.test(line))
      .map(line => line.replace(/^\s*[-*•]\s+/, ''))
      .map(txt => `<li>${txt}</li>`)
      .join('');
    return `${p1}<ul>${items}</ul>`;
  });

  // Turn single blank lines into paragraph breaks, but don’t break inside lists/code/headers
  // First, split by double newlines and wrap paragraphs.
  const parts = md.split(/\n{2,}/).map(chunk => {
    // already HTML blocks? leave as-is
    if (/^\s*<(div|ul|ol|pre|h\d|table|blockquote)/i.test(chunk)) return chunk;
    // lines that are list items or headings or code blocks should not be wrapped again
    if (/^\s*<\/?(ul|ol|li|pre|div|code)/i.test(chunk)) return chunk;
    // If the chunk already contains block tags, skip wrapping
    if (/<(div|ul|ol|pre|table|blockquote)\b/i.test(chunk)) return chunk;
    // Otherwise wrap in <p>
    return `<p>${chunk.replace(/\n/g, '<br/>')}</p>`;
  });

  return parts.join('\n');
}

// ---- [ADD] Inject consistent styles once (matches viewer tone) ----
function ensureReviewStyles() {
  if (document.getElementById('reviewStyles')) return;
  const css = `
    .review-container { font-family: Inter, "Helvetica Neue", Arial, sans-serif; font-size: 14px; line-height: 1.5; }
    .review-title { font-weight: 800; font-size: 18px; margin: 8px 0 6px; }
    .review-heading { font-weight: 700; font-size: 16px; margin: 14px 0 6px; padding-bottom: 2px; border-bottom: 1px solid rgba(255,255,255,0.12); }
    .review-subheading { font-weight: 600; font-size: 15px; margin: 10px 0 4px; }
    .review-subheading-sm { font-weight: 600; font-size: 14px; opacity: 0.9; margin: 8px 0 4px; }
    .review-container p { margin: 8px 0; }
    .review-container ul, .review-container ol { margin: 6px 0 10px 18px; }
    .review-container li { margin: 2px 0; }
    .review-container strong { font-weight: 700; }
    .review-container em { font-style: italic; }
    .review-container code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; padding: 1px 4px; border-radius: 4px; background: rgba(127,127,127,0.12); }
    .review-code { background: rgba(127,127,127,0.12); padding: 8px; border-radius: 8px; overflow:auto; }
  `.trim();
  const style = document.createElement('style');
  style.id = 'reviewStyles';
  style.textContent = css;
  document.head.appendChild(style);
}


function setSynthBodyText(text, filename = 'synthesis.md') {
  if (!synthBody) return;
  ensureReviewStyles();
  const htmlBody = formatMarkdownToHTML(String(text ?? ''));
  const html = `<div class="review-container" data-final="1">${htmlBody}</div>`;
  synthBody.html(html);
  synthBody.elt.scrollTop = 0;

  // keep .md download as original text
  const dlBtn = document.getElementById('synDownload');
  if (dlBtn) {
    dlBtn.onclick = (e) => {
      e.preventDefault();
      const blob = new Blob([String(text ?? '')], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'synthesis.md';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    };
  }
}



function currentSynthPlainText() {
  return synthBody ? synthBody.elt.innerText : '';
}

function copySynthesisToClipboard() {
  const txt = currentSynthPlainText();
  if (!txt) return;
  navigator.clipboard?.writeText(txt);
}


function setSynthHtml(html) { if (synthBody) synthBody.html(html); }

function currentSynthPlainText() { return synthBody ? synthBody.elt.innerText : ''; }
function copySynthesisToClipboard() {
  const txt = currentSynthPlainText();
  if (!txt) return;
  navigator.clipboard?.writeText(txt);
}
function downloadSynthesisAsMarkdown() {
  const txt = currentSynthPlainText();
  if (!txt) return;
  const blob = new Blob([txt], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'synthesis.md';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
// Robustly pull just the .summary string if the model returns JSON
function stripSummaryJson(raw) {
  const t = String(raw || '').trim();
  // direct JSON
  try { const j = JSON.parse(t); if (j && typeof j.summary === 'string') return j.summary; } catch (_) {}
  // fenced
  const fence = t.match(/```json([\s\S]*?)```/i);
  if (fence) {
    try { const j = JSON.parse(fence[1]); if (j && typeof j.summary === 'string') return j.summary; } catch (_) {}
  }
  // single JSON object somewhere in text
  const block = t.match(/\{[\s\S]*\}/);
  if (block) {
    try { const j = JSON.parse(block[0]); if (j && typeof j.summary === 'string') return j.summary; } catch (_) {}
  }
  return t;
}

async function runSynthesisAbstracts() {
  if (!OPENAI_API_KEY) { openApiKeyModal(); return; }

  // 1) Collect all visible items that have abstracts (you already have this)
  const items = collectVisibleForSynthesis(Infinity);
  const totalVisible = (visibleMask || []).reduce((a,b)=>a+(b?1:0),0);
  const totalWithAbs = items.length;

  openSynthPanel(`Preparing (thematic) — ${totalWithAbs} abstracts; ${totalVisible} visible nodes…`);
  if (!totalWithAbs) { setSynthHtml('<div style="opacity:.8">No visible papers have abstracts.</div>'); return; }

  // 2) Build a global numbering for [n] and for the References list
  //    Keep stable order (by cbc desc) as in your collector
  const numbered = items.map((it, idx) => ({ n: idx+1, ...it })); // [{n, id, title, authors, ...}]
  const byNodeIndex = new Map(numbered.map(r => [r.id, r]));
  const shortRefMap = {}; // n -> "Author Year: Title..."
  for (const it of numbered) shortRefMap[it.n] = shortRef(it); // you already have shortRef()

  // 3) Group the same items by cluster (natural clustering already in your data)
  //    Use clusterOf[] if present; otherwise put everything in one synthetic cluster -1
  const byCluster = new Map();
  const fallbackCid = -1;
  for (const it of numbered) {
    const rawCid = (typeof clusterOf !== 'undefined' && Array.isArray(clusterOf) && Number.isFinite(clusterOf[it.id])) 
                    ? Number(clusterOf[it.id]) 
                    : fallbackCid;
    const cid = Number.isFinite(rawCid) ? rawCid : fallbackCid;
    let arr = byCluster.get(cid);
    if (!arr) byCluster.set(cid, (arr = []));
    arr.push(it);
  }

  // 4) Decide cluster titles: prefer your AI labels if present, else fallback strings
  const titleForCid = (cid) => {
    if (Array.isArray(clusterLabels) && typeof clusterLabels[cid] === 'string' && clusterLabels[cid].trim()) {
      return clusterLabels[cid].trim();
    }
    return (cid === -1) ? 'General Theme' : `Cluster ${cid}`;
  };

  // 5) Helper to ask the model for a JSON result { title, summary, used_ids }
  const askClusterSummary = async (clusterItems, preferredTitle) => {
    // chunk large clusters to stay within token budgets
    const chunks = partition(clusterItems, SYNTH_CHUNK_SIZE);
    const perChunk = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const payload = chunks[ci].map(({n, title, authors, year, venue, abstract}) => ({
        n, title, authors, year, venue, abstract
      }));

      const sys = [
        'You are a research synthesiser.',
        'Summarise the following academic paper abstracts in UK English for ONE THEME.',
        'Highlight shared aims, methods, convergences/divergences, key findings, gaps.',
        'Use inline bracket citations like [n] where n is the global paper number.',
        'Cite only numbers provided; do not invent new numbers.',
        'Return JSON ONLY with keys: "summary" (string) and "used_ids" (array of integers).',
        'Do NOT include a References section.'
      ].join(' ');

      const user = [
        preferredTitle ? `THEME: ${preferredTitle}` : '',
        `ABSTRACTS (numbered JSON; count=${payload.length}):`,
        JSON.stringify(payload),
        '',
        'Write a concise integrated summary (~150–250 words). Keep [n] next to supported claims.'
      ].join('\n');

      setSynthHtml(`<div>Summarising “${preferredTitle||'Theme'}” chunk ${ci+1}/${chunks.length}…</div>`);
      const raw = await openaiChatDirect(
        [{role:'system',content:sys},{role:'user',content:user}],
        SYNTH_BODY_MAX_TOKENS
      );
      // Robust JSON scrape (you already have parseJsonLoose in your file)
      const j = (function parseJsonLoose(text){
        try { return JSON.parse(text); } catch(_) {}
        const fence = text.match(/```json([\s\S]*?)```/i);
        if (fence) { try { return JSON.parse(fence[1]); } catch(_){} }
        const block = text.match(/\{[\s\S]*\}/);
        if (block) { try { return JSON.parse(block[0]); } catch(_){} }
        return null;
      })(raw) || { summary: String(raw||'').trim(), used_ids: [] };

      perChunk.push({
        summary: String(j.summary||'').trim(),
        used_ids: Array.isArray(j.used_ids) ? j.used_ids.map(Number).filter(Number.isFinite) : []
      });
    }

    // Merge chunk summaries into one thematic paragraph, preserving citations
    const allowed = Array.from(new Set(perChunk.flatMap(c => c.used_ids))).sort((a,b)=>a-b);
    const mergeSys = [
      'You are a research synthesiser.',
      'Combine the chunk summaries (they already contain inline [n] citations).',
      'Preserve existing [n] citations verbatim; only add citations using ALLOWED_IDS.',
      'Do not renumber citations; do not invent numbers.',
      'Return JSON ONLY: {"summary":"..."}'
    ].join(' ');
    const mergeUser = [
      `ALLOWED_IDS: ${allowed.join(', ')}`,
      `CHUNK SUMMARIES (${perChunk.length}):`,
      perChunk.map((c,i)=>`[Chunk ${i+1}] ${c.summary}`).join('\n\n'),
      '',
      'Produce a single, tight thematic summary (~160–260 words).'
    ].join('\n');

    const mergedRaw = await openaiChatDirect(
      [{role:'system',content:mergeSys},{role:'user',content:mergeUser}],
      { max_tokens: Math.min(1400, SYNTH_META_MAX_TOKENS) }
    );

    // stripSummaryJson() already exists in your file
    const merged = stripSummaryJson(mergedRaw);
    return { title: preferredTitle || computeAISummaryTitle(merged, 'Theme'), summary: merged, used_ids: allowed };
  };

  // 6) Run per-cluster syntheses
  const clusterOrder = [...byCluster.keys()].sort((a,b)=>{
    // largest cluster first (stable & readable)
    return (byCluster.get(b)?.length||0) - (byCluster.get(a)?.length||0);
  });

  const thematicBlocks = [];
  const citedIdsGlobal = new Set();

  for (const cid of clusterOrder) {
    const arr = byCluster.get(cid) || [];
    if (!arr.length) continue;

    const title = titleForCid(cid);
    const res = await askClusterSummary(arr, title);
    for (const id of (res.used_ids||[])) citedIdsGlobal.add(id);

    // Markdown block per cluster
    thematicBlocks.push([
      `## ${res.title}`,
      '',
      res.summary,
      ''
    ].join('\n'));
  }

  // 7) Build final report with References for *all* visible-with-abstract items
  const header = `
Processed **${totalWithAbs}** abstracts (from **${totalVisible}** visible nodes).
Found **${byCluster.size}** thematic cluster${byCluster.size===1?'':'s'}.
`.trim();

  const bodyMd = [
    '# Thematic Synthesis (Abstracts)',
    '',
    header,
    '',
    ...thematicBlocks,
    '## References',
    '',
    ...numbered.map((it, k) => formatReference(it, k)) // your formatter
  ].join('\n');

  // Panel view (HTML) mirroring the markdown (use your renderer helpers)
  const refsHtml = renderReferenceListHtml(numbered);
  const clustersHtml = thematicBlocks
    .map(block => `<div style="margin:10px 0;white-space:pre-wrap">${esc(block).replace(/\n/g,'<br/>')}</div>`)
    .join('');

  const html = `
    <div style="opacity:.85;margin-bottom:8px">${esc(header)}</div>
    ${clustersHtml}
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.2);margin:12px 0">
    <div style="font-weight:600;margin-bottom:6px">References (${numbered.length})</div>
    ${refsHtml}
  `;
  setSynthHtml(html);
  setSynthBodyText(bodyMd, 'thematic_synthesis.md');

  // 8) Create ONE AI lens object linked to the visible items
  try {
    addAIFootprintFromItems('synthesis', numbered, bodyMd, 'Thematic Synthesis (Abstracts)');
    redraw();
  } catch (e) {
    console.warn('Footprint (thematic synthesis) failed:', e);
  }
}





// Pick up what’s on-screen, respecting filters
function collectVisibleForSynthesis(maxItems = Infinity) {
  const out = [];
  const n = nodes.length | 0;
  const idxs = [];
  for (let i = 0; i < n; i++) if (visibleMask[i]) idxs.push(i);
  // sort by cited_by_count DESC so most central items are early if you later cap
  idxs.sort((a,b) => (nodes[b]?.cbc||0) - (nodes[a]?.cbc||0));

  for (let k = 0; k < idxs.length; k++) {
    const i = idxs[k];
    const item = itemsData?.[i] || {};
    const w = item.openalex || {};
    const abs = String(item.openalex_abstract || getAbstract(w) || '').trim();
    if (!abs) continue;


    // add index + world position so the footprint can draw lines & a marker
    const p = (typeof parallaxWorldPos === 'function') ? parallaxWorldPos(i) : (nodes?.[i] || {});
    const px = Number.isFinite(p?.x) ? p.x : 0;
    const py = Number.isFinite(p?.y) ? p.y : 0;

    const title = w.display_name || w.title || item.title || 'Untitled';
    const year  = w.publication_year || '';
    const venue = inferVenueNameFromWork(w, item.venue || '');
    const doi   = cleanDOI(w.doi || '');
    const url   = pickBestUrl(w, doi ? `https://doi.org/${doi}` : '');
    const authors = getAuthors(w);

    out.push({
      id: i, idx: i, x: px, y: py,
      title,
      authors,
      year,
      venue,
      doi,
      url,
      abstract: abs.slice(0, MAX_ABSTRACT_CHARS)   // keep per-abstract budget
    });

    if (out.length >= maxItems) break;
  }
  return out;
}


// Very simple HTML sanitizer + formatting for the returned doc
function renderSynthesisAsHtml(txt) {
  const escd = esc(txt).replace(/\n/g, '<br/>');
  return `<div style="font-size:14px;line-height:1.45;white-space:normal">${escd}</div>`;
}

let apiBtn, apiModal;



function openApiKeyModal() {
  apiModal?.show();
  const input = document.getElementById('apiInput');
  if (input) { input.value = OPENAI_API_KEY; input.focus(); }
}

function formatReference(it, k) {
  const n = k + 1;
  const au = (it.authors || []).join(', ');
  const yr = it.year || '';
  const ven= it.venue || '';
  const tail = it.doi ? `https://doi.org/${it.doi}` : (it.url || '');
  return `[${n}] ${esc(au)}${yr?` (${yr})`:''}. ${esc(it.title)}.${ven?` ${esc(ven)}.`:''} ${esc(tail)}`;
}

function renderReferenceListHtml(items) {
  // Keep the same numbering the model cited
  const lines = items.map((it, k) => formatReference(it, k));
  // simple list; change to <ol> if you prefer
  return `<div style="font-size:13px;line-height:1.4;white-space:pre-wrap">${lines.join('\n')}</div>`;
}


function partition(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Accepts either (messages, 700) or (messages, { max_tokens: 700, temperature: 0.2 })
// ---- client (sketch.js) ----
const OPENAI_PROXY = `${FETCH_PROXY}/openai/chat`; // reuse your existing FETCH_PROXY base

async function openaiChatDirect(messages, opts = {}) {
  const options = (typeof opts === 'number') ? { max_tokens: opts } : (opts || {});
  const {
    model = OPENAI_MODEL || 'gpt-4o-mini',
    temperature = 0.2,
    max_tokens = 1400,
    retries    = (typeof OQ_MAX_RETRIES === 'number' ? OQ_MAX_RETRIES : 6),
    throttleMs = (typeof OQ_INTER_CALL_DELAY_MS === 'number' ? OQ_INTER_CALL_DELAY_MS : 0),
    onRetry    = null  // optional callback(status, waitMs, attempt)
  } = options;

  const body = { model, messages, temperature, max_tokens };

  // --- global gate: ensure spacing between ALL OpenAI calls ---
  const now = Date.now();
  const gap = Math.max(0, (__OPENAI_NEXT_OK_TS || 0) - now);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));

  let delay = 900; // starting backoff (ms)
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(OPENAI_PROXY, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(OPENAI_API_KEY ? { 'Authorization': `Bearer ${OPENAI_API_KEY}` } : {})
        },
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        const ra = Number(r.headers.get('retry-after')) || 0;
        const err = new Error(`OpenAI ${r.status}`);
        err.status = r.status;
        err.retryAfter = ra;
        throw err;
      }
      const j = await r.json();

      // after a *successful* call: set next-allowed time (global) + optional per-call idle
      __OPENAI_NEXT_OK_TS = Date.now() + (OPENAI_MIN_INTERVAL_MS || 0);
      if (throttleMs) await new Promise(res => setTimeout(res, throttleMs));

      return j?.choices?.[0]?.message?.content || '';
    } catch (e) {
      const status = e && e.status;
      const last = (attempt === retries);

      // adaptive wait (respect Retry-After on 429; longer waits for 5xx)
      let wait = delay;
      if (status === 429) {
        wait = (e.retryAfter ? e.retryAfter * 1000 : delay) + Math.round(Math.random()*400);
      } else if (status === 502 || status === 503 || status === 504) {
        wait = delay + Math.round(Math.random()*600);
      } else {
        wait = 800 + Math.round(Math.random()*400);
      }

      if (typeof onRetry === 'function') {
        try { onRetry(status || 0, wait, attempt); } catch(_) {}
      }

      if (last) throw e;
      // push the global gate forward too (keeps bursts tamed after errors)
      __OPENAI_NEXT_OK_TS = Date.now() + wait + (OPENAI_MIN_INTERVAL_MS || 0);
      await new Promise(res => setTimeout(res, wait));
      delay = Math.min(Math.round(delay * 1.8), 20000);
    }
  }
}



// Collect visible cached full texts and map to a consistent corpus
function collectVisibleForReader() {
  // Your project already has this helper; keep this shim name for compatibility
  return collectVisibleFulltextCorpus(); // expects [{idx,title,authors,year,venue,doi,text}, ...]
}

// Turn corpus into printable reference strings with stable [n] keys
function buildReferenceList(corpus) {
  return corpus.map((d, k) => {
    const doiUrl = d.doi ? `https://doi.org/${d.doi}` : '';
    const bits = [];
    if (d.authors) bits.push(d.authors);
    if (d.year)    bits.push(`(${d.year})`);
    if (d.title)   bits.push(d.title);
    if (d.venue)   bits.push(d.venue);
    if (doiUrl)    bits.push(doiUrl);
    return { key: k + 1, text: bits.join('. ') };
  });
}

// Stage-1 prompt: one short paragraph per paper with inline [n]
function buildPerPaperPrompt(refKey, d) {
  const header =
`Write one concise paragraph summarising the following paper.
Rules:
- Use exactly the inline citation key [${refKey}] in the paragraph.
- Academic tone; 5–8 sentences. No heading.`;

  const body =
`[${refKey}] ${d.title || 'Untitled'}
Authors: ${d.authors || 'Unknown'}
Year/Venue: ${d.year || ''} ${d.venue || ''}
DOI: ${d.doi ? 'https://doi.org/' + d.doi : 'n/a'}

Full text (truncated if long):
${String(d.text || '').slice(0, 18000)}`;

  return [
    { role: 'system', content: header },
    { role: 'user',   content: body }
  ];
}

// Stage-2 prompt: merge a small batch of paragraphs into a SECTION
function buildSectionMergePrompt(paragraphs, approxWords) {
  return [
    {
      role: 'system',
      content:
`You are a scholarly synthesis engine.
Combine the paragraphs below into a cohesive SECTION of a literature review.
Rules:
- KEEP all bracketed inline citations [n] exactly as given. They refer to the numbered references list.
- Do not invent or renumber citations.
- Academic tone; no headings; ~${approxWords} words.`
    },
    { role: 'user', content: paragraphs.join('\n\n') }
  ];
}

// Stage-3 prompt: merge all sections into the final review
function buildFinalMergePrompt(sections, totalRefs, targetWords) {
  return [
    {
      role: 'system',
      content:
`You merge SECTIONS into a single, flowing literature review of ~${targetWords} words.
Rules:
- KEEP inline citations [n] exactly as they appear (do not renumber).
- Ensure every paper from [1]..[${totalRefs}] is cited at least once; if a few are missing, add a short sentence to include them.
- Write for an expert reader; crisp academic tone; introduce themes; discuss methods; identify gaps.
- No headings; just paragraphs.`
    },
    { role: 'user', content: sections.join('\n\n') }
  ];
}

// Small helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));


// ---------- Reader (full-text) main ----------
async function runReaderFulltext() {
  if (!OPENAI_API_KEY) { openApiKeyModal(); return; }

  // 0) Collect visible, cached full texts
  const docs = collectVisibleForReader() || [];
  if (!docs.length) { openSynthPanel('No cached full texts visible.'); return; }

  // Assign stable [n] across the entire run
  for (let i = 0; i < docs.length; i++) docs[i].ref = i + 1;

  // Open the panel once
  openSynthPanel(`Preparing (${docs.length} full texts)…`);

  // 1) Stage-1: one paragraph per paper
  const perPaper = [];
  const CALL_DELAY_MS = 180;       // gentle pacing; avoid 429s
  const MAX_TOKENS_PAPER = 700;    // tune if you like

  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    setSynthProgressHtml(`<div>Analysing paper ${i + 1}/${docs.length} [${d.ref}]…</div>`);
    const msg = buildPerPaperPrompt(d.ref, d);
    const para = await openaiChatDirect(msg, { temperature: 0.2, max_tokens: MAX_TOKENS_PAPER });
    perPaper.push((para || '').trim());
    await sleep(CALL_DELAY_MS);
  }

  // 2) Stage-2: merge into sections in batches
  const REFS_PER_SECTION = 12;     // ~12 paras per section
  const SECT_WORDS       = 1200;   // ~ section target
  const sections = [];
  for (let off = 0; off < perPaper.length; off += REFS_PER_SECTION) {
    const part = perPaper.slice(off, off + REFS_PER_SECTION);
    setSynthProgressHtml(`<div>Merging section ${sections.length + 1}…</div>`);
    const msg = buildSectionMergePrompt(part, SECT_WORDS);
    const sect = await openaiChatDirect(msg, { temperature: 0.25, max_tokens: 1400 });
    sections.push((sect || '').trim());
    await sleep(80);
  }

  // 3) Stage-3: final merge
  setSynthProgressHtml('<div>Assembling final review…</div>');
  const TARGET_WORDS = Math.min(5000, 3500 + Math.floor(docs.length * 6)); // rough scaling
  const finalMsg = buildFinalMergePrompt(sections, docs.length, TARGET_WORDS);
  const finalReview = await openaiChatDirect(finalMsg, { temperature: 0.25, max_tokens: 7000 });
  const finalText = (finalReview || '').trim();

  // 4) References
  const refs = buildReferenceList(docs);                 // [{key,text},...]
  const refLines = refs.map(r => `[${r.key}] ${r.text}`); // array of strings

  // 5) Single write to the panel + enable download
  const out =
`Literature Review
=================

${finalText}

References
----------

${refLines.join('\n')}`;

  setSynthProgressHtml('');                 // clear progress
  setSynthBodyText(out, 'literature_review.md');

  // --- Add clickable AI footprint for Reader (full-text) ---
try {
  // "docs" is the list you built at the top of runReaderFulltext()
  addAIFootprintFromItems('reader', docs, out, 'Reader (full-text)');
  redraw();
} catch (e) {
  console.warn('Footprint (reader) failed:', e);
}
  // itemsForRun = list you collected at the start, else recompute:
const itemsForRun = (typeof collectVisibleForSynthesis === 'function')
  ? collectVisibleForSynthesis(Infinity)
  : [];

  enableSynthDownload('literature_review.txt', out);
  // --- Add clickable AI footprint for Chronological Review ---

}

// Short label to ground the model during merge (saves tokens)
function shortRef(it) {
  const au = (it.authors && it.authors[0]) ? it.authors[0] : 'Anon';
  const yr = it.year || '';
  let t = String(it.title || '').trim();
  if (t.length > 60) t = t.slice(0, 57) + '…';
  return `${au} ${yr}: ${t}`;
}

// Robust JSON extractor for tiny payloads like {"label": "..."}
function extractJson(raw) {
  const t = String(raw || '').trim();
  // 1) direct JSON
  try { return JSON.parse(t); } catch (_) {}
  // 2) fenced ```json ... ```
  const fence = t.match(/```json([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) {} }
  // 3) single JSON object somewhere in text
  const block = t.match(/\{[\s\S]*\}/);
  if (block) { try { return JSON.parse(block[0]); } catch (_) {} }
  // 4) last-ditch: just the label field
  const m = t.match(/"label"\s*:\s*"([^"]+)"/i);
  if (m) return { label: m[1] };
  return null;
}

async function runLabelClustersAI() {
  if (!OPENAI_API_KEY) { openApiKeyModal(); return; }

  // Ensure we have clusters
  if (!clusterOf || clusterOf.length !== nodes.length) computeDomainClusters();

  // Build cluster -> node index list
const groups = new Map();
const nNow = Array.isArray(nodes) ? nodes.length : 0;
for (let i = 0; i < nNow; i++) {
  const cid = (clusterOf && Number.isFinite(+clusterOf[i])) ? (+clusterOf[i]) : -1;
  if (cid < 0) continue;
  let arr = groups.get(cid);
  if (!arr) groups.set(cid, arr = []);
  arr.push(i);
}

// Primary source for sizes
 // Primary source
 let all = [...groups.entries()];

 // Fallback: if groups is empty (clusterOf not ready for these nodes yet),
 // derive from the hydrated sidebar snapshot so we don't bail early.
 if (!all.length && dimsIndex?.clusters?.size) {
   all = [...dimsIndex.clusters.values()]
           .map(rec => [rec.cid, Array.from(rec.nodes || [])])
           .map(([cid, arr], k) => [Number.isFinite(+cid) ? +cid : k, arr]);
 }

 if (!all.length) {
   msg = 'No clusters found to label.';
   updateInfo(); redraw(); return;
 }

 showLoading('Labelling clusters…', 0.05);

 const updated = [];
 for (let k = 0; k < all.length; k++) {
   const [cid, arrAll] = all[k];

   // Prefer visible nodes if there are any; else use all in the cluster
   const arrVis = arrAll.filter(i => !visibleMask.length || visibleMask[i]);
   const use = arrVis.length ? arrVis : arrAll;

   // Build sample of titles + abstracts
   const sample = [];
   for (let j = 0; j < use.length && sample.length < LABEL_ABS_PER_CLUSTER; j++) {
     const i = use[j];
     const item = itemsData[i] || {};
     const w = item.openalex || {};
     const abs = String(item.openalex_abstract || getAbstract(w) || '').trim();
     const title = w.display_name || w.title || item.title || 'Untitled';
     if (!abs) { sample.push({ title, abstract: title.slice(0, 180) }); continue; }
     sample.push({ title, abstract: abs.slice(0, LABEL_ABS_CHARS) });
   }
   // Even a 1-paper cluster will still yield a title-only sample

   setLoadingProgress(
     0.05 + 0.9 * (k / all.length),
     `Labelling cluster ${k+1}/${all.length} (${sample.length} abstracts)`
   );

   try {
     const raw = await openaiChatDirect(
       [{ role: 'system', content: 'You are an expert at naming research clusters succinctly.' },
        { role: 'user', content: [
            'Given paper titles and abstracts from ONE research cluster, return a 3–4 word, specific, human-friendly label that best describes the shared topic.',
            'Avoid punctuation; use Title Case; no quotes.',
            'Return JSON ONLY in the form: {"label":"<3-4 word title>"}',
            JSON.stringify(sample)
          ].join('\n')
        }],
       200
     );

     const j = extractJson(raw);
     let label = '';
     if (j && typeof j.label === 'string') label = j.label.trim();
     if (!label) label = (raw || '').trim().split('\n')[0].slice(0, 60);

     if (label) {
       clusterLabels[cid] = label;   // overwrite previous (default/TF-IDF/old)
       updated.push({ cid, label });
     }
   } catch (err) {
     console.warn('Label cluster error', err);
   }
 

    if (!sample.length) continue; // nothing to ground—skip

    const sys = 'You are an expert at naming research clusters succinctly.';
    const user = [
      'Given paper titles and abstracts from ONE research cluster, return a 3–4 word, specific, human-friendly label that best describes the shared topic.',
      'Avoid punctuation; use Title Case; no quotes.',
      'Return JSON ONLY in the form: {"label":"<3-4 word title>"}',
      JSON.stringify(sample)
    ].join('\n');

    try {
      const raw = await openaiChatDirect(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        200 // tiny output budget; we just want a short JSON
      );

      const j = extractJson(raw);
      let label = '';
      if (j && typeof j.label === 'string') label = j.label.trim();
      if (!label) label = (raw || '').trim().split('\n')[0].slice(0, 60);

      if (label) {
        clusterLabels[cid] = label;   // ← overwrite existing label
        updated.push({ cid, label });
      }
    } catch (err) {
      // continue to next cluster
      console.warn('Label cluster error', err);
    }
  }

  hideLoading();

  if (updated.length) {
    // Refresh Dimensions → Clusters so names match the new labels
    buildDimensionsIndex();
    renderDimensionsUI();
    msg = `AI labels updated for ${updated.length} cluster(s).`;
  } else {
    msg = 'No cluster labels were updated.';
  }

  const finalReaderText = outEl?.innerText || finalMarkdownString || '';
addAIFootprintFromItems('reader', _footprintItems, finalReaderText, 'Reader extract');
  updateInfo(); redraw();
}
function pointerOverUI() {
  const evt = window.event;
  if (!evt || !evt.target) return false;
  let el = evt.target;
  while (el) {
    if (
      (topBar && el === topBar.elt) ||
      (lensBar && el === lensBar.elt) ||
      (dimSidebar && el === dimSidebar.elt) ||
      (infoPanel && infoPanel.div && el === infoPanel.div.elt) ||
      (synthPanel && el === synthPanel.elt)
    ) return true;
    el = el.parentElement;
  }
  return false;
}

function saveProject() {
  try {
    const obj = serializeState();
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    downloadJSON(obj, `domain-map-${stamp}.json`);
    msg = 'Project saved.';
  } catch (e) {
    console.error(e);
    msg = 'Save failed.';
  }
  updateInfo(); redraw();
}

function serializeState() {
  // compact node positions (everything else is rebuilt from itemsData)
  const nodePos = nodes.map(n => ({ x: n.x, y: n.y, r: n.r || 3 }));

// dimensions: serialise Sets as arrays (WITH AI fields if present)
const dims = (dimTools || []).map(d => {
  if (!d) return null;
  return {
    type: d.type, key: d.key, label: d.label,
    cid: (d.cid != null ? d.cid : null),
    power: d.power|0, x: d.x, y: d.y,
    color: d.color || null,
    nodes: Array.from(d.nodes || []),
    ...(d.type === 'ai' && {
      aiSig:       d.aiSig || d.aiSignature || null,
      aiTitle:     d.aiTitle || d.label || null,
      aiContent:   d.aiContent || '',
      aiCreatedAt: d.aiCreatedAt || null,
      summaryRef:  d.summaryRef || null
    })
  };
});

  // cluster data
  const cl = {
    clusterOf: (clusterOf && clusterOf.length === nodes.length) ? Array.from(clusterOf) : null,
    labels: Array.isArray(clusterLabels) ? Array.from(clusterLabels) : null,
    colors: Array.isArray(clusterColors) ? clusterColors.map(c => Array.from(c)) : null
  };

  // filters, lenses, camera
  const filt = { degThreshold, yearLo, yearHi };
  const camState = { x: cam.x, y: cam.y, scale: cam.scale };

  // --- NEW: AI footprints (strip volatile fields like _markerScreen) ---
  const aiDocs = Array.isArray(aiFootprints) ? aiFootprints.map(f => ({
    type: f.type || 'ai',
    title: String(f.title || ''),
    nodeIds: Array.isArray(f.nodeIds) ? f.nodeIds.slice() : [],
    x: Number.isFinite(f.x) ? f.x : null,
    y: Number.isFinite(f.y) ? f.y : null,
    content: String(f.content || ''),
    createdAt: Number.isFinite(+f.createdAt) ? +f.createdAt : null,
    sig: f.sig || null
  })) : [];

  // --- Seed metadata for quick reuse later (optional convenience) ---
const seeds = [];
for (let i = 0; i < itemsData.length; i++) {
  const it = itemsData[i];
  if (it && it.isSeed) {
    seeds.push({
      index: i,
      oa: (it.openalex && it.openalex.id) || null,
      doi: (it.openalex && it.openalex.doi) || it.doi || null,
      title: (it.openalex && (it.openalex.display_name || it.openalex.title)) || it.label || ''
    });
  }
}


const obj = {
  meta: {
    format: 'domain-viz-save-v1',
    exported_at: new Date().toISOString(),
    seeds                           // ← ADD
  },
  items: itemsData,
  edges: edges,
  nodePositions: nodePos,
  dimensions: dims,
  clusters: cl,
  lenses: lenses,
  filters: filt,
  camera: camState,
  aiFootprints: aiDocs
};

  return obj;
}


function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'project.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}
async function handleProjectFileSelected(p5file) {
  const native = p5file?.file || p5file;
  if (!native) { msg = 'Could not access the file.'; updateInfo(); redraw(); return; }

  // NEW: show a loading overlay immediately
  showLoading('Reading project…', 0.01);

  const reader = new FileReader();

  // NEW: live progress while reading the file
  reader.onprogress = (e) => {
    if (e && e.lengthComputable) {
      const p = Math.max(0, Math.min(1, e.loaded / e.total));
      setLoadingProgress(0.01 + p * 0.19, `Reading file… ${Math.round(p * 100)}%`);
    } else {
      setLoadingProgress(0.15, 'Reading file…');
    }
  };

  reader.onerror = () => {
    hideLoading();
    msg = 'Failed to read file.';
    updateInfo(); redraw();
  };

  reader.onload = async () => {
    try {
      setLoadingProgress(0.22, 'Parsing JSON…');
      const text = String(reader.result || '');
      const obj = JSON.parse(text);

      await nextTick();
      if (obj?.meta?.format === 'domain-viz-save-v1') {
        setLoadingProgress(0.26, 'Restoring project…');
        await restoreProjectState(obj);   // progress continues inside
      } else if (Array.isArray(obj?.nodes) && Array.isArray(obj?.edges)) {
  // NEW: viewer-manifest path
  setLoadingProgress(0.26, 'Importing viewer dataset…');

  await restoreFromViewerIndex(obj);
      
      
      } else {
        setLoadingProgress(0.26, 'Importing dataset…');
        await buildGraphFromPayloadAsync(obj); // already reports 0.68→1.00
      }
      setLoadingProgress(1.0, 'Done');
      msg = 'Project loaded.';
    } catch (e) {
      console.error(e);
      msg = 'Invalid JSON.';
    } finally {
      hideLoading();
      updateInfo(); redraw();
    }
  };

  reader.readAsText(native, 'utf-8');
}


async function restoreProjectState(save) {
  // 1) Put base data back
  setLoadingProgress(0.28, 'Preparing data…');
  itemsData = Array.isArray(save.items) ? save.items : [];
  const es = Array.isArray(save.edges) ? save.edges : buildEdgesFromItems(itemsData);

  // 2) Rebuild nodes from items (so derived fields are present)
    setLoadingProgress(0.30, 'Rebuilding graph…');
  const payload = { items: itemsData, edges: es };
  await buildGraphFromPayloadAsync(payload);

  // 3) Apply saved positions (if any)
  setLoadingProgress(0.90, 'Applying saved positions…');
  const pos = Array.isArray(save.nodePositions) ? save.nodePositions : null;
  if (pos && pos.length === nodes.length) {
    for (let i = 0; i < nodes.length; i++) {
      const p = pos[i] || {};
      if (Number.isFinite(p.x)) nodes[i].x = p.x;
      if (Number.isFinite(p.y)) nodes[i].y = p.y;
      if (Number.isFinite(p.r)) nodes[i].r = p.r;
    }
  }

  // 4) Restore clusters (if provided)

   setLoadingProgress(0.92, 'Restoring clusters…');
  if (save.clusters && Array.isArray(save.clusters.clusterOf) &&
      save.clusters.clusterOf.length === nodes.length) {
    clusterOf = Array.from(save.clusters.clusterOf);
    clusterCount = Math.max(...clusterOf) + 1;
    clusterLabels = Array.isArray(save.clusters.labels) ? Array.from(save.clusters.labels) : clusterLabels;
if (Array.isArray(save.clusters.colors) && save.clusters.colors.length === clusterCount) {
  clusterColors = save.clusters.colors.map(c => Array.from(c));
} else {
  clusterColors = makeClusterColors(clusterCount);
}

  } else {
    // compute if missing
    computeDomainClusters();
  }

  // 5) Restore dimensions tools
  setLoadingProgress(0.94, 'Restoring tools…');
  dimTools = [];
  dimByKey.clear();
  if (Array.isArray(save.dimensions)) {
    for (const d of save.dimensions) {
      if (!d) continue;
      const tool = {
        type: d.type, key: d.key, label: d.label,
        cid: (d.cid != null ? d.cid : undefined),
        //power: Number(d.power || 0),
        power: DEFAULT_DIM_POWER, 
        x: Number(d.x || 0), y: Number(d.y || 0),
        color: d.color || (DIM_COLORS[d.type] || [220,220,220]),
        nodes: new Set(Array.isArray(d.nodes) ? d.nodes : [])
      };
      const idx = dimTools.push(tool) - 1;
      dimByKey.set(tool.key, idx);
    }
  }
dimMembershipDirty = true;
  selectedDim = -1; dimHover = -1; dimDrag = { active:false, idx:-1, dx:0, dy:0, sx:0, sy:0 };
_syncAIDimsWithFootprints()
  // 6) Restore lenses and filters (if present)
setLoadingProgress(0.96, 'Restoring view…');
if (save.lenses) {
  // merge but clamp AI to explicit boolean only
  lenses = { ...lenses, ...save.lenses };
  lenses.aiDocs = (typeof save.lenses.aiDocs === 'boolean') ? !!save.lenses.aiDocs : false;
} else {
  // no lenses in save => AI is OFF
  lenses.aiDocs = false;
}

initDegreeFilterUI();
applyDegreeFilter(degThreshold);
initYearFilterUI();
recomputeVisibility();

  // 7) Restore AI footprints (if provided)
setLoadingProgress(0.97, 'Restoring AI notes…');
window.aiFootprints = [];
if (Array.isArray(save.aiFootprints)) {
  for (const f of save.aiFootprints) {
    if (!f) continue;

    // sanitize node ids
    const idxs = Array.isArray(f.nodeIds)
      ? f.nodeIds.filter(i => Number.isFinite(i) && i >= 0 && i < nodes.length)
      : [];

    // use saved world position; if missing, fall back to centroid of current node positions
    let fx = Number(f.x), fy = Number(f.y);
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
      if (idxs.length) {
        let sx = 0, sy = 0, c = 0;
        for (const i of idxs) { const p = nodes[i]; if (!p) continue; sx += p.x; sy += p.y; c++; }
        if (c) { fx = sx / c; fy = sy / c; }
      }
    }

    window.aiFootprints.push({
      type: f.type || 'ai',
      title: String(f.title || ''),
      nodeIds: idxs,
      x: Number.isFinite(fx) ? fx : 0,
      y: Number.isFinite(fy) ? fy : 0,
      content: String(f.content || ''),
      createdAt: Number.isFinite(+f.createdAt) ? +f.createdAt : Date.now(),
      sig: f.sig || null
    });
  }
}
_syncAIDimsWithFootprints()
recomputeVisibility();

// keep local reference in sync if you use a separate var
if (typeof aiFootprints !== 'undefined') aiFootprints = window.aiFootprints;

  // 8) Camera
  if (save.camera) {
    const c = save.camera;
    if (Number.isFinite(c.x)) cam.x = c.x;
    if (Number.isFinite(c.y)) cam.y = c.y;
    if (Number.isFinite(c.scale)) cam.scale = c.scale;
  }

  // 8) Refresh dimensions sidebar (names may change with cluster labels)
  setLoadingProgress(0.99, 'Finalising…');
  buildDimensionsIndex();
  renderDimensionsUI();
  layoutRunning = false;
noLoop();
vx = new Array(nodes.length).fill(0);
vy = new Array(nodes.length).fill(0);

  msg = 'Project loaded.';
   adjustWorldToContent(80);
  if (!save.camera) fitWorldInView(60);  // show the whole world immediately
  updateInfo(); redraw();

}


function fitWorldInView(pad = 40) {
  // choose a scale that fits the whole world in the screen with padding
  const sx = (width  - pad * 2) / world.w;
  const sy = (height - pad * 2) / world.h;
  cam.scale = Math.max(0.05, Math.min(sx, sy));
  const sxp = width  * 0.5;
  const syp = height * 0.5;
  cam.x = sxp - (world.w * 0.5) * cam.scale;
  cam.y = syp - (world.h * 0.5) * cam.scale;
}
function handleFtFileSelected(p5file) {
  const native = p5file?.file || p5file;
  if (!native || pendingFTIndex < 0) return;
  const i = pendingFTIndex;
  pendingFTIndex = -1;

  // Read as ArrayBuffer and extract via PDF.js
  showLoading('Reading local PDF…', 0.05);
  const reader = new FileReader();
  reader.onerror = () => { hideLoading(); msg = 'Failed to read local PDF.'; updateInfo(); redraw(); };
  reader.onload = async () => {
    try {
      const buf = reader.result;
      const text = await extractTextFromPdfBuffer(buf);
      if (!text || text.length < 80) throw new Error('No text found (scanned PDF?)');
      const item = itemsData[i] || (itemsData[i] = {});
      item.fulltext = String(text);
      item.fulltext_source = '(local file)';
      item.fulltext_extracted_at = new Date().toISOString();
      if (nodes[i]) nodes[i].hasFullText = true;
      msg = 'Full text extracted from local PDF.';
      if (infoPanel && infoPanel.index === i) infoPanel.setItemIndex(i);
    } catch (err) {
      console.warn(err);
      msg = 'Local PDF extraction failed: ' + (err.message || String(err));
    } finally {
      hideLoading();
      updateInfo(); redraw();
    }
  };
  reader.readAsArrayBuffer(native);
}
function promptLocalPdfForIndex(i) {
  pendingFTIndex = i;
  if (ftFileInput) {
    ftFileInput.elt.value = '';
    ftFileInput.elt.accept = '.pdf,application/pdf';
    ftFileInput.elt.click();
  }
}

function hasFulltextCandidate(w, doiUrl = '') {
  const best = w?.best_oa_location || {};
  const prim = w?.primary_location || {};
  const cand = [
    // Prefer HTML landings, then PDFs, then DOI
    best.landing_page_url, prim.landing_page_url,
    best.url_for_pdf, best.pdf_url, prim.pdf_url,
    w?.host_venue?.url, prim?.source?.url,
    doiUrl
  ].filter(u => typeof u === 'string' && u.startsWith('http'));
  return cand.length > 0;
}


// Config: change if you want a short pause between fetches
const AUTOCACHE_SLEEP_MS = 250; // small delay to keep UI responsive
const MAX_FT_ATTEMPTS_PER_SESSION = 2; // stop hammering stubborn targets

function _shouldAttemptFT(i) {
  const it = itemsData?.[i] || (itemsData[i] = {});
  it._ftAttemptCount = (it._ftAttemptCount || 0);
  if (it._ftAttemptCount >= MAX_FT_ATTEMPTS_PER_SESSION) return false;
  it._ftAttemptCount++;
  return true;
}






// Optional global cap (0 = no cap)
let AUTOCACHE_PER_RUN_CAP = 0;  // set to e.g. 500 if you want a ceiling; keep 0 for unlimited

async function autoCacheVisible({ onlyOnScreen = true } = {}) {
  // Build the target list ONCE, then iterate without mutating it.
  const targets = [];
  for (let i = 0; i < nodes.length; i++) {
    if (!visibleMask?.[i]) continue;
    if (onlyOnScreen && !inView?.[i]) continue;           // on-screen only
    if (!nodes[i] || nodes[i].hasFullText) continue;
    if (!_shouldAttemptFT(i)) continue;                    // per-session attempt budget
    targets.push(i);
  }

  if (!targets.length) {
    msg = 'Auto-cache: nothing to do (all visible already cached or none visible).';
    updateInfo(); redraw();
    return;
  }

  // Optional cap (0 = unlimited)
  const maxN = Math.max(0, AUTOCACHE_PER_RUN_CAP|0);
  const batch = (maxN > 0 && targets.length > maxN) ? targets.slice(0, maxN) : targets;

  showLoading(`Auto-caching ${batch.length} papers…`, 0.02);

  let done = 0, ok = 0, fail = 0;
  for (const i of batch) {
    const success = await extractFullTextForIndex(i, null, { silent: true });
    if (success) ok++; else fail++;
    done++;

    const frac = done / batch.length;
    setLoadingProgress(0.02 + 0.96 * frac, `Auto-caching… ${done}/${batch.length}`);

    await new Promise(r => setTimeout(r, AUTOCACHE_SLEEP_MS)); // keep UI responsive
  }

  hideLoading();
  msg = `Auto-cache finished: ${ok} cached, ${fail} failed.`;
  updateInfo();
  redraw();
}




// Build a clean list of OA candidates (PDF first, then landing pages)
// Build a clean list of full-text candidates (HTML landings first, then PDFs, then DOI)
function fulltextCandidatesFromWork(w, doiUrl = '') {
  const best = w?.best_oa_location || {};
  const prim = w?.primary_location || {};

  const landings = [
    best.landing_page_url,
    prim.landing_page_url,
    w?.host_venue?.url,
    prim?.source?.url,
  ];

  const directPdf = [
    best.url_for_pdf, best.pdf_url, prim.pdf_url
  ];

  const tail = [doiUrl].filter(Boolean);

  const seen = new Set();
  return [...landings, ...directPdf, ...tail]
    .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
    .filter(u => (seen.has(u.toLowerCase()) ? false : seen.add(u.toLowerCase())));
}



// Optional: ask Unpaywall for more OA links (often better than publisher)
async function fetchUnpaywall(doi) {
  if (!UNPAYWALL_EMAIL || !doi) return null;
  const u = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`;
  try {
    const r = await fetchWithTimeout(viaProxy(u), {}, 15000);   // go via proxy to avoid CORS
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function mergeUnpaywallCandidates(json, current) {
  if (!json) return current;
  const add = [];
  const best = json.best_oa_location || {};
  const locs = Array.isArray(json.oa_locations) ? json.oa_locations : [];
  const pushIf = (u) => { if (u && /^https?:\/\//i.test(u)) add.push(u); };

  pushIf(best.url_for_pdf || best.pdf_url || best.hosted_content);
  pushIf(best.url);

  for (const L of locs) {
    pushIf(L.url_for_pdf || L.pdf_url || L.hosted_content);
    pushIf(L.url);
  }

  // de-dup, keep order: PDFs first, then landings, then DOI
  const seen = new Set();
  const all = [...add, ...current].filter(u => {
    const k = u.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return all;
}

// ---------- Reader (full-text) helpers ----------
const READER_PER_PAPER_WORDS   = 140;   // ~140 words per paper in stage-1
const READER_TARGET_WORDS      = 5000;  // final review target length (approx)
const READER_MAX_PAPERS        = 250;   // hard cap to avoid huge runs
const READER_PAPERS_PER_CHUNK  = 30;    // how many stage-1 paragraphs to merge per chunk

function collectVisibleFulltextCorpus() {
  const out = [];
  if (!Array.isArray(nodes) || !Array.isArray(itemsData)) return out;
  for (let i = 0; i < nodes.length; i++) {
    if (!visibleMask?.[i]) continue;                   // only what’s on screen
    const it = itemsData[i];
    if (!it || typeof it.fulltext !== 'string' || !it.fulltext.trim()) continue;  // cached full text only
    const w = it.openalex || {};
    const title  = w.display_name || w.title || it.title || 'Untitled';
// Use the canonical helper – this fixes “Anon” by handling compact OpenAlex records.
const authorsArr = (typeof getAuthors === 'function') ? getAuthors(w) : [];
const authors    = Array.isArray(authorsArr) ? authorsArr.join(', ') : String(authorsArr || '');
const year   = w.publication_year || '';
// Add venue fallbacks (covers compact OA + primary_location)
const venue  = w.host_venue?.display_name
           || w.primary_location?.source?.display_name
           || w.venue_name
           || '';
// Normalise DOI
const doiRaw   = (w.doi || '').toString();
const doiClean = (typeof cleanDOI === 'function')
  ? cleanDOI(doiRaw)
  : doiRaw.replace(/^https?:\/\/doi\.org\//,'');

    out.push({
      idx: i,
      title, authors, year, venue,
      doi: doiClean,
      text: it.fulltext
    });
  }
  return out;
}

// Small convenience
function tokensApproxFromChars(chars) { return Math.ceil(chars / 4); }

// ---------- Reader (full-text) main ----------
// ===============================================
// DROP-IN: Full-text Reader (final, non-stalling)
// ===============================================






// --- Synthesis UI helpers (missing shims) ---
// --- Synthesis UI helpers (final-safe progress) ---
function setSynthProgressHtml(html) {
  if (!synthBody) return;
  // If we've already written the final doc, don't overwrite it.
  const hasFinal = synthBody.elt && synthBody.elt.querySelector('pre[data-final="1"]');
  if (hasFinal) return;
  setSynthHtml(html);
}




// Optional: wire the Download button to download a specific blob of content.
// If you prefer to keep your existing "Download" (which saves whatever is in the panel),
// you can remove calls to enableSynthDownload(...). If you keep them, include this:
function enableSynthDownload(filename, content) {
  const btn = document.getElementById('synDownload');
  if (!btn) return;
  btn.onclick = () => {
    const blob = new Blob([String(content ?? '')], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename || 'synthesis.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
}

// ===============================================
// AI: Open Question (answer from visible docs)
// ===============================================
// ===============================================
// AI: Open Question (scalable, intent-aware)
// ===============================================
async function runOpenQuestion() {
  if (typeof openSynthPanel === 'function') openSynthPanel('Open Question');

  const corpusAll = collectVisibleCorpusChrono();
  const visibleCount = corpusAll.length|0;
  if (!visibleCount) {
    setSynthHtml(`<div style="padding:8px">No visible documents. Make some visible, then retry.</div>`); return;
  }

  const html = `
    <div style="padding:8px;display:flex;flex-direction:column;gap:8px">
      <div><b>Ask a research question</b> — screening titles/abstracts first, then deep synthesis from relevant items only. Visible docs: <b>${visibleCount}</b>.</div>
      <textarea id="oq_input" rows="5" style="width:100%;font:14px/1.3 sans-serif;padding:6px" placeholder="e.g. Systematic review of digital fabrication/3D printing approaches with fungal mycelium (materials, processes, structural performance)."></textarea>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label style="font-size:12px;opacity:.8">Mode:</label>
        <select id="oq_mode" style="font-size:12px;padding:4px 6px">
          <option value="auto" selected>Auto (match the question)</option>
          <option value="systematic">Systematic review (~6000 words)</option>
          <option value="thematic">Thematic mapping</option>
          <option value="methods">Methods comparison</option>
          <option value="data">Data compilation / table</option>
          <option value="general">General answer</option>
        </select>

        <label style="font-size:12px;opacity:.8;margin-left:10px">Screen cap:</label>
        <input id="oq_cap" type="number" min="100" max="${Math.max(visibleCount,OQ_SCREEN_CAP)}" value="${Math.min(visibleCount,OQ_SCREEN_CAP)}" style="width:90px;font-size:12px;padding:4px 6px">
        <span style="opacity:.6;font-size:12px">(how many to pass into screening)</span>
      </div>

      <div style="display:flex;gap:8px;align-items:center">
        <button id="oq_run" class="btn">Run staged review</button>
        <span id="oq_status" style="opacity:.7"></span>
      </div>

      <div id="oq_prog" style="opacity:.8;font-size:12px;margin-top:4px"></div>
      <pre id="oq_draft" style="white-space:pre-wrap;word-wrap:break-word;margin:6px 0 12px 0;opacity:.95"></pre>
    </div>`;
  setSynthHtml(html);

  const btn    = document.getElementById('oq_run');
  const input  = document.getElementById('oq_input');
  const modeEl = document.getElementById('oq_mode');
  const capEl  = document.getElementById('oq_cap');
  const status = document.getElementById('oq_status');
  const progEl = document.getElementById('oq_prog');
  const draftEl= document.getElementById('oq_draft');
  const appendDraft = (t) => { if (draftEl) { draftEl.textContent += String(t||'')+'\n\n'; draftEl.scrollTop = draftEl.scrollHeight; } };
  const show = (h) => { if (progEl) progEl.innerHTML = h; };

  btn.onclick = async () => {
    const q = String(input.value || '').trim();
    if (!q) { status.textContent = 'Please enter a question.'; return; }
    const intent = detectOQIntent(q, (modeEl?.value || 'auto'));

    // ------------------ Stage 1: relevance screening ------------------
    status.textContent = 'Screening titles/abstracts…';

    // lexical prefilter → fewer calls, less 429 risk
    const ranked = rankDocsForScreen(corpusAll, q);
    const cap = clamp(Number(capEl?.value || OQ_SCREEN_CAP), 100, Math.max(visibleCount, OQ_SCREEN_CAP));
    const pool = ranked.slice(0, Math.min(cap, ranked.length));

    const CH = OQ_SCREEN_CHUNK;
    const relevantKeySet = new Set();

    for (let off = 0; off < pool.length; off += CH) {
      const part = pool.slice(off, off + CH);
      const refs = buildChronoReferenceList(part).join('\n');
      const ex   = makeScreenExcerpts(part, OQ_SCREEN_EXCERPT);
      const msg  = buildOQScreenPrompt(q, refs, ex);

      show(`<div>Screening ${Math.min(pool.length, off+CH)}/${pool.length}…</div>`);

      let reply = '';
      try {
        reply = await openaiChatDirect(msg, {
          temperature: 0.0,
          max_tokens: OQ_SCREEN_MAX_TOKENS,
          retries: OQ_MAX_RETRIES,
          throttleMs: OQ_INTER_CALL_DELAY_MS,
          onRetry: (st, wait, k) => { show(`<div>Retry ${k+1} (screen ${off/CH+1}): ${st||'net'}, ${(wait/1000).toFixed(1)}s…</div>`); }
        });
      } catch { reply = ''; }

      const keys = parseScreenKeys(reply);
      if (keys.length) keys.forEach(k => relevantKeySet.add(k));
      else {
        // If the model gave nothing, keep the top 1/3 of this part lexically
        const fallback = part.slice(0, Math.max(4, Math.ceil(part.length/3))).map(d => d.refKey);
        fallback.forEach(k => relevantKeySet.add(k));
        appendDraft('(screen: local fallback added some items)');
      }
    }

    // build relevant docs list in the order they appeared in pool
    let relevant = pool.filter(d => relevantKeySet.has(d.refKey));
    // ensure we keep enough items, else top-up lexically
    if (relevant.length < Math.min(40, pool.length)) {
      const need = Math.min(OQ_SCREEN_KEEP_TOPN, pool.length) - relevant.length;
      for (const d of pool) {
        if (need <= 0) break;
        if (!relevantKeySet.has(d.refKey)) { relevant.push(d); relevantKeySet.add(d.refKey); }
      }
    }
    // trim to keep-topN
    relevant = relevant.slice(0, Math.min(OQ_SCREEN_KEEP_TOPN, relevant.length));

    appendDraft(`Screened: kept ${relevant.length} of ${pool.length} (visible ${visibleCount}).`);

    if (!relevant.length) {
      setSynthHtml(`<div style="padding:8px">No relevant documents found for this query.</div>`);
      return;
    }

    // ------------------ Stage 2: focused synthesis ------------------
    status.textContent = `Extracting evidence from ${relevant.length} relevant docs…`;

    const refsBlockAll = buildChronoReferenceList(relevant).join('\n');
    const chunks = [];
    const MAP_CH = OQ_CHUNK_SIZE;

    for (let off = 0; off < relevant.length; off += MAP_CH) {
      const part = relevant.slice(off, off + MAP_CH);
      const ex   = makeOQExcerpts(part, OQ_EXCERPT_CHARS);
      const msg  = buildOQChunkPrompt(q, intent, refsBlockAll, ex);

      show(`<div>Evidence ${Math.min(relevant.length, off+MAP_CH)}/${relevant.length}…</div>`);
      let out = '';
      try {
        out = await openaiChatDirect(msg, {
          temperature: 0.2,
          max_tokens: OQ_BODY_TOKENS,
          retries: OQ_MAX_RETRIES,
          throttleMs: OQ_INTER_CALL_DELAY_MS,
          onRetry: (st, wait, k) => { show(`<div>Retry ${k+1} (map ${off/MAP_CH+1}): ${st||'net'}, ${(wait/1000).toFixed(1)}s…</div>`); }
        });
      } catch { out = ''; }

      out = String(out || '').trim();
      if (!out) {
        // local fallback bullets if a batch fails completely
        out = localExtractEvidenceBullets(part, q, 2);
        if (out) appendDraft('(map: local evidence fallback used)');
      }
      if (out) { chunks.push(out); appendDraft(out); }
      await new Promise(r => setTimeout(r, 80));
    }

    if (!chunks.length) { setSynthHtml(`<div style="padding:8px">No evidence extracted.</div>`); return; }

    status.textContent = 'Composing final report…';
    const mergeMsgs = buildOQMergePrompt(q, intent, refsBlockAll, chunks);
    let finalText = '';
    try {
      finalText = await openaiChatDirect(mergeMsgs, {
        temperature: 0.2,
        max_tokens: OQ_MERGE_TOKENS,
        retries: OQ_MAX_RETRIES,
        throttleMs: OQ_INTER_CALL_DELAY_MS
      });
    } catch { finalText = chunks.join('\n\n'); }

    // ----- restrict references to ACTUALLY CITED -----
    const usedKeys = extractCitedRefKeys(finalText);
    const usedDocs = usedKeys.length
      ? usedKeys.map(k => relevant.find(d => d.refKey === k)).filter(Boolean)
      : relevant.slice(0, Math.min(80, relevant.length)); // cautious fallback

    const refsBlockFinal = buildChronoReferenceList(usedDocs).join('\n');
    const heading = `${intent.titlePrefix} — ${q}`;
    const mdOut =
`${heading}
=====================

${finalText.trim()}

References
----------
${refsBlockFinal}
`;

    // render + download
    setSynthBodyText(mdOut, 'open-question.md');

    // AI footprint connects to cited docs only
    const usedIdxs = (usedKeys.length ? usedKeys : usedDocs.map(d => d.refKey))
      .map(k => {
        const hit = relevant.find(d => d.refKey === k) || corpusAll.find(d => d.refKey === k);
        return hit ? hit.idx : -1;
      })
      .filter(i => (i|0) >= 0);

    const fpItems = idxsToFootprintItems(usedIdxs);
    addAIFootprintFromItems('open_question', fpItems, mdOut, heading);

    if (typeof redraw === 'function') redraw();
    status.textContent = 'Done.';
  };
}




// ---------- Helpers (local to Open Question) ----------
function rankDocsByQuery(corpus, query) {
  const qWords = (query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  if (!qWords.length) return [...corpus];

  const scoreDoc = (doc) => {
    const text = (doc.text || '').toLowerCase();
    let score = 0;
    for (const w of qWords) {
      // basic term frequency with small bonus for title hits
      const re = new RegExp(`\\b${escapeRegex(w)}\\b`, 'g');
      const m  = text.match(re);
      if (m) score += m.length;
      if (doc.title && new RegExp(`\\b${escapeRegex(w)}\\b`, 'i').test(doc.title)) score += 2;
    }
    // Prefer full text a bit over abstract when tied
    if (doc.source === 'fulltext') score += 0.25;
    return score;
  };

  return [...corpus].map(d => ({ d, s: scoreDoc(d) }))
                    .sort((a,b) => b.s - a.s)
                    .map(x => x.d);
}

function buildOpenQuestionMessages(question, docs) {
  // Keep excerpts modest to stay inside token limits (prioritise content density)
  const EXCERPT_CHARS = 1400; // per doc
  const refsBlock = buildChronoReferenceList(docs).join('\n');
  const excerpts  = docs.map(d => {
    const tag = `[${d.refKey}]`;
    const tx  = String(d.text || '').replace(/\s+/g, ' ').slice(0, EXCERPT_CHARS);
    return `${tag} ${tx}`;
  }).join('\n\n');

  const sys =
`You are a postdoctoral researcher writing in formal UK academic English.
Answer the user's research question using ONLY the provided excerpts.
Rules:
- Every specific claim must be supported by inline bracket citations using the provided keys [n] or [n*].
- Use multiple citations where appropriate.
- Do NOT invent references, numbers, or content not present in the excerpts.
- If evidence is insufficient, state the limitation explicitly and suggest targeted follow-up work.
- Provide a cohesive, well-structured answer (no headings).`;

  const user =
`QUESTION:
${question}

REFERENCES (for the citation keys):
${refsBlock}

EVIDENCE EXCERPTS (cite with [n] / [n*]):
${excerpts}`;

  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

function extractCitedRefKeys(text) {
  // Matches [12], [3*], [7] etc. (deduped, in encounter order)
  const out = [];
  const seen = new Set();
  const re = /\[(\d+\*?)\]/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const k = m[1];
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

function idxsToFootprintItems(idxs) {
  const items = [];
  for (const i of idxs) {
    const p = (typeof parallaxWorldPos === 'function') ? parallaxWorldPos(i) : null;
    items.push({ idx: i, x: p ? p.x : 0, y: p ? p.y : 0 });
  }
  return items;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }




// --- Reader compatibility shim ---
function collectVisibleForReader() {
  // Old name used in earlier builds; just forward to the current helper
  return collectVisibleFulltextCorpus();
}
// Build a chunk prompt: summarize a group of full-text papers, keeping [n] tags


// Merge section summaries into a single review, preserving [n] exactly
function buildReaderMergePrompt(sectionSummaries, allRefs) {
  const sys =
`You merge SECTIONS into a single flowing literature review.
Rules:
- KEEP all inline citation tags [n] exactly as they appear (do not renumber or invent new numbers).
- Ensure coverage: if any refs from [1]..[${(allRefs && allRefs.length) || 'N'}] are never cited, add a short sentence to include them.
- Academic tone; no headings; just paragraphs; clear transitions.`;

  const user = sectionSummaries.join('\n\n');

  return [
    { role: 'system', content: sys },
    { role: 'user',   content: user }
  ];
}
// Collect visible items, using full text if cached, else abstract.
// Adds {refKey:'n' or 'n*', source:'fulltext'|'abstract'}
function collectVisibleCorpusChrono() {
  const out = [];
  const n = nodes.length|0;
  for (let i = 0; i < n; i++) {
    if (visibleMask && !visibleMask[i]) continue;
    const it = itemsData?.[i]; if (!it) continue;
    const w  = it.openalex || {};

    const title   = w.display_name || w.title || it.title || 'Untitled';
    const authors = (Array.isArray(w.authorships) ? w.authorships.map(a=>a?.author?.display_name).filter(Boolean).join(', ') : '') || '';
    const year    = Number(w.publication_year) || NaN;
    const venue   = w.host_venue?.display_name || w.primary_location?.source?.display_name || '';
    const doi     = (w.doi || '').toString().replace(/^https?:\/\/doi\.org\//i,'').trim();

    // Prefer cached full text
    let text = (typeof it.fulltext === 'string' && it.fulltext.trim().length > 0) ? it.fulltext : '';
    let source = 'fulltext';
    if (!text) {
      const abs = (it.openalex_abstract || getAbstract(w) || '').toString();
      if (!abs.trim()) continue; // skip if nothing to analyze
      text = abs;
      source = 'abstract';
    }
    out.push({ idx:i, title, authors, year, venue, doi, text, source });
  }

  // Sort ascending by year, NaNs at the end
  out.sort((a,b) => {
    const ay = Number.isFinite(a.year) ? a.year : Infinity;
    const by = Number.isFinite(b.year) ? b.year : Infinity;
    return ay - by;
  });

  // Assign stable keys: n for fulltext, n* for abstract-only
  for (let k = 0; k < out.length; k++) {
    const nKey = k + 1;
    out[k].numKey = nKey;
    out[k].refKey = (out[k].source === 'abstract') ? `${nKey}*` : String(nKey);
  }
  return out;
}
function buildChronoReferenceList(corpus) {
  // Returns array of printable lines with [n] or [n*] prefix
  return corpus.map(d => {
    const doiUrl = d.doi ? `https://doi.org/${d.doi}` : '';
    const bits = [];
    if (d.authors) bits.push(d.authors);
    if (d.year)    bits.push(`(${d.year})`);
    if (d.title)   bits.push(d.title);
    if (d.venue)   bits.push(d.venue);
    if (doiUrl)    bits.push(doiUrl);
    const line = bits.join('. ').replace(/\s+/g,' ').trim();
    return `[${d.refKey}] ${line}`;
  });
}
function buildChronoPerPaperPrompt(doc) {
  const perWords = (doc.source === 'fulltext') ? 120 : 80;
  return [
    { role:'system', content:
`Summarise this paper in ${perWords} words (problem, methods, findings, contribution).
Use exactly the inline citation key [${doc.refKey}] once in your paragraph.
Academic tone; no heading.` },
    { role:'user', content:
`[${doc.refKey}] ${doc.title}
Authors: ${doc.authors || 'Unknown'}
Year/Venue: ${doc.year || ''} ${doc.venue || ''}
Text source: ${doc.source}
${doc.doi ? 'DOI: https://doi.org/' + doc.doi : 'DOI: n/a'}

Full text (or abstract if not available; truncated if long):
${String(doc.text || '').slice(0, 18000)}`
    }
  ];
}

function buildChronoSectionPrompt(paragraphs, years) {
  const lo = Number.isFinite(years.lo) ? years.lo : 'earliest';
  const hi = Number.isFinite(years.hi) ? years.hi : 'latest';
  const approxWords = Math.min(1500, Math.max(600, paragraphs.length * 120));
  return [
    { role:'system', content:
`Combine the paragraphs into a cohesive chronological SECTION (${lo}–${hi}).
Rules:
- KEEP inline citation keys [n] / [n*] exactly as given (do not renumber).
- Identify transitions or shifts if evident.
- Academic tone; no headings; ~${approxWords} words.` },
    { role:'user', content: paragraphs.join('\n\n') }
  ];
}

function buildChronoMergePrompt(sections, refKeys, targetWords = 6000) {
  return [
    { role:'system', content:
`Merge the SECTIONS into a single literature review (~${targetWords} words).
Goals:
- Present developments over time; identify and name phases (with date spans).
- KEEP inline citation keys [n] / [n*] exactly as they appear (do not renumber).
- Academic tone; flowing paragraphs; no headings (except a short "Phases of development" bullet list near the end).` },
    { role:'user', content: sections.join('\n\n') }
  ];
}
async function runChronologicalReview() {
  if (!OPENAI_API_KEY) { openApiKeyModal?.(); return; }

  const corpusAll = collectVisibleCorpusChrono();
  if (!corpusAll.length) { openSynthPanel('No visible items with text/abstract.'); return; }

  const MAX = 350;
  const corpus = corpusAll.slice(0, MAX);
  const _footprintItems = Array.isArray(corpus) ? corpus.slice() : [];

  // Open panel and lay out a progress area + a persistent final area
  openSynthPanel(`Preparing chronological review (${corpus.length} items)…`);

  setSynthHtml(`
  <div id="chronoProgress" style="opacity:.8;font-size:12px;margin-bottom:8px"></div>
  <pre id="chronoDraft" style="white-space:pre-wrap;word-wrap:break-word;margin:0 0 12px 0;opacity:.95"></pre>
  <pre id="chronoOut" data-final="1" style="white-space:pre-wrap;word-wrap:break-word;margin:0"></pre>
`);


  const progressEl = document.getElementById('chronoProgress');
  const outEl = document.getElementById('chronoOut');
  const draftEl = document.getElementById('chronoDraft');


 const showProgress = (html) => { if (progressEl) progressEl.innerHTML = html; };
const appendDraft  = (txt) => {
  if (!draftEl) return;
  draftEl.textContent += String(txt || '') + '\n\n';
  draftEl.scrollTop = draftEl.scrollHeight;
};

// Keep an in-memory accumulator so “Download” can always save what we have so far.
let accumMd = 'Chronological Review\n====================\n\n';

  // Per-paper (chronological)
  const per = [];
  const CALL_DELAY_MS = 160;
  for (let i = 0; i < corpus.length; i++) {
    const d = corpus[i];
    showProgress(`<div>Summarising ${i+1}/${corpus.length} [${d.refKey}] (${d.year || 'n.d.'})…</div>`);
    const para = await openaiChatDirect(buildChronoPerPaperPrompt(d), { temperature: 0.25, max_tokens: 700 });
    per.push((para || '').trim());
    await new Promise(r => setTimeout(r, CALL_DELAY_MS));
  }

  // Batch into sections
    // ===== 5-year windows instead of fixed-count batches =====
  // Build a map refKey -> generated per-paper paragraph
  const paraByRef = new Map();
  for (let i = 0; i < corpus.length; i++) {
    paraByRef.set(corpus[i].refKey, per[i]);
  }

  // Group docs into 5-year windows (plus n.d.)
  const windows = groupIntoYearWindows(corpus, 5);

  // For a stable heading range (used later)
  const knownYears = corpus.map(d => Number.isFinite(d.year) ? d.year : null).filter(v => v != null);
  const globalLo = knownYears.length ? Math.min(...knownYears) : null;
  const globalHi = knownYears.length ? Math.max(...knownYears) : null;

  const windowSections = [];   // [{ heading, bodyMd }]
  for (let wIdx = 0; wIdx < windows.length; wIdx++) {
    const win = windows[wIdx];
    const heading = buildChronoWindowHeading(win);
    showProgress(`<div>Merging window ${wIdx+1}/${windows.length}: ${heading}…</div>`);

    // Gather this window’s paragraphs in chronological order
    const paras = win.docs.map(d => paraByRef.get(d.refKey)).filter(Boolean);

    // Ask the model to merge this window’s paragraphs
    const sectMsg = buildChronoWindowSectionPrompt(paras, win);
    const sectTxt = await openaiChatDirect(sectMsg, { temperature: 0.25, max_tokens: 1600 });
    const sect = (sectTxt || '').trim();

    // Accumulate with an explicit Markdown heading for the window
    const sectMd = `## ${heading}\n\n${sect}`;
    windowSections.push({ heading, bodyMd: sectMd });

    // Live draft + rolling download
    appendDraft(sectMd);
    enableSynthDownload?.('chronological_review.md', accumMd + sectMd + '\n\n');
    accumMd += sectMd + '\n\n';
  }


  // Final merge
    // ===== Title + Trends Over Time =====
  showProgress('<div>Generating title…</div>');
  const titleSuffix = await generateChronoTitle(windows, corpus);
  const reviewTitle = `Chronological Review: ${titleSuffix || 'Developments Over Time'}`;

  showProgress('<div>Analysing trends over time…</div>');
  const windowsMd = windowSections.map(s => s.bodyMd).join('\n\n');
  const trendsMsg = buildChronoTrendsPrompt(
    windowsMd,
    globalLo == null ? undefined : globalLo,
    globalHi == null ? undefined : globalHi
  );
  const trendsText = String(await openaiChatDirect(trendsMsg, { temperature: 0.2, max_tokens: 1200 }) || '').trim();

  // References list
  const refLines = buildChronoReferenceList(corpus);

  // ===== Final structured markdown =====
  const md =
`# ${reviewTitle}

${globalLo && globalHi ? `_Coverage: ${globalLo}–${globalHi}_\n` : ''}

${windowSections.map(s => s.bodyMd).join('\n\n')}

## Trends Over Time
${trendsText}

## References

${refLines.join('\n')}`;

  if (outEl) outEl.textContent = md;
  if (progressEl) progressEl.innerHTML = '';

  enableSynthDownload?.('chronological_review.md', md);

  // Clickable AI footprint on the graph
  try {
    addAIFootprintFromItems('chronological', corpus, md, reviewTitle);
  } catch (_) {}


}

// Compute convex hull (Monotone chain) for [{x,y},...]
function convexHull(pts) {
  const p = pts.slice().sort((a,b)=>a.x===b.x? a.y-b.y : a.x-b.x);
  if (p.length <= 1) return p;
  const cross = (o,a,b) => (a.x-o.x)*(b.y-o.y) - (a.y-o.y)*(b.x-o.x);
  const lower = [];
  for (const pt of p) { while (lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], pt) <= 0) lower.pop(); lower.push(pt); }
  const upper = [];
  for (let i=p.length-1;i>=0;i--) { const pt=p[i]; while (upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], pt) <= 0) upper.pop(); upper.push(pt); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Smooth draw of a closed path in SCREEN space (expects [{sx,sy},...])
function drawClosedSpline(screenPts) {
  if (screenPts.length === 0) return;
  if (screenPts.length < 3) {
    // Draw a small circle or line if 1–2 points only
    if (screenPts.length === 1) {
      const p = screenPts[0]; noFill(); strokeWeight(2); ellipse(p.sx, p.sy, 28, 28);
    } else {
      const a = screenPts[0], b = screenPts[1]; noFill(); strokeWeight(2); line(a.sx, a.sy, b.sx, b.sy);
    }
    return;
  }
  // Catmull-Rom style
  beginShape();
  // loop indices to close nicely
  const n = screenPts.length;
  for (let i = -1; i <= n; i++) {
    const p = screenPts[(i + n) % n];
    curveVertex(p.sx, p.sy);
  }
  endShape(CLOSE);
}

// Choose a hull vertex for placing the marker (rightmost)
function chooseMarkerPoint(hull) {
  if (!hull || !hull.length) return null;
  let best = hull[0], bi = 0;
  for (let i=1;i<hull.length;i++) {
    const p = hull[i];
    if (p.x > best.x) { best = p; bi = i; }
  }
  return { wx: best.x, wy: best.y, index: bi };
}

// Convert node indices to world points (robust to your node structure)
function nodeIndicesToWorldPoints(idxs) {
  const out = [];
  for (const i of idxs) {
    const p = typeof parallaxWorldPos === 'function' ? parallaxWorldPos(i) : nodes?.[i];
    if (p && isFinite(p.x) && isFinite(p.y)) out.push({ x: p.x, y: p.y });
  }
  return out;
}

// Add a footprint from a list of item objects returned by your collectors
// ---- AI footprints (single, strict dedupe) ----
function addAIFootprintFromItems(type, items, textContent, title = 'AI output') {
  if (!Array.isArray(items) || items.length === 0) return;

  // Compute center of the items (where the marker will be placed)
  let cx = 0, cy = 0;
  const idxs = [];
  for (const it of items) {
    cx += it.x || 0;
    cy += it.y || 0;
    if (Number.isFinite(it.idx)) idxs.push(it.idx);
  }
  cx /= items.length;
  cy /= items.length;

  // Build a strong signature across run + nodes + content
  const sorted  = idxs.slice().sort((a,b)=>a-b);
  const content = String(textContent || '').trim();
  const sig     = `${type}|${sorted.join(',')}|${content.length}:${content.slice(0,256)}`;

  // strict de-dup against the same store the renderer uses
  const exists = aiFootprints.some(f => f.sig === sig);
  if (exists) return;

  const finalTitle =
    (title && String(title).trim())
      ? String(title).trim()
      : computeAISummaryTitle(content, 'AI summary');

  const f = {
    type,
    title: finalTitle,
    nodeIds: sorted,
    x: cx,
    y: cy,
    content,
    sig,
    createdAt: Date.now()
  };
  aiFootprints.push(f);
  ensureAIDimensionForFootprint(f, /*selectAfter=*/false);
}



// Draw all footprints (call from draw, in SCREEN space)
// Draw all footprints (call from draw, in SCREEN space)
// Draw all footprints (screen space)
function drawAIFootprints() {
  if (!aiFootprints.length || (lenses && lenses.aiDocs === false)) return;

  const H = computeHighlightMask();
  const hasSelection = (selectedIndex >= 0) || (selectedDim >= 0) || (aiActiveFootprint != null);

  push();
  noFill();

  for (const f of aiFootprints) {
    const idxs = Array.isArray(f.nodeIds) ? f.nodeIds : [];
    if (!idxs.length) continue;

    // Collect node positions (world → screen) & centroid/fallback for the marker
    let sx = 0, sy = 0, count = 0;
    const nodeScreens = [];
    for (const i of idxs) {
      const p = (typeof parallaxWorldPos === 'function') ? parallaxWorldPos(i) : nodes?.[i];
      if (!p) continue;
      sx += p.x; sy += p.y; count++;
      nodeScreens.push(worldToScreen(p.x, p.y));
    }
    if (!count) continue;

    const cx = sx / count, cy = sy / count;
    let wx = Number.isFinite(f.x) ? f.x : cx;
let wy = Number.isFinite(f.y) ? f.y : cy;
if (f.dimKey && dimByKey) {
  const dk = dimByKey.get(f.dimKey);
  if (dk != null && dimTools[dk]) {
    wx = dimTools[dk].x;
    wy = dimTools[dk].y;
    // keep footprint in sync so saves persist the latest
    f.x = wx; f.y = wy;
  }
}

const ms = (typeof worldToScreen === 'function') ? worldToScreen(wx, wy) : { x: wx, y: wy };

    const focused = (aiHoverFootprint === f) || (aiActiveFootprint === f) || idxs.some(i => H[i]);

    // Connectors
    strokeWeight(1);
    let a;
    if (hasSelection) a = focused ? (EDGE_HILITE_ALPHA || 255) : SELECT_DIM_EDGE_ALPHA;
    else if (H.some(Boolean)) a = focused ? (EDGE_HILITE_ALPHA || 255) : (EDGE_IDLE_DIM_ALPHA || 90);
    else a = EDGE_IDLE_ALPHA || 110;
    stroke(0, 200, 255, a);

    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      if (Array.isArray(visibleMask) && !visibleMask[i]) continue;
      const ps = nodeScreens[k];
      if (!ps) continue;
      line(ms.x, ms.y, ps.x, ps.y);
    }

    // Icon
    const iconSize = 24;
    noStroke();
    if (aiMarkerImg) {
      push();
      if (!focused) tint(255, 180); // dim on idle
      image(aiMarkerImg, ms.x - iconSize/2, ms.y - iconSize/2, iconSize, iconSize);
      pop();
    } else {
      fill(0, 200, 255, focused ? 240 : 140);
      circle(ms.x, ms.y, iconSize * 0.8);
    }

    // Hit-test cache for this frame
    f._markerScreen = { sx: ms.x, sy: ms.y, r: iconSize * 0.55 };
  }

  pop();
}





// Hit-test markers in screen space; returns the footprint or null
function hitAIFootprintMarker(sx, sy) {
  for (let i = aiFootprints.length - 1; i >= 0; i--) {
    const m = aiFootprints[i]._markerScreen;
    if (!m) continue;
    const dx = sx - m.sx, dy = sy - m.sy;
    if (dx*dx + dy*dy <= (m.r*m.r)) return aiFootprints[i];
  }
  return null;
}

// Hit-test the AI marker in SCREEN coords (robust to first-frame / missing _markerScreen)
function hoverAIFootprintMarker(sx, sy) {
  if (!Array.isArray(aiFootprints)) return null;
  const Rdef = 14;
  for (const f of aiFootprints) {
    let mx, my, R = Rdef;

    const m = f && f._markerScreen;
    if (m && Number.isFinite(m.sx) && Number.isFinite(m.sy)) {
      mx = m.sx; my = m.sy; R = Number.isFinite(m.r) ? m.r : Rdef;
    } else {
      // fall back to saved world position (or 0,0)
      const wx = Number.isFinite(f.x) ? f.x : 0;
      const wy = Number.isFinite(f.y) ? f.y : 0;
      const s  = (typeof worldToScreen === 'function') ? worldToScreen(wx, wy) : { x: wx, y: wy };
      mx = s.x; my = s.y;
    }

    const dx = sx - mx, dy = sy - my;
    if (dx*dx + dy*dy <= R*R) return f;
  }
  return null;
}


// Open a stored AI doc in your existing synthesis panel
function openAIDocFootprint(f) {
  if (!f) return;
  aiActiveFootprint = f;                 // keep highlight behaviour
  const k = ensureAIDimensionForFootprint(f, /*selectAfter=*/true);
  // No center viewer here – we treat AI summaries like dimensions now.
}


function computeAISummaryTitle(text, fallback = 'AI summary') {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;

  // try first sentence, trimmed to ~10 words / 72 chars
  const sentence = (s.split(/(?<=[.!?])\s+/)[0] || s).trim();
  let t = sentence.split(' ').slice(0, 10).join(' ');
  t = t.replace(/\s+[,;:–-]+$/, '');
  if (t.length > 72) t = t.slice(0, 69) + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function ensureAIDimensionForFootprint(f, selectAfter = false) {
  if (!f || !Array.isArray(f.nodeIds)) return -1;

  // stable key for lookup
  const toolKey = `ai|${f.sig || (f.title || '').trim() || 'untitled'}`;

  // already exists?
  let idx = dimByKey.get(toolKey);
  if (idx != null) {
    f.dimKey = toolKey;
    if (selectAfter) selectDimension(idx);
    return idx;
  }

  // build node set for influence
  const ns = new Set();
  for (const i of f.nodeIds) if (Number.isFinite(i)) ns.add(i);

  // ---------- choose initial placement: majority-cluster centroid (+ jitter) ----------
  let wx = 0, wy = 0, placed = false;

  // Make sure clusters exist
  try {
    if (!clusterOf || clusterOf.length !== nodes.length) computeDomainClusters();
  } catch (_) {}

  if (Array.isArray(clusterOf) && clusterOf.length === nodes.length) {
    // Majority cluster among the footprint's nodes
    const counts = new Map();
    for (const i of ns) {
      const c = clusterOf[i];
      if (Number.isInteger(c) && c >= 0) counts.set(c, (counts.get(c) || 0) + 1);
    }
    if (counts.size) {
      let bestCid = -1, bestCnt = -1;
      for (const [cid, cnt] of counts) {
        if (cnt > bestCnt) { bestCnt = cnt; bestCid = cid; }
      }
      // Centroid of the whole cluster (using current draw positions)
      if (bestCid >= 0) {
        let sx = 0, sy = 0, k = 0;
        for (let i = 0; i < nodes.length; i++) {
          if (clusterOf[i] === bestCid) {
            const p = (typeof parallaxWorldPos === 'function') ? parallaxWorldPos(i) : nodes[i];
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
              sx += p.x; sy += p.y; k++;
            }
          }
        }
        if (k > 0) {
          wx = sx / k; wy = sy / k; placed = true;
        }
      }
    }
  }

  // Fallbacks: footprint centroid → nodes centroid → world centre
  if (!placed) {
    if (Number.isFinite(f.x) && Number.isFinite(f.y)) {
      wx = f.x; wy = f.y;
    } else {
      let sx = 0, sy = 0, k = 0;
      for (const i of ns) {
        const p = (typeof parallaxWorldPos === 'function') ? parallaxWorldPos(i) : nodes[i];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { sx += p.x; sy += p.y; k++; }
      }
      if (k > 0) { wx = sx / k; wy = sy / k; }
      else { wx = world.w * 0.5; wy = world.h * 0.5; }
    }
  }

  // Small random offset so multiple summaries don't stack perfectly
  const J = AI_DIM_JITTER || 24;
  wx += (Math.random() * 2 - 1) * J;
  wy += (Math.random() * 2 - 1) * J;

const label =
  (f.title && String(f.title).trim())
    ? String(f.title).trim()
    : computeAISummaryTitle(f.content, 'AI summary');



  // create the dimension (power 0 by default)
  const tool = {
    type: 'ai',
    key: toolKey,
    label,
    nodes: ns,
    power: 0,
    x: wx, y: wy,
    selected: false,
    userMoved: false,
    color: DIM_COLORS.ai || [130,210,255],
    aiSig: f.sig,
    aiContent: f.content,
    aiCreatedAt: f.createdAt,
    aiTitle: label,
    summaryRef: f.summaryRef || null   // ← ADD THIS
  };

  idx = dimTools.push(tool) - 1;
  dimByKey.set(toolKey, idx);

  dimMembershipDirty = true;


  // link footprint <-> dim and keep footprint position in sync for saves
  f.dimKey = toolKey;
  f.x = wx; f.y = wy;

  if (lenses?.hideNonDim) recomputeVisibility?.();
  redraw();

  if (selectAfter) selectDimension(idx);
  return idx;
}

// --------- Intent detection & prompts for Open Question ---------
function detectOQIntent(question, explicitMode = 'auto') {
  const q = String(question || '').toLowerCase();
  const pick = (mode, label, words, title) =>
    ({ mode, modeLabel: label, targetWords: words, titlePrefix: title });

  if (explicitMode !== 'auto') {
    switch (explicitMode) {
      case 'systematic': return pick('systematic', 'systematic review', 6000, 'Systematic Review');
      case 'thematic':   return pick('thematic',   'thematic mapping',  2800, 'Thematic Synthesis');
      case 'methods':    return pick('methods',    'methods comparison',2200, 'Methods Comparison');
      case 'data':       return pick('data',       'data compilation',  2000, 'Data Compilation');
      default:           return pick('general',    'answer',            1600, 'Open Question');
    }
  }

  if (/\bsystematic review|prisma|meta[- ]analysis|evidence synthesis\b/i.test(q))
    return pick('systematic','systematic review',6000,'Systematic Review');
  if (/\btheme|thematic|mapping|landscape\b/i.test(q))
    return pick('thematic','thematic mapping',2800,'Thematic Synthesis');
  if (/\bmethod(s|ology)|compare|contrast|benchmark|approach(es)?\b/i.test(q))
    return pick('methods','methods comparison',2200,'Methods Comparison');
  if (/\btable|dataset|compile|catalog|inventory|extraction|data\b/i.test(q))
    return pick('data','data compilation',2000,'Data Compilation');

  return pick('general','answer',1600,'Open Question');
}

function makeOQExcerpts(docs, perChars = 1200) {
  return docs.map(d => {
    const tx = String(d.text || '').replace(/\s+/g,' ').slice(0, perChars);
    const head = `${d.title ? d.title + ' — ' : ''}${d.authors || ''} ${d.year ? '('+d.year+')' : ''}`;
    return `[${d.refKey}] ${head}\n${tx}`;
  });
}

function buildOQChunkPrompt(question, intent, refsBlock, excerptsArr) {
  const styleNotes = {
    systematic: `Extract detailed, non-overlapping evidence relevant to the QUESTION.
- Prefer higher-level statements supported by multiple sources.
- Include brief notes on population/context/intervention/outcome if present.
- Output as tight bullets.`,
    thematic:   `Identify themes and sub-themes; for each, extract 1–3 representative findings with citations.`,
    methods:    `Focus on methodological details (assumptions, data, algorithms, limitations). Group bullets by method family.`,
    data:       `Extract concrete numeric findings or parameters into uniform bullets (variable, value, units, context).`,
    general:    `Extract the most decision-relevant findings answering the QUESTION; prioritise breadth then depth.`
  }[intent.mode];

  const sys =
`You are a postdoctoral researcher writing in formal UK academic English.
From each excerpt, extract concise EVIDENCE BULLETS strictly supported by the text.
Rules:
- Every bullet MUST include inline citation keys like [n] or [n*]; use multiple citations when appropriate.
- Do NOT invent data or references; only use what is present.
- Keep bullets terse (1–2 sentences).`;

  const user =
`QUESTION:
${question}

TASK STYLE:
${styleNotes}

REFERENCES (for the citation keys):
${refsBlock}

EVIDENCE EXCERPTS:
${excerptsArr.join('\n\n')}

Return: a list of bullets only.`;

  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

function buildOQMergePrompt(question, intent, refsBlock, chunkTexts) {
  // Heuristic section plan based on intent
  const plan = {
    systematic: [
      'Scope & approach',
      'Evidence base',
      'Findings by theme',
      'Mechanisms & models',
      'Limitations & future work'
    ],
    thematic: [
      'Overview & scope',
      'Themes',
      'Cross-cutting issues',
      'Gaps & next steps'
    ],
    methods: [
      'Problem framing',
      'Method families & assumptions',
      'Comparative performance',
      'Failure modes & limitations',
      'Recommendations'
    ],
    data: [
      'Scope & variables',
      'Compiled findings',
      'Consistency & discrepancies',
      'Data gaps'
    ],
    general: [
      'Answer',
      'Supporting evidence',
      'Caveats & uncertainties'
    ]
  }[intent.mode];

  const sys =
`You are a postdoctoral researcher writing in formal UK academic English.
Compose a cohesive ${intent.modeLabel} strictly from the provided EVIDENCE BULLETS.
Rules:
- Every specific claim must include inline bracket citations [n] / [n*] (multiple where appropriate).
- Structure the report into clear sections following the suggested plan.
- Aim for ~${intent.targetWords} words; scale with available evidence, but avoid redundancy.
- Do NOT invent content or references. If evidence is insufficient, state limitations explicitly.`;

  const user =
`QUESTION:
${question}

SECTION PLAN:
- ${plan.join('\n- ')}

REFERENCES (for citation keys):
${refsBlock}

EVIDENCE BULLETS (aggregated from all batches):
${chunkTexts.join('\n\n')}

Write the full report now, using formal prose and inline citations.`;

  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

function splitIntoSentences(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  // naive splitter that works fine for scientific prose
  return s.split(/(?<=[.!?])\s+(?=[A-Z([])/).filter(x => x && x.length > 30);
}

function localExtractEvidenceBullets(partDocs, query, maxPerDoc = 2) {
  const qWords = String(query||'').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  if (!qWords.length) return '';
  const bullets = [];
  for (const d of partDocs) {
    const sents = splitIntoSentences(d.text).slice(0, 40);
    const scored = sents.map(t => {
      const lt = t.toLowerCase();
      let s = 0;
      for (const w of qWords) if (lt.includes(w)) s++;
      return { t, s };
    }).filter(x => x.s > 0)
      .sort((a,b)=> b.s - a.s)
      .slice(0, maxPerDoc);
    for (const x of scored) {
      bullets.push(`• ${x.t.trim()} [${d.refKey}]`);
    }
  }
  return bullets.join('\n');
}
// ---------- Stage 1: relevance screening ----------
function expandQueryTerms(q) {
  const base = (q || '').toLowerCase();
  const words = base.split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const extra = [];
  // light morphological expansion
  for (const w of words) {
    if (/ing$|ed$|s$/i.test(w)) extra.push(w.replace(/(ing|ed|s)$/,''));
  }
  // light domain synonyms the model often misses (generic but helpful)
  if (/\bprint|fabricat|additive|3d|robot|extrud|toolpath|cfd|nozzle|cnc\b/i.test(base)) {
    extra.push('3d','printing','printed','print','additive','fabrication','digital','robotic','extrusion','toolpath','cnc');
  }
  return Array.from(new Set(words.concat(extra)));
}

function rankDocsForScreen(corpus, query) {
  const terms = expandQueryTerms(query);
  if (!terms.length) return [...corpus];

  // weight: title>abstract>fulltext; bonus if concept-y keywords appear in title
  const scoreDoc = (d) => {
    const title = (d.title || '').toLowerCase();
    const text  = (d.text || '').toLowerCase();  // abstract/fulltext
    let s = 0;
    for (const t of terms) {
      const re = new RegExp(`\\b${escapeRegex(t)}\\w*\\b`, 'g');
      const inTitle = title.match(re);
      const inText  = text.match(re);
      if (inText)  s += inText.length * 1.0;
      if (inTitle) s += inTitle.length * 3.0;
    }
    if (d.source === 'fulltext') s += 0.2;
    return s;
  };
  return [...corpus].map(d => ({ d, s: scoreDoc(d) }))
                    .sort((a,b) => b.s - a.s)
                    .map(x => x.d);
}

// short, title-first snippets for screening
function makeScreenExcerpts(docs, perChars = 420) {
  return docs.map(d => {
    const abs = String(d.text || '').replace(/\s+/g,' ');
    const head = `${d.title ? d.title + ' — ' : ''}${d.authors || ''} ${d.year ? '('+d.year+')' : ''}`;
    return `[${d.refKey}] ${head}\n${abs.slice(0, perChars)}`;
  });
}

// ask the model to return ONLY relevant keys, as JSON
function buildOQScreenPrompt(question, refsBlock, screenExcerpts) {
  const sys = `You are selecting documents strictly relevant to the QUESTION. 
Return ONLY a JSON array of citation keys like ["3","7*","12"]. No commentary.`;
  const user =
`QUESTION:
${question}

REFERENCES (for keys):
${refsBlock}

TITLE/ABSTRACT EXCERPTS:
${screenExcerpts.join('\n\n')}

Return ONLY: a JSON array of keys, e.g. ["3","12*"]. No prose.`;
  return [{ role:'system', content: sys }, { role:'user', content: user }];
}

function parseScreenKeys(txt) {
  try {
    const j = JSON.parse(String(txt || '').trim());
    if (Array.isArray(j)) return j.map(String);
  } catch {}
  // fallback: harvest bracketed keys like [3] [4*]
  const keys = [];
  const re = /\[([0-9]+[*]?)\]/g; let m;
  const s = String(txt || '');
  while ((m = re.exec(s))) keys.push(m[1]);
  return Array.from(new Set(keys));
}

// ─────────────────────────────────────────────────────────────────────────────
// LENSES + DATA RETRIEVAL DROPDOWNS  (replaces the old "Lenses" icon bar)
// ─────────────────────────────────────────────────────────────────────────────
let lensesMenuBtn, lensesMenu, lensesMenuItems = [];
let dataMenuBtn, dataMenu;


function updateLensesMenuItemStates() {
  if (!lensesMenuItems?.length) return;
  for (const { row, spec } of lensesMenuItems) {
    const active = !!spec.on();
    row.style('opacity', active ? '1' : '0.45');
  }
}

// Data Retrieval dropdown (holds "Retrieve Full Texts")
function createDataMenuButton() {
   // Icon button instead of text
  const btn = createImg('./Icons/Data_Ret.png', 'Data Retrieval');
  const parent = (window.topBar || window.topToolbar || document.body);
  btn.parent(parent);
  btn.style('width','40px');
  btn.style('height','40px');
  btn.style('margin-left','1px');
    btn.attribute('title', 'Retrieve Data'); 
  btn.style('cursor','pointer');
  btn.attribute('draggable','false');
  attachTooltip(btn, 'Retrieve Data'); 
  if (typeof captureUI === 'function') captureUI(btn.elt);

  if (DEMO_MODE) {
  btn.style('opacity', '0.1');
  btn.style('pointer-events', 'none');
  btn.style('cursor', 'default');
  btn.attribute('title', 'Retrieve Data (disabled in Demo mode)');
}

  const menu = createDiv('');
  menu.addClass('dropdown');
  menu.style('position','fixed');
  menu.style('display','none');
  menu.style('z-index','10040');
  menu.style('background', '#000');   
  menu.style('border-radius','8px');
  menu.style('backdrop-filter','blur(6px)');
  menu.style('padding','6px 0');
  menu.style('box-shadow', '0 10px 28px rgba(0,0,0,0.45)'); // stronger separation
menu.style('backdrop-filter', ''); 
  captureUI(menu.elt);

  function addItem(label, onClick) {
    const row = createDiv(label);
    row.parent(menu);
    row.style('padding','8px 14px');
    row.style('font','12px/1.2 system-ui, -apple-system, Segoe UI, Roboto');
    row.style('color','#f0f3f6');
    row.style('cursor','pointer');
    row.mouseOver(()=> row.style('background','rgba(255,255,255,0.06)'));
    row.mouseOut(()=>  row.style('background','transparent'));
    captureUI(row.elt);

    row.elt.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof onClick === 'function') onClick();
      // Close after action
      menu.style('display','none');
    }, { capture: true });
  }

  addItem('Retrieve Full Texts', () => {
    if (typeof autoCacheVisible === 'function') {
      autoCacheVisible();
    } else {
      console.warn('autoCacheVisible() not found.');
    }
  });

   addItem('Retrieve by DOI…', () => openIdRetrievalDialog('doi'));
  addItem('Retrieve by OpenAlex ID…', () => openIdRetrievalDialog('wid'));
  addItem('Retrieve by Journal…', () => openJournalRetrievalDialog());





  btn.elt.addEventListener('click', (ev) => { ev.stopPropagation(); 
    const vis = menu.elt.style.display !== 'none';
    if (vis) menu.style('display','none'); else {
      const b = btn.elt.getBoundingClientRect();
      menu.style('left', `${b.left}px`);
      menu.style('top',  `${b.bottom + 6}px`);
      menu.style('display','block');
    }
  }, { capture: true });

  document.addEventListener('click', (ev) => {
    if (menu.elt.style.display === 'none') return;
    if (!menu.elt.contains(ev.target) && ev.target !== btn.elt) {
      menu.style('display','none');
    }
  }, { capture: true });

  document.body.appendChild(menu.elt);
}


// helper to pop a menu just under a button
function positionMenuUnder(btn, menu) {
  const r = btn.elt.getBoundingClientRect();
  menu.style('left', `${Math.round(r.left)}px`);
  menu.style('top',  `${Math.round(r.bottom + 6)}px`);
  menu.style('display','block');
}

// Ensure any icon-strip refresh also updates our dropdown state
// (If updateLensIcons already exists earlier, this later definition overrides it.)


// Retire the old icon strip if something calls it


//Menue Styles
function styleLikeSaveLoad(btn) {
  btn.style('background','rgba(255,255,255,0.10)');
  btn.style('border','1px solid rgba(255,255,255,0.25)');
  btn.style('color','#fff');
  btn.style('padding','6px 10px');
  btn.style('border-radius','8px');
  btn.style('cursor','pointer');
  btn.style('font-size','12px');
}
function syncDimSidebarTop() {
  if (!dimSidebar || !filtersPanel) return;
  const bottom = filtersPanel.elt.getBoundingClientRect().bottom;
  const topY = Math.round(bottom + 12);
  dimSidebar.style('top', `${topY}px`);
  const maxH = windowHeight - topY - PANEL_MARGIN;
  dimSidebar.style('max-height', `${Math.max(120, maxH)}px`);
}
function syncDimSidebarTop() {
  if (!dimSidebar || !filtersPanel) return;
  const bottom = filtersPanel.elt.getBoundingClientRect().bottom;
  const GAP = 12; // visual separation between panels
  const topY = Math.round(bottom + GAP);

  dimSidebar.style('top', `${topY}px`);
  const maxH = windowHeight - topY - PANEL_MARGIN;
  dimSidebar.style('max-height', `${Math.max(120, maxH)}px`);
}
// put this near other small helpers (top-level utilities)
function normalizeIsOA(item) {
  const w = item?.openalex || item || {};
  const oa = w.open_access || w.openAccess || item?.open_access || {};
  const status = String(oa.oa_status || oa.status || '').toLowerCase();
  const statusOpen = !!status && status !== 'closed';

  return !!(
    oa.is_oa === true ||
    w.is_oa === true ||
    item?.is_oa === true ||
    item?.oa === true ||
    statusOpen
  );
}

function forceDefaultLensStates() {
  // Hard defaults at startup
  lenses.aiDocs = false;
  // keep any other defaults you want hard-set here too (e.g., hideNonDim=false)
  if (typeof recomputeVisibility === 'function') recomputeVisibility();
  if (typeof redraw === 'function') redraw();
}

async function handleAnyImportSelected(p5file) {
  const native = p5file?.file || p5file;
  if (!native) { msg = "Could not access the file."; updateInfo(); redraw(); return; }

  const name = (native.name || '').toLowerCase();
  const type = (native.type || '').toLowerCase();
  const isPdf = type.includes('pdf') || name.endsWith('.pdf');

  if (!isPdf) {
    // Keep existing JSON path
    return handleFileSelected(p5file);
  }

  try {
    showLoading('Starting PDF import…', 0.02);
    const onStatus = (m, pct) => setLoadingProgress(Math.max(0, Math.min(1, pct||0)), m);
    const onWork   = (item, workRaw) => addOpenAlexItemAsNode(item, workRaw);
    await DataRetrieval.importPdfFile(native, { viaProxy, onStatus, onWork });
    hideLoading();
    msg = 'Paper imported ✓';
computeDomainClusters();   // recompute communities
buildDimensionsIndex();    // rebuild Dimensions (so “Clusters” names update)
renderDimensionsUI();      // re-render side panel
redraw();


    updateInfo(); redraw();
  } catch (e) {
    hideLoading();
    msg = `Import failed: ${e.message || e}`;
    updateInfo(); redraw();
  }
}

function addOpenAlexItemAsNode(item, workRaw) {
  // Make sure indexes reflect current graph
  indexExistingPubKeys();
  const oa  = normOA(workRaw?.id);
  const doi = normDOI(workRaw?.doi || workRaw?.ids?.doi);
  const ttl = normTitle(workRaw?.title || workRaw?.display_name);

  const existingIdx =
    (oa  && oaIdToNode.get(oa)) ??
    (doi && doiToNode.get(doi)) ??
    (ttl && titleToNode.get(ttl));

  if (Number.isInteger(existingIdx) && existingIdx >= 0) {
    // Merge any fresher metadata and select the existing node
    const nodeIdx = nodes[existingIdx]?.idx ?? existingIdx;
    mergeWorkIntoItem(nodeIdx, workRaw);

    // ensure keys point to it
    if (oa)  oaIdToNode.set(oa, existingIdx);
    if (doi) doiToNode.set(doi, existingIdx);
    if (ttl) titleToNode.set(ttl, existingIdx);

    // Update sidebars
    buildDimensionsIndex?.(); updateDimSections?.();

    // Focus it
    selectNode?.(existingIdx);
    msg = 'Publication already in graph — selected & updated.';
    updateInfo?.(); redraw?.();
    return;
  }

  // Otherwise create a new node centered (as before)
  const emptyBefore = itemsData.length === 0;
  const idx = itemsData.length;
  itemsData.push({ ...item, openalex: workRaw });

    // Mark as seed iff this is the first/only item                 // ← ADD
  if (emptyBefore) {                                             // ← ADD
    itemsData[idx].isSeed = true;                                // ← ADD
    itemsData[idx].seedSource = 'pdf';                           // ← ADD
  }    

  const ctr = screenToWorld(width / 2, height / 2);
  nodes.push({
    idx,
    x: ctr.x, y: ctr.y,
    r: typeof baselineNodeR === 'function' ? baselineNodeR() : (typeof NODE_R !== 'undefined' ? NODE_R : 10),
    label: item.label,
    oa: !!item.oa,
    cbc: Number(item.cbc || 0),
    hasAbs: !!item.hasAbs,
    hasFullText: !!item.hasFullText,
    visible: true
  });
  ensureVelArrays?.();

  // Register keys
  const newNodeIdx = nodes.length - 1;
  if (oa)  oaIdToNode.set(oa, newNodeIdx);
  if (doi) doiToNode.set(doi, newNodeIdx);
  if (ttl) titleToNode.set(ttl, newNodeIdx);

  // Rebuild dims and UI
  buildDimensionsIndex?.(); updateDimSections?.();
  recomputeVisibility?.(); updateInfo?.();
  selectNode?.(newNodeIdx); redraw?.();
}



function zoomFadeT() {
  // 0 below start, 1 at/after end, smooth between
  const t = (zoomLevel - ZOOM_FADE_START) / (ZOOM_FADE_END - ZOOM_FADE_START);
  return Math.max(0, Math.min(1, t));
}

function hitCiteButtonAtScreen(sx, sy) {
  if (!citeUi.visible || !citeUi.buttons.length) return -1;
  let best = -1, bestD2 = Infinity;
  for (let i = 0; i < citeUi.buttons.length; i++) {
    const b = citeUi.buttons[i];
    const dx = sx - b.sx, dy = sy - b.sy;
    const d2 = dx*dx + dy*dy;
    if (d2 < (b.r + 4) * (b.r + 4) && d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

let _isBuildingLeft  = false;
let _isBuildingRight = false;

async function onCiteButtonClicked(b) {
if (DEMO_MODE) {
  showToast?.('Citations expansion is disabled in Demo mode');
  return;
}
  if (selectedIndex < 0) return;

  const seedIdx = nodes[selectedIndex].idx;
  const seedOA  = itemsData[seedIdx]?.openalex?.id;

  // Track per-node completion flags
  const item = itemsData[seedIdx] || {};
  item._built = item._built || {};

  // Helpers to run the actual builds (we'll call these after the L2 caps dialog when needed)
  const runLeftBuild = async () => {
    try {
      indexExistingOAIds();
      showLoading(b.level === 1 ? 'Building cited (L1)…' : 'Building cited (L2)…', 0.02);
      const onProgress = (m, pct) => setLoadingProgress(Math.max(0, Math.min(1, pct||0)), m);

      const edgesOA = [];
      const onBatch = (works, ctx) => {
        if (ctx?.level === 1) for (const w of works) edgesOA.push([seedOA, w.id]);
        integrateWorksAndEdges(seedIdx, works, null); // live nodes
onGraphDataChanged();
      };

      const res = await DataRetrieval.expandCited({
        openalexId: seedOA,
        depth: (b.level === 2 ? 2 : 1),
        viaProxy,
        onProgress,
        onBatch
      });

      integrateWorksAndEdges(seedIdx, [], res.edgesOA);
      onGraphDataChanged();
      hideLoading();
      msg = 'Cited expansion complete ✓';
      if (b.level === 1) item._built.citedL1 = true; else item._built.citedL2 = true;
      updateInfo(); redraw();
    } catch (e) {
      hideLoading();
      console.error(e);
      msg = `Build failed: ${e.message || e}`;
      updateInfo(); redraw();
    }
  };

  const runRightBuild = async () => {
    try {
      indexExistingOAIds();
      const msgTitle = (b.level === 2) ? 'Building cited by (L2)…' : 'Building cited by (L1)…';
      showLoading(msgTitle, 0.02);
      const onProgress = (m, pct) => setLoadingProgress(Math.max(0, Math.min(1, pct||0)), m);

      const edgesOA = [];
      const onBatch = (works, ctx) => {
        // edges are added after the call as a single bulk integrate from res.edgesOA;
        // here we stream the nodes so you see them arrive.
        integrateWorksAndEdges(seedIdx, works, null);
        onGraphDataChanged();
      };

      // Fetch latest caps at the moment we run (in case dialog just saved them)
      const { l2PerParent, l2GlobalCap } = (window.CITED_BY_CAPS || loadCitedByCaps());

      const res = await DataRetrieval.expandCitedBy({
        openalexId: seedOA,
        limit: 15000,        // tweak to taste for L1 size
        depth: (b.level === 2 ? 2 : 1),
        l2PerParent,
        l2GlobalCap,
        viaProxy,
        onProgress,
        onBatch
      });

      // Now integrate edges (both L1 and any L2 edges the retriever created)
      integrateWorksAndEdges(seedIdx, [], res.edgesOA);
      onGraphDataChanged();

      hideLoading();
      msg = (b.level === 2) ? 'Cited-by (L2) complete ✓' : 'Cited-by (L1) complete ✓';
      if (b.level === 1) item._built.citedByL1 = true; else item._built.citedByL2 = true;
      updateInfo(); redraw();
    } catch (e) {
      hideLoading();
      console.error(e);
      msg = `Build failed: ${e.message || e}`;
      updateInfo(); redraw();
    }
  };

  // LEFT side (outgoing references)
  if (b.side === 'left') {
    if ((b.level === 1 && item._built.citedL1) || (b.level === 2 && item._built.citedL2)) return;
    if (_isBuildingLeft) return;

    if (b.level === 2) {
      // Ask for caps first, then proceed with the L2 build
      openCitedByCapsDialog(() => {
        _isBuildingLeft = true;
        runLeftBuild().finally(() => { _isBuildingLeft = false; });
      });
    } else {
      _isBuildingLeft = true;
      try { await runLeftBuild(); } finally { _isBuildingLeft = false; }
    }
    return;
  }

  // RIGHT side (incoming “cited by”)
  if (b.side === 'right') {
    // L1 and L2 supported
    if (b.level === 1 && item._built.citedByL1) return;
    if (b.level === 2 && item._built.citedByL2) return;
    if (_isBuildingRight) return;

    if (b.level === 2) {
      // Open the caps dialog first; build on save
      openCitedByCapsDialog(() => {
        _isBuildingRight = true;
        runRightBuild().finally(() => { _isBuildingRight = false; });
      });
    } else {
      _isBuildingRight = true;
      try { await runRightBuild(); } finally { _isBuildingRight = false; }
    }
    return;
  }
}



// ---- OpenAlex integration helpers ---------------------------------
const oaIdToNode = new Map();  // OpenAlex ID (full URL) -> node index

function normOA(id) {
  if (!id) return null;
  const s = String(id);
  const m = s.match(/(?:openalex\.org\/)?(W\d+)/i);
  return m ? `https://openalex.org/${m[1]}` : s;
}

function indexExistingOAIds() {
  oaIdToNode.clear();
  for (let i = 0; i < itemsData.length; i++) {
    const id = normOA(itemsData[i]?.openalex?.id);
    if (id != null) oaIdToNode.set(id, i);
  }
}

function ensureUndirectedEdge(i, j) {
  if (i === j) return false;
  for (const e of edges) {
    if ((e.source === i && e.target === j) || (e.source === j && e.target === i)) return false;
  }
  edges.push({ source: i, target: j });
  return true;
}

// Create (if needed) and return node index for an OpenAlex work
const _seedPlacement = new Map(); // seedIdx -> {k}

function getOrCreateNodeForWork(work, seedIdx) {
  // 1) Try to find an existing node by OA id, DOI, or Title
  const oa  = normOA(work?.id);
  const doi = normDOI(work?.doi || work?.ids?.doi);
  const ttl = normTitle(work?.title || work?.display_name);

  // Make sure maps reflect current graph
  if (oaIdToNode.size === 0 && doiToNode.size === 0 && titleToNode.size === 0) {
    indexExistingPubKeys();
  }

  let idx = null;
  const byOa  = oa  && oaIdToNode.has(oa)   ? oaIdToNode.get(oa)   : null;
  const byDoi = doi && doiToNode.has(doi)   ? doiToNode.get(doi)   : null;
  const byTtl = ttl && titleToNode.has(ttl) ? titleToNode.get(ttl) : null;
  idx = byOa ?? byDoi ?? byTtl;

  if (Number.isInteger(idx) && idx >= 0) {
    // Merge any missing info and ensure all keys map to this node
    mergeWorkIntoItem(idx, work);
    if (oa  && !oaIdToNode.has(oa))   oaIdToNode.set(oa, idx);
    if (doi && !doiToNode.has(doi))   doiToNode.set(doi, idx);
    if (ttl && !titleToNode.has(ttl)) titleToNode.set(ttl, idx);
    return idx;
  }

  // 2) Create a brand new node
const oaMin = compactOA(work);
const item = {
  label: oaMin.display_name || '(untitled)',
  cbc: oaMin.cited_by_count|0,
  hasAbs: !!oaMin.abstract,
  oa: !!oaMin.open_access?.is_oa,
  openalex: oaMin,           // <- tiny object, not the full `work`
  hasFullText: false
};
// Cache references count for Info panel fallback
item.refsCount = Number(oaMin.refsCount ?? 0);

 // --- ADD: carry light metadata to the item for UI fallbacks
 item.authors = (Array.isArray(oaMin.authorship_names) && oaMin.authorship_names.length)
                  ? oaMin.authorship_names.slice()
                  : (Array.isArray(oaMin.authors) ? oaMin.authors.slice() : []);
 if (oaMin.venue_name) item.venue = oaMin.venue_name;

  const newItemIdx = itemsData.length;
  itemsData.push(item);

  // Place around the seed (uses your ring placement if you have it; fallback to center)
  const r0 = typeof baselineNodeR === 'function' ? baselineNodeR() : (typeof NODE_R !== 'undefined' ? NODE_R : 10);
  const pos = typeof placeNewNode === 'function' ? placeNewNode(seedIdx, r0) : screenToWorld(width/2, height/2);
const y = Number(
  (work && (work.publication_year ??
           ((work.from_publication_date||'').slice(0,4)))) || NaN
);
  
  
  
  nodes.push({
    idx: newItemIdx,
    x: pos.x, y: pos.y,
    r: r0,
    label: item.label,
    oa: !!item.oa,
    cbc: Number(item.cbc || 0),
    hasAbs: !!item.hasAbs,
    hasFullText: !!item.hasFullText,
    year: Number.isFinite(y) ? y : undefined, 
    visible: true
  });
  ensureVelArrays?.();

  // Register keys for future lookups
  const newNodeIdx = nodes.length - 1;
  if (oa)  oaIdToNode.set(oa, newNodeIdx);
  if (doi) doiToNode.set(doi, newNodeIdx);
  if (ttl) titleToNode.set(ttl, newNodeIdx);

  return newNodeIdx;
}



function integrateWorksAndEdges(seedIdx, works, edgePairsOA) {
  // Re-index existing keys so dedupe maps are up to date
  indexExistingPubKeys();

  // 1) Create or upsert nodes for all incoming works; remember their OA ids
  const batchOAs = [];
  for (const w of (Array.isArray(works) ? works : [])) {
    const idx = getOrCreateNodeForWork(w, seedIdx);
    const oa = normOA(w?.id);
    if (oa != null) {
      oaIdToNode.set(oa, idx);
      batchOAs.push(oa);
    }
  }

  // 2) Add any server-provided edges (OA id pairs)
  if (Array.isArray(edgePairsOA)) {
    for (const pair of edgePairsOA) {
      const fromId = Array.isArray(pair) ? pair[0] : pair?.from;
      const toId   = Array.isArray(pair) ? pair[1] : pair?.to;
      const a = oaIdToNode.get(normOA(fromId));
      const b = oaIdToNode.get(normOA(toId));
      if (Number.isInteger(a) && Number.isInteger(b)) ensureUndirectedEdge(a, b);
    }
  }

  // 3) NEW: Intra-batch linking (connect newly fetched works to each other)
  if (Array.isArray(works) && works.length) {
    for (const w of works) {
      const wIdx = oaIdToNode.get(normOA(w?.id));
      if (!Number.isInteger(wIdx)) continue;

      const refs =
        (Array.isArray(w?.referenced_works) && w.referenced_works) ||
        (Array.isArray(w?.referencedWorks)  && w.referencedWorks)  ||
        (Array.isArray(w?.referenced)       && w.referenced)       || [];

      for (const refId of refs) {
        const jIdx = oaIdToNode.get(normOA(refId));
        if (Number.isInteger(jIdx)) ensureUndirectedEdge(wIdx, jIdx);
      }
    }
  }

  // 4) Refresh graph structures & UI
if (typeof computeDomainClusters === 'function') computeDomainClusters();
if (typeof buildDimensionsIndex   === 'function') buildDimensionsIndex();
if (typeof renderDimensionsUI     === 'function') renderDimensionsUI();
if (typeof updateDimSections      === 'function') updateDimSections();

  buildAdjacency(nodes.length, edges);
  computeDegreesFromAdj?.();
  ensureVelArrays?.();
  if (typeof degSlider?.value === 'function' && Number(degSlider.value()) > 0) degSlider.value(0);
  buildDimensionsIndex?.(); updateDimSections?.();
  setWorldSizeForN?.(nodes.length);
cbcMin = Infinity; cbcMax = -Infinity;
for (const n of nodes) {
  const c = Number(n?.cbc || 0);
  if (c < cbcMin) cbcMin = c;
  if (c > cbcMax) cbcMax = c;
}
if (!Number.isFinite(cbcMin)) cbcMin = 0;
if (!Number.isFinite(cbcMax)) cbcMax = 0;
initExtCitesFilterUI?.();
  recomputeVisibility?.(); updateInfo?.(); redraw?.();
window._clustersDirty = true;

// 5) Visibility & repaint
if (typeof recomputeVisibility    === 'function') recomputeVisibility();
if (typeof updateInfo             === 'function') updateInfo();
if (typeof redraw                 === 'function') redraw();


}




function placeNewNode(seedIdx, r) {
  // compute view-centre fallback
  const ctr = screenToWorld(width / 2, height / 2);

  const seed = (typeof seedIdx === 'number' && nodes[seedIdx]) ? nodes[seedIdx] : null;
  const cx = seed ? seed.x : ctr.x;
  const cy = seed ? seed.y : ctr.y;

  // how many we’ve placed around this seed already
  let entry = _seedPlacement.get(seedIdx || -1);
  if (!entry) { entry = { k: 0, a0: Math.random() * Math.PI * 2 }; _seedPlacement.set(seedIdx || -1, entry); }
  const k = entry.k++;
  const a = entry.a0 + k * (Math.PI * 0.35); // ~20 nodes per 360°

  // base radius away from seed
  const base = Math.max(6 * r, 80);
  let rad = base + Math.floor(k / 12) * (3 * r); // spiral after ~12

  // propose a position and nudge until no obvious overlaps
  let x = cx + Math.cos(a) * rad;
  let y = cy + Math.sin(a) * rad;

  const minSep = Math.max(2.6 * r, 28);
  let tries = 0;
  while (tries++ < 24 && collidesAny(x, y, minSep)) {
    rad += r * 0.6;
    x = cx + Math.cos(a) * rad;
    y = cy + Math.sin(a) * rad;
  }
  return { x, y };
}

function collidesAny(x, y, minSep) {
  const m2 = minSep * minSep;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    const dx = x - n.x, dy = y - n.y;
    if (dx*dx + dy*dy < m2) return true;
  }
  return false;
}







function drawSelectedNodeCitationsUI() {
  // reset per-frame state
  citeUi.visible = false;
  citeUi.buttons = [];

  if (selectedIndex < 0) return;

  // Fade timings: buttons 3→4, labels 5→5.5
  const tBtns = Math.max(0, Math.min(1, (zoomLevel - ZOOM_FADE_START) / (ZOOM_FADE_END - ZOOM_FADE_START)));
if (tBtns <= 0) return;
const tText = tBtns;  // labels fade in at the same time as buttons
if (DEMO_MODE) return;
  const n = nodes[selectedIndex];
  if (!n) return;
  if (lenses?.openAccess && !n.oa) return;

  // Node centre & half-size (screen space)
  const p = parallaxWorldPos(selectedIndex);
  const s = worldToScreen(p.x, p.y);
  const rWorld    = (n.r || NODE_R);
  const halfWorld = n.hasFullText ? (rWorld * 1.5) : rWorld; // squares ~3r wide
  const halfScr   = halfWorld * cam.scale;

  // ---- Size relative to node (with clamped ranges) ----
  const btnDiam     = Math.max(20, Math.min(44, halfScr * 0.35));
  const btnR        = btnDiam / 2;
  const edgeSpacing = Math.max(10, Math.min(28, btnDiam * 0.5));

  // L1 overlays node edge (centre slightly inside edge)
  const overlayInset  = Math.min(L1_OVERLAY_INSET_MAX, Math.max(4, btnR * L1_OVERLAY_INSET_FRAC));
  const offL1         = Math.max(0, halfScr - overlayInset);
  const offL2         = offL1 + btnDiam + edgeSpacing;

  // Button centres
  const leftL1  = { x: s.x - offL1, y: s.y };
  const leftL2  = { x: s.x - offL2, y: s.y };
  const rightL1 = { x: s.x + offL1, y: s.y };
  const rightL2 = { x: s.x + offL2, y: s.y };

  // Counts
  const item    = itemsData[n.idx] || {};
  const work    = item.openalex || {};
  const cited   = Array.isArray(work?.referenced_works) ? work.referenced_works.length : (item.refsCount|0);
  const citedBy = (item.cbc != null ? item.cbc : (work.cited_by_count|0)) | 0;

  // Completion flags (disable buttons once built)
  const leftL1Done  = !!(item?._built?.citedL1);
  const leftL2Done  = !!(item?._built?.citedL2);
  const rightL1Done = !!(item?._built?.citedByL1);

  push();

  // Subtle guide ring
  noFill();
  stroke(255, 245 * tBtns);
  strokeWeight(3);
   // Match the drawn node footprint in screen space, plus a tiny halo
 const sideWorld = n.hasFullText
   ? (rWorld * 2 * (typeof FULLTEXT_BOX_SIZE_MULT === 'number' ? FULLTEXT_BOX_SIZE_MULT : 1.0))
   : (rWorld * 2);
 const haloPx = 6;
 const sideScr = sideWorld * cam.scale + haloPx;
 rectMode(CENTER);
 if (n.hasFullText) {
   rect(s.x, s.y, sideScr, sideScr, 8);
 } else {
   circle(s.x, s.y, sideScr);
 }

  // Connectors: edge-to-edge between L1 and L2
  stroke(255, 200 * tBtns);
  strokeWeight(2);
  // Left
  line(leftL2.x + btnR, s.y, leftL1.x - btnR, s.y);
  // Right
  line(rightL1.x + btnR, s.y, rightL2.x - btnR, s.y);

  // Button drawer
  // Button drawer
// Button drawer (icon version)

const drawBtn = (cx, cy, side, level, tip, disabled=false) => {
  const idx = citeUi.buttons.length;
  const hovered = (idx === citeUi.hover) && !disabled;

  // Pick the right icon
  let img = null;
  if (side === 'left') {
    img = (level === 1) ? iconLeftL1 : iconLeftL2;
  } else {
    img = (level === 1) ? iconRightL1 : iconRightL2;
  }

  // Subtle background puck so icons feel like buttons
  // (keeps the same hit radius and visual affordance)
  stroke(255, (disabled ? 255 : (hovered ? 255 : 220)) * tBtns);
  strokeWeight(1);
  fill(disabled ? 255 : 15, (disabled ? 255 : (hovered ? 220 : 180)) * tBtns);
  circle(cx, cy, btnDiam);

  // Draw icon (fallback to old text if image missing)
  const iconSize = Math.max(14, btnDiam * (hovered ? 0.78 : 0.72));
  noStroke();
  if (img) {
    // Dim disabled; otherwise fade with tBtns
    const a = Math.round((disabled ? 160 : 255) * tBtns);
    push();
    tint(255, a);
    imageMode(CENTER);
    image(img, cx, cy, iconSize, iconSize);
    pop();
  } else {
    // Fallback: "L1"/"L2" text
    fill(disabled ? 0 : 230, (disabled ? 220 : 230) * tBtns);
    textAlign(CENTER, CENTER);
    textSize(Math.max(11, Math.min(13, btnDiam * 0.42)));
    text(`L${level}`, cx, cy + 0.5);
  }

  // Only clickable if not disabled
  if (!disabled) citeUi.buttons.push({ side, level, sx: cx, sy: cy, r: btnR, tip });
};



  // Left (Cited)
  drawBtn(leftL1.x,  leftL1.y,  'left',  1, 'Build Cited Level 1', leftL1Done);
  drawBtn(leftL2.x,  leftL2.y,  'left',  2, 'Build Cited Level 2', leftL2Done);

  // Right (Cited by)
  drawBtn(rightL1.x, rightL1.y, 'right', 1, 'Build Cited By Level 1', rightL1Done);
  drawBtn(rightL2.x, rightL2.y, 'right', 2, 'Build Cited By Level 2'); // (wire later if needed)

  // Labels (fade later, 5→5.5) pinned to node interior
// Labels (fade with buttons) — centered text in 50% black pill, scales with node size+zoom
// Labels (fade with buttons) — centered text in 50% black pill, scales w/ node + shrinks to avoid overlap
if (tText > 0) {
  const innerMargin = Math.max(12, Math.min(28, btnDiam * 0.8)) + (LABEL_BTN_EXTRA_MARGIN || 0);

  // Smaller-by-default font that scales with node size
  const baseFont = Math.max(10, Math.min(20, halfScr * 0.18));   // ↓ smaller default than before
  let fontPx = baseFont;

  const leftStr  = `Cited: ${cited}`;
  const rightStr = `Cited by: ${citedBy}`;

  // helper to (re)measure pills for current font
  const measure = () => {
    textSize(fontPx);
    const padX = Math.max(6, fontPx * 0.6);
    const pillH = Math.max(14, Math.round(fontPx * 1.5));
    const wL = textWidth(leftStr)  + padX * 2;
    const wR = textWidth(rightStr) + padX * 2;
    return { padX, pillH, wL, wR };
  };

  // initial measure
  let { padX, pillH, wL, wR } = measure();

  // available span between inner margins
  const leftInnerX  = s.x - halfScr + innerMargin;
  const rightInnerX = s.x + halfScr - innerMargin;
  const available   = rightInnerX - leftInnerX;

  // desired gap between the two pills
  const MIN_GAP = 10;

  // If pills would overlap, proportionally shrink font (floor at 50% of base)
  const required = wL + wR + MIN_GAP;
  if (required > available) {
    const scale1 = Math.max(0.5, available / required);
    fontPx = Math.max(8, Math.floor(baseFont * scale1));
    ({ padX, pillH, wL, wR } = measure());
  }

  // Centers (keep them inside the inner margins)
  const cxL = leftInnerX + wL / 2;
  const cxR = rightInnerX - wR / 2;
  const cy  = s.y;

  // 50% transparent black pill (modulated by fade)
  const pillAlpha = Math.round(127 * tText);     // 50% at full fade-in
  noStroke();
  rectMode(CENTER);
  fill(0, pillAlpha);
  rect(cxL, cy, wL, pillH, 10);
  rect(cxR, cy, wR, pillH, 10);

  // Centered white text
  fill(255, Math.round(255 * tText));
  textAlign(CENTER, CENTER);
  textSize(fontPx);
  text(leftStr,  cxL, cy + 0.5);
  text(rightStr, cxR, cy + 0.5);
}



  pop();

  // Tooltip
  citeUi.visible = true;
  if (citeUi.hover >= 0 && citeUi.hover < citeUi.buttons.length) {
    const b = citeUi.buttons[citeUi.hover];
    drawTooltip(b.sx, b.sy - (btnR + 12), b.tip);
  }
}


// Median of existing node radii; falls back to NODE_R
function baselineNodeR() {
  if (!Array.isArray(nodes) || nodes.length === 0) return NODE_R;
  const rs = nodes.map(n => +((n && n.r) || NODE_R)).filter(Number.isFinite);
  rs.sort((a, b) => a - b);
  return rs[Math.floor(rs.length / 2)] || NODE_R;
}

function mergeWorkIntoItem(idx, work) {
  if (!Number.isInteger(idx) || !itemsData[idx] || !work) return;
  const it = itemsData[idx];

  // Prefer richer title
  const richTitle = work.title || work.display_name;
  if (richTitle && (!it.label || it.label === '(untitled)')) it.label = richTitle;

  // If we only have a compact payload, replace with the full work.
  // Otherwise, shallow-merge to refresh key fields.
  if (!it.openalex || !it.openalex.id || isCompactOpenAlex(it.openalex)) {
    it.openalex = { ...work };
  } else {
    const fields = [
      'authorships','host_venue','primary_location','concepts','biblio','open_access',
      'referenced_works','referencedWorks','referenced','referenced_works_count','ids','doi','id',
      'display_name','title','publication_year','from_publication_date','cited_by_count'
    ];
    for (const k of fields) if (work[k] != null) it.openalex[k] = work[k];
  }

  // Cache counts for fast UI
  it.cbc = Number(work.cited_by_count || it.cbc || 0);
  it.refsCount =
      (Array.isArray(work.referenced_works) ? work.referenced_works.length : null) ??
      (work.referenced_works_count ?? work?.biblio?.reference_count ?? work?.biblio?.references_count ?? it.refsCount ?? null);

  // Keep openalex subobject coherent (optional)
  (it.openalex ||= {}).cited_by_count = it.cbc|0;

   // Persist a friendly venue on the item for UI fallbacks & indexing
 const vname = inferVenueNameFromWork(work, it.venue || '');
 if (vname && !it.venue) it.venue = vname;
 // Also cache a compact field inside openalex for consistent fallbacks
 if (vname && !it.openalex.venue_name) it.openalex.venue_name = vname;

  // Abstract presence flag
  if (work.abstract_inverted_index || work.abstract) it.hasAbs = true;

  // Refresh node label/counters
  const n = nodes.find(n => n && n.idx === idx);
  if (n) { n.label = it.label; n.cbc = it.cbc|0; }
}


function openCitedByCapsDialog(onSave /* optional */) {
  const dlg = document.createElement('div');
  Object.assign(dlg.style, {
    position:'fixed', inset:'0', background:'rgba(0,0,0,0.45)',
    backdropFilter:'blur(4px)', display:'flex', alignItems:'center',
    justifyContent:'center', zIndex:'10060'
  });

  const { l2PerParent, l2GlobalCap } = (window.CITED_BY_CAPS || loadCitedByCaps());

  dlg.innerHTML = `
    <div style="padding:14px;min-width:420px;background:rgba(16,16,20,0.95);
                border:1px solid rgba(255,255,255,0.18);border-radius:10px;color:#fff">
      <div style="font-weight:600;margin-bottom:8px">Cited-by (L2) Limits</div>

      <label style="display:block;margin:8px 0 4px">Per-parent L2 cap</label>
      <input id="cap_parent" type="number" min="1" max="2000" step="1"
             value="${l2PerParent}"
             style="width:100%;padding:8px;font:14px/1.3 system-ui;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:#111;color:#fff"/>

      <label style="display:block;margin:12px 0 4px">Global L2 cap</label>
      <input id="cap_global" type="number" min="1" max="20000" step="1"
             value="${l2GlobalCap}"
             style="width:100%;padding:8px;font:14px/1.3 system-ui;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:#111;color:#fff"/>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button id="caps_cancel"
                style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer">Cancel</button>
        <button id="caps_save"
                style="background:#2a84ff;border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(dlg);
  const close = () => dlg.remove();

  const elParent = dlg.querySelector('#cap_parent');
  const elGlobal = dlg.querySelector('#cap_global');

  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter')  { e.preventDefault(); dlg.querySelector('#caps_save').click(); }
  });

  dlg.querySelector('#caps_cancel').onclick = close;
  dlg.querySelector('#caps_save').onclick = () => {
    const p = Number(elParent.value);
    const g = Number(elGlobal.value);
    if (!Number.isFinite(p) || p < 1) { showToast?.('Per-parent must be ≥ 1'); return; }
    if (!Number.isFinite(g) || g < p) { showToast?.('Global must be ≥ per-parent'); return; }
    const saved = saveCitedByCaps({ l2PerParent: p, l2GlobalCap: g });
    showToast?.(`Saved: per-parent ${p}, global ${g}`);
    try { if (typeof onSave === 'function') onSave(saved); } catch {}
    close();
  };

  elParent.focus();
  elParent.select();
}



function openIdRetrievalDialog(mode /* 'doi' | 'wid' */) {
  const title = mode === 'doi' ? 'Retrieve by DOI' : 'Retrieve by OpenAlex Works ID';
  const placeholder = mode === 'doi'
    ? 'e.g. 10.1038/s41586-020-2649-2'
    : 'e.g. W3157227542 or https://openalex.org/W3157227542';

  const dlg = document.createElement('div');
  dlg.className = 'glass-modal';

  // Ensure it renders ABOVE the fixed canvas and captures clicks
  Object.assign(dlg.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0,0,0,0.45)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: '10060' // > menus (10040) and > canvas (0)
  });

  dlg.innerHTML = `
    <div class="glass-card"
         style="padding:14px;min-width:420px;background:rgba(16,16,20,0.95);
                border:1px solid rgba(255,255,255,0.18);border-radius:10px;color:#fff">
      <div style="font-weight:600;margin-bottom:8px">${title}</div>
      <input id="idr_input" type="text" placeholder="${placeholder}"
             style="width:100%;padding:8px;font:14px/1.3 system-ui, sans-serif;margin-bottom:10px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:#111;color:#fff"/>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn-secondary" id="idr_cancel"
                style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer">Cancel</button>
        <button class="btn-primary"  id="idr_go"
                style="background:#2a84ff;border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer">Search</button>
      </div>
    </div>
  `;

  document.body.appendChild(dlg);

  // Prevent canvas panning & global click closers from swallowing events
  if (typeof captureUI === 'function') captureUI(dlg);

  const input = dlg.querySelector('#idr_input');
  const cancelBtn = dlg.querySelector('#idr_cancel');
  const goBtn = dlg.querySelector('#idr_go');

  const close = () => dlg.remove();
  cancelBtn.onclick = close;

  const submit = async () => {
    const raw = input.value.trim();
    if (!raw) { showToast?.('Please enter an ID.'); return; }
    close();
    await runIdRetrieval(mode, raw);
  };

  goBtn.onclick = submit;

  // Keyboard affordances
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter')  { e.preventDefault(); submit(); }
  });

  // Focus the input for immediate typing
  input.focus();
  input.select();
}


async function runIdRetrieval(mode, value) {
  try {
    const viaProxy = window.viaProxy; // if you have one; otherwise omit
    const normOA = (id) => {
      if (!id) return null;
      const m = String(id).match(/W\d+/i);
      return m ? `https://openalex.org/${m[0].toUpperCase()}` : String(id);
    };

    // 1) Resolve work
    let res;
    if (mode === 'doi') {
      // accept bare DOI or prefixed forms
      const doi = String(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
      res = await DataRetrieval.resolveByDOI(doi, { viaProxy });
    } else {
      // accept W123… or full URL
      const m = String(value).match(/W\d+/i);
      if (!m) { showToast('That does not look like a valid OpenAlex Works ID'); return; }
      const wid = m[0].toUpperCase();
      res = await DataRetrieval.resolveByWID(wid, { viaProxy });
    }

    const work = res.work;
    const oaUrl = normOA(work?.id);
    if (!oaUrl) { showToast('Could not resolve an OpenAlex ID for this record.'); return; }

    // 2) Already in graph?
    if (oaIdToNode?.has(oaUrl)) {
      showToast('Already present in the visualisation.');
      // Optionally flash/select the node:
      // focusNode(oaIdToNode.get(oaUrl));
      return;
    }

    // 3) Create/Upsert node
    const seedIdx = null; // no seed—this is a direct add
    const idx = getOrCreateNodeForWork(work, seedIdx);
    oaIdToNode.set(oaUrl, idx);

// Mark as seed iff this is now a single-item graph        // ← ADD
if (itemsData.length === 1) {                              // ← ADD
  itemsData[idx].isSeed = true;                            // ← ADD
  itemsData[idx].seedSource = (mode === 'doi' ? 'doi' : 'openalex_id'); // ← ADD
}


    // 4) Link to existing nodes (outgoing)
    let outgoingLinks = 0, incomingLinks = 0;
    const refs =
      (Array.isArray(work?.referenced_works) && work.referenced_works) ||
      (Array.isArray(work?.referencedWorks)  && work.referencedWorks)  ||
      (Array.isArray(work?.referenced)       && work.referenced)       || [];

    for (const ref of refs) {
      const tgtIdx = oaIdToNode.get(normOA(ref));
      if (Number.isInteger(tgtIdx)) {
        ensureUndirectedEdge(idx, tgtIdx);
        outgoingLinks++;
      }
    }

    // 5) Link from existing nodes (incoming)
    // Scan existing nodes whose openalex.referenced_works includes this work
    for (let j = 0; j < nodes.length; j++) {
      if (j === idx) continue;
      const wj = nodes[j]?.openalex || nodes[j]?.work || nodes[j]?.data;
      const jRefs =
        (Array.isArray(wj?.referenced_works) && wj.referenced_works) ||
        (Array.isArray(wj?.referencedWorks)  && wj.referencedWorks)  ||
        (Array.isArray(wj?.referenced)       && wj.referenced)       || [];
      if (jRefs.some(r => normOA(r) === oaUrl)) {
        ensureUndirectedEdge(j, idx);
        incomingLinks++;
      }
    }

    // 6) Refresh graph + UI (reuse your existing pipeline)
    buildAdjacency(nodes.length, edges);
    computeDegreesFromAdj?.();
    ensureVelArrays?.();
    if (typeof degSlider?.value === 'function' && Number(degSlider.value()) > 0) degSlider.value(0);
    buildDimensionsIndex?.();
    updateDimSections?.();
    setWorldSizeForN?.(nodes.length);
    recomputeVisibility?.();
    updateInfo?.();
    redraw?.();
    
// Expand filters so the new node can actually show up
if (typeof computeYearBounds === 'function') computeYearBounds();   // sets yearMin/Max and yearLo/Hi
if (typeof initYearFilterUI === 'function') initYearFilterUI();     // updates sliders/label

// If OA lens is on and this node isn't OA, temporarily disable it so it's visible
if (lenses?.openAccess && !nodes[idx]?.oa) {
  lenses.openAccess = false;
  // if you have a toggle UI, update it here too
}

// Clear cluster-size gating for single adds (0 = off)
if (typeof clusterSizeThreshold !== 'undefined' && clusterSizeThreshold > 0) {
  clusterSizeThreshold = 0;
}

// Recompute vis after filter tweaks
recomputeVisibility?.();

// Select and bring into view
selectNode?.(idx);
focusNode?.(idx, { minPxRadius: 6, preferFitWhenTiny: true });
redraw?.();




    if (Number.isInteger(idx)) {
  // bring it into view and show its info
  selectNode?.(idx);
  // for a tiny graph (1–5 nodes) fit nicely; otherwise just centre
  if (nodes.length <= 5) {
    fitWorldInView?.(60);        // zoom to fit the (small) world
  } else {
    centerCameraOnWorld?.();     // keep current zoom, pan to world centre
  }
  redraw?.();
}

    showToast(`Added 1 publication. Linked to ${outgoingLinks} it cites and ${incomingLinks} that cite it (existing items).`);

  } catch (err) {
    // DOIs occasionally fail due to non-registered records
    showToast(err?.message || 'Unable to retrieve the record.');
    console.error('[Retrieve]', err);
  }
}

// ---- L2 caps storage helpers ---------------------------------------------
function loadL2Caps(dir /* 'left' | 'right' */) {
  try {
    const raw = localStorage.getItem(`l2_${dir}_caps`);
    const caps = raw ? JSON.parse(raw) : null;
    if (caps && Number.isFinite(+caps.global) && Number.isFinite(+caps.perParent)) return caps;
  } catch {}
  // sensible defaults if none saved yet
  return { global: 200, perParent: 25 };
}
function saveL2Caps(dir, caps) {
  try { localStorage.setItem(`l2_${dir}_caps`, JSON.stringify({ 
    global: +caps.global|0, 
    perParent: +caps.perParent|0 
  })); } catch {}
}

// ---- L2 caps dialog -------------------------------------------------------
function openL2CapsDialog(dir /* 'left' | 'right' */, onConfirm /* (caps) => void */) {
  const caps = loadL2Caps(dir);

  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position:'fixed', inset:'0', background:'rgba(0,0,0,0.45)', zIndex:'10060',
    display:'flex', alignItems:'center', justifyContent:'center'
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    minWidth:'360px', maxWidth:'92vw', background:'#111',
    color:'#fff', border:'1px solid rgba(255,255,255,0.12)',
    borderRadius:'12px', padding:'14px 16px', boxShadow:'0 12px 40px rgba(0,0,0,0.45)',
    font:'14px/1.35 system-ui, -apple-system, Segoe UI, Roboto'
  });

  const title = document.createElement('div');
  title.innerHTML = `<b>L2 settings — ${dir === 'right' ? 'Cited (→)' : 'Cited-by (←)'} </b>`;
  title.style.marginBottom = '8px';

  const desc = document.createElement('div');
  desc.textContent = 'Choose limits for this expansion:';
  desc.style.opacity = '0.9';
  desc.style.marginBottom = '8px';

  const row1 = document.createElement('div');
  row1.style.display = 'flex'; row1.style.justifyContent = 'space-between'; row1.style.gap = '8px'; row1.style.marginBottom = '8px';
  const lblGlobal = document.createElement('label');
  lblGlobal.textContent = 'Global cap (max new works):';
  lblGlobal.style.flex = '1';
  const inpGlobal = document.createElement('input');
  Object.assign(inpGlobal, { type:'number', value:String(caps.global) });
  Object.assign(inpGlobal.style, { width:'120px', padding:'6px', background:'#000', color:'#fff', border:'1px solid #333', borderRadius:'8px' });

  const row2 = document.createElement('div');
  row2.style.display = 'flex'; row2.style.justifyContent = 'space-between'; row2.style.gap = '8px'; row2.style.marginBottom = '12px';
  const lblPer = document.createElement('label');
  lblPer.textContent = 'Per-parent cap (each seed):';
  lblPer.style.flex = '1';
  const inpPer = document.createElement('input');
  Object.assign(inpPer, { type:'number', value:String(caps.perParent) });
  Object.assign(inpPer.style, { width:'120px', padding:'6px', background:'#000', color:'#fff', border:'1px solid #333', borderRadius:'8px' });

  const actions = document.createElement('div');
  actions.style.display = 'flex'; actions.style.justifyContent = 'flex-end'; actions.style.gap = '8px';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { padding:'8px 10px', background:'#222', color:'#fff', border:'1px solid #333', borderRadius:'8px', cursor:'pointer' });
  const okBtn = document.createElement('button');
  okBtn.textContent = 'Continue';
  Object.assign(okBtn.style, { padding:'8px 10px', background:'#4b9bff', color:'#000', border:'1px solid #5aa7ff', borderRadius:'8px', cursor:'pointer', fontWeight:'600' });

  // layout
  row1.appendChild(lblGlobal); row1.appendChild(inpGlobal);
  row2.appendChild(lblPer);    row2.appendChild(inpPer);
  actions.appendChild(cancelBtn); actions.appendChild(okBtn);
  card.appendChild(title); card.appendChild(desc); card.appendChild(row1); card.appendChild(row2); card.appendChild(actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // handlers
  const close = () => overlay.remove();
  cancelBtn.onclick = close;

  okBtn.onclick = () => {
    const g = +inpGlobal.value|0, p = +inpPer.value|0;
    if (!(g > 0) || !(p > 0)) { window.showToast?.('Please enter positive integers.'); return; }
    if (p > g) { window.showToast?.('Per-parent cap cannot exceed global cap.'); return; }
    const picked = { global: g, perParent: p };
    saveL2Caps(dir, picked);
    close();
    onConfirm?.(picked);
  };

  // escape key
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  overlay.tabIndex = -1; overlay.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAlex: Retrieve by Journal (Source) — search by title -> pick -> fetch works
// ─────────────────────────────────────────────────────────────────────────────

function openJournalRetrievalDialog() {
  const dlg = document.createElement('div');
  dlg.className = 'glass-modal';
  Object.assign(dlg.style, {
    position:'fixed', inset:'0', background:'rgba(0,0,0,0.45)', backdropFilter:'blur(4px)',
    display:'flex', alignItems:'center', justifyContent:'center', zIndex:'10060'
  });

  dlg.innerHTML = `
    <div class="glass-card"
         style="padding:14px;min-width:560px;background:rgba(16,16,20,0.95);
                border:1px solid rgba(255,255,255,0.18);border-radius:10px;color:#fff">
      <div style="font-weight:600;margin-bottom:8px">Retrieve by Journal (OpenAlex)</div>

      <label style="display:block;margin:0 0 6px">Journal title</label>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input id="jrnl_query" type="text" placeholder="e.g. Nature, PNAS, Journal of X…"
               style="flex:1;padding:8px;font:14px/1.3 system-ui;border-radius:6px;
                      border:1px solid rgba(255,255,255,0.2);background:#111;color:#fff"/>
        <button id="jrnl_search"
                style="background:#2a84ff;border:1px solid rgba(255,255,255,0.2);
                       color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer">Search</button>
      </div>

      <div id="jrnl_results"
           style="max-height:280px;overflow:auto;border:1px solid rgba(255,255,255,0.12);
                  border-radius:8px;padding:6px;display:none"></div>

      <div id="jrnl_sel"
           style="display:none;margin-top:10px;padding:8px;border:1px dashed rgba(255,255,255,0.18);border-radius:8px">
        <div id="jrnl_sel_name" style="font-weight:600"></div>
        <div id="jrnl_sel_meta" style="opacity:0.8;margin-top:4px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
          <button id="jrnl_cancel"
                  style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);
                         color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer">Cancel</button>
          <button id="jrnl_go"
                  style="background:#2a84ff;border:1px solid rgba(255,255,255,0.2);
                         color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer">Retrieve</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(dlg);
  if (typeof captureUI === 'function') captureUI(dlg);

  const qInput   = dlg.querySelector('#jrnl_query');
  const resDiv   = dlg.querySelector('#jrnl_results');
  const selBox   = dlg.querySelector('#jrnl_sel');
  const selName  = dlg.querySelector('#jrnl_sel_name');
  const selMeta  = dlg.querySelector('#jrnl_sel_meta');
  const btnSearch= dlg.querySelector('#jrnl_search');
  const btnGo    = dlg.querySelector('#jrnl_go');
  const btnCancel= dlg.querySelector('#jrnl_cancel');

  let selected = null; // { id: 'https://openalex.org/S123…', display_name, works_count, issn_l, host_organization_name, ... }

  const close = () => dlg.remove();

  async function doSearch() {
    const q = (qInput.value || '').trim();
    if (!q) { showToast?.('Enter a journal title to search.'); return; }
    resDiv.style.display = 'block';
    resDiv.innerHTML = `<div style="opacity:.8;padding:8px">Searching…</div>`;

    try {
      const viaProxy = window.viaProxy;
      const base = 'https://api.openalex.org/sources';
      const url  = prox(`${base}?search=${encodeURIComponent(q)}&per-page=25`);
      const r = await fetch(url, { headers: { 'accept':'application/json' }});
      if (!r.ok) throw new Error(`Search failed (${r.status})`);
      const j = await r.json();
      const results = Array.isArray(j?.results) ? j.results : [];
      if (!results.length) {
        resDiv.innerHTML = `<div style="opacity:.8;padding:8px">No journals found for “${q}”.</div>`;
        return;
      }
      resDiv.innerHTML = '';
      results.forEach(src => {
        const row = document.createElement('div');
        row.style.padding = '8px';
        row.style.borderRadius = '6px';
        row.style.cursor = 'pointer';
        row.onmouseenter = ()=> row.style.background = 'rgba(255,255,255,0.06)';
        row.onmouseleave = ()=> row.style.background = 'transparent';
        row.innerHTML = `
          <div style="font-weight:600">${src.display_name || '(untitled journal)'}</div>
          <div style="opacity:.8;font-size:12px;margin-top:2px">
            Works: ${Number(src.works_count||0).toLocaleString()}${src.issn_l ? ` · ISSN-L: ${src.issn_l}`:''}
          </div>
        `;
        row.onclick = () => {
          selected = src;
          selName.textContent = src.display_name || '(untitled journal)';
          selMeta.textContent = `Total publications in OpenAlex: ${Number(src.works_count||0).toLocaleString()}`;
          selBox.style.display = 'block';
          // light highlight
          row.style.background = 'rgba(42,132,255,0.18)';
        };
        resDiv.appendChild(row);
      });
    } catch (e) {
      console.error(e);
      resDiv.innerHTML = `<div style="color:#f66;padding:8px">Error: ${e.message || e}</div>`;
    }
  }

  async function doRetrieve() {
    if (!selected?.id) { showToast?.('Please select a journal first.'); return; }
    close();
    await retrieveAllWorksForJournal(selected);
  }

  btnSearch.onclick = doSearch;
  btnGo.onclick     = doRetrieve;
  btnCancel.onclick = close;

  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && document.activeElement === qInput) { e.preventDefault(); doSearch(); }
  });

  qInput.focus();
  qInput.select();
}

// Fetch & stream works for a given OpenAlex Source (journal) into the graph
// Fetch & stream works for a given OpenAlex Source (journal) into the graph
async function retrieveAllWorksForJournal(src) {
  try {
    const sourceId = (src?.id || '').replace(/^https?:\/\/openalex\.org\//i, '');
    if (!sourceId || !/^S\d+$/i.test(sourceId)) throw new Error('Invalid OpenAlex Source ID');

    showLoading(`Retrieving works: ${src.display_name || 'journal'}`, 0.02);

    const total   = Number(src.works_count || 0);
    const perPage = 200;     // OpenAlex max
    let   cursor  = '*';
    let   fetched = 0;
    const seedIdx = null;    // place around view centre / seedless
    const base    = 'https://api.openalex.org/works';
    const filter  = `primary_location.source.id:${sourceId}`;
    let   page    = 0;

    while (cursor) {
      page++;
      const full = `${base}?filter=${encodeURIComponent(filter)}&per-page=${perPage}&cursor=${encodeURIComponent(cursor)}`;
      const url  = prox(full);                         // ← always go via prox()

      const r = await fetch(url, { headers: { 'accept':'application/json' }});
      if (!r.ok) throw new Error(`Works fetch failed (${r.status})`);

      const j = await r.json();
      const works = Array.isArray(j?.results) ? j.results : [];
      fetched += works.length;

      // Stream nodes + their intra-batch edges
      integrateWorksAndEdges(seedIdx, works, null);
        if (sinceLastRefresh >= 2000) {      // tune: refresh ~every 2k items
    onGraphDataChanged();
    sinceLastRefresh = 0;
    await nextTick();
  }

      // Progress
      const pct = total ? Math.min(1, fetched / total) : (page % 10) / 10;
      setLoadingProgress(pct, `Retrieved ${fetched.toLocaleString()} of ${total ? total.toLocaleString() : '…'}`);

      // Cursor paging
      cursor = j?.meta?.next_cursor || null;

      // Yield to UI if helper exists
      if (typeof nextTick === 'function') await nextTick();
      else await new Promise(r => setTimeout(r, 0));
    }

    hideLoading();
    onGraphDataChanged();
    msg = `Imported ${fetched.toLocaleString()} works from “${src.display_name || 'journal'}” ✓`;
    updateInfo?.(); redraw?.();

  } catch (e) {
    hideLoading?.();
    console.error(e);
    showToast?.(e?.message || 'Journal import failed.');
    msg = `Import failed: ${e.message || e}`;
    updateInfo?.(); redraw?.();
  }
onGraphDataChanged();
}
function prox(url) {
  const vp = window.viaProxy;
  if (typeof vp === 'function') return vp(url); // your existing wrapper
  if (typeof vp === 'string' && vp) return vp + url;

  if (typeof FETCH_PROXY === 'string' && FETCH_PROXY) {
    // ✅ correct pattern for your proxy:
    return `${FETCH_PROXY}/fetch?url=${encodeURIComponent(url)}`;
  }
  return url; // no proxy
}
// Call this after *any* import that adds nodes/edges
function onGraphDataChanged() {
  try {
// 0) External citations bounds & slider (OpenAlex 'cited_by_count')
if (Array.isArray(nodes) && nodes.length) {
  let maxC = 0, minC = Infinity;
  for (const n of nodes) {
    const c = Number(n?.cbc || 0);
    if (c > maxC) maxC = c;
    if (c < minC) minC = c;
  }
  cbcMin = Number.isFinite(minC) ? minC : 0;
  cbcMax = maxC;
  if (extCitesThreshold > cbcMax) extCitesThreshold = cbcMax;  // clamp if needed
  initExtCitesFilterUI?.();  // refresh min/max/value + label
}


    // 1) (Re)build adjacency & degrees (affects Internal Citations slider)
    buildAdjacency(nodes.length|0, edges);          // existing helper
    computeDegreesFromAdj();                        // updates degree[] & degreeMax
    initDegreeFilterUI();                           // updates the slider to new max

    // 2) Year bounds from nodes[] and refresh the year sliders
    computeYearBounds();                            // sets yearMin/yearMax & yearLo/yearHi
    initYearFilterUI();                             // writes into your p5 sliders + label

    // 3) Recompute visibility with the new bounds & refresh UI
    recomputeVisibility();                          // rebuilds visibleMask + edgesFiltered
    updateInfo?.();                                 // bottom-right counts
    updateDimSections?.();                          // keep Dimensions in sync
    redraw?.();

    // (optional) notify listeners
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('macroscope:dataChanged', {
        detail: { yearMin, yearMax, degreeMax }
      }));
    }
  } catch (e) {
    console.warn('onGraphDataChanged failed:', e);
  }
}


function computeFilterBoundsFromGraph() {
  // Be defensive about where nodes/edges live:
  const nodes = (window.gNodes || window.nodes || window.allNodes || []).filter(n =>
    n && (n.type === 'work' || n.kind === 'work' || n.isWork)
  );

  // Year extraction (prefer your normalized fields if present)
  const years = nodes
    .map(n => Number(n.year ?? n.published_year ?? n.publication_year))
    .filter(y => Number.isFinite(y));

  const yearMin = years.length ? Math.min(...years) : 1900;
  const yearMax = years.length ? Math.max(...years) : (new Date()).getFullYear();

  // Internal citations = citations between works that are *both* in the current graph
  // Try to use an existing edge list; fall back gracefully
  const edges = (window.gEdges || window.links || window.allEdges || []).filter(e =>
    e && (e.type === 'citation' || e.kind === 'citation' || e.isCitation)
  );

  const idOf = n => n.id || n.key || n.oaid || n.openalex_id;
  const idSet = new Set(nodes.map(idOf).filter(Boolean));

  const internalInCounts = new Map(); // targetId -> count
  for (const n of nodes) internalInCounts.set(idOf(n), 0);

  for (const e of edges) {
    const src = e.source?.id ?? e.source?.key ?? e.source ?? e.from ?? e.u;
    const dst = e.target?.id ?? e.target?.key ?? e.target ?? e.to ?? e.v;
    if (!src || !dst) continue;
    if (idSet.has(src) && idSet.has(dst)) {
      internalInCounts.set(dst, (internalInCounts.get(dst) || 0) + 1);
    }
  }

  const internalVals = Array.from(internalInCounts.values());
  const internalMin = internalVals.length ? Math.min(...internalVals) : 0;
  const internalMax = internalVals.length ? Math.max(...internalVals) : 0;

  return { yearMin, yearMax, internalMin, internalMax };
}

function applyFilterBoundsToUI({ yearMin, yearMax, internalMin, internalMax }) {
  // YEAR controls (sliders + readouts)
  const yMinEl = document.getElementById('flt_year_min') 
              || document.querySelector('[data-role="year-min"]');
  const yMaxEl = document.getElementById('flt_year_max') 
              || document.querySelector('[data-role="year-max"]');
  const yRangeEl = document.getElementById('flt_year_range') 
                || document.querySelector('[data-role="year-range"]'); // dual slider widget?

  if (yMinEl) { yMinEl.min = yearMin; yMinEl.max = yearMax; if (!yMinEl.value) yMinEl.value = yearMin; }
  if (yMaxEl) { yMaxEl.min = yearMin; yMaxEl.max = yearMax; if (!yMaxEl.value) yMaxEl.value = yearMax; }
  // If you use a single dual-slider control, set its dataset or API accordingly:
  if (yRangeEl && typeof yRangeEl.setRange === 'function') yRangeEl.setRange(yearMin, yearMax);

  const yMinLbl = document.getElementById('lbl_year_min') || document.querySelector('[data-role="year-min-label"]');
  const yMaxLbl = document.getElementById('lbl_year_max') || document.querySelector('[data-role="year-max-label"]');
  if (yMinLbl) yMinLbl.textContent = String(yMinEl?.value ?? yearMin);
  if (yMaxLbl) yMaxLbl.textContent = String(yMaxEl?.value ?? yearMax);

  // INTERNAL CITATIONS controls
  const icMinEl = document.getElementById('flt_internal_min') 
               || document.querySelector('[data-role="internal-min"]');
  const icMaxEl = document.getElementById('flt_internal_max') 
               || document.querySelector('[data-role="internal-max"]');
  if (icMinEl) { icMinEl.min = internalMin; icMinEl.max = internalMax; if (!icMinEl.value) icMinEl.value = internalMin; }
  if (icMaxEl) { icMaxEl.min = internalMin; icMaxEl.max = internalMax; if (!icMaxEl.value) icMaxEl.value = internalMax; }

  const icMinLbl = document.getElementById('lbl_internal_min') || document.querySelector('[data-role="internal-min-label"]');
  const icMaxLbl = document.getElementById('lbl_internal_max') || document.querySelector('[data-role="internal-max-label"]');
  if (icMinLbl) icMinLbl.textContent = String(icMinEl?.value ?? internalMin);
  if (icMaxLbl) icMaxLbl.textContent = String(icMaxEl?.value ?? internalMax);
}
function initExtCitesFilterUI() {
  if (!extCitesSlider) return;
  const max = Math.max(0, Number(cbcMax || 0));
  extCitesSlider.elt.min = '0';
  extCitesSlider.elt.max = String(max);
  if (extCitesThreshold > max) extCitesThreshold = max;
  extCitesSlider.elt.value = String(extCitesThreshold|0);
  if (extCitesLabel) {
    extCitesLabel.html(`External citations ≥ ${extCitesThreshold}${max?` (max ${max})`:''}`);
  }
  if (extCitesInput) {                    // NEW
    extCitesInput.attribute('max', String(max));
    extCitesInput.elt.value = String(extCitesThreshold|0);
  }
}


function initClusterFilterUI() {
  if (!clusterSizeSlider) return;
  const max = (Array.isArray(clusterSizesTotal) && clusterSizesTotal.length)
            ? Math.max(...clusterSizesTotal)
            : (nodes.length|0);
  clusterSizeSlider.elt.min = '0';
  clusterSizeSlider.elt.max = String(max);
  if (clusterSizeThreshold > max) clusterSizeThreshold = max;
  clusterSizeSlider.elt.value = String(clusterSizeThreshold|0);
  if (clusterSizeLabel) clusterSizeLabel.html(`Show clusters ≥ ${clusterSizeThreshold} nodes`);
  if (clusterSizeInput) {                  // NEW
    clusterSizeInput.attribute('max', String(max));
    clusterSizeInput.elt.value = String(clusterSizeThreshold|0);
  }
}


function mixRGB(a, b, t){
  const u = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0]*u + b[0]*(1-u)),
    Math.round(a[1]*u + b[1]*(1-u)),
    Math.round(a[2]*u + b[2]*(1-u)),
  ];
}

function buildFiltersInto(containerBody) {
  if (!containerBody) return;

  // small field factory
  const mkNum = (init, {min=0, max=999999, step=1}={}, onChange) => {
    const i = createInput(String(init|0), 'number');
    i.parent(containerBody);
    i.attribute('min', String(min));
    i.attribute('max', String(max));
    i.attribute('step', String(step));
    i.style('width','72px');
    i.style('margin','0 0 10px');
    i.style('padding','4px 6px');
    i.style('font-size','12px');
    i.style('color','#fff');                // white text
    i.style('background','#000');           // black bg (subtle blend in this UI)
    i.style('border','1px solid #333');
    i.style('border-radius','6px');
    captureUI?.(i.elt);
    const apply = () => { if (onChange) onChange(Number(i.value())); };
    i.changed(apply);   // fires on Enter/blur
    i.input(()=>{});    // keep responsive without recompute on every key
    return i;
  };

  // --- External citations ---
  extCitesLabel = createDiv(`External citations ≥ ${extCitesThreshold|0}`);
  extCitesLabel.parent(containerBody);
  extCitesLabel.style('color','#eaeaea');
  extCitesLabel.style('font-size','12px');
  extCitesLabel.style('margin','0 0 6px');

  // Slider
  extCitesSlider = createSlider(0, cbcMax|0, extCitesThreshold|0, 1);
  extCitesSlider.parent(containerBody);
  extCitesSlider.style('width','100%');
  extCitesSlider.style('margin','0 0 6px');
  captureUI?.(extCitesSlider.elt);

  // Number input (clamped to current max)
  extCitesInput = mkNum(extCitesThreshold|0, { min:0, max:(cbcMax|0), step:1 }, (v)=>{
    const max = Math.max(0, cbcMax|0);
    extCitesThreshold = clamp(v|0, 0, max);
    extCitesSlider.elt.value = String(extCitesThreshold);
    extCitesLabel.html(`External citations ≥ ${extCitesThreshold}${max?` (max ${max})`:''}`);
    recomputeVisibility(); redraw();
  });

  extCitesSlider.input(() => {
    const max = Math.max(0, cbcMax|0);
    extCitesThreshold = clamp(Number(extCitesSlider.value())|0, 0, max);
    extCitesLabel.html(`External citations ≥ ${extCitesThreshold}${max?` (max ${max})`:''}`);
    if (extCitesInput) extCitesInput.elt.value = String(extCitesThreshold);
    recomputeVisibility(); redraw();
  });

  // --- Internal citations ---
  degLabel = createDiv(`Internal citations ≥ ${degThreshold|0}`);
  degLabel.parent(containerBody);
  degLabel.style('color','#eaeaea');
  degLabel.style('font-size','12px');
  degLabel.style('margin','10px 0 6px');

  degSlider = createSlider(0, degreeMax|0, degThreshold|0, 1);
  degSlider.parent(containerBody);
  degSlider.style('width','100%');
  degSlider.style('margin','0 0 6px');
  captureUI(degSlider.elt);

  degInput = mkNum(degThreshold|0, { min:0, max:(degreeMax|0), step:1 }, (v)=>{
    const max = degreeMax|0;
    degThreshold = clamp(v|0, 0, max);
    degSlider.elt.value = String(degThreshold);
    updateDegLabel?.();            // keeps "(max N)" text consistent
    applyDegreeFilter(degThreshold);
  });

  degSlider.input(() => {
    const max = degreeMax|0;
    degThreshold = clamp(Number(degSlider.value())|0, 0, max);
    if (degInput) degInput.elt.value = String(degThreshold);
    updateDegLabel?.();
    applyDegreeFilter(degThreshold);
  });

  // --- Cluster size ---
  clusterSizeLabel = createDiv(`Show clusters ≥ ${clusterSizeThreshold|0} nodes`);
  clusterSizeLabel.parent(containerBody);
  clusterSizeLabel.style('color','#eaeaea');
  clusterSizeLabel.style('font-size','12px');
  clusterSizeLabel.style('margin','10px 0 6px');

  // use a safe initial max; tightened post-cluster-compute via initClusterFilterUI()
  const clMaxInit = nodes.length|0;
  clusterSizeSlider = createSlider(0, clMaxInit, clusterSizeThreshold|0, 1);
  clusterSizeSlider.parent(containerBody);
  clusterSizeSlider.style('width','100%');
  clusterSizeSlider.style('margin','0 0 6px');
  captureUI?.(clusterSizeSlider.elt);

  clusterSizeInput = mkNum(clusterSizeThreshold|0, { min:0, max:clMaxInit, step:1 }, (v)=>{
    const max = (Array.isArray(clusterSizesTotal) && clusterSizesTotal.length)
              ? Math.max(...clusterSizesTotal) : (nodes.length|0);
    clusterSizeThreshold = clamp(v|0, 0, max);
    clusterSizeSlider.elt.value = String(clusterSizeThreshold);
    clusterSizeLabel.html(`Show clusters ≥ ${clusterSizeThreshold} nodes`);
    recomputeVisibility(); redraw();
  });

  clusterSizeSlider.input(() => {
    const max = (Array.isArray(clusterSizesTotal) && clusterSizesTotal.length)
              ? Math.max(...clusterSizesTotal) : (nodes.length|0);
    clusterSizeThreshold = clamp(Number(clusterSizeSlider.value())|0, 0, max);
    clusterSizeLabel.html(`Show clusters ≥ ${clusterSizeThreshold} nodes`);
    if (clusterSizeInput) clusterSizeInput.elt.value = String(clusterSizeThreshold);
    recomputeVisibility(); redraw();
  });

  // --- Year range (two fields) ---
  const labelYears = (lo, hi) => `Year range: ${lo||yearMin} – ${hi||yearMax}`;
  yearLabel = createDiv(labelYears(yearLo, yearHi));
  yearLabel.parent(containerBody);
  yearLabel.style('color','#eaeaea');
  yearLabel.style('font-size','12px');
  yearLabel.style('margin','10px 0 6px');

  // Stack the sliders
  const yearWrap = createDiv('');
  yearWrap.parent(containerBody);
  yearWrap.style('display','block');
  yearWrap.style('min-width','0');

  yearSliderMin = createSlider(yearMin|0, yearMax|0, yearLo||yearMin||0, 1);
  yearSliderMin.parent(yearWrap);
  yearSliderMin.style('display','block');
  yearSliderMin.style('width','100%');
  captureUI(yearSliderMin.elt);

  yearSliderMax = createSlider(yearMin|0, yearMax|0, yearHi||yearMax||0, 1);
  yearSliderMax.parent(yearWrap);
  yearSliderMax.style('display','block');
  yearSliderMax.style('width','100%');
  captureUI(yearSliderMax.elt);

  // Two compact inputs on one row
  const yrRow = createDiv('');
  yrRow.parent(containerBody);
  yrRow.style('display','flex');
  yrRow.style('gap','8px');
  yrRow.style('margin','6px 0 0');

  const yrMinWrap = createDiv('');
  yrMinWrap.parent(yrRow);
  const yrMaxWrap = createDiv('');
  yrMaxWrap.parent(yrRow);

  yearLoInput = mkNum(yearLo||yearMin, { min:yearMin, max:yearMax, step:1 }, (v)=>{
    const lo = clamp(v|0, yearMin|0, yearMax|0);
    yearLo = Math.min(lo, yearHi);                      // keep order
    yearSliderMin.elt.value = String(yearLo);
    yearLabel.html(labelYears(yearLo, yearHi));
    applyYearFilter();
  });
  yearLoInput.parent(yrMinWrap);

  yearHiInput = mkNum(yearHi||yearMax, { min:yearMin, max:yearMax, step:1 }, (v)=>{
    const hi = clamp(v|0, yearMin|0, yearMax|0);
    yearHi = Math.max(hi, yearLo);
    yearSliderMax.elt.value = String(yearHi);
    yearLabel.html(labelYears(yearLo, yearHi));
    applyYearFilter();
  });
  yearHiInput.parent(yrMaxWrap);

  // Slider handlers (keep your existing behavior)
  yearSliderMin.input(() => {
    const v = Number(yearSliderMin.value());
    if (v > yearHi) { yearHi = v; yearSliderMax.elt.value = String(yearHi); if (yearHiInput) yearHiInput.elt.value = String(yearHi); }
    yearLo = v;
    yearLabel.html(labelYears(yearLo, yearHi));
    if (yearLoInput) yearLoInput.elt.value = String(yearLo);
    applyYearFilter();
  });

  yearSliderMax.input(() => {
    const v = Number(yearSliderMax.value());
    if (v < yearLo) { yearLo = v; yearSliderMin.elt.value = String(yearLo); if (yearLoInput) yearLoInput.elt.value = String(yearLo); }
    yearHi = v;
    yearLabel.html(labelYears(yearLo, yearHi));
    if (yearHiInput) yearHiInput.elt.value = String(yearHi);
    applyYearFilter();
  });
}


function mountDimensionsInto(containerBody) {
  if (!containerBody) return;
  if (!dimSidebar) createDimensionsSidebar(); // ensure it exists
  try {
    containerBody.appendChild(dimSidebar.elt);
    dimSidebar.elt.classList.add('dim-scroll');

    // Flow inside accordion, not fixed
    dimSidebar.style('position','static');
    dimSidebar.style('left','');
    dimSidebar.style('top','');
    dimSidebar.style('width','100%');

    // Remove the “inner panel” chrome so we don’t see panel-in-panel
    dimSidebar.style('background','transparent');
    dimSidebar.style('border','none');
    dimSidebar.style('box-shadow','none');
    dimSidebar.style('backdrop-filter','none');
    dimSidebar.style('padding','0');

    // Keep the content scrollable but within the accordion body
    dimSidebar.style('max-height','400px');
    dimSidebar.style('overflow','auto');

    themeDimensionsScrollbars();
    polishDimensionsUI();   // removes any duplicate inner titles, styles buttons
  } catch {}
}


function buildOverlaysInto(containerBody) {
  const mkSlider = (label, init, onInput) => {
    const row = createDiv('');
    row.parent(containerBody);
    row.style('display','flex');
    row.style('align-items','center');
    row.style('justify-content','space-between');
    row.style('gap','10px');
    row.style('margin','0 0 8px');

    const lab = createDiv(label);
    lab.parent(row);
    lab.style('color','#eaeaea');
    lab.style('font-size','12px');

    const sl = createSlider(0, 100, init|0, 1);
    sl.parent(row);
    sl.style('width','120px');
    captureUI?.(sl.elt);
    if (onInput) sl.input(onInput);
    return sl;
  };

  // Abstracts
  mkSlider('Abstracts', Math.round(ovAbstracts*100), (e) => {
    ovAbstracts = Number(e.target.value)/100;
    redraw();
  });

  // Open Access
  mkSlider('Open Access', Math.round(ovOpenAccess*100), (e) => {
    ovOpenAccess = Number(e.target.value)/100;
    redraw();
  });

  // Clusters
// Clusters (node colours)
mkSlider('Clusters', Math.round(ovClusterColors*100), (e) => {
  ovClusterColors = Number(e.target.value)/100;

  // Lens is on if either colours or labels are on
  lenses.domainClusters = (ovClusterColors > 0) || (ovClusterLabels > 0);

  if (lenses.domainClusters) {
    if (!Array.isArray(clusterOf) || clusterOf.length !== nodes.length || !clusterCount || !clusterColors?.length) {
      computeDomainClusters();
      computeClusterLabels?.();
      buildDimensionsIndex?.();
    }
  }
  redraw();
});

// Cluster Labels (pill UI + click)
mkSlider('Cluster Labels', Math.round(ovClusterLabels*100), (e) => {
  ovClusterLabels = Number(e.target.value)/100;

  // Lens is on if either colours or labels are on
  lenses.domainClusters = (ovClusterColors > 0) || (ovClusterLabels > 0);

  if (lenses.domainClusters) {
    if (!Array.isArray(clusterOf) || clusterOf.length !== nodes.length || !clusterCount || !clusterColors?.length) {
      computeDomainClusters();
      computeClusterLabels?.();
      buildDimensionsIndex?.();
    }
  }

  // If labels are fully off, also clear hover/selection and hits so they’re not clickable.
  if (ovClusterLabels === 0) {
    clusterHoverId = -1;
    clusterSelectId = -1;
    clusterLabelHits = [];
  }
  redraw();
});

}



function polishDimensionsUI() {
  if (!dimSidebar?.elt) return;

  // 1) Remove the inner "Dimensions" title so it doesn’t duplicate the accordion header
  try {
    // Try common selectors first
    const dupTitle =
      dimSidebar.elt.querySelector('.dimensions-title, .dim-header, .section-title, h2, h3');
    if (dupTitle && /dimensions/i.test(dupTitle.textContent.trim())) {
      dupTitle.remove();
    }
  } catch {}

  // 2) Style the Search and Clear (×) controls
  try {
    // Adjust these selectors to your actual markup if needed
    const searchBtn = dimSidebar.elt.querySelector('.dim-search-btn, button[data-role="dim-search"]')
                      || dimSidebar.elt.querySelector('button'); // fallback: first button
    const clearBtn  = dimSidebar.elt.querySelector('.dim-clear-btn, [data-role="dim-clear"]');

    // Search button: white text (keep existing background)
    if (searchBtn) {
      searchBtn.style.color = '#fff';
      // keep your current bg; if you want explicit, uncomment:
      // searchBtn.style.background = '#000';
      // searchBtn.style.border = '1px solid #444';
    }

    // Clear button: white cross on black bg with thin grey border
    if (clearBtn) {
      clearBtn.textContent = '×';
      clearBtn.style.color = '#fff';
      clearBtn.style.background = '#000';
      clearBtn.style.border = '1px solid #555'; // thin grey line, matching inputs
      clearBtn.style.borderRadius = '6px';
      clearBtn.style.width = '28px';
      clearBtn.style.height = '28px';
      clearBtn.style.display = 'flex';
      clearBtn.style.alignItems = 'center';
      clearBtn.style.justifyContent = 'center';
      clearBtn.style.lineHeight = '0';
      clearBtn.style.fontSize = '18px';
      clearBtn.style.cursor = 'pointer';
    }

    // Optional: make the input’s border match, if needed
    const searchInput = dimSidebar.elt.querySelector('.dim-search-input, input[type="search"], input[type="text"]');
    if (searchInput) {
      searchInput.style.border = '1px solid #555';
      searchInput.style.background = '#000';
      searchInput.style.color = '#fff';
    }
  } catch {}
}

// Injects CSS for custom scrollbars and tags all scrollable children
function themeDimensionsScrollbars() {
  // 1) Install CSS (WebKit + Firefox)
  if (!document.getElementById('dim-scrollbar-css')) {
    const css = `
      /* Firefox */
      .dim-scroll {
        scrollbar-width: thin;
        scrollbar-color: #ffffff rgb(10,10,10);
      }
      /* WebKit (Chrome, Edge, Safari) */
      .dim-scroll::-webkit-scrollbar {
        width: 10px;
        height: 10px;
      }
      .dim-scroll::-webkit-scrollbar-track {
        background: rgb(10,10,10);
      }
      .dim-scroll::-webkit-scrollbar-thumb {
        background: #ffffff;
        border-radius: 8px;
        border: 2px solid rgb(10,10,10); /* keeps the white thumb crisp on dark */
      }
    `;
    const style = document.createElement('style');
    style.id = 'dim-scrollbar-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // 2) Add class to every actually-scrollable element inside the sidebar
  if (!window.dimSidebar?.elt) return;
  const all = [window.dimSidebar.elt, ...window.dimSidebar.elt.querySelectorAll('*')];
  all.forEach(el => {
    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    const ox = cs.overflowX;
    const canScrollY = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight;
    const canScrollX = (ox === 'auto' || ox === 'scroll') && el.scrollWidth  > el.clientWidth;
    if (canScrollY || canScrollX) el.classList.add('dim-scroll');
  });
}



// ── Custom tooltip (white on black) ──────────────────────────────────────────
let __tooltipEl = null;

function ensureTooltipLayer() {
  if (__tooltipEl) return __tooltipEl;
  const el = document.createElement('div');
  el.id = 'macroscope-tooltip';
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '100060',
    background: '#000',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.25)',
    padding: '6px 8px',
    borderRadius: '8px',
    font: '12px/1.2 system-ui, -apple-system, Segoe UI, Roboto',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 120ms ease',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    // prevent layout jank when first shown
    left: '0px',
    top:  '0px'
  });
  document.body.appendChild(el);
  __tooltipEl = el;
  return el;
}

function attachTooltip(target, text) {
  const el = target?.elt || target;    // supports p5.Element or HTMLElement
  if (!el) return;
  el.removeAttribute?.('title');       // disable native tooltip
  const tip = ensureTooltipLayer();
  const OFFSET = 12;

  function move(e) {
    const x = (e.clientX || 0) + OFFSET;
    const y = (e.clientY || 0) + OFFSET;
    // Clamp to viewport
    const r = tip.getBoundingClientRect();
    const maxX = window.innerWidth  - r.width  - 8;
    const maxY = window.innerHeight - r.height - 8;
    tip.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    tip.style.top  = Math.max(8, Math.min(y, maxY)) + 'px';
  }
  function show(e) { tip.textContent = text; tip.style.opacity = '1'; move(e); }
  function hide()   { tip.style.opacity = '0'; }

  el.addEventListener('mouseenter', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('mousemove',  move);
  el.addEventListener('mousedown',  hide);
  el.addEventListener('touchstart', hide, { passive: true });

  // Already used across your UI to prevent canvas panning
  try { captureUI?.(el); } catch {}
}
async function restoreFromViewerIndex(indexObj) {
  // 1) Remember remote shard bases (used by lazy info + AI)
  const _PFX = (window.DATA_BASE_PREFIX || '');  // e.g. "Test_Data/"
function _joinBase(base) {
  if (!base) return null;
  if (/^([a-z]+:)?\/\//i.test(base) || base.startsWith('/')) return base; // absolute
  if (_PFX && !base.startsWith(_PFX)) {
    return _PFX.replace(/\/+$/,'/') + base.replace(/^\/+/,'');
  }
  return base;
}

const _detailsFromIndex = indexObj?.meta?.paths?.detailsBase;
const _aiFromIndex      = indexObj?.meta?.paths?.aiBase;

REMOTE_DETAILS_BASE = _joinBase(_detailsFromIndex) || REMOTE_DETAILS_BASE;
REMOTE_AI_BASE      = _joinBase(_aiFromIndex)      || REMOTE_AI_BASE;


  // 2) Build nodes directly from the fixed layout in the manifest
  const N = (indexObj.nodes || []).length;
  itemsData = new Array(N);   // keep API stable (some UI expects this)
  nodes = new Array(N);

  // degree[] may be provided or we recompute from edges
  const rawEdges = (indexObj.edges || []).map(e =>
    Array.isArray(e) ? { source: e[0]|0, target: e[1]|0 }
                     : { source: (e.s ?? e.source)|0, target: (e.t ?? e.target)|0 }
  );

  for (let i = 0; i < N; i++) {
    const nn = indexObj.nodes[i] || {};
    nodes[i] = {
      idx: i,
      x: +nn.x, y: +nn.y,
      r: nn.r || 3,
      label: nn.label || (nn.id || `n${i}`),
      cbc: nn.cbc|0,
      oa: !!nn.oa,
      year: Number.isFinite(+nn.year) ? +nn.year : NaN,
      hasAbs: !!nn.hasAbs,
        hasFullText: !!nn.hasFullText,
      idStr: (nn.id || '').replace(/^https?:\/\/openalex\.org\//i, '') || null,        // ← used for lazy detail fetch
        intIn: (Number.isFinite(+nn.intIn) ? (+nn.intIn|0) : undefined),  // ← NEW

    
    };
    // Minimal stub so InfoPanel doesn't crash if remote is unavailable
    itemsData[i] = { openalex: { id: nn.id || null, cited_by_count: nn.cbc|0,
                                 open_access: { is_oa: !!nn.oa } },
                     label: nodes[i].label };
  }

  // 3) Graph bookkeeping
  edges = rawEdges;
  buildAdjacency(N, edges);
  computeDegreesFromAdj();
  initDegreeFilterUI?.();
// Ensure internal in-degree exists and compute robust stats for parallax
(function ensureIntInAndStats() {
  const need = nodes.some(n => n && (n.intIn === undefined));
  if (need) {
    const inDeg = new Array(N).fill(0);
    for (const e of edges) {
      const t = (e.target|0);
      if (t>=0 && t<N) inDeg[t]++;
    }
    for (let i=0;i<N;i++) nodes[i].intIn = inDeg[i]|0;
  }
  computeIntInRobustStats();
  // Keep CBC percentiles ready for fallback
  computeCbcRobustStats?.();
})();



// 3.5) Initialise ranges required by filters (years + external citations)
computeYearBounds();            // sets yearMin/yearMax and yearLo/yearHi from nodes[]

cbcMin = Infinity; cbcMax = -Infinity;
for (const n of nodes) {
  const c = Number(n?.cbc || 0);
  if (c < cbcMin) cbcMin = c;
  if (c > cbcMax) cbcMax = c;
}
if (!Number.isFinite(cbcMin)) cbcMin = 0;
if (!Number.isFinite(cbcMax)) cbcMax = 0;
initExtCitesFilterUI?.();       // writes the External Citations UI



// 4) Clusters
if (Array.isArray(indexObj.nodes)) {
  clusterOf = indexObj.nodes.map(n => (Number.isFinite(+n.cluster) ? +n.cluster : -1));
}

// Determine clusterCount
const maxCid = Math.max(-1, ...(clusterOf || []).map(c => +c));
clusterCount = Math.max(0, maxCid + 1);

// Labels (from export snapshot)
{
  const labMap = indexObj?.clusters?.labels || {};
  const arr = new Array(clusterCount).fill('');
  for (const k in labMap) {
    const cid = (+k)|0;
    if (cid >= 0 && cid < clusterCount) arr[cid] = String(labMap[k] || '');
  }
  clusterLabels = arr;
}

// Colours (use saved palette when present)
if (Array.isArray(indexObj?.clusters?.colors) &&
    indexObj.clusters.colors.length === clusterCount) {
  clusterColors = indexObj.clusters.colors.map(c => Array.from(c));
} else {
  clusterColors = makeClusterColors(clusterCount);
}

// Total sizes per cluster (for overlay gating & slider bounds)
clusterSizesTotal = new Array(clusterCount).fill(0);
for (let i = 0; i < nodes.length; i++) {
  const cid = clusterOf[i];
  if (cid != null && cid >= 0) clusterSizesTotal[cid]++;
}

// Tighten the slider now that sizes are known
initClusterFilterUI?.();

// If you want to (re)derive label text from abstracts, you *can* call:
// computeClusterLabels?.();

// Make sure any cached cluster-label sprites / indices are rebuilt
const _hasImportedLabels =
  !!(indexObj?.clusters?.labels) && Object.keys(indexObj.clusters.labels).length > 0;
if (!_hasImportedLabels) {
  computeClusterLabels?.();
}

  // 5) Dimensions (read-only)
dimTools = (indexObj.dimensions || []).map(d => ({
  type: d.type || 'concepts',
  key:  `${d.type||'concepts'}|${d.label||''}`,
  label: d.label || '',
  cid: (d.cid!=null? d.cid : null),
  power: d.power|0,
  x: +d.x, y: +d.y,
  color: d.color || null,
  nodes: new Set(d.nodes || []),
  ...(d.type === 'ai' ? {
    aiSig:       d.aiSig || null,
    aiTitle:     d.aiTitle || d.label || null,
    aiContent:   d.aiContent || '',     // if empty, we’ll lazy-load from summaryRef
    aiCreatedAt: d.aiCreatedAt || null,
    summaryRef:  d.summaryRef || null
  } : {})
}));

//Dimensions index snapshot -> sidebar (Authors, Venues, Concepts, Institutions)
const hydrateDimMap = (targetMap, obj) => {
  targetMap.clear();
  if (!obj) return;
  for (const [key, arr] of Object.entries(obj)) {
    const s = new Set((arr || []).map(n => n|0));
    targetMap.set(String(key), { key: String(key), count: s.size, nodes: s });
  }
};

if (indexObj.dimIndex) {
  hydrateDimMap(dimsIndex.authors,      indexObj.dimIndex.authors);
  hydrateDimMap(dimsIndex.venues,       indexObj.dimIndex.venues);
  hydrateDimMap(dimsIndex.concepts,     indexObj.dimIndex.concepts);
  hydrateDimMap(dimsIndex.institutions, indexObj.dimIndex.institutions);
} else {
  // Fallback (light viewer packages): attempt to build from whatever we have
  buildDimensionsIndex?.();
}

// Always rebuild the "Clusters" section using clusterOf + clusterLabels
// (this keeps it in sync even if there was no snapshot)
(() => {
  dimsIndex.clusters.clear();
  if (Array.isArray(clusterOf) && clusterOf.length === itemsData.length && clusterCount > 0) {
    const byCid = new Map();
    for (let i = 0; i < itemsData.length; i++) {
      const cid = clusterOf[i]; if (cid == null || cid < 0) continue;
      const label = (clusterLabels[cid] && clusterLabels[cid].trim()) ? clusterLabels[cid] : `Cluster ${cid+1}`;
      let rec = byCid.get(cid);
      if (!rec) { rec = { cid, key: label, label, count: 0, nodes: new Set() }; byCid.set(cid, rec); }
      if (!rec.nodes.has(i)) { rec.nodes.add(i); rec.count++; }
    }
    for (const rec of byCid.values()) {
      // keep your size threshold behaviour
      if (rec.count > 10) dimsIndex.clusters.set(rec.label, rec);
    }
  }
})();

// Re-render the sidebar
renderDimensionsUI?.();
updateDimSections?.();


// Only rebuild Dimensions index if no snapshot was provided
if (!indexObj.dimIndex) {
  buildDimensionsIndex?.();
  renderDimensionsUI?.();
  updateDimSections?.();
}
  
  
  // 6) AI dimensions → aiFootprints (lazy text fetch later)
  window.aiFootprints = (indexObj.aiDimensions || []).map((a, j) => ({
    type: 'ai',
    title: String(a.label || a.id || `AI ${j+1}`),
    aiTitle: String(a.label || a.id || `AI ${j+1}`),
    nodeIds: Array.isArray(a.nodes) ? a.nodes.slice() : [],
    x: +a.x, y: +a.y,
    aiContent: '',                   // empty until fetched
    summaryRef: a.summaryRef || `${a.id || ('A'+(j+1))}.json`,
    createdAt: Date.now()
  }));
_syncAIDimsWithFootprints();

  // 7) Ranges/filters (optional: use provided)
  if (indexObj?.ranges?.year) {
    yearLo = +indexObj.ranges.year.min || yearLo;
    yearHi = +indexObj.ranges.year.max || yearHi;
  }
  if (indexObj?.ranges?.internalDegree) {
    degThreshold = Math.max(0, Math.min(degThreshold, +indexObj.ranges.internalDegree.max|0));
  }
  initYearFilterUI?.();   // <-- add this so sliders/label match yearLo/yearHi
  try {
    const m = indexObj?.meta || {};
    projectMeta = {
      title:   (m.userTitle ?? m.title ?? '').toString(),
      text:    (m.userText ?? m.text ?? '').toString(),
      created: (m.created ?? m.exported_at ?? '').toString()
    };
    
      hideProjectMetaPanel();
    
  } catch { hideProjectMetaPanel(); }

  // 8) Camera fit & UI refresh
  centerCameraOnWorld();
  recomputeVisibility?.();
  updateInfo(); redraw();
showCanvasOverviewIfNoneSelected();


}
function viewerNodeId(i) {
  // Prefer OpenAlex W-id; fallback to DOI; else stable local id.
  const w = itemsData?.[i]?.openalex || {};
  const id = (w.id || '').toString();
  const m = id.match(/(?:openalex\.org\/)?(W\d+)/i);
  if (m) return m[1];
  const doi = (w.doi || itemsData?.[i]?.doi || '').toString();
  if (doi) return doi.replace(/[^A-Za-z0-9]+/g,'_');
  return `N${i}`;
}
const toArray = (v) =>
  Array.isArray(v) ? v.slice()
  : (v && typeof v[Symbol.iterator] === 'function') ? Array.from(v)
  : [];

function buildViewerIndexObject(metaOverrides = null) {
  // ranges
  const nowIso = new Date().toISOString();
  const years = nodes.map(n => +n.year).filter(Number.isFinite);
  const cbc   = nodes.map(n => n.cbc|0);
  const yrMin = years.length ? Math.min(...years) : null;
  const yrMax = years.length ? Math.max(...years) : null;
  const cMin  = cbc.length   ? Math.min(...cbc)   : 0;
  const cMax  = cbc.length   ? Math.max(...cbc)   : 0;

  // cluster sizes + labels
  const sizes = {};
  (clusterOf || []).forEach(c => { if (c>=0) sizes[c] = (sizes[c]||0) + 1; });
  const labels = {};
  (Array.isArray(clusterLabels) ? clusterLabels : []).forEach((t,c)=>{ if (t) labels[c]=t; });

  // Make sure dimsIndex is up-to-date for snapshotting
if (typeof buildDimensionsIndex === 'function') buildDimensionsIndex();

  
  
  
  
  // dims
const dims = (dimTools || []).map(d => ({
  id: d.id || null,
  type: d.type,
  label: d.label,
  x: d.x,
  y: d.y,
  power: d.power|0,
  nodes: toArray(d.nodes),
  ...(d.type === 'ai' ? {
    aiSig:       d.aiSig || null,
    aiTitle:     d.aiTitle || d.label || null,
    aiContent:   d.aiContent || '',
    aiCreatedAt: d.aiCreatedAt || null,
    summaryRef:  d.summaryRef || null
  } : {})
}));

  // ai (summaryRef will be filled in export loop)
  const ai = (window.aiFootprints||[]).map((f,j)=>({
    id: `A${j+1}`,
    type: 'ai',
    label: f.aiTitle || f.title || `AI ${j+1}`,
    x: f.x, y: f.y,
    nodes: Array.from(f.nodeIds || []),
    summaryRef: `A${j+1}.json`
  }));
// Compute directed internal in-degrees for export
function computeInternalInDegrees(nCount, edgeList) {
  const inDeg = new Array(nCount).fill(0);
  for (const e of (edgeList || [])) {
    const t = (Array.isArray(e) ? e[1] : (e.t ?? e.target)) | 0;
    if (t >= 0 && t < nCount) inDeg[t]++;
  }
  return inDeg;
}
const __E_ARRAY = (edges||[]).map(e => [e.source|0, e.target|0]);
const __intInDeg = computeInternalInDegrees(nodes.length|0, __E_ARRAY);
const __intInMin = __intInDeg.length ? Math.min(...__intInDeg) : 0;
const __intInMax = __intInDeg.length ? Math.max(...__intInDeg) : 0;

  // nodes
  const simpleNodes = nodes.map((n,i)=>({
    id: viewerNodeId(i),
    idx: i,
    x: n.x, y: n.y, r: n.r||3,
    label: n.label || '',
    year: Number.isFinite(+n.year) ? +n.year : null,
    hasAbs: !!n.hasAbs,
    oa: !!n.oa,
    cbc: n.cbc|0,
     intIn: __intInDeg[i]|0,   // ← NEW
    deg: (degree?.[i] ?? 0)|0,
    cluster: (clusterOf?.[i] ?? -1)|0,
    hasFullText: !!(
    (itemsData?.[i]?.fulltext && String(itemsData[i].fulltext).trim()) ||
    n.hasFullText
  )

  }));

if (typeof buildDimensionsIndex === 'function') buildDimensionsIndex();

const snapshotMap = (map) => {
  const out = {};
  map.forEach((rec, key) => {
    out[key] = Array.from(rec.nodes || []).map(n => n|0).sort((a,b)=>a-b);
  });
  return out;
};


const dimIndexSnapshot = {
  authors:      snapshotMap(dimsIndex.authors),
  venues:       snapshotMap(dimsIndex.venues),
  concepts:     snapshotMap(dimsIndex.concepts),
  institutions: snapshotMap(dimsIndex.institutions)
};

  return {

    
    meta: {
      title: 'Macroscope export',
      version: 1,
      created: nowIso,
      counts: { nodes: nodes.length|0, edges: edges.length|0 },
      paths: { detailsBase: 'data/details/', aiBase: 'data/ai/' }
    },
ranges: {
  year: { min: yrMin, max: yrMax },
  internalDegree: { min: 0, max: (degreeMax|0) },
  internalIn: { min: __intInMin|0, max: __intInMax|0 },   // ← NEW
  citedBy: { min: cMin, max: cMax }
},

    nodes: simpleNodes,
    edges: (edges||[]).map(e => [e.source|0, e.target|0]),
    clusters: {
  count: Object.keys(sizes).length,
  labels,
  sizes,
  colors: (Array.isArray(clusterColors) && clusterColors.length
           ? clusterColors
           : makeClusterColors(Object.keys(sizes).length))
},
    dimensions: dims,
    dimIndex: dimIndexSnapshot,
    aiDimensions: ai,
    tooltips: true
  };
}

function buildViewerDetailsObject(i) {
  const it = itemsData?.[i] || {};
  const w  = it.openalex || {};
  const id = viewerNodeId(i);
  const authors = getAuthors(w);

  const venue = inferVenueNameFromWork(w, it.venue || '');

  const refs =
    (w.referenced_works_count ??
     (Array.isArray(w.referenced_works) ? w.referenced_works.length : undefined) ??
     w.biblio?.reference_count ??
     w.biblio?.references_count ??
     it.refsCount ??
     null);

  const doiClean = (typeof cleanDOI === 'function')
      ? cleanDOI(w.doi || it.doi || '')
      : (w.doi || it.doi || '');

  // Pick a good human URL (landing page > PDF > venue > OpenAlex > DOI)
  const doiUrl = doiClean ? `https://doi.org/${doiClean}` : '';
  const bestUrl = (typeof pickBestUrl === 'function') ? pickBestUrl(w, doiUrl) : (doiUrl || w?.id || '');

  // OA flags
  const oaObj = w.open_access || {};
  const oaStatus = oaObj.is_oa ? (oaObj.oa_status || '') : '';



  const oaLink = (typeof normOA === 'function') ? normOA(w.id) : (w.id || null);
  const abs = (it.openalex_abstract || (typeof getAbstract==='function' ? getAbstract(w) : '') || '').toString();

  return {
    id,
    title: w.display_name || w.title || (it.label || nodes?.[i]?.label || id),
    authors,
    venue,
    year: nodes?.[i]?.year || w.publication_year || w.biblio?.publication_year || null,
    doi: doiClean || null,
    url: bestUrl || null,
    openalex: oaLink,
    abstract: abs,
    is_oa: !!(w.open_access?.is_oa),
    oa_status: oaStatus || null,
    network: {
      internal_citations: (degree?.[i] ?? 0)|0,
      cited_by_count: w.cited_by_count|0
    },
    references: refs,
    networkCitations: (degree?.[i] ?? 0)|0,
    seed: !!it.isSeed
  };
}

async function exportViewerPackageZip(opts = {}) {

  projectMeta = {
  title: (opts.userTitle || '').toString(),
  text:  (opts.userText  || '').toString(),
  created: new Date().toISOString()
};
renderProjectMetaPanel();


  if (typeof JSZip === 'undefined') { showToast?.('JSZip not found'); return; }
  showLoading?.('Preparing viewer package…', 0.05);
  const zip = new JSZip();

  const base = `macroscope-viewer-${Date.now()}/`;
  const dataDir     = base + 'data/';
  const detailsDir  = dataDir + 'details/';
  const aiDir       = dataDir + 'ai/';

  // 1) Manifest
  const indexObj = buildViewerIndexObject({ userTitle: opts.userTitle || '', userText: opts.userText || '' });
  zip.file(dataDir + 'index.json', JSON.stringify(indexObj));

  // 2) Details shards (one per node)
  for (let i=0;i<nodes.length;i++){
    const d = buildViewerDetailsObject(i);
    zip.file(detailsDir + `${d.id}.json`, JSON.stringify(d));
    if ((i+1)%500===0) setLoadingProgress?.(0.05 + 0.40*((i+1)/nodes.length), `Writing details… ${Math.round(100*(i+1)/nodes.length)}%`);
  }

  // 3) AI shards
  const ai = (window.aiFootprints || []);
  for (let j=0;j<ai.length;j++){
    const f = ai[j] || {};
    const id = `A${j+1}`;
    const shard = {
      id,
      title: f.aiTitle || f.title || `AI ${j+1}`,
      created: new Date(f.createdAt || Date.now()).toISOString(),
      body: String(f.aiContent || ''),
      sources: Array.isArray(f.nodeIds)
        ? f.nodeIds.map(i => ({ idx:i, id: viewerNodeId(i), title: nodes?.[i]?.label || '' }))
        : []
    };
    zip.file(aiDir + `${id}.json`, JSON.stringify(shard));
  }

  // 4) Pack + download
setLoadingProgress?.(0.90, 'Compressing…');
const blob = await zip.generateAsync({ type:'blob', compression:'DEFLATE' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');

// derive filename: use provided name or a default
const fname = String((opts && opts.fileName) ? opts.fileName : `viewer-package-${Date.now()}.zip`).trim() || `viewer-package-${Date.now()}.zip`;

a.href = url;
a.download = fname;
a.click();

setTimeout(() => URL.revokeObjectURL(url), 20000);
hideLoading?.();
showToast?.('Viewer package exported.');
}
// Map labels across reclusterings by overlap rather than index


// Map AI/manual labels across reclusterings by membership overlap (Jaccard)
function remapClusterLabels(prevClusterOf, newClusterOf, prevLabels, minJaccard = 0.25) {
  const n = Math.min(prevClusterOf?.length || 0, newClusterOf?.length || 0);
  const oldMap = new Map(); // oldCid -> Set(indices)
  const newMap = new Map(); // newCid -> Set(indices)

  for (let i = 0; i < n; i++) {
    const oc = prevClusterOf[i], nc = newClusterOf[i];
    if (oc >= 0) { if (!oldMap.has(oc)) oldMap.set(oc, new Set()); oldMap.get(oc).add(i); }
    if (nc >= 0) { if (!newMap.has(nc)) newMap.set(nc, new Set()); newMap.get(nc).add(i); }
  }

  const newCount = Math.max(-1, ...newClusterOf) + 1;
  const remapped = new Array(newCount).fill('');

  for (const [oldCid, oldSet] of oldMap.entries()) {
    const label = String(prevLabels?.[oldCid] || '').trim();
    if (!label) continue;

    let bestCid = -1, bestJac = 0;
    for (const [newCid, newSet] of newMap.entries()) {
      let inter = 0;
      if (oldSet.size <= newSet.size) { for (const idx of oldSet) if (newSet.has(idx)) inter++; }
      else { for (const idx of newSet) if (oldSet.has(idx)) inter++; }
      if (!inter) continue;
      const uni = oldSet.size + newSet.size - inter;
      const jac = inter / Math.max(1, uni);
      if (jac > bestJac) { bestJac = jac; bestCid = newCid; }
    }
    if (bestCid >= 0 && bestJac >= minJaccard && !remapped[bestCid]) remapped[bestCid] = label;
  }
  return remapped;
}

// Optional: preserve cluster colours via the same overlap logic
function remapClusterColors(prevClusterOf, newClusterOf, prevColors, minJaccard = 0.25) {
  if (!prevClusterOf || !prevColors) return null;

  const n = Math.min(prevClusterOf.length, newClusterOf.length);
  const oldMap = new Map(), newMap = new Map();
  for (let i = 0; i < n; i++) {
    const oc = prevClusterOf[i], nc = newClusterOf[i];
    if (oc >= 0) { if (!oldMap.has(oc)) oldMap.set(oc, new Set()); oldMap.get(oc).add(i); }
    if (nc >= 0) { if (!newMap.has(nc)) newMap.set(nc, new Set()); newMap.get(nc).add(i); }
  }

  const count = Math.max(-1, ...newClusterOf) + 1;
  const out = makeClusterColors(count);

  for (const [oc, os] of oldMap.entries()) {
    const col = prevColors[oc];
    if (!col) continue;
    let bestCid = -1, bestJac = 0;
    for (const [nc, ns] of newMap.entries()) {
      let inter = 0;
      if (os.size <= ns.size) { for (const idx of os) if (ns.has(idx)) inter++; }
      else { for (const idx of ns) if (os.has(idx)) inter++; }
      if (!inter) continue;
      const uni = os.size + ns.size - inter;
      const jac = inter / Math.max(1, uni);
      if (jac > bestJac) { bestJac = jac; bestCid = nc; }
    }
    if (bestCid >= 0 && bestJac >= minJaccard) out[bestCid] = col;
  }
  return out;
}
function focusNode(i, {minPxRadius = 6, preferFitWhenTiny = true} = {}) {
  const n = nodes?.[i]; if (!n) return;

  // If the world is tiny (few nodes), fit it; otherwise centre on the node.
  if (preferFitWhenTiny && nodes.length <= 5 && typeof fitWorldInView === 'function') {
    fitWorldInView(60);
  }

  // Centre on the node at current zoom
  const sxc = width * 0.5, syc = height * 0.5;
  cam.x = sxc - n.x * cam.scale;
  cam.y = syc - n.y * cam.scale;

  // Ensure the node is not microscopic at current zoom
  const r = (n.r || NODE_R || 8);
  const pxR = r * cam.scale;
  if (pxR < minPxRadius) {
    cam.scale = Math.max(0.05, minPxRadius / r);
    cam.x = sxc - n.x * cam.scale;
    cam.y = syc - n.y * cam.scale;
  }
}
function _syncAIDimsWithFootprints() {
  if (!Array.isArray(dimTools) || !Array.isArray(aiFootprints)) return;

  const bySig = new Map();
  for (const f of aiFootprints) if (f?.sig) bySig.set(f.sig, f);

  const sameNodes = (aSet, arr) => {
    if (!aSet || !arr) return false;
    if (aSet.size !== arr.length) return false;
    for (const i of arr) if (!aSet.has(i)) return false;
    return true;
  };

  for (const d of dimTools) {
    if (!d || d.type !== 'ai') continue;

    // Try by signature first
    let f = (d.aiSig && bySig.get(d.aiSig)) || null;

    // Fallback: match by nodes + (title/label) if signature missing
    if (!f) {
      for (const g of aiFootprints) {
        if (!g) continue;
        const titleMatch = ((d.aiTitle || d.label || '').trim().toLowerCase() ===
                            (g.title || g.aiTitle || '').trim().toLowerCase());
        if (sameNodes(d.nodes instanceof Set ? d.nodes : new Set(d.nodes || []), g.nodeIds || []) &&
            (titleMatch || !d.aiTitle)) { f = g; break; }
      }
    }

    if (f) {
      d.aiSig       = f.sig || d.aiSig || null;
      d.aiTitle     = f.title || f.aiTitle || d.aiTitle || d.label || null;
      d.aiCreatedAt = Number.isFinite(+f.createdAt) ? +f.createdAt : (d.aiCreatedAt || null);
      d.aiContent   = (f.content || f.aiContent || d.aiContent || '');
      // keep an explicit link for lazy fetch in viewer builds too:
      d.summaryRef  = d.summaryRef || f.summaryRef || null;

      // remember the back-link so marker follows the handle
      f.dimKey = d.key;
    }
  }
}

function openPublishDialog(onSubmit) {
  // backdrop
  const bg = document.createElement('div');
  Object.assign(bg.style, {
    position:'fixed', inset:'0', background:'rgba(0,0,0,0.45)', zIndex: '10090'
  });
  document.body.appendChild(bg);

  // modal
  const box = document.createElement('div');
  Object.assign(box.style, {
    position:'fixed', left:'50%', top:'20%', transform:'translate(-50%, 0)',
    width:'min(520px, 90vw)', background:'#111', color:'#fff',
    border:'1px solid rgba(255,255,255,0.2)', borderRadius:'12px',
    boxShadow:'0 12px 40px rgba(0,0,0,0.5)', padding:'16px', zIndex:'10100',
    font:'13px/1.4 system-ui, -apple-system, Segoe UI, Roboto'
  });

  const nowIso = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const defaultZip = `viewer-package-${nowIso}.zip`;

  box.innerHTML = `
    <div style="font-weight:700; font-size:15px; margin-bottom:10px;">Publish</div>

    <label style="display:block; margin:8px 0 4px;">Save As (.zip)</label>
    <input id="pub_name" value="${defaultZip}" style="width:100%; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.25); background:#000; color:#fff" />

    <label style="display:block; margin:10px 0 4px;">Title</label>
    <input id="pub_title" placeholder="e.g. My Cluster Map" style="width:100%; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.25); background:#000; color:#fff" />

    <label style="display:block; margin:10px 0 4px;">Text</label>
    <textarea id="pub_text" rows="5" placeholder="Short description shown when the package is opened…" style="width:100%; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.25); background:#000; color:#fff; resize:vertical"></textarea>

    <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
      <button id="pub_cancel" style="padding:8px 12px; border-radius:8px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.2); color:#fff; cursor:pointer;">Cancel</button>
      <button id="pub_ok"     style="padding:8px 12px; border-radius:8px; background:#2a7; border:1px solid rgba(255,255,255,0.2); color:#000; cursor:pointer; font-weight:700;">Publish</button>
    </div>
  `;
  document.body.appendChild(box);

  const close = () => { box.remove(); bg.remove(); };
  box.querySelector('#pub_cancel').addEventListener('click', close);

  box.querySelector('#pub_ok').addEventListener('click', () => {
    const name  = String(box.querySelector('#pub_name').value || '').trim() || defaultZip;
    const title = String(box.querySelector('#pub_title').value || '').trim();
    const text  = String(box.querySelector('#pub_text').value || '').trim();
    close();
    if (typeof onSubmit === 'function') onSubmit({ name, title, text });
  });
}
// Build the same stable key that toggleDimensionTool uses
function dimKeyFor(type, rec){
  const stableId = (type === 'clusters' && rec.cid != null) ? `cid:${rec.cid}` : rec.key;
  return `${type}|${stableId}`;
}

function dimExists(type, rec){
  return dimByKey?.has(dimKeyFor(type, rec));
}

// Compute a non-overlapping spawn position for a new handle
function nextHandleSpawnPos() {
  // Base: last handle position if any; else the existing left-side spawn
  let base;
  const last = (Array.isArray(dimTools) && dimTools.length) ? dimTools[dimTools.length-1] : null;
  if (last) {
    base = { x: last.x, y: last.y };
  } else {
    base = screenToWorld(Math.max(200, width * 0.2), height * 0.5);
  }

  const iconWorld = (DIM_HANDLE_ICON_PX || 28) / cam.scale;
  const minSep   = iconWorld * 1.35;         // keep at least ~1.35× icon apart
  const minSep2  = minSep * minSep;

  // Try a few fixed offsets, then a short golden-angle spiral if needed
  const fixed = [
    [ iconWorld*1.6, 0 ],
    [ 0,             iconWorld*1.6 ],
    [ iconWorld*1.6, iconWorld*1.6 ],
    [ -iconWorld*1.6, 0 ],
    [ 0,            -iconWorld*1.6 ],
    [ -iconWorld*1.6, -iconWorld*1.6 ],
  ];

  const isFree = (x, y) => {
    for (const d of (dimTools || [])) {
      if (!d) continue;
      const dx = d.x - x, dy = d.y - y;
      if (dx*dx + dy*dy < minSep2) return false;
    }
    return true;
  };

  for (const [dx, dy] of fixed) {
    const x = base.x + dx, y = base.y + dy;
    if (isFree(x, y)) return { x, y };
  }

  // Golden-angle spiral fallback
  const GA = 137.50776405003785 * Math.PI / 180;
  for (let k = 0; k < 18; k++) {
    const r = iconWorld * (2.0 + k * 0.6);
    const a = k * GA;
    const x = base.x + Math.cos(a) * r;
    const y = base.y + Math.sin(a) * r;
    if (isFree(x, y)) return { x, y };
  }

  return base; // worst case: use base
}
// === Full Text Literature Review (cluster-themed) ===
// === Full Text Literature Review (cluster-themed, full sections) ===
// === Full Text Literature Review — v2 (structured, coverage-safe) ===
async function runFullTextLitReview() {
  if (!OPENAI_API_KEY) { openApiKeyModal(); return; }

  // 0) Collect visible cached full texts
  const docsAll = collectVisibleFulltextCorpus() || []; // [{idx,title,authors,year,venue,doi,url,text},...]
  if (!docsAll.length) { openSynthPanel('No cached full texts visible.'); return; }
  for (let i = 0; i < docsAll.length; i++) docsAll[i].ref = i + 1;

  // Ensure clusters (for theme hints / stats)
  try { if (!clusterOf || clusterOf.length !== nodes.length) computeDomainClusters(); } catch(_) {}

  const totalVisible = docsAll.length;
  openSynthPanel(`Preparing Full-Text Lit Review (${totalVisible} papers)…`);

  // 1) Per-paper pass: JSON summaries + concepts + quotes
  const perPaper = [];              // [{n,title,summary,concepts:[{term,definition}],quotes:[]}]
  const perPaperMap = new Map();    // n -> item

  for (const d of docsAll) {
    setSynthProgressHtml(`<div>Analysing [${d.ref}] ${escapeHtml(shortRefForPrompt(d))}…</div>`);
    const msg  = buildPerPaperJSONPrompt(d.ref, d);
    const raw  = await openaiChatDirect(msg, { temperature: 0.2, max_tokens: FLR_MAX_TOK_PAPER });
    const j    = parseTinyJson(raw) || {};
    const entry = {
      n: d.ref,
      title: d.title || `Paper ${d.ref}`,
      summary: (j.summary || '').trim(),
      concepts: Array.isArray(j.concepts) ? j.concepts : [],
      quotes: Array.isArray(j.quotes) ? j.quotes.slice(0,2) : []
    };
    perPaper.push(entry); perPaperMap.set(entry.n, entry);
    await new Promise(r => setTimeout(r, FLR_CALL_DELAY));
  }

  // 2) Theme selection (3–8 themes depending on set size)
  const themeMin = Math.max(FLR_THEMES_MIN, Math.min(FLR_THEMES_MAX, Math.ceil(Math.min(8, Math.max(3, docsAll.length/25)))));
  const themeMax = Math.max(themeMin, FLR_THEMES_MAX);
  const itemsForTheme = perPaper.map(p => ({ n: p.n, title: p.title, summary: p.summary }));
  const themeSelMsg   = buildThemeSelectionPrompt(itemsForTheme, themeMin, themeMax);
  const themesRaw     = await openaiChatDirect(themeSelMsg, { temperature: 0.2, max_tokens: 1200 });
  let themes = parseTinyJson(themesRaw); if (!Array.isArray(themes)) themes = [];
  // Fallback: if model returns nothing, one theme with all refs
  if (!themes.length) themes = [{ title: 'Core Theme', refs: docsAll.map(d=>d.ref), rationale: 'Automatic fallback' }];

  // 3) Methodology stats + shortRefs block
   const lines = [];
const stats = computeMethodologyStats(docsAll, themes.length);
const span = (stats.years.min!=null && stats.years.max!=null) ? `${stats.years.min}–${stats.years.max}` : 'n/a';
const clusterNote = (stats.clustersPresent!=null) ? `clusters in view ≈${stats.clustersPresent}; ` : '';
lines.push(
  `Reviewed **${stats.total}** full-text papers; span **${span}**; open-access **${stats.oaYes}**; `+
  `${clusterNote}themes used **${stats.themesCount}**.`,
  ''
);
  const shortRefsBlock = docsAll.map(d => `[${d.ref}] ${shortRefForPrompt(d)}`).join('\n');

  // 4) Overall Themes summary (single paragraph)
  const overallMsg = buildOverallThemesSummaryPrompt(JSON.stringify(themes), shortRefsBlock);
  const overallThemesRaw = (await openaiChatDirect(overallMsg, { temperature: 0.25, max_tokens: 700 }))?.trim() || '';
const overallThemes = rebalanceCitations(overallThemesRaw, docsAll.map(d=>d.ref), 2);

  // 5) Concepts consolidation
  const conceptRows = perPaper.flatMap(p => (p.concepts||[]).map(c => `${c.term} | ${c.definition} | [${p.n}]`)).join('\n');
  const conceptsMsg = buildConceptsPrompt(conceptRows, shortRefsBlock);
  const conceptsMd  = (await openaiChatDirect(conceptsMsg, { temperature: 0.25, max_tokens: 900 }))?.trim() || '';
const conceptsOut = (typeof dedupeConceptBullets === 'function') ? dedupeConceptBullets(conceptsMd) : conceptsMd;
  // 6) Thematic Review (blocks)
  const themeBlocks = [];
  const cited = new Set();
  
  for (const t of themes) {
    const pMsg = buildThemeReviewPrompt(t, perPaperMap, shortRefsBlock);
    const block = (await openaiChatDirect(pMsg, { temperature: 0.25, max_tokens: 1400 }))?.trim() || '';
    themeBlocks.push({ title: String(t.title||'Theme'), body: block });
    // track citations used
    const used = (block.match(/\[(\d+)\]/g) || []).map(s => +s.replace(/\D/g,''));
    for (const k of used) if (Number.isFinite(k)) cited.add(k);
    await new Promise(r => setTimeout(r, 120));
  }

  // 7) Recommended Key Papers (3–10), with network hints when available
  const clusterSizes = {};
  if (Array.isArray(clusterOf)) for (const d of docsAll) {
    const c = Number(clusterOf[d.idx]); if (Number.isFinite(c)) clusterSizes[c] = (clusterSizes[c]||0) + 1;
  }
  const candidateLines = docsAll.map(d => {
    const w = itemsData?.[d.idx]?.openalex || {};
    const citedBy = w?.cited_by_count|0;
    const deg = (typeof adj !== 'undefined' && Array.isArray(adj?.[d.idx])) ? adj[d.idx].length : (nodes?.[d.idx]?.deg|0);
    const cid = Number(clusterOf?.[d.idx]); const csz = Number.isFinite(cid) ? (clusterSizes[cid]||0) : 0;
    return `${d.ref} | ${citedBy} | ${deg} | ${csz} | ${shortRefForPrompt(d)}`;
  }).join('\n');
  const keyMsg = buildKeyPapersPrompt(candidateLines, FLR_KEY_MIN, FLR_KEY_MAX, shortRefsBlock);
  const keyMd  = (await openaiChatDirect(keyMsg, { temperature: 0.25, max_tokens: 800 }))?.trim() || '';
  const keyMdCovered = ensureKeyCoverage(keyMd, themes, docsAll);
  // 8) Coverage catch-up (ensure every [n] appears in body)
  const missing = docsAll.map(d=>d.ref).filter(n => !cited.has(n));
  let catchupMd = '';
  if (missing.length) {
  const rows = missing.map(n => {
  const d = docsAll[n-1];
  const hint = (String(d.text||d.title||'').trim().split(/(?<=[.!?])\s+/)[0]||'').slice(0,140);
  return `${n} | ${shortRefForPrompt(d)} | ${hint}`;
}).join('\n');
    const cuMsg = buildCoverageCatchUpPrompt(rows, shortRefsBlock);
    catchupMd = (await openaiChatDirect(cuMsg, { temperature: 0.25, max_tokens: 600 }))?.trim() || '';
  }

  // 9) Title
  const titleMsg = [
    { role:'system', content:`Propose a short, specific review title (≤12 words). Return plain text only.` },
    { role:'user', content:`Themes:\n${JSON.stringify(themes)}\n\nOverall:\n${overallThemes.slice(0,600)}` }
  ];
  const reviewTitle = (await openaiChatDirect(titleMsg, { temperature: 0.6, max_tokens: 60 }))?.trim() || 'Full-Text Literature Review';

  // 10) Build References (rich)
  const refsList = buildReferenceListRich(docsAll);

  // 11) Assemble Markdown (exact structure requested)
 
  lines.push(`# ${reviewTitle}`, '');

  // 1. Methodology (stats)
  lines.push('## 1. Methodology', '');
  const yrs = (stats.years.min!=null && stats.years.max!=null) ? `${stats.years.min}–${stats.years.max}` : 'n/a';
  lines.push(
    `Reviewed **${stats.total}** full-text papers (on-screen & cached); time span **${yrs}**; `+
    `open-access detected for **${stats.oaYes}**; themes derived from graph clusters (≈${stats.clustersPresent}).`,
    ''
  );
  lines.push('_Synthesis pipeline_: per-paper grounded summaries → theme detection → concept consolidation → thematic mini-reviews → key-paper selection → coverage catch-up.', '');

  // 2. Summary of Publications (overall themes)
  lines.push('## 2. Summary of Publications (Overall Themes)', '');
  lines.push(overallThemes || '(n/a)', '');

  // 3. Concepts (with definitions)
  lines.push('## 3. Concepts', '');
  lines.push(conceptsOut || '(n/a)', '');

  // 4. Thematic Review (mini-summaries)
  lines.push('## 4. Thematic Review', '');
  for (const t of themeBlocks) {
    lines.push(`### ${t.title}`, '', t.body, '');
  }
if (catchupMd) {
  lines.push('**Peripheral & emerging (coverage addendum)**', '');
  // ensure bullets (model may return plain lines)
  const cu = catchupMd.replace(/^\s*(?!- )(.+)$/gm, '- $1');
  lines.push(cu, '');
}

  // 5. Recommended Key Papers
  lines.push('## 5. Recommended Key Papers', '');
  lines.push(keyMd || '(n/a)', '');

  // References
  lines.push('## References', '');
  for (const r of refsList) lines.push(`[${r.key}] ${r.text}`);

  const bodyMd = lines.join('\n');

  // 12) Panel HTML
  const refsHtml = renderReferenceListHtmlRich(refsList);
  const html = `
    <div style="font-weight:600;font-size:16px;margin:2px 0 10px">${escapeHtml(reviewTitle)}</div>
    <div style="opacity:.9;margin:8px 0 12px">
      Reviewed <b>${stats.total}</b> papers; span <b>${yrs}</b>; OA: <b>${stats.oaYes}</b>; themes ≈ <b>${stats.clustersPresent}</b>.
    </div>
<div class="review-container">${formatMarkdownToHTML(bodyMd.replace(/^#[^\n]*\n/gm,'').trim())}</div>
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.2);margin:12px 0">
    <div style="font-weight:600;margin-bottom:6px">References (${refsList.length})</div>
    ${refsHtml}
  `;
  ensureReviewStyles();
  setSynthHtml(html);
  setSynthBodyText(bodyMd, 'full_text_lit_review.md');

  // 13) Add ONE AI lens footprint
  try {
    addAIFootprintFromItems('lit-review', docsAll, bodyMd, `AI Lit Review: ${reviewTitle}`);
    redraw();
  } catch (e) {
    console.warn('Footprint (lit review) failed:', e);
  }
}


async function draftSectionFromThemes(opts) {
  const {
    sectionName,      // e.g., "Critical Analysis"
    instruction,      // concrete writing brief
    themes,           // themeBlocks [{title, body}]
    docsAll,          // all docs with .ref
    temperature = 0.25,
    max_tokens = 1000
  } = opts;

  // Build a compact source bundle to keep prompts tight
  const themeDigest = themes.map((t, i) => `(${i+1}) ${t.title}\n${t.body}`).join('\n\n');
  const refsLine = `Available references (use inline [n] tags; do NOT invent numbers): ${docsAll.map(d => `[${d.ref}]`).join(' ')}`;

  const messages = [
    { role: 'system', content: `You are writing the "${sectionName}" section of a literature review. Produce assertive prose, no placeholders.` },
    { role: 'user', content:
`Materials:
THEMATIC DIGEST:
${themeDigest}

${refsLine}

Task:
${instruction}

Rules:
- Use 3–8 inline citations with the existing [n] tags where relevant.
- Do not add headings inside this section (just paragraphs).
- Do not use bullet points unless explicitly requested.
- No placeholders like "(discuss...)" or "(to be added)".` }
  ];

  const out = await openaiChatDirect(messages, { temperature, max_tokens });
  return String(out || '').trim();
}
// === Helper: generate a concise, content-aware title suffix ===
async function generateReviewTitle(themes, docsAll) {
  // Keep prompt tiny but grounded in what the review actually covered
  const digest = themes.map((t,i) => `(${i+1}) ${t.title}: ${t.body.slice(0, 280)}…`).join('\n\n');
  const refsLine = `Refs considered: ${docsAll.slice(0, 12).map(d => `[${d.ref}]`).join(' ')}${docsAll.length > 12 ? ' …' : ''}`;
  const messages = [
    { role: 'system', content: 'You create brief, specific titles for academic literature reviews.' },
    { role: 'user', content:
`Thematic digest (trimmed):
${digest}

${refsLine}

Task: Propose a short, specific title (<= 12 words) that captures the main focus.
Rules:
- No punctuation at the end.
- No leading "AI Lit Review:" — we add that prefix.
- Avoid generic phrases like "A Comprehensive Review" or "State of the Art".` }
  ];
  const out = await openaiChatDirect(messages, { temperature: 0.35, max_tokens: 32 });
  const s = String(out || '').trim();
  // safety trims
  return s.replace(/^[“"'\-:\s]+|[.”"'\s]+$/g, '').slice(0, 90);
}

// === Helper: file-safe slug for downloads ===
function toSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 80);
}
// Build the review body without backticks (avoids template-literal pitfalls)
function buildLitReviewBody({
  reviewTitle, introNote, section2, methodNote,
  section4, thematicMd, section6, catchup,
  section7, section8, refsList
}) {
  // Guard against stray backticks in titles
  const safeTitle = String(reviewTitle || 'AI Lit Review').replace(/`/g, 'ʼ');

  const lines = [];
  lines.push(`# ${safeTitle}`, '');

  lines.push('# 1. Introduction', '');
  lines.push('Background and context');
  lines.push(String(introNote || ''), '');
  lines.push('Structure of the review');
  lines.push('This review is organised into conceptual framing, methodology, field overview, thematic synthesis, critical analysis, integration, and future directions.', '');

  lines.push('# 2. Theoretical / Conceptual Framework', '');
  lines.push(String(section2 || ''), '');

  lines.push('# 3. Methodology of the Review', '');
  lines.push('Search strategy and graph basis');
  lines.push(String(methodNote || ''), '');
  lines.push('Inclusion and exclusion criteria');
  lines.push('Visible nodes with cached full text at time of synthesis.', '');
  lines.push('Data extraction and synthesis methods');
  lines.push('Per-paper grounded summaries → cluster merges with preserved [n] → structured assembly.', '');
  lines.push('Limitations of the review approach');
  lines.push('As noted above.', '');

  lines.push('# 4. Overview of the Field', '');
  lines.push(String(section4 || ''), '');

  lines.push('# 5. Thematic Review (Core Section)', '');
  lines.push(String(thematicMd || ''), '');
  lines.push('Comparative insights across themes');
  lines.push('(contrasts in approaches, findings, and assumptions across themes)', '');

  lines.push('# 6. Critical Analysis', '');
  if (section6) lines.push(String(section6));
  if (catchup)  lines.push(String(catchup));
  lines.push('');

  lines.push('# 7. Synthesis and Integration', '');
  lines.push(String(section7 || ''), '');

  lines.push('# 8. Future Directions', '');
  lines.push(String(section8 || ''), '');

  lines.push('# References', '');
  for (const r of (refsList || [])) lines.push(`[${r.key}] ${r.text}`);

  return lines.join('\n');
}
// --- helper: make a short "scope note" for an uncited paper
function makeScopeNoteFromDoc(d, maxWords = 22) {
  const txt = String(d.text || d.title || '').replace(/\s+/g, ' ').trim();
  if (!txt) return '';
  // take first sentence or first ~maxWords
  let first = txt.split(/(?<=[.!?])\s+/)[0] || txt;
  const words = first.split(' ');
  if (words.length > maxWords) first = words.slice(0, maxWords).join(' ') + '…';
  return first;
}

// --- Chrono helpers: 5-year windows + title + trends ---

function groupIntoYearWindows(corpus, span = 5) {
  const windows = [];
  const years = corpus.map(d => Number.isFinite(d.year) ? d.year : null).filter(y => y != null);
  if (!years.length) return [{ start: 'earliest', end: 'latest', docs: corpus.slice() }];

  const minY = Math.min(...years);
  const maxY = Math.max(...years);

  for (let start = Math.floor(minY / span) * span; start <= maxY; start += span) {
    const endRaw = start + span - 1;
    const end = Math.min(endRaw, maxY); // ← cap at latest pub year
    const docs = corpus.filter(d => Number.isFinite(d.year) && d.year >= start && d.year <= end);
    if (docs.length) windows.push({ start, end, docs });
  }

  // Any items with no year: put them in a final "n.d." bucket
  const nd = corpus.filter(d => !Number.isFinite(d.year));
  if (nd.length) windows.push({ start: 'n.d.', end: 'n.d.', docs: nd });
  return windows;
}


function buildChronoWindowHeading(win) {
  if (win.start === 'n.d.') return 'No date (n.d.)';
  if (win.start === win.end) return `${win.start}`; // ← single-year window
  return `${win.start}–${win.end}`;
}

function buildChronoWindowSectionPrompt(paragraphs, win) {
  const heading = buildChronoWindowHeading(win);
  const approxWords = Math.min(1200, Math.max(400, paragraphs.length * 110));
  const lo = (win.start === 'n.d.') ? 'n.d.' : win.start;
  const hi = (win.end === 'n.d.')   ? 'n.d.' : win.end;

  return [
    { role:'system', content:
`Combine the paragraphs into a cohesive chronological SECTION for ${lo}–${hi}.
Rules:
- KEEP inline citation keys [n] / [n*] exactly as given (do not renumber).
- Academic tone; no subheadings inside this section; ~${approxWords} words.
- Briefly note any continuity or shifts relative to the prior window if evident.` },
    { role:'user', content: paragraphs.join('\n\n') }
  ];
}

async function generateChronoTitle(windows, allRefs) {
  // Feed short per-window digests to title generator
  const windowHints = windows.map((w,i) => {
    const y = buildChronoWindowHeading(w);
    const tops = w.docs.slice(0, 4).map(d => `${d.title}`).join(' • ');
    return `(${i+1}) ${y}: ${tops}`;
  }).join('\n');

  const msg = [
    { role:'system', content: 'You create short, specific titles for chronological literature reviews.' },
    { role:'user', content:
`WINDOW DIGESTS (trimmed):
${windowHints}

References considered: ${allRefs.slice(0, 18).map(d => `[${d.refKey}]`).join(' ')}${allRefs.length>18?' …':''}

Task:
- Propose a concise title (<= 12 words) capturing the time-evolutionary focus.
- No trailing punctuation.` }
  ];
  const out = await openaiChatDirect(msg, { temperature: 0.35, max_tokens: 32 });
  const s = String(out || '').trim();
  return s.replace(/^[“"'\-:\s]+|[.”"'\s]+$/g, '').slice(0, 90);
}

function buildChronoTrendsPrompt(windowSectionsMarkdown, yrLo, yrHi) {
  const period = (Number.isFinite(yrLo) && Number.isFinite(yrHi)) ? `${yrLo}–${yrHi}` : 'overall period';
  return [
    { role:'system', content:
`From the per-window sections, write a concluding "Trends Over Time" analysis.
Goals:
- Identify major shifts, convergences/divergences, and methodological/theoretical inflections across windows.
- 3–6 tight paragraphs (~250–350 words total), academic tone.
- Keep inline [n] / [n*] citations exactly as they appear if you reference specifics (but you may also write general trend text without citations).
- No bullet lists; prose only.` },
    { role:'user', content:
`PER-WINDOW SECTIONS (${period}):
${windowSectionsMarkdown}` }
  ];
}
function aiKindOf(d) {
  const s = String(d?.aiSig || d?.aiTitle || d?.label || '').toLowerCase();

  // Chronological Review
  if (s.includes('chrono')) return 'chrono';
  if (s.includes('chronolog')) return 'chrono';

  // Abstracts synthesis
  if (s.includes('abstract')) return 'abstracts';
  if (s.includes('synthes')) return 'abstracts'; // synthesise/synthesize

  // Lit review (full text)
  if (s.includes('lit') || s.includes('literature')) return 'lit';
  if (s.includes('full text') || s.includes('full-text')) return 'lit';

  // Open question
  if (s.includes('question')) return 'question';

  return null; // unknown → fallback
}


function compactOA(work) {
  const a = work || {};
  const abs = (a.abstract && String(a.abstract)) ||
              (a.abstract_inverted_index ? getAbstract(a) : '');

  const refsCount = Array.isArray(a.referenced_works)
    ? a.referenced_works.length
    : Number(
        (a.referenced_works_count ??
         a?.biblio?.reference_count ??
         a?.biblio?.references_count ??
         0)
      );

  // NEW: normalise DOI once
  const __doi = (a.doi || (a.ids && a.ids.doi)) ? String(a.doi || a.ids.doi).trim() : null;

  return {
    id: a.id || null,
    display_name: a.display_name || a.title || '',
    cited_by_count: Number(a.cited_by_count || 0),
    publication_year: Number(a.publication_year || (a.from_publication_date||'').slice(0,4)) || null,
    open_access: { is_oa: !!(a.open_access && a.open_access.is_oa) },
    // --- keep small, but DO include DOI so the Info panel + caching can use it
    doi: __doi,                        // ← NEW (flat DOI for your UI)
    ids: __doi ? { doi: __doi } : {},  // ← NEW (minimal compatibility for any callers)
    concepts: Array.isArray(a.concepts)
      ? a.concepts.slice(0, 6).map(c => ({ display_name: c?.display_name, id: c?.id }))
      : [],
    authors: Array.isArray(a.authorships)
      ? Array.from(new Set(
          a.authorships.map(x => x?.author?.display_name).filter(Boolean)
        ))
      : [],
    authorship_names: Array.isArray(a.authorships)
      ? Array.from(new Set(
          a.authorships.map(x => x?.author?.display_name).filter(Boolean)
        ))
      : [],

    institutions: Array.isArray(a.authorships)
      ? Array.from(new Set(
          a.authorships.flatMap(x =>
            Array.isArray(x?.institutions)
              ? x.institutions.map(ii => ii?.display_name).filter(Boolean)
              : []
          )
        ))
      : [],
      // compact venue for UI fallbacks
    venue_name: inferVenueNameFromWork(a, ''),
    abstract: abs || '',
    refsCount
  };
}


function isCompactOpenAlex(w) {
  if (!w || typeof w !== 'object') return true;
  const noAuthors = !Array.isArray(w.authorships);
  const noVenue   = !(w.host_venue || (w.primary_location && w.primary_location.source));
  const noRefs    = (w.referenced_works == null) && (w.referenced_works_count == null)
                    && !(w.biblio && (w.biblio.reference_count != null || w.biblio.references_count != null));
  return noAuthors || noVenue || noRefs;
}
// === Full-Text Lit Review (v2) helpers ===

// Tunables
const FLR_THEMES_MIN = 3;
const FLR_THEMES_MAX = 8;
const FLR_KEY_MIN    = 3;
const FLR_KEY_MAX    = 10;
const FLR_CALL_DELAY = 180;  // ms pacing to avoid 429s
const FLR_MAX_TOK_PAPER = 700;

// Rich references (with best URL) for HTML + markdown
function buildReferenceListRich(corpus) {
  return corpus.map((d, k) => {
    const title = stripTagsKeepText(d.title || '');
    const doiUrl = d.doi ? `https://doi.org/${d.doi}` : '';
    const best   = (typeof pickBestUrl === 'function') ? pickBestUrl((itemsData?.[d.idx]?.openalex || {}), doiUrl) : (d.url || doiUrl);
    const bits   = [];
    if (d.authors) bits.push(d.authors);
    if (d.year)    bits.push(`(${d.year})`);
    if (title) bits.push(title);
    if (d.venue)   bits.push(d.venue);
    if (best)      bits.push(best);
    return { key: (k + 1), text: bits.join('. '), url: best || '' };
  });
}

function renderReferenceListHtmlRich(refs) {
  const esc = s => String(s||'').replace(/[<>&]/g, c=>({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
  return refs.map(r => {
    const link = r.url ? `<a href="${esc(r.url)}" target="_blank" style="color:#8ecbff;text-decoration:none">${esc(r.url)}</a>` : '';
    const line = `[${r.key}] ${esc(r.text)}${r.url?'':''}`;
    return `<div style="margin:3px 0">${link ? line.replace(esc(r.url), link) : line}</div>`;
  }).join('');
}

// Stats for Methodology
function computeMethodologyStats(docs, themesCount = null) {
  const total = docs.length;
  const years = docs.map(d => +d.year).filter(Number.isFinite);
  const yMin  = years.length ? Math.min(...years) : null;
  const yMax  = years.length ? Math.max(...years) : null;
  let oaYes = 0; 
  for (const d of docs) {
    const w = itemsData?.[d.idx]?.openalex || {};
    if (w?.open_access?.is_oa) oaYes++;
  }
  const set = new Set();
  if (Array.isArray(clusterOf)) for (const d of docs) {
    const c = Number(clusterOf[d.idx]); if (Number.isFinite(c)) set.add(c);
  }
  const clustersPresent = set.size || null;
  return { total, years: {min: yMin, max: yMax}, oaYes, clustersPresent, themesCount };
}


// Per-paper JSON prompt: summary + concepts + short quotes (≤2)
function buildPerPaperJSONPrompt(n, d) {
  const header =
`You are preparing a rigorous full-text literature review. Return STRICT JSON:
{
  "n": ${n},
  "summary": "60–90 word neutral summary ending with [${n}]",
  "concepts": [{"term":"...", "definition":"... [${n}]"}, ... up to 4],
  "quotes": ["short direct quote ≤20 words [${n}]", ... up to 2]
}
Rules:
- Include the bracket [${n}] exactly once in each summary/definition/quote where appropriate.
- No markdown, no commentary, JSON only.`;

  const body =
`[${n}] ${d.title || 'Untitled'}
Authors: ${d.authors || 'Unknown'}
Year/Venue: ${d.year || ''} ${d.venue || ''}
DOI: ${d.doi ? 'https://doi.org/' + d.doi : 'n/a'}

Full text (truncated if long):
${String(d.text || '').slice(0, 18000)}`;

  return [{ role:'system', content: header }, { role:'user', content: body }];
}

// Robust JSON extractor (mirrors your extractJson style)
function parseTinyJson(raw) {
  const t = String(raw||'').trim();
  try { return JSON.parse(t); } catch(_) {}
  const m = t.match(/```json([\s\S]*?)```/i);
  if (m) { try { return JSON.parse(m[1]); } catch(_) {} }
  const one = t.match(/\{[\s\S]*\}/);
  if (one) { try { return JSON.parse(one[0]); } catch(_) {} }
  return null;
}

// Theme selection from per-paper summaries
function buildThemeSelectionPrompt(items, minThemes, maxThemes) {
  const sys =
`Cluster and name ${minThemes}–${maxThemes} high-level THEMES covering the corpus.
Return STRICT JSON: [{"title":"...", "refs":[n,...], "rationale":"..."}]
Rules: 
- Use each n at most once across themes if possible.
- Prefer grouping by conceptual coherence; avoid tiny themes unless necessary.
- Aim to include the largest clusters by size.`;

  const user = items.map(it => `[${it.n}] ${it.title} — ${it.summary}`).join('\n');

  return [{ role:'system', content: sys }, { role:'user', content: user }];
}

// Overall themes summary prose
function buildOverallThemesSummaryPrompt(themeJson, refsBlock) {
  const sys =
`Write a 180–260 word "Summary of Publications (Overall Themes)".
Rules:
- Refer to many different [n]; avoid over-citing the same few.
- No subheadings; one cohesive paragraph.
- Preserve [n] exactly as keys.`;
  const user = `THEMES:\n${themeJson}\n\nSHORT REFS:\n${refsBlock}`;
  return [{ role:'system', content: sys }, { role:'user', content: user }];
}

// Concepts consolidation
function buildThemeReviewPrompt(theme, perPaperMap, refsBlock) {
  const sys =
`You are writing the BODY ONLY for a section about THEME: ${theme.title}.
Return plain markdown text WITHOUT any heading.
Structure:
- 2–3 sentence overview that cites several different [n] (avoid reusing the same [n] more than twice).
- Then a bullet list of mini-summaries: one bullet per paper in theme.refs, 1–2 sentences each, MUST include that paper's [n].
- Use short provided quotes (≤20 words) sparingly.
Rules:
- Do NOT include the theme title or any heading.
- Vary citations; don't over-use the same 2–3 references.`;

  const lines = theme.refs.map(n => {
    const p = perPaperMap.get(n) || {};
    const q = (p.quotes || []).join(' | ');
    return `[${n}] ${p.title}\nSUMMARY: ${p.summary}\nQUOTES: ${q}`;
  }).join('\n\n');

  const user = `PAPERS:\n${lines}\n\nSHORT REFS:\n${refsBlock}`;
  return [{ role:'system', content: sys }, { role:'user', content: user }];
}


// Key papers selection combining network hints
function buildKeyPapersPrompt(candidatesBlock, kMin, kMax, refsBlock) {
  const sys =
`Choose ${kMin}–${kMax} KEY PAPERS to start with.
Return numbered markdown list "1. Title — why it matters [n]" with 1–2 sentences each.
Balance foundational, representative, and high-impact works; vary [n].`;
  const user = `CANDIDATES (n | cited_by | internal_deg | cluster_size | title):\n${candidatesBlock}\n\nSHORT REFS:\n${refsBlock}`;
  return [{ role:'system', content: sys }, { role:'user', content: user }];
}

// Coverage catch-up for any uncited items: 1-sentence micro-notes
function buildCoverageCatchUpPrompt(missingRows, refsBlock) {
  const sys =
`Write a bullet list with ONE sentence per paper, each ending with its [n].
Rules: no headings; ≤24 words per bullet; crisp and non-redundant.`;
  const user = `UNCITED (n | shortRef | hint):\n${missingRows}\n\nSHORT REFS:\n${refsBlock}`;
  return [{ role:'system', content: sys }, { role:'user', content: user }];
}

// Short helper used in prompts (author-year-title) — GLOBAL
// Robust to authors as string or array, and truncates long titles for neat prompts.
function shortRefForPrompt(d) {
  // Accept array OR comma-separated string
  let firstAuthor = 'Anon';
  if (Array.isArray(d.authors)) {
    if (d.authors.length) firstAuthor = String(d.authors[0] || '').trim() || 'Anon';
  } else if (typeof d.authors === 'string') {
    firstAuthor = (d.authors.split(',')[0] || '').trim() || 'Anon';
  }
  const yr = d.year || '';
  let t = String(d.title || '').trim();
  if (t.length > 60) t = t.slice(0, 57) + '…';
  return `${firstAuthor} ${yr}: ${t}`;
}


// Short helper used in prompts (author-year-title)
function shortRef(it) {
  const arr = Array.isArray(it.authors)
    ? it.authors
    : String(it.authors || '').split(/\s*,\s*/).filter(Boolean);
  const au = arr.length ? arr[0] : 'Anon';
  const yr = it.year || '';
  let t = String(it.title || '').trim();
  if (t.length > 60) t = t.slice(0, 57) + '…';
  return `${au} ${yr}: ${t}`;
}


function buildConceptsPrompt(conceptRows, refsBlock) {
  const sys =
`From the candidates, produce 8–14 KEY CONCEPTS.
Return markdown list:
- **Term** — concise definition (1–2 sentences) [n,n,...]
Rules:
- Each concept MUST cite 2–4 different [n]; avoid single-source concepts.
- Merge duplicates (case-insensitive) and pick the clearest term.
- Prefer corpus-prevalent ideas; avoid niche, overlapping items.
- Vary citations across the list; don't overuse the same [n].`;
  const user = `CANDIDATE CONCEPTS (term | definition | n):\n${conceptRows}\n\nSHORT REFS:\n${refsBlock}`;
  return [{ role:'system', content: sys }, { role:'user', content: user }];
}
function dedupeConceptBullets(md) {
  const lines = md.split('\n').filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const ln of lines) {
    const m = ln.match(/^\s*-\s*\*\*(.+?)\*\*\s*—/);
    if (!m) { out.push(ln); continue; }
    const key = m[1].trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ln);
  }
  return out.join('\n');
}



function rebalanceCitations(md, allowedKeys, maxPerKey = 2) {
  const tok = md.split(/(\[\d+\])/g);
  const counts = new Map();
  for (const t of tok) {
    const m = t.match(/^\[(\d+)\]$/);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  // If any key exceeds cap, try replacing extra occurrences with underused keys
  const underused = () => {
    const res = [];
    for (const k of allowedKeys) {
      const c = counts.get(String(k)) || 0;
      if (c < maxPerKey) res.push(String(k));
    }
    return res;
  };
  for (let i = 0; i < tok.length; i++) {
    const m = tok[i].match?.(/^\[(\d+)\]$/);
    if (!m) continue;
    const k = m[1];
    if ((counts.get(k) || 0) <= maxPerKey) continue;
    const candidates = underused();
    if (!candidates.length) continue;
    const rep = candidates.shift();
    tok[i] = `[${rep}]`;
    counts.set(k, counts.get(k) - 1);
    counts.set(rep, (counts.get(rep) || 0) + 1);
  }
  return tok.join('');
}
function stripTagsKeepText(s='') {
  // decode a few common entities first
  const un = s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  return un.replace(/<\/?[^>]+>/g,'');
}
function ensureKeyCoverage(keyMd, themes, docsAll) {
  // collect referenced [n] in keyMd
  const used = new Set((keyMd.match(/\[(\d+)\]/g) || []).map(s => +s.replace(/\D/g,'')));
  const want = new Set();
  // aim for ≥1 per theme where possible
  for (const t of themes) {
    const hit = t.refs.find(n => used.has(n));
    if (!hit) want.add(t.refs[0]); // simple heuristic: first ref as representative
  }
  if (!want.size) return keyMd;
  const picks = Array.from(want).map(n => {
    const d = docsAll[n-1];
    return `- ${shortRefForPrompt(d)} — representative for its theme. [${n}]`;
  }).join('\n');
  return keyMd + `\n\n_Added for theme coverage:_\n${picks}`;
}

// ============== Multi Cluster Lit Reviews ==============

// Collect visible, cached full texts for a given cluster id
function collectVisibleFulltextForCluster(cid) {
  const all = collectVisibleFulltextCorpus(); // [{idx,title,authors,year,venue,doi,text}, ...]
  if (!Array.isArray(clusterOf) || !Array.isArray(all)) return [];
  return all.filter(d => Number.isFinite(d.idx) && clusterOf[d.idx] === cid);
}

// Build a friendly cluster title
function clusterTitle(cid) {
  const base = (Array.isArray(clusterLabels) && clusterLabels[cid] && clusterLabels[cid].trim())
               ? clusterLabels[cid].trim()
               : `Cluster ${cid}`;
  return base;
}

// Run the full-text lit review pipeline on an injected corpus.
// Assumes you already dropped in the improved helpers used by runFullTextLitReview().
async function buildFullTextLitReviewFromCorpus(docsAll, titleHint) {
  // Borrow the same defensive checks as the single review:
  if (!OPENAI_API_KEY) { openApiKeyModal(); return null; }
  if (!docsAll || !docsAll.length) return null;

  // Stable numeric keys
  for (let i = 0; i < docsAll.length; i++) docsAll[i].ref = i + 1;

  // Make sure clusters exist (for stats & hints), but don’t mutate user view
  try { if (!clusterOf || clusterOf.length !== nodes.length) computeDomainClusters(); } catch(_) {}

  // We reuse the same helper chain that runFullTextLitReview uses (as per your last patch):
  // - buildPerPaperJSONPrompt / parseTinyJson / buildThemeSelectionPrompt ...
  // - computeMethodologyStats / buildReferenceListRich / renderReferenceListHtmlRich
  // NOTE: This function is essentially the same body as runFullTextLitReview(),
  //       but parameterised by docsAll and returns the composed markdown + refs + title,
  //       without touching the global synth panel until the caller decides.

  // ---------- Per-paper JSON pass ----------
  const perPaper = [];
  const perPaperMap = new Map();
  for (const d of docsAll) {
    setSynthProgressHtml(`<div>Analysing [${d.ref}] ${escapeHtml(shortRefForPrompt(d))}…</div>`);
    const msg  = buildPerPaperJSONPrompt(d.ref, d);
    const raw  = await openaiChatDirect(msg, { temperature: 0.2, max_tokens: 700 });
    const j    = parseTinyJson(raw) || {};
    const entry = {
      n: d.ref,
      title: d.title || `Paper ${d.ref}`,
      summary: (j.summary || '').trim(),
      concepts: Array.isArray(j.concepts) ? j.concepts : [],
      quotes: Array.isArray(j.quotes) ? j.quotes.slice(0,2) : []
    };
    perPaper.push(entry); perPaperMap.set(entry.n, entry);
    await new Promise(r => setTimeout(r, 160));
  }

  // ---------- Theme selection ----------
  const themeMin = Math.max(3, Math.min(8, Math.ceil(Math.min(8, Math.max(3, docsAll.length/25)))));
  const themeMax = Math.max(themeMin, 8);
  const itemsForTheme = perPaper.map(p => ({ n: p.n, title: p.title, summary: p.summary }));
  const themeSelMsg   = buildThemeSelectionPrompt(itemsForTheme, themeMin, themeMax);
  let themes = parseTinyJson(await openaiChatDirect(themeSelMsg, { temperature: 0.2, max_tokens: 1200 }));
  if (!Array.isArray(themes) || !themes.length) themes = [{ title: 'Core Theme', refs: docsAll.map(d=>d.ref), rationale: 'Fallback' }];

  // ---------- Stats & overall summary ----------
  const stats = computeMethodologyStats(docsAll, themes.length);
  const shortRefsBlock = docsAll.map(d => `[${d.ref}] ${shortRefForPrompt(d)}`).join('\n');
  const overallThemesRaw = (await openaiChatDirect(
    buildOverallThemesSummaryPrompt(JSON.stringify(themes), shortRefsBlock),
    { temperature: 0.25, max_tokens: 700 }
  ))?.trim() || '';

  const overallThemes = rebalanceCitations
    ? rebalanceCitations(overallThemesRaw, docsAll.map(d=>d.ref), 2)
    : overallThemesRaw;

  // ---------- Concepts ----------
  const conceptRows = perPaper.flatMap(p => (p.concepts||[]).map(c => `${c.term} | ${c.definition} | [${p.n}]`)).join('\n');
  let conceptsMd = (await openaiChatDirect(
  buildConceptsPrompt(conceptRows, shortRefsBlock),
  { temperature: 0.25, max_tokens: 900 }
))?.trim() || '';
  const conceptsOut = (typeof dedupeConceptBullets === 'function') ? dedupeConceptBullets(conceptsMd) : conceptsMd;

  if (typeof dedupeConceptBullets === 'function') conceptsMd = dedupeConceptBullets(conceptsMd);

  // ---------- Theme blocks ----------
  const themeBlocks = [];
  const cited = new Set();

  for (const t of themes) {
    const pMsg = buildThemeReviewPrompt(t, perPaperMap, shortRefsBlock);
    const raw  = (await openaiChatDirect(pMsg, { temperature: 0.25, max_tokens: 1400 }))?.trim() || '';
    const body = (typeof rebalanceCitations === 'function') ? rebalanceCitations(raw, t.refs, 2) : raw;
    themeBlocks.push({ title: String(t.title||'Theme'), body });
    const used = (body.match(/\[(\d+)\]/g) || []).map(s => +s.replace(/\D/g,''));
    for (const k of used) if (Number.isFinite(k)) cited.add(k);
    await new Promise(r => setTimeout(r, 120));
  }

  // ---------- Key papers ----------
  const clusterSizes = {};
  if (Array.isArray(clusterOf)) for (const d of docsAll) {
    const c = Number(clusterOf[d.idx]); if (Number.isFinite(c)) clusterSizes[c] = (clusterSizes[c]||0) + 1;
  }
  const candidateLines = docsAll.map(d => {
    const w = itemsData?.[d.idx]?.openalex || {};
    const citedBy = w?.cited_by_count|0;
    const deg = (typeof adj !== 'undefined' && Array.isArray(adj?.[d.idx])) ? adj[d.idx].length : (nodes?.[d.idx]?.deg|0);
    const cid = Number(clusterOf?.[d.idx]); const csz = Number.isFinite(cid) ? (clusterSizes[cid]||0) : 0;
    return `${d.ref} | ${citedBy} | ${deg} | ${csz} | ${shortRefForPrompt(d)}`;
  }).join('\n');

  const keyRaw = (await openaiChatDirect(
    buildKeyPapersPrompt(candidateLines, 3, 10, shortRefsBlock), { temperature: 0.25, max_tokens: 800 }
  ))?.trim() || '';
  const keyMd  = (typeof ensureKeyCoverage === 'function')
    ? ensureKeyCoverage(keyRaw, themes, docsAll)
    : keyRaw;

  // ---------- Coverage addendum ----------
  const missing = docsAll.map(d=>d.ref).filter(n => !cited.has(n));
  let catchupMd = '';
  if (missing.length) {
    const rows = missing.map(n => {
      const d = docsAll[n-1];
      const hint = (String(d.text||d.title||'').trim().split(/(?<=[.!?])\s+/)[0]||'').slice(0,140);
      return `${n} | ${shortRefForPrompt(d)} | ${hint}`;
    }).join('\n');
    const cuMsg = buildCoverageCatchUpPrompt(rows, shortRefsBlock);
    const raw = (await openaiChatDirect(cuMsg, { temperature: 0.25, max_tokens: 600 }))?.trim() || '';
    // force bullets
    catchupMd = raw.replace(/^\s*(?!- )(.+)$/gm, '- $1');
  }

  // ---------- Title ----------
  const reviewTitle = (await openaiChatDirect([
    { role:'system', content:`Propose a short, specific review title (≤12 words). Return plain text only.` },
    { role:'user', content:`Hint: ${titleHint || ''}\nThemes:\n${JSON.stringify(themes)}\n\nOverall:\n${overallThemes.slice(0,600)}` }
  ], { temperature: 0.6, max_tokens: 60 }))?.trim() || (titleHint || 'Full-Text Literature Review');

  // ---------- References ----------
  const refsList = buildReferenceListRich(docsAll);

  // ---------- Assemble Markdown ----------
  const yrs = (stats.years.min!=null && stats.years.max!=null) ? `${stats.years.min}–${stats.years.max}` : 'n/a';
  const header = [
    `# ${reviewTitle}`, '',
    '## 1. Methodology', '',
    `Reviewed **${stats.total}** full-text papers; span **${yrs}**; open-access **${stats.oaYes}**; ` +
    `${(stats.clustersPresent!=null)?`clusters in view ≈${stats.clustersPresent}; `:''}` +
    `themes used **${stats.themesCount||themes.length}**.`, '',
    '_Pipeline_: per-paper grounded summaries → theme detection → concepts → thematic mini-reviews → key papers → coverage addendum.', '',
    '## 2. Summary of Publications (Overall Themes)', '', overallThemes || '(n/a)', '',
    '## 3. Concepts', '', conceptsMd || '(n/a)', '',
    '## 4. Thematic Review', ''
  ];

  const themeMd = themeBlocks.flatMap(t => [`### ${t.title}`, '', t.body, '']).join('\n');
  const addendum = catchupMd ? ['**Peripheral & emerging (coverage addendum)**', '', catchupMd, ''] : [];
  const keys = ['## 5. Recommended Key Papers', '', keyMd || '(n/a)', ''];
  const refs = ['## References', '', ...refsList.map(r => `[${r.key}] ${r.text}`)];

  const bodyMd = [...header, themeMd, ...addendum, ...keys, ...refs].join('\n');

  // ---------- Ready for caller ----------
  return { title: reviewTitle, bodyMd, refsList };
}

// Main: run across all clusters >= minSize; create 1 lens + 1 doc per cluster.
async function runMultiClusterLitReviews(minSize = 50) {
  if (!OPENAI_API_KEY) { openApiKeyModal(); return; }
  if (!Array.isArray(clusterOf) || clusterCount <= 0) {
    computeDomainClusters?.();
  }

  // Build cluster → visible-fulltext docs
  const byCid = new Map();
  for (let i = 0; i < clusterCount; i++) {
    const docs = collectVisibleFulltextForCluster(i);
    if (docs.length >= minSize) byCid.set(i, docs);
  }

  if (!byCid.size) {
    openSynthPanel(`No clusters at or above the threshold (${minSize}) with cached full texts.`);
    return;
  }

  openSynthPanel(`Running Multi Cluster Lit Reviews on ${byCid.size} cluster(s) ≥ ${minSize}…`);

  const summaryLines = [];
  let created = 0;

  for (const [cid, docs] of byCid.entries()) {
    const cTitle = clusterTitle(cid);
    setSynthProgressHtml(`<div>Reviewing <b>${escapeHtml(cTitle)}</b> — ${docs.length} cached full-text paper(s)…</div>`);

    // Build the review for this cluster
    const result = await buildFullTextLitReviewFromCorpus(docs, cTitle);
    if (!result) continue;

    // Create an AI lens at this cluster’s centroid
    try {
      // convert the docs to footprint items with world coords
      const items = docs.map(d => {
        const p = (typeof parallaxWorldPos === 'function') ? parallaxWorldPos(d.idx) : (nodes?.[d.idx] || {x:0,y:0});
        return { idx: d.idx, x: p.x, y: p.y };
      });
      const lensTitle = `AI Lit Review (Cluster ${cid}): ${result.title}`;
      addAIFootprintFromItems('lit-review', items, result.bodyMd, lensTitle);
      created++;
    } catch(e) {
      console.warn('Lens creation failed for cluster', cid, e);
    }

    // Add to on-screen summary; last run will also be downloadable via the panel button
    summaryLines.push(`- **${cTitle}** — ${docs.length} papers → created “${escapeHtml(result.title)}”`);
  }

  setSynthBodyText(
    `# Multi Cluster Lit Reviews\n\n` +
    `Threshold: ≥ ${minSize} papers with cached full text (visible).\n\n` +
    `Created **${created}** review(s):\n\n` +
    summaryLines.join('\n') +
    `\n\n(Open each AI lens to read the cluster-specific review. You can also export them via your usual publish flow.)`,
    'multi_cluster_lit_reviews.md'
  );

  redraw?.();
}
function openMultiClusterLitDialog() {
  const bg = document.createElement('div');
  Object.assign(bg.style, {
    position:'fixed', left:0, top:0, right:0, bottom:0,
    background:'rgba(0,0,0,0.35)', zIndex: 9998
  });
  const box = document.createElement('div');
  Object.assign(box.style, {
    position:'fixed', zIndex:9999, width:'360px',
    left:'50%', top:'50%', transform:'translate(-50%,-50%)',
    background:'#111', color:'#fff', border:'1px solid #444',
    borderRadius:'10px', padding:'16px', boxShadow:'0 8px 28px rgba(0,0,0,0.4)'
  });
  box.innerHTML = `
    <div style="font-weight:600;font-size:16px;margin-bottom:8px">Multi Cluster Lit Reviews</div>
    <div style="font-size:13px;opacity:.9;margin-bottom:8px">
      Run a full-text literature review for every visible cluster with at least this many papers (with cached full text):
    </div>
    <label style="font-size:13px">Minimum cluster size</label>
    <input id="mc_min" type="number" min="3" step="1" value="50"
      style="width:100%;margin:6px 0 12px;padding:6px;border-radius:6px;border:1px solid #333;background:#1b1b1b;color:#eee"/>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="mc_cancel" style="padding:6px 12px;background:#333;border:1px solid #444;border-radius:8px;color:#ddd">Cancel</button>
      <button id="mc_ok" style="padding:6px 12px;background:#7bb96f;border:1px solid #5e9b52;border-radius:8px;color:#041a04;font-weight:700">Run</button>
    </div>`;
  document.body.appendChild(bg); document.body.appendChild(box);

  const close = () => { box.remove(); bg.remove(); };
  box.querySelector('#mc_cancel').addEventListener('click', close);
  box.querySelector('#mc_ok').addEventListener('click', async () => {
    const min = Math.max(3, parseInt(box.querySelector('#mc_min').value, 10) || 50);
    close();
    runMultiClusterLitReviews(min);
  });
}
function recomputeViewportCulling(padPx = 60) {
  if (!nodes.length) { inView = []; edgesOnscreen = []; return; }

  // Screen rect → world rect (+padding to avoid pop-in)
  const wx0 = (0 - cam.x) / cam.scale;
  const wy0 = (0 - cam.y) / cam.scale;
  const wx1 = (width  - cam.x) / cam.scale;
  const wy1 = (height - cam.y) / cam.scale;
  const pad = padPx / cam.scale;
  const minX = Math.min(wx0, wx1) - pad;
  const maxX = Math.max(wx0, wx1) + pad;
  const minY = Math.min(wy0, wy1) - pad;
  const maxY = Math.max(wy0, wy1) + pad;

  // Nodes
  if (!Array.isArray(inView) || inView.length !== nodes.length) {
    inView = new Array(nodes.length).fill(false);
  }
  for (let i = 0; i < nodes.length; i++) {
 const n = nodes[i];
    if (!n || !visibleMask[i]) { inView[i] = false; continue; }
    // Use the *rendered* position (after Dimensions / AI Lens displacement)
    const p = (typeof parallaxWorldPos === 'function') ? parallaxWorldPos(i) : n;
    const baseR = (n.r || NODE_R);
    // Square “full text” nodes are drawn larger; use their true half-size
    const half = n?.hasFullText ? (baseR * (typeof FULLTEXT_BOX_SIZE_MULT === 'number' ? FULLTEXT_BOX_SIZE_MULT : 1.5))
                                : baseR;
    const x0 = p.x - half, x1 = p.x + half;
    const y0 = p.y - half, y1 = p.y + half;
    inView[i] = !(x1 < minX || x0 > maxX || y1 < minY || y0 > maxY);
  }

  // Edges (only those with BOTH endpoints visible & on-screen)
edgesOnscreen.length = 0;
const es = (visEdges > 0 ? edgesFiltered : []);
for (let k = 0; k < es.length; k++) {
  const e = es[k];
  const a = e.source|0, b = e.target|0;

  // Must pass graph-level filters…
  if (!visibleMask[a] || !visibleMask[b]) continue;

  // …but for on-screen test, keep the edge if EITHER end is in view
  if (!inView[a] && !inView[b]) continue;

  edgesOnscreen.push(e);
}
}
// Normalise DOI -> "10.xxxx/yyy"
function cleanDOI(doi='') {
  return String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i,'');
}

// Prefer a human-friendly, useful URL (for "URL" in the Info panel)
function pickBestUrl(w, doiUrl = '') {
  const pl = w.primary_location || {};
  const cand = [
    pl.landing_page_url,
    pl.pdf_url,
    (pl.source && pl.source.homepage_url),
    doiUrl,          // ← moved up (prefer DOI resolver before OpenAlex page)
    w.id             // OpenAlex fallback last
  ].filter(Boolean);
  return cand[0] || '';
}

// Alias for older call sites that check "can we even try?"
const _hasFTCand = hasFulltextCandidate;
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>\]]+/i;

function _sniffDoiFromHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pick = (sel, attr='content') =>
      Array.from(doc.querySelectorAll(sel))
        .map(n => (n.getAttribute(attr)||'').trim())
        .find(v => DOI_RE.test(v)) || '';

    // Common publisher hints
    const fromMeta =
      pick('meta[name="citation_doi"]') ||
      pick('meta[name="dc.identifier"]') ||
      pick('meta[property="og:doi"]') ||
      pick('meta[name="doi"]');

    if (fromMeta) {
      const m = fromMeta.match(DOI_RE);
      if (m) return m[0];
    }

    // Anchor tags pointing to doi.org
    const a = Array.from(doc.querySelectorAll('a[href*="doi.org/"]'))
      .map(n => n.getAttribute('href')||'')
      .find(h => DOI_RE.test(h));
    if (a) return a.match(DOI_RE)[0];

    // Last resort: scan whole HTML
    const m2 = String(html).match(DOI_RE);
    return m2 ? m2[0] : '';
  } catch { return ''; }
}

async function discoverDoiForIndex(i) {
  const item = itemsData?.[i] || {};
  const w = item.openalex || {};
  if (w.doi) return w.doi; // already have one

  const cand = fulltextCandidatesFromWork(w, '');
  // just try a couple of landing pages to keep it cheap
  const pages = cand.filter(u => !/\.pdf(\?|$)/i.test(u)).slice(0, 3);
  for (const url of pages) {
    try {
      const r = await fetchWithTimeout(viaProxy(url), { redirect: 'follow' }, 15000);

      if (!r.ok) continue;
      const html = await r.text();
      const doi = _sniffDoiFromHtml(html);
      if (doi) {
        (item.openalex ||= {}).doi = doi; // persist
        return doi;
      }
    } catch { /* continue */ }
  }
  return '';
}

// Throttle visibility recompute to one per animation frame
let _visRecompRAF = 0;
function scheduleVisRecompute() {
  if (_visRecompRAF) return;
  _visRecompRAF = requestAnimationFrame(() => {
    _visRecompRAF = 0;
    recomputeVisibility(); // this already calls redraw() at the end
  });
}
//const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// ---- Canvas Overview stats + chart ----
function computeCanvasStats() {
  const totalNodes   = Array.isArray(nodes) ? nodes.length : 0;
  const totalEdges   = Array.isArray(edges) ? edges.length : 0;

  const visibleNodes = Array.isArray(visibleMask)
    ? visibleMask.reduce((a, b) => a + (b ? 1 : 0), 0)
    : totalNodes;

  const visibleEdges = Array.isArray(edgesFiltered)
    ? edgesFiltered.length
    : (Array.isArray(edges) && Array.isArray(visibleMask))
        ? edges.filter(e => visibleMask[e.source|0] && visibleMask[e.target|0]).length
        : 0;

  let withAbs = 0, withFT = 0;
  const yearCounts = new Map();
  let yMin =  Infinity, yMax = -Infinity;

  for (let i = 0; i < totalNodes; i++) {
    const it = (itemsData && itemsData[i]) || {};
    const w  = it.openalex || {};

    // Abstract presence (robust to compact + flags)
    const hasAbs = !!(it.hasAbs || nodes?.[i]?.hasAbs || w.abstract || w.abstract_inverted_index);
    if (hasAbs) withAbs++;

    // Full text presence (either cached flag or text)
    const hasFT = !!(nodes?.[i]?.hasFullText || (typeof it.fulltext === 'string' && it.fulltext.trim()));
    if (hasFT) withFT++;

    // Year histogram
    const y = Number.isFinite(+w.publication_year) ? +w.publication_year : Number(nodes?.[i]?.year);
    if (Number.isFinite(y)) {
      yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  const clusters =
    Number.isFinite(clusterCount) ? clusterCount :
    (Array.isArray(clusterOf) && clusterOf.length) ? (Math.max(...clusterOf) + 1) : 0;

  return {
    totalNodes, visibleNodes, totalEdges, visibleEdges,
    withAbs, withFT, clusters,
    years: {
      min: (yMin ===  Infinity) ? null : yMin,
      max: (yMax === -Infinity) ? null : yMax,
      counts: yearCounts
    }
  };
}

// Simple inline SVG bar chart for year counts
function svgYearBars(years, width = 226, height = 82, margin = 6) {
  const { min, max, counts } = years || {};
  if (min == null || max == null || !counts || !counts.size) {
    return `<div style="opacity:.7;font-size:12px">No year data</div>`;
  }

  const W = Math.max(120, width);
  const labelH = 12;                 // space for labels below the bars
  const H = Math.max(52, height);    // total svg height (includes labelH)
  const chartH = H - labelH;         // height available for bars/background
  const bw = Math.max(1, Math.floor((W - margin*2) / (max - min + 1)));

  let maxCount = 1;
  for (let y = min; y <= max; y++) maxCount = Math.max(maxCount, counts.get(y) || 0);

  let rects = '';
  for (let y = min; y <= max; y++) {
    const c = counts.get(y) || 0;
    const x = margin + (y - min) * bw;
    const h = Math.round((c / maxCount) * (chartH - margin*2));
    const yTop = (chartH - margin - h);
    rects += `<rect x="${x}" y="${yTop}" width="${bw-1}" height="${h}" rx="2" ry="2" fill="rgba(255,255,255,.85)"/>`;
  }

  // background only behind the bars, not the labels
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${chartH}" fill="rgba(255,255,255,0.06)" rx="6"/>
    ${rects}
    <!-- year labels placed BELOW the chart area -->
    <text x="${margin}" y="${chartH + labelH - 2}" font-size="10" fill="rgba(255,255,255,0.8)">${min}</text>
    <text x="${W - margin - 20}" y="${chartH + labelH - 2}" font-size="10" fill="rgba(255,255,255,0.8)">${max}</text>
  </svg>`;
}



function showCanvasOverviewIfNoneSelected() {
  if (!infoPanel) return;

  // NEW: if nothing is loaded, hide the panel and bail
  if (!hasGraphData()) { 
    infoPanel.hide(); 
    return; 
  }

  const noneSelected = (selectedIndex < 0) && (selectedDim < 0) && (aiActiveFootprint == null);
  if (noneSelected) {
    infoPanel.show();
    infoPanel.setCanvasOverview();
  } else {
    // if something *is* selected, the specific renderers will .show() themselves
    // Keep this symmetrical so it doesn't hang around
    infoPanel.hide();
  }
}


function deselectNode() {
  selectedIndex = -1;
  showCanvasOverviewIfNoneSelected();
  redraw();
}

function deselectDimension() {
  selectedDim = -1;
  showCanvasOverviewIfNoneSelected();
  redraw();
}
function hasGraphData() {
  return Array.isArray(nodes) && nodes.length > 0;
}
function drawSplashIfNeeded() {
  if (!_splashEnabled) return false;
  if (hasGraphData())   return false;

  const splash = (typeof DEMO_MODE !== 'undefined' && DEMO_MODE) ? splashDemoImg : splashImg;
  if (!splash || !splash.width || !splash.height) return false;

  const cx = width / 2, cy = height / 2;

  push();
  // optional subtle dim so the splash “sits” on the canvas
  noStroke();
  fill(0, 100);
  rect(0, 0, width, height);

  imageMode(CENTER);

  // Fit to ~60% viewport, preserve aspect
  const maxW = width * 0.6;
  const maxH = height * 0.6;
  const sc   = Math.min(maxW / splash.width, maxH / splash.height, 1);
  image(splash, cx, cy, splash.width * sc, splash.height * sc);
  pop();

  return true; // indicates we drew the splash and want to skip normal drawing
}
function openBugDialog() {
  // Build once; reuse.
  if (!__bugDialogDiv) {
    __bugDialogDiv = createDiv('');
    __bugDialogDiv.id('bugDialog');
    __bugDialogDiv.style('position','fixed');
    __bugDialogDiv.style('inset','0');
    __bugDialogDiv.style('background','rgba(0,0,0,0.55)');
    __bugDialogDiv.style('z-index','10090');
    __bugDialogDiv.style('display','flex');
    __bugDialogDiv.style('align-items','center');
    __bugDialogDiv.style('justify-content','center');

    // Card
    const card = createDiv('');
    card.parent(__bugDialogDiv);
    card.style('width','min(680px, 92vw)');
    card.style('max-height','84vh');
    card.style('overflow','auto');
    card.style('background','rgba(20,20,24,0.95)');
    card.style('border','1px solid rgba(255,255,255,0.12)');
    card.style('border-radius','14px');
    card.style('box-shadow','0 18px 50px rgba(0,0,0,0.45)');
    card.style('backdrop-filter','blur(4px)');
    card.style('padding','16px 16px 12px 16px');
    card.style('color','#fff');

    const title = createDiv('Report a bug / Suggest a feature');
    title.parent(card);
    title.style('font-weight','700');
    title.style('font-size','16px');
    title.style('margin','0 0 10px 0');

    const hint = createDiv(
      '<div style="opacity:.8; font-size:12px; margin-bottom:10px;">' +
      'Please describe the issue and context, or suggest improvements. ' +
      'We will include session context (URL, time, demo mode, dataset title) automatically.</div>'
    );
    hint.parent(card);

    // Description textarea
    const descLabel = createDiv('<b>Description of the bug</b>');
    descLabel.parent(card);
    descLabel.style('font-size','13px');
    descLabel.style('margin','10px 0 4px');

    const desc = createElement('textarea');
    desc.parent(card);
    desc.id('bugDesc');
    desc.attribute('placeholder', 'Give as much information as you can on the bug and the context where it occurred…');
    desc.style('width','100%');
    desc.style('height','120px');
    desc.style('resize','vertical');
    desc.style('padding','8px');
    desc.style('border-radius','8px');
    desc.style('border','1px solid rgba(255,255,255,0.15)');
    desc.style('background','#111');
    desc.style('color','#fff');

    // Ideas textarea
    const ideaLabel = createDiv('<b>Ideas for new features or improvements</b>');
    ideaLabel.parent(card);
    ideaLabel.style('font-size','13px');
    ideaLabel.style('margin','12px 0 4px');

    const ideas = createElement('textarea');
    ideas.parent(card);
    ideas.id('bugIdeas');
    ideas.attribute('placeholder', 'Optional: What would you like to see improved?');
    ideas.style('width','100%');
    ideas.style('height','100px');
    ideas.style('resize','vertical');
    ideas.style('padding','8px');
    ideas.style('border-radius','8px');
    ideas.style('border','1px solid rgba(255,255,255,0.15)');
    ideas.style('background','#111');
    ideas.style('color','#fff');

    // Buttons row
    const row = createDiv('');
    row.parent(card);
    row.style('display','flex');
    row.style('gap','10px');
    row.style('justify-content','flex-end');
    row.style('margin','12px 0 0');

    const cancelBtn = createButton('Cancel');
    cancelBtn.parent(row);
    cancelBtn.mousePressed(closeBugDialog);

    const sendBtn = createButton('Send');
    sendBtn.parent(row);
    sendBtn.style('font-weight','600');
    sendBtn.mousePressed(async () => {
      await submitBugForm({
        description: desc.value().trim(),
        ideas: ideas.value().trim()
      }, sendBtn);
    });

    // Click outside to close
    __bugDialogDiv.mousePressed((ev) => {
      if (ev?.target === __bugDialogDiv.elt) closeBugDialog();
    });

    captureUI?.(__bugDialogDiv.elt); // prevent canvas panning through the modal
  }

  __bugDialogDiv.show();
}

function closeBugDialog() {
  __bugDialogDiv?.hide();
}

async function submitBugForm(payload, btn) {
  try {
    if (!FORM_ENDPOINT || FORM_ENDPOINT.includes('REPLACE_ME')) {
      showToast?.('Form endpoint not configured.');
      return;
    }
    // Basic requirement: need at least a bug description OR ideas
    if (!payload.description && !payload.ideas) {
      showToast?.('Please provide a description or an idea.');
      return;
    }

    // Build context bundle
    const context = {
      url: location?.href || '',
      time: new Date().toISOString(),
      demoMode: !!DEMO_MODE,
      bugMode: !!BUG_MODE,
      projectTitle: (projectMeta?.title || '').trim(), // shown under top-right icons
      datasetBase: (window.DATA_BASE_PREFIX || ''),    // demo dataset path if used
      selectedIndex: (typeof selectedIndex === 'number' ? selectedIndex : null),
      userAgent: (navigator?.userAgent || ''),
      appVersion: (window.APP_VERSION || '')
    };

    const body = {
      description: payload.description,
      ideas: payload.ideas,
      context
    };

    btn?.attribute('disabled', 'true');
    btn?.html('Sending…');

    const r = await fetch(FORM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const t = await r.text().catch(()=> '');
      throw new Error(`HTTP ${r.status}${t ? ` – ${t}` : ''}`);
    }

    // Success UX
    showToast?.('Thanks! Your feedback was sent.');
    closeBugDialog();

  } catch (err) {
    console.error(err);
    showToast?.(`Failed to send: ${err?.message || 'unknown error'}`);
  } finally {
    if (btn) { btn.removeAttribute('disabled'); btn.html('Send'); }
  }
}
