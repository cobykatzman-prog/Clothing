// Right-panel "Size spec" section (roadmap v2 phase 4): per-size POM table with manual entry, grading increments,
// tolerances, validation warnings, calibration status, CSV export and a printable table. Logic lives in spec.js.
import { state, subscribe, notify, snapshot } from './state.js';
import { h, toast, userError } from './util.js';
import { section } from './ui-left.js';
import { download } from './export.js';
import { formatMeasure, KIND_LABELS } from './measure.js';
import {
  SIZES, POMS, SOURCES, VIEW_LABEL, designSpec, scaleInfo, specCSV, normalizeSpecState, cloneSpecState, hasManual, SPEC_DISCLAIMER,
} from './spec.js';

const SKIP = new Set(['render', 'zoom', 'elements-live', 'busy']);
const slug = () => (state.name || 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
const today = () => new Date().toISOString().slice(0, 10);
const LEVEL = { error: 'Error', warn: 'Warning', note: 'Note' };

function patchSpec(fn) {
  snapshot();   // typing a value, an increment or a tolerance is an undoable edit like every other change
  const s = cloneSpecState(state.spec); fn(s);
  state.spec = normalizeSpecState(s);
  notify('spec');
}
const parse = t => { const v = parseFloat(String(t).replace(',', '.')); return isFinite(v) ? v : null; };

/** Printable spec: a plain DOM table that only shows in print media (css/spec.css). */
export function buildPrintDoc(data) {
  const ident = state.name || 'Untitled design';
  const th = t => h('th', { scope: 'col' }, t);
  const head = h('tr', {}, th('POM'), th('Point of measure'), th('Tol ±'), ...SIZES.map(s => th(s + (s === data.baseSize ? ' (base)' : ''))));
  const body = data.rows.map(r => h('tr', {},
    h('td', {}, r.code), h('th', { scope: 'row' }, r.name, h('div', { class: 'ps-how' }, r.how)), h('td', {}, String(r.tol)),
    ...SIZES.map(s => { const c = r.cells[s]; return h('td', { class: 'ps-v ps-' + c.source }, c.cm == null ? 'n/a' : formatMeasure(c.cm, 'cm', { unitLabel: false }), h('span', { class: 'ps-tag' }, ' ' + SOURCES[c.source].short)); })));
  const warns = data.warnings.length ? h('ul', { class: 'ps-warn' }, data.warnings.map(w => h('li', {}, h('b', {}, LEVEL[w.level] + ': '), w.msg))) : h('p', {}, 'No validation warnings.');
  return h('div', { id: 'print-spec', 'aria-hidden': 'true' },
    h('h1', {}, 'Measurement spec: ' + ident),
    h('p', {}, `Garment: ${data.kindLabel}. Base size ${data.baseSize}. All values are flat measurements in cm. Printed ${today()}.`),
    h('p', {}, h('b', {}, 'Key: '), 'C = calibrated, M = manual (typed by you), E = estimated (not production-verified).'),
    h('table', {}, h('thead', {}, head), h('tbody', {}, body)),
    h('h2', {}, 'Checks'), warns,
    h('p', { class: 'ps-note' }, SPEC_DISCLAIMER));
}
export function printSpec() {
  const data = designSpec(state); if (!data) throw userError('Load a Front or Back garment first to print a measurement spec.');
  data.kindLabel = KIND_LABELS[data.kind] || data.kind;
  const old = document.getElementById('print-spec'); if (old) old.remove();
  const doc = buildPrintDoc(data); document.body.append(doc);
  document.body.classList.add('printing-spec');
  const done = () => { document.body.classList.remove('printing-spec'); doc.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(() => { if (document.body.classList.contains('printing-spec') && !document.hidden) done(); }, 60000);
}
export function exportSpecCSV() {
  const data = designSpec(state); if (!data) throw userError('Load a Front or Back garment first to export a measurement spec.');
  download(new Blob([specCSV(data, { design: state.name })], { type: 'text/csv;charset=utf-8' }), `${slug()}-measurement-spec.csv`);
}

export function specBlock() {
  const S = state;
  const summary = h('div', { class: 'spec-sum small', id: 'spec-summary', 'aria-live': 'polite' });
  const scaleEl = h('div', { class: 'spec-scale small', id: 'spec-scale' });
  const legend = h('div', { class: 'spec-legend small' }, ['calibrated', 'manual', 'estimated'].map(k => h('span', { class: 'spec-badge src-' + k, tip: SOURCES[k].note }, SOURCES[k].short + ' ' + SOURCES[k].label)));
  const grid = h('div', { class: 'spec-grid-wrap', role: 'region', 'aria-label': 'Size spec table, scrolls sideways', tabindex: '0' });
  const gradeBox = h('div', { class: 'spec-grade', id: 'spec-grade' });
  const warnBox = h('ul', { class: 'spec-warns', id: 'spec-warns', 'aria-label': 'Measurement checks' });
  const resetBtn = h('button', { type: 'button', class: 'btn ghost sm', id: 'spec-reset', onclick: () => { patchSpec(s => { s.manual = {}; }); toast('Typed values cleared. The table follows the drawing again.', 'ok'); } }, 'Clear typed values');
  const csvBtn = h('button', { type: 'button', class: 'btn sm', id: 'spec-csv', onclick: () => { try { exportSpecCSV(); } catch (e) { toast(e.message, 'error'); } } }, 'Export spec (CSV)');
  const printBtn = h('button', { type: 'button', class: 'btn sm', id: 'spec-print', onclick: () => { try { printSpec(); } catch (e) { toast(e.message, 'error'); } } }, 'Print table');
  const empty = h('div', { class: 'muted small', id: 'spec-empty' }, 'Load or generate a garment on Front or Back to build the size spec.');
  const body = h('div', { class: 'spec-body' }, summary, scaleEl, legend, grid, h('div', { class: 'lbl' }, 'Grading step and tolerance'), gradeBox, h('div', { class: 'lbl' }, 'Checks'), warnBox,
    h('div', { class: 'row gap wrap' }, csvBtn, printBtn, resetBtn),
    h('div', { class: 'muted small mnote' }, 'Type any size to enter your own value; clear the box to go back to the drawing. ' + 'Estimated values are never production-verified.'));
  const el = h('div', { class: 'spec-block' }, empty, body);

  // The grid is built once (the POM list is fixed) and updated in place, so keyboard focus is never lost.
  const cells = {}, incs = {}, tols = {}, names = {}, gnames = {};
  function cellInput(r, sz) {
    const inp = h('input', { type: 'text', inputmode: 'decimal', class: 'spec-in', 'data-key': r.key, 'data-size': sz, placeholder: '–', autocomplete: 'off',
      oninput: () => { inp.dataset.dirty = '1'; },
      onchange: e => {
        delete inp.dataset.dirty;
        const t = e.target.value.trim();
        if (t === '') patchSpec(s => { if (s.manual[r.key]) { delete s.manual[r.key][sz]; if (!Object.keys(s.manual[r.key]).length) delete s.manual[r.key]; } });
        else {
          const v = parse(t);
          if (v == null || v <= 0 || v >= 400) { toast('Type a number in cm, for example 54.', 'error'); sync(); return; }
          patchSpec(s => { (s.manual[r.key] = s.manual[r.key] || {})[sz] = { cm: v, at: new Date().toISOString() }; });
        }
      } });
    const tag = h('span', { class: 'spec-tag', 'aria-hidden': 'true' });
    cells[r.key + '|' + sz] = { inp, tag };
    return h('div', { class: 'spec-cell' }, inp, tag);
  }
  const head = h('div', { class: 'spec-row spec-head', role: 'row' }, h('span', { role: 'columnheader' }, 'Point of measure'), SIZES.map(sz => h('span', { role: 'columnheader', 'data-hsize': sz }, sz)));
  grid.append(h('div', { class: 'spec-grid', role: 'table', 'aria-label': 'Measurement spec by size, cm' }, head,
    POMS.map(r => h('div', { class: 'spec-row', role: 'row', 'data-key': r.key },
      (names[r.key] = h('span', { class: 'spec-name', role: 'rowheader' }, h('b', {}, r.code), ' ', r.name)),
      SIZES.map(sz => h('div', { role: 'cell' }, cellInput(r, sz)))))));
  const setIn = (inp, v) => { if (!(document.activeElement === inp && inp.dataset.dirty)) inp.value = v; };
  gradeBox.append(...POMS.map(r => {
    const inc = h('input', { type: 'text', inputmode: 'decimal', class: 'spec-in', 'data-inc': r.key, 'aria-label': `${r.code} grading step in cm per size, blank uses the size chart`,
      onchange: e => { delete inc.dataset.dirty; const t = e.target.value.trim(), v = parse(t); patchSpec(s => { if (t === '' || v == null) delete s.inc[r.key]; else s.inc[r.key] = v; }); }, oninput: () => { inc.dataset.dirty = '1'; } });
    const tol = h('input', { type: 'text', inputmode: 'decimal', class: 'spec-in', 'data-tol': r.key, 'aria-label': `${r.code} tolerance plus or minus, in cm`,
      onchange: e => { delete tol.dataset.dirty; const t = e.target.value.trim(), v = parse(t); patchSpec(s => { if (t === '' || v == null) delete s.tol[r.key]; else s.tol[r.key] = v; }); }, oninput: () => { tol.dataset.dirty = '1'; } });
    incs[r.key] = inc; tols[r.key] = tol;
    return h('div', { class: 'spec-grow' }, h('span', { class: 'spec-gname' }, r.code + ' ' + r.name),
      h('label', { class: 'spec-gf' }, h('span', { class: 'small muted' }, 'Step cm/size'), inc),
      h('label', { class: 'spec-gf' }, h('span', { class: 'small muted' }, 'Tol ± cm'), tol));
  }));

  function sync() {
    const d = designSpec(S);
    empty.hidden = !!d; body.hidden = !d;
    if (!d) return;
    const c = d.baseCounts;
    summary.textContent = `${d.rows.length} points of measure, base size ${d.baseSize}: ${c.calibrated} calibrated, ${c.manual} manual, ${c.estimated} estimated at the base size.`;
    const si = scaleInfo(d.cal);
    scaleEl.textContent = si ? `${si.text}. 1 cm = ${Math.round(si.pxPerCm * 10) / 10} px on the 1024 px canvas.` + (si.calibrated ? '' : ' Calibrate it above with a real measurement.') : '';
    scaleEl.className = 'spec-scale small ' + (si && si.calibrated ? 'cal' : 'est');
    resetBtn.hidden = !hasManual(S.spec);
    head.querySelectorAll('[data-hsize]').forEach(e => e.classList.toggle('base', e.dataset.hsize === d.baseSize));
    for (const r of d.rows) {
      names[r.key].setAttribute('data-tip', r.how + '. Views: ' + r.views.map(v => VIEW_LABEL[v]).join(', ') + (r.views.includes('side') ? ' (side is reference only)' : ''));
      for (const sz of SIZES) {
        const c = r.cells[sz], { inp, tag } = cells[r.key + '|' + sz];
        setIn(inp, c.cm == null ? '' : String(c.cm));
        inp.className = 'spec-in src-' + c.source + (sz === d.baseSize ? ' base' : ''); inp.dataset.src = c.source;
        inp.setAttribute('aria-label', `${r.code} ${r.name}, size ${sz}, ${c.cm == null ? 'no value' : c.cm + ' cm'}, ${SOURCES[c.source].label}`);
        inp.setAttribute('data-tip', (c.note || SOURCES[c.source].note) + (c.cm != null ? `. Range ${c.min} to ${c.max} cm` : ''));
        tag.className = 'spec-tag src-' + c.source; tag.textContent = SOURCES[c.source].short;
      }
      setIn(incs[r.key], r.incIsDefault ? '' : String(r.steps[0]));
      incs[r.key].placeholder = r.steps.every(v => v === r.steps[0]) ? String(r.steps[0]) : 'chart';
      setIn(tols[r.key], r.tolIsDefault ? '' : String(r.tol)); tols[r.key].placeholder = String(r.tol);
    }
    warnBox.replaceChildren(...(d.warnings.length ? d.warnings.map(w => h('li', { class: 'spec-w lvl-' + w.level, 'data-key': w.key || '' }, h('b', {}, LEVEL[w.level] + ': '), w.msg))
      : [h('li', { class: 'spec-w lvl-ok' }, h('b', {}, 'OK: '), 'No validation warnings.')]));
  }

  let raf = 0;
  subscribe(r => { if (SKIP.has(r) || raf) return; raf = requestAnimationFrame(() => { raf = 0; sync(); }); });
  sync();
  return { el, sync };
}

export function specSection() {
  const b = specBlock();
  return { sec: section('•', 'Size spec', 'Per-size measurement table (points of measure) with grading steps, tolerances and checks. Every value is labelled calibrated, manual or estimated.', [b.el], false, 'sec-spec'), sync: b.sync };
}
