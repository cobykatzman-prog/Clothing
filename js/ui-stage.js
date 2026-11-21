// Centre column: view tabs, tool strip, canvas, empty state, busy overlay.
import { state, VIEWS, VIEW_LABELS, activeView, subscribe, notify } from './state.js';
import { h, icon } from './util.js';
import * as A from './ui-actions.js';
import { createStage } from './canvas.js';
import { stageHint } from './manual.js';
import { viewTools } from './ui-look.js';
import { nextStepHint } from './ui-guide.js';
import { selectionBar, initSelectionKeys } from './ui-select.js';
import { initReview } from './ui-review.js';

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
  const toolBtn = (t, ic, label, tip) => h('button', { class: 'tool-i', 'data-tool': t, tip: `${tip}`, 'aria-label': label, onclick: () => { S.ui.tool = t; notify('tool'); } }, icon(ic, 18));
  let stage;
  const act = (ic, label, fn, tip) => h('button', { class: 'tool-i', 'aria-label': label, tip: tip || label, onclick: () => fn() }, icon(ic, 18));
  const zoomLbl = h('button', { type: 'button', class: 'zoomlbl', id: 'zoom-label', 'aria-label': 'Zoom level. Press for 100%', tip: 'Zoom level. Press for actual size (100%)', onclick: () => stage.zoomTo(1) }, '100%');
  const tools = h('div', { class: 'toolstrip' },
    toolBtn('move', 'pointer', 'Move', 'Move: select, drag and resize added text and graphics; drag empty space to pan'),
    h('span', { class: 'sep', 'data-level': 'advanced' }),
    act('zoomOut', 'Zoom out', () => stage.zoomBy(1 / 1.2)), zoomLbl, act('zoomIn', 'Zoom in', () => stage.zoomBy(1.2)),
    act('fit', 'Fit to screen', () => stage.fit(), 'Fit to screen (0)'),
    act('zoomSel', 'Zoom to selection', () => stage.zoomToSelection(), 'Zoom in on the selected area (Z)'),
    act('rotate', 'Rotate view', () => stage.rotateBy(15), 'Rotate the view 15° (does not change the design)'),
    h('button', { class: 'tool-i txt', 'aria-label': 'Reset the view rotation', tip: 'Reset the view rotation', onclick: () => stage.resetRotation() }, '0°'),
    h('span', { class: 'sep' }),
    act('undo', 'Undo', () => A.undo()), act('redo', 'Redo', () => A.redo()));

  // short, context-sensitive hint over the canvas (what the current tool / selection can do)
  const hintEl = h('div', { class: 'stage-hint', id: 'stage-hint', role: 'status', style: { position: 'absolute', left: '12px', bottom: '10px', maxWidth: 'calc(100% - 24px)', pointerEvents: 'none', background: 'rgba(255,255,255,.9)', color: '#4b4b55', fontSize: '12px', padding: '6px 10px', borderRadius: '8px', boxShadow: '0 1px 4px rgba(0,0,0,.08)' }, hidden: true });
  wrap.append(hintEl);
  // rotation and copy look are Advanced; Basic keeps move, zoom, fit and undo / redo (the selection tools have their own bar below)
  [...tools.querySelectorAll('[aria-label="Rotate view"],[aria-label="Reset the view rotation"]')].forEach(b => { b.dataset.level = 'advanced'; });
  root.append(h('div', { class: 'stage-top' }, tabs, tools), nextStepHint(), selectionBar(), h('div', { class: 'stage-look', 'data-level': 'advanced', style: { padding: '0 16px 6px' } }, viewTools()), wrap);
  stage = createStage(cv, wrap);
  window.__stage = stage;
  initReview(wrap);   // review bar (Accept / Reject / Regenerate), compare bar and before / after divider over the canvas

  // drag & drop on whole window
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && f.type.startsWith('image/')) A.loadFile(f); });

  tabs.setAttribute('aria-label', 'Garment views');
  tabs.addEventListener('keydown', e => {
    const all = [...tabs.querySelectorAll('.tab')], i = all.indexOf(document.activeElement);
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (i < 0 || n === undefined) return;
    e.preventDefault(); const t = all[(n + all.length) % all.length]; t.focus(); t.click();
  });
  function sync(r) {
    const V = activeView();
    empty.hidden = !!V.current;
    tabs.querySelectorAll('.tab').forEach(t => { t.classList.toggle('on', t.dataset.v === S.activeView); t.classList.toggle('has', !!S.views[t.dataset.v].current); t.setAttribute('aria-selected', t.dataset.v === S.activeView); t.tabIndex = t.dataset.v === S.activeView ? 0 : -1; });
    tools.querySelectorAll('[data-tool]').forEach(b => { b.classList.toggle('on', S.ui.tool === b.dataset.tool); });
    busyEl.hidden = !S.ui.busy; busyEl.querySelector('span').textContent = S.ui.busyMsg || '';
    procEl.hidden = !S.ui.processing;
    zoomLbl.textContent = Math.round(stage.zoom * 100) + '%';
    if (r === 'loaded') stage.fit();
    const hint = stageHint();
    hintEl.hidden = !hint || !V.current; hintEl.textContent = hint;
    stage.draw();
  }
  subscribe(sync); sync();
  initSelectionKeys();
}
