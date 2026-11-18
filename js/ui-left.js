// Left panel: upload, generate, select areas, text, graphics, references.
import { state, activeView, subscribe, notify, snapshot, markFlow, hasMask } from './state.js';
import { h, icon, thumbOf, toast, setDisabled } from './util.js';
import * as A from './ui-actions.js';
import { REGION_NAMES } from './segment.js';
import { createElement, GRAPHIC_LIBRARY, FONTS } from './elements.js';
import { createLayers } from './manual.js';
import { SAMPLE_KINDS } from './samples.js';

const pretty = s => s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const KIND_LABEL = { tee: 'T-shirt', longSleeve: 'Long sleeve', polo: 'Polo', hoodie: 'Hoodie' };
const REGION_TIPS = {
  body: 'The main torso panel', leftSleeve: "The garment's left sleeve (right side as you look at it)", rightSleeve: "The garment's right sleeve (left side as you look at it)",
  collar: 'The collar / neckband', neckline: 'The neck opening', cuffs: 'Cuffs at the end of the sleeves', hem: 'The bottom hem', shoulders: 'Shoulder seams and yoke',
  sidePanels: 'Side seams and panels', stripes: 'Existing stripes', logos: 'Existing logos or prints', text: 'Existing lettering', fabric: 'Just the fabric surface (no trims)',
};

export function section(num, title, tip, body, open = true, id) {
  const d = h('details', { class: 'card', id }, h('summary', {}, h('span', { class: 'num' }, num), h('span', { class: 'ttl' }, title), tip ? h('span', { class: 'hint', tip }, icon('help', 14)) : null, h('span', { class: 'chev' }, icon('chevron', 16))), h('div', { class: 'card-body' }, body));
  if (open) d.open = true;
  return d;
}
export function field(label, input, tip) { return h('label', { class: 'field', tip }, h('span', { class: 'lbl' }, label), input); }

export function initLeft(root) {
  const S = state;
  // ---- 1 Upload ----
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: e => { const f = e.target.files[0]; if (f) A.loadFile(f); e.target.value = ''; } });
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'button', 'aria-label': 'Upload a garment image', onclick: () => fileIn.click(), onkeydown: e => { if (e.key === 'Enter') fileIn.click(); } },
    icon('upload', 26), h('b', {}, 'Drop a photo here'), h('span', {}, 'or click to browse · PNG, JPG, WEBP'));
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) A.loadFile(f); });
  const viewHint = h('div', { class: 'muted small' });
  const sec1 = section(1, 'Upload image', 'Upload a clean photo or flat-lay of a garment. The background is removed automatically.', [
    drop, fileIn, viewHint,
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn ghost sm', tip: 'Try the editor with a built-in sample garment', onclick: () => A.loadSample('tee') }, icon('sparkles', 15), 'Try a sample shirt'),
      h('button', { class: 'btn ghost sm', id: 'btn-removebg', tip: 'Cut the garment out of its background again', onclick: () => A.removeBg() }, icon('scissors', 15), 'Remove background')),
  ], true, 'sec-upload');

  // ---- 2 Generate ----
  let kind = 'tee';
  const kinds = (SAMPLE_KINDS || ['tee', 'longSleeve', 'polo', 'hoodie']);
  const kindBtns = kinds.map(k => h('button', { class: 'chip' + (k === kind ? ' on' : ''), 'data-k': k, onclick: () => { kind = k; kindBtns.forEach(b => b.classList.toggle('on', b.dataset.k === k)); } }, KIND_LABEL[k] || pretty(k)));
  const colorIn = h('input', { type: 'color', value: '#6f8fb5', 'aria-label': 'Garment colour' });
  const stripeIn = h('input', { type: 'checkbox' });
  const genPrompt = h('textarea', { rows: 2, placeholder: 'e.g. navy hoodie with white stripes', 'aria-label': 'Describe a garment to generate' });
  const genLabel = h('span', {}, 'Generate garment');
  const genStatus = h('div', { class: 'muted small gen-status', role: 'status', 'aria-live': 'polite' });
  const genBtn = h('button', { class: 'btn primary sm', onclick: () => runGenerate() }, icon('sparkles', 15), genLabel);
  const runGenerate = async () => {
    if (genBtn.disabled) return;
    genBtn.disabled = true; genLabel.textContent = 'Generating…'; genStatus.textContent = '';
    try {
      const r = await A.generateFromPrompt(genPrompt.value, { defaultKind: kind });
      genStatus.textContent = r.message;
      if (r.spec) { // keep "Use sample" in step with what was just generated
        kind = r.spec.kind; kindBtns.forEach(b => b.classList.toggle('on', b.dataset.k === kind));
        colorIn.value = r.spec.color;
      }
    } finally { genBtn.disabled = false; genLabel.textContent = 'Generate garment'; }
  };
  genPrompt.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runGenerate(); });
  const sec2 = section(2, 'Generate garment', 'Describe a garment and the editor builds front, back, side and detail views of it at once, right here in your browser.', [
    h('div', { class: 'chips' }, kindBtns),
    h('div', { class: 'row gap center' }, field('Colour', colorIn), h('label', { class: 'check' }, stripeIn, 'Stripes')),
    genPrompt,
    genStatus,
    h('div', { class: 'row gap wrap' },
      genBtn,
      h('button', { class: 'btn ghost sm', tip: 'Draw the chosen sample shape in the chosen colour', onclick: () => A.loadSample(kind, { color: colorIn.value, stripe: stripeIn.checked }, S.views[S.activeView].base ? S.activeView : null) }, 'Use sample')),
  ], false, 'sec-generate');

  // ---- 3 Select ----
  const toolBtn = (t, ic, label, tip) => h('button', { class: 'tool', 'data-tool': t, tip, onclick: () => { S.ui.tool = t; if (t === 'brush') S.ui.brushMode = 'add'; notify('tool'); } }, icon(ic, 17), label);
  const regionBtns = REGION_NAMES.map(n => h('button', { class: 'chip region', 'data-r': n, tip: REGION_TIPS[n] || pretty(n), onclick: () => A.toggleRegion(n) }, pretty(n)));
  const brush = h('input', { type: 'range', min: 6, max: 160, value: S.ui.brushSize, 'aria-label': 'Brush size', oninput: e => { S.ui.brushSize = +e.target.value; brushVal.textContent = e.target.value + ' px'; notify('tool'); } });
  const brushVal = h('span', { class: 'val' }, S.ui.brushSize + ' px');
  const modeBtns = ['add', 'erase'].map(m => h('button', { class: 'seg-btn', 'data-m': m, onclick: () => { S.ui.brushMode = m; S.ui.tool = 'brush'; notify('tool'); } }, m === 'add' ? 'Add' : 'Erase'));
  const maskTog = h('input', { type: 'checkbox', checked: true, onchange: e => { S.ui.showMask = e.target.checked; notify('tool'); } });
  const limitTog = h('input', { type: 'checkbox', onchange: e => { S.ui.limitToSelection = e.target.checked; A.recompute(); } });
  const selInfo = h('div', { class: 'muted small', id: 'sel-info' });
  const sec3 = section(3, 'Select garment areas', 'Choose the part you want to change. Only the selected pixels will be edited by Generate variations.', [
    h('div', { class: 'tools' }, toolBtn('region', 'pick', 'Pick on canvas', 'Click a part of the garment on the canvas to select it'), toolBtn('brush', 'brush', 'Brush', 'Paint the exact area you want to change')),
    h('div', { class: 'chips' }, regionBtns),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn ghost sm', onclick: A.selectWhole }, 'Whole garment'),
      h('button', { class: 'btn ghost sm', tip: 'Expand the selection outward so a part can get bigger (e.g. wider sleeves)', onclick: () => A.growMask() }, 'Grow'),
      h('button', { class: 'btn ghost sm', onclick: A.invertMask }, 'Invert'),
      h('button', { class: 'btn ghost sm', onclick: A.clearMask }, 'Clear')),
    h('div', { class: 'brushbox' },
      h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Brush size'), brushVal), brush,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Brush mode' }, modeBtns)),
    h('label', { class: 'check' }, maskTog, 'Show selection overlay'),
    h('label', { class: 'check', tip: 'When on, shape sliders, colour and fabric also only change the selected area.' }, limitTog, 'Limit sliders & colour to the selection'),
    selInfo,
  ], false, 'sec-select');

  // ---- 4 Text ----
  const txt = h('input', { type: 'text', value: 'ATHENS', maxlength: 40, 'aria-label': 'Text to add' });
  const font = h('select', { 'aria-label': 'Font' }, ...FONTS.map(f => h('option', { value: f.value }, f.label)));
  const tcol = h('input', { type: 'color', value: '#1d1d1f', 'aria-label': 'Text colour' });
  const sec4 = section(4, 'Add text', 'Adds editable text. Drag it on the canvas; use the corner handles to resize and the top handle to rotate.', [
    txt, h('div', { class: 'row gap center' }, font, tcol),
    h('button', { class: 'btn primary sm', onclick: () => addEl('text', { text: txt.value || 'Text', color: tcol.value, font: font.value }) }, icon('type', 15), 'Add text'),
  ], false, 'sec-text');

  // ---- 5 Graphics ----
  const lib = GRAPHIC_LIBRARY;
  const gcol = h('input', { type: 'color', value: '#c0392b', 'aria-label': 'Trim colour' });
  const libGrid = h('div', { class: 'gfx' }, lib.map(g => {
    const b = h('button', { class: 'gfx-item', tip: g.name, 'aria-label': 'Add ' + g.name, onclick: () => {
      const type = g.category === 'crest' ? 'crest' : g.category === 'patch' ? 'patch' : 'graphic';
      addEl(type, g.category === 'stripes' ? { graphicId: g.id, w: 360, h: 170 } : { graphicId: g.id });
    } });
    b.innerHTML = (g.svg || '').replace(/\{\{(c\d)\}\}/g, (_, k) => g.colors?.[k] || '#888');
    return b;
  }));
  const sec5 = section(5, 'Add graphics', 'Crests, stripes, piping and patches are vector shapes you can move, resize and recolour.', [
    libGrid,
    h('div', { class: 'row gap center' }, field('Colour', gcol)),
    h('div', { class: 'chips' },
      h('button', { class: 'chip', onclick: () => addEl('stripe', { color: gcol.value }) }, 'Stripes'),
      h('button', { class: 'chip', onclick: () => addEl('piping', { color: gcol.value }) }, 'Piping'),
      h('button', { class: 'chip', onclick: () => addEl('patch', { bg: gcol.value }) }, 'Patch')),
  ], false, 'sec-graphics');
  function addEl(type, props) {
    const V = activeView();
    if (!V.current) { toast('Load a garment first.', 'info'); return; }
    snapshot();
    const b = V.seg?.bbox;
    const pos = b ? { x: b.x + b.w / 2, y: b.y + b.h * (type === 'text' ? 0.45 : 0.4) } : {};
    const el = createElement(type, { ...props, ...pos, view: S.activeView });
    S.elements.push(el); S.selectedId = el.id; S.ui.tool = 'move';
    markFlow('refined'); notify('elements');
  }

  // layers list (top of the stack first; drag to reorder; the inspector for the selected item is in the right panel)
  const layers = createLayers();
  const secEl = section('•', 'Layers on this view', 'Everything you added, top of the stack first. Click to select, drag to reorder.', layers.el, true, 'sec-layers');
  secEl.classList.add('compact');

  // ---- 6 References ----
  const refIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: e => { A.addReferences([...e.target.files]); e.target.value = ''; } });
  const refGrid = h('div', { class: 'refs' });
  const sec6 = section(6, 'References', 'Keep mood-board images (a fabric, a hem, a colour palette) next to your design. ' + (document.querySelector('meta[name="threadform-shared"][content="1"]') ? 'They are saved with the design in the shared library, so everyone who has the password sees them.' : 'They are saved with the design in this browser and never uploaded.'), [
    h('button', { class: 'btn ghost sm', onclick: () => refIn.click() }, icon('plus', 15), 'Add reference images'), refIn, refGrid,
    h('div', { class: 'muted small' }, 'For your own reference while you design; they do not change the garment.'),
  ], false, 'sec-refs');

  sec3.dataset.level = sec6.dataset.level = secEl.dataset.level = 'advanced';   // Basic mode hides them (CSS), Advanced shows them
  root.append(sec1, sec2, sec3, sec4, sec5, secEl, sec6);

  function sync(reason) {
    const V = activeView();
    const has = !!V.base;
    if (reason === 'loaded') { document.getElementById('sec-upload').open = false; document.getElementById('sec-select').open = true; }
    viewHint.textContent = has ? `Editing the ${state.activeView} view. Use the tabs above the canvas for other views.` : `Uploading to the ${state.activeView} view.`;
    setDisabled(root.querySelector('#btn-removebg'), !has, 'Load a garment first, then you can cut it out of its background again.');
    root.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === S.ui.tool));
    regionBtns.forEach(b => { b.classList.toggle('on', V.regionSel.includes(b.dataset.r)); b.disabled = !has || !V.seg?.regions?.[b.dataset.r]; });
    modeBtns.forEach(b => b.classList.toggle('on', b.dataset.m === S.ui.brushMode));
    brush.value = S.ui.brushSize; brushVal.textContent = S.ui.brushSize + ' px';
    selInfo.textContent = hasMask(V) ? 'Selection active. Only highlighted pixels will change.' : 'Nothing selected yet: the whole garment may change.';
    refGrid.replaceChildren(...S.references.map((c, i) => h('div', { class: 'ref' }, thumbOf(c, 64, '#f3f2ef'), h('button', { class: 'x', 'aria-label': 'Remove reference', onclick: () => A.removeReference(i) }, icon('x', 12)))));
  }
  subscribe(r => { if (r !== 'render' && r !== 'zoom' && r !== 'processing' && r !== 'busy' && r !== 'elements-live') sync(r); });
  sync();
  return { sync };
}
