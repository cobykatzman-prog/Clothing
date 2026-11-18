// Threadform - manual editing (owner: manual-editing worker).
// 1. Per-part garment colour: each garment region (sleeve, collar, cuffs...) gets its own target colour,
//    applied as a full-strength tint through fabric.applyColor so folds and shading survive.
// 2. Element inspector (right panel), layers list (left panel) and keyboard nudging for design elements.
//    The inspector edits every property of an element: content, font, size, weight, outline, shadow, colours,
//    logo image and tint, position, scale, rotation, opacity, flip, copies to other views and reset.
// Every manual change goes through state.snapshot() so undo/redo covers it. Continuous controls (sliders,
// typing, arrow-key nudges) share one undo step via editGate(), so dragging stays smooth.
import { state, activeView, snapshot, notify, subscribe, markFlow, VIEWS, VIEW_LABELS } from './state.js';
import { h, icon, toast, SIZE, friendly, userError } from './util.js';
import { REGION_NAMES } from './segment.js';
import { isSelTool, selToolHint } from './selection.js';
import { applyColor } from './fabric.js';
import { FONTS, WEIGHTS, GRAPHIC_LIBRARY, getGraphic, fitElement, updateElement, resetElement, copyToView, createElement, onElementAssetsLoaded } from './elements.js';
import * as A from './ui-actions.js';

/* ------------------------------------------------------------------ small helpers */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const HEX = /^#[0-9a-f]{6}$/i;
function hexToRgb(hex) { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); }
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let hh = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  return [hh, s, l];
}
function hslToRgb(hh, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}
/** Target colour for a part: its picked colour, nudged by the hue / saturation / lightness sliders. */
export function partTarget(p) {
  if (!p || !HEX.test(p.color || '')) return null;
  const [r, g, b] = hexToRgb(p.color); let [hh, s, l] = rgbToHsl(r, g, b);
  hh = (hh + (p.hue || 0) / 360 + 1) % 1;
  const sat = p.sat || 0, lig = p.light || 0;
  s = sat > 0 ? s + (1 - s) * sat / 100 : s * (1 + sat / 100);
  l = lig > 0 ? l + (1 - l) * lig / 100 : l * (1 + lig / 100);
  return rgbToHex(...hslToRgb(hh, clamp(s, 0, 1), clamp(l, 0, 1)));
}

/* ------------------------------------------------------------------ per-part colour: pipeline + sampling */
export const PART_LABELS = {
  body: ['Body', 'The main torso panel'],
  leftSleeve: ['Left sleeve', "The garment's left sleeve (right side as you look at it)"],
  rightSleeve: ['Right sleeve', "The garment's right sleeve (left side as you look at it)"],
  shoulders: ['Shoulders', 'Shoulder seams and yoke'],
  collar: ['Collar', 'The collar or neckband'],
  neckline: ['Neckline', 'The neck opening edge'],
  cuffs: ['Cuffs', 'Cuffs at the end of the sleeves'],
  hem: ['Hem', 'The bottom hem'],
  sidePanels: ['Side panels', 'Side seams and panels'],
  stripes: ['Stripes', 'Existing stripes'],
  logos: ['Logos', 'Existing logos or prints'],
  text: ['Lettering', 'Existing lettering'],
};
export const PART_NAMES = REGION_NAMES.filter(n => PART_LABELS[n]);
export const partsActive = parts => !!parts && PART_NAMES.some(n => parts[n]?.color);

/** Pipeline step (called by ui-actions.recompute after the whole-garment colour). Pure: returns a canvas. */
export function applyParts(canvas, seg, parts) {
  let out = canvas;
  for (const name of PART_NAMES) {
    const p = parts?.[name], mask = seg?.regions?.[name];
    const target = partTarget(p);
    if (!target || !mask) continue;
    out = applyColor(out, mask, { tint: target, tintAmount: 1 });
  }
  return out;
}

const SAMPLE = 96;
let _scratch = null;
const _sampleCache = new WeakMap();
/** Average colour of the pixels a region covers in `canvas` (what the user currently sees), as #rrggbb or null. */
export function sampleRegion(canvas, mask) {
  if (!canvas || !mask) return null;
  const hit = _sampleCache.get(mask);
  if (hit && hit.canvas === canvas) return hit.hex;
  if (!_scratch) { _scratch = [document.createElement('canvas'), document.createElement('canvas')]; _scratch.forEach(c => { c.width = c.height = SAMPLE; }); }
  const [a, b] = _scratch;
  const ax = a.getContext('2d', { willReadFrequently: true }), bx = b.getContext('2d', { willReadFrequently: true });
  ax.clearRect(0, 0, SAMPLE, SAMPLE); bx.clearRect(0, 0, SAMPLE, SAMPLE);
  ax.drawImage(canvas, 0, 0, SAMPLE, SAMPLE); bx.drawImage(mask, 0, 0, SAMPLE, SAMPLE);
  const pa = ax.getImageData(0, 0, SAMPLE, SAMPLE).data, pm = bx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  let r = 0, g = 0, bl = 0, n = 0;
  for (let i = 0; i < pa.length; i += 4) if (pm[i + 3] > 127 && pa[i + 3] > 127) { r += pa[i]; g += pa[i + 1]; bl += pa[i + 2]; n++; }
  const hex = n ? rgbToHex(r / n, g / n, bl / n) : null;
  _sampleCache.set(mask, { canvas, hex });
  return hex;
}

/* ------------------------------------------------------------------ undo gating */
// Continuous controls call editGate() before each change: the first call takes one snapshot, later calls
// within the idle window reuse it. closeGate() ends the gesture (on change, selection change, undo).
let gateOpen = false, gateT = 0;
export function editGate() {
  if (!gateOpen) { snapshot(); gateOpen = true; }
  clearTimeout(gateT); gateT = setTimeout(closeGate, 800);
}
export function closeGate() { gateOpen = false; clearTimeout(gateT); }
subscribe(r => { if (r === 'restore' || r === 'loaded') closeGate(); });

/* ------------------------------------------------------------------ part selection & values */
export function activePart() { const n = state.ui.part; return n && PART_LABELS[n] ? n : 'body'; }
/** Makes a garment part the one the colour panel edits (called from canvas clicks and the part chips). */
export function setActivePart(name) { if (state.ui.part === name) return; state.ui.part = name; notify('part'); }
/** Patch one part's colour settings. The first change starts from the colour the part has now. */
export function setPartValue(name, patch) {
  const V = activeView(); if (!V.base || !V.seg?.regions?.[name]) return;
  editGate();
  const cur = (V.parts || {})[name];
  const now = sampleRegion(V.current, V.seg.regions[name]) || '#808080';
  V.parts = { ...(V.parts || {}), [name]: { hue: 0, sat: 0, light: 0, ...cur, color: cur?.color || now, ...patch } };
  markFlow('refined'); notify('color');
}
/** Remove a part's colour (back to the garment colour). Structural: one undo step. */
export function clearPart(name) {
  const V = activeView(); if (!V.parts?.[name]) return;
  closeGate(); snapshot();
  const parts = { ...V.parts }; delete parts[name]; V.parts = parts;
  notify('color');
}

/* ------------------------------------------------------------------ styles (shared by both panels) */
let _css = false;
function ensureCss() {
  if (_css) return; _css = true;
  const s = document.createElement('style'); s.id = 'manual-css';
  s.textContent = `
.pgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.pchip{display:flex;align-items:center;gap:7px;border:1px solid var(--line);background:#fff;border-radius:9px;padding:5px 7px;font-size:12px;font-weight:550;cursor:pointer;text-align:left;min-width:0}
.pchip span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pchip.on{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.pchip:disabled{opacity:.4;cursor:default}
.sw{display:inline-block;width:16px;height:16px;border-radius:5px;border:1px solid rgba(0,0,0,.15);flex:none}
.sw.big{width:30px;height:30px;border-radius:8px}
.peditor{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:8px}
.ptitle{font-weight:650;font-size:13px}
.peditor .hex,.insp input[type=text],.insp input[type=number],.insp textarea,.insp select{font:inherit;font-size:12.5px;padding:5px 7px;border:1px solid var(--line);border-radius:8px;width:100%;box-sizing:border-box;background:#fff;min-width:0}
.peditor .hex{width:96px}
.insp{display:flex;flex-direction:column;gap:8px}
.insp .field{display:flex;flex-direction:column;align-items:stretch;gap:3px}
.insp .field.inline{flex-direction:row;align-items:center;justify-content:space-between}
.insp .field.inline input[type=color]{width:44px;height:28px;padding:2px;border:1px solid var(--line);border-radius:8px;background:#fff}
.insp .num2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.insp .btns{display:flex;flex-wrap:wrap;gap:6px}
.insp .btns .btn{padding:5px 9px;font-size:12px}
.insp input:disabled,.insp textarea:disabled,.insp select:disabled{opacity:.5}
.insp .igrp{border-top:1px solid var(--line);padding-top:6px}
.insp .igrp>summary{cursor:pointer;font-weight:650;font-size:12.5px;padding:3px 0 3px 18px;position:relative;list-style:none}
.insp .igrp>summary::-webkit-details-marker{display:none}
.insp .igrp>summary::before{content:'';position:absolute;left:4px;top:50%;width:6px;height:6px;border-right:1.6px solid var(--muted);border-bottom:1.6px solid var(--muted);transform:translateY(-70%) rotate(-45deg);transition:transform .12s}
.insp .igrp[open]>summary::before{transform:translateY(-30%) rotate(45deg)}
.insp .igrp-body{display:flex;flex-direction:column;gap:8px;padding:6px 0 2px}
.insp .copyrow{display:flex;flex-wrap:wrap;gap:6px}
.insp .copyrow .btn{padding:5px 9px;font-size:12px}
.erow.dropabove{box-shadow:inset 0 2px 0 var(--accent)}
.erow.dropbelow{box-shadow:inset 0 -2px 0 var(--accent)}
.erow .mini{font:inherit;font-size:11px;line-height:1;padding:4px 5px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;color:var(--muted)}
.erow .mini:disabled{opacity:.35;cursor:default}
.erow .mini:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.erow.locked .ename{font-style:italic}
.erow.hidden .ename{text-decoration:line-through;opacity:.6}
.erow .ename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.erow .etype{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);min-width:44px}
`;
  document.head.append(s);
}

export function createPartPanel() {
  ensureCss();
  const chips = new Map();
  const grid = h('div', { class: 'pgrid' }, PART_NAMES.map(n => {
    const sw = h('span', { class: 'sw' });
    const btn = h('button', { class: 'pchip', 'data-p': n, onclick: () => setActivePart(n) }, sw, h('span', {}, PART_LABELS[n][0]));
    chips.set(n, { btn, sw });
    return btn;
  }));
  const title = h('div', { class: 'ptitle' });
  const curSw = h('span', { class: 'sw big', tip: 'Colour the part has now' });
  const newSw = h('span', { class: 'sw big', tip: 'Colour the part will have' });
  const picker = h('input', { type: 'color', 'aria-label': 'Pick the part colour', tip: 'Pick a colour for this part' });
  const hexIn = h('input', { type: 'text', class: 'hex', maxlength: 7, 'aria-label': 'Part colour as hex', tip: 'Type a colour as #rrggbb' });
  const setP = patch => { setPartValue(activePart(), patch); A.scheduleRecompute(); };
  picker.addEventListener('input', () => setP({ color: picker.value }));
  picker.addEventListener('change', closeGate);
  hexIn.addEventListener('input', () => { const v = hexIn.value.trim().toLowerCase(); if (HEX.test(v)) setP({ color: v }); });
  hexIn.addEventListener('change', closeGate);
  const sl = {};
  const sliderRow = (k, label, min, max, tip) => {
    const out = h('output', { class: 'val' }, '0');
    const inp = h('input', { type: 'range', min, max, step: 1, value: 0, 'aria-label': 'Part ' + label.toLowerCase(), tip,
      oninput: e => { setP({ [k]: +e.target.value }); }, onchange: closeGate,
      ondblclick: e => { e.target.value = 0; setP({ [k]: 0 }); closeGate(); } });
    sl[k] = { inp, out };
    return h('div', { class: 'slider' }, h('div', { class: 'row between' }, h('span', { class: 'lbl' }, label), out), inp);
  };
  const resetBtn = h('button', { class: 'btn ghost sm', tip: 'Remove the colour from this part (back to the garment colour)', onclick: () => { clearPart(activePart()); A.scheduleRecompute(); } }, 'Reset this part');
  const ed = h('div', { class: 'peditor' },
    title,
    h('div', { class: 'row gap center' }, curSw, h('span', { class: 'muted' }, '→'), newSw, picker, hexIn),
    sliderRow('hue', 'Hue', -180, 180, 'Shift the hue of the picked colour'),
    sliderRow('sat', 'Saturation', -100, 100, 'Less or more vivid'),
    sliderRow('light', 'Lightness', -100, 100, 'Darker or lighter (double-click a slider to reset it)'),
    resetBtn,
    h('div', { class: 'muted small' }, 'Pick a colour and the part takes it, keeping its folds and shading.'));
  const root = h('div', { class: 'pwrap' }, grid, ed);

  function sync() {
    const V = activeView(), name = activePart();
    for (const n of PART_NAMES) {
      const c = chips.get(n), reg = V.base ? V.seg?.regions?.[n] : null;
      const hex = reg ? sampleRegion(V.current, reg) : null;
      c.sw.style.background = hex || 'repeating-linear-gradient(45deg,#fff 0 3px,#ddd 3px 6px)';
      c.btn.disabled = !reg;
      c.btn.classList.toggle('on', n === name);
      c.btn.setAttribute('aria-pressed', String(n === name));
      c.btn.setAttribute('data-tip', `${PART_LABELS[n][1]}${hex ? '. Current colour ' + hex : ''}`);
    }
    const reg = V.base ? V.seg?.regions?.[name] : null;
    ed.hidden = !reg;
    if (!reg) return;
    const p = (V.parts || {})[name];
    const cur = sampleRegion(V.current, reg) || '#808080';
    title.textContent = 'Colour: ' + PART_LABELS[name][0];
    curSw.style.background = cur;
    newSw.style.background = partTarget(p) || cur;
    resetBtn.disabled = !p?.color;
    const val = p?.color || cur;
    if (document.activeElement !== picker) picker.value = val;
    if (document.activeElement !== hexIn) hexIn.value = val;
    for (const k of ['hue', 'sat', 'light']) {
      const v = Math.round(p?.[k] || 0), { inp, out } = sl[k];
      if (document.activeElement !== inp) inp.value = v;
      out.textContent = v;
    }
  }
  sync();
  subscribe(r => { if (r === 'render') sync(); });   // swatches show the colour after the recompute has finished
  return { el: root, sync };
}

/* ------------------------------------------------------------------ design elements: helpers */
export const TYPE_LABEL = { text: 'Text', logo: 'Logo', crest: 'Crest', graphic: 'Graphic', stripe: 'Stripes', piping: 'Piping', embroidery: 'Embroidery', print: 'Print', patch: 'Patch' };
const TEXTY = el => ['text', 'embroidery', 'print'].includes(el.type) && el.props.text != null && !el.props.graphicId && !el.props.svg;
function baseOf(el) { if (!el.base) el.base = { w: el.w, h: el.h, size: el.props.size }; return el.base; }
export function scalePct(el) { const b = baseOf(el); return TEXTY(el) && b.size ? el.props.size / b.size * 100 : el.w / b.w * 100; }
export function setScalePct(el, pct) {
  const b = baseOf(el); pct = Math.max(2, pct);
  if (TEXTY(el) && b.size) { el.props.size = Math.max(4, b.size * pct / 100); el._cache = null; fitElement(el); }
  else { el.w = Math.max(6, b.w * pct / 100); el.h = Math.max(4, b.h * pct / 100); }
  return el;
}
const graphicSlots = p => { const lib = getGraphic(p.graphicId); return [['color', 'Main colour', 'c1'], ['color2', 'Accent colour', 'c2'], ['color3', 'Detail colour', 'c3']].map(([key, label, c]) => ({ key, label, fallback: lib?.colors?.[c] })); };
/** Colour fields an element exposes in the inspector. */
export function colorSlots(el) {
  const p = el.props;
  if (el.type === 'stripe') return [{ key: 'color', label: 'Stripe colour' }, { key: 'color2', label: 'Second colour' }];
  if (el.type === 'piping') return [{ key: 'color', label: 'Piping colour' }];
  if (el.type === 'logo') return [];
  if (el.type === 'patch') {
    const s = [{ key: 'bg', label: 'Patch fill' }, { key: 'border', label: 'Edge colour' }];
    if (p.graphicId) return s.concat(graphicSlots(p));
    if (p.text != null) s.push({ key: 'textColor', label: 'Lettering' });
    return s;
  }
  if (p.graphicId) return graphicSlots(p);
  if (p.svg) return [
    ['color', 'Main colour', 'c1'], ['color2', 'Accent colour', 'c2'],
    ['color3', 'Detail colour', 'c3'], ['color4', 'Additional colour 1', 'c4'],
    ['color5', 'Additional colour 2', 'c5'], ['color6', 'Additional colour 3', 'c6']
  ].map(([key, label, slot]) => ({ key, label: 'SVG ' + label.toLowerCase(), fallback: p.colors?.[slot] }))
    .filter(slot => !!slot.fallback);
  if (TEXTY(el)) return [{ key: 'color', label: 'Colour' }];
  return [];
}
const hexOr = (v, fallback) => (HEX.test(v || '') ? v.toLowerCase() : fallback);
const slotHex = (el, s) => hexOr(el.props[s.key] ?? s.fallback, '#888888');
const sigOf = el => [el.id, el.locked, el.visible, el.type, el.props.graphicId, el.props.text != null, el.props.shape].join('|');
// fonts: a family counts as installed when the browser measures it differently from its generic fallback
const _fontOk = new Map();
export function fontInstalled(family) {
  if (!family) return true;
  if (_fontOk.has(family)) return _fontOk.get(family);
  const ctx = document.createElement('canvas').getContext('2d'), s = 'mmmmmmmmmmlli0Oo@#';
  const w = f => { ctx.font = `72px ${f}`; return ctx.measureText(s).width; };
  const ok = w(`"${family}", monospace`) !== w('monospace') || w(`"${family}", serif`) !== w('serif');
  _fontOk.set(family, ok); return ok;
}

/* ------------------------------------------------------------------ structural edits (one undo step each) */
function change(fn) { closeGate(); snapshot(); fn(); notify('elements'); }
export function selectedElement() { return state.elements.find(e => e.id === state.selectedId) || null; }
export function selectElement(id) { closeGate(); state.selectedId = id; state.ui.tool = 'move'; notify('selection'); }
export function duplicateElement(el) {
  if (!el) return;
  change(() => {
    const c = el.clone(); c.base = el.base ? { ...el.base } : null;
    c.x += 24; c.y += 24; c.name = (el.name || el.type) + ' copy';
    state.elements.splice(state.elements.indexOf(el) + 1, 0, c);
    state.selectedId = c.id;
  });
}
/** Copies an element onto other views (appended on top there). One undo step. Returns how many copies were made. */
export function duplicateToViews(el, views) {
  const targets = (views || []).filter(v => v !== el.view && VIEWS.includes(v));
  if (!el || !targets.length) return 0;
  change(() => { for (const v of targets) state.elements.push(copyToView(el, v)); });
  toast(`Copied to ${targets.map(v => VIEW_LABELS[v]).join(', ')}.`, 'ok');
  return targets.length;
}
export function deleteElement(el) {
  if (!el || el.locked) return;
  change(() => { state.elements = state.elements.filter(x => x.id !== el.id); if (state.selectedId === el.id) state.selectedId = null; });
  toast(`${TYPE_LABEL[el.type] || 'Item'} deleted.`, 'ok', 4000, { label: 'Undo', fn: () => A.undo() });
}
export function toggleLock(el) { if (el) change(() => { el.locked = !el.locked; }); }
export function toggleVisible(el) { if (el) change(() => { el.visible = el.visible === false; }); }
/** Reset one element to the look a new one of its type gets (keeps its text, graphic and logo). One undo step. */
export function resetItem(el) { if (el) change(() => { resetElement(el); }); toast('Reset to the default look.', 'ok'); }
/** Align by the rotated item's visible bounds, not its unrotated width/height. */
export function alignElement(el, mode) {
  if (!el || el.locked) return false;
  const b = state.views[el.view]?.seg?.bbox || { x: 0, y: 0, w: SIZE, h: SIZE };
  const a = (Number(el.rotation) || 0) * Math.PI / 180;
  const hw = Math.abs(Math.cos(a)) * el.w / 2 + Math.abs(Math.sin(a)) * el.h / 2;
  const hh = Math.abs(Math.sin(a)) * el.w / 2 + Math.abs(Math.cos(a)) * el.h / 2;
  const next = { x: el.x, y: el.y };
  if (mode === 'left') next.x = b.x + hw;
  else if (mode === 'hcenter') next.x = b.x + b.w / 2;
  else if (mode === 'right') next.x = b.x + b.w - hw;
  else if (mode === 'top') next.y = b.y + hh;
  else if (mode === 'vcenter') next.y = b.y + b.h / 2;
  else if (mode === 'bottom') next.y = b.y + b.h - hh;
  else return false;
  if (Math.abs(next.x - el.x) < 0.001 && Math.abs(next.y - el.y) < 0.001) return false;
  change(() => { el.x = next.x; el.y = next.y; });
  return true;
}
/** Layer order within this view. mode: 'up' (forward one), 'down' (back one), 'front', 'back'. */
export function reorder(el, mode) {
  const arr = state.elements, i = arr.indexOf(el); if (!el || i < 0) return;
  const above = [], below = [];
  arr.forEach((e, k) => { if (e !== el && e.view === el.view) (k > i ? above : below).push(k); });
  if (mode === 'up' && above.length) { const j = above[0]; change(() => { arr.splice(i, 1); arr.splice(j, 0, el); }); }
  else if (mode === 'down' && below.length) { const j = below[below.length - 1]; change(() => { arr.splice(i, 1); arr.splice(j, 0, el); }); }
  else if (mode === 'front' && above.length) change(() => { arr.splice(i, 1); arr.push(el); });
  else if (mode === 'back' && below.length) change(() => { arr.splice(i, 1); arr.unshift(el); });
}
/** Keyboard: Delete/Backspace removes, arrows nudge (Shift = 10 px), Ctrl/Cmd+D duplicates, Esc deselects. Returns true if handled. */
export function handleElementKey(e) {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return false;
  if (e.key === 'Escape' && state.selectedId) { closeGate(); state.selectedId = null; notify('selection'); return true; }
  const el = selectedElement(); if (!el) return false;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateElement(el); return true; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteElement(el); return true; }
  const s = e.shiftKey ? 10 : 1;
  const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
  if (!d) return false;
  e.preventDefault();
  if (el.locked) return true;
  editGate(); el.x += d[0]; el.y += d[1]; notify('elements-live');
  return true;
}
// logo images decode asynchronously: redraw the stage when one arrives (no autosave: 'render' is not content)
onElementAssetsLoaded(() => notify('render'));

/* ------------------------------------------------------------------ layers list (left panel) */
export function createLayers() {
  ensureCss();
  const list = h('div', { class: 'elist' });
  let dragId = null;
  const label = e => {
    const t = e.props?.text;
    if (t != null && !e.props.graphicId) return String(t).replace(/\s+/g, ' ').slice(0, 22) || e.name;
    const lib = getGraphic(e.props?.graphicId); return lib ? lib.name : (e.name || e.type);
  };
  const mini = (txt, tip, fn, disabled) => h('button', { class: 'mini', tip, disabled: !!disabled, 'aria-label': tip, onclick: ev => { ev.stopPropagation(); fn(); } }, txt);
  function row(e, items) {
    const pos = items.indexOf(e);
    const r = h('div', {
      class: 'erow' + (e.id === state.selectedId ? ' on' : '') + (e.locked ? ' locked' : '') + (e.visible === false ? ' hidden' : ''),
      draggable: 'true', 'data-id': e.id, tip: 'Click to select. Drag to change the layer order.',
      onclick: () => selectElement(e.id),
      ondragstart: ev => { dragId = e.id; ev.dataTransfer && ev.dataTransfer.setData('text/plain', e.id); },
      ondragend: () => { dragId = null; list.querySelectorAll('.dropabove,.dropbelow').forEach(x => x.classList.remove('dropabove', 'dropbelow')); },
      ondragover: ev => { if (!dragId) return; ev.preventDefault(); const b = r.getBoundingClientRect(); const above = ev.clientY < b.top + b.height / 2; r.classList.toggle('dropabove', above); r.classList.toggle('dropbelow', !above); },
      ondragleave: () => r.classList.remove('dropabove', 'dropbelow'),
      ondrop: ev => {
        ev.preventDefault(); r.classList.remove('dropabove', 'dropbelow');
        const from = state.elements.find(x => x.id === dragId), to = e; dragId = null;
        if (!from || from === to || from.view !== to.view) return;
        const above = ev.clientY < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2;
        change(() => { const arr = state.elements; arr.splice(arr.indexOf(from), 1); arr.splice(arr.indexOf(to) + (above ? 1 : 0), 0, from); });
      },
    },
      h('span', { class: 'etype' }, TYPE_LABEL[e.type] || e.type),
      h('span', { class: 'ename' }, label(e)),
      mini('▲', 'Bring forward (drawn over more things)', () => reorder(e, 'up'), pos === 0),
      mini('▼', 'Send backward (drawn under more things)', () => reorder(e, 'down'), pos === items.length - 1),
      mini(e.locked ? 'Unlock' : 'Lock', e.locked ? 'Unlock so it can be moved' : 'Lock so it cannot be moved or deleted', () => toggleLock(e)),
      h('button', { class: 'icon-btn', 'aria-label': e.visible === false ? 'Show layer' : 'Hide layer', tip: e.visible === false ? 'Show on the design' : 'Hide on the design', onclick: ev => { ev.stopPropagation(); toggleVisible(e); } }, icon(e.visible === false ? 'eyeoff' : 'eye', 15)),
      h('button', { class: 'icon-btn', 'aria-label': 'Delete layer', tip: 'Delete this element', disabled: !!e.locked, onclick: ev => { ev.stopPropagation(); deleteElement(e); } }, icon('trash', 15)));
    return r;
  }
  function sync(reason) {
    if (['render', 'zoom', 'processing', 'busy', 'elements-live', 'part'].includes(reason)) return;
    const items = state.elements.filter(e => e.view === state.activeView);
    const top = items.slice().reverse();   // top of the stack first
    list.replaceChildren(...(top.length ? top.map(e => row(e, top)) : [h('div', { class: 'muted small' }, 'Nothing added yet. Use sections 4 and 5 to add text, crests or stripes.')]));
  }
  // upload a picture as a new logo on this view
  const logoIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', hidden: true, 'aria-label': 'Logo file', onchange: e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) addLogo(f); } });
  const addBtn = h('button', { class: 'btn ghost sm', tip: 'Upload a logo or picture to place on the garment (then recolour it in the Selected item section)', onclick: () => logoIn.click() }, icon('plus', 15), 'Add logo…');
  const wrap = h('div', { class: 'lwrap' }, h('div', { class: 'row gap center' }, addBtn, logoIn), list);
  subscribe(sync); sync();
  return { el: wrap, sync };
}

/* ------------------------------------------------------------------ element inspector (right panel) */
/** Reads a picture file into a PNG data URL, shrunk to 1024 px so the saved design stays small. */
function readLogo(file) {
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
  const ext = String(file?.name || '').split('.').pop().toLowerCase();
  const extensionTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
  const type = file?.type || extensionTypes[ext];
  if (!file || !allowed.has(type)) return Promise.reject(userError('Use a PNG, JPG, WebP or SVG logo.'));
  if (file.size > 20 * 1024 * 1024) return Promise.reject(userError('That logo is larger than 20 MB. Resize it and try again.'));
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(userError('That file could not be read. Try another image.'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => rej(userError('That file could not be read as an image. Try a PNG or JPG.'));
      img.onload = () => {
        const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1, k = Math.min(1, SIZE / Math.max(iw, ih));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(iw * k)); c.height = Math.max(1, Math.round(ih * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res({ url: c.toDataURL('image/png'), iw, ih });
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
/** Read and sanitise an SVG as vector artwork. It stays an SVG layer instead of being flattened to pixels. */
async function readVector(file) {
  if (!file || file.size > 20 * 1024 * 1024) throw userError('That SVG is larger than 20 MB.');
  const source = await file.text();
  if (source.length > 20 * 1024 * 1024) throw userError('That SVG is larger than 20 MB.');
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (root?.localName !== 'svg' || doc.querySelector('parsererror')) throw userError('That file is not a valid SVG.');
  // Preserve safe presentation rules from common SVG exports (including Illustrator),
  // but inline them before removing stylesheet nodes. External resources and active CSS are never kept.
  const styleNodes = [...root.querySelectorAll('style')];
  const cssRules = [];
  const safeCss = new Set(['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity', 'opacity']);
  for (const styleNode of styleNodes) {
    const css = styleNode.textContent || '';
    for (const match of css.matchAll(/([^{}]+)\\{([^{}]*)\\}/g)) {
      const selectors = match[1].trim().split(',');
      const declarations = [];
      for (const declaration of match[2].split(';')) {
        const at = declaration.indexOf(':');
        if (at < 1) continue;
        const property = declaration.slice(0, at).trim().toLowerCase();
        const value = declaration.slice(at + 1).trim();
        if (safeCss.has(property) && value && !/url\\s*\\(|javascript:|expression\\s*\\(/i.test(value)) declarations.push([property, value]);
      }
      if (declarations.length) for (const selector of selectors) {
        const clean = selector.trim();
        // Restrict selectors to simple tag/class/id combinations; ignore complex or active selectors.
        if (/^(?:[a-z][\\w-]*)?(?:[.#][\\w-]+)*$/i.test(clean) && clean) cssRules.push({ selector: clean, declarations });
      }
    }
  }
  if (cssRules.length) {
    const nodes = [root, ...root.querySelectorAll('*')];
    for (const node of nodes) {
      const applied = new Map();
      for (const rule of cssRules) {
        try { if (node.matches(rule.selector)) for (const [property, value] of rule.declarations) applied.set(property, value); } catch {}
      }
      const inline = new Set((node.getAttribute('style') || '').split(';').map(part => part.split(':', 1)[0].trim().toLowerCase()));
      for (const [property, value] of applied) {
        if (!inline.has(property) && !node.hasAttribute(property)) {
          const current = node.getAttribute('style') || '';
          node.setAttribute('style', current + (current.trim() && !current.trim().endsWith(';') ? ';' : '') + property + ':' + value);
        }
      }
    }
  }
  root.querySelectorAll('script,foreignObject,iframe,object,embed,style,link,animate,animateTransform,animateMotion,set').forEach(n => n.remove());
  for (const node of root.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase(), value = attr.value.trim();
      if (name.startsWith('on')) node.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) node.removeAttribute(attr.name);
      else if (/javascript:|expression\(|url\(\s*['"]?(?!#)/i.test(value)) node.removeAttribute(attr.name);
    }
  }
  for (const attr of [...root.attributes]) {
    const name = attr.name.toLowerCase(), value = attr.value.trim();
    if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) || /javascript:|expression\(|url\(\s*['"]?(?!#)/i.test(value)) root.removeAttribute(attr.name);
  }
  let vb = (root.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
  if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) {
    const w = parseFloat(root.getAttribute('width')) || 100, h = parseFloat(root.getAttribute('height')) || 100;
    vb = [0, 0, w, h];
  }
  // Turn up to three distinct solid fill/stroke colours into editor colour slots.
  // Keep gradients, patterns, "none", currentColor and other paint servers untouched.
  const palette = {};
  const colourCanvas = document.createElement('canvas');
  const colourContext = colourCanvas.getContext('2d');
  const pickerHex = value => {
    const colour = (value || '').trim();
    if (!colour || /^(none|currentcolor|inherit|initial|unset|transparent)$/i.test(colour) || /^url\(/i.test(colour)) return null;
    // Native colour inputs accept opaque six-digit hex. Normalize named/rgb/hsl colours
    // through the browser; leave alpha colours and paint servers unchanged.
    if (/^(rgba|hsla)\(/i.test(colour)) return null;
    if (!colourContext) return /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : null;
    colourContext.fillStyle = '#010203';
    colourContext.fillStyle = colour;
    const normalized = String(colourContext.fillStyle).toLowerCase();
    return /^#[0-9a-f]{6}$/.test(normalized) && normalized !== '#010203' ? normalized : null;
  };
  const paintToken = value => {
    const colour = pickerHex(value);
    if (!colour) return null;
    let index = Object.keys(palette).find(key => palette[key].toLowerCase() === colour);
    if (!index) {
      const used = Object.keys(palette).length;
      if (used >= 6) return null;
      index = 'c' + (used + 1);
      palette[index] = colour;
    }
    return '{{' + index + '}}';
  };
  const paintNodes = [root, ...root.querySelectorAll('*')];
  for (const node of paintNodes) {
    for (const attrName of ['fill', 'stroke']) {
      if (!node.hasAttribute(attrName)) continue;
      const token = paintToken(node.getAttribute(attrName));
      if (token) node.setAttribute(attrName, token);
    }
    if (node.hasAttribute('style')) {
      const style = node.getAttribute('style').replace(/(^|;)\s*(fill|stroke)\s*:\s*([^;]+)/gi, (whole, prefix, property, value) => {
        const token = paintToken(value);
        return token ? prefix + property + ':' + token : whole;
      });
      node.setAttribute('style', style);
    }
  }
  const inner = [...root.childNodes].map(n => new XMLSerializer().serializeToString(n)).join('');
  // A fixed outer viewBox lets the existing editor scale the artwork consistently; the nested SVG
  // preserves the source's original coordinate system and aspect ratio.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><svg x="0" y="0" width="100" height="100" viewBox="' + vb.join(' ') + '" preserveAspectRatio="xMidYMid meet">' + inner + '</svg></svg>';
  return { svg, ratio: vb[3] / vb[2], colors: palette };
}
function isSVGFile(file) {
  return file?.type === 'image/svg+xml' || /\.svg$/i.test(file?.name || '');
}
/** Replace a logo's picture (keeps its width and position). */
async function replaceLogo(el, file) {
  if (!el || !file) return;
  try {
    const vector = isSVGFile(file) ? await readVector(file) : null;
    const raster = vector ? null : await readLogo(file);
    // The user may delete the layer while the file is decoding; never resurrect or mutate a stale object.
    if (!state.elements.includes(el) || el.type !== 'logo') return;
    change(() => {
      if (vector) { el.type = 'graphic'; el.props = { svg: vector.svg, ...(Object.keys(vector.colors).length ? { colors: vector.colors } : {}) }; el.h = el.w * vector.ratio; }
      else { el.props.image = raster.url; el._tint = null; el.h = el.w * raster.ih / raster.iw; }
      el._cache = null; el.base = { w: el.w, h: el.h, size: el.props.size };
    });
    toast('Logo replaced.', 'ok');
  } catch (e) { toast(friendly(e, 'That logo could not be used. Try a PNG or JPG.'), 'error', 5000); }
}
/** Adds an uploaded picture as a logo on the active view, centred on the garment's body. */
export async function addLogo(file) {
  const viewName = state.activeView;
  const V = activeView();
  if (!V.current) { toast('Load a garment first.', 'info'); return; }
  try {
    const vector = isSVGFile(file) ? await readVector(file) : null;
    const raster = vector ? null : await readLogo(file);
    // Keep the upload attached to the view where it was started; don't silently place it on a newly selected view.
    if (state.activeView !== viewName || activeView() !== V) {
      toast('The view changed while the logo was loading. Select the original view and upload it again.', 'info', 5000);
      return;
    }
    const b = V.seg?.bbox, pos = b ? { x: b.x + b.w / 2, y: b.y + b.h * 0.4 } : { x: SIZE / 2, y: SIZE / 2 };
    const el = vector
      ? createElement('graphic', { svg: vector.svg, ...(Object.keys(vector.colors).length ? { colors: vector.colors } : {}), view: viewName, ...pos })
      : createElement('logo', { image: raster.url, view: viewName, ...pos });
    el.w = 200; el.h = vector ? 200 * vector.ratio : 200 * raster.ih / raster.iw;
    el.base = { w: el.w, h: el.h, size: undefined };
    change(() => { state.elements.push(el); state.selectedId = el.id; state.ui.tool = 'move'; });
    markFlow('refined');
  } catch (e) { toast(friendly(e, 'That logo could not be added. Try a PNG or JPG.'), 'error', 5000); }
}
/** Shadow settings are replaced as a whole object (never mutated) so undo snapshots keep their own copy. */
function setShadow(el, patch) {
  el.props.shadow = { on: false, color: '#000000', alpha: 0.45, blur: 8, x: 4, y: 4, ...(el.props.shadow || {}), ...patch };
}

export function createInspector() {
  ensureCss();
  const body = h('div', { class: 'insp' });
  const empty = h('div', { class: 'muted small' }, 'Nothing selected. Click a design element on the canvas or in the layers list to edit it. Add elements from sections 4 and 5.');
  let key = null, sig = null, binders = [], inputs = [], writing = null;
  const cur = () => state.elements.find(e => e.id === key) || null;

  // bind a control to one property: refreshes from the element, writes back on input (one undo step per gesture)
  function bind(input, get, set) {
    inputs.push(input);
    binders.push(c => {
      input.disabled = !!c.locked;
      if (document.activeElement === input || input === writing) return;
      if (input.type === 'checkbox') input.checked = !!get(c); else input.value = get(c) ?? '';
    });
    input.addEventListener('input', () => {
      const c = cur(); if (!c || c.locked) return;
      const v = input.type === 'checkbox' ? input.checked : input.value;   // read before the undo snapshot notifies
      writing = input;
      try { editGate(); set(c, v); } finally { writing = null; }
      notify('elements-live');
    });
    input.addEventListener('change', () => { closeGate(); notify('elements'); });
    return input;
  }
  const row = (label, control, tip, inline) => h('label', { class: 'field' + (inline ? ' inline' : ''), tip }, h('span', { class: 'lbl' }, label), control);
  const textIn = (label, get, set, tip, multi) => row(label, bind(h(multi ? 'textarea' : 'input', multi ? { rows: 2, 'aria-label': label } : { type: 'text', 'aria-label': label }), get, set), tip);
  const numIn = (label, get, set, o = {}) => row(label, bind(h('input', { type: 'number', min: o.min, max: o.max, step: o.step || 1, 'aria-label': label }), get, (c, v) => { const n = parseFloat(v); if (Number.isFinite(n)) set(c, n); }), o.tip);
  const rangeIn = (label, get, set, min, max, tip) => row(label, bind(h('input', { type: 'range', min, max, step: 1, 'aria-label': label }), get, (c, v) => set(c, +v)), tip);
  const colorIn = (label, get, set, tip) => row(label, bind(h('input', { type: 'color', 'aria-label': label }), get, set), tip, true);
  const check = (label, get, set, tip) => h('label', { class: 'check', tip }, bind(h('input', { type: 'checkbox' }), get, set), label);
  const select = (label, options, get, set, tip) => row(label, bind(h('select', { 'aria-label': label }, options), get, set), tip);
  const btn = (txt, tip, fn, cls = 'btn ghost sm') => h('button', { class: cls, tip, onclick: () => { const c = cur(); if (c) fn(c); } }, txt);
  const group = (title, kids, open = true) => h('details', { class: 'igrp', open: open || null }, h('summary', {}, title), h('div', { class: 'igrp-body' }, kids));
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', hidden: true, 'aria-label': 'Replace logo image', onchange: e => { const f = e.target.files?.[0]; e.target.value = ''; const c = cur(); if (c && f) replaceLogo(c, f); } });

  function build(c) {
    binders = []; inputs = [];
    const p = c.props, parts = [], lib = getGraphic(p.graphicId);
    parts.push(h('div', { class: 'ptitle' }, (TYPE_LABEL[c.type] || c.type) + (lib ? ' · ' + lib.name : '')));
    parts.push(textIn('Name', x => x.name, (x, v) => { x.name = v; }, 'A name for this item in the layers list'));

    // Beginner-friendly controls first: the common actions are visible before the detailed controls.
    parts.push(group('Quick edit', [
      h('div', { class: 'num2' },
        numIn('Size %', x => Math.round(scalePct(x)), (x, v) => setScalePct(x, clamp(v, 2, 800)), { min: 2, max: 800, tip: 'Resize the selected item without changing its proportions' }),
        numIn('Rotation °', x => Math.round(x.rotation), (x, v) => { x.rotation = ((v % 360) + 360) % 360; }, { min: 0, max: 359, tip: 'Turn the selected item' })),
      h('div', { class: 'btns' },
        btn('Centre on garment', 'Place this item in the middle of the garment', x => {
          const b = activeView().seg?.bbox;
          if (b) change(() => { x.x = b.x + b.w / 2; x.y = b.y + b.h * 0.4; });
        }),
        btn('Duplicate', 'Make another copy of this item', x => duplicateElement(x)),
        btn('Delete', 'Remove this item', x => deleteElement(x), 'btn ghost sm danger')),
      h('details', { class: 'igrp' },
        h('summary', {}, 'Align to garment'),
        h('div', { class: 'igrp-body' },
          h('div', { class: 'btns' },
            btn('Centre horizontally', 'Align the item to the garment centre from left to right', x => alignElement(x, 'hcenter')),
            btn('Centre vertically', 'Align the item to the garment centre from top to bottom', x => alignElement(x, 'vcenter'))),
          h('div', { class: 'btns' },
            btn('Align left', 'Align the visible left edge of the item with the garment left edge', x => alignElement(x, 'left')),
            btn('Align right', 'Align the visible right edge of the item with the garment right edge', x => alignElement(x, 'right'))),
          h('div', { class: 'btns' },
            btn('Align top', 'Align the visible top edge of the item with the garment top edge', x => alignElement(x, 'top')),
            btn('Align bottom', 'Align the visible bottom edge of the item with the garment bottom edge', x => alignElement(x, 'bottom')))),
      h('div', { class: 'muted small' }, 'Drag the item on the shirt to move it. Pull a corner to resize, or use the round handle to rotate it. Arrow keys nudge it; Shift + arrow moves 10 px.')
    ]));

    // ---- content: what the item says or shows
    const content = [];
    if (TEXTY(c)) {
      content.push(textIn('Text', x => x.props.text, (x, v) => updateElement(x, { text: v }), 'The words. Press Enter for a new line.', true));
      const fontOpts = FONTS.map(f => h('option', { value: f.value }, f.label + (fontInstalled(f.family) ? '' : ' · fallback here')));
      content.push(select('Font', fontOpts, x => x.props.font, (x, v) => updateElement(x, { font: v }), 'Typeface. Fonts not installed on this computer show their fallback.'));
    }
    if (c.type === 'patch') {
      content.push(select('Shape', ['round', 'oval', 'shield', 'square'].map(s => h('option', { value: s }, s[0].toUpperCase() + s.slice(1))), x => x.props.shape, (x, v) => updateElement(x, { shape: v }), 'Outline of the patch'));
      if (p.text != null && !p.graphicId) content.push(textIn('Lettering', x => x.props.text, (x, v) => updateElement(x, { text: v.slice(0, 6) }), 'Up to 6 characters'));
    }
    if (c.type === 'crest' || c.type === 'graphic' || (c.type === 'patch' && p.graphicId)) {
      const cat = lib?.category || (c.type === 'crest' ? 'crest' : 'graphic');
      const opts = GRAPHIC_LIBRARY.filter(g => g.category === cat);
      if (opts.length) content.push(select('Design', opts.map(g => h('option', { value: g.id }, g.name)), x => x.props.graphicId, (x, v) => updateElement(x, { graphicId: v }), 'Swap for another design from the same group'));
    }
    if (c.type === 'logo') {
      content.push(h('div', { class: 'btns' },
        btn('Replace image…', 'Upload a picture to use instead of this logo', () => fileIn.click()), fileIn));
      content.push(colorIn('Tint colour', x => (HEX.test(x.props.tint || '') ? x.props.tint : '#c0392b'), (x, v) => { x.props.tint = v; if (!(x.props.tintAmount > 0)) x.props.tintAmount = 1; }, 'Recolour the logo with this colour'));
      content.push(rangeIn('Tint strength %', x => Math.round((x.props.tintAmount || 0) * 100), (x, v) => { x.props.tintAmount = v / 100; }, 0, 100, '0 = the logo keeps its own colours'));
    }
    if (c.type === 'stripe') {
      content.push(numIn('Number of stripes', x => x.props.count || 1, (x, v) => updateElement(x, { count: clamp(Math.round(v), 1, 8) }), { min: 1, max: 8 }));
      content.push(rangeIn('Gap between stripes %', x => Math.round((x.props.gapRatio ?? 0.7) * 100), (x, v) => updateElement(x, { gapRatio: v / 100 }), 0, 200, 'Space between the stripes, as a share of stripe height'));
      content.push(check('Alternate colours', x => !!x.props.alternate, (x, v) => updateElement(x, { alternate: v }), 'Use the second colour for every other stripe'));
      content.push(check('Ribbed texture', x => x.props.ribbed !== false, (x, v) => updateElement(x, { ribbed: v }), 'Fine rib lines across the stripes'));
    }
    if (c.type === 'piping') {
      content.push(rangeIn('Thickness', x => x.props.thickness || 8, (x, v) => updateElement(x, { thickness: clamp(v, 2, 40) }), 2, 40, 'How thick the piping is'));
      content.push(rangeIn('Bend', x => x.props.curve || 0, (x, v) => updateElement(x, { curve: v }), -100, 100, 'Bend the piping. 0 = straight'));
      content.push(check('Stitch marks', x => x.props.stitch !== false, (x, v) => updateElement(x, { stitch: v }), 'Dashed stitch lines along the piping'));
    }
    if (content.length) parts.push(group('Content', content));

    // ---- type (text) and colours
    const typo = [];
    if (TEXTY(c)) {
      typo.push(h('div', { class: 'num2' },
        numIn('Size', x => Math.round(x.props.size), (x, v) => updateElement(x, { size: clamp(v, 4, 400) }), { min: 4, max: 400, tip: 'Text height (the whole canvas is 1024)' }),
        numIn('Letter spacing', x => x.props.letterSpacing || 0, (x, v) => updateElement(x, { letterSpacing: clamp(v, -20, 60) }), { min: -20, max: 60, tip: 'Space between letters' })));
      typo.push(select('Weight', WEIGHTS.map(([w, n]) => h('option', { value: w }, `${n} (${w})`)), x => String(x.props.weight || 700), (x, v) => updateElement(x, { weight: +v }), 'Thickness of the letters'));
      typo.push(check('Italic', x => !!x.props.italic, (x, v) => updateElement(x, { italic: v }), 'Italic lettering'));
      typo.push(rangeIn('Arch', x => x.props.curve || 0, (x, v) => updateElement(x, { curve: v }), -100, 100, 'Bend the text into an arch (right) or a smile (left). 0 = straight'));
    }
    const slots = colorSlots(c);
    for (const s of slots) typo.push(colorIn(s.label, x => slotHex(x, s), (x, v) => updateElement(x, { [s.key]: v }), s.label + ' (click to pick)'));
    if (typo.length) parts.push(group(TEXTY(c) ? 'Type & colour' : 'Colours', typo));

    // ---- outline and shadow
    if (c.type === 'text' || c.type === 'embroidery') {
      const edge = [
        h('div', { class: 'num2' },
          numIn('Outline width', x => x.props.outline || 0, (x, v) => updateElement(x, { outline: clamp(v, 0, 20) }), { min: 0, max: 20, step: 0.5, tip: '0 = no outline' }),
          colorIn('Outline colour', x => hexOr(x.props.outlineColor, '#ffffff'), (x, v) => updateElement(x, { outlineColor: v }), 'Colour of the outline')),
      ];
      parts.push(group('Outline', edge, !!p.outline));
    }
    const shadowRows = [
      check('Drop shadow', x => !!(x.props.shadow && x.props.shadow.on), (x, v) => setShadow(x, { on: v }), 'Add a shadow behind the item'),
      h('div', { class: 'num2' },
        colorIn('Shadow colour', x => hexOr(x.props.shadow?.color, '#000000'), (x, v) => setShadow(x, { color: v }), 'Shadow colour'),
        rangeIn('Shadow strength %', x => Math.round((x.props.shadow?.alpha ?? 0.45) * 100), (x, v) => setShadow(x, { alpha: v / 100 }), 0, 100, 'How dark the shadow is')),
      h('div', { class: 'num2' },
        numIn('Blur', x => x.props.shadow?.blur ?? 8, (x, v) => setShadow(x, { blur: clamp(v, 0, 80) }), { min: 0, max: 80, tip: 'Softness of the shadow (px on the 1024 canvas)' }),
        numIn('Shadow X', x => x.props.shadow?.x ?? 4, (x, v) => setShadow(x, { x: clamp(v, -120, 120) }), { min: -120, max: 120, tip: 'Shadow offset to the right (negative = left), px' })),
      numIn('Shadow Y', x => x.props.shadow?.y ?? 4, (x, v) => setShadow(x, { y: clamp(v, -120, 120) }), { min: -120, max: 120, tip: 'Shadow offset down (negative = up), px' }),
    ];
    parts.push(group('Shadow', shadowRows, !!(p.shadow && p.shadow.on)));

    // ---- position, size, appearance
    parts.push(group('Fine position & appearance', [
      h('div', { class: 'num2' },
        numIn('X', x => Math.round(x.x), (x, v) => { x.x = v; }, { tip: 'Left-right position on the canvas (0 = left edge, 1024 = right edge)' }),
        numIn('Y', x => Math.round(x.y), (x, v) => { x.y = v; }, { tip: 'Up-down position on the canvas (0 = top, 1024 = bottom)' })),
      rangeIn('Opacity %', x => Math.round((x.opacity ?? 1) * 100), (x, v) => { x.opacity = clamp(v, 0, 100) / 100; }, 0, 100, 'See-through amount'),
      h('div', { class: 'row gap' },
        check('Flip horizontally', x => !!x.flipX, (x, v) => { x.flipX = v; }, 'Mirror left to right'),
        check('Flip vertically', x => !!x.flipY, (x, v) => { x.flipY = v; }, 'Mirror top to bottom')),
    ]));

    // ---- layer and copies
    const others = VIEWS.filter(v => v !== c.view);
    parts.push(group('Copy & layers', [
      h('div', { class: 'btns' },
        btn(c.locked ? 'Unlock' : 'Lock', c.locked ? 'Allow moving and deleting' : 'Stop it being moved, resized or deleted', x => toggleLock(x)),
        btn(c.visible === false ? 'Show' : 'Hide', c.visible === false ? 'Show on the design' : 'Hide on the design', x => toggleVisible(x)),
        btn('Forward', 'Draw over the layer below', x => reorder(x, 'up')),
        btn('Backward', 'Draw under the layer above', x => reorder(x, 'down')),
        btn('Duplicate', 'Copy this element (Ctrl/Cmd+D)', x => duplicateElement(x)),
        btn('Delete', 'Remove this element (Delete key)', x => deleteElement(x), 'btn ghost sm danger')),
      h('div', { class: 'muted small' }, 'Duplicate to other views (same place and look):'),
      h('div', { class: 'copyrow' },
        others.map(v => btn('To ' + VIEW_LABELS[v], `Put a copy of this element on the ${VIEW_LABELS[v].toLowerCase()} view`, x => duplicateToViews(x, [v]))),
        others.length > 1 ? btn('To all other views', 'Put a copy on every other view', x => duplicateToViews(x, others)) : null),
      h('div', { class: 'btns' }, btn('Reset this item', 'Back to the default look for this type. Keeps its text, graphic and logo, and its position.', x => resetItem(x), 'btn ghost sm danger')),
    ], false));
    parts.push(h('div', { class: 'muted small' }, 'Drag on the canvas to move. Corner squares resize, the round handle rotates. Arrow keys nudge (Shift = 10 px).'));
    body.replaceChildren(...parts);
  }

  function sync(reason) {
    if (['render', 'zoom', 'processing', 'busy'].includes(reason)) return;
    const c = selectedElement();
    const visible = c && c.view === state.activeView ? c : null;
    if (!visible) { if (key !== null) { key = null; sig = null; closeGate(); } body.replaceChildren(empty); return; }
    const s = sigOf(visible);
    if (s !== sig || visible.id !== key) { key = visible.id; sig = s; closeGate(); build(visible); }
    binders.forEach(f => f(visible));
  }
  subscribe(sync); sync();
  return { el: body, sync };
}

/* ------------------------------------------------------------------ canvas hint (stage) */
export function stageHint() {
  const V = activeView();
  if (isSelTool(state.ui.tool)) return selToolHint(state.ui.tool);
  const el = selectedElement();
  if (el && el.view === state.activeView) return `${TYPE_LABEL[el.type] || 'Element'} selected: drag to move, corner squares to resize, round handle to rotate, arrow keys to nudge, Delete to remove.`;
  if (V.base) return 'Click a part of the garment (sleeve, collar, cuffs...) to colour it in the Colour section, or click a design element to edit it.';
  return '';
}
