// Selection UI (owner: selection): the tool bar on the stage (compact in Basic, complete in Advanced), the "Selection" section of the
// left panel (modes, modify, refine, history, overlay, saved selections) and the keyboard shortcuts.
// All state lives in state.ui / selection.js; every control here is a thin binding, and every text is inserted as text.
import { state, activeView, subscribe, notify, hasMask } from './state.js';
import { h, icon, thumbOf, setDisabled, debounce, toast } from './util.js';
import { REGION_NAMES } from './segment.js';
import * as S from './selection.js';
import { retunePick } from './sel-tools.js';
import { recompute } from './ui-actions.js';

const pretty = s => s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const REGION_TIPS = {
  body: 'The main torso panel', leftSleeve: "The garment's left sleeve (right side as you look at it)", rightSleeve: "The garment's right sleeve (left side as you look at it)",
  collar: 'The collar / neckband', neckline: 'The neck opening', cuffs: 'Cuffs at the end of the sleeves', hem: 'The bottom hem', shoulders: 'Shoulder seams and yoke',
  sidePanels: 'Side seams and panels', stripes: 'Existing stripes', logos: 'Existing logos or prints', text: 'Existing lettering', fabric: 'Just the fabric surface (no trims)',
};
const syncs = [];
const track = s => { syncs.push(s); return s; };
const setTool = id => { state.ui.tool = id; notify('tool'); };
const stageApi = () => window.__stage;
const isAdvanced = () => document.body.dataset.mode === 'advanced';

/* ------------------------------------------------------------------ small controls */
function slider({ label, get, set, min, max, step = 1, fmt = v => v + ' px', tip, cls = '', after, level }) {
  const val = h('span', { class: 'val' }), inp = h('input', { type: 'range', min, max, step, 'aria-label': label });
  const row = h('label', { class: 'sl-row ' + cls, tip, 'data-level': level }, h('span', { class: 'lbl' }, label), inp, val);
  inp.addEventListener('input', () => { set(+inp.value); val.textContent = fmt(+inp.value); after?.(+inp.value); });
  const sync = () => { const v = get(); if (document.activeElement !== inp) inp.value = v; val.textContent = fmt(v); };
  sync(); track(sync);
  return row;
}
function numberField({ label, get, set, min, max, step = 1, unit = 'px', tip }) {
  const inp = h('input', { type: 'number', min, max, step, class: 'num', 'aria-label': label, inputmode: 'decimal' });
  const clampV = v => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  const commit = () => { set(clampV(+inp.value)); inp.value = get(); };
  inp.addEventListener('change', commit);
  inp.addEventListener('input', () => { if (inp.value !== '' && Number.isFinite(+inp.value)) set(clampV(+inp.value)); });
  const bump = d => h('button', { type: 'button', class: 'stp', 'aria-label': (d > 0 ? 'Increase ' : 'Decrease ') + label, tip: (d > 0 ? 'More' : 'Less') + ' (' + step + ' ' + unit + ')', onclick: () => { set(clampV(+(get() + d * step).toFixed(2))); inp.value = get(); } }, d > 0 ? '+' : '−');
  const el = h('span', { class: 'numfield', tip }, bump(-1), inp, bump(1), h('span', { class: 'unit' }, unit));
  const sync = () => { if (document.activeElement !== inp) inp.value = get(); };
  sync(); track(sync);
  return el;
}
const check = (label, get, set, tip) => {
  const cb = h('input', { type: 'checkbox', onchange: () => set(cb.checked) });
  track(() => { cb.checked = !!get(); });
  return h('label', { class: 'check', tip }, cb, label);
};
function selectBox(label, opts, get, set, tip) {
  const sel = h('select', { 'aria-label': label, tip, onchange: () => set(sel.value) }, opts.map(([v, t]) => h('option', { value: v }, t)));
  track(() => { sel.value = get(); });
  return sel;
}
const modeGroup = cls => {
  const btns = S.MODES.map(m => h('button', { type: 'button', class: 'seg-btn', 'data-mode': m, 'aria-pressed': 'false', tip: { add: 'Add to the selection', subtract: 'Take away from the selection', intersect: 'Keep only where the new shape overlaps the selection', replace: 'Replace the selection with the new shape' }[m], onclick: () => { state.ui.selMode = m; notify('tool'); } }, S.MODE_LABEL[m]));
  const el = h('div', { class: 'seg ' + cls, role: 'group', 'aria-label': 'How a new shape combines with the selection' }, btns);
  track(() => btns.forEach(b => { const on = b.dataset.mode === state.ui.selMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }));
  return el;
};
const retune = debounce(() => retunePick(), 70);

/* ------------------------------------------------------------------ tool buttons + option sets (used by the stage bar and the panel) */
function toolButtons(cls, attr = 'data-tool') {
  return S.SEL_TOOLS.map(t => {
    const b = h('button', { type: 'button', class: cls, [attr]: t.id, 'aria-pressed': 'false', 'aria-label': t.label, tip: `${t.tip} (${t.key})`, 'data-level': t.basic ? null : 'advanced', onclick: () => setTool(t.id) }, icon(t.icon, 17), h('span', { class: 'tl' }, t.label));
    return b;
  });
}
function regionChips(names = REGION_NAMES, withBoth = true) {
  const btns = names.map(n => h('button', { type: 'button', class: 'chip region', 'data-r': n, 'aria-pressed': 'false', tip: REGION_TIPS[n] || pretty(n), onclick: () => S.toggleRegion(n) }, pretty(n)));
  const both = h('button', { type: 'button', class: 'chip both', 'data-act': 'both-sleeves', tip: 'Select the left and the right sleeve together, then describe the change', onclick: () => S.selectBothSleeves() }, icon('both', 13), 'Both sleeves');
  track(() => { const V = activeView(); btns.forEach(b => { const on = V.regionSel.includes(b.dataset.r); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.disabled = !V.base || !V.seg?.regions?.[b.dataset.r]; }); both.disabled = !V.base || !(V.seg?.regions?.leftSleeve || V.seg?.regions?.rightSleeve); });
  return h('div', { class: 'chips region-chips' }, withBoth ? both : null, btns);
}
const brushSize = () => slider({ label: 'Brush size', get: () => state.ui.brushSize, set: v => { state.ui.brushSize = v; notify('tool'); }, min: 1, max: 240, tip: 'Size in image pixels. [ and ] change it from the keyboard. Zoom in for fine detail.' });
const brushHardness = () => slider({ label: 'Hardness', get: () => Math.round(state.ui.brushHardness * 100), set: v => { state.ui.brushHardness = v / 100; notify('tool'); }, min: 0, max: 100, fmt: v => v + '%', tip: '100% = crisp edge, lower = soft edge', level: 'advanced' });
const tolSlider = (label, key, tip) => slider({ label, get: () => state.ui[key], set: v => { state.ui[key] = v; }, min: 1, max: 100, fmt: v => String(v), tip, after: retune });
function colourPick() {
  const inp = h('input', { type: 'color', 'aria-label': 'Colour to select', tip: 'The colour to select. Click the garment with this tool to pick one.' });
  inp.addEventListener('input', () => { state.ui.pickColor = inp.value; });
  inp.addEventListener('change', () => { state.ui.pickColor = inp.value; S.selectByPickedColor(); });
  const eye = h('button', { type: 'button', class: 'btn ghost sm', 'data-act': 'eyedropper', tip: window.EyeDropper ? 'Pick a colour from anywhere on screen' : 'Click the garment on the canvas to pick its colour', onclick: async () => {
    if (!window.EyeDropper) { setTool('color'); toast('Click the garment on the canvas to pick its colour.', 'info'); return; }
    try { const r = await new window.EyeDropper().open(); state.ui.pickColor = r.sRGBHex; notify('tool'); S.selectByPickedColor(); } catch { /* cancelled */ }
  } }, 'Eyedropper');
  const go = h('button', { type: 'button', class: 'btn ghost sm', 'data-act': 'select-colour', tip: 'Select every pixel of this colour', onclick: () => S.selectByPickedColor() }, 'Select this colour');
  track(() => { if (document.activeElement !== inp) inp.value = state.ui.pickColor; });
  return h('span', { class: 'row gap center wrap' }, inp, eye, go);
}

/* ------------------------------------------------------------------ the bar on the stage */
export function selectionBar() {
  const tools = h('div', { class: 'sb-tools', role: 'toolbar', 'aria-label': 'Selection tools' }, toolButtons('sb-tool'));
  const act = (ic, label, tip, fn, extra = {}) => h('button', { type: 'button', class: 'sb-act', 'aria-label': label, tip, onclick: fn, ...extra }, icon(ic, 16), h('span', { class: 'tl' }, label));
  const undoB = act('undo', 'Undo selection', 'Undo the last selection step (Ctrl+Z while a selection tool is active)', () => S.selUndo(), { 'data-act': 'sel-undo', 'data-level': 'advanced' });
  const redoB = act('redo', 'Redo selection', 'Redo the selection step you undid', () => S.selRedo(), { 'data-act': 'sel-redo', 'data-level': 'advanced' });
  const clearB = act('x', 'Clear', 'Clear the selection (nothing selected)', () => S.clearSelection(), { 'data-act': 'clear' });
  const allB = act('selall', 'Select garment', 'Select the entire garment (Ctrl+A)', () => S.selectEntireGarment(), { 'data-act': 'select-all', 'data-level': 'advanced' });
  const invB = act('invert', 'Invert', 'Swap the selected and the unselected parts of the garment (Ctrl+I)', () => S.invertSelection(), { 'data-act': 'invert', 'data-level': 'advanced' });
  const zoomB = act('zoomSel', 'Zoom to it', 'Zoom the canvas to the selection (Z)', () => stageApi()?.zoomToSelection(), { 'data-act': 'zoom-sel', 'data-level': 'advanced' });
  const eyeB = act('eye', 'Outline', 'Show or hide the selection outline', () => { state.ui.ovl.show = !state.ui.ovl.show; notify('tool'); }, { 'data-act': 'toggle-overlay' });
  const bothB = h('button', { type: 'button', class: 'sb-act accent', 'data-act': 'both-sleeves-bar', tip: 'Select both sleeves at once, then describe the change in the Look tab', onclick: () => S.selectBothSleeves() }, icon('both', 16), h('span', { class: 'tl' }, 'Both sleeves'));
  const modes = modeGroup('sb-modes'); modes.dataset.level = 'advanced';
  for (const b of [bothB, clearB]) b.classList.add('keep');
  const row1 = h('div', { class: 'sb-row' }, tools, h('span', { class: 'sep', 'data-level': 'advanced' }), modes);
  const actions = h('div', { class: 'sb-actions' }, bothB, allB, invB, clearB, h('span', { class: 'sep' }), undoB, redoB, h('span', { class: 'sep', 'data-level': 'advanced' }), zoomB, eyeB);
  // options for the active tool
  const opt = (tools_, ...kids) => h('div', { class: 'sb-opt', 'data-for': tools_.join(' ') }, ...kids);
  const opts = h('div', { class: 'sb-row sb-opts' },
    opt(['brush', 'eraser'], brushSize(), brushHardness()),
    opt(['region'], regionChips(['leftSleeve', 'rightSleeve', 'body', 'collar', 'cuffs', 'stripes', 'logos', 'text'], false)),
    opt(['wand'], tolSlider('Tolerance', 'wandTol', 'How different a colour may be and still be picked up'), check('Contiguous', () => state.ui.wandContig, v => { state.ui.wandContig = v; retune(); }, 'On: only touching pixels. Off: every similar pixel in the image')),
    opt(['color'], colourPick(), tolSlider('Tolerance', 'colorTol', 'How close a colour must be to the picked colour')),
    opt(['texture'], tolSlider('Tolerance', 'texTol', 'How similar the material or weave must be')),
    opt(['move', 'lasso', 'polygon', 'rect', 'component', 'smart'], h('span', { class: 'sb-tip' }, '')));
  const tip = opts.querySelector('.sb-tip');
  const basicTip = h('p', { class: 'sb-basic-tip', 'data-level': 'basic-only' }, h('b', {}, 'To change both sleeves: '), 'choose Click a part, click each sleeve (or press Both sleeves), then describe the change.');
  const root = h('div', { class: 'selbar', id: 'selbar', 'aria-label': 'Select the area to change' }, row1, h('div', { class: 'sb-row sb-lower' }, opts, actions), basicTip);
  track(() => {
    const V = activeView(), t = state.ui.tool, st = S.isSelTool(t);
    tools.querySelectorAll('.sb-tool').forEach(b => { const on = b.dataset.tool === t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    opts.querySelectorAll('.sb-opt').forEach(o => { const f = o.dataset.for.split(' ').includes(t); o.hidden = !f; });
    const info = S.selHistInfo();
    setDisabled(undoB, !info.canUndo, 'Nothing to undo in the selection yet');
    setDisabled(redoB, !info.canRedo, 'Nothing to redo in the selection');
    const has = hasMask(V);
    setDisabled(clearB, !has && !V.regionSel.length, 'Nothing is selected');
    setDisabled(zoomB, !has, 'Select an area first');
    setDisabled(invB, !V.seg, 'Needs the garment outline');
    setDisabled(allB, !V.seg, 'Needs the garment outline');
    eyeB.classList.toggle('on', !state.ui.ovl.show); eyeB.setAttribute('aria-pressed', String(!state.ui.ovl.show));
    eyeB.querySelector('.tl').textContent = state.ui.ovl.show ? 'Hide outline' : 'Show outline';
    tip.textContent = st ? S.selToolHint(t) : 'Pick a selection tool above to mark the part you want to change, then describe the change.';
    root.dataset.tool = t;
    root.dataset.has = has ? '1' : '0';
  });
  return root;
}

/* ------------------------------------------------------------------ left panel section */
export function selectionSection({ section }) {
  const V0 = () => activeView();
  const modes = modeGroup('');
  const toolGrid = h('div', { class: 'tool-grid', role: 'group', 'aria-label': 'Selection tools' }, toolButtons('ptool', 'data-ptool'));
  const readout = h('div', { class: 'readout', id: 'sel-readout', role: 'status', 'aria-live': 'polite' });
  const selInfo = h('div', { class: 'muted small', id: 'sel-info' });

  // modify
  const featherN = numberField({ label: 'Feather amount', get: () => state.ui.feather, set: v => { state.ui.feather = v; }, min: 0, max: 100, tip: 'Soften the edge of the selection over this many pixels' });
  const growN = numberField({ label: 'Expand or contract amount', get: () => state.ui.grow, set: v => { state.ui.grow = v; }, min: 0, max: 200, tip: 'How many pixels to grow or shrink the selection by' });
  const smoothN = numberField({ label: 'Smooth amount', get: () => state.ui.smoothPx, set: v => { state.ui.smoothPx = v; }, min: 0, max: 60, tip: 'Round off jagged corners and specks' });
  const btn = (txt, act, tip, fn, cls = 'btn ghost sm') => h('button', { type: 'button', class: cls, 'data-act': act, tip, onclick: fn }, txt);
  const modify = h('div', { class: 'modify' },
    h('div', { class: 'mrow' }, h('span', { class: 'lbl' }, 'Feather'), featherN, btn('Apply', 'feather', 'Feather the selection edge', () => S.featherSelection(state.ui.feather))),
    h('div', { class: 'mrow' }, h('span', { class: 'lbl' }, 'Grow / shrink'), growN, btn('Expand', 'expand', 'Make the selection bigger by this many pixels', () => S.expandSelection(state.ui.grow)), btn('Contract', 'contract', 'Make the selection smaller by this many pixels', () => S.contractSelection(state.ui.grow))),
    h('div', { class: 'mrow' }, h('span', { class: 'lbl' }, 'Smooth'), smoothN, btn('Apply', 'smooth', 'Round off corners and specks', () => S.smoothSelection(state.ui.smoothPx))));

  // refine edges (live preview, then apply)
  const applyR = btn('Apply refinement', 'refine-apply', 'Keep the refined edge', () => S.applyRefine(), 'btn primary sm');
  const cancelR = btn('Cancel', 'refine-cancel', 'Go back to the edge you had', () => S.cancelRefine());
  const refineBox = h('div', { class: 'refine' },
    slider({ label: 'Edge radius', get: () => state.ui.refine.radius, set: v => { state.ui.refine.radius = v; S.refinePreview(); }, min: 1, max: 40, tip: 'How far from the edge the selection may snap to the picture' }),
    slider({ label: 'Strength', get: () => state.ui.refine.strength, set: v => { state.ui.refine.strength = v; S.refinePreview(); }, min: 0, max: 100, fmt: v => v + '%', tip: '0 = leave the edge alone, 100 = snap fully to the picture edges' }),
    h('div', { class: 'row gap wrap' }, btn('Preview', 'refine-preview', 'Show the refined edge on the canvas before you keep it', () => S.refinePreview()), applyR, cancelR));
  track(() => { const on = S.refine.active; applyR.hidden = cancelR.hidden = !on; });

  // history
  const histInfo = h('span', { class: 'muted small', id: 'sel-hist-info' });
  const undoB = btn('Undo selection', 'sel-undo', 'Undo the last selection step', () => S.selUndo()), redoB = btn('Redo selection', 'sel-redo', 'Redo the selection step you undid', () => S.selRedo());

  // overlay
  const overlay = h('div', { class: 'ovl' },
    check('Show selection outline', () => state.ui.ovl.show, v => { state.ui.ovl.show = v; notify('tool'); }, 'Show or hide the marching-ants outline and tint'),
    h('div', { class: 'row gap center wrap' }, h('span', { class: 'lbl' }, 'Look'),
      selectBox('Overlay look', [['both', 'Outline + tint'], ['ants', 'Outline only'], ['tint', 'Tint only']], () => state.ui.ovl.style, v => { state.ui.ovl.style = v; notify('tool'); }, 'Outline and tint, outline only, or tint only'),
      selectBox('Overlay view', [['normal', 'Normal'], ['only', 'Dim the rest'], ['mask', 'Black & white mask']], () => state.ui.ovl.view, v => { state.ui.ovl.view = v; notify('tool'); }, 'Normal, dim everything that is not selected, or show the selection as a black and white mask')),
    slider({ label: 'Tint opacity', get: () => state.ui.ovl.opacity, set: v => { state.ui.ovl.opacity = v; notify('tool'); }, min: 0, max: 60, fmt: v => v + '%', tip: 'How strongly the selection is tinted (0-60%)' }),
    h('label', { class: 'field', tip: 'Tint colour' }, h('span', { class: 'lbl' }, 'Tint colour'), (() => { const c = h('input', { type: 'color', 'aria-label': 'Tint colour', oninput: e => { state.ui.ovl.color = e.target.value; notify('tool'); } }); track(() => { c.value = state.ui.ovl.color; }); return c; })()),
    check('Animate the outline', () => state.ui.ovl.animate, v => { state.ui.ovl.animate = v; notify('tool'); }, 'Marching ants'));

  // saved selections
  const nameIn = h('input', { type: 'text', id: 'sel-save-name', maxlength: 60, placeholder: 'Name (optional)', 'aria-label': 'Name for the saved selection' });
  const saveB = btn('Save selection', 'save-sel', 'Keep this selection so you can bring it back later', () => { const s = S.saveSelection(nameIn.value); if (s) { nameIn.value = ''; toast(`Saved "${s.name}".`, 'ok'); } }, 'btn primary sm');
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveB.click(); } e.stopPropagation(); });
  const loadMode = selectBox('Load as', S.MODES.map(m => [m, S.MODE_LABEL[m]]), () => state.ui.savedMode, v => { state.ui.savedMode = v; }, 'How a loaded selection combines with the current one');
  const list = h('ul', { class: 'saved-list', id: 'saved-list', 'aria-label': 'Saved selections' });
  let sig = '';
  const rebuildSaved = () => {
    const V = V0(), items = V.saved || [];
    const s2 = state.activeView + '|' + items.map(s => s.id + ':' + s.name).join('|');
    if (s2 === sig) return; sig = s2;
    if (!items.length) { list.replaceChildren(h('li', { class: 'muted small sv-empty' }, 'No saved selections on this view yet.')); return; }
    list.replaceChildren(...items.map(s => {
      const nm = h('span', { class: 'sv-name', tabindex: 0, role: 'button', 'aria-label': 'Load ' + s.name, tip: 'Load this selection', onclick: () => S.loadSaved(s.id), onkeydown: e => { if (e.key === 'Enter') S.loadSaved(s.id); } }, s.name);
      const th = h('span', { class: 'sv-thumb' }, savedThumb(V, s));
      const mini = (ic, tip, fn, act) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': tip + ': ' + s.name, 'data-act': act, tip, onclick: fn }, icon(ic, 15));
      const row = h('li', { class: 'sv-row', 'data-id': s.id }, th, nm,
        h('button', { type: 'button', class: 'btn ghost sm', 'data-act': 'load', tip: 'Load this selection (uses the "Load as" setting)', onclick: () => S.loadSaved(s.id) }, 'Load'),
        mini('pencil', 'Rename', () => startRename(row, nm, s), 'rename'), mini('trash', 'Delete', () => S.deleteSaved(s.id), 'delete'));
      return row;
    }));
  };
  function startRename(row, nm, s) {
    const inp = h('input', { type: 'text', class: 'sv-edit', value: s.name, maxlength: 60, 'aria-label': 'New name' });
    let done = false;
    const finish = ok => { if (done) return; done = true; if (ok) S.renameSaved(s.id, inp.value); sig = ''; rebuildSaved(); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    nm.replaceWith(inp); inp.focus(); inp.select();
  }
  function savedThumb(V, s) {
    const c = thumbOf(V.current, 56, '#f3f2ef'), x = c.getContext('2d'), m = thumbOf(s.canvas, 56);
    const mx = m.getContext('2d'); mx.globalCompositeOperation = 'source-in'; mx.fillStyle = 'rgb(79,70,229)'; mx.fillRect(0, 0, 56, 56);
    x.globalAlpha = 0.7; x.drawImage(m, 0, 0); c.setAttribute('role', 'img'); c.setAttribute('aria-label', s.name + ' thumbnail');
    return c;
  }

  const limitTog = h('input', { type: 'checkbox', onchange: e => { state.ui.limitToSelection = e.target.checked; recompute(); } });
  track(() => { limitTog.checked = !!state.ui.limitToSelection; });

  const sec = section(3, 'Select garment areas', 'Choose the part you want to change, with real selection tools. Only the selected pixels are edited. Hold Shift to add, Alt to subtract.', [
    h('div', { class: 'lbl' }, 'Tools'), toolGrid,
    h('div', { class: 'lbl' }, 'How a new shape combines'), modes,
    h('div', { class: 'muted small' }, 'Shortcuts: Shift adds, Alt (Option) subtracts, Shift + Alt keeps the overlap.'),
    h('div', { class: 'optbox' }, brushSize(), brushHardness(), tolSlider('Wand tolerance', 'wandTol', 'How different a colour may be and still be picked up'),
      check('Wand: contiguous only', () => state.ui.wandContig, v => { state.ui.wandContig = v; retune(); }, 'On: only touching pixels. Off: every similar pixel in the image'),
      tolSlider('Colour tolerance', 'colorTol', 'How close a colour must be to the picked colour'), colourPick(), tolSlider('Material tolerance', 'texTol', 'How similar the material or weave must be')),
    h('div', { class: 'lbl' }, 'Garment parts (select several, e.g. both sleeves)'), regionChips(),
    h('div', { class: 'row gap wrap' },
      btn('Select garment', 'select-all', 'Select the entire garment (Ctrl+A)', () => S.selectEntireGarment()),
      btn('Invert', 'invert', 'Swap selected and unselected (Ctrl+I)', () => S.invertSelection()),
      btn('Clear', 'clear', 'Clear the selection', () => S.clearSelection()),
      btn('Zoom to selection', 'zoom-sel', 'Zoom the canvas to the selection (Z)', () => stageApi()?.zoomToSelection())),
    readout,
    h('div', { class: 'lbl' }, 'Modify the selection'), modify,
    h('details', { class: 'sub', id: 'sel-refine' }, h('summary', {}, 'Refine edges'), refineBox),
    h('div', { class: 'row gap center wrap' }, undoB, redoB, histInfo),
    h('details', { class: 'sub', id: 'sel-overlay' }, h('summary', {}, 'Outline and tint'), overlay),
    h('div', { class: 'lbl' }, 'Saved selections'),
    h('div', { class: 'row gap center wrap' }, nameIn, saveB),
    h('div', { class: 'row gap center' }, h('span', { class: 'lbl' }, 'Load as'), loadMode),
    list,
    h('label', { class: 'check', tip: 'When on, shape sliders, colour and fabric also only change the selected area.' }, limitTog, 'Limit sliders & colour to the selection'),
    selInfo,
  ], false, 'sec-select');

  track(() => {
    const V = V0(), t = state.ui.tool;
    toolGrid.querySelectorAll('.ptool').forEach(b => { const on = b.dataset.ptool === t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const info = S.selHistInfo();
    setDisabled(undoB, !info.canUndo, 'Nothing to undo in the selection yet'); setDisabled(redoB, !info.canRedo, 'Nothing to redo in the selection');
    histInfo.textContent = info.count > 1 ? `Step ${info.index} of ${info.count - 1}` : '';
    const has = hasMask(V), st = S.selectionStats(V);
    readout.textContent = !has ? 'Nothing selected.' : `Selected ${st.pct != null ? st.pct.toFixed(1) + '% of the garment' : st.area + ' px'} · ${st.bounds ? `${st.bounds.w} × ${st.bounds.h} px at (${st.bounds.x}, ${st.bounds.y})` : ''}`;
    readout.dataset.pct = st.pct != null ? st.pct.toFixed(2) : ''; readout.dataset.w = st.bounds?.w ?? 0; readout.dataset.h = st.bounds?.h ?? 0; readout.dataset.x = st.bounds?.x ?? 0; readout.dataset.y = st.bounds?.y ?? 0;
    selInfo.textContent = has ? 'Selection active. Only highlighted pixels will change.' : 'Nothing selected yet: the whole garment may change.';
    rebuildSaved();
  });
  return sec;
}

/* ------------------------------------------------------------------ keyboard */
export function initSelectionKeys() {
  const KEYS = Object.fromEntries(S.SEL_TOOLS.map(t => [t.key.toLowerCase(), t.id])); KEYS.v = 'move';
  window.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if (typing || document.querySelector('.app')?.hidden || document.querySelector('dialog[open], .tour')) return;
    const tool = state.ui.tool, st = S.isSelTool(tool), mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z' && st) {
      if (e.shiftKey ? S.selRedo() : S.selUndo()) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    if (mod && k === 'y' && st) { if (S.selRedo()) { e.preventDefault(); e.stopImmediatePropagation(); } return; }
    if (mod && !e.altKey && k === 'a' && st) { e.preventDefault(); S.selectEntireGarment(); return; }
    if (mod && !e.altKey && k === 'i' && st) { e.preventDefault(); S.invertSelection(); return; }
    if (mod && e.shiftKey && k === 'a' && st) { e.preventDefault(); S.clearSelection(); return; }
    if (mod || e.altKey) return;
    if (!activeView().current) return;
    if (e.key === '[' || e.key === ']') {
      if (!st) return;
      const s = state.ui.brushSize, step = Math.max(1, Math.round(s * 0.12));
      state.ui.brushSize = Math.max(1, Math.min(240, s + (e.key === ']' ? step : -step))); e.preventDefault(); notify('tool'); return;
    }
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); stageApi()?.zoomToSelection(); return; }
    if (KEYS[k] && !e.shiftKey && (e.key.length === 1)) {
      if (KEYS[k] !== 'move' && !isAdvanced() && !S.SEL_TOOLS.find(t => t.id === KEYS[k])?.basic) return;   // Basic only offers its own tools
      e.preventDefault(); setTool(KEYS[k]);
    }
  }, true);
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live', 'compare'].includes(r)) for (const s of syncs) { try { s(); } catch (err) { console.error(err); } } });
  for (const s of syncs) { try { s(); } catch (err) { console.error(err); } }
}
