// Bottom bar: undo/redo, version history drawer, compare, export menu.
import { state, VIEWS, activeView, subscribe, notify, markFlow, pushVersion, restoreVersion } from './state.js';
import { h, icon, toast, makeCanvas, SIZE, canvasToBlob, friendly, userError, setDisabled } from './util.js';
import * as A from './ui-actions.js';
import { exportPNG, exportSVG, exportDesignSheet, download } from './export.js';
import { exportMeasureData, measurementsCSV, manufacturerSpecCSV, gradedMeasurementCSV } from './measure.js';
import { exportSpecCSV, printSpec } from './ui-spec.js';
import { openExportDialog } from './export-dialog.js';
import { editControls, editHistoryPanel } from './ui-review.js';

const slug = () => (state.name || 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : Math.floor(s / 3600) + ' h ago'; };

export function initBottom(root) {
  const S = state;
  const undoB = h('button', { class: 'btn ghost', id: 'btn-undo', tip: 'Undo (Ctrl+Z)', onclick: () => A.undo() }, icon('undo'), 'Undo');
  const redoB = h('button', { class: 'btn ghost', id: 'btn-redo', tip: 'Redo (Ctrl+Shift+Z)', onclick: () => A.redo() }, icon('redo'), 'Redo');
  const histB = h('button', { class: 'btn ghost', 'data-level': 'advanced', 'aria-expanded': 'false', 'aria-controls': 'drawer', tip: 'See every saved version and go back to any of them', onclick: () => toggleDrawer() }, icon('history'), 'Version history');
  const cmpB = h('button', { class: 'btn ghost', id: 'btn-compare', tip: 'Compare the garment before and after: a slider, side by side, flip, or hold to see the before', onclick: () => { S.ui.compare = !S.ui.compare; if (S.ui.compare) markFlow('compared'); notify('compare'); } }, icon('compare'), 'Compare before / after');
  const saveB = h('button', { class: 'btn ghost', 'data-level': 'advanced', tip: 'Save a named checkpoint you can return to', onclick: () => { const n = prompt('Name this version', 'My checkpoint'); if (n) { pushVersion(n); toast('Version saved.', 'ok'); } } }, icon('save'), 'Save version');

  // export menu
  const menu = h('div', { class: 'menu', role: 'menu', hidden: true });
  const item = (label, sub, fn) => h('button', { class: 'menu-item', role: 'menuitem', onclick: async () => { menu.hidden = true; try { await fn(); markFlow('exported'); } catch (e) { console.error(e); toast(friendly(e, 'The export did not work. Try another format, or use Custom export with a smaller size.'), 'error', 5000); } } }, h('b', {}, label), h('span', {}, sub));
  const V = () => activeView();
  const png = (scale, transparent, suffix) => async () => {
    if (!V().current) throw userError('Nothing to export yet. Pick a sample, upload or generate a garment first.');
    const blob = await exportPNG({ baseCanvas: V().current, elements: S.elements, view: S.activeView, scale, transparent });
    download(blob, `${slug()}-${S.activeView}${suffix}.png`);
  };
  async function frontBack() {
    const names = ['front', 'back'].filter(n => S.views[n].current);
    if (!names.length) throw userError('Nothing to export yet. Pick a sample, upload or generate a garment first.');
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
      const d = exportMeasureData(S, S.activeView); if (!d) throw userError('Nothing to measure yet. Load a garment first.');
      download(new Blob([measurementsCSV(d, { design: S.name, view: S.activeView })], { type: 'text/csv' }), `${slug()}-${S.activeView}-measurements.csv`);
    }),
    item('Manufacturer spec (cm CSV)', 'Point-of-measure codes, flat measurements and factory sign-off fields', async () => {
      const view = S.views.front?.current ? 'front' : S.activeView;
      const d = exportMeasureData(S, view, { unit: 'cm' }); if (!d) throw userError('Nothing to measure yet. Load or generate a garment first.');
      download(new Blob([manufacturerSpecCSV(d, { design: S.name, view })], { type: 'text/csv;charset=utf-8' }), `${slug()}-manufacturer-spec-cm.csv`);
    }),
    item('Graded size chart (XS–XXL CSV)', 'Estimated size run using the selected size as the base', async () => {
      const view = S.views.front?.current ? 'front' : S.activeView;
      const d = exportMeasureData(S, view); if (!d) throw userError('Load a Front or Back garment view before exporting a graded size chart.');
      download(new Blob([gradedMeasurementCSV(d, { design: S.name, view })], { type: 'text/csv;charset=utf-8' }), `${slug()}-graded-size-chart.csv`);
    }),
    item('Measurement spec (CSV, labelled)', 'All 9 points of measure, sizes XS–XXL, tolerances, calibrated / manual / estimated status', async () => { exportSpecCSV(); }),
    item('Measurement spec (print)', 'Printable table; use Save as PDF in the print dialog', async () => { printSpec(); }),
    item('Design sheet', 'Specs, swatches, all views', async () => {
      const views = {}; for (const n of VIEWS) if (S.views[n].current) views[n] = S.views[n].current;
      const params = {}; for (const n of VIEWS) params[n] = { ...S.views[n].params };
      const blob = await exportDesignSheet({ views, elements: S.elements, params: params[S.activeView], paramsByView: params, notes: S.ui.notes || S.ui.prompt || '', name: S.name, fabric: V().fabric.name, measurements: exportMeasureData(S, S.activeView) });
      download(blob, `${slug()}-design-sheet.png`);
    }));
  const expB = h('button', { class: 'btn primary', id: 'btn-export', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'export-menu', tip: 'Download your design', onclick: e => { e.stopPropagation(); setMenu(menu.hidden); } }, icon('download'), 'Export', icon('chevron', 14));
  menu.id = 'export-menu';
  function setMenu(open, focusBtn = false) {
    menu.hidden = !open; expB.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('.menu-item')?.focus();
    else if (focusBtn) expB.focus();
  }
  new MutationObserver(() => expB.setAttribute('aria-expanded', String(!menu.hidden))).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('click', () => { menu.hidden = true; });
  // keyboard: arrows move through the menu, Escape closes it and returns to the Export button
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('.menu-item')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(false, true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') setMenu(false);
  });
  const expWrap = h('div', { class: 'menu-wrap' }, expB, menu);

  // history drawer: two tabs, Versions (uploads, accepted options, saved checkpoints) and Edit history (review.js / ui-review.js)
  const list = h('div', { class: 'vlist' });
  const edits = editHistoryPanel();
  edits.el.hidden = true;
  const tabVers = h('button', { type: 'button', class: 'dtab on', role: 'tab', id: 'dtab-versions', 'aria-selected': 'true', 'aria-controls': 'drawer-body', tip: 'Every upload, accepted option and saved checkpoint. Click one to go back to it.', onclick: () => showDrawerTab('versions') }, 'Versions');
  const tabEdits = h('button', { type: 'button', class: 'dtab', role: 'tab', id: 'dtab-edits', 'aria-selected': 'false', 'aria-controls': 'drawer-body', tip: 'Every accepted edit, with its before and after. Revert to any stage without losing anything.', onclick: () => showDrawerTab('edits') }, 'Edit history');
  const versNote = h('div', { class: 'muted small', id: 'drawer-note' }, 'Every upload and accepted option is saved. Click one to restore it (you can undo that too).');
  function showDrawerTab(k) {
    const v = k === 'versions';
    tabVers.classList.toggle('on', v); tabVers.setAttribute('aria-selected', String(v));
    tabEdits.classList.toggle('on', !v); tabEdits.setAttribute('aria-selected', String(!v));
    list.hidden = !v; edits.el.hidden = v;
    versNote.hidden = !v;
    if (v) renderVersions();
  }
  const drawer = h('aside', { class: 'drawer', id: 'drawer', 'aria-label': 'Version history and edit history' },
    h('div', { class: 'drawer-head' }, h('b', {}, 'History'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => toggleDrawer(false) }, icon('x'))),
    h('div', { class: 'dtabs', role: 'tablist', 'aria-label': 'History' }, tabVers, tabEdits),
    versNote, list, edits.el);
  function toggleDrawer(on) {
    const open = on ?? !drawer.classList.contains('open');
    drawer.classList.toggle('open', open); histB.setAttribute('aria-expanded', String(open)); renderVersions();
    if (open) drawer.querySelector('button')?.focus();
  }
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toggleDrawer(false); histB.focus(); } });
  function renderVersions() {
    list.replaceChildren(...(S.versions.length ? S.versions.map(v => h('button', { class: 'vitem', onclick: () => { restoreVersion(v.id); toast('Restored “' + v.label + '”', 'ok'); } },
      v.thumb ? h('img', { src: v.thumb, alt: '' }) : h('span', { class: 'ph' }), h('span', { class: 'vt' }, h('b', {}, v.label), h('span', { class: 'muted small' }, `${v.view} · ${ago(v.time)}`)))) : [h('div', { class: 'muted small' }, 'No versions yet.')]));
  }
  document.body.append(drawer);

  const [undoEB, redoEB] = editControls();
  root.append(h('div', { class: 'bar-left' }, undoB, redoB, h('span', { class: 'sep' }), undoEB, redoEB, h('span', { class: 'sep' }), histB, saveB), h('div', { class: 'bar-mid' }, cmpB), h('div', { class: 'bar-right' }, expWrap));
  function sync() {
    setDisabled(undoB, !S.undoStack.length, 'Nothing to undo yet');
    setDisabled(redoB, !S.redoStack.length, 'Nothing to redo: redo brings back a step you undid');
    const has = !!activeView().current;
    cmpB.classList.toggle('on', S.ui.compare); cmpB.setAttribute('aria-pressed', String(!!S.ui.compare));
    setDisabled(cmpB, !has, 'Load a garment first, then compare the original with your edit');
    setDisabled(expB, !has, 'Nothing to export yet: pick a sample, upload a photo or generate a garment first');
    if (drawer.classList.contains('open')) renderVersions();
  }
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live'].includes(r)) sync(); }); sync();
  window.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && document.activeElement.type !== 'range') return;
    if (e.altKey) return;   // Ctrl+Alt+Z is undo / redo of the last accepted edit (ui-review.js)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? A.redo() : A.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); A.redo(); }
  });
}
