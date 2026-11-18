// Header: brand, design name, workflow stepper, engine badge.
import { state, subscribe, hasMask, notify, VIEWS } from './state.js';
import { h, icon } from './util.js';
import { engineBadge } from './ui-right.js';

const STEPS = [
  ['upload', 'Upload', 'Add a garment photo or try a sample', () => { const d = document.getElementById('sec-upload'); open(d); }],
  ['select', 'Select area', 'Choose the part of the garment to change', () => open(document.getElementById('sec-select'))],
  ['describe', 'Describe', 'Say what you want in plain words', () => { document.getElementById('prompt')?.focus(); }],
  ['generate', 'Generate', 'Create Subtle, Medium and Bold options', () => document.getElementById('btn-variations')?.focus()],
  ['compare', 'Compare', 'Check before and after', () => document.getElementById('btn-compare')?.click()],
  ['refine', 'Refine', 'Fine-tune with sliders, colour, fabric and graphics', () => open(document.getElementById('sec-shape'))],
  ['export', 'Export', 'Download PNG, SVG or a design sheet', () => document.getElementById('btn-export')?.click()],
];
function open(d) { if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }

export function initHeader(root) {
  const name = h('input', { class: 'name', value: state.name, 'aria-label': 'Design name', oninput: e => { state.name = e.target.value; } });
  const steps = h('ol', { class: 'stepper', 'aria-label': 'Workflow' }, STEPS.map(([k, label, tip, fn], i) =>
    h('li', { 'data-k': k }, h('button', { class: 'step', tip, onclick: fn }, h('span', { class: 'sn' }, i + 1), h('span', { class: 'sl' }, label)))));
  root.append(
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('layers', 18)), h('b', {}, 'Threadform')),
    name, steps, h('div', { class: 'head-right' }, engineBadge()));
  function sync() {
    const f = state.flow;
    const done = {
      upload: VIEWS.some(v => state.views[v].base),
      select: hasMask(state.views[state.activeView]) || f.generated,
      describe: f.described, generate: f.generated, compare: f.compared, refine: f.refined, export: f.exported,
    };
    let cur = STEPS.findIndex(([k]) => !done[k]);
    steps.querySelectorAll('li').forEach((li, i) => {
      const k = li.dataset.k;
      li.classList.toggle('done', !!done[k]); li.classList.toggle('cur', i === cur);
    });
    if (document.activeElement !== name) name.value = state.name;
  }
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live'].includes(r)) sync(); }); sync();
}
