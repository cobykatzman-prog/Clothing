// Look controls (owner: worker P): shape sliders with numeric inputs, fit/sleeve presets with an
// active-preset indicator, whole-garment colour, fabric + fabric tint, and per-view copy/reset.
// Every control writes through ui-actions (undoable, recomputed) and is redrawn from the active view.
import { state, activeView, subscribe, notify, snapshot, newColor, VIEWS, VIEW_LABELS } from './state.js';
import { h, toast } from './util.js';
import * as A from './ui-actions.js';
import { DEFAULT_PARAMS, FIT_PRESETS, SLEEVE_PRESETS } from './warp.js';
import { FABRICS } from './fabric.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pretty = s => s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const signed = v => (v > 0 ? '+' + v : v < 0 ? '−' + Math.abs(v) : '0');

/* ------------------------------------------------------------------ styles (injected once) */
let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  document.head.append(h('style', {}, `
    .lk-head{display:flex;align-items:center;gap:6px;min-width:0}
    .lk-head .lbl{flex:1;min-width:0}
    .num-in{width:68px;font:inherit;font-size:12px;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);text-align:right;font-variant-numeric:tabular-nums;flex:none}
    .lk-reset{border:1px solid var(--line);background:#fff;border-radius:6px;padding:2px 7px;font-size:12px;line-height:1.2;cursor:pointer;color:var(--muted);flex:none}
    .lk-reset:hover:not(:disabled){border-color:#c9c6f5;color:var(--ink)}
    .lk-reset:disabled{opacity:.45;cursor:default}
    .lk-hint{font-size:11px;color:var(--muted);display:flex;justify-content:space-between;gap:6px}
    .lk-status{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
    .lk-status .row{align-items:center;gap:8px;flex-wrap:wrap}
    .lk-status b{color:var(--ink);font-weight:600}
    .lk-note{font-size:11.5px;color:var(--muted)}
    .lk-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px}
    .lk-tools details{position:relative}
    .lk-tools summary{list-style:none;cursor:pointer;border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 11px;font-weight:600;color:var(--ink)}
    .lk-tools summary::-webkit-details-marker{display:none}
    .lk-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:20;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.14);padding:10px;display:flex;flex-direction:column;gap:6px;min-width:190px}
    .lk-pop label{display:flex;align-items:center;gap:8px;cursor:pointer}
    .lk-pop label[aria-disabled="true"]{opacity:.45;cursor:default}
    .lk-pop .btn{align-self:flex-start}
    @media (max-width:560px){ .num-in{width:60px} }
  `));
}

/* ------------------------------------------------------------------ generic numeric control */
// A range slider and a typed number kept in step, plus a reset button. Both write through `set`.
function control({ label, tip, min, max, hint, get, set, reset, resetTip = 'Reset to 0' }) {
  let rng, num, rb;
  const commitTyped = v => { v = clamp(Math.round(v), min, max); rng.value = v; set(v); };
  rng = h('input', { type: 'range', min, max, step: 1, value: 0, 'aria-label': label,
    oninput: e => { num.value = e.target.value; set(+e.target.value); },
    onchange: A.endEdit,
    ondblclick: () => { A.beginEdit(); set(reset ? reset.value : 0); A.endEdit(); } });
  num = h('input', { type: 'number', class: 'num-in', min, max, step: 1, value: 0, inputmode: 'numeric', 'aria-label': label + ' value', tip: `Type a value from ${min} to ${max}`,
    oninput: e => { if (e.target.value === '' || e.target.value === '-' || e.target.value === '.') return; const v = Number(e.target.value); if (isFinite(v)) commitTyped(v); },
    onchange: e => { if (e.target.value === '' || !isFinite(Number(e.target.value))) { e.target.value = String(get()); } else commitTyped(Number(e.target.value)); A.endEdit(); } });
  rb = h('button', { class: 'lk-reset', type: 'button', tip: resetTip, 'aria-label': 'Reset ' + label, onclick: () => { A.beginEdit(); set(reset ? reset.value : 0); A.endEdit(); } }, '↺ Reset');
  const head = h('div', { class: 'lk-head' }, h('span', { class: 'lbl' }, label), num, rb);
  const el = h('div', { class: 'slider', tip }, head, rng, hint ? h('div', { class: 'lk-hint' }, h('span', {}, hint[0]), h('span', {}, hint[1]), h('span', {}, hint[2])) : null);
  return {
    el,
    sync(V) {
      const v = clamp(Math.round(get(V)), min, max);
      if (document.activeElement !== rng) rng.value = v;
      if (document.activeElement !== num) num.value = v;
    },
  };
}

/* ------------------------------------------------------------------ shape */
// tip explains the direction and the range in plain words; hint is the scale printed under the slider.
export const SHAPE = [
  { k: 'bodyWidth', label: 'Body width', hint: ['− narrower', '0 original', '+ wider'], tip: 'How wide the torso is across the chest and waist. Range −100 to +100; 0 keeps the original width.' },
  { k: 'bodyLength', label: 'Body length', hint: ['− shorter', '0 original', '+ longer'], tip: 'How long the garment is from the shoulders to the hem. Range −100 to +100; 0 keeps the original length.' },
  { k: 'shoulderWidth', label: 'Shoulder width', hint: ['− fitted', '0 original', '+ dropped'], tip: 'Moves the shoulder seams in (fitted) or out (dropped shoulder). Range −100 to +100; 0 keeps the original.' },
  { k: 'sleeveLength', label: 'Sleeve length', hint: ['− shorter', '0 original', '+ longer'], tip: 'How far the sleeves reach down the arm. Range −100 to +100; 0 keeps the original length.' },
  { k: 'sleeveWidth', label: 'Sleeve width', hint: ['− slimmer', '0 original', '+ fuller'], tip: 'How wide the sleeve is around the arm. Range −100 to +100; 0 keeps the original width.' },
  { k: 'sleeveFlare', label: 'Sleeve flare', hint: ['− tapered', '0 original', '+ flared'], tip: 'Narrows (tapered) or widens (flared) the sleeve toward the cuff. Range −100 to +100; 0 keeps the original.' },
  { k: 'sleeveShape', label: 'Sleeve curve', hint: ['− straighter', '0 original', '+ more curve'], tip: 'How much the sleeve bends along its length. Range −100 to +100; 0 keeps the original.' },
  { k: 'collarSize', label: 'Collar size', hint: ['− smaller', '0 original', '+ larger'], tip: 'Makes the collar band smaller or larger. Range −100 to +100; 0 keeps the original.' },
  { k: 'neckOpening', label: 'Neck opening', hint: ['− closer', '0 original', '+ wider'], tip: 'Makes the neck hole narrower or wider. Range −100 to +100; 0 keeps the original.' },
  { k: 'hemShape', label: 'Hem curve', hint: ['− dips', '0 straight', '+ lifts'], tip: 'Curves the hem: positive lifts the side corners (curved shirt-tail), negative lets them drop. Range −100 to +100; 0 is a straight hem.' },
  { k: 'cropLength', label: 'Crop length', hint: ['− longer', '0 original', '+ cropped'], tip: 'Cuts the bottom of the garment shorter (cropped). Range −100 to +100; 0 keeps the original length.' },
];
const SHAPE_LABEL = Object.fromEntries(SHAPE.map(s => [s.k, s.label]));

export function shapeBlock() {
  injectStyles();
  const ctls = SHAPE.map(s => control({
    label: s.label, tip: s.tip + ' Double-click the slider to reset it.', hint: s.hint, min: -100, max: 100,
    get: V => (V || activeView()).params[s.k] || 0,
    set: v => A.setParam(s.k, v),
  }));
  const resetAll = h('button', { class: 'btn ghost sm', tip: 'Set every shape slider back to 0 (original). Undo brings them back.', onclick: () => { A.beginEdit(); A.resetParams(); A.endEdit(); } }, 'Reset shape');
  const el = h('div', { class: 'stack-col' }, ...ctls.map(c => c.el), resetAll);
  return {
    el,
    sync(V) { ctls.forEach(c => c.sync(V)); resetAll.disabled = !V.base; },
  };
}

/* ------------------------------------------------------------------ fit & sleeve presets */
const describePreset = p => {
  const parts = Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${SHAPE_LABEL[k]} ${signed(v)}`);
  return parts.length ? parts.join(' · ') : 'All shape sliders at 0 (original)';
};
// a preset counts as "adjusted" once one of the sliders it sets has been moved away from its value
const presetState = (V, kind) => {
  const name = V.presets?.[kind]; if (!name) return null;
  const table = kind === 'fit' ? FIT_PRESETS : SLEEVE_PRESETS, p = table[name] || {};
  const adjusted = Object.keys(p).some(k => (V.params[k] || 0) !== (p[k] || 0));
  return { name, p, adjusted, label: pretty(name) };
};

/** Clear: sets the sliders this preset changed back to 0 and forgets the preset. Other sliders keep their values. */
export function clearPreset(kind) {
  const V = activeView(); const st = presetState(V, kind); if (!st) return;
  snapshot();
  const params = { ...V.params };
  for (const k of Object.keys(st.p)) params[k] = 0;
  V.params = params; V.presets = { ...(V.presets || {}), [kind]: null };
  notify('params'); A.recompute();
}

export function presetBlock() {
  injectStyles();
  const fitChips = Object.keys(FIT_PRESETS).map(n => h('button', { class: 'chip', type: 'button', 'data-preset': 'fit:' + n, tip: `${pretty(n)} fit: ${describePreset(FIT_PRESETS[n])}. You can still move any slider afterwards.`, onclick: () => A.applyFit(n) }, pretty(n)));
  const slvChips = Object.keys(SLEEVE_PRESETS).map(n => h('button', { class: 'chip', type: 'button', 'data-preset': 'sleeve:' + n, tip: `${pretty(n)} sleeves: ${describePreset(SLEEVE_PRESETS[n])}. You can still move any slider afterwards.`, onclick: () => A.applySleeve(n) }, pretty(n)));
  const status = { fit: h('b', {}, 'None'), sleeve: h('b', {}, 'None') };
  const clearBtn = { fit: h('button', { class: 'btn ghost sm', type: 'button', tip: 'Set the fit preset’s sliders back to 0. Your other slider values stay.', onclick: () => clearPreset('fit') }, 'Clear fit preset'),
    sleeve: h('button', { class: 'btn ghost sm', type: 'button', tip: 'Set the sleeve preset’s sliders back to 0. Your other slider values stay.', onclick: () => clearPreset('sleeve') }, 'Clear sleeve preset') };
  const line = kind => h('div', { class: 'row' }, h('span', {}, (kind === 'fit' ? 'Fit: ' : 'Sleeves: '), status[kind]), clearBtn[kind]);
  const el = h('div', { class: 'stack-col' },
    h('div', { class: 'lbl' }, 'Fit'), h('div', { class: 'chips' }, fitChips),
    h('div', { class: 'lbl' }, 'Sleeves'), h('div', { class: 'chips' }, slvChips),
    h('div', { class: 'lk-status', 'aria-live': 'polite' }, line('fit'), line('sleeve')),
    h('div', { class: 'lk-note' }, 'A preset is a starting point. You can move any slider afterwards; the preset then shows as adjusted.'));
  const chipsAll = [...fitChips, ...slvChips];
  return {
    el,
    sync(V) {
      for (const c of chipsAll) {
        const [kind, name] = c.dataset.preset.split(':');
        c.classList.toggle('on', V.presets?.[kind] === name);
      }
      for (const kind of ['fit', 'sleeve']) {
        const st = presetState(V, kind);
        status[kind].textContent = st ? st.label + (st.adjusted ? ' (adjusted)' : '') : 'None';
        clearBtn[kind].disabled = !st;
      }
    },
  };
}

/* ------------------------------------------------------------------ whole-garment colour */
export function wholeColourBlock() {
  injectStyles();
  let tintInput;
  const ctls = [
    control({ label: 'Hue', tip: 'Turns every colour around the colour wheel. Range −180 to +180; 0 keeps the colours.', hint: ['−180', '0 original', '+180'], min: -180, max: 180,
      get: V => V.color.hue || 0, set: v => A.setColor({ hue: v }) }),
    control({ label: 'Saturation', tip: 'How vivid the colours are. Range −100 (muted, grey) to +100 (vivid); 0 keeps the original.', hint: ['− muted', '0 original', '+ vivid'], min: -100, max: 100,
      get: V => V.color.sat || 0, set: v => A.setColor({ sat: v }) }),
    control({ label: 'Lightness', tip: 'How light or dark the garment is. Range −100 (darker) to +100 (lighter); 0 keeps the original.', hint: ['− darker', '0 original', '+ lighter'], min: -100, max: 100,
      get: V => V.color.light || 0, set: v => A.setColor({ light: v }) }),
  ];
  tintInput = h('input', { type: 'color', value: '#c0392b', 'aria-label': 'Tint colour', tip: 'Pick a colour to blend over the whole garment',
    oninput: e => { const V = activeView(); A.setColor({ tint: e.target.value, tintAmount: Math.max(V.color.tintAmount || 0, 0.5) }); }, onchange: A.endEdit });
  const tintCtl = control({ label: 'Tint strength', tip: 'How much the tint colour covers the garment. 0 = no tint, 100 = fully that colour. Pick a tint colour first.', hint: ['0 none', '50', '100 full'], min: 0, max: 100, resetTip: 'Remove the tint',
    get: V => Math.round((V.color.tintAmount || 0) * (V.color.tint ? 1 : 0) * 100),
    set: v => A.setColor({ tint: activeView().color.tint || tintInput.value, tintAmount: v / 100 }),
    reset: { value: 0 } });
  const reset = h('button', { class: 'btn ghost sm', type: 'button', tip: 'Set hue, saturation, lightness and tint back to the original colours. Undo brings them back.',
    onclick: () => { A.beginEdit(); const V = activeView(); V.color = newColor(); A.endEdit(); notify('color'); A.recompute(); } }, 'Reset whole garment');
  const el = h('details', { class: 'subdet', open: true },
    h('summary', { class: 'lbl', tip: 'Colour every part of the garment at once. Parts you colour separately keep their own colour.' }, 'Whole garment'),
    h('div', { class: 'stack-col' }, ...ctls.map(c => c.el),
      h('div', { class: 'row gap center' }, h('label', { class: 'field', tip: 'Pick a colour to blend over the garment' }, h('span', { class: 'lbl' }, 'Tint'), tintInput), h('div', { class: 'grow' }, tintCtl.el)),
      reset));
  return {
    el,
    sync(V) {
      ctls.forEach(c => c.sync(V));
      if (V.color.tint && document.activeElement !== tintInput) tintInput.value = V.color.tint;
      tintCtl.sync(V);
      reset.disabled = !V.base;
    },
  };
}

/* ------------------------------------------------------------------ fabric */
export function fabricBlock() {
  injectStyles();
  const fabBtns = ['none', ...FABRICS].map(n => h('button', { class: 'chip', type: 'button', 'data-f': n, tip: n === 'none' ? 'No fabric texture: keep the original look' : `${pretty(n)} texture`,
    onclick: () => { A.beginEdit(); A.setFabric(n === 'none' ? null : n); A.endEdit(); } }, n === 'none' ? 'None (original)' : pretty(n)));
  const strength = control({ label: 'Strength', tip: 'How strongly the fabric texture shows. 0 = no texture, 100 = full texture. Choose a fabric first.', hint: ['0 none', '60 default', '100 full'], min: 0, max: 100, resetTip: 'Back to the default strength (60)',
    get: V => Math.round(V.fabric.amount * 100), set: v => A.setFabric(activeView().fabric.name, v / 100), reset: { value: 60 } });
  // fabric tint: a colour blended into the fabric texture (separate from the whole-garment tint above)
  const tintInput = h('input', { type: 'color', value: '#8a6d3b', 'aria-label': 'Fabric tint colour', tip: 'Pick a colour to tint the fabric texture',
    oninput: e => { const V = activeView(); A.setFabricTint({ tint: e.target.value, tintAmount: Math.max(V.fabric.tintAmount || 0, 0.5) }); }, onchange: A.endEdit });
  const tintCtl = control({ label: 'Fabric tint strength', tip: 'How much the fabric tint colour shows. 0 = no tint, 100 = fully that colour. Pick a tint colour first.', hint: ['0 none', '50', '100 full'], min: 0, max: 100, resetTip: 'Remove the fabric tint',
    get: V => Math.round((V.fabric.tintAmount || 0) * (V.fabric.tint ? 1 : 0) * 100),
    set: v => A.setFabricTint({ tint: activeView().fabric.tint || tintInput.value, tintAmount: v / 100 }), reset: { value: 0 } });
  const el = h('div', { class: 'stack-col' },
    h('div', { class: 'chips' }, fabBtns),
    strength.el,
    h('div', { class: 'lbl', tip: 'Tints the fabric texture only. Use Whole garment colour above to change the colour of the whole garment.' }, 'Fabric tint'),
    h('div', { class: 'row gap center' }, h('label', { class: 'field', tip: 'Pick a colour to tint the fabric texture' }, h('span', { class: 'lbl' }, 'Colour'), tintInput), h('div', { class: 'grow' }, tintCtl.el)));
  return {
    el,
    sync(V) {
      fabBtns.forEach(b => b.classList.toggle('on', (V.fabric.name || 'none') === b.dataset.f));
      strength.sync(V); tintCtl.sync(V);
      if (V.fabric.tint && document.activeElement !== tintInput) tintInput.value = V.fabric.tint;
      const on = !!V.fabric.name && V.fabric.name !== 'none';
      strength.el.querySelectorAll('input,button').forEach(b => { b.disabled = !V.base || !on; });
      fabBtns.forEach(b => { b.disabled = !V.base; });
    },
  };
}

/* ------------------------------------------------------------------ per-view tools */
// Copy the look (shape, presets, whole-garment colour, fabric and fabric tint) to other views, and reset this view.
export function copyLook(targets) {
  const from = state.activeView, src = activeView();
  const ok = targets.filter(n => n !== from && state.views[n].base);
  if (!ok.length) { toast('Choose a view that already has a garment in it.', 'info'); return false; }
  snapshot();
  for (const n of ok) {
    const V = state.views[n];
    V.params = { ...src.params }; V.color = { ...src.color }; V.fabric = { ...src.fabric };
    V.presets = { ...(src.presets || { fit: null, sleeve: null }) };
  }
  notify('params');
  for (const n of ok) A.recompute(n);
  toast(`Copied the look to ${ok.map(n => VIEW_LABELS[n]).join(' and ')}. Each view can still be changed on its own. Undo reverts it.`, 'ok', 4500);
  return true;
}

export function resetView() {
  const V = activeView(); if (!V.base) return;
  snapshot();
  V.params = { ...DEFAULT_PARAMS }; V.color = newColor();
  V.fabric = { name: null, amount: 0.6, tint: null, tintAmount: 0.5 };
  V.presets = { fit: null, sleeve: null }; V.parts = {};
  notify('params'); A.recompute();
  toast(`${VIEW_LABELS[state.activeView]} view reset to its base. Undo brings the look back.`, 'ok', 4000);
}

export function viewTools() {
  injectStyles();
  const copyChecks = {};
  const checkRows = VIEWS.map(n => {
    const cb = h('input', { type: 'checkbox', value: n, 'aria-label': 'Copy to ' + VIEW_LABELS[n] });
    copyChecks[n] = cb;
    return h('label', { 'aria-disabled': 'false', tip: 'Copy the look to this view' }, cb, VIEW_LABELS[n]);
  });
  const doCopy = h('button', { class: 'btn primary sm', type: 'button', tip: 'Copy the current view’s shape, colour and fabric to the ticked views',
    onclick: () => { const picked = VIEWS.filter(n => copyChecks[n].checked); if (!picked.length) { toast('Tick at least one view to copy to.', 'info'); return; } if (copyLook(picked)) { VIEWS.forEach(n => { copyChecks[n].checked = false; }); det.open = false; } } }, 'Copy look');
  const pop = h('div', { class: 'lk-pop' }, h('span', { class: 'lbl' }, 'Copy this view’s look to:'), ...checkRows, doCopy);
  const det = h('details', { tip: 'Copy this view’s shape, colour and fabric to other views' }, h('summary', {}, 'Copy look to…'), pop);
  const reset = h('button', { class: 'btn ghost sm', type: 'button', tip: 'Set this view’s shape, colour, fabric and per-part colours back to its base. Undo brings them back.', onclick: resetView }, 'Reset this view');
  const el = h('div', { class: 'lk-tools' }, det, reset);
  const sync = () => {
    VIEWS.forEach(n => {
      const cb = copyChecks[n], row = cb.closest('label'), has = !!state.views[n].base, isHere = n === state.activeView;
      cb.disabled = !has || isHere; row.setAttribute('aria-disabled', String(!has || isHere));
      row.dataset.tip = isHere ? 'This view' : has ? 'Copy the look to this view' : 'This view has no garment yet';
      if (cb.disabled) cb.checked = false;
    });
    doCopy.disabled = !VIEWS.some(n => copyChecks[n].checked);
    reset.disabled = !state.views[state.activeView].base;
  };
  subscribe(r => { if (!['render', 'processing', 'busy', 'zoom', 'elements-live'].includes(r)) sync(); });
  pop.addEventListener('change', () => { doCopy.disabled = !VIEWS.some(n => copyChecks[n].checked); });
  sync();
  return el;
}
