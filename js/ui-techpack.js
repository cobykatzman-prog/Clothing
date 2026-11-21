// Threadform - tech pack builder UI (roadmap v2 phase 5): an editor + live A4 preview dialog, the print layout (Save as PDF
// from the browser print dialog), the multi-sheet spreadsheet and the CSV bundle. The data model is techpack.js, the
// drawings are techdraw.js. Everything the design already holds is filled in automatically; the editor only asks for
// what a picture cannot know (stitching, trims, supplier, notes). All text is inserted as text, never as HTML.
import { state, subscribe, notify, snapshot } from './state.js';
import { h, toast, userError, friendly } from './util.js';
import { openDialog } from './ui-dialog.js';
import { download, downloadAll, extractSwatches, compose } from './export.js';
import { designSpec } from './spec.js';
import { designCalibration, designKind, referenceSeg, KIND_LABELS, formatMeasure } from './measure.js';
import { SIZES, VIEW_LABEL } from './spec.js';
import {
  buildTechPack, normalizeTechPack, cloneTechPack, suggestFor, spreadsheetXML, csvBundle,
  MATERIAL_COLS, TRIM_COLS, STITCH_COLS,
} from './techpack.js';
import { renderDrawing, renderArtworkDetail } from './techdraw.js';
import * as store from './storage.js';
import { identity } from './workspace-ui.js';

const slug = () => (state.name || 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
const designId = () => { try { return decodeURIComponent((location.hash.match(/^#\/design\/([^/?]+)/) || [])[1] || ''); } catch (e) { return ''; } };
const dataURL = c => { try { return c.toDataURL('image/png'); } catch (e) { return ''; } };

/* ------------------------------------------------------------------ gather what the design already holds */
let sharedHistory = [];   // best-effort revisions of the open design from the shared library (author + date)
async function loadSharedHistory() {
  sharedHistory = [];
  const id = designId(); if (!id || !store.shared || !store.shared()) return;
  try {
    const vs = await store.listVersions(id);
    sharedHistory = vs.map(v => ({ rev: v.rev, date: v.savedAt ? new Date(v.savedAt).toISOString().slice(0, 10) : '', author: v.editedBy || '', note: v.note || '', source: 'Shared library revision' }));
  } catch (e) { sharedHistory = []; }
}
function collectInput() {
  const S = state, spec = designSpec(S), cal = {}, landmarks = {};
  for (const v of ['front', 'back']) {
    const c = designCalibration(S, v), seg = S.views[v] && S.views[v].seg;
    if (c && seg && !(seg.metrics && seg.metrics.empty)) { const fs = (seg.metrics && seg.metrics.fitScale) || 1; cal[v] = { ...c, s: c.s / fs }; landmarks[v] = seg.landmarks; }
  }
  const fabrics = ['front', 'back'].map(v => ({ view: v, name: S.views[v] && S.views[v].fabric && S.views[v].fabric.name })).filter(f => f.name);
  let colours = [];
  const fv = S.views.front.current ? 'front' : S.views.back.current ? 'back' : null;
  if (fv) { try { colours = extractSwatches(compose(S.views[fv].current, S.elements.filter(e => e.view === fv || e.view === 'all'), fv, 1, 'transparent'), 6); } catch (e) { colours = []; } }
  const parts = [];
  for (const v of ['front', 'back']) for (const [part, p] of Object.entries((S.views[v] && S.views[v].parts) || {})) if (p && /^#[0-9a-f]{3,8}$/i.test(p.color || '')) parts.push({ view: v, part, hex: p.color });
  const history = [...sharedHistory,
    ...S.versions.map(v => ({ rev: '', date: v.time ? new Date(v.time).toISOString().slice(0, 10) : '', author: '', note: v.label || 'Saved version', source: 'Saved version' }))];
  const ref = referenceSeg(S), id = identity();
  return {
    name: S.name, designId: designId(), kind: spec ? spec.kind : ref ? designKind(S, ref) : 'tee', baseSize: S.measure.size, techpack: S.techpack, spec, cal, landmarks,
    elements: S.elements, fabrics, colours, parts, history, identity: id && id.name ? id.name : '', now: new Date(),
  };
}
export const modelNow = () => buildTechPack(collectInput());

/* ------------------------------------------------------------------ drawings (canvas -> data URLs) */
async function makeDrawings(model) {
  const out = { views: {}, details: [] }, elements = state.elements;
  const pl = model.placements;
  for (const v of ['front', 'back', 'side', 'detail']) {
    const c = await renderDrawing(state, v, { placements: pl.filter(p => p.view === v).length ? pl : [], dims: true });
    if (c) out.views[v] = { src: dataURL(c), w: c.width, h: c.height, kind: c.dataset.kind };
  }
  for (let i = 0; i < pl.length && out.details.length < 6; i++) {
    const p = pl[i], el = elements.find(e => e.id === p.id);
    if (!el || (p.view !== 'front' && p.view !== 'back')) continue;
    const c = await renderArtworkDetail(state, el, p, i + 1);
    if (c) out.details.push({ n: i + 1, src: dataURL(c), label: p.label, view: p.view });
  }
  return out;
}

/* ------------------------------------------------------------------ the pages (shared by the preview and the print layout) */
const TAG = { calibrated: 'C', manual: 'M', estimated: 'E', missing: '-' };
function table(columns, rows, { cls = '', keep = null } = {}) {
  const idx = keep || columns.map((_, i) => i);
  return h('table', { class: 'tp-table ' + cls }, h('thead', {}, h('tr', {}, idx.map(i => h('th', { scope: 'col' }, columns[i])))),
    h('tbody', {}, rows.length ? rows.map(r => h('tr', {}, idx.map(i => h('td', {}, r[i] == null || r[i] === '' ? '' : String(r[i]))))) : h('tr', {}, h('td', { colspan: idx.length, class: 'tp-none' }, 'None recorded.'))));
}
const sheetOf = (m, key) => m.sheets.find(s => s.key === key);
function fig(src, caption, cls = '') { return h('figure', { class: 'tp-fig ' + cls }, src ? h('img', { src, alt: caption }) : h('div', { class: 'tp-noimg' }, 'Not available'), h('figcaption', {}, caption)); }

export function buildDoc(model, dr, { print = false } = {}) {
  const I = model.ident, pages = [];
  const page = (title, ...kids) => pages.push({ title, kids });
  const honest = h('p', { class: 'tp-banner', role: 'note' }, h('b', {}, 'Not production-verified. '), 'Values are labelled Calibrated (C), Manual (M, typed by you) or Estimated (E). Estimated values come from the picture and a typical size chart.');
  const warn = model.warnings.filter(w => w.level !== 'note');

  /* 1 cover */
  const idRows = [['Design name', I.name], ['Design ID', I.designId || 'Not saved yet'], ['Style no.', I.styleNo || 'Not set'], ['Season', I.season || 'Not set'], ['Supplier / factory', I.supplier || 'Not set'], ['Status', I.status], ['Garment type', I.garment], ['Base size', I.baseSize], ['Units', I.units], ['Revision', `${I.revNo} · ${I.revDate} · ${I.revAuthor || 'author not set'}`], ['Pack generated', I.generated], ['Scale', I.scale]];
  page('Cover',
    h('div', { class: 'tp-cover' },
      h('div', { class: 'tp-ident' }, h('dl', {}, idRows.map(([a, b]) => [h('dt', {}, a), h('dd', {}, b)]))),
      h('div', { class: 'tp-hero' }, dr && dr.views.front ? fig(dr.views.front.src, 'Front, technical drawing', 'tp-hero-fig') : h('div', { class: 'tp-noimg' }, 'Load a garment to see the drawing'))),
    honest,
    h('h3', {}, 'Contents'), h('ol', { class: 'tp-toc' }, ['Technical drawings: front and back', 'Side and detail drawings', 'Graded size chart', 'Materials, colours and trims', 'Stitching and construction', 'Logo and graphic placement', 'Production notes and revisions'].map(t => h('li', {}, t))),
    warn.length ? [h('h3', {}, 'Check before sending'), h('ul', { class: 'tp-warn' }, warn.map(w => h('li', {}, h('b', {}, (w.level === 'error' ? 'Error: ' : 'Warning: ')), w.msg)))] : null);

  /* 2 drawings */
  const vcap = (v, extra) => `${VIEW_LABEL[v]} (${extra})`;
  page('Technical drawings',
    h('div', { class: 'tp-two' }, fig(dr && dr.views.front && dr.views.front.src, vcap('front', 'measurement callouts; ~ = estimated, no ~ = calibrated'), 'tp-draw'), fig(dr && dr.views.back && dr.views.back.src, vcap('back', 'measurement callouts; ~ = estimated, no ~ = calibrated'), 'tp-draw')),
    h('p', { class: 'tp-small' }, 'Flat drawings follow the current shape of the design. Solid line = silhouette; dashed grey = schematic seam and stitch lines (not a pattern); dashed orange boxes with a number = artwork placement (see the Logo and graphic placement table). Callout names follow the point-of-measure table.'));

  /* 3 side + detail */
  page('Side and detail drawings',
    h('div', { class: 'tp-two' }, fig(dr && dr.views.side && dr.views.side.src, 'Side view' + (dr && dr.views.side ? ' (reference only: no measurements are made on a side view)' : ''), 'tp-draw'), fig(dr && dr.views.detail && dr.views.detail.src, 'Detail view' + (dr && dr.views.detail ? ' (close-up picture in greys)' : ''), 'tp-draw')),
    !(dr && (dr.views.side || dr.views.detail)) ? h('p', { class: 'tp-small' }, 'This design has no side or detail picture yet. Add them in the Side and Detail tabs and they will appear here.') : null);

  /* 4 size chart */
  const sp = model.spec;
  if (sp) {
    const head = h('tr', {}, h('th', { scope: 'col' }, 'POM'), h('th', { scope: 'col' }, 'Point of measure and how to measure'), h('th', { scope: 'col' }, 'Tol ±'), ...SIZES.map(s => h('th', { scope: 'col' }, s + (s === sp.baseSize ? ' (base)' : ''))));
    const body = sp.rows.map(r => h('tr', {}, h('td', {}, r.code), h('th', { scope: 'row' }, r.name, h('div', { class: 'tp-how' }, r.how)), h('td', { class: 'tp-n' }, String(r.tol)),
      ...SIZES.map(s => { const c = r.cells[s]; return h('td', { class: 'tp-n tp-v tp-' + c.source }, c.cm == null ? 'n/a' : formatMeasure(c.cm, 'cm', { unitLabel: false }), h('span', { class: 'tp-tag' }, ' ' + TAG[c.source]), c.cm == null ? null : h('div', { class: 'tp-rng' }, `${c.min} to ${c.max}`)); })));
    page('Graded size chart',
      h('p', { class: 'tp-small' }, `Flat measurements in cm, base size ${sp.baseSize}. Tolerance range (min to max) is shown under each value. Key: C = calibrated, M = manual (typed by you), E = estimated, graded from the base size.`),
      h('table', { class: 'tp-table tp-chart' }, h('thead', {}, head), h('tbody', {}, body)),
      h('p', { class: 'tp-small' }, `Scale: ${I.scale}. ${sp.counts.calibrated} calibrated, ${sp.counts.manual} manual and ${sp.counts.estimated} estimated values across all sizes.`),
      sp.warnings.length ? [h('h3', {}, 'Measurement checks'), h('ul', { class: 'tp-warn' }, sp.warnings.slice(0, 14).map(w => h('li', {}, h('b', {}, (w.level === 'error' ? 'Error: ' : w.level === 'warn' ? 'Warning: ' : 'Note: ')), w.msg)))] : null);
  } else page('Graded size chart', h('p', { class: 'tp-banner' }, 'No size chart: load a front or back garment image first.'));

  /* 5 materials, colours, trims */
  const sw = h('div', { class: 'tp-swatches' }, model.colours.map(c => h('div', { class: 'tp-sw' }, h('span', { class: 'tp-chip', style: { background: c.hex } }), h('div', {}, h('b', {}, (c.name || 'Colour') + ' ' + c.hex.toUpperCase()), h('div', { class: 'tp-small' }, c.where + ' · ' + c.source)))));
  page('Materials, colours and trims',
    h('h3', {}, 'Materials'), table(sheetOf(model, 'materials').columns, sheetOf(model, 'materials').rows),
    h('h3', {}, 'Colours'), model.colours.length ? sw : h('p', { class: 'tp-small' }, 'No colours could be read.'), h('p', { class: 'tp-small' }, sheetOf(model, 'colours').note),
    h('h3', {}, 'Trims'), table(sheetOf(model, 'trims').columns, sheetOf(model, 'trims').rows), h('p', { class: 'tp-small' }, sheetOf(model, 'trims').note));

  /* 6 stitching + construction */
  page('Stitching and construction',
    h('h3', {}, 'Stitching'), table(sheetOf(model, 'stitching').columns, sheetOf(model, 'stitching').rows), h('p', { class: 'tp-small' }, sheetOf(model, 'stitching').note),
    h('h3', {}, 'Construction notes'), table(sheetOf(model, 'construction').columns, sheetOf(model, 'construction').rows));

  /* 7 artwork */
  const art = sheetOf(model, 'artwork');
  page('Logo and graphic placement',
    h('p', { class: 'tp-small' }, art.note),
    table(art.columns, art.rows, { cls: 'tp-art', keep: [0, 1, 2, 4, 5, 6, 7, 8, 9, 12, 14] }),
    dr && dr.details.length ? [h('h3', {}, 'Artwork detail drawings'), h('div', { class: 'tp-details' }, dr.details.map(d => fig(d.src, `${d.n}. ${d.label} (${VIEW_LABEL[d.view]})`, 'tp-detail')))] : null);

  /* 8 production + revisions */
  const prod = sheetOf(model, 'production'), rev = sheetOf(model, 'revisions');
  page('Production notes and revisions',
    h('h3', {}, 'Production notes'), table(prod.columns, prod.rows),
    h('h3', {}, 'Revision details'), table(rev.columns, rev.rows), h('p', { class: 'tp-small' }, rev.note),
    h('h3', {}, 'Sign-off'), h('div', { class: 'tp-sign' }, ['Designer', 'Factory / supplier', 'Date'].map(t => h('div', {}, h('span', {}, t), h('i', {})))),
    h('p', { class: 'tp-disc' }, model.disclaimer));

  const n = pages.length;
  const root = h('div', { class: 'tp-doc', id: print ? 'print-techpack' : 'tp-doc', 'aria-hidden': print ? 'true' : null });
  pages.forEach((p, i) => root.append(h('section', { class: 'tp-page', 'aria-label': `Page ${i + 1} of ${n}: ${p.title}` },
    h('header', { class: 'tp-head' }, h('div', {}, h('b', {}, 'TECH PACK'), ' · ' + p.title), h('div', { class: 'tp-brand' }, 'THREADFORM')),
    h('div', { class: 'tp-body' }, p.kids),
    h('footer', { class: 'tp-foot' }, h('span', {}, `${I.name}${I.styleNo ? ' · ' + I.styleNo : ''} · ID ${I.designId || 'unsaved'} · Rev ${I.revNo} · ${I.revDate} · DRAFT, not production-verified`), h('span', {}, `Page ${i + 1} of ${n}`)))));
  return root;
}

/* ------------------------------------------------------------------ actions */
let printing = null;
export async function printTechPack(model = modelNow(), dr = null) {
  dr = dr || await makeDrawings(model);
  const old = document.getElementById('print-techpack'); if (old) old.remove();
  const doc = buildDoc(model, dr, { print: true }); document.body.append(doc);
  document.body.classList.add('printing-tp');
  const done = () => { document.body.classList.remove('printing-tp'); doc.remove(); window.removeEventListener('afterprint', done); printing = null; };
  window.addEventListener('afterprint', done); printing = done;
  window.print();
  setTimeout(() => { if (document.body.classList.contains('printing-tp') && !document.hidden) done(); }, 60000);
}
export function exportTechPackSheet(model = modelNow()) { download(new Blob([spreadsheetXML(model)], { type: 'application/vnd.ms-excel;charset=utf-8' }), `${slug()}-techpack.xml`); }
export async function exportTechPackCSVs(model = modelNow()) {
  const files = csvBundle(model, slug());
  await downloadAll(files.map(f => ({ name: f.name, blob: new Blob([f.text], { type: 'text/csv;charset=utf-8' }) })), 450);
  return files.length;
}

/* ------------------------------------------------------------------ the editor */
function patchTP(fn) {
  snapshot();   // every edit is undoable like the rest of the design
  const t = cloneTechPack(state.techpack); fn(t);
  state.techpack = normalizeTechPack(t);
  notify('techpack');
}
const LISTS = {
  materials: { cols: MATERIAL_COLS, labels: ['Part', 'Material', 'Composition', 'Weight (gsm)', 'Supplier', 'Notes'], add: 'Add material' },
  trims: { cols: TRIM_COLS, labels: ['Item', 'Specification', 'Placement', 'Qty', 'Colour', 'Supplier'], add: 'Add trim' },
  stitching: { cols: STITCH_COLS, labels: ['Area', 'Stitch / seam type', 'SPI', 'Notes'], add: 'Add stitching line' },
};
const PROD = [['labels', 'Labels (main, care, size)'], ['packaging', 'Packaging'], ['washCare', 'Wash care'], ['moq', 'Minimum order quantity'], ['leadTime', 'Lead time']];

export function openTechPack() {
  if (![...Object.values(state.views)].some(v => v.current)) { toast('Load or generate a garment first, then build a tech pack.', 'error'); return null; }
  const status = h('div', { class: 'tp-status small muted', role: 'status', 'aria-live': 'polite' }, 'Preparing drawings…');
  const preview = h('div', { class: 'tp-preview', id: 'tp-preview', role: 'region', 'aria-label': 'Tech pack preview, A4 pages', tabindex: '0' });
  const form = h('div', { class: 'tp-form', id: 'tp-form' });
  let model = null, drawings = null, token = 0, closed = false;

  const field = (label, getter, setter, { area = false, ph = '', id = '' } = {}) => {
    const inp = h(area ? 'textarea' : 'input', { class: 'tp-in', ...(area ? { rows: 3 } : { type: 'text' }), placeholder: ph, ...(id ? { id } : {}), 'data-f': id.replace(/^tpf-/, '') });
    inp.value = getter();
    inp.addEventListener('change', () => patchTP(t => setter(t, inp.value)));
    return h('label', { class: 'tp-field' }, h('span', { class: 'lbl' }, label), inp);
  };
  function listEditor(key) {
    const L = LISTS[key], box = h('div', { class: 'tp-list', 'data-list': key });
    const commit = () => patchTP(t => { t[key] = [...box.querySelectorAll('.tp-row')].map(r => { const o = {}; L.cols.forEach((c, i) => { o[c] = r.querySelectorAll('input')[i].value; }); if (r.dataset.s === '1') o.s = true; return o; }); });
    const row = (v = {}) => {
      const r = h('div', { class: 'tp-row', 'data-s': v.s ? '1' : null },
        L.cols.map((c, i) => { const inp = h('input', { type: 'text', class: 'tp-in', 'aria-label': `${L.labels[i]}, ${L.add.replace('Add ', '')} row`, placeholder: L.labels[i], 'data-c': c }); inp.value = v[c] || ''; inp.addEventListener('change', () => { r.dataset.s = ''; commit(); }); return inp; }),
        v.s ? h('span', { class: 'tp-sug', tip: 'Suggested starting point for this garment type: edit it to confirm, or delete it.' }, 'suggested') : null,
        h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Remove this row', onclick: () => { r.remove(); commit(); } }, 'Remove'));
      return r;
    };
    (state.techpack[key] || []).forEach(v => box.append(row(v)));
    return h('div', {}, box, h('button', { type: 'button', class: 'btn sm', 'data-add': key, onclick: () => { const r = row(); box.append(r); r.querySelector('input').focus(); } }, L.add));
  }
  function constructionEditor() {
    const box = h('div', { class: 'tp-list', 'data-list': 'construction' });
    const commit = () => patchTP(t => { t.construction = [...box.querySelectorAll('.tp-row')].map(r => ({ text: r.querySelector('textarea').value, ...(r.dataset.s === '1' ? { s: true } : {}) })); });
    const row = (v = {}) => { const ta = h('textarea', { class: 'tp-in', rows: 2, 'aria-label': 'Construction note', placeholder: 'Construction note' }); ta.value = v.text || ''; const r = h('div', { class: 'tp-row one', 'data-s': v.s ? '1' : null }, ta, v.s ? h('span', { class: 'tp-sug' }, 'suggested') : null, h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Remove this note', onclick: () => { r.remove(); commit(); } }, 'Remove')); ta.addEventListener('change', () => { r.dataset.s = ''; commit(); }); return r; };
    (state.techpack.construction || []).forEach(v => box.append(row(v)));
    return h('div', {}, box, h('button', { type: 'button', class: 'btn sm', 'data-add': 'construction', onclick: () => { const r = row(); box.append(r); r.querySelector('textarea').focus(); } }, 'Add construction note'));
  }
  function revisionEditor() {
    const box = h('div', { class: 'tp-list', 'data-list': 'revisions' });
    const cols = ['no', 'date', 'author', 'note'], labels = ['Rev', 'Date (YYYY-MM-DD)', 'Author', 'What changed'];
    const commit = () => patchTP(t => { t.revisions = [...box.querySelectorAll('.tp-row')].map(r => { const o = {}; cols.forEach((c, i) => { o[c] = r.querySelectorAll('input')[i].value; }); return o; }); });
    const row = (v = {}) => { const r = h('div', { class: 'tp-row rev' }, cols.map((c, i) => { const inp = h('input', { type: 'text', class: 'tp-in', 'aria-label': 'Revision ' + labels[i], placeholder: labels[i] }); inp.value = v[c] || ''; inp.addEventListener('change', commit); return inp; }), h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Remove this revision', onclick: () => { r.remove(); commit(); } }, 'Remove')); return r; };
    (state.techpack.revisions || []).forEach(v => box.append(row(v)));
    return h('div', {}, box, h('button', { type: 'button', class: 'btn sm', 'data-add': 'revisions', onclick: () => { const r = row(); box.append(r); r.querySelector('input').focus(); } }, 'Add revision line'));
  }
  const group = (title, hint, ...kids) => h('details', { class: 'tp-group', open: true }, h('summary', {}, title), hint ? h('p', { class: 'tp-small' }, hint) : null, ...kids);

  function buildForm() {
    const T = state.techpack, id = identity();
    form.replaceChildren(
      h('p', { class: 'tp-small' }, 'Everything the design already holds (drawings, size chart, colours, artwork positions) is filled in for you. Add what a picture cannot show. Changes save with the design and can be undone.'),
      group('Identity and revision', 'Design ID comes from the saved design link.',
        h('div', { class: 'tp-grid2' },
          field('Style no.', () => T.styleNo, (t, v) => { t.styleNo = v; }, { id: 'tpf-styleNo', ph: 'e.g. CE-LS-001' }), field('Season', () => T.season, (t, v) => { t.season = v; }, { id: 'tpf-season', ph: 'e.g. SS27' }),
          field('Supplier / factory', () => T.supplier, (t, v) => { t.supplier = v; }, { id: 'tpf-supplier' }), field('Status', () => T.status, (t, v) => { t.status = v; }, { id: 'tpf-status', ph: 'Draft' }),
          field('Revision number', () => T.rev.no, (t, v) => { t.rev.no = v; }, { id: 'tpf-revNo' }), field('Revision date', () => T.rev.date, (t, v) => { t.rev.date = v; }, { id: 'tpf-revDate', ph: 'blank = today' }),
          field('Revision author', () => T.rev.author, (t, v) => { t.rev.author = v; }, { id: 'tpf-revAuthor', ph: id && id.name ? id.name : 'Your name' })),
        h('button', { type: 'button', class: 'btn sm', id: 'tp-use-history', onclick: useHistory }, 'Use the latest saved version'),
        h('div', { class: 'lbl' }, 'Revision log'), revisionEditor()),
      group('Materials', 'Fabric and artwork materials from the design are listed automatically. Add composition, weight and suppliers here.', listEditor('materials')),
      group('Trims', 'Piping, patches and embroidery from the design are listed automatically. Add labels, buttons, zips and drawcords.', listEditor('trims')),
      group('Stitching', null, h('button', { type: 'button', class: 'btn sm', id: 'tp-suggest', tip: 'Adds typical stitching and construction lines for this garment type, flagged as suggested', onclick: suggest }, 'Suggest for this garment type'), listEditor('stitching')),
      group('Construction notes', null, constructionEditor()),
      group('Production notes', null, h('div', { class: 'tp-grid2' }, PROD.map(([k, l]) => field(l, () => T.production[k], (t, v) => { t.production[k] = v; }, { id: 'tpf-p-' + k }))),
        field('Production notes', () => T.production.notes, (t, v) => { t.production.notes = v; }, { area: true, id: 'tpf-p-notes' }), field('General notes', () => T.notes, (t, v) => { t.notes = v; }, { area: true, id: 'tpf-notes' })));
  }
  function suggest() {
    const k = model ? model.ident.kind : 'tee', s = suggestFor(k);
    patchTP(t => {
      const have = new Set(t.stitching.map(r => r.area)); for (const r of s.stitching) if (!have.has(r.area)) t.stitching.push(r);
      const hv = new Set(t.construction.map(r => r.text)); for (const r of s.construction) if (!hv.has(r.text)) t.construction.push(r);
    });
    buildForm(); toast(`Added suggested lines for a ${KIND_LABELS[k] || 'garment'}. Check each one with your factory.`, 'ok');
  }
  function useHistory() {
    const m = modelNow(), top = m.history[0];
    if (!top) { toast('There are no saved versions yet. Use Save version first.', 'error'); return; }
    patchTP(t => { if (top.rev !== '') t.rev.no = String(top.rev); if (top.date) t.rev.date = top.date; if (top.author) t.rev.author = top.author; else if (!t.rev.author && identity() && identity().name) t.rev.author = identity().name; });
    buildForm(); toast('Revision details filled from the latest saved version.', 'ok');
  }

  /* ---- preview ---- */
  const fitPreview = () => { const doc = preview.firstElementChild; if (!doc) return; const w = preview.clientWidth - 24; doc.style.zoom = String(Math.max(0.2, Math.min(1, w / 1124))); };
  let rt = 0;
  function renderPreview() {
    cancelAnimationFrame(rt); rt = requestAnimationFrame(() => {
      if (closed) return;
      model = modelNow();
      const doc = buildDoc(model, drawings);
      preview.replaceChildren(doc); fitPreview();
      const w = model.warnings.filter(x => x.level !== 'note').length;
      status.textContent = `${doc.children.length} A4 pages. ${w ? w + ' thing' + (w === 1 ? '' : 's') + ' to check.' : 'No blocking checks.'} Not production-verified.`;
    });
  }
  async function refreshDrawings() {
    const my = ++token; status.textContent = 'Drawing views…';
    try { const m = modelNow(); const d = await makeDrawings(m); if (my !== token || closed) return; drawings = d; renderPreview(); }
    catch (e) { console.error(e); status.textContent = 'Some drawings could not be made.'; }
  }
  const unsub = subscribe(r => { if (closed) return; if (r === 'techpack') renderPreview(); else if (r === 'restore') { buildForm(); refreshDrawings(); } });
  const guard = fn => async () => { try { await fn(); } catch (e) { console.error(e); toast(friendly(e, 'That export did not work.'), 'error', 5000); } };
  const bar = h('div', { class: 'tp-bar' },
    h('button', { type: 'button', class: 'btn primary', id: 'tp-print', tip: 'Opens the print dialog: choose Save as PDF. A4, several pages', onclick: guard(async () => { if (!model) throw userError('The tech pack is still being prepared.'); await printTechPack(modelNow(), drawings); }) }, 'Print / Save as PDF'),
    h('button', { type: 'button', class: 'btn', id: 'tp-xml', tip: 'One workbook with a sheet per section; opens in Excel, LibreOffice and Numbers', onclick: guard(async () => { exportTechPackSheet(modelNow()); toast('Tech pack workbook downloaded (one sheet per section).', 'ok'); }) }, 'Spreadsheet (multi-sheet)'),
    h('button', { type: 'button', class: 'btn', id: 'tp-csv', tip: 'One CSV file per section, downloaded one after another', onclick: guard(async () => { const n = await exportTechPackCSVs(modelNow()); toast(`${n} CSV files downloaded.`, 'ok'); }) }, 'CSV files'),
    h('button', { type: 'button', class: 'btn ghost', id: 'tp-refresh', tip: 'Redraw the technical drawings from the current design', onclick: refreshDrawings }, 'Refresh drawings'), status);
  const body = h('div', { class: 'tp-wrap' }, bar, h('div', { class: 'tp-cols' }, form, preview));
  const d = openDialog({ title: 'Tech pack', cls: 'tp-dlg', body: [body], onClose: () => { closed = true; unsub(); window.removeEventListener('resize', fitPreview); } });
  window.addEventListener('resize', fitPreview);
  new ResizeObserver(fitPreview).observe(preview);
  buildForm();
  loadSharedHistory().then(() => { if (!closed) renderPreview(); });
  refreshDrawings();
  return d;
}
