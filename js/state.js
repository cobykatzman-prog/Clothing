// Single store (owner: shell).
import { makeCanvas, cloneCanvas, thumbOf, maskIsEmpty, canvasToBlob, toast } from './util.js';
import { DEFAULT_PARAMS } from './warp.js';
import { segmentGarment } from './segment.js';
import { ElementLayer } from './elements.js';
import { defaultMeasureState, normalizeMeasureState } from './measure.js';
import { defaultSpecState, normalizeSpecState } from './spec.js';
import { defaultTechPack, normalizeTechPack } from './techpack.js';
import { emptyColourways, normalizeColourways, colourwaysDoc, appearanceOfView, captureElementColours } from './colourway-model.js';

export const VIEWS = ['front', 'back', 'side', 'detail'];
export const VIEW_LABELS = { front: 'Front', back: 'Back', side: 'Side', detail: 'Detail' };
const MAX_UNDO = 30, MAX_VERSIONS = 24;

export function newColor() { return { hue: 0, sat: 0, light: 0, tint: null, tintAmount: 0.5 }; }
export function newView() {
  return {
    original: null,   // untouched upload / generated image
    base: null,       // what sliders are derived from (original, or an accepted option)
    baseSeg: null,
    current: null,    // base + shape + fabric + colour  (what is displayed)
    seg: null,        // segmentation of `current`
    mask: makeCanvas(),
    maskRev: 0, _maskCache: null,
    params: { ...DEFAULT_PARAMS },
    presets: { fit: null, sleeve: null },   // preset that started the shape (ui-look.js)
    color: newColor(),
    parts: {},        // per-garment-part colour {[region]: {color, hue, sat, light}} (manual.js)
    fabric: { name: null, amount: 0.6 },
    regionSel: [],
    saved: [],        // named saved selections [{id, name, canvas (alpha = selection), t}] (selection.js)
    sample: null,     // {kind,color,stripe} when procedural
    job: 0,
  };
}

const subs = new Set();
export const state = {
  name: 'Untitled design',
  techpack: defaultTechPack(),      // tech pack fields: notes, trims, stitching, construction, revision (techpack.js, saved with the design)
  spec: defaultSpecState(),         // per-size manual values, grading increments, tolerances (spec.js, saved with the design)
  measure: defaultMeasureState(),   // size / unit / calibration / show-dimensions of this design (measure.js, saved with the design)
  colourways: emptyColourways(),   // {list, activeId}: colours / fabrics / material notes per colourway; the shape is shared (colourways.js)
  tags: [],              // home-page tags of this design (saved in the design document, see serializeDesign)
  views: Object.fromEntries(VIEWS.map(v => [v, newView()])),
  activeView: 'front',
  get params() { return this.views[this.activeView].params; },
  elements: [],
  selectedId: null,
  references: [],
  versions: [],
  undoStack: [], redoStack: [],
  variations: null,      // [{label, canvas, seg, source, ops}]
  lastOps: null,
  review: null,          // the option being previewed (review.js); not saved
  edits: [],             // accepted edits, oldest first, max 50 (review.js): {id, n, time, prompt, summary, level, source, view, thumbs, before, after}
  editHead: null,        // id of the edit whose result is on the garment now (null = before the first kept edit)
  editSeq: 0,
  flow: { described: false, generated: false, compared: false, refined: false, exported: false, skippedSelect: false },
  ui: {
    tool: 'move', snap: true, multi: [], multiFor: null, brushSize: 48, brushHardness: 1, showMask: true, compare: false, comparePos: 0.5, compareMode: 'slider', flipShow: 'after', peek: false, limitToSelection: false, busy: 0, prompt: '', notes: '',
    // selection tools (selection.js / ui-select.js); none of this is saved with the design
    selMode: 'add',                                   // add | subtract | intersect | replace
    wandTol: 20, wandContig: true, colorTol: 20, texTol: 30, pickColor: '#8a6a4a',
    feather: 4, grow: 4, smoothPx: 3, refine: { radius: 6, strength: 60 }, savedMode: 'replace',
    ovl: { show: true, style: 'both', opacity: 26, color: '#4f46e5', view: 'normal', animate: true },   // style: both | ants | tint; view: normal | mask | only
  },
};
export const activeView = () => state.views[state.activeView];

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function notify(reason = 'change') { subs.forEach(fn => { try { fn(reason); } catch (e) { console.error(e); } }); }
export function markFlow(k) { if (!state.flow[k]) { state.flow[k] = true; notify('flow'); } }
export function touchMask(v) { v.maskRev++; }
export function hasMask(v = activeView()) {   // exact (any selected pixel counts, even on a 2 px detail), cached per mask revision
  if (!v._has || v._has.rev !== v.maskRev || v._has.c !== v.mask) v._has = { rev: v.maskRev, c: v.mask, val: !maskIsEmpty(v.mask) };
  return v._has.val;
}

// ---- snapshots ----
export function cloneElement(e) {
  if (typeof e.clone === 'function') { const c = e.clone(); c.id = e.id; return c; }
  const c = Object.assign(Object.create(Object.getPrototypeOf(e)), e);
  c.props = { ...(e.props || {}) };
  return c;
}
function maskClone(v) {
  if (!v._maskCache || v._maskCache.rev !== v.maskRev) v._maskCache = { rev: v.maskRev, canvas: cloneCanvas(v.mask) };
  return v._maskCache.canvas;
}
export function capture() {
  const views = {};
  for (const n of VIEWS) {
    const v = state.views[n];
    views[n] = {
      original: v.original, base: v.base, baseSeg: v.baseSeg, current: v.current, seg: v.seg,
      mask: maskClone(v), params: { ...v.params }, presets: { ...(v.presets || {}) }, color: { ...v.color }, fabric: { ...v.fabric },
      regionSel: [...v.regionSel], sample: v.sample, parts: { ...v.parts }, saved: [...(v.saved || [])],
    };
  }
  return { views, elements: state.elements.map(cloneElement), activeView: state.activeView, name: state.name, measure: { ...state.measure }, spec: normalizeSpecState(state.spec), techpack: normalizeTechPack(state.techpack), cwActive: state.colourways.activeId };
}
function apply(s) {
  const keepSel = state.selectedId;   // undo / redo keeps the selected layer when it still exists
  for (const n of VIEWS) {
    const v = state.views[n], d = s.views[n];
    v.job++; // cancel pending recomputes
    Object.assign(v, { original: d.original, base: d.base, baseSeg: d.baseSeg, current: d.current, seg: d.seg,
      params: { ...d.params }, presets: { ...(d.presets || {}) }, color: { ...d.color }, fabric: { ...d.fabric }, regionSel: [...d.regionSel], sample: d.sample, parts: { ...d.parts }, saved: [...(d.saved || [])] });
    const x = v.mask.getContext('2d'); x.clearRect(0, 0, v.mask.width, v.mask.height); x.drawImage(d.mask, 0, 0);
    v.maskRev++; v._maskCache = { rev: v.maskRev, canvas: d.mask };
  }
  state.elements = s.elements.map(cloneElement);
  state.activeView = s.activeView;
  state.name = s.name;
  if (s.measure) state.measure = { ...s.measure };
  state.spec = normalizeSpecState(s.spec);
  state.techpack = normalizeTechPack(s.techpack);
  if ('cwActive' in s && (s.cwActive == null || state.colourways.list.some(c => c.id === s.cwActive))) state.colourways.activeId = s.cwActive;
  state.selectedId = state.elements.some(e => e.id === keepSel && (!e.view || e.view === s.activeView)) ? keepSel : null;
}
/** Call BEFORE a mutation: records the current state as an undo step. */
export function snapshot() {
  state.undoStack.push(capture());
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack.length = 0;
  notify('history');
}
export function undo() {
  if (!state.undoStack.length) return false;
  state.redoStack.push(capture());
  apply(state.undoStack.pop());
  notify('restore'); return true;
}
export function redo() {
  if (!state.redoStack.length) return false;
  state.undoStack.push(capture());
  apply(state.redoStack.pop());
  notify('restore'); return true;
}
export function pushVersion(label) {
  const v = activeView();
  const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const thumb = v.current ? thumbOf(v.current, 120, '#f3f2ef').toDataURL('image/jpeg', 0.8) : '';
  state.versions.unshift({ id, label, thumb, time: Date.now(), view: state.activeView, snapshot: capture() });
  if (state.versions.length > MAX_VERSIONS) state.versions.pop();
  notify('versions');
  return id;
}
export function restoreVersion(id) {
  const ver = state.versions.find(v => v.id === id);
  if (!ver) return false;
  if (!ver.snapshot) {   // saved version loaded from storage: decode it first, then restore
    if (!ver.loading) ver.loading = ver.load()
      .then(s => { ver.snapshot = s; ver.loading = null; })
      .catch(e => { ver.loading = null; console.error(e); toast('That version could not be opened.', 'error'); });
    ver.loading.then(() => { if (ver.snapshot) restoreVersion(id); });
    return true;
  }
  snapshot();
  apply(ver.snapshot);
  notify('restore');
  return true;
}

// ---- persistence: serialize / hydrate a whole design (used by main.js via storage.js) ----
// Canvases are stored as PNG assets, keyed 'a0', 'a1'... and deduplicated by identity.
// Element/param/colour settings are plain JSON. Segmentation is recomputed on load (it is deterministic).
const blobCache = new WeakMap();   // canvas -> Promise<Blob|dataURL>; only for canvases never drawn on again
const isLiveMask = c => VIEWS.some(n => state.views[n].mask === c);
function encodeCanvas(c) {
  const live = isLiveMask(c);     // live masks are painted in place, so never cache them
  if (!live && blobCache.has(c)) return blobCache.get(c);
  const p = canvasToBlob(c, 'image/png');
  if (!live) blobCache.set(c, p);
  return p;
}
function makeRefs() {
  const keys = new Map(), assets = {}, jobs = [];
  const add = (obj, make) => {
    let k = keys.get(obj);
    if (!k) { k = 'a' + keys.size; keys.set(obj, k); jobs.push(make().then(x => { assets[k] = x; })); }
    return k;
  };
  return {
    assets, jobs,
    canvas: c => (c ? add(c, () => encodeCanvas(c)) : null),
    raw: v => (v == null ? null : add(v, () => Promise.resolve(v))),
  };
}
const elDoc = e => (typeof e.toJSON === 'function' ? e.toJSON() : JSON.parse(JSON.stringify(e)));
function viewDoc(v, ref) {
  return {
    original: ref(v.original), base: ref(v.base), current: ref(v.current),
    sameBase: !!v.base && v.current === v.base,
    mask: v.mask && !maskIsEmpty(v.mask) ? ref(v.mask) : null,
    params: { ...v.params }, presets: { ...(v.presets || {}) }, color: { ...v.color }, fabric: { ...v.fabric }, parts: JSON.parse(JSON.stringify(v.parts || {})),
    regionSel: [...(v.regionSel || [])], sample: v.sample ? JSON.parse(JSON.stringify(v.sample)) : null,
    saved: (v.saved || []).filter(x => x.canvas).map(x => ({ id: x.id, name: x.name, t: x.t || 0, canvas: ref(x.canvas) })),
  };
}
function snapDoc(s, ref) {   // s has the shape produced by capture()
  return {
    views: Object.fromEntries(VIEWS.map(n => [n, viewDoc(s.views[n], ref)])),
    elements: s.elements.map(elDoc), activeView: s.activeView, name: s.name,
    measure: s.measure ? { ...s.measure } : null,
    spec: s.spec ? normalizeSpecState(s.spec) : null,
    techpack: s.techpack ? normalizeTechPack(s.techpack) : null,
  };
}
// a version that is still in storage: re-reference its assets in the new save
function remapRaw(raw, R) {
  if (!raw || !raw.snapshot) return null;
  const s = JSON.parse(JSON.stringify(raw.snapshot));
  for (const n of VIEWS) {
    const d = s.views?.[n]; if (!d) continue;
    for (const f of ['original', 'base', 'current', 'mask']) d[f] = d[f] ? R.raw(raw.assets?.[d[f]] ?? null) : null;
    d.saved = (d.saved || []).map(x => ({ ...x, canvas: x.canvas ? R.raw(raw.assets?.[x.canvas] ?? null) : null })).filter(x => x.canvas);
  }
  return s;
}

/** Writes what the studio shows now back into the active colourway (colours, fabrics, layer colours; never the shape). */
export function syncActiveColourway() {
  const cw = state.colourways, c = cw.list.find(x => x.id === cw.activeId);
  if (!c) return null;
  for (const n of VIEWS) if (state.views[n].base) c.views[n] = appearanceOfView(state.views[n]);
  const now = captureElementColours(state.elements);
  c.elements = now;
  // a layer added after the other colourways were made starts with the same colours in all of them
  for (const o of cw.list) if (o !== c) for (const [id, col] of Object.entries(now)) if (!o.elements[id]) o.elements[id] = { ...col };
  return c;
}

/** Whole design -> { doc, assets }. assets: { key: Blob|dataURL }. Safe to call while editing. */
export async function serializeDesign() {
  syncActiveColourway();
  const R = makeRefs();
  const doc = {
    v: 1, name: state.name, activeView: state.activeView, tags: [...(state.tags || [])], measure: { ...state.measure }, spec: normalizeSpecState(state.spec), techpack: normalizeTechPack(state.techpack),
    views: Object.fromEntries(VIEWS.map(n => [n, viewDoc(state.views[n], R.canvas)])),
    elements: state.elements.map(elDoc),
    references: state.references.filter(Boolean).map(R.canvas),
    flow: { ...state.flow }, colourways: colourwaysDoc(state.colourways),
    edits: state.edits.map(e => editDoc(e, R)), editHead: state.editHead, editSeq: state.editSeq,
    versions: state.versions.map(ver => ({
      id: ver.id, label: ver.label, thumb: ver.thumb, time: ver.time, view: ver.view,
      snapshot: ver.snapshot ? snapDoc(ver.snapshot, R.canvas) : remapRaw(ver._raw, R),
    })),
  };
  await Promise.all(R.jobs);
  return { doc, assets: R.assets };
}

async function assetToCanvas(x) {
  let src;
  if (typeof x === 'string') { src = new Image(); src.src = x; await src.decode(); }
  else src = await createImageBitmap(x);
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  src.close?.();
  blobCache.set(c, Promise.resolve(x));   // unchanged until the next save: no need to re-encode it
  return c;
}
function assetLoader(assets = {}) {
  const cache = new Map();
  return k => {
    if (!k || assets[k] == null) return Promise.resolve(null);
    if (!cache.has(k)) cache.set(k, assetToCanvas(assets[k]));
    return cache.get(k);
  };
}
const blankView = () => ({
  original: null, base: null, baseSeg: null, current: null, seg: null, mask: makeCanvas(),
  maskRev: 0, _maskCache: null, params: { ...DEFAULT_PARAMS }, presets: { fit: null, sleeve: null }, color: newColor(), parts: {},
  fabric: { name: null, amount: 0.6 }, regionSel: [], saved: [], sample: null, job: 0,
});
async function hydrateView(vd, load) {
  const f = blankView();
  if (!vd) return f;
  const [original, base, current, mask] = await Promise.all([vd.original, vd.base, vd.current, vd.mask].map(k => load(k)));
  const saved = (await Promise.all((vd.saved || []).map(async x => ({ id: String(x.id), name: String(x.name || 'Selection').slice(0, 60), t: x.t || 0, canvas: await load(x.canvas) })))).filter(x => x.canvas);
  Object.assign(f, { saved,
    original, base, current: vd.sameBase ? base : (current || base), mask: mask || makeCanvas(),
    params: { ...DEFAULT_PARAMS, ...(vd.params || {}) }, color: { ...newColor(), ...(vd.color || {}) },
    presets: { ...f.presets, ...(vd.presets || {}) }, parts: { ...(vd.parts || {}) }, fabric: { ...f.fabric, ...(vd.fabric || {}) }, regionSel: [...(vd.regionSel || [])], sample: vd.sample || null,
  });
  return f;
}
async function segmentView(f) {
  if (f.base) f.baseSeg = await segmentGarment(f.base);
  if (f.current) f.seg = f.current === f.base ? f.baseSeg : await segmentGarment(f.current);
  return f;
}
async function hydrateSnapshot(sd, load) {
  const views = {};
  await Promise.all(VIEWS.map(async n => { views[n] = await segmentView(await hydrateView(sd.views?.[n], load)); }));
  return {
    views, elements: (sd.elements || []).map(o => ElementLayer.fromJSON(o)),
    activeView: sd.activeView || 'front', name: sd.name || 'Untitled design',
    // Version snapshots must restore the measurement setup as well as the artwork.
    // Older saved versions did not include it, so fall back to the standard defaults.
    measure: sd.measure ? normalizeMeasureState(sd.measure) : defaultMeasureState(),
    spec: normalizeSpecState(sd.spec),
    techpack: normalizeTechPack(sd.techpack),
  };
}
function lazyVersion(v, assets) {
  const ver = {
    id: v.id, label: v.label, thumb: v.thumb || '', time: v.time || 0, view: v.view,
    snapshot: null, _raw: { snapshot: v.snapshot, assets },
  };
  ver.load = () => hydrateSnapshot(v.snapshot || {}, assetLoader(assets));
  return ver;
}

/** Replaces the whole studio with a serialized design (see serializeDesign). */
export async function hydrateDesign(doc = {}, assets = {}) {
  const load = assetLoader(assets);
  const views = {};
  await Promise.all(VIEWS.map(async n => { views[n] = await segmentView(await hydrateView(doc.views?.[n], load)); }));
  for (const n of VIEWS) {
    const job = state.views[n].job + 1;          // cancels pending recomputes of the previous design
    Object.assign(state.views[n], views[n], { job });
  }
  state.name = doc.name || 'Untitled design';
  state.tags = Array.isArray(doc.tags) ? doc.tags.filter(t => typeof t === 'string') : [];
  state.activeView = VIEWS.includes(doc.activeView) ? doc.activeView : 'front';
  state.measure = normalizeMeasureState(doc.measure);
  state.spec = normalizeSpecState(doc.spec);
  state.techpack = normalizeTechPack(doc.techpack);
  state.colourways = normalizeColourways(doc.colourways);
  state.selectedId = null;
  state.elements = (doc.elements || []).map(o => ElementLayer.fromJSON(o));
  state.references = (await Promise.all((doc.references || []).map(k => load(k)))).filter(Boolean);
  state.flow = { described: false, generated: false, compared: false, refined: false, exported: false, skippedSelect: false, ...(doc.flow || {}) };
  state.undoStack.length = 0; state.redoStack.length = 0;
  state.variations = null; state.lastOps = null; state.applied = null; state.review = null;
  state.versions = (doc.versions || []).map(v => lazyVersion(v, assets));
  state.edits = (doc.edits || []).map(d => lazyEdit(d, assets));
  state.editHead = state.edits.some(e => e.id === doc.editHead) ? doc.editHead : null;
  state.editSeq = Math.max(0, Number(doc.editSeq) || 0, ...state.edits.map(e => e.n || 0));
  notify('loaded');
}

// ---- edit history (review.js): every accepted edit keeps a full 'before' and 'after' snapshot, decoded on demand ----
const EMPTY_MASK = makeCanvas();   // shared empty selection for snapshots; never painted on
/** Like capture(), but empty selections share one canvas so an edit does not copy four empty masks. */
export function captureEdit() {
  const s = capture();
  for (const n of VIEWS) if (maskIsEmpty(s.views[n].mask)) s.views[n].mask = EMPTY_MASK;
  return s;
}
/** Puts a snapshot from captureEdit()/decodeEdit() on the garment (the caller records the undo step). */
export function applySnapshot(s) { apply(s); notify('restore'); }
function editSide(e, which, R) {
  if (e[which]) return snapDoc(e[which], R.canvas);
  return e._raw?.[which] ? remapRaw({ snapshot: e._raw[which], assets: e._raw.assets }, R) : null;
}
export function editDoc(e, R) {
  return {
    id: e.id, n: e.n, time: e.time, prompt: e.prompt, summary: e.summary, level: e.level, source: e.source, view: e.view,
    selThumb: e.selThumb, beforeThumb: e.beforeThumb, afterThumb: e.afterThumb,
    before: editSide(e, 'before', R), after: editSide(e, 'after', R),
  };
}
export function lazyEdit(d, assets) {
  return { id: String(d.id), n: Number(d.n) || 0, time: d.time || 0, prompt: String(d.prompt || ''), summary: String(d.summary || ''), level: String(d.level || ''),
    source: d.source === 'ai' ? 'ai' : d.source === 'revert' ? 'revert' : 'local', view: VIEWS.includes(d.view) ? d.view : 'front',
    selThumb: d.selThumb || '', beforeThumb: d.beforeThumb || '', afterThumb: d.afterThumb || '',
    before: null, after: null, _raw: { assets, before: d.before || null, after: d.after || null } };
}
/** Decodes (and caches) the 'before' or 'after' snapshot of an edit. Resolves null when the edit has no such picture. */
export function decodeEdit(e, which) {
  if (e[which]) return Promise.resolve(e[which]);
  if (!e._raw?.[which]) return Promise.resolve(null);
  const key = '_p' + which;
  if (!e[key]) e[key] = hydrateSnapshot(e._raw[which], assetLoader(e._raw.assets)).then(s => { e[which] = s; return s; }, err => { e[key] = null; throw err; });
  return e[key];
}
