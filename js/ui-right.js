// Right panel: describe + variations, fit/sleeve presets, shape sliders, colour, fabric.
import { state, activeView, subscribe, markFlow, hasMask, notify } from './state.js';
import { h, icon, thumbOf, setDisabled } from './util.js';
import { getMode } from './ui-guide.js';
import * as A from './ui-actions.js';
import { section } from './ui-left.js';
import { createPartPanel, createInspector } from './manual.js';
import { presetBlock, shapeBlock, wholeColourBlock, fabricBlock } from './ui-look.js';
import { measureSection } from './ui-measure.js';
import { engineRow } from './ai-ui.js';
import { previewOption, combine as combineOption } from './ui-review.js';

const EXAMPLES = ['make the sleeves flared', 'boxy oversized fit', 'remove the cuffs', 'cropped hem', 'heavyweight cotton', 'red piping on the collar', 'vintage Greek island style'];

/** Neutral privacy note shown in the header and next to the options. */
export function localNote(cls = '') {
  if (document.querySelector('meta[name="threadform-shared"][content="1"]')) {
    return h('span', { class: 'badge local ' + cls, tip: 'Threadform edits garments right here in your browser. Saved designs go to your shared library, so everyone who has the password sees them.' },
      h('i', { class: 'dot' }), 'Shared library');
  }
  return h('span', { class: 'badge local ' + cls, tip: 'Threadform reshapes, recolours and generates garments right here in your browser. Your images and designs are never uploaded.' },
    h('i', { class: 'dot' }), 'Runs in your browser');
}

let tabs = null;
/** Shows the right-panel tab that holds section `id` (and opens that section). Returns false when `id` is not on the right. */
export function revealSection(id) { return tabs ? tabs.reveal(id) : false; }
export function showTab(key) { tabs?.show(key); }

/** Accessible tabs (arrow keys, Home / End). Each tab holds a few collapsible sections. */
function createTabs(root, defs) {
  const list = h('div', { class: 'rtabs', role: 'tablist', id: 'right-tabs', 'aria-label': 'Edit controls' });
  const btns = [], panels = [];
  defs.forEach(d => {
    const b = h('button', { type: 'button', class: 'rtab', role: 'tab', id: 'rtab-' + d.key, 'aria-controls': 'rpanel-' + d.key, 'aria-selected': 'false', tabindex: '-1', tip: d.tip, 'data-k': d.key, onclick: () => show(d.key, true) }, d.label);
    const p = h('div', { class: 'rpanel', role: 'tabpanel', id: 'rpanel-' + d.key, 'aria-labelledby': 'rtab-' + d.key, 'data-k': d.key, hidden: true }, d.secs);
    if (d.level) { b.dataset.level = d.level; p.dataset.level = d.level; }
    btns.push(b); panels.push(p); list.append(b);
  });
  root.append(list, ...panels);
  let cur = null;
  const visible = () => btns.filter(b => b.offsetParent !== null || !b.dataset.level || getMode() === 'advanced');
  function show(key, focus = false) {
    if (!btns.some(b => b.dataset.k === key)) return;
    const changed = cur !== key; cur = key;
    btns.forEach(b => { const on = b.dataset.k === key; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    panels.forEach(p => { p.hidden = p.dataset.k !== key; });
    if (changed) { root.scrollTop = 0; notify('tab'); }
  }
  list.addEventListener('keydown', e => {
    const vis = visible(), i = vis.indexOf(document.activeElement);
    if (i < 0) return;
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: vis.length - 1 }[e.key];
    if (n === undefined) return;
    e.preventDefault();
    show(vis[(n + vis.length) % vis.length].dataset.k, true);
  });
  function reveal(id) {
    const sec = document.getElementById(id), p = sec?.closest('.rpanel');
    if (!p) return false;
    if (p.dataset.level === 'advanced' || sec.dataset.level === 'advanced') { if (getMode() !== 'advanced') return false; }
    show(p.dataset.k);
    if (sec.tagName === 'DETAILS') sec.open = true;
    return true;
  }
  show(defs[0].key);
  return { show, reveal, current: () => cur };
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
    prompt, examples, keepNote, genBtn, engineRow(), cards,
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
  // ---- tabs: one group of sections at a time instead of one long scroll ----
  secPresets.dataset.level = secShape.dataset.level = secFabric.dataset.level = 'advanced';
  const layersSec = document.getElementById('sec-layers');   // built by the left panel; it belongs with the items
  if (layersSec) layersSec.dataset.level = 'advanced';
  tabs = createTabs(root, [
    { key: 'look', label: 'Look', tip: 'Describe a change, compare options and colour the garment', secs: [secDescribe, secColor] },
    { key: 'shape', label: 'Shape', tip: 'Fit and sleeve presets, shape sliders and fabric (Advanced)', secs: [secPresets, secShape, secFabric], level: 'advanced' },
    { key: 'items', label: 'Items', tip: 'Edit the text and graphics you added', secs: [secInspector, layersSec].filter(Boolean) },
    { key: 'measure', label: 'Measure', tip: 'Approximate garment measurements', secs: [secMeasure] },
  ]);
  // open the tab that fits what the person is doing
  let lastSel = null;
  subscribe(r => {
    if (r === 'mode' && getMode() === 'basic' && tabs.current() === 'shape') tabs.show('look');
    if ((r === 'selection' || r === 'elements') && state.selectedId && state.selectedId !== lastSel) tabs.show('items');
    if (r === 'selection' || r === 'elements' || r === 'restore' || r === 'loaded') lastSel = state.selectedId;
    if (r === 'part') tabs.reveal('sec-color');
    if (r === 'variations') tabs.reveal('sec-describe');
  });

  const sumOf = (o, i) => (o.ops && o.ops.summary) || ['A small change to what you asked for', 'The change exactly as you described it', 'A stronger version of your change'][i] || '';
  const shorten = t => (t.length > 60 ? t.slice(0, 58).trimEnd() + '…' : t);
  function renderCards() {
    const v = S.variations;
    if (!v) { cards.replaceChildren(h('div', { class: 'muted small empty-cards' }, 'Your three options will appear here.')); return; }
    cards.replaceChildren(...v.map((o, i) => {
      const name = ['Light', 'Medium', 'Strong'][i] || (o && o.label) || '';
      if (!o || !o.canvas) {   // still working (AI), cancelled or did not finish: no picture yet
        const msg = !o ? '' : o.cancelled ? 'Cancelled' : o.failed ? 'Did not finish. Create the options again to retry.' : 'Working on it…';
        return h('div', { class: 'vcard pending', 'data-state': o && o.cancelled ? 'cancelled' : o && o.failed ? 'failed' : 'working' },
          h('div', { class: 'vmeta' }, h('b', {}, name), h('span', { class: 'muted small' }, msg)));
      }
      const th = thumbOf(o.canvas, 200, '#f3f2ef');
      const applied = S.applied && S.applied.index === i;
      const fromAi = o.source === 'ai';
      return h('div', { class: 'vcard' + (applied ? ' applied' : '') },
        h('div', { class: 'vthumb' }, th),
        h('div', { class: 'vmeta' },
          h('b', {}, name, h('span', { class: 'vtag ' + (fromAi ? 'ai' : 'builtin') }, fromAi ? 'AI' : 'Built-in')),
          h('span', { class: 'muted small', tip: sumOf(o, i) }, shorten(sumOf(o, i))),
          o.note ? h('span', { class: 'vnote small' }, 'AI was not used for this option: ' + o.note) : null),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn primary sm', tip: applied ? 'This option is on the garment now' : 'Show this option on the garment. Accept or reject it below the canvas', onclick: () => previewOption(i) }, applied ? icon('check', 14) : null, applied ? 'Applied' : 'Preview'),
          h('button', { class: 'btn ghost sm', disabled: !S.applied, tip: S.applied ? 'Apply this option on top of the one you picked' : 'Pick an option first, then add another on top', onclick: () => combineOption(i) }, 'Combine')));
    }));
  }
  function sync(reason) {
    const V = activeView();
    partPanel.sync();
    if (document.activeElement !== prompt && prompt.value !== S.ui.prompt) prompt.value = S.ui.prompt;
    const has = !!V.base;
    [...root.querySelectorAll('.chip, .slider input')].forEach(b => { b.disabled = !has; });
    setDisabled(genBtn, !has, 'Load a garment first: pick a sample, upload a photo or generate one on the left.');
    // look controls redraw from the active view and set their own disabled state (after the loop above)
    presets.sync(V); shape.sync(V); whole.sync(V); fab.sync(V);
    const sel = hasMask(V);
    keepNote.textContent = sel ? 'Only your selected area will change. Everything else is kept exactly. To make a part bigger, grow the selection (Advanced: Expand) so there is room.'
      : getMode() === 'basic' ? 'The change applies to the whole garment. To change just one area, select it first with the tools above the canvas (for both sleeves: Click a part, then click each sleeve).'
      : 'No area selected: the change applies to the whole garment. Optional: select an area on the left to limit it.';
    if (!reason || ['variations', 'applied', 'restore', 'loaded', 'history'].includes(reason)) renderCards();
  }
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live', 'tab'].includes(r)) sync(r); });
  sync();
}
