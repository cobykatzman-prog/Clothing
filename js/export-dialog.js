// Export dialog (owner: export/design). Opened from the Export menu ("Custom export...").
// Format (PNG, SVG, front and back images, design sheet), view, scale (1x, 2x, 4x or custom), background
// (transparent, white or any colour), design elements on/off, and design-sheet options (views, title, notes, specs).
// A live preview shows the garment as it will export, the pixel size and an estimated file size.
import { state, VIEWS, VIEW_LABELS, markFlow } from './state.js';
import { h, icon, toast, SIZE, canvasToBlob } from './util.js';
import { exportMeasureData } from './measure.js';
import { exportPNG, exportSVG, exportDesignSheet, exportViewImages, previewCanvas, download, downloadAll, sheetSize, SHEET_SECTIONS } from './export.js';

const FORMATS = [
  ['png', 'PNG image', 'One view as a PNG, with the size and background you choose.'],
  ['svg', 'SVG (editable)', 'One view as vector SVG: text, logos and trims stay editable.'],
  ['fb', 'Front and back', 'Two PNG files, front and back, the same size and background.'],
  ['sheet', 'Design sheet', 'One PNG sheet with the views, specs, colour palette and notes.'],
];
const SCALES = [['1', '1×'], ['2', '2×'], ['4', '4×'], ['custom', 'Custom']];

// options are remembered for the rest of the session
const last = {
  format: 'png', view: 'front', scale: '1', custom: 2, bg: 'transparent', bgColor: '#ffffff',
  elements: true, measure: false, svgGarment: false, sheetScale: '1', title: null, notes: null,
  sections: Object.fromEntries(SHEET_SECTIONS.map(([k]) => [k, true])),
  sheetViews: Object.fromEntries(VIEWS.map(v => [v, true])),
};
const slugOf = s => (s || 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
const fmtBytes = b => b < 1024 ? b + ' B' : b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB' : (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const bgValue = () => (last.bg === 'transparent' ? 'transparent' : last.bg === 'white' ? '#ffffff' : last.bgColor);
const scaleValue = () => clamp(last.scale === 'custom' ? +last.custom || 1 : +last.scale, 0.25, 4);
const sheetScaleValue = () => +last.sheetScale;
const hasView = v => !!state.views[v].current;
const activeOrFirst = () => (hasView(state.activeView) ? state.activeView : VIEWS.find(hasView));

/** Pixel size and file count of the current choice. */
export function exportInfo() {
  const f = last.format;
  if (f === 'svg') return { w: SIZE, h: SIZE, files: 1, vector: true };
  if (f === 'sheet') { const { w, h: hh } = sheetSize(sheetScaleValue()); return { w, h: hh, files: 1 }; }
  const s = scaleValue(), w = Math.round(SIZE * s);
  if (f === 'fb') return { w: w * 2, h: w, files: 2 };
  return { w, h: w, files: 1 };
}

function chipRow(items, isOn, onPick, cls = 'chip') {
  const btns = items.map(([key, label]) => h('button', { type: 'button', class: cls, 'data-key': key, 'aria-pressed': 'false', onclick: () => onPick(key) }, label));
  return { el: h('div', { class: 'chips xchips' }, btns), paint: () => btns.forEach((b, i) => { const on = isOn(items[i][0]); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }) };
}
const field = (label, control, tip) => h('label', { class: 'field xfield', tip }, h('span', { class: 'lbl' }, label), control);
const check = (label, get, set, tip) => { const cb = h('input', { type: 'checkbox', onchange: () => { set(cb.checked); refresh(); } }); return { el: h('label', { class: 'check', tip }, cb, label), paint: () => { cb.checked = !!get(); } }; };

let dlg, previewEl = null, refresh = () => { };

/** Opens the export dialog for the current design. */
export function openExportDialog() {
  if (!VIEWS.some(hasView)) { toast('Load a garment first.', 'info'); return; }
  if (dlg) return;
  const S = state;
  const paints = [];
  const add = c => { paints.push(c.paint); return c.el; };

  // ---- format
  const fmtRow = chipRow(FORMATS.map(([k, l]) => [k, l]), k => last.format === k, k => { last.format = k; refresh(); });
  const fmtHint = h('div', { class: 'muted small' });

  // ---- image options (png, svg, front and back)
  const viewSel = h('select', { 'aria-label': 'View', onchange: e => { last.view = e.target.value; refresh(); } },
    VIEWS.map(v => h('option', { value: v }, VIEW_LABELS[v] + (hasView(v) ? '' : ' (no image yet)'))));
  const scaleRow = chipRow(SCALES, k => last.scale === k, k => { last.scale = k; refresh(); });
  const customIn = h('input', { type: 'number', min: 0.25, max: 4, step: 0.25, value: last.custom, 'aria-label': 'Custom scale', class: 'xnum', oninput: e => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) { last.custom = n; last.scale = 'custom'; refresh(); } } });
  const bgRow = chipRow([['transparent', 'Transparent'], ['white', 'White'], ['custom', 'Colour']], k => last.bg === k, k => { last.bg = k; refresh(); });
  const bgColor = h('input', { type: 'color', value: last.bgColor, 'aria-label': 'Background colour', oninput: e => { last.bgColor = e.target.value; last.bg = 'custom'; refresh(); } });
  const imgGroup = h('div', { class: 'xgroup' },
    field('View', viewSel, 'Which view to export (PNG and SVG)'),
    h('div', { class: 'lbl' }, 'Size'), scaleRow.el, h('div', { class: 'row gap center xcustom' }, customIn, h('span', { class: 'muted small' }, 'times the 1024 px canvas (0.25 to 4)')),
    h('div', { class: 'lbl' }, 'Background'), bgRow.el, h('div', { class: 'row gap center xbgc' }, bgColor, h('span', { class: 'muted small' }, 'Used when Colour is chosen')));
  paints.push(() => { viewSel.value = last.view; customIn.value = last.custom; bgColor.value = last.bgColor; scaleRow.paint(); bgRow.paint(); });

  // ---- svg
  const svgGarment = add(check('Embed the garment picture behind the elements', () => last.svgGarment, v => { last.svgGarment = v; }, 'Adds the garment as a picture under the vector elements (bigger file)'));
  svgGarment.classList.add('xsvg');

  // ---- elements (all formats)
  const elCb = add(check('Include design elements', () => last.elements, v => { last.elements = v; }, 'Text, logos, crests, stripes and other elements are drawn on top'));

  // ---- measurements (dimension lines and labels on PNG / SVG / front and back; the design sheet has its own table)
  const measCb = add(check('Include measurements (dimension lines and labels)', () => last.measure, v => { last.measure = v; }, 'Draws tech-pack style dimension lines with the approximate measurements on the exported image, or as an editable <g id="measurements"> group in the SVG'));

  // ---- design sheet
  const sheetScaleRow = chipRow([['1', '1×'], ['2', '2×']], k => last.sheetScale === k, k => { last.sheetScale = k; refresh(); });
  const titleIn = h('input', { type: 'text', maxlength: 80, 'aria-label': 'Sheet title', oninput: e => { last.title = e.target.value; refresh(); } });
  const notesIn = h('textarea', { rows: 3, maxlength: 600, 'aria-label': 'Sheet notes', oninput: e => { last.notes = e.target.value; refresh(); } });
  const sectionBoxes = SHEET_SECTIONS.map(([k, label, tip]) => add(check(label, () => last.sections[k], v => { last.sections[k] = v; }, tip)));
  const viewBoxes = VIEWS.map(v => add(check(VIEW_LABELS[v] + (hasView(v) ? '' : ' (no image)'), () => last.sheetViews[v], val => { last.sheetViews[v] = val; }, 'Include this view panel')));
  const sheetGroup = h('div', { class: 'xgroup' },
    h('div', { class: 'lbl' }, 'Sheet size'), sheetScaleRow.el,
    field('Title', titleIn, 'Heading of the sheet (defaults to the design name)'),
    field('Notes', notesIn, 'Printed at the bottom of the sheet (defaults to your last prompt)'),
    h('div', { class: 'lbl' }, 'Views on the sheet'), h('div', { class: 'xcol2' }, viewBoxes),
    h('div', { class: 'lbl' }, 'Specs and sections'), h('div', { class: 'xcol2' }, sectionBoxes));
  paints.push(() => { sheetScaleRow.paint(); titleIn.value = last.title ?? S.name ?? ''; notesIn.value = last.notes ?? (S.ui.notes || S.ui.prompt || ''); });

  // ---- live preview
  previewEl = h('div', { class: 'xprev-wrap' });
  const info = h('div', { class: 'xinfo', 'aria-live': 'polite' });
  const preview = h('div', { class: 'xprev' }, previewEl, info);

  // ---- footer
  const goBtn = h('button', { type: 'submit', class: 'btn primary' }, icon('download', 16), 'Export');
  const form = h('form', { method: 'dialog', class: 'dlg-body xform', onsubmit: e => { e.preventDefault(); doExport(goBtn); } },
    h('div', { class: 'dlg-head' }, h('h2', {}, 'Export design'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))),
    h('div', { class: 'xlayout' },
      h('div', { class: 'xopts' },
        h('div', { class: 'lbl' }, 'Format'), fmtRow.el, fmtHint,
        imgGroup, svgGarment, elCb, measCb, sheetGroup),
      preview),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), goBtn));
  paints.push(fmtRow.paint);

  dlg = h('dialog', { class: 'home-dlg xdlg', 'aria-label': 'Export options' });
  dlg.addEventListener('close', () => { dlg.remove(); dlg = null; previewEl = null; refresh = () => { }; });
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();

  // which controls apply to the chosen format
  const showFor = () => {
    const f = last.format;
    imgGroup.hidden = f === 'sheet';
    viewSel.closest('label').hidden = f === 'fb' || f === 'sheet';
    scaleRow.el.hidden = f === 'svg' || f === 'sheet'; customIn.closest('.xcustom').hidden = f === 'svg' || f === 'sheet' || last.scale !== 'custom';
    bgRow.el.hidden = f === 'svg' || f === 'sheet';
    imgGroup.querySelector('.xbgc').hidden = f === 'svg' || f === 'sheet' || last.bg !== 'custom';
    imgGroup.querySelectorAll('.lbl').forEach(l => { if (l.textContent === 'Background' || l.textContent === 'Size') l.hidden = f === 'svg' || f === 'sheet'; });
    svgGarment.hidden = f !== 'svg';
    measCb.hidden = f === 'sheet';
    sheetGroup.hidden = f !== 'sheet';
    fmtHint.textContent = FORMATS.find(x => x[0] === f)[2];
  };

  refresh = () => {
    paints.forEach(p => p());
    showFor();
    const info2 = exportInfo();
    renderPreview();
    const names = describeFiles();
    info.replaceChildren(
      h('b', {}, `${info2.w} × ${info2.h} px`),
      h('span', { class: 'muted small' }, info2.vector ? ' · vector, scales to any size' : ` · ${info2.files} file${info2.files > 1 ? 's' : ''}`),
      h('span', { class: 'xsize muted small' }, ' · estimating size…'),
      h('div', { class: 'muted small xnames' }, 'Downloads: ' + names.join(', ')));
    estimate(++estToken, info2);
    goBtn.disabled = !anyViewForFormat();
  };
  refresh();
}

let estToken = 0;
function anyViewForFormat() {
  if (last.format === 'fb') return hasView('front') || hasView('back');
  if (last.format === 'sheet') return VIEWS.some(v => last.sheetViews[v] && hasView(v));
  return hasView(last.view);
}
function describeFiles() {
  const slug = slugOf(state.name), s = scaleValue();
  const suf = s !== 1 ? '@' + s + 'x' : '';
  if (last.format === 'svg') return [`${slug}-${last.view}.svg`];
  if (last.format === 'sheet') return [`${slug}-design-sheet.png`];
  if (last.format === 'fb') return [`${slug}-front${suf}.png`, `${slug}-back${suf}.png`];
  return [`${slug}-${last.view}${suf}.png`];
}

/** Draws the preview thumbnails: the garment with the chosen background and elements. */
function renderPreview() {
  if (!previewEl) return;
  const f = last.format, els = last.elements ? state.elements : [];
  const views = f === 'fb' ? ['front', 'back'] : [f === 'sheet' ? activeOrFirst() : last.view].filter(Boolean);
  previewEl.replaceChildren(...views.map(v => {
    const cur = state.views[v]?.current;
    if (!cur) return h('div', { class: 'xprev-none muted small' }, `${VIEW_LABELS[v]}: no image yet`);
    const c = previewCanvas({ baseCanvas: cur, elements: els, view: v, background: f === 'svg' ? 'transparent' : bgValue(), size: 240 });
    c.className = 'xprev-img'; c.setAttribute('aria-label', `${VIEW_LABELS[v]} preview`);
    return h('figure', { class: 'xfig' }, c, h('figcaption', { class: 'muted small' }, VIEW_LABELS[v] + (f === 'sheet' ? ' (front of the sheet)' : '')));
  }));
}

/** Estimated size: exact for SVG, measured from a 240 px preview and scaled for the others. */
async function estimate(token, info) {
  const sizeEl = dlg?.querySelector('.xsize');
  if (!sizeEl) return;
  if (last.format === 'sheet') { sizeEl.textContent = ' · file size depends on the content'; return; }
  try {
    let bytes;
    if (last.format === 'svg') {
      const base = last.svgGarment ? state.views[last.view].current : null;
      bytes = new Blob([exportSVG({ elements: last.elements ? state.elements : [], view: last.view, baseCanvas: base, title: state.name })]).size;
    } else {
      const v = last.format === 'sheet' ? activeOrFirst() : last.view;
      const cur = state.views[v]?.current; if (!cur) return;
      const c = previewCanvas({ baseCanvas: cur, elements: last.elements ? state.elements : [], view: v, background: bgValue(), size: 240 });
      const blob = await canvasToBlob(c, 'image/png');
      const k = (info.w / c.width) * (info.h / c.height);
      bytes = blob.size * k * info.files;
    }
    if (token !== estToken) return;
    sizeEl.textContent = ` · about ${fmtBytes(Math.round(bytes))}` + (last.format === 'svg' ? '' : ' (estimate)');
  } catch (e) { if (token === estToken && sizeEl) sizeEl.textContent = ''; }
}

/** Runs the export for the current options and downloads the file(s). */
async function doExport(btn) {
  const S = state, f = last.format, slug = slugOf(S.name);
  const els = last.elements ? S.elements : [];
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Exporting…';
  try {
    if (f === 'png') {
      const s = scaleValue();
      const blob = await exportPNG({ baseCanvas: S.views[last.view].current, elements: els, view: last.view, scale: s, background: bgValue(), measurements: last.measure ? exportMeasureData(S, last.view) : null });
      download(blob, `${slug}-${last.view}${s !== 1 ? '@' + s + 'x' : ''}.png`);
    } else if (f === 'svg') {
      download(exportSVG({ elements: els, view: last.view, baseCanvas: last.svgGarment ? S.views[last.view].current : null, title: S.name, measurements: last.measure ? exportMeasureData(S, last.view) : null }), `${slug}-${last.view}.svg`);
    } else if (f === 'fb') {
      const views = { front: S.views.front.current, back: S.views.back.current };
      const items = await exportViewImages({ views, elements: els, scale: scaleValue(), background: bgValue(), only: ['front', 'back'], name: slug, measurements: last.measure ? { front: exportMeasureData(S, 'front'), back: exportMeasureData(S, 'back') } : null });
      if (!items.length) throw new Error('Nothing to export yet');
      await downloadAll(items);
    } else {
      const v = activeOrFirst(); if (!v) throw new Error('Nothing to export yet');
      const views = {}; for (const n of VIEWS) if (S.views[n].current && last.sheetViews[n]) views[n] = S.views[n].current;
      const fabric = S.views[v].fabric?.name;
      const blob = await exportDesignSheet({
        views, elements: els, params: { ...S.views[v].params }, notes: last.notes ?? (S.ui.notes || S.ui.prompt || ''),
        name: S.name, title: last.title || S.name, fabric: fabric && fabric !== 'none' ? fabric : null,
        include: { ...last.sections, views: VIEWS.filter(n => last.sheetViews[n]) }, scale: sheetScaleValue(), measurements: exportMeasureData(S, v),
      });
      download(blob, `${slug}-design-sheet.png`);
    }
    markFlow('exported');
    dlg?.close();
  } catch (e) {
    console.error(e); toast('Export failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}
