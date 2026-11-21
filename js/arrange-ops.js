// Arranging design elements in the studio: multi-selection, groups, alignment, snapping, numeric transforms.
// The geometry lives in arrange.js (pure). Every structural change here is one undo step.
import { state, activeView, snapshot, notify } from './state.js';
import { SIZE, toast } from './util.js';
import { scaleElement } from './elements.js';
import { bounds, unionBounds, rectBox, alignDeltas, distributeDeltas, snapLines, snapBox } from './arrange.js';
import { closeGate, editGate } from './manual.js';

const inView = e => !e.view || e.view === 'all' || e.view === state.activeView;
const byId = id => state.elements.find(e => e.id === id) || null;
const newGroupId = () => 'g' + Math.random().toString(36).slice(2, 8);
function change(fn) { closeGate(); snapshot(); fn(); notify('elements'); }

/* ---- the current selection: the primary item (state.selectedId), extra items picked with Shift, and group mates ---- */
/** Items currently selected on this view (primary first). Empty when nothing is selected. */
export function selectedSet() {
  const p = byId(state.selectedId);
  if (!p || !inView(p)) return [];
  const ids = new Set([p.id]);
  if (state.ui.multiFor === p.id) for (const id of state.ui.multi || []) { const e = byId(id); if (e && inView(e)) ids.add(id); }
  for (const id of [...ids]) { const g = byId(id)?.group; if (g) for (const e of state.elements) if (e.group === g && inView(e)) ids.add(e.id); }
  return [p, ...state.elements.filter(e => ids.has(e.id) && e !== p)];
}
export const isMulti = () => selectedSet().length > 1;
/** Shift / Ctrl click: add the item to the selection, or remove it again. */
export function toggleInSelection(id) {
  const e = byId(id); if (!e) return;
  if (!state.selectedId || !byId(state.selectedId)) { state.selectedId = id; state.ui.multi = []; state.ui.multiFor = id; notify('selection'); return; }
  if (id === state.selectedId) return;
  if (state.ui.multiFor !== state.selectedId) { state.ui.multi = []; state.ui.multiFor = state.selectedId; }
  const i = state.ui.multi.indexOf(id);
  if (i >= 0) state.ui.multi.splice(i, 1); else state.ui.multi.push(id);
  notify('selection');
}
/** Select exactly these items (the first becomes the primary). */
export function selectMany(ids) {
  ids = ids.filter(id => byId(id)); if (!ids.length) return;
  state.selectedId = ids[0]; state.ui.multiFor = ids[0]; state.ui.multi = ids.slice(1); state.ui.tool = 'move'; notify('selection');
}

/* ---- groups ---- */
export const groupMembers = g => (g ? state.elements.filter(e => e.group === g) : []);
export function canGroup() { const s = selectedSet(); return s.length > 1 && !(s.every(e => e.group && e.group === s[0].group)); }
export function canUngroup() { return selectedSet().some(e => e.group); }
export function groupSelection() {
  const s = selectedSet(); if (s.length < 2) { toast('Pick two or more items first (Shift + click).', 'info'); return false; }
  const g = newGroupId();
  change(() => { for (const e of s) e.group = g; });
  toast(`Grouped ${s.length} items. They now move, hide, lock and copy together.`, 'ok');
  return true;
}
export function ungroupSelection() {
  const s = selectedSet(); if (!s.some(e => e.group)) return false;
  const groups = new Set(s.map(e => e.group).filter(Boolean));
  change(() => { for (const e of state.elements) if (groups.has(e.group)) e.group = null; });
  return true;
}

/* ---- set-wide actions ---- */
export function nudgeSet(dx, dy) {
  const s = selectedSet().filter(e => !e.locked); if (!s.length) return false;
  editGate(); for (const e of s) { e.x += dx; e.y += dy; } notify('elements-live'); return true;
}
export function setLockedSet(on) { const s = selectedSet(); if (s.length) change(() => { for (const e of s) e.locked = !!on; }); }
export function setVisibleSet(on) { const s = selectedSet(); if (s.length) change(() => { for (const e of s) e.visible = !!on; }); }
export function deleteSet() {
  const s = selectedSet().filter(e => !e.locked); if (!s.length) return false;
  const ids = new Set(s.map(e => e.id));
  change(() => { state.elements = state.elements.filter(e => !ids.has(e.id)); state.selectedId = null; state.ui.multi = []; });
  toast(s.length > 1 ? `${s.length} items deleted.` : 'Item deleted.', 'ok', 4000, { label: 'Undo', fn: () => import('./ui-actions.js').then(A => A.undo()) });
  return true;
}
/** Duplicates the whole selection (groups stay groups), offset a little, and selects the copies. */
export function duplicateSet() {
  const s = selectedSet(); if (!s.length) return false;
  change(() => {
    const gmap = new Map(), copies = [];
    for (const e of s) {
      const c = e.clone(); c.base = e.base ? { ...e.base } : null; c.x += 24; c.y += 24; c.name = (e.name || e.type) + ' copy';
      if (e.group) { if (!gmap.has(e.group)) gmap.set(e.group, newGroupId()); c.group = gmap.get(e.group); }
      state.elements.splice(state.elements.indexOf(e) + 1, 0, c); copies.push(c);
    }
    state.selectedId = copies[0].id; state.ui.multiFor = copies[0].id; state.ui.multi = copies.slice(1).map(c => c.id);
  });
  return true;
}

/* ---- alignment ---- */
const SIZE_BOX = { x0: 0, y0: 0, x1: SIZE, y1: SIZE, cx: SIZE / 2, cy: SIZE / 2, w: SIZE, h: SIZE };
/** The garment's outline box on this view (the canvas when the view has no outline). */
export function garmentBox() { return rectBox(activeView().seg?.bbox) || SIZE_BOX; }
/** What alignment refers to: one item aligns to the garment, several align to each other. */
export function alignTarget() { const s = selectedSet(); return s.length > 1 ? unionBounds(s) : garmentBox(); }
export function alignSelection(mode) {
  const s = selectedSet().filter(e => !e.locked); if (!s.length) return false;
  const d = alignDeltas(s, mode, alignTarget()).filter(m => Math.abs(m.dx) > 1e-6 || Math.abs(m.dy) > 1e-6);
  if (!d.length) return false;
  change(() => { for (const { el, dx, dy } of d) { el.x += dx; el.y += dy; } });
  return true;
}
export function distributeSelection(axis) {
  const s = selectedSet().filter(e => !e.locked); if (s.length < 3) { toast('Pick three or more items to space them evenly.', 'info'); return false; }
  const d = distributeDeltas(s, axis); if (!d.length) return false;
  change(() => { for (const { el, dx, dy } of d) { el.x += dx; el.y += dy; } });
  return true;
}

/* ---- numeric transform of one item (used by the inspector) ---- */
const isTextual = el => ['text', 'embroidery', 'print'].includes(el.type) && el.props.text != null && !el.props.graphicId && !el.props.svg;
/** Sets width and/or height in canvas px. Keeps proportions when `keep` (always for text, whose size follows its font). */
export function setSize(el, { w, h }, keep = true) {
  if (w != null && w > 0) { const k = w / el.w; if (keep || isTextual(el)) scaleElement(el, k); else scaleElement(el, k, 1); }
  else if (h != null && h > 0) { const k = h / el.h; if (keep || isTextual(el)) scaleElement(el, k); else scaleElement(el, 1, k); }
  el._cache = null;
}

/* ---- snapping while dragging ---- */
/** Lines the moving set can snap to: garment edges and centre, canvas centre, every other item on the view. */
export function snapContext(moving) {
  const ids = new Set(moving.map(e => e.id));
  return snapLines({ garment: activeView().seg?.bbox ? garmentBox() : null, others: state.elements.filter(e => inView(e) && e.visible !== false && !ids.has(e.id)), size: SIZE });
}
export { bounds, unionBounds, snapBox };
