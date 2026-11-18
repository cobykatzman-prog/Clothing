// Header: brand, design name, workflow stepper, privacy note.
import { state, subscribe, hasMask, VIEWS } from './state.js';
import { h, icon, logoutForm } from './util.js';
import { localNote, revealSection } from './ui-right.js';
import { getMode } from './ui-guide.js';
import { engineBadge } from './ai-ui.js';
import { onAiChange, useAi } from './ai.js';

const STEPS = [
  ['upload', 'Upload', 'Add a garment photo or try a sample', () => { const d = document.getElementById('sec-upload'); open(d); }],
  ['select', 'Select area', 'Choose the part of the garment to change', () => open(document.getElementById('sec-select'))],
  ['describe', 'Describe', 'Say what you want in plain words', () => { revealSection('sec-describe'); document.getElementById('prompt')?.focus(); }],
  ['generate', 'Generate', 'Create Subtle, Medium and Bold options', () => { revealSection('sec-describe'); document.getElementById('btn-variations')?.focus(); }],
  ['compare', 'Compare', 'Check before and after', () => document.getElementById('btn-compare')?.click()],
  ['refine', 'Refine', 'Fine-tune with colour, text and graphics (and shape sliders and fabric in Advanced)', () => { const id = getMode() === 'advanced' ? 'sec-shape' : 'sec-color'; revealSection(id); open(document.getElementById(id)); }],
  ['export', 'Export', 'Download PNG, SVG or a design sheet', () => document.getElementById('btn-export')?.click()],
];
function open(d) { if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }

export function initHeader(root) {
  const name = h('input', { class: 'name', value: state.name, 'aria-label': 'Design name', oninput: e => { state.name = e.target.value; } });
  const steps = h('ol', { class: 'stepper', 'aria-label': 'Workflow' }, STEPS.map(([k, label, tip, fn], i) =>
    h('li', { 'data-k': k, 'data-level': k === 'select' ? 'advanced' : null }, h('button', { class: 'step', tip, 'aria-label': `Step ${i + 1}: ${label}`, onclick: fn }, h('span', { class: 'sn' }, i + 1), h('span', { class: 'sl' }, label)))));
  const note = localNote();   // "runs in your browser" is not true while AI is on: the engine badge says what happens instead
  const syncNote = () => { note.hidden = useAi(); };
  onAiChange(syncNote); syncNote();
  root.append(
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('layers', 18)), h('b', {}, 'Threadform')),
    name, steps, h('div', { class: 'head-right' }, engineBadge(), note, logoutForm()));
  function sync() {
    const f = state.flow;
    const done = {
      upload: VIEWS.some(v => state.views[v].base),
      select: hasMask(state.views[state.activeView]) || f.generated,
      describe: f.described, generate: f.generated, compare: f.compared, refine: f.refined, export: f.exported,
    };
    if (getMode() === 'basic') done.select = done.select || done.upload;   // selecting is optional in Basic (it is an Advanced tool)
    let cur = STEPS.findIndex(([k]) => !done[k]);
    let n = 0;   // number only the steps shown in this mode
    steps.querySelectorAll('li').forEach(li => { const sn = li.querySelector('.sn'), b = li.querySelector('.step'); if (getMode() === 'basic' && li.dataset.level === 'advanced') return; n++; sn.textContent = n; b.setAttribute('aria-label', `Step ${n}: ${b.querySelector('.sl').textContent}`); });
    steps.querySelectorAll('li').forEach((li, i) => {
      const k = li.dataset.k;
      li.classList.toggle('done', !!done[k]); li.classList.toggle('cur', i === cur);
      const b = li.querySelector('.step'); if (i === cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    if (document.activeElement !== name) name.value = state.name;
  }
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live'].includes(r)) sync(); }); sync();
}
