// Pipeline + actions shared by all UI panels (owner: shell).
import { state, VIEWS, activeView, snapshot, notify, pushVersion, markFlow, touchMask, hasMask, newColor, undo as sUndo, redo as sRedo } from './state.js';
import { SIZE, makeCanvas, cloneCanvas, loadImageToCanvas, debounce, intersectMask, hasTransparentBorder, cropToContent, toast } from './util.js';
import { segmentGarment, removeBackground, REGION_NAMES } from './segment.js';
import { applyShape, DEFAULT_PARAMS, FIT_PRESETS, SLEEVE_PRESETS } from './warp.js';
import { applyColor, applyFabric } from './fabric.js';
import { localVariations } from './variations.js';
import { parsePrompt } from './prompt.js';
import { requestVariations, generateGarment, aiStatus } from './ai.js';
import { sampleGarment } from './samples.js';

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
    if (colorActive(V.color)) {
      canvas = await applyColor(canvas === V.base ? cloneCanvas(canvas) : canvas, lim, V.color);
      if (tok !== V.job) return;
    }
    V.current = canvas; V.seg = seg;
  } catch (err) {
    console.error(err); toast('Could not apply that change: ' + err.message, 'error');
  } finally {
    if (tok === V.job) { state.ui.processing = false; notify('render'); }
  }
}
export const scheduleRecompute = debounce(() => recompute(), 90);

let sliderSnapped = false;
export function beginEdit() { if (!sliderSnapped) { snapshot(); sliderSnapped = true; } }
export function endEdit() { sliderSnapped = false; }

export function setParam(key, val) {
  beginEdit();
  activeView().params[key] = val; markFlow('refined'); notify('params'); scheduleRecompute();
}
export function resetParams() {
  snapshot(); const V = activeView(); V.params = { ...DEFAULT_PARAMS }; notify('params'); recompute();
}
export function applyFit(name) {
  snapshot(); const V = activeView();
  V.params = { ...DEFAULT_PARAMS, ...FIT_PRESETS[name] }; markFlow('refined'); notify('params'); recompute();
}
export function applySleeve(name) {
  snapshot(); const V = activeView();
  const keys = ['sleeveLength', 'sleeveWidth', 'sleeveFlare', 'sleeveShape'];
  for (const k of keys) V.params[k] = 0;
  Object.assign(V.params, SLEEVE_PRESETS[name]); markFlow('refined'); notify('params'); recompute();
}
export function setColor(patch) { beginEdit(); Object.assign(activeView().color, patch); markFlow('refined'); notify('color'); scheduleRecompute(); }
export function setFabric(name, amount) {
  beginEdit(); const V = activeView(); V.fabric.name = name; if (amount != null) V.fabric.amount = amount;
  markFlow('refined'); notify('color'); scheduleRecompute();
}

// ---------- loading ----------
async function installBase(name, canvas, { sample = null, keepSeg = null, label } = {}) {
  const V = state.views[name];
  const seg = keepSeg || await segmentGarment(canvas);
  V.job++;
  V.original = canvas; V.base = canvas; V.baseSeg = seg; V.current = canvas; V.seg = seg;
  V.params = { ...DEFAULT_PARAMS }; V.color = newColor(); V.fabric = { name: null, amount: 0.6 };
  V.regionSel = []; V.sample = sample;
  const x = V.mask.getContext('2d'); x.clearRect(0, 0, SIZE, SIZE); touchMask(V);
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
  } catch (e) { toast(e.message, 'error'); } finally { done(); }
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
  } catch (e) { console.error(e); toast('Sample failed: ' + e.message, 'error'); } finally { done(); }
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
  catch (e) { toast('Background removal failed: ' + e.message, 'error'); } finally { done(); }
}

const KIND_WORDS = [['hoodie', /hood/i], ['polo', /polo|collared/i], ['longSleeve', /long.?sleeve|sweater|jumper/i], ['tee', /t-?shirt|tee|shirt/i]];
const COLOR_WORDS = { black: '#26262b', white: '#f3f3f0', navy: '#243b6b', blue: '#4a78b5', red: '#b83a3a', green: '#4f8a5b', olive: '#6b7040', yellow: '#e2c24a', mustard: '#c99a2e', pink: '#e59aaa', purple: '#7a5aa6', grey: '#8d8f94', gray: '#8d8f94', beige: '#d4c4a8', cream: '#efe6d2', brown: '#7a5638', orange: '#dd7a35', teal: '#2f8a8a' };
export async function generateFromPrompt(text, kindOverride, colorOverride) {
  const done = busy('Generating garment…');
  try {
    await tick();
    let kind = kindOverride || (KIND_WORDS.find(([, re]) => re.test(text)) || [])[0] || 'tee';
    let color = colorOverride, stripe = false;
    const found = [...text.toLowerCase().matchAll(/\b([a-z]+)\b/g)].filter(m => COLOR_WORDS[m[1]]);
    const sm = text.toLowerCase().match(/\b([a-z]+)\s+stripe/);
    if (sm && /stripe/.test(sm[0])) stripe = COLOR_WORDS[sm[1]] || true;
    else if (/stripe/i.test(text)) stripe = true;
    const body = found.find(m => !sm || m[1] !== sm[1]);
    if (body) color = COLOR_WORDS[body[1]];
    let ai = null;
    if (text.trim()) {
      try { ai = await generateGarment({ prompt: text, refs: state.references, view: state.activeView }); } catch (e) { console.warn(e); }
    }
    snapshot();
    if (ai?.canvas) {
      let c = ai.canvas.width === SIZE && ai.canvas.height === SIZE ? ai.canvas : (() => { const n = makeCanvas(); n.getContext('2d').drawImage(ai.canvas, 0, 0, SIZE, SIZE); return n; })();
      if (!hasTransparentBorder(c)) c = cropToContent(await removeBackground(c));
      await installBase(state.activeView, c);
      state.engine.used = 'ai';
      toast('Garment generated by the AI engine.', 'ok');
    } else {
      const spec = { kind, color: color || '#6f8fb5', stripe };
      await installBase(state.activeView, drawSample(kind, state.activeView, spec), { sample: spec });
      state.engine.used = 'local';
      toast('AI is not configured, so I made a local sample garment from your description.', 'info', 4500);
    }
    state.variations = null;
    if (state.name === 'Untitled design') state.name = 'Generated ' + (({ tee: 't-shirt', longSleeve: 'long-sleeve', polo: 'polo', hoodie: 'hoodie' })[kind] || 'garment');
    pushVersion('Generated garment');
    markFlow('generated'); notify('loaded');
  } catch (e) { console.error(e); toast('Generate failed: ' + e.message, 'error'); } finally { done(); }
}

// ---------- references ----------
export async function addReferences(files) {
  for (const f of files) {
    try { state.references.push(await loadImageToCanvas(f)); } catch (e) { toast(e.message, 'error'); }
  }
  notify('references');
}
export function removeReference(i) { state.references.splice(i, 1); notify('references'); }

// ---------- selection (mask) ----------
export function toggleRegion(name) {
  const V = activeView(); if (!V.seg?.regions?.[name]) { toast(`No "${name}" area was found on this garment.`, 'info'); return; }
  snapshot();
  const x = V.mask.getContext('2d');
  const on = V.regionSel.includes(name);
  if (on) {
    V.regionSel = V.regionSel.filter(n => n !== name);
    x.save(); x.globalCompositeOperation = 'destination-out'; x.drawImage(V.seg.regions[name], 0, 0); x.restore();
  } else {
    V.regionSel.push(name);
    const t = makeCanvas(), tx = t.getContext('2d');
    tx.drawImage(V.seg.regions[name], 0, 0); tx.globalCompositeOperation = 'source-in'; tx.fillStyle = 'rgb(79,70,229)'; tx.fillRect(0, 0, SIZE, SIZE);
    x.drawImage(t, 0, 0);
  }
  touchMask(V); state.flow.skippedSelect = false; notify('mask');
}
export function selectWhole() {
  const V = activeView(); if (!V.seg) return; snapshot();
  const t = makeCanvas(), tx = t.getContext('2d');
  tx.drawImage(V.seg.mask, 0, 0); tx.globalCompositeOperation = 'source-in'; tx.fillStyle = 'rgb(79,70,229)'; tx.fillRect(0, 0, SIZE, SIZE);
  const x = V.mask.getContext('2d'); x.clearRect(0, 0, SIZE, SIZE); x.drawImage(t, 0, 0);
  V.regionSel = []; touchMask(V); notify('mask');
}
export function clearMask() {
  const V = activeView(); snapshot();
  V.mask.getContext('2d').clearRect(0, 0, SIZE, SIZE); V.regionSel = []; touchMask(V); notify('mask');
}
export function invertMask() {
  const V = activeView(); if (!V.seg) return; snapshot();
  const t = makeCanvas(), tx = t.getContext('2d');
  tx.drawImage(V.seg.mask, 0, 0); tx.globalCompositeOperation = 'destination-out'; tx.drawImage(V.mask, 0, 0);
  tx.globalCompositeOperation = 'source-in'; tx.fillStyle = 'rgb(79,70,229)'; tx.fillRect(0, 0, SIZE, SIZE);
  const x = V.mask.getContext('2d'); x.clearRect(0, 0, SIZE, SIZE); x.drawImage(t, 0, 0);
  V.regionSel = []; touchMask(V); notify('mask');
}
/** mask handed to engines: the selection as drawn (it may include empty space so shapes can grow), or null when nothing is selected */
export function effectiveMask(V = activeView()) {
  if (!hasMask(V)) return null;
  return cloneCanvas(V.mask);
}
export function growMask(px = 28) {
  const V = activeView(); if (!hasMask(V)) { toast('Select an area first.', 'info'); return; }
  snapshot();
  const src = cloneCanvas(V.mask), x = V.mask.getContext('2d');
  for (const r of [px, px * 0.5]) for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; x.drawImage(src, Math.cos(a) * r, Math.sin(a) * r); }
  touchMask(V); notify('mask');
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
    let res = [];
    try {
      res = await requestVariations({ imageCanvas: src, maskCanvas: mask, prompt: promptText, refs: state.references, view: state.activeView, ops });
    } catch (e) { console.warn('AI request failed', e); }
    const labels = ['Subtle', 'Medium', 'Bold'];
    let local = null;
    const out = [];
    for (let i = 0; i < 3; i++) {
      const r = res[i];
      if (r && r.canvas && r.source === 'ai') {
        const c = mask ? enforceMask(src, r.canvas, mask) : r.canvas;
        out.push({ label: r.label || labels[i], canvas: c, seg: null, source: 'ai' });
      } else {
        local = local || await localVariations(src, seg, mask, ops);
        const l = local[i]; out.push({ label: l.label, canvas: mask ? enforceMask(src, l.canvas, mask) : l.canvas, seg: mask ? null : (l.seg || null), source: 'local' });
      }
    }
    state.variations = out.map(o => ({ ...o, ops }));
    state.applied = null;
    state.engine.used = out.every(o => o.source === 'ai') ? 'ai' : out.some(o => o.source === 'ai') ? 'mixed' : 'local';
    markFlow('generated'); notify('variations');
    if (!mask) toast('No area selected: changes may touch any matching part of the garment.', 'info', 3800);
  } catch (e) { console.error(e); toast('Could not generate variations: ' + e.message, 'error'); } finally { done(); }
}
async function bake(canvas, seg, label) {
  const V = activeView();
  const s = seg || await segmentGarment(canvas);
  V.job++;
  V.base = canvas; V.baseSeg = s; V.current = canvas; V.seg = s;
  V.params = { ...DEFAULT_PARAMS }; V.color = newColor(); V.fabric = { name: null, amount: 0.6 };
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
  } catch (e) { toast('Could not combine: ' + e.message, 'error'); } finally { done(); }
}

// ---------- elements ----------
export function selectedElement() { return state.elements.find(e => e.id === state.selectedId) || null; }
export function removeElement(id) { snapshot(); state.elements = state.elements.filter(e => e.id !== id); if (state.selectedId === id) state.selectedId = null; notify('elements'); }

// ---------- engine ----------
export async function refreshEngine() {
  try { const s = await aiStatus(); state.engine.available = !!s.available; state.engine.provider = s.provider || (s.available ? 'ai' : 'local'); }
  catch { state.engine.available = false; state.engine.provider = 'local'; }
  notify('engine');
}
export const undo = () => { sUndo(); };
export const redo = () => { sRedo(); };
export { REGION_NAMES, FIT_PRESETS, SLEEVE_PRESETS, DEFAULT_PARAMS };
