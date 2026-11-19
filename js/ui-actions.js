// Pipeline + actions shared by all UI panels (owner: shell).
import { state, VIEWS, activeView, snapshot, notify, pushVersion, markFlow, touchMask, hasMask, newColor, undo as sUndo, redo as sRedo } from './state.js';
import { SIZE, makeCanvas, cloneCanvas, loadImageToCanvas, debounce, hasTransparentBorder, cropToContent, toast, friendly } from './util.js';
import { segmentGarment, removeBackground, REGION_NAMES } from './segment.js';
import { applyShape, DEFAULT_PARAMS, FIT_PRESETS, SLEEVE_PRESETS } from './warp.js';
import { applyColor, applyFabric } from './fabric.js';
import { applyParts, partsActive } from './manual.js';
import { localVariations } from './variations.js';
import { parsePrompt } from './prompt.js';
import { sampleGarment } from './samples.js';
import { clubEliteViews } from './samples-club.js';
import { parseGarmentText, makeGarmentViews, GEN_VIEWS } from './generate.js';
import { aiGenerate, AiError, useAi } from './ai.js';
import { startTask } from './ai-ui.js';
import * as SEL from './selection.js';

// ---------- busy overlay ----------
export function busy(msg = 'Working…') {
  state.ui.busy++; state.ui.busyMsg = msg; notify('busy');
  return () => { state.ui.busy = Math.max(0, state.ui.busy - 1); notify('busy'); };
}
const tick = () => new Promise(r => setTimeout(r, 16));

// ---------- pipeline: base -> shape -> fabric -> colour ----------
const paramsDefault = p => Object.keys(DEFAULT_PARAMS).every(k => !p[k]);
const colorActive = c => c.hue || c.sat || c.light || (c.tint && c.tintAmount > 0);

export function limitMask(v) {
  if (!state.ui.limitToSelection || !hasMask(v)) return null;
  return v.mask;
}
export async function recompute(name = state.activeView) {
  const V = state.views[name];
  if (!V.base) return;
  const tok = ++V.job;
  state.ui.processing = true; notify('processing');
  try {
    let canvas = V.base, seg = V.baseSeg;
    const lim = limitMask(V);
    if (!paramsDefault(V.params)) {
      const r = await applyShape(V.base, V.baseSeg, V.params, lim ? { region: V.mask } : undefined);
      if (tok !== V.job) return;
      canvas = r.canvas; seg = r.seg || V.baseSeg;
    }
    if (V.fabric.name && V.fabric.name !== 'none') {
      canvas = await applyFabric(canvas === V.base ? cloneCanvas(canvas) : canvas, lim, V.fabric.name, V.fabric.amount);
      if (tok !== V.job) return;
    }
    if (V.fabric.tint && V.fabric.tintAmount > 0) {   // fabric tint (ui-look.js), separate from the whole-garment colour
      canvas = applyColor(canvas === V.base ? cloneCanvas(canvas) : canvas, lim, { tint: V.fabric.tint, tintAmount: V.fabric.tintAmount });
      if (tok !== V.job) return;
    }
    if (colorActive(V.color)) {
      canvas = await applyColor(canvas === V.base ? cloneCanvas(canvas) : canvas, lim, V.color);
      if (tok !== V.job) return;
    }
    if (partsActive(V.parts)) {   // per-part colours (manual), after the whole-garment colour
      canvas = applyParts(canvas === V.base ? cloneCanvas(canvas) : canvas, seg, V.parts);
      if (tok !== V.job) return;
    }
    V.current = canvas; V.seg = seg;
  } catch (err) {
    console.error(err); toast('That change could not be applied. Undo it, or try a smaller value.', 'error', 5000);
  } finally {
    if (tok === V.job) { state.ui.processing = false; notify('render'); }
  }
}
export const scheduleRecompute = debounce(() => recompute(), 90);

// Shape is a property of the garment, not of a camera view. Keep the front, back and
// side on the same shape settings, while leaving each view's artwork, colour and fabric alone.
const linkedShapeViews = () => ['front', 'back', 'side'].filter(name => state.views[name] && state.views[name].base);
async function recomputeLinkedViews() {
  for (const name of linkedShapeViews()) await recompute(name);
}
const scheduleShapeRecompute = debounce(() => recomputeLinkedViews(), 90);

let sliderSnapped = false;
export function beginEdit() { if (!sliderSnapped) { snapshot(); sliderSnapped = true; } }
export function endEdit() { sliderSnapped = false; }

export function setParam(key, val) {
  beginEdit();
  // Use the active view as the source of truth for the COMPLETE shape, not just
  // the slider being moved. This also reconciles any older view-specific differences.
  const params = { ...activeView().params, [key]: val };
  for (const name of linkedShapeViews()) state.views[name].params = { ...params };
  markFlow('refined'); notify('params'); scheduleShapeRecompute();
}
export function resetParams() {
  snapshot();
  for (const name of linkedShapeViews()) {
    const V = state.views[name]; V.params = { ...DEFAULT_PARAMS }; V.presets = { fit: null, sleeve: null };
  }
  markFlow('refined'); notify('params'); recomputeLinkedViews();
}
export function applyFit(name) {
  snapshot();
  for (const view of linkedShapeViews()) {
    const V = state.views[view];
    V.params = { ...DEFAULT_PARAMS, ...FIT_PRESETS[name] };
    V.presets = { fit: name, sleeve: null };
  }
  markFlow('refined'); notify('params'); recomputeLinkedViews();
}
export function applySleeve(name) {
  snapshot();
  const keys = ['sleeveLength', 'sleeveWidth', 'sleeveFlare', 'sleeveShape'];
  const params = { ...activeView().params };
  for (const k of keys) params[k] = 0;
  Object.assign(params, SLEEVE_PRESETS[name]);
  for (const view of linkedShapeViews()) {
    const V = state.views[view];
    V.params = { ...params };
    V.presets = { ...(V.presets || {}), sleeve: name };
  }
  markFlow('refined'); notify('params'); recomputeLinkedViews();
}
export function clearPreset(kind) {
  snapshot();
  const table = kind === 'fit' ? FIT_PRESETS : SLEEVE_PRESETS;
  const source = activeView(), preset = table[source.presets?.[kind]] || {};
  const params = { ...source.params };
  for (const key of Object.keys(preset)) params[key] = 0;
  for (const name of linkedShapeViews()) {
    const V = state.views[name];
    V.params = { ...params };
    V.presets = { ...(V.presets || {}), [kind]: null };
  }
  markFlow('refined'); notify('params'); recomputeLinkedViews();
}
export function setColor(patch) { beginEdit(); Object.assign(activeView().color, patch); markFlow('refined'); notify('color'); scheduleRecompute(); }
export function setFabric(name, amount) {
  beginEdit(); const V = activeView(); V.fabric.name = name; if (amount != null) V.fabric.amount = amount;
  markFlow('refined'); notify('color'); scheduleRecompute();
}
export function setFabricTint(patch) {
  beginEdit(); Object.assign(activeView().fabric, patch); markFlow('refined'); notify('color'); scheduleRecompute();
}

// ---------- loading ----------
async function installBase(name, canvas, { sample = null, keepSeg = null, label } = {}) {
  const V = state.views[name];
  const seg = keepSeg || await segmentGarment(canvas);
  V.job++;
  V.original = canvas; V.base = canvas; V.baseSeg = seg; V.current = canvas; V.seg = seg;
  V.params = { ...DEFAULT_PARAMS }; V.color = newColor(); V.fabric = { name: null, amount: 0.6 };
  V.regionSel = []; V.sample = sample; V.parts = {}; V.presets = { fit: null, sleeve: null };
  const x = V.mask.getContext('2d'); x.clearRect(0, 0, SIZE, SIZE); touchMask(V);
  V.saved = [];   // saved selections belong to the image they were made on
}
export async function loadFile(file, viewName = state.activeView) {
  const done = busy('Reading image…');
  try {
    await tick();
    snapshot();
    let c = await loadImageToCanvas(file);
    if (!hasTransparentBorder(c)) {   // a photo with a background: reload edge-to-edge so the border is background, then cut it out
      try { c = cropToContent(await removeBackground(await loadImageToCanvas(file, 1))); } catch (e) { console.warn('bg removal failed', e); }
    }
    await installBase(viewName, c);
    if (state.name === 'Untitled design') state.name = (file.name || 'My design').replace(/\.[^.]+$/, '');
    state.activeView = viewName; state.variations = null;
    pushVersion('Uploaded ' + viewName);
    notify('loaded');
    toast('Image loaded. Now choose an area to change, or describe your idea.', 'ok');
  } catch (e) { console.error(e); toast(friendly(e, 'That image could not be loaded. Try a PNG or JPG, or pick a sample.'), 'error', 5000); } finally { done(); }
}
export function drawSample(kind, view, opts) { return sampleGarment(kind, view, opts || {}); }
export async function loadSample(kind = 'tee', opts = null, viewName = null) {
  const done = busy('Making a sample garment…');
  try {
    await tick();
    snapshot();
    const spec = opts ? { kind, color: opts.color || '#6f8fb5', stripe: opts.stripe ?? false } : { kind, showpiece: true };
    const names = viewName ? [viewName] : ['front', 'back'];
    for (const n of names) {
      const c = drawSample(kind, n, spec.showpiece ? undefined : { color: spec.color, stripe: spec.stripe });
      await installBase(n, c, { sample: spec });
    }
    if (!viewName) { state.activeView = 'front'; state.name = 'Sample ' + ({ tee: 't-shirt', longSleeve: 'long-sleeve tee', polo: 'polo', hoodie: 'hoodie' }[kind] || kind); }
    state.variations = null;
    pushVersion('Sample ' + kind);
    notify('loaded');
  } catch (e) { console.error(e); toast('The sample could not be drawn. Reload the page and try again.', 'error', 5000); } finally { done(); }
}
/** The 'Club Élite' test shirt: a photo-like bitmap with the artwork baked in, both views loaded the same way an upload would be. */
export async function loadClubSample() {
  const done = busy('Making the Club Élite test shirt…');
  try {
    await tick();
    snapshot();
    const v = clubEliteViews();
    for (const n of ['front', 'back']) await installBase(n, v[n], { sample: null });
    state.activeView = 'front'; state.name = 'Club Élite test shirt'; state.variations = null;
    pushVersion('Club Élite test shirt');
    notify('loaded');
  } catch (e) { console.error(e); toast('The test shirt could not be drawn. Reload the page and try again.', 'error', 5000); } finally { done(); }
}
/** Switching to an empty tab of a sample design builds the matching view automatically */
export async function ensureView(name) {
  const V = state.views[name];
  if (V.base) return;
  const src = VIEWS.map(n => state.views[n].sample).find(Boolean);
  if (src) await loadSample(src.kind, src.showpiece ? null : src, name);
}
export async function removeBg() {
  const V = activeView(); if (!V.base) return;
  const done = busy('Removing background…');
  try { await tick(); snapshot(); const c = cropToContent(await removeBackground(V.original)); await installBase(state.activeView, c, { sample: V.sample }); notify('loaded'); pushVersion('Background removed'); }
  catch (e) { console.error(e); toast('The background could not be removed. Try a photo on a plain, light background.', 'error', 5000); } finally { done(); }
}

// Generate garment: the in-browser generator builds front, back, side and detail views as one design.
let generating = false;
const applyGarmentLook = (V, spec) => {
  V.params = { ...DEFAULT_PARAMS, ...(FIT_PRESETS[spec.fit] || {}), ...(SLEEVE_PRESETS[spec.sleeve] || {}) };
  V.presets = { fit: FIT_PRESETS[spec.fit] ? spec.fit : null, sleeve: SLEEVE_PRESETS[spec.sleeve] ? spec.sleeve : null };
  V.fabric = spec.fabric ? { name: spec.fabric.name, amount: spec.fabric.amount } : { name: null, amount: 0.6 };
};
export async function generateFromPrompt(text, { defaultKind = 'tee', defaultColor = null, addStripes = false } = {}) {
  const prompt = String(text || '').trim();
  if (!prompt) {
    const msg = 'Describe a garment first, for example "navy hoodie with white stripes". Or use "Use sample" to draw the chosen shape.';
    toast(msg, 'info', 5000);
    return { ok: false, message: msg };
  }
  if (generating) return { ok: false, message: 'Already generating, please wait.' };
  generating = true;
  try {
    let note = '';
    const spec = parseGarmentText(prompt, { defaultKind, defaultColor, addStripes });
    if (useAi()) {   // AI makes the front; matching procedural views use the same garment specification.
      const r = await generateWithAi(prompt, spec, { defaultKind, defaultColor, addStripes });
      if (r.result) return r.result;
      if (r.cancelled) return { ok: false, message: 'Cancelled. Nothing was changed.' };
      note = 'The built-in engine was used instead.';
    }
    const done = busy('Generating garment…');
    try {
      await tick();
      const views = makeGarmentViews(spec);
      snapshot();
      for (const v of GEN_VIEWS) {
        await installBase(v, views[v], { sample: spec.sample });
        applyGarmentLook(state.views[v], spec);
      }
      for (const v of GEN_VIEWS) await recompute(v);
      state.activeView = 'front';
      state.variations = null;
      state.name = spec.title;
      pushVersion('Generated');
      markFlow('generated'); notify('loaded');
      const message = `Generated: ${spec.summary}. Front, back, side and detail are ready to edit.`;
      toast(note ? 'AI was not available, so the built-in engine made this garment. Front, back, side and detail are ready to edit.' : 'Generated. Front, back, side and detail are ready to edit.', 'ok', 4500);
      return { ok: true, message: note ? `${message} ${note}` : message, spec };
    } catch (e) {
      console.error(e);
      const msg = 'That garment could not be generated. Try a simpler description, such as "red hoodie", or pick a sample.';
      toast(msg, 'error', 5000);
      return { ok: false, message: msg };
    } finally { done(); }
  } catch (e) {
    console.error(e);
    const msg = 'The generator hit a problem. Please try again with a simpler garment description.';
    toast(msg, 'error', 5000);
    return { ok: false, message: msg };
  } finally { generating = false; }
}

// AI "Generate garment": the server makes the front; Threadform builds matching procedural back, side and detail views.
// Returns {result} on success, {cancelled:true} when the person cancelled, or {} after showing a friendly message (caller falls back).
async function generateWithAi(prompt, spec, options = {}) {
  const task = startTask({ title: 'Generating garment with AI', hint: 'This can take up to a minute. You can keep working or cancel.' });
  try {
    const aiPrompt = `${prompt}\n\nGarment details: ${spec.summary}. Body colour: ${spec.color}. ${spec.stripe ? `Include ${spec.stripeName || 'contrasting'} stripes.` : 'Do not add stripes unless specifically described.'} Keep the design clean and suitable for a clothing mockup.`;
    const { canvas } = await aiGenerate({ prompt: aiPrompt, refs: state.references, view: 'front', signal: task.signal });
    if (task.closed) return { cancelled: true };
    task.setStatus('Preparing the garment for editing…');
    const done = busy('Preparing the garment…');
    try {
      await tick();
      let c = canvas;
      if (!hasTransparentBorder(c)) {
        try {
          const cut = cropToContent(await removeBackground(c));
          // If the cut-out is (almost) empty the garment blended into its background: keep the image as it came back
          // instead of installing a blank canvas and calling that a success.
          const d = cut.getContext('2d').getImageData(0, 0, cut.width, cut.height).data; let solid = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 40) solid++;
          if (solid / (cut.width * cut.height) >= 0.02) c = cut;
        } catch (e) { console.warn('bg removal failed', e); }
      }
      if (task.closed) return { cancelled: true };
      const matchingViews = makeGarmentViews(spec);
      snapshot();
      await installBase('front', c, { sample: spec.sample, label: 'AI front' });
      applyGarmentLook(state.views.front, spec);
      for (const view of GEN_VIEWS) {
        if (view === 'front') continue;
        await installBase(view, matchingViews[view], { sample: spec.sample, label: 'Matching ' + view });
        applyGarmentLook(state.views[view], spec);
      }
      for (const view of GEN_VIEWS) await recompute(view);
      state.activeView = 'front'; state.variations = null;
      state.name = spec.title || (prompt.length > 40 ? prompt.slice(0, 38).trimEnd() + '…' : prompt);
      pushVersion('Generated with AI');
      markFlow('generated'); notify('loaded');
    } finally { done(); }
    const message = 'AI front generated. Matching back, side and detail views were built from the same garment specification and are ready to edit.';
    task.succeed(message);
    return { result: { ok: true, message, ai: true, spec } };
  } catch (e) {
    if (e instanceof AiError && e.kind === 'aborted') return { cancelled: true };
    if (!(e instanceof AiError)) console.error(e);
    const err = e instanceof AiError ? e : new AiError('upstream');
    task.fail(err, { note: 'Using the built-in engine instead.', actions: [{ label: 'Try AI again', retry: true, primary: true, fn: () => generateFromPrompt(prompt, options) }] });
    return {};
  }
}

// ---------- references ----------
export async function addReferences(files) {
  for (const f of files) {
    try { state.references.push(await loadImageToCanvas(f)); } catch (e) { toast(friendly(e, 'That reference image could not be read. Try a PNG or JPG.'), 'error', 5000); }
  }
  notify('references');
}
export function removeReference(i) { state.references.splice(i, 1); notify('references'); }

// ---------- selection (mask) ----------
// The selection itself lives in selection.js (undoable, selection history, saved selections). These names are kept for the panels.
export const toggleRegion = name => SEL.toggleRegion(name);
export const selectWhole = () => SEL.selectEntireGarment();
export const clearMask = () => SEL.clearSelection();
export const invertMask = () => SEL.invertSelection();
export const growMask = (px = 28) => SEL.expandSelection(px);
/** mask handed to engines: the selection as drawn (it may include empty space so shapes can grow), or null when nothing is selected */
export function effectiveMask(V = activeView()) {
  if (!hasMask(V)) return null;
  return cloneCanvas(V.mask);
}

// ---------- variations ----------
function enforceMask(original, result, mask) {
  const out = cloneCanvas(original), ox = out.getContext('2d');
  ox.globalCompositeOperation = 'destination-out'; ox.drawImage(mask, 0, 0);
  const inside = makeCanvas(), ix = inside.getContext('2d');
  ix.drawImage(result, 0, 0); ix.globalCompositeOperation = 'destination-in'; ix.drawImage(mask, 0, 0);
  ox.globalCompositeOperation = 'source-over'; ox.drawImage(inside, 0, 0);
  return out;
}
export async function generateVariations(promptText) {
  const V = activeView(); if (!V.current) { toast('Load or generate a garment first.', 'info'); return; }
  if (!promptText.trim()) { toast('Describe what you would like to change, e.g. "make the sleeves flared".', 'info'); return; }
  const done = busy('Creating three options…');
  try {
    await tick();
    markFlow('described');
    const ops = parsePrompt(promptText);
    state.lastOps = ops;
    const mask = effectiveMask(V);
    const src = V.current, seg = V.seg;
    const local = await localVariations(src, seg, mask, ops);
    const out = local.slice(0, 3).map(l => ({ label: l.label, canvas: mask ? enforceMask(src, l.canvas, mask) : l.canvas, seg: mask ? null : (l.seg || null) }));
    state.variations = out.map(o => ({ ...o, ops }));
    state.applied = null;
    markFlow('generated'); notify('variations');
    if (!mask) toast('No area selected: changes may touch any matching part of the garment.', 'info', 3800);
  } catch (e) { console.error(e); toast('The options could not be created. Try different words, for example "make the sleeves longer".', 'error', 5000); } finally { done(); }
}
async function bake(canvas, seg, label) {
  const V = activeView();
  const s = seg || await segmentGarment(canvas);
  V.job++;
  V.base = canvas; V.baseSeg = s; V.current = canvas; V.seg = s;
  V.params = { ...DEFAULT_PARAMS }; V.color = newColor(); V.fabric = { name: null, amount: 0.6 }; V.parts = {}; V.presets = { fit: null, sleeve: null };
  pushVersion(label);
}
export async function acceptVariation(i) {
  const o = state.variations?.[i]; if (!o) return;
  const done = busy('Applying…');
  try { snapshot(); await bake(o.canvas, o.seg, `${o.label}: ${o.ops?.summary || 'option'}`); state.applied = { index: i }; markFlow('compared'); notify('applied'); toast(`${o.label} option applied. Sliders now refine from this result.`, 'ok'); }
  finally { done(); }
}
export async function combineVariation(i) {
  const o = state.variations?.[i]; const V = activeView(); if (!o || !V.current) return;
  const done = busy('Combining…');
  try {
    snapshot();
    const mask = effectiveMask(V);
    const lv = await localVariations(V.current, V.seg, mask, o.ops);
    const r = lv[i];
    await bake(mask ? enforceMask(V.current, r.canvas, mask) : r.canvas, mask ? null : r.seg, `Combined + ${o.label}`);
    markFlow('compared'); notify('applied'); toast(`Added the ${o.label} option on top.`, 'ok');
  } catch (e) { console.error(e); toast('Those options could not be combined. Use one option on its own, then describe the next change.', 'error', 5000); } finally { done(); }
}

export const undo = () => { sUndo(); };
export const redo = () => { sRedo(); };
export { REGION_NAMES, FIT_PRESETS, SLEEVE_PRESETS, DEFAULT_PARAMS };
