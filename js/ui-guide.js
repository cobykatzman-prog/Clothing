// Making the studio easier to use (owner: shell): Basic / Advanced mode, the "?" help (guided tour,
// keyboard shortcuts, how it works), the plain-language "Next step" hint and a few keyboard shortcuts.
// Every text here is inserted as text, never as HTML.
import { state, VIEWS, activeView, subscribe, notify, hasMask } from './state.js';
import { isSelTool, selectionStats } from './selection.js';
import { h, icon, prefs, clamp } from './util.js';
import { openDialog } from './ui-dialog.js';

/* ------------------------------------------------------------------ Basic / Advanced */
export const getMode = () => (document.body.dataset.mode === 'advanced' ? 'advanced' : 'basic');
export function setMode(m) {
  m = m === 'advanced' ? 'advanced' : 'basic';
  if (document.body.dataset.mode === m) return;
  document.body.dataset.mode = m; prefs.set('mode', m); notify('mode');
}
/** Applies the remembered mode (default Basic). Call before the panels are shown. */
export function initMode() { document.body.dataset.mode = prefs.get('mode') === 'advanced' ? 'advanced' : 'basic'; }

function modeToggle() {
  const btn = (m, label, tip) => h('button', { type: 'button', class: 'mode-btn', 'data-m': m, 'aria-pressed': 'false', tip, onclick: () => setMode(m) }, label);
  const el = h('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Amount of controls shown' },
    btn('basic', 'Basic', 'Basic: just the essentials - start a garment, describe a change, colour, text and graphics, measurements and export.'),
    btn('advanced', 'Advanced', 'Advanced: everything - shape sliders, presets, fabric, layers, references, every selection tool, saved selections and copy look.'));
  const sync = () => el.querySelectorAll('.mode-btn').forEach(b => { const on = b.dataset.m === getMode(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  subscribe(r => { if (r === 'mode') sync(); }); sync();
  return el;
}

/* ------------------------------------------------------------------ help: tour, how it works, shortcuts */
const HOW = [
  ['Upload', 'Pick a sample, upload a photo of a garment, or describe one under "Generate garment".'],
  ['Select', 'Optional: mark the part to change with the tools above the canvas (Brush, Lasso, Click a part, Smart select). To change both sleeves, click each sleeve, then describe the change. With nothing selected the whole garment can change.'],
  ['Describe', 'Write what you want in plain words, for example "make the sleeves flared".'],
  ['Generate', 'Press "Create 3 options" to get a light, a medium and a strong version.'],
  ['Compare', 'Look at the three options, press "Use this" on your favourite, and use "Compare before / after" to check it.'],
  ['Refine', 'Recolour any part, add text and graphics, and check the measurements. Advanced adds shape sliders and fabric.'],
  ['Export', 'Download a picture, an editable SVG, the measurements or a full design sheet.'],
];
const KEYS = [
  ['Ctrl + Z', 'Undo'], ['Ctrl + Shift + Z  or  Ctrl + Y', 'Redo'],
  ['Delete  or  Backspace', 'Delete the selected text or graphic'], ['Ctrl + D', 'Duplicate the selected text or graphic'],
  ['Arrow keys', 'Nudge the selected item by 1 px (hold Shift for 10 px)'],
  ['+  /  -', 'Zoom in / out (or use the mouse wheel over the canvas)'], ['0', 'Fit the garment to the screen'],
  ['Hold Space and drag', 'Move around the canvas (or drag with the middle mouse button, or two fingers on a touch screen)'], ['Esc', 'Deselect, cancel a selection in progress, or close a dialog or menu'], ['?', 'Open this help'],
  ['Mouse wheel', 'Zoom towards the pointer (up to 1000%)'], ['Z', 'Zoom to the selection'],
  ['B  E  L  P  M', 'Selection tools: Brush, Eraser, Lasso, Polygon, Rectangle'], ['R  C  S  W  K  T', 'Selection tools: Click a part, Whole part, Smart select, Magic wand, By colour, By material'], ['V', 'Back to the Move tool'],
  ['[  and  ]', 'Make the brush or eraser smaller / bigger'],
  ['Shift  /  Alt (Option)  /  Shift + Alt', 'While selecting: add to, subtract from, or intersect with the selection'],
  ['Ctrl + A  /  Ctrl + I  /  Ctrl + Shift + A', 'Select the whole garment / invert the selection / clear it'],
  ['Ctrl + Z  (selection tool active)', 'Undo the last selection step (Ctrl + Shift + Z redoes it)'],
  ['Polygon: Enter  /  Backspace  /  Esc', 'Finish the shape / remove the last point / cancel it'],
];

export function openHelp() {
  const tourBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => { d.close(); setTimeout(startTour, 50); } }, icon('sparkles', 16), 'Take the guided tour');
  const d = openDialog({
    title: 'Help', cls: 'wide help-dlg',
    body: [
      h('p', { class: 'muted' }, document.querySelector('meta[name="threadform-shared"][content="1"]')
        ? 'Threadform edits garments right here in your browser. Your designs (including their images) are saved to the shared library on this site\'s server, where everyone who has the password can see and edit them.'
        : 'Threadform runs entirely in your browser. Nothing is uploaded, and your designs are saved in this browser.'),
      tourBtn,
      h('h3', {}, 'How it works'),
      h('ol', { class: 'how' }, HOW.map(([t, d]) => h('li', {}, h('b', {}, t), h('span', {}, d)))),
      h('p', { class: 'muted small' }, 'Basic shows only the essentials. Switch to Advanced in the header for shape sliders, presets, fabric, layers, references, the full set of selection tools (wand, colour, material, polygon...), saved selections and copy look. Nothing is lost when you switch.'),
      h('h3', {}, 'Keyboard shortcuts'),
      h('table', { class: 'keys' }, h('tbody', {}, KEYS.map(([k, t]) => h('tr', {}, h('th', { scope: 'row' }, h('kbd', {}, k)), h('td', {}, t))))),
      h('p', { class: 'muted small' }, 'On a Mac use Cmd instead of Ctrl.'),
    ],
  });
  tourBtn.focus();
  return d;
}

/* ------------------------------------------------------------------ guided tour */
// Each step points at a part of the screen. `show` makes sure it is visible first (opens a tab or section).
const reveal = id => window.__threadform?.reveal?.(id);
const TOUR = [
  { sel: '#sec-upload', title: 'Start with a garment', text: 'Pick a sample, upload a photo, or describe a garment under "Generate garment". The background is removed for you.' },
  { sel: '#selbar', title: 'Select the part to change', text: 'Pick a tool above the canvas: Click a part, Brush, Lasso or Smart select. To change both sleeves, click each sleeve (or press "Both sleeves"), then describe the change. Nothing selected means the whole garment can change.' },
  { sel: '#sec-describe', show: () => reveal('sec-describe'), title: 'Describe a change', text: 'Write what you want in plain words, like "make the sleeves flared". Then press "Create 3 options".' },
  { sel: '#variation-cards', show: () => reveal('sec-describe'), title: 'Pick the one you like', text: 'You get a light, a medium and a strong version. Press "Use this" on your favourite. You can always undo.' },
  { sel: '#right-tabs', title: 'Colour, items and measurements', text: 'These tabs hold the colour of each part, your text and graphics, and the garment\'s measurements. The right tab opens by itself when you need it.' },
  { sel: '#btn-undo', title: 'Nothing is permanent', text: 'Undo and redo any step. Your design saves itself ' + (document.querySelector('meta[name="threadform-shared"][content="1"]') ? 'to the shared library' : 'in this browser') + ' as you work.' },
  { sel: '#btn-export', title: 'Export when you are happy', text: 'Download a picture, an editable SVG, the measurements or a full design sheet. Press "?" in the header any time to see this tour again.' },
];
let tour = null;
export function startTour() {
  if (tour) return;
  const prev = document.activeElement;
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const ttl = h('h2', { id: 'tour-title' }), txt = h('p', { id: 'tour-text' }), count = h('span', { class: 'muted small' });
  const back = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => go(i - 1) }, 'Back');
  const next = h('button', { type: 'button', class: 'btn primary sm', onclick: () => (i === TOUR.length - 1 ? end(true) : go(i + 1)) }, 'Next');
  const skip = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => end(true) }, 'Skip tour');
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text' },
    count, ttl, txt, h('div', { class: 'tour-actions' }, skip, h('span', { class: 'grow' }), back, next));
  const root = h('div', { class: 'tour', id: 'tour' }, spot, card);
  document.body.append(root);
  let i = 0;
  const place = () => {
    const s = TOUR[i];
    const t = [...document.querySelectorAll(s.sel)].find(e => e.offsetParent !== null || e.getClientRects().length);
    const vw = innerWidth, vh = innerHeight;
    if (t) {
      const r = t.getBoundingClientRect(), pad = 6;
      const top = clamp(r.top - pad, 4, vh - 8), bottom = clamp(r.bottom + pad, 4, vh - 4);
      Object.assign(spot.style, { left: clamp(r.left - pad, 4, vw - 8) + 'px', top: top + 'px', width: Math.max(8, Math.min(r.width + pad * 2, vw - 8)) + 'px', height: Math.max(8, bottom - top) + 'px', display: '' });
      const cw = card.offsetWidth, ch = card.offsetHeight;
      let y = bottom + 10; if (y + ch > vh - 8) y = top - ch - 10; if (y < 8) y = clamp(vh - ch - 8, 8, vh);
      let x = clamp(r.left + r.width / 2 - cw / 2, 8, vw - cw - 8);
      if (r.width > vw * 0.6 && r.height > vh * 0.5) { x = (vw - cw) / 2; y = vh - ch - 16; }
      Object.assign(card.style, { left: x + 'px', top: y + 'px' });
    } else {
      spot.style.display = 'none';
      Object.assign(card.style, { left: (vw - card.offsetWidth) / 2 + 'px', top: (vh - card.offsetHeight) / 2 + 'px' });
    }
  };
  function go(n) {
    i = clamp(n, 0, TOUR.length - 1);
    const s = TOUR[i];
    s.show?.();
    count.textContent = `Step ${i + 1} of ${TOUR.length}`;
    ttl.textContent = s.title; txt.textContent = s.text;
    back.disabled = i === 0; next.textContent = i === TOUR.length - 1 ? 'Done' : 'Next';
    const t = document.querySelector(s.sel);
    t?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    requestAnimationFrame(place);
    next.focus();
  }
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(true); }
    else if (e.key === 'Tab') {   // keep keyboard focus inside the tour card
      const f = [...card.querySelectorAll('button:not(:disabled)')]; if (!f.length) return;
      const k = f.indexOf(document.activeElement);
      if (e.shiftKey && k <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && k === f.length - 1) { e.preventDefault(); f[0].focus(); }
    } else if (e.key === 'ArrowRight' && document.activeElement?.closest('.tour-card')) { e.preventDefault(); if (i < TOUR.length - 1) go(i + 1); }
    else if (e.key === 'ArrowLeft' && document.activeElement?.closest('.tour-card')) { e.preventDefault(); go(i - 1); }
  };
  const onResize = () => requestAnimationFrame(place);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize); window.addEventListener('scroll', onResize, true);
  function end(done) {
    if (done) prefs.set('tour', 'done');
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize); window.removeEventListener('scroll', onResize, true);
    root.remove(); tour = null;
    if (prev && prev.isConnected) prev.focus?.();
  }
  tour = { end };
  go(0);
}
/** First visit to the studio: show the tour once. */
export function maybeStartTour() {
  if (prefs.get('tour') === 'done' || tour) return;
  setTimeout(() => { if (!document.querySelector('.app')?.hidden && prefs.get('tour') !== 'done') startTour(); }, 450);
}

/* ------------------------------------------------------------------ "Next step" hint */
export function nextStepText() {
  const f = state.flow, V = activeView(), basic = getMode() === 'basic';
  if (!VIEWS.some(n => state.views[n].base)) return 'Next: pick a sample or upload a photo of a garment (left panel), or describe one under Generate garment.';
  if (!V.base) return 'This view is still empty. Switch to a view that has a garment, or upload a photo for this one.';
  if (state.variations && !state.applied) return 'Next: look at the three options in the Look tab and press "Use this" on the one you like.';
  const sel = hasMask(V);
  if (!(f.refined || f.compared || state.applied)) {
    if (sel) { const st = selectionStats(V); return `Selected${st.pct != null ? ' ' + Math.round(st.pct) + '% of the garment' : ''}. Next: describe what to change in the selected area (Look tab) and press "Create 3 options".`; }
    if (isSelTool(state.ui.tool)) return 'Next: mark the part to change. Choose Click a part, then click each sleeve to select both, then describe the change.';
    return basic ? 'Next: describe a change in the Look tab and press "Create 3 options", or change a colour.'
      : 'Next: describe a change and press "Create 3 options", or move a shape slider.';
  }
  if (!f.exported) return 'Next: fine-tune colours, text or graphics. Happy? Export it with the button at the bottom right.';
  return 'Exported. Keep refining, or go Home to start another design.';
}
export function nextStepHint() {
  const txt = h('span', {});
  const el = h('p', { class: 'next-step', id: 'next-step', role: 'status', 'aria-live': 'polite' }, icon('help', 15), txt);
  const sync = () => { const t = nextStepText(); if (txt.textContent !== t) txt.textContent = t; };
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live'].includes(r)) sync(); }); sync();
  return el;
}

/* ------------------------------------------------------------------ header controls + global keys */
export function initGuide(header) {
  const help = h('button', { type: 'button', class: 'icon-btn help-btn', id: 'btn-help', 'aria-label': 'Help: guided tour, keyboard shortcuts and how it works', tip: 'Help: tour, keyboard shortcuts, how it works (?)', 'aria-haspopup': 'dialog', onclick: () => openHelp() }, '?');
  header.querySelector('.head-right')?.append(modeToggle(), help);
  window.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open], .tour')) return;
    if (document.querySelector('.app')?.hidden) return;
    const st = window.__stage;
    if (e.key === '?') { e.preventDefault(); openHelp(); }
    else if (st && (e.key === '+' || e.key === '=')) { e.preventDefault(); st.zoomBy(1.2); }
    else if (st && (e.key === '-' || e.key === '_')) { e.preventDefault(); st.zoomBy(1 / 1.2); }
    else if (st && e.key === '0') { e.preventDefault(); st.fit(); }
  });
}
