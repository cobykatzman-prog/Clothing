// Threadform - colourways controller (roadmap v2 phase 7). One garment structure, many colourways.
// Colours, fabrics, layer colours and material notes live in state.colourways; the shape sliders, the artwork layout and the
// pictures are shared, so changing the fit changes every colourway. Switching a colourway writes its look onto the
// views and recomputes them through the normal pipeline (ui-actions.recompute), as one undo step.
import { state, snapshot, notify, VIEWS, activeView, syncActiveColourway, markFlow } from './state.js';
import { recompute } from './ui-actions.js';
import { updateElement } from './elements.js';
import { sampleRegion, closeGate, editGate } from './manual.js';
import { makeColourway, branchColourway, uniqueName, appearanceOfView, captureElementColours, SECTION_IDS, MAX_COLOURWAYS, fabricForMaterial, materialSnapshot } from './colourway-model.js';
import { normalizeMaterials } from './materials.js';
import { cachedKit, listKit } from './kit.js';

export const colourwayList = () => state.colourways.list;
export const activeColourway = () => state.colourways.list.find(c => c.id === state.colourways.activeId) || null;
const byId = id => state.colourways.list.find(c => c.id === id) || null;
const garmentViews = () => VIEWS.filter(n => state.views[n].base);
const hasGarment = () => garmentViews().length > 0;
const clone = v => JSON.parse(JSON.stringify(v));

function captureLook() {
  const views = {};
  for (const n of garmentViews()) views[n] = appearanceOfView(state.views[n]);
  return { views, elements: captureElementColours(state.elements) };
}
async function recomputeAll() { for (const n of garmentViews()) await recompute(n); }

/** Applies the stored look of a colourway to the live views and layers (no undo step of its own). */
function applyLook(cw) {
  for (const n of garmentViews()) {
    const V = state.views[n], a = cw.views[n] || cw.views.front || cw.views[Object.keys(cw.views)[0]];
    if (!a) continue;
    V.color = { ...a.color }; V.fabric = { ...a.fabric }; V.parts = clone(a.parts);
  }
  for (const el of state.elements) if (cw.elements?.[el.id]) updateElement(el, cw.elements[el.id]);
}

/** Makes the very first colourway out of the look the garment has now (no-op when colourways already exist). */
export function ensureBaseline() {
  if (state.colourways.list.length || !hasGarment()) return activeColourway();
  const cw = makeColourway({ name: 'Colourway 1', ...captureLook() });
  state.colourways = { list: [cw], activeId: cw.id };
  notify('colourways');
  return cw;
}

/** Adds a colourway: a branch of the one on screen (same structure, same look to start from) and puts it on the garment. */
export function addColourway(name) {
  if (!hasGarment() || state.colourways.list.length >= MAX_COLOURWAYS) return null;
  ensureBaseline(); syncActiveColourway();
  const src = activeColourway();
  const cw = branchColourway(src, uniqueName(state.colourways.list, name || 'Colourway ' + (state.colourways.list.length + 1)));
  state.colourways.list.push(cw); state.colourways.activeId = cw.id;
  notify('colourways');
  return cw;
}
/** Branch of ANY colourway (it is also put on the garment). Records the parent so the lineage can be shown. */
export async function branchFrom(id) {
  const src = byId(id); if (!src || state.colourways.list.length >= MAX_COLOURWAYS) return null;
  syncActiveColourway();
  const cw = branchColourway(src, uniqueName(state.colourways.list, src.name + ' (branch)'));
  const at = state.colourways.list.findIndex(c => c.id === id);
  state.colourways.list.splice(at + 1, 0, cw);
  await switchTo(cw.id);
  return cw;
}
export async function switchTo(id) {
  const cw = byId(id); if (!cw) return false;
  if (state.colourways.activeId === id) return true;
  closeGate(); syncActiveColourway(); snapshot();
  state.colourways.activeId = id;
  applyLook(cw);
  markFlow('refined'); notify('colourways'); notify('color');
  await recomputeAll();
  return true;
}
export function renameColourway(id, name) {
  const cw = byId(id), n = String(name || '').trim().slice(0, 60);
  if (!cw || !n || n === cw.name) return false;
  cw.name = n; notify('colourways'); return true;
}
export function setColourwayText(id, patch) {
  const cw = byId(id); if (!cw) return;
  for (const k of ['notes', 'supplierNotes']) if (patch[k] != null) cw[k] = String(patch[k]).slice(0, 1500);
  notify('colourways-text');
}
export async function removeColourway(id) {
  const list = state.colourways.list, at = list.findIndex(c => c.id === id);
  if (at < 0) return false;
  const wasActive = state.colourways.activeId === id;
  list.splice(at, 1);
  for (const c of list) if (c.parent === id) c.parent = null;
  if (wasActive) {
    const next = list[Math.min(at, list.length - 1)] || null;
    state.colourways.activeId = null;
    if (next) { snapshot(); state.colourways.activeId = next.id; applyLook(next); notify('colourways'); notify('color'); await recomputeAll(); return true; }
  }
  notify('colourways'); return true;
}

/* ------------------------------------------------------------------ sections (parts of the garment) */
export const sectionAvailable = name => !!(activeView().base && activeView().seg?.regions?.[name]);
export const availableSections = () => SECTION_IDS.filter(sectionAvailable);
const sectionViews = name => garmentViews().filter(n => state.views[n].seg?.regions?.[name]);
const recomputeViewsFor = name => Promise.all(sectionViews(name).map(n => recompute(n)));

function patchPart(name, fn) {
  const views = sectionViews(name); if (!views.length) return false;
  ensureBaseline(); editGate();
  for (const n of views) {
    const V = state.views[n], next = fn({ hue: 0, sat: 0, light: 0, ...(V.parts?.[name] || {}) });
    const parts = { ...(V.parts || {}) };
    if (next) parts[name] = next; else delete parts[name];
    V.parts = parts;
  }
  markFlow('refined'); notify('color');
  syncActiveColourway();
  return true;
}
/** Colour of one section in every view that has it (full-strength tint; folds and shading survive). */
export function setSectionColour(name, hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return false;
  const ok = patchPart(name, p => ({ ...p, color: hex.toLowerCase() }));
  if (ok) recomputeViewsFor(name);
  return ok;
}
/** Fabric appearance of one section (null name = none). amount 0..1 is the weave strength. */
export function setSectionFabric(name, fabricName, amount = 0.6) {
  const ok = patchPart(name, p => {
    const q = { ...p };
    if (!fabricName) { delete q.fabric; return q.color ? q : null; }
    q.fabric = { name: fabricName, amount: Math.min(1, Math.max(0, Number(amount) || 0)) };
    return q;
  });
  if (ok) recomputeViewsFor(name);
  return ok;
}
/** Back to the garment's own colour and fabric for this section, and forget its material notes. */
export function clearSection(name) {
  closeGate();
  const views = sectionViews(name);
  if (views.some(n => state.views[n].parts?.[name])) {
    snapshot();
    for (const n of views) { const V = state.views[n], parts = { ...(V.parts || {}) }; delete parts[name]; V.parts = parts; }
    markFlow('refined'); notify('color');
  }
  const cw = activeColourway();
  if (cw?.sections?.[name]) { delete cw.sections[name]; notify('colourways'); }
  syncActiveColourway(); recomputeViewsFor(name);
}

/** Notes and the material assigned to one section of the ACTIVE colourway (stored with the colourway, small JSON only). */
export function setSectionInfo(name, patch) {
  ensureBaseline();
  const cw = activeColourway(); if (!cw) return false;
  const cur = { ...(cw.sections[name] || {}) };
  if ('material' in patch) { const m = materialSnapshot(patch.material); if (m) cur.material = m; else delete cur.material; }
  for (const k of ['note', 'supplier']) if (k in patch) { const v = String(patch[k] || '').slice(0, k === 'note' ? 400 : 120); if (v) cur[k] = v; else delete cur[k]; }
  if (Object.keys(cur).length) cw.sections[name] = cur; else delete cw.sections[name];
  notify('colourways-text'); return true;
}
/** Assign a library material to a section: remembers its details and shows its weave (and its colour when `useColour`). */
export function assignMaterial(name, material, { useColour = true, amount = 0.6 } = {}) {
  if (!material) { setSectionInfo(name, { material: null }); setSectionFabric(name, null); notify('colourways'); return true; }
  const m = materialSnapshot(material); if (!m) return false;
  setSectionInfo(name, { material: m });
  setSectionFabric(name, fabricForMaterial(m.type), amount);
  if (useColour) setSectionColour(name, m.color);
  notify('colourways');
  return true;
}
export function sectionState(name) {
  const V = activeView(), p = V.parts?.[name], cw = activeColourway(), reg = V.seg?.regions?.[name];
  return { colour: p?.color || null, current: reg ? sampleRegion(V.current, reg) : null, fabric: p?.fabric || null, info: cw?.sections?.[name] || {} };
}

/* ------------------------------------------------------------------ materials library (browser library + shared brand kit) */
const MATERIALS_KEY = 'threadform.materials.v1';
/** Materials the person can assign: the library on the home page plus brand-kit materials (shared workspace). */
export function libraryMaterials() {
  let out = [];
  try { out = normalizeMaterials(JSON.parse(localStorage.getItem(MATERIALS_KEY) || '[]')); } catch { out = []; }
  try {
    for (const it of cachedKit('material')) {
      const d = it.data || {};
      out.push({ id: 'kit-' + it.id, name: it.name, type: d.type || 'Other', color: d.color, composition: d.composition, supplier: d.supplier, sku: d.sku, weightGsm: d.weightGsm, notes: d.notes });
    }
  } catch { /* kit unavailable */ }
  return out.filter(m => m && m.name);
}
export const refreshKitMaterials = () => listKit('material').catch(() => []);
