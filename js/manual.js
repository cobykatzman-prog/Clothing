// Threadform - manual editing (owner: manual-editing worker).
// 1. Per-part garment colour: each garment region (sleeve, collar, cuffs...) gets its own target colour,
//    applied as a full-strength tint through fabric.applyColor so folds and shading survive.
// 2. Element inspector (right panel), layers list (left panel) and keyboard nudging for design elements.
// Every manual change goes through state.snapshot() so undo/redo covers it. Continuous controls (sliders,
// typing, arrow-key nudges) share one undo step via editGate(), so dragging stays smooth.
import { state, activeView, snapshot, notify, subscribe, markFlow } from './state.js';
import { h, icon } from './util.js';
import { REGION_NAMES } from './segment.js';
import { applyColor } from './fabric.js';
import { FONTS, GRAPHIC_LIBRARY, getGraphic, fitElement, updateElement } from './elements.js';
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

/* ------------------------------------------------------------------ part colour panel (right panel) */
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
.insp .field.inline{flex-direction:row;align-items:center}
.insp .num2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.insp .btns{display:flex;flex-wrap:wrap;gap:6px}
.insp .btns .btn{padding:5px 9px;font-size:12px}
.insp input:disabled,.insp textarea:disabled,.insp select:disabled{opacity:.5}
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
    const inp = h('input', { type: 'range', min, max, step: 1, value: 0, 'aria-label': label, tip,
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
/** Colour fields an element exposes in the inspector. */
export function colorSlots(el) {
  const p = el.props;
  if (el.type === 'stripe') return [{ key: 'color', label: 'Stripe colour' }, { key: 'color2', label: 'Second colour' }];
  if (el.type === 'piping') return [{ key: 'color', label: 'Piping colour' }];
  if (el.type === 'logo') return [];
  if (el.type === 'patch') {
    const s = [{ key: 'bg', label: 'Patch fill' }, { key: 'border', label: 'Edge colour' }];
    if (p.text != null && !p.graphicId) s.push({ key: 'textColor', label: 'Lettering' });
    return s;
  }
  if (p.graphicId) {
    const lib = getGraphic(p.graphicId);
    return [['color', 'Main colour', 'c1'], ['color2', 'Accent colour', 'c2'], ['color3', 'Detail colour', 'c3']]
      .map(([key, label, c]) => ({ key, label, fallback: lib?.colors?.[c] }));
  }
  if (TEXTY(el)) return [{ key: 'color', label: 'Colour' }];
  return [];
}
const slotHex = (el, s) => { const v = el.props[s.key] ?? s.fallback; return HEX.test(v || '') ? v.toLowerCase() : '#888888'; };
const sigOf = el => [el.id, el.locked, el.visible, el.type, el.props.graphicId, el.props.text != null, el.props.shape].join('|');

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
export function deleteElement(el) {
  if (!el || el.locked) return;
  change(() => { state.elements = state.elements.filter(x => x.id !== el.id); if (state.selectedId === el.id) state.selectedId = null; });
}
export function toggleLock(el) { if (el) change(() => { el.locked = !el.locked; }); }
export function toggleVisible(el) { if (el) change(() => { el.visible = el.visible === false; }); }
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
  subscribe(sync); sync();
  return { el: list, sync };
}

/* ------------------------------------------------------------------ element inspector (right panel) */
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
  const btn = (txt, tip, fn, cls = 'btn ghost sm') => h('button', { class: cls, tip, onclick: () => { const c = cur(); if (c) fn(c); } }, txt);

  function build(c) {
    binders = []; inputs = [];
    const p = c.props, parts = [], lib = getGraphic(p.graphicId);
    parts.push(h('div', { class: 'ptitle' }, (TYPE_LABEL[c.type] || c.type) + (lib ? ' · ' + lib.name : '')));
    if (TEXTY(c)) {
      parts.push(textIn('Text', x => x.props.text, (x, v) => updateElement(x, { text: v }), 'The words. Press Enter for a new line.', true));
      const font = bind(h('select', { 'aria-label': 'Font' }, FONTS.map(f => h('option', { value: f.value }, f.label))), x => x.props.font, (x, v) => updateElement(x, { font: v }));
      parts.push(row('Font', font, 'Typeface'));
      parts.push(h('div', { class: 'num2' },
        numIn('Size', x => Math.round(x.props.size), (x, v) => updateElement(x, { size: clamp(v, 4, 400) }), { min: 4, max: 400, tip: 'Text height (the whole canvas is 1024)' }),
        numIn('Letter spacing', x => x.props.letterSpacing || 0, (x, v) => updateElement(x, { letterSpacing: clamp(v, -20, 60) }), { min: -20, max: 60, tip: 'Space between letters' })));
      parts.push(h('div', { class: 'row gap' },
        check('Bold', x => x.props.weight >= 600, (x, v) => updateElement(x, { weight: v ? 700 : 400 }), 'Bold lettering'),
        check('Italic', x => !!x.props.italic, (x, v) => updateElement(x, { italic: v }), 'Italic lettering')));
      parts.push(rangeIn('Arch', x => x.props.curve || 0, (x, v) => updateElement(x, { curve: v }), -100, 100, 'Bend the text into an arch (right) or a smile (left). 0 = straight'));
    }
    if (c.type === 'stripe') {
      parts.push(numIn('Number of stripes', x => x.props.count || 1, (x, v) => updateElement(x, { count: clamp(Math.round(v), 1, 8) }), { min: 1, max: 8 }));
      parts.push(check('Alternate colours', x => !!x.props.alternate, (x, v) => updateElement(x, { alternate: v }), 'Use the second colour for every other stripe'));
    }
    if (c.type === 'piping') parts.push(rangeIn('Thickness', x => x.props.thickness || 8, (x, v) => updateElement(x, { thickness: clamp(v, 2, 40) }), 2, 40, 'How thick the piping is'));
    if (c.type === 'patch') {
      parts.push(row('Shape', bind(h('select', { 'aria-label': 'Patch shape' }, ['round', 'oval', 'shield', 'square'].map(s => h('option', { value: s }, s[0].toUpperCase() + s.slice(1)))), x => x.props.shape, (x, v) => updateElement(x, { shape: v })), 'Outline of the patch'));
      if (p.text != null && !p.graphicId) parts.push(textIn('Lettering', x => x.props.text, (x, v) => updateElement(x, { text: v.slice(0, 6) }), 'Up to 6 characters'));
    }
    if (c.type === 'crest' || c.type === 'graphic' || (c.type === 'patch' && p.graphicId)) {
      const cat = lib?.category || (c.type === 'crest' ? 'crest' : 'graphic');
      const opts = GRAPHIC_LIBRARY.filter(g => g.category === cat);
      if (opts.length) parts.push(row('Design', bind(h('select', { 'aria-label': 'Design' }, opts.map(g => h('option', { value: g.id }, g.name))), x => x.props.graphicId, (x, v) => updateElement(x, { graphicId: v })), 'Swap for another design from the same group'));
    }
    const slots = colorSlots(c);
    for (const s of slots) parts.push(colorIn(s.label, x => slotHex(x, s), (x, v) => updateElement(x, { [s.key]: v }), s.label + ' (click to pick)'));
    parts.push(h('div', { class: 'num2' },
      numIn('X', x => Math.round(x.x), (x, v) => { x.x = v; }, { tip: 'Left-right position on the canvas (0 = left edge, 1024 = right edge)' }),
      numIn('Y', x => Math.round(x.y), (x, v) => { x.y = v; }, { tip: 'Up-down position on the canvas (0 = top, 1024 = bottom)' })));
    parts.push(h('div', { class: 'num2' },
      numIn('Scale %', x => Math.round(scalePct(x)), (x, v) => setScalePct(x, v), { min: 2, max: 800, tip: '100 = the size it was added at' }),
      numIn('Rotation °', x => Math.round(x.rotation), (x, v) => { x.rotation = ((v % 360) + 360) % 360; }, { tip: 'Degrees (0 = upright)' })));
    parts.push(rangeIn('Opacity %', x => Math.round((x.opacity ?? 1) * 100), (x, v) => { x.opacity = clamp(v, 0, 100) / 100; }, 0, 100, 'See-through amount'));
    parts.push(h('div', { class: 'btns' },
      btn(c.locked ? 'Unlock' : 'Lock', c.locked ? 'Allow moving and deleting' : 'Stop it being moved, resized or deleted', x => toggleLock(x)),
      btn(c.visible === false ? 'Show' : 'Hide', c.visible === false ? 'Show on the design' : 'Hide on the design', x => toggleVisible(x)),
      btn('Forward', 'Draw over the layer below', x => reorder(x, 'up')),
      btn('Backward', 'Draw under the layer above', x => reorder(x, 'down')),
      btn('Duplicate', 'Copy this element (Ctrl/Cmd+D)', x => duplicateElement(x)),
      btn('Delete', 'Remove this element (Delete key)', x => deleteElement(x), 'btn ghost sm danger')));
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
  if (state.ui.tool === 'region') return 'Click a part of the garment to choose it for colouring. Click again to add it to the selection.';
  const el = selectedElement();
  if (el && el.view === state.activeView) return `${TYPE_LABEL[el.type] || 'Element'} selected: drag to move, corner squares to resize, round handle to rotate, arrow keys to nudge, Delete to remove.`;
  if (V.base) return 'Click a part of the garment (sleeve, collar, cuffs...) to colour it in the Colour section, or click a design element to edit it.';
  return '';
}
