// Right panel: describe + variations, fit/sleeve presets, shape sliders, colour, fabric.
import { state, activeView, subscribe, notify, markFlow, hasMask } from './state.js';
import { h, icon, thumbOf } from './util.js';
import * as A from './ui-actions.js';
import { section } from './ui-left.js';
import { createPartPanel, createInspector } from './manual.js';
import { presetBlock, shapeBlock, wholeColourBlock, fabricBlock } from './ui-look.js';
import { measureSection } from './ui-measure.js';

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
  const genBtn = h('button', { class: 'btn primary block', id: 'btn-variations', onclick: () => A.generateVariations(prompt.value) }, icon('sparkles', 16), 'Create 3 options');
  const examples = h('div', { class: 'chips small' }, EXAMPLES.map(t => h('button', { class: 'chip', onclick: () => { prompt.value = t; S.ui.prompt = t; markFlow('described'); prompt.focus(); } }, t)));
  const cards = h('div', { class: 'cards', id: 'variation-cards' });
  const keepNote = h('div', { class: 'muted small', id: 'mask-note' });
  const secDescribe = section(1, 'Describe your changes', 'Say what you want in plain words. You will get three options: Subtle, Medium and Bold. Pick one to apply it.', [
    prompt, examples, keepNote, genBtn, h('div', { class: 'row between center engine-row' }, h('span', { class: 'muted small' }, 'Engine'), engineBadge()), cards,
  ], true, 'sec-describe');

  // ---- Fit / sleeve presets (ui-look.js: one-click presets, active-preset status, clear) ----
  const presets = presetBlock();
  const secPresets = section(2, 'Fit & sleeve presets', 'One-click starting points. Afterwards you can move any slider; the preset then shows as adjusted.', [presets.el], true, 'sec-presets');

  // ---- Shape sliders (ui-look.js: slider + typed value + reset per control) ----
  const shape = shapeBlock();
  const secShape = section(3, 'Shape', 'Reshape the garment from the original image. Every control has a typed value and a reset; 0 is always the original.', [shape.el], true, 'sec-shape');

  // ---- Colour ----
  // whole-garment hue / saturation / lightness / tint (ui-look.js); per-part colour stays in manual.js
  const whole = wholeColourBlock();
  // per-part colour (sleeves, collar, cuffs...) from manual.js
  const partPanel = createPartPanel();
  const secColor = section(4, 'Colour', 'Click a part of the garment on the canvas, or pick it below, then choose its colour. Folds and shading are kept.', [
    h('div', { class: 'lbl', tip: 'Garment parts. The swatch shows the colour the part has now.' }, 'Parts'),
    partPanel.el,
    whole.el,
  ], true, 'sec-color');
  // selected design element (text, crest, stripes...): colour, size, position, layer order
  const inspector = createInspector();
  const secInspector = section('•', 'Selected item', 'Edit the design element you selected on the canvas or in Layers.', inspector.el, true, 'sec-inspector');

  // ---- Fabric ----
  // fabric list, strength 0-100, "None", fabric tint strength (ui-look.js)
  const fab = fabricBlock();
  const secFabric = section(5, 'Fabric', 'Applies a procedural weave and shading while keeping the original folds and shadows.', [fab.el], false, 'sec-fabric');

  const secMeasure = measureSection().sec;   // approximate garment measurements (ui-measure.js)
  root.append(secInspector, secDescribe, secPresets, secShape, secMeasure, secColor, secFabric);

  const sumOf = (o, i) => (o.ops && o.ops.summary) || ['A small change to what you asked for', 'The change exactly as you described it', 'A stronger version of your change'][i] || '';
  const shorten = t => (t.length > 60 ? t.slice(0, 58).trimEnd() + '…' : t);
  function renderCards() {
    const v = S.variations;
    if (!v) { cards.replaceChildren(h('div', { class: 'muted small empty-cards' }, 'Your three options will appear here.')); return; }
    cards.replaceChildren(...v.map((o, i) => {
      const th = thumbOf(o.canvas, 200, '#f3f2ef');
      const applied = S.applied && S.applied.index === i;
      return h('div', { class: 'vcard' + (applied ? ' applied' : '') },
        h('div', { class: 'vthumb' }, th, h('span', { class: 'vsrc ' + o.source }, o.source === 'ai' ? 'AI' : 'Local')),
        h('div', { class: 'vmeta' }, h('b', {}, ['Light', 'Medium', 'Strong'][i] || o.label), h('span', { class: 'muted small', tip: sumOf(o, i) }, shorten(sumOf(o, i)))),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn primary sm', onclick: () => A.acceptVariation(i) }, applied ? icon('check', 14) : null, applied ? 'Applied' : 'Use this'),
          h('button', { class: 'btn ghost sm', disabled: !S.applied, tip: S.applied ? 'Apply this option on top of the one you picked' : 'Pick an option first, then add another on top', onclick: () => A.combineVariation(i) }, 'Combine')));
    }));
  }
  function sync(reason) {
    const V = activeView();
    partPanel.sync();
    if (document.activeElement !== prompt && prompt.value !== S.ui.prompt) prompt.value = S.ui.prompt;
    const has = !!V.base;
    [genBtn, ...root.querySelectorAll('.chip, .slider input')].forEach(b => { b.disabled = !has; });
    // look controls redraw from the active view and set their own disabled state (after the loop above)
    presets.sync(V); shape.sync(V); whole.sync(V); fab.sync(V);
    const sel = hasMask(V);
    keepNote.textContent = sel ? 'Only your selected area will change. Everything else is kept exactly. To make a part bigger, use Grow so there is room.' : 'No area selected: the change applies to the whole garment. Optional: select an area on the left to limit it.';
    if (!reason || ['variations', 'applied', 'restore', 'loaded', 'history'].includes(reason)) renderCards();
  }
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live'].includes(r)) sync(r); });
  sync();
}
