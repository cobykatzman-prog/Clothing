// Right panel: describe + variations, fit/sleeve presets, shape sliders, colour, fabric.
import { state, activeView, subscribe, notify, markFlow, hasMask } from './state.js';
import { h, icon, thumbOf } from './util.js';
import * as A from './ui-actions.js';
import { section, field } from './ui-left.js';
import { FABRICS } from './fabric.js';
import { createPartPanel, createInspector } from './manual.js';

const pretty = s => s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const SLIDERS = [
  ['bodyWidth', 'Body width', 'Narrower or wider through the chest and torso'],
  ['bodyLength', 'Body length', 'Shorter or longer overall'],
  ['shoulderWidth', 'Shoulder width', 'Pull shoulder seams in or out (drop shoulder)'],
  ['sleeveLength', 'Sleeve length', 'Short to long sleeves'],
  ['sleeveWidth', 'Sleeve width', 'Slim to wide sleeves'],
  ['sleeveFlare', 'Sleeve flare', 'Widen the sleeve opening like a bell'],
  ['sleeveShape', 'Sleeve taper', 'Negative tapers toward the cuff, positive balloons it'],
  ['collarSize', 'Collar size', 'Smaller or larger collar'],
  ['neckOpening', 'Neck opening', 'Smaller or wider neckline'],
  ['hemShape', 'Hem curve', 'Straight hem to curved shirt-tail hem'],
  ['cropLength', 'Crop length', 'Cut the garment shorter at the hem'],
];
const EXAMPLES = ['make the sleeves flared', 'boxy oversized fit', 'remove the cuffs', 'cropped hem', 'heavyweight cotton', 'red piping on the collar', 'vintage Greek island style'];

export function engineLabel() {
  const e = state.engine;
  const aiName = /gpt|image/i.test(e.provider || '') ? e.provider : 'gpt-image-1';
  if (e.used === 'ai') return { txt: `AI (${aiName})`, cls: 'ai' };
  if (e.used === 'mixed') return { txt: 'AI + local fallback', cls: 'ai' };
  if (e.used === 'local') return { txt: 'Local engine (offline)', cls: 'local' };
  return e.available ? { txt: `AI (${aiName})`, cls: 'ai' } : { txt: 'Local engine (offline)', cls: 'local' };
}
export function engineBadge() {
  const b = h('span', { class: 'badge', tip: 'AI = server-side image model. Local engine = free in-browser edits that run offline. The local engine is used automatically when AI is not configured.' });
  const upd = () => { const l = engineLabel(); b.className = 'badge ' + l.cls; b.replaceChildren(h('i', { class: 'dot' }), l.txt); };
  subscribe(r => { if (r === 'engine' || r === 'variations') upd(); }); upd();
  return b;
}

export function initRight(root) {
  const S = state;
  // ---- Describe ----
  const prompt = h('textarea', { rows: 3, id: 'prompt', placeholder: 'e.g. make the sleeves flared and remove the cuffs', 'aria-label': 'Describe your changes', oninput: e => { S.ui.prompt = e.target.value; if (e.target.value.trim()) markFlow('described'); } });
  const genBtn = h('button', { class: 'btn primary block', id: 'btn-variations', onclick: () => A.generateVariations(prompt.value) }, icon('sparkles', 16), 'Generate variations');
  const examples = h('div', { class: 'chips small' }, EXAMPLES.map(t => h('button', { class: 'chip', onclick: () => { prompt.value = t; S.ui.prompt = t; markFlow('described'); prompt.focus(); } }, t)));
  const cards = h('div', { class: 'cards', id: 'variation-cards' });
  const keepNote = h('div', { class: 'muted small', id: 'mask-note' });
  const secDescribe = section(1, 'Describe your changes', 'Say what you want in plain words. You will get three options: Subtle, Medium and Bold. Pick one to apply it.', [
    prompt, examples, keepNote, genBtn, h('div', { class: 'row between center engine-row' }, h('span', { class: 'muted small' }, 'Engine'), engineBadge()), cards,
  ], true, 'sec-describe');

  // ---- Fit / sleeve presets ----
  const fitBtns = Object.keys(A.FIT_PRESETS).map(n => h('button', { class: 'chip', onclick: () => A.applyFit(n) }, pretty(n)));
  const slvBtns = Object.keys(A.SLEEVE_PRESETS).map(n => h('button', { class: 'chip', onclick: () => A.applySleeve(n) }, pretty(n)));
  const secPresets = section(2, 'Fit & sleeve presets', 'One-click starting points. You can fine-tune with the sliders afterwards.', [
    h('div', { class: 'lbl' }, 'Fit'), h('div', { class: 'chips' }, fitBtns),
    h('div', { class: 'lbl' }, 'Sleeves'), h('div', { class: 'chips' }, slvBtns),
  ], true, 'sec-presets');

  // ---- Shape sliders ----
  const sliderEls = {};
  const rows = SLIDERS.map(([k, label, tip]) => {
    const val = h('output', { class: 'val' }, '0');
    const inp = h('input', { type: 'range', min: -100, max: 100, step: 1, value: 0, 'aria-label': label,
      oninput: e => { val.textContent = e.target.value; A.setParam(k, +e.target.value); }, onchange: A.endEdit,
      ondblclick: e => { e.target.value = 0; val.textContent = '0'; A.setParam(k, 0); A.endEdit(); } });
    sliderEls[k] = { inp, val };
    return h('div', { class: 'slider', tip: tip + ' (double-click to reset)' }, h('div', { class: 'row between' }, h('span', { class: 'lbl' }, label), val), inp);
  });
  const secShape = section(3, 'Shape', 'These sliders reshape the garment from the original image, so you can always go back to 0.', [
    ...rows, h('button', { class: 'btn ghost sm', onclick: A.resetParams }, 'Reset shape')], true, 'sec-shape');

  // ---- Colour ----
  const cEls = {};
  const mk = (key, label, min, max, tip) => {
    const val = h('output', { class: 'val' }, '0');
    const inp = h('input', { type: 'range', min, max, value: 0, 'aria-label': label, oninput: e => { val.textContent = e.target.value; A.setColor({ [key]: +e.target.value }); }, onchange: A.endEdit });
    cEls[key] = { inp, val };
    return h('div', { class: 'slider', tip }, h('div', { class: 'row between' }, h('span', { class: 'lbl' }, label), val), inp);
  };
  const tint = h('input', { type: 'color', value: '#c0392b', 'aria-label': 'Tint colour', oninput: e => { A.setColor({ tint: e.target.value, tintAmount: Math.max(S.views[S.activeView].color.tintAmount, 0.5) }); amtSync(); }, onchange: A.endEdit });
  const tintAmt = h('input', { type: 'range', min: 0, max: 100, value: 0, 'aria-label': 'Tint strength', oninput: e => { A.setColor({ tint: S.views[S.activeView].color.tint || tint.value, tintAmount: e.target.value / 100 }); }, onchange: A.endEdit });
  const amtSync = () => { tintAmt.value = Math.round(activeView().color.tintAmount * 100); };
  // per-part colour (sleeves, collar, cuffs...) from manual.js
  const partPanel = createPartPanel();
  const wholeBody = h('details', { class: 'subdet', open: true },
    h('summary', { class: 'lbl', tip: 'Colour every part of the garment at once. Parts you colour separately keep their own colour.' }, 'Whole garment'),
    mk('hue', 'Hue', -180, 180, 'Rotate the colour around the colour wheel'), mk('sat', 'Saturation', -100, 100, 'Muted to vivid'), mk('light', 'Lightness', -100, 100, 'Darker to lighter'),
    h('div', { class: 'row gap center' }, field('Tint', tint, 'Pick a colour to blend over the garment'), h('div', { class: 'grow' }, tintAmt)),
    h('button', { class: 'btn ghost sm', onclick: () => { A.beginEdit(); const V = activeView(); V.color = { hue: 0, sat: 0, light: 0, tint: null, tintAmount: 0.5 }; A.endEdit(); notify('color'); A.recompute(); } }, 'Reset whole garment'));
  const secColor = section(4, 'Colour', 'Click a part of the garment on the canvas, or pick it below, then choose its colour. Folds and shading are kept.', [
    h('div', { class: 'lbl', tip: 'Garment parts. The swatch shows the colour the part has now.' }, 'Parts'),
    partPanel.el,
    wholeBody,
  ], true, 'sec-color');
  // selected design element (text, crest, stripes...): colour, size, position, layer order
  const inspector = createInspector();
  const secInspector = section('•', 'Selected item', 'Edit the design element you selected on the canvas or in Layers.', inspector.el, true, 'sec-inspector');

  // ---- Fabric ----
  const fabBtns = ['none', ...FABRICS].map(n => h('button', { class: 'chip', 'data-f': n, onclick: () => { A.beginEdit(); A.setFabric(n === 'none' ? null : n); A.endEdit(); } }, n === 'none' ? 'Original' : pretty(n)));
  const fabAmt = h('input', { type: 'range', min: 0, max: 100, value: 60, 'aria-label': 'Fabric strength', oninput: e => A.setFabric(activeView().fabric.name, e.target.value / 100), onchange: A.endEdit });
  const secFabric = section(5, 'Fabric', 'Applies a procedural weave and shading while keeping the original folds and shadows.', [
    h('div', { class: 'chips' }, fabBtns), field('Strength', fabAmt)], false, 'sec-fabric');

  root.append(secInspector, secDescribe, secPresets, secShape, secColor, secFabric);

  function renderCards() {
    const v = S.variations;
    if (!v) { cards.replaceChildren(h('div', { class: 'muted small empty-cards' }, 'Your three options will appear here.')); return; }
    cards.replaceChildren(...v.map((o, i) => {
      const th = thumbOf(o.canvas, 200, '#f3f2ef');
      const applied = S.applied && S.applied.index === i;
      return h('div', { class: 'vcard' + (applied ? ' applied' : '') },
        h('div', { class: 'vthumb' }, th, h('span', { class: 'vsrc ' + o.source }, o.source === 'ai' ? 'AI' : 'Local')),
        h('div', { class: 'vmeta' }, h('b', {}, o.label), h('span', { class: 'muted small' }, ['Gentle', 'Balanced', 'Dramatic'][i])),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn primary sm', onclick: () => A.acceptVariation(i) }, applied ? icon('check', 14) : null, applied ? 'Applied' : 'Use this'),
          h('button', { class: 'btn ghost sm', disabled: !S.applied, tip: S.applied ? 'Apply this option on top of the one you picked' : 'Pick an option first, then add another on top', onclick: () => A.combineVariation(i) }, 'Combine')));
    }));
  }
  function sync(reason) {
    const V = activeView();
    partPanel.sync();
    for (const [k, { inp, val }] of Object.entries(sliderEls)) { const v = V.params[k] || 0; if (+inp.value !== v) inp.value = v; val.textContent = Math.round(v); }
    for (const [k, { inp, val }] of Object.entries(cEls)) { const v = V.color[k] || 0; if (+inp.value !== v) inp.value = v; val.textContent = Math.round(v); }
    if (V.color.tint) tint.value = V.color.tint; amtSync();
    fabBtns.forEach(b => b.classList.toggle('on', (V.fabric.name || 'none') === b.dataset.f));
    fabAmt.value = Math.round(V.fabric.amount * 100);
    if (document.activeElement !== prompt && prompt.value !== S.ui.prompt) prompt.value = S.ui.prompt;
    const has = !!V.base;
    [genBtn, ...root.querySelectorAll('.chip, .slider input')].forEach(b => { b.disabled = !has; });
    const sel = hasMask(V);
    keepNote.textContent = sel ? 'Only your selected area will change. Everything else is kept exactly. To make a part bigger, use Grow so there is room.' : 'No area selected: the change applies to the whole garment. Optional: select an area on the left to limit it.';
    if (!reason || ['variations', 'applied', 'restore', 'loaded', 'history'].includes(reason)) renderCards();
  }
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live'].includes(r)) sync(r); });
  sync();
}
