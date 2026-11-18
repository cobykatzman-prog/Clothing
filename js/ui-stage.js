// Centre column: view tabs, tool strip, canvas, empty state, busy overlay.
import { state, VIEWS, VIEW_LABELS, activeView, subscribe, notify } from './state.js';
import { h, icon } from './util.js';
import * as A from './ui-actions.js';
import { createStage } from './canvas.js';

export function initStage(root) {
  const S = state;
  const cv = h('canvas', { id: 'stage', tabindex: 0, 'aria-label': 'Garment canvas' });
  const wrap = h('div', { class: 'stage-wrap' }, cv);
  const busyEl = h('div', { class: 'busy', hidden: true }, h('div', { class: 'spin' }), h('span', {}));
  const procEl = h('div', { class: 'proc', hidden: true }, h('div', { class: 'spin sm' }), 'Updating…');
  const empty = h('div', { class: 'empty' },
    h('div', { class: 'empty-card' },
      h('div', { class: 'empty-ico' }, icon('layers', 34)),
      h('h2', {}, 'Design your garment'),
      h('p', {}, 'Upload a photo of a garment, or start with a sample. Then pick an area, describe what you want, and compare the options.'),
      h('div', { class: 'row gap center', style: { justifyContent: 'center' } },
        h('button', { class: 'btn primary lg', id: 'btn-try-sample', onclick: () => A.loadSample('tee') }, icon('sparkles', 17), 'Try a sample shirt'),
        h('button', { class: 'btn ghost lg', onclick: () => { const i = h('input', { type: 'file', accept: 'image/*', onchange: e => e.target.files[0] && A.loadFile(e.target.files[0]) }); i.click(); } }, icon('upload', 17), 'Upload image')),
      h('div', { class: 'muted small' }, 'Tip: you can also drag an image onto this window.')));
  wrap.append(empty, busyEl, procEl);

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, VIEWS.map(v => h('button', { class: 'tab', role: 'tab', 'data-v': v, tip: v === 'detail' ? 'A close-up (cuff, collar, print…) of the same design' : `${VIEW_LABELS[v]} view of this design`, onclick: async () => { S.activeView = v; S.selectedId = null; notify('view'); await A.ensureView(v); } }, VIEW_LABELS[v], h('i', { class: 'tdot' }))));
  const toolBtn = (t, ic, label, tip) => h('button', { class: 'tool-i', 'data-tool': t, tip: `${tip}`, 'aria-label': label, onclick: () => { S.ui.tool = t; if (t === 'brush') S.ui.brushMode = 'add'; notify('tool'); } }, icon(ic, 18));
  let stage;
  const act = (ic, label, fn, tip) => h('button', { class: 'tool-i', 'aria-label': label, tip: tip || label, onclick: () => fn() }, icon(ic, 18));
  const zoomLbl = h('span', { class: 'zoomlbl' }, '100%');
  const tools = h('div', { class: 'toolstrip' },
    toolBtn('move', 'pointer', 'Move', 'Move: select, drag and resize added text and graphics; drag empty space to pan'),
    toolBtn('region', 'pick', 'Pick region', 'Pick a garment region by clicking it'),
    toolBtn('brush', 'brush', 'Brush', 'Brush: paint the area to change'),
    h('button', { class: 'tool-i', 'aria-label': 'Eraser', 'data-tool': 'erase', tip: 'Eraser: remove parts of the selection', onclick: () => { S.ui.tool = 'brush'; S.ui.brushMode = 'erase'; notify('tool'); } }, icon('eraser', 18)),
    h('span', { class: 'sep' }),
    act('zoomOut', 'Zoom out', () => stage.zoomBy(1 / 1.2)), zoomLbl, act('zoomIn', 'Zoom in', () => stage.zoomBy(1.2)),
    act('fit', 'Fit to screen', () => stage.fit(), 'Fit to screen'),
    act('rotate', 'Rotate view', () => stage.rotateBy(15), 'Rotate the view 15° (does not change the design)'),
    h('button', { class: 'tool-i txt', tip: 'Reset the view rotation', onclick: () => stage.resetRotation() }, '0°'),
    h('span', { class: 'sep' }),
    act('undo', 'Undo', () => A.undo()), act('redo', 'Redo', () => A.redo()));

  root.append(h('div', { class: 'stage-top' }, tabs, tools), wrap);
  stage = createStage(cv, wrap);
  window.__stage = stage;

  // drag & drop on whole window
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && f.type.startsWith('image/')) A.loadFile(f); });

  function sync(r) {
    const V = activeView();
    empty.hidden = !!V.current;
    tabs.querySelectorAll('.tab').forEach(t => { t.classList.toggle('on', t.dataset.v === S.activeView); t.classList.toggle('has', !!S.views[t.dataset.v].current); t.setAttribute('aria-selected', t.dataset.v === S.activeView); });
    tools.querySelectorAll('[data-tool]').forEach(b => { const t = b.dataset.tool; b.classList.toggle('on', t === 'erase' ? (S.ui.tool === 'brush' && S.ui.brushMode === 'erase') : t === 'brush' ? (S.ui.tool === 'brush' && S.ui.brushMode !== 'erase') : S.ui.tool === t); });
    busyEl.hidden = !S.ui.busy; busyEl.querySelector('span').textContent = S.ui.busyMsg || '';
    procEl.hidden = !S.ui.processing;
    zoomLbl.textContent = Math.round(stage.zoom * 100) + '%';
    if (r === 'loaded') stage.fit();
    cv.style.cursor = S.ui.tool === 'brush' ? 'none' : '';
    stage.draw();
  }
  subscribe(sync); sync();
}
