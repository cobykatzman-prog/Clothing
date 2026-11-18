// Bottom bar: undo/redo, version history drawer, compare, export menu.
import { state, VIEWS, activeView, subscribe, notify, markFlow, pushVersion, restoreVersion } from './state.js';
import { h, icon, toast, makeCanvas, SIZE, canvasToBlob } from './util.js';
import * as A from './ui-actions.js';
import { exportPNG, exportSVG, exportDesignSheet, download } from './export.js';
import { exportMeasureData, measurementsCSV } from './measure.js';
import { openExportDialog } from './export-dialog.js';

const slug = () => (state.name || 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : Math.floor(s / 3600) + ' h ago'; };

export function initBottom(root) {
  const S = state;
  const undoB = h('button', { class: 'btn ghost', tip: 'Undo (Ctrl+Z)', onclick: () => A.undo() }, icon('undo'), 'Undo');
  const redoB = h('button', { class: 'btn ghost', tip: 'Redo (Ctrl+Shift+Z)', onclick: () => A.redo() }, icon('redo'), 'Redo');
  const histB = h('button', { class: 'btn ghost', tip: 'See every saved version and go back to any of them', onclick: () => toggleDrawer() }, icon('history'), 'Version history');
  const cmpB = h('button', { class: 'btn ghost', id: 'btn-compare', tip: 'Drag the slider to compare the original (left) with your edit (right)', onclick: () => { S.ui.compare = !S.ui.compare; if (S.ui.compare) markFlow('compared'); notify('compare'); } }, icon('compare'), 'Compare before / after');
  const saveB = h('button', { class: 'btn ghost', tip: 'Save a named checkpoint you can return to', onclick: () => { const n = prompt('Name this version', 'My checkpoint'); if (n) { pushVersion(n); toast('Version saved.', 'ok'); } } }, icon('save'), 'Save version');

  // export menu
  const menu = h('div', { class: 'menu', role: 'menu', hidden: true });
  const item = (label, sub, fn) => h('button', { class: 'menu-item', role: 'menuitem', onclick: async () => { menu.hidden = true; try { await fn(); markFlow('exported'); } catch (e) { console.error(e); toast('Export failed: ' + e.message, 'error'); } } }, h('b', {}, label), h('span', {}, sub));
  const V = () => activeView();
  const png = (scale, transparent, suffix) => async () => {
    if (!V().current) throw new Error('Nothing to export yet');
    const blob = await exportPNG({ baseCanvas: V().current, elements: S.elements, view: S.activeView, scale, transparent });
    download(blob, `${slug()}-${S.activeView}${suffix}.png`);
  };
  async function frontBack() {
    const names = ['front', 'back'].filter(n => S.views[n].current);
    if (!names.length) throw new Error('Nothing to export yet');
    const c = makeCanvas(SIZE * names.length, SIZE); const x = c.getContext('2d');
    for (let i = 0; i < names.length; i++) {
      const b = await exportPNG({ baseCanvas: S.views[names[i]].current, elements: S.elements, view: names[i], scale: 1, transparent: true });
      const bmp = await createImageBitmap(b); x.drawImage(bmp, i * SIZE, 0, SIZE, SIZE);
    }
    download(await canvasToBlob(c), `${slug()}-front-back.png`);
  }
  menu.append(
    h('button', { class: 'menu-item', role: 'menuitem', id: 'btn-custom-export', onclick: () => { menu.hidden = true; openExportDialog(); } }, h('b', {}, 'Custom export…'), h('span', {}, 'Format, size, background, elements and design-sheet options')),
    item('PNG', '1024 px, white background', png(1, false, '')),
    item('High-res PNG 2×', '2048 px', png(2, false, '@2x')),
    item('High-res PNG 4×', '4096 px, for print', png(4, false, '@4x')),
    item('Transparent PNG', 'No background', png(1, true, '-transparent')),
    item('SVG graphics', 'Editable vector text, logos, trims', async () => { download(exportSVG({ elements: S.elements, view: S.activeView }), `${slug()}-${S.activeView}.svg`); }),
    item('Front + back', 'Both views side by side', frontBack),
    item('Measurements (CSV)', 'Approximate flat measurements: original, edited, change', async () => {
      const d = exportMeasureData(S, S.activeView); if (!d) throw new Error('Nothing to measure yet');
      download(new Blob([measurementsCSV(d, { design: S.name, view: S.activeView })], { type: 'text/csv' }), `${slug()}-${S.activeView}-measurements.csv`);
    }),
    item('Design sheet', 'Specs, swatches, all views', async () => {
      const views = {}; for (const n of VIEWS) if (S.views[n].current) views[n] = S.views[n].current;
      const params = {}; for (const n of VIEWS) params[n] = { ...S.views[n].params };
      const blob = await exportDesignSheet({ views, elements: S.elements, params: params[S.activeView], paramsByView: params, notes: S.ui.notes || S.ui.prompt || '', name: S.name, fabric: V().fabric.name, measurements: exportMeasureData(S, S.activeView) });
      download(blob, `${slug()}-design-sheet.png`);
    }));
  const expB = h('button', { class: 'btn primary', id: 'btn-export', 'aria-haspopup': 'menu', onclick: e => { e.stopPropagation(); menu.hidden = !menu.hidden; } }, icon('download'), 'Export', icon('chevron', 14));
  document.addEventListener('click', () => { menu.hidden = true; });
  const expWrap = h('div', { class: 'menu-wrap' }, expB, menu);

  // history drawer
  const list = h('div', { class: 'vlist' });
  const drawer = h('aside', { class: 'drawer', id: 'drawer', 'aria-label': 'Version history' },
    h('div', { class: 'drawer-head' }, h('b', {}, 'Version history'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => toggleDrawer(false) }, icon('x'))),
    h('div', { class: 'muted small' }, 'Every upload and accepted option is saved. Click one to restore it (you can undo that too).'), list);
  function toggleDrawer(on) { drawer.classList.toggle('open', on ?? !drawer.classList.contains('open')); renderVersions(); }
  function renderVersions() {
    list.replaceChildren(...(S.versions.length ? S.versions.map(v => h('button', { class: 'vitem', onclick: () => { restoreVersion(v.id); toast('Restored “' + v.label + '”', 'ok'); } },
      v.thumb ? h('img', { src: v.thumb, alt: '' }) : h('span', { class: 'ph' }), h('span', { class: 'vt' }, h('b', {}, v.label), h('span', { class: 'muted small' }, `${v.view} · ${ago(v.time)}`)))) : [h('div', { class: 'muted small' }, 'No versions yet.')]));
  }
  document.body.append(drawer);

  root.append(h('div', { class: 'bar-left' }, undoB, redoB, h('span', { class: 'sep' }), histB, saveB), h('div', { class: 'bar-mid' }, cmpB), h('div', { class: 'bar-right' }, expWrap));
  function sync() {
    undoB.disabled = !S.undoStack.length; redoB.disabled = !S.redoStack.length;
    const has = !!activeView().current;
    cmpB.classList.toggle('on', S.ui.compare); cmpB.disabled = !has; expB.disabled = !has;
    if (drawer.classList.contains('open')) renderVersions();
  }
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live'].includes(r)) sync(); }); sync();
  window.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && document.activeElement.type !== 'range') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? A.redo() : A.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); A.redo(); }
  });
}
