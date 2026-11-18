// Selection system core (owner: selection). V.mask (1024x1024 canvas, ALPHA = selection) stays the one canonical selection, so
// effectiveMask / variations / enforceMask keep working. This module owns everything that CHANGES it:
//   - every mask edit goes through applyNew() so it is undoable twice over: the global undo (snapshot) and a dedicated selection
//     history (run-length encoded, 100 steps per view) that Ctrl+Z walks while a selection tool is active;
//   - the engine (mask.js, pure functions) is only reached through the small `eng` adapter below;
//   - saved selections, the live preview mask (refine edges), numeric readouts, tool metadata and tool hints.
import { state, VIEWS, activeView, snapshot, notify, subscribe, touchMask, hasMask } from './state.js';
import { SIZE, makeCanvas, cloneCanvas, toast } from './util.js';
import { regionAt } from './segment.js';
import * as M from './mask.js';

const N = SIZE * SIZE;
export const MAX_SEL_HISTORY = 100;
export const MODES = ['add', 'subtract', 'intersect', 'replace'];
export const MODE_LABEL = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect', replace: 'Replace' };

/* ------------------------------------------------------------------ tools (metadata shared by the stage bar, the panel and the help) */
export const SEL_TOOLS = [
  { id: 'brush', label: 'Brush', icon: 'brush', key: 'B', basic: true, tip: 'Brush: paint the area to change. Alt removes. [ and ] change the size.' },
  { id: 'eraser', label: 'Eraser', icon: 'eraser', key: 'E', basic: true, tip: 'Eraser: rub out parts of the selection.' },
  { id: 'lasso', label: 'Lasso', icon: 'lasso', key: 'L', basic: true, tip: 'Lasso: draw freehand around the area, then let go.' },
  { id: 'polygon', label: 'Polygon', icon: 'polygon', key: 'P', tip: 'Polygon: click each corner. Double-click or Enter to finish, Backspace removes the last point, Esc cancels.' },
  { id: 'rect', label: 'Rectangle', icon: 'rect', key: 'M', tip: 'Rectangle: drag a box.' },
  { id: 'region', label: 'Click a part', icon: 'pick', key: 'R', basic: true, tip: 'Click a part of the garment (a sleeve, the collar, the body...) to select it. Click more parts to add them.' },
  { id: 'component', label: 'Whole part', icon: 'component', key: 'C', tip: 'Whole part: click anywhere on a piece and the whole piece is selected.' },
  { id: 'smart', label: 'Smart select', icon: 'sparkles', key: 'S', basic: true, tip: 'Smart select: click an object or area (a stripe, a logo, a patch) and it is selected for you.' },
  { id: 'wand', label: 'Magic wand', icon: 'wand', key: 'W', tip: 'Magic wand: click a colour area. Tolerance sets how similar the neighbours must be.' },
  { id: 'color', label: 'By colour', icon: 'color', key: 'K', tip: 'Select by colour: click a pixel (or pick a colour) and everything of that colour is selected.' },
  { id: 'texture', label: 'By material', icon: 'texture', key: 'T', tip: 'Select by material / texture: click a spot and every area with a similar weave or print is selected.' },
];
export const isSelTool = t => SEL_TOOLS.some(x => x.id === t);
export const NEEDS_SEG = new Set(['region', 'component', 'smart']);
const HINTS = {
  brush: 'Brush: drag over the area to change. Shift adds, Alt removes. [ and ] change the size.',
  eraser: 'Eraser: drag to rub out parts of the selection. [ and ] change the size.',
  lasso: 'Lasso: drag a loop around the area, then let go. Shift adds, Alt removes.',
  polygon: 'Polygon: click corners. Double-click or Enter finishes, Backspace removes a point, Esc cancels.',
  rect: 'Rectangle: drag a box over the area. Shift adds, Alt removes.',
  region: 'Click a part (sleeve, collar, body...). Click both sleeves to select them together, then describe the change.',
  component: 'Click anywhere on a piece to select the whole piece.',
  smart: 'Click an object or area (a stripe, a logo, a patch) and it is selected for you.',
  wand: 'Click a colour area. Change the tolerance to grow or shrink what is picked up.',
  color: 'Click a pixel (or pick a colour) to select everything of that colour.',
  texture: 'Click a spot to select every area with a similar material or print.',
};
export function selToolHint(tool) { return HINTS[tool] || ''; }

/* ------------------------------------------------------------------ alpha helpers */
export function readAlpha(c) {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
  return a;
}
export function alphaToCanvas(a, rgb = [79, 70, 229]) {
  const c = makeCanvas(), img = new ImageData(SIZE, SIZE), d = img.data;
  for (let i = 0, j = 0; i < N; i++, j += 4) { d[j] = rgb[0]; d[j + 1] = rgb[1]; d[j + 2] = rgb[2]; d[j + 3] = a[i]; }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
export function writeAlpha(c, a) {
  const x = c.getContext('2d'), img = new ImageData(SIZE, SIZE), d = img.data;
  for (let i = 0, j = 0; i < N; i++, j += 4) { d[j] = 79; d[j + 1] = 70; d[j + 2] = 229; d[j + 3] = a[i]; }
  x.clearRect(0, 0, SIZE, SIZE); x.putImageData(img, 0, 0);
}
function hashAlpha(a) {
  let h = 2166136261 >>> 0;
  const w = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 16777619) >>> 0;
  return h;
}
const sameAlpha = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
export function alphaIsEmpty(a, thr = 24) { for (let i = 0; i < a.length; i++) if (a[i] > thr) return false; return true; }

// run-length coding (selection history keeps 100 steps cheaply); falls back to raw bytes for noisy masks
function rleEncode(a) {
  const out = []; let i = 0;
  while (i < a.length) { const v = a[i]; let j = i + 1; while (j < a.length && a[j] === v && j - i < 0xFFFFFF) j++; out.push(((j - i) << 8 | v) >>> 0); i = j; if (out.length > 200000) return { raw: a.slice() }; }
  return { runs: Uint32Array.from(out) };
}
function rleDecode(e) {
  if (e.raw) return e.raw.slice();
  const a = new Uint8Array(N); let p = 0;
  for (const r of e.runs) { const v = r & 255, n = r >>> 8; if (v) a.fill(v, p, p + n); p += n; }
  return a;
}

/* ------------------------------------------------------------------ engine adapter: the ONLY place that calls mask.js */
// mask.js works on Uint8Array alpha planes and ImageData-like images (tolerances are CIE76 Delta-E, 0-100). The ImageData of a canvas is
// cached per canvas, so repeated picks (and tolerance tuning) reuse the engine's own Lab cache.
const imgCache = new WeakMap();
export function imageData(c) {
  let d = imgCache.get(c);
  if (!d) { d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height); imgCache.set(c, d); }
  return d;
}
export const eng = {
  combine: (a, b, mode) => M.combine(a, b, mode),
  invert: (a, garmentCanvas) => M.invert(a, garmentCanvas || undefined),
  feather: (a, px) => M.feather(a, px),
  expand: (a, px) => M.expand(a, px),
  contract: (a, px) => M.contract(a, px),
  smooth: (a, px) => M.smooth(a, px),
  refine: (a, canvas, o) => M.refineEdge(a, imageData(canvas), o),
  brush: (pts, size, hardness) => M.fromBrushStroke(pts, size, hardness),
  lasso: pts => M.fromLasso(pts),
  polygon: pts => M.fromPolygon(pts),
  rect: (a, b) => M.fromRect(a, b),
  regions: (seg, names) => M.fromRegions(seg, names),
  wand: (canvas, x, y, tol, contig) => M.magicWand(imageData(canvas), x, y, tol, contig),
  byColor: (canvas, rgb, tol) => M.selectByColor(imageData(canvas), rgb, tol),
  byTexture: (canvas, x, y, tol) => M.selectByTexture(imageData(canvas), x, y, tol),
  component: (seg, canvas, x, y) => M.selectComponent(seg, imageData(canvas), x, y, { mode: 'blob' }),
  smart: (canvas, seg, x, y) => M.smartSelect(imageData(canvas), seg, x, y),
  outline: a => M.outline(a),
  bounds: (a, t = 128) => M.bounds(a, t),
};

/* ------------------------------------------------------------------ selection history (per view) */
const hist = Object.fromEntries(VIEWS.map(n => [n, { s: [], i: -1 }]));
let stepId = 0;
const pack = (a, reg, label) => ({ id: ++stepId, enc: rleEncode(a), hash: hashAlpha(a), reg: [...reg], label });
function ensureHist(name = state.activeView) {
  const H = hist[name], V = state.views[name];
  if (!H.s.length) { H.s = [pack(readAlpha(V.mask), V.regionSel, 'Start')]; H.i = 0; }
  return H;
}
function pushHist(name, a, reg, label) {
  const H = ensureHist(name);
  H.s.length = H.i + 1;
  const e = pack(a, reg, label); H.s.push(e);
  if (H.s.length > MAX_SEL_HISTORY) H.s.shift();
  H.i = H.s.length - 1;
  return e;
}
export const selTopId = (name = state.activeView) => { const H = hist[name]; return H.s[H.i]?.id ?? null; };
export function selHistInfo(name = state.activeView) {
  const H = hist[name];
  return { canUndo: H.i > 0, canRedo: H.i >= 0 && H.i < H.s.length - 1, index: Math.max(0, H.i), count: H.s.length, steps: Math.max(0, H.i), label: H.s[H.i]?.label || '' };
}
function setMaskFromEntry(V, e) {
  writeAlpha(V.mask, rleDecode(e.enc)); V.regionSel = [...e.reg]; touchMask(V); clearPreview(); notify('mask');
}
export function selUndo() {
  const V = activeView(), H = ensureHist(), cur = H.s[H.i];
  if (H.i <= 0) return false;
  H.i--;
  const top = state.undoStack[state.undoStack.length - 1];
  if (top && top._selId === cur.id) state.undoStack.pop();   // the matching global step is consumed together with it
  setMaskFromEntry(V, H.s[H.i]); notify('history');
  return true;
}
export function selRedo() {
  const V = activeView(), H = ensureHist();
  if (H.i >= H.s.length - 1) return false;
  H.i++;
  snapshot(); const top = state.undoStack[state.undoStack.length - 1]; if (top) top._selId = H.s[H.i].id;
  setMaskFromEntry(V, H.s[H.i]); notify('history');
  return true;
}
subscribe(r => {
  if (r === 'loaded') { for (const n of VIEWS) hist[n] = { s: [], i: -1 }; clearPreview(); }
  else if (r === 'restore') {   // global undo / redo / version restore changed the mask: keep the selection history coherent
    for (const n of VIEWS) {
      const H = hist[n]; if (!H.s.length) continue;
      const V = state.views[n], a = readAlpha(V.mask), hh = hashAlpha(a);
      if (hh === H.s[H.i].hash) continue;
      let at = -1;   // the restored mask is one we already know: step to it, so "undo selection" keeps walking the same line
      for (let d = 1; d < H.s.length && at < 0; d++) { if (H.s[H.i - d]?.hash === hh) at = H.i - d; else if (H.s[H.i + d]?.hash === hh) at = H.i + d; }
      if (at >= 0) H.i = at; else pushHist(n, a, V.regionSel, 'Restored');
    }
    clearPreview();
  }
});

/* ------------------------------------------------------------------ the one mutation entry point */
/** Replaces the selection of `V` by alpha `next`. Undoable. Returns false when nothing changed. */
export function applyNew(next, label, { V = activeView(), regionSel = null, silent = false } = {}) {
  const name = VIEWS.find(n => state.views[n] === V) || state.activeView;
  const H = ensureHist(name), old = readAlpha(V.mask);
  const reg = regionSel || V.regionSel;
  if (sameAlpha(old, next) && reg.join() === V.regionSel.join()) return false;
  snapshot();
  const top = state.undoStack[state.undoStack.length - 1];
  clearPreview();
  writeAlpha(V.mask, next); V.regionSel = [...reg]; touchMask(V);
  const e = pushHist(name, next, reg, label);
  if (top) top._selId = e.id;
  state.flow.skippedSelect = false;
  if (!silent) notify('mask');
  return true;
}
/** Combines a shape (alpha) with the current selection by `mode` and records it. */
export function commitShape(shape, mode, label, opts = {}) {
  const V = opts.V || activeView(), cur = readAlpha(V.mask);
  const next = mode === 'replace' ? shape : eng.combine(cur, shape, mode);
  return applyNew(next, label, { V, regionSel: opts.regionSel });
}

/* ------------------------------------------------------------------ live preview mask (refine edges, in-progress edits) */
export const preview = { view: null, canvas: null, rev: 0 };
export function setPreview(V, alphaOrCanvas) {
  preview.view = V; preview.canvas = alphaOrCanvas instanceof Uint8Array ? alphaToCanvas(alphaOrCanvas) : alphaOrCanvas; preview.rev++;
  notify('render');
}
export function clearPreview() {
  if (!preview.canvas) { refine.active = false; return; }
  preview.view = null; preview.canvas = null; preview.rev++; refine.active = false; clearTimeout(refine.t); notify('render');
}
/** the mask the overlay shows: the preview while one is active, otherwise the real selection */
export const displayMask = V => (preview.canvas && preview.view === V ? preview.canvas : V.mask);
export const displayRev = V => (preview.canvas && preview.view === V ? 'p' + preview.rev : 'm' + V.maskRev);

/* ------------------------------------------------------------------ friendly guards */
const segOk = V => !!(V.seg && V.seg.mask && !V.seg.metrics?.empty);
let lastHint = 0;
export function hint(msg, kind = 'info') { const t = Date.now(); if (t - lastHint > 1500) { lastHint = t; toast(msg, kind, 4200); } }
export function needSeg(V = activeView()) {
  if (segOk(V)) return true;
  hint('The garment outline was not found for this image, so this tool cannot tell the parts apart. Try the Brush, Lasso or Magic wand instead.');
  return false;
}

/* ------------------------------------------------------------------ operations used by the UI */
const gArea = new WeakMap();
function garmentAlpha(V) {
  if (!V.seg?.mask) return null;
  let g = gArea.get(V.seg.mask);
  if (!g) { g = readAlpha(V.seg.mask); gArea.set(V.seg.mask, g); }
  return g;
}
export function selectEntireGarment(mode = null, V = activeView()) {
  if (!needSeg(V)) return false;
  return commitShape(garmentAlpha(V), mode || modeNow(), 'Select garment', { V, regionSel: [] });
}
export function clearSelection(V = activeView()) {
  if (alphaIsEmpty(readAlpha(V.mask), 0) && !V.regionSel.length) return false;
  return applyNew(new Uint8Array(N), 'Clear', { V, regionSel: [] });
}
export function invertSelection(V = activeView()) {
  const cur = readAlpha(V.mask), g = garmentAlpha(V);
  let next;
  try { next = eng.invert(cur, g ? V.seg.mask : null); } catch (e) { console.error(e); return false; }
  return applyNew(next, 'Invert', { V, regionSel: [] });
}
export function toggleRegion(name, V = activeView()) {
  if (!V.seg?.regions?.[name]) { toast(`No "${name}" area was found on this garment.`, 'info'); return false; }
  const on = V.regionSel.includes(name);
  return regionOp([name], on ? 'subtract' : 'add', V);
}
/** names: region names. Updates the chips (regionSel) along with the pixels. */
export function regionOp(names, mode, V = activeView()) {
  const have = names.filter(n => V.seg?.regions?.[n]);
  if (!have.length) { toast('That part was not found on this garment. Try the Brush or Lasso.', 'info'); return false; }
  let reg = [...V.regionSel];
  if (mode === 'add') for (const n of have) { if (!reg.includes(n)) reg.push(n); }
  else if (mode === 'subtract') reg = reg.filter(n => !have.includes(n));
  else if (mode === 'replace') reg = [...have];
  else reg = reg.filter(n => have.includes(n));
  const label = (mode === 'subtract' ? 'Deselect ' : 'Select ') + have.join(' + ');
  return commitShape(eng.regions(V.seg, have), mode, label, { V, regionSel: reg });
}
export function selectBothSleeves(V = activeView()) {
  const names = ['leftSleeve', 'rightSleeve'].filter(n => V.seg?.regions?.[n]);
  if (!names.length) { hint('No sleeves were found on this view. Try the Lasso around them, or switch to the front view.'); return false; }
  return regionOp(names, 'add', V);
}
const mod = (fn, label) => (px, V = activeView()) => {
  if (!hasMask(V)) { hint('Select an area first.'); return false; }
  let next; try { next = fn(readAlpha(V.mask), px, V); } catch (e) { console.error(e); toast('That could not be applied to this selection.', 'error'); return false; }
  return applyNew(next, label(px), { V });
};
export const expandSelection = mod((a, px) => eng.expand(a, px), px => `Expand ${px}px`);
export const contractSelection = mod((a, px) => eng.contract(a, px), px => `Contract ${px}px`);
export const featherSelection = mod((a, px) => eng.feather(a, px), px => `Feather ${px}px`);
export const smoothSelection = mod((a, px) => eng.smooth(a, px), px => `Smooth ${px}px`);

// Refine edges: a live preview (the overlay edge follows the sliders), then Apply or Cancel
export const refine = { active: false, base: null, t: 0, V: null };
export function refinePreview() {
  const V = activeView();
  if (!hasMask(V) || !V.current) { hint('Select an area first, then refine its edge.'); return false; }
  if (!refine.active || refine.V !== V) { refine.active = true; refine.V = V; refine.base = readAlpha(V.mask); }
  clearTimeout(refine.t);
  refine.t = setTimeout(() => {
    if (!refine.active) return;
    const o = state.ui.refine;
    try { setPreview(V, eng.refine(refine.base, V.current, { radius: o.radius, strength: o.strength / 100 })); } catch (e) { console.error(e); }
    notify('refine');
  }, 50);
  notify('refine');
  return true;
}
export function applyRefine() {
  const V = refine.V; if (!refine.active || !V || !preview.canvas) return false;
  const next = readAlpha(preview.canvas);
  refine.active = false;
  return applyNew(next, 'Refine edges', { V });
}
export function cancelRefine() { refine.active = false; clearTimeout(refine.t); clearPreview(); notify('refine'); }
subscribe(r => { if (r === 'view' || r === 'tool') { if (refine.active) cancelRefine(); } });

export function effectiveMode(e, tool) {
  const basic = typeof document !== 'undefined' && document.body.dataset.mode !== 'advanced';
  let m = basic ? 'add' : state.ui.selMode;
  if (tool === 'eraser') return 'subtract';
  if (e?.shiftKey && e?.altKey) m = 'intersect'; else if (e?.shiftKey) m = 'add'; else if (e?.altKey) m = 'subtract';
  return m;
}
export const modeNow = () => effectiveMode(null, state.ui.tool);

/* ------------------------------------------------------------------ pick tools (single click) */
export function pixelColor(V, x, y) {
  const c = V.current; if (!c) return null;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(clampI(x), clampI(y), 1, 1).data;
  return d[3] < 8 ? null : [d[0], d[1], d[2]];
}
const clampI = v => Math.max(0, Math.min(SIZE - 1, Math.floor(v)));
export const rgbToHex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
export const hexToRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
// tolerance sliders are 0-100 in the UI; the engine takes them as-is (see mask.js)
/** shape builders for the click tools. Return alpha or null. */
export function pickShape(tool, V, p) {
  const x = clampI(p.x), y = clampI(p.y), o = state.ui;
  if (!V.current) return null;
  if (tool === 'wand') return eng.wand(V.current, x, y, o.wandTol, o.wandContig);
  if (tool === 'texture') return eng.byTexture(V.current, x, y, o.texTol);
  if (tool === 'color') { const rgb = pixelColor(V, x, y); if (!rgb) return null; o.pickColor = rgbToHex(rgb); return eng.byColor(V.current, rgb, o.colorTol); }
  if (tool === 'component') { if (!needSeg(V)) return null; return eng.component(V.seg, V.current, x, y); }
  if (tool === 'smart') { if (!needSeg(V)) return null; return eng.smart(V.current, V.seg, x, y); }
  return null;
}
export function selectByPickedColor(V = activeView(), mode = null) {
  const rgb = hexToRgb(state.ui.pickColor); if (!rgb || !V.current) return false;
  return commitShape(eng.byColor(V.current, rgb, state.ui.colorTol), mode || modeNow(), 'Select by colour', { V });
}
export { regionAt };

/* ------------------------------------------------------------------ readouts */
const statCache = new WeakMap();
export function selectionStats(V = activeView()) {
  const key = V.maskRev, gm = V.seg?.mask || null;
  const c = statCache.get(V.mask);
  if (c && c.key === key && c.gm === gm) return c.val;
  const a = readAlpha(V.mask), g = garmentAlpha(V);
  let n = 0, ing = 0, gn = 0;
  for (let i = 0; i < N; i++) {
    const ig = g && g[i] >= 128;
    if (ig) gn++;
    if (a[i] >= 128) { n++; if (ig) ing++; }
  }
  const b = n ? eng.bounds(a, 128) : null;
  const val = { empty: n === 0, area: n, pct: gn ? (ing / gn) * 100 : null, bounds: b && b.w ? b : null };
  statCache.set(V.mask, { key, gm, val });
  return val;
}

/* ------------------------------------------------------------------ saved selections (per view, saved with the design) */
let savedId = 0;
const newSavedId = () => 's' + Date.now().toString(36) + (++savedId).toString(36) + Math.random().toString(36).slice(2, 5);
export function saveSelection(name, V = activeView()) {
  if (!hasMask(V)) { hint('Select an area first, then save it.'); return null; }
  snapshot();
  V.saved = [...(V.saved || [])];
  const nm = (String(name || '').trim() || `Selection ${V.saved.length + 1}`).slice(0, 60);
  const s = { id: newSavedId(), name: nm, canvas: cloneCanvas(V.mask), t: Date.now() };
  V.saved.push(s); notify('saved');
  return s;
}
export function loadSaved(id, mode = state.ui.savedMode, V = activeView()) {
  const s = (V.saved || []).find(x => x.id === id); if (!s) return false;
  const shape = readAlpha(s.canvas);
  return commitShape(shape, mode, `Load "${s.name}" (${mode})`, { V, regionSel: mode === 'replace' ? [] : undefined });
}
export function renameSaved(id, name, V = activeView()) {
  const i = (V.saved || []).findIndex(x => x.id === id), nm = String(name || '').trim().slice(0, 60);
  if (i < 0 || !nm || V.saved[i].name === nm) return false;
  snapshot(); V.saved = V.saved.map(s => (s.id === id ? { ...s, name: nm } : s)); notify('saved'); return true;
}
export function deleteSaved(id, V = activeView()) {
  if (!(V.saved || []).some(x => x.id === id)) return false;
  snapshot(); V.saved = V.saved.filter(s => s.id !== id); notify('saved'); return true;
}

/* ------------------------------------------------------------------ misc */
export function selectionBounds(V = activeView()) { return selectionStats(V).bounds; }
export function resetViewHistory(name) { hist[name] = { s: [], i: -1 }; }
export function onViewImageReplaced(name) { hist[name] = { s: [], i: -1 }; const V = state.views[name]; V.saved = []; }
