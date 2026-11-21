// Threadform - renders a colourway on the shared garment (DOM canvas). The shape never comes from the colourway: it is
// always the design's own sliders, so every colourway is the same garment in different colours and fabrics.
import { state, cloneElement } from './state.js';
import { applyShape, DEFAULT_PARAMS } from './warp.js';
import { applyColor, applyFabric } from './fabric.js';
import { applyParts, partsActive } from './manual.js';
import { cloneCanvas } from './util.js';
import { updateElement, elementsReady } from './elements.js';
import { compose } from './export.js';
import { appearanceOfView } from './colourway-model.js';

export const sectionFabricsActive = parts => !!parts && Object.values(parts).some(p => p && p.fabric && p.fabric.name && p.fabric.amount > 0);

/** Per-section fabric (procedural weave through the section mask). Pure: returns a canvas. */
export function applySectionFabrics(canvas, seg, parts) {
  let out = canvas;
  for (const [name, p] of Object.entries(parts || {})) {
    const mask = seg?.regions?.[name];
    if (!mask || !p?.fabric?.name || !(p.fabric.amount > 0)) continue;
    out = applyFabric(out, mask, p.fabric.name, p.fabric.amount);
  }
  return out;
}

const paramsDefault = p => Object.keys(DEFAULT_PARAMS).every(k => !p[k]);
const colorActive = c => c && (c.hue || c.sat || c.light || (c.tint && c.tintAmount > 0));
const shapeCache = new WeakMap();   // base canvas -> { key, promise }
function shaped(V) {
  if (paramsDefault(V.params)) return Promise.resolve({ canvas: V.base, seg: V.baseSeg });
  const key = JSON.stringify(V.params), hit = shapeCache.get(V.base);
  if (hit && hit.key === key) return hit.promise;
  const promise = applyShape(V.base, V.baseSeg, V.params).then(r => ({ canvas: r.canvas, seg: r.seg || V.baseSeg }));
  shapeCache.set(V.base, { key, promise });
  return promise;
}

/** Garment picture of one view in the colourway `cw` (a stored record). Resolves null when the view has no garment. */
export async function renderColourwayView(viewName, cw, { live = false } = {}) {
  const V = state.views[viewName];
  if (!V?.base) return null;
  if (live && V.current) return cloneCanvas(V.current);   // the active colourway IS what the studio shows
  const app = cw?.views?.[viewName] || cw?.views?.front || appearanceOfView(V);
  const s = await shaped(V);
  let canvas = s.canvas === V.base ? cloneCanvas(s.canvas) : s.canvas;
  if (app.fabric.name) canvas = applyFabric(canvas, null, app.fabric.name, app.fabric.amount);
  if (app.fabric.tint && app.fabric.tintAmount > 0) canvas = applyColor(canvas, null, { tint: app.fabric.tint, tintAmount: app.fabric.tintAmount });
  if (colorActive(app.color)) canvas = applyColor(canvas, null, app.color);
  if (partsActive(app.parts)) canvas = applyParts(canvas, s.seg, app.parts);
  if (sectionFabricsActive(app.parts)) canvas = applySectionFabrics(canvas, s.seg, app.parts);
  return canvas;
}

/** Elements of the design with the colourway's colour overrides applied (copies; the design's own layers are untouched). */
export function elementsForColourway(cw) {
  return state.elements.map(e => {
    const c = cloneElement(e), o = cw?.elements?.[e.id];
    if (o) updateElement(c, o);
    return c;
  });
}

/** Finished picture (garment + artwork) of one colourway and view, as a canvas of 1024*scale px. */
export async function renderColourwayComposite(viewName, cw, { live = false, scale = 1, background = '#f3f2ef' } = {}) {
  const base = await renderColourwayView(viewName, cw, { live });
  if (!base) return null;
  const els = elementsForColourway(live ? null : cw);
  await elementsReady(els);
  return compose(base, els, viewName, scale, background);
}
