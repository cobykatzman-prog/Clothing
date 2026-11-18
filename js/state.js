// Single store (owner: shell).
import { makeCanvas, cloneCanvas, thumbOf, maskIsEmpty } from './util.js';
import { DEFAULT_PARAMS } from './warp.js';

export const VIEWS = ['front', 'back', 'side', 'detail'];
export const VIEW_LABELS = { front: 'Front', back: 'Back', side: 'Side', detail: 'Detail' };
const MAX_UNDO = 30, MAX_VERSIONS = 24;

export function newColor() { return { hue: 0, sat: 0, light: 0, tint: null, tintAmount: 0.5 }; }
export function newView() {
  return {
    original: null,   // untouched upload / generated image
    base: null,       // what sliders are derived from (original, or an accepted AI result)
    baseSeg: null,
    current: null,    // base + shape + fabric + colour  (what is displayed)
    seg: null,        // segmentation of `current`
    mask: makeCanvas(),
    maskRev: 0, _maskCache: null,
    params: { ...DEFAULT_PARAMS },
    color: newColor(),
    fabric: { name: null, amount: 0.6 },
    regionSel: [],
    sample: null,     // {kind,color,stripe} when procedural
    job: 0,
  };
}

const subs = new Set();
export const state = {
  name: 'Untitled design',
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
  engine: { available: false, provider: 'local', used: null },
  flow: { described: false, generated: false, compared: false, refined: false, exported: false, skippedSelect: false },
  ui: { tool: 'move', brushSize: 48, brushMode: 'add', showMask: true, compare: false, comparePos: 0.5, limitToSelection: false, busy: 0, prompt: '', notes: '' },
};
export const activeView = () => state.views[state.activeView];

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function notify(reason = 'change') { subs.forEach(fn => { try { fn(reason); } catch (e) { console.error(e); } }); }
export function markFlow(k) { if (!state.flow[k]) { state.flow[k] = true; notify('flow'); } }
export function touchMask(v) { v.maskRev++; }
export function hasMask(v = activeView()) { return !maskIsEmpty(v.mask); }

// ---- snapshots ----
export function cloneElement(e) {
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
      mask: maskClone(v), params: { ...v.params }, color: { ...v.color }, fabric: { ...v.fabric },
      regionSel: [...v.regionSel], sample: v.sample,
    };
  }
  return { views, elements: state.elements.map(cloneElement), activeView: state.activeView, name: state.name };
}
function apply(s) {
  for (const n of VIEWS) {
    const v = state.views[n], d = s.views[n];
    v.job++; // cancel pending recomputes
    Object.assign(v, { original: d.original, base: d.base, baseSeg: d.baseSeg, current: d.current, seg: d.seg,
      params: { ...d.params }, color: { ...d.color }, fabric: { ...d.fabric }, regionSel: [...d.regionSel], sample: d.sample });
    const x = v.mask.getContext('2d'); x.clearRect(0, 0, v.mask.width, v.mask.height); x.drawImage(d.mask, 0, 0);
    v.maskRev++; v._maskCache = { rev: v.maskRev, canvas: d.mask };
  }
  state.elements = s.elements.map(cloneElement);
  state.activeView = s.activeView;
  state.name = s.name;
  state.selectedId = null;
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
  snapshot();
  apply(ver.snapshot);
  notify('restore');
  return true;
}
