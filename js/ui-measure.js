// Right-panel "Measurements" section: size, unit, live table (now / original / change), calibration, canvas dimension lines.
// All numbers come from measure.js; the per-design settings live in state.measure (saved with the design).
import { state, subscribe, notify, snapshot } from './state.js';
import { h, toast } from './util.js';
import { section } from './ui-left.js';
import {
  SIZES, KINDS, KIND_LABELS, CALIBRATE_KEYS, NOTE, designMeasure, formatMeasure, visibleDelta, calibrationText, normalizeMeasureState,
} from './measure.js';

const CAL_LABEL = { chest: 'chest', length: 'body length', shoulder: 'shoulder width', hem: 'hem width' };
const SKIP = new Set(['render', 'zoom', 'elements-live', 'busy']);

function setMeasure(patch) {
  snapshot();   // size / unit / scale changes are undoable like every other edit
  state.measure = normalizeMeasureState({ ...state.measure, ...patch });
  notify('measure');
}

export function measureBlock() {
  const S = state;
  const sizeBtns = SIZES.map(sz => h('button', { type: 'button', class: 'chip', 'data-size': sz, 'aria-pressed': 'false', onclick: () => setMeasure({ size: sz, manual: null }) }, sz));
  const kindSel = h('select', { id: 'measure-kind', 'aria-label': 'Garment type', onchange: e => setMeasure({ kind: e.target.value || null }) },
    h('option', { value: '' }, 'Auto-detect'), KINDS.map(k => h('option', { value: k }, KIND_LABELS[k])));
  const table = h('div', { class: 'mtable', id: 'measure-table', role: 'table', 'aria-label': 'Garment measurements' });
  const basis = h('div', { class: 'muted small mbasis', id: 'measure-basis' });

  // ---- calibration: "My chest measures ___"
  const calKey = h('select', { id: 'measure-cal-key', 'aria-label': 'Measurement you know', onchange: () => paintCal() },
    CALIBRATE_KEYS.map(k => h('option', { value: k }, k === 'chest' ? 'chest (pit to pit)' : CAL_LABEL[k])));
  const calIn = h('input', { type: 'number', id: 'measure-cal-input', class: 'mcal-in', min: 1, step: 0.5, inputmode: 'decimal', placeholder: '53', 'aria-label': 'Your measurement',
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); applyCal(); } } });
  const calUnit = h('span', { class: 'muted small', id: 'measure-cal-unit' }, 'cm');
  const calMsg = h('div', { class: 'small mmsg', id: 'measure-cal-msg', 'aria-live': 'polite' });
  const calBtn = h('button', { type: 'button', class: 'btn sm', id: 'measure-cal-apply', onclick: () => applyCal() }, 'Set');
  const calReset = h('button', { type: 'button', class: 'btn ghost sm', id: 'measure-cal-reset', onclick: () => { calIn.value = ''; setMeasure({ manual: null }); } }, 'Reset');
  function applyCal() {
    const key = calKey.value, v = parseFloat(calIn.value), cm = v;
    if (!isFinite(v) || cm < 10 || cm > 200) { calMsg.textContent = 'Type a realistic flat measurement, for example 54 cm.'; calMsg.className = 'small mmsg err'; return; }
    calMsg.textContent = '';
    setMeasure({ manual: { key, cm } });
    toast(`Scale set: ${CAL_LABEL[key]} = ${formatMeasure(cm, 'cm')}.`, 'ok');
  }
  const calRow = h('div', { class: 'row gap center wrap mcal', 'data-level': 'advanced' }, h('span', { class: 'small' }, 'My'), calKey, h('span', { class: 'small' }, 'measures'), calIn, calUnit, calBtn, calReset);

  const show = h('input', { type: 'checkbox', id: 'measure-show', onchange: e => setMeasure({ show: e.target.checked }) });
  const showRow = h('label', { class: 'check', tip: 'Draws dimension lines on the canvas only. They are never part of the garment picture.' }, show, 'Show dimensions on canvas');
  const note = h('div', { class: 'muted small mnote' }, NOTE);

  const el = h('div', { class: 'measure-block' },
    h('div', { class: 'lbl' }, 'Size'), h('div', { class: 'chips xs', role: 'group', 'aria-label': 'Size' }, sizeBtns),
    h('div', { class: 'row gap center between wrap' },
      h('span', { class: 'muted small' }, 'All measurements in centimetres (cm)'),
      h('label', { class: 'row gap center small', 'data-level': 'advanced' }, h('span', { class: 'lbl' }, 'Garment'), kindSel)),
    table, basis,
    h('div', { class: 'lbl', 'data-level': 'advanced' }, 'Know a real measurement?'), calRow, calMsg,
    showRow, note);

  function paintCal() {
    const m = S.measure, u = m.unit;
    calUnit.textContent = 'cm';
    calIn.step = 0.5;
    if (document.activeElement !== calIn) {
      if (m.manual && m.manual.key === calKey.value) calIn.value = String(Math.round(m.manual.cm * 100) / 100);
      else if (!m.manual) calIn.value = '';
    }
    calReset.hidden = !m.manual;
  }

  function sync() {
    const m = S.measure, d = designMeasure(S, S.activeView);
    sizeBtns.forEach(b => { const on = b.dataset.size === m.size; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    kindSel.value = m.kind || '';
    show.checked = !!m.show;
    if (m.manual && calKey.value !== m.manual.key && document.activeElement !== calKey) calKey.value = m.manual.key;
    paintCal();
    if (!d) {
      table.replaceChildren(h('div', { class: 'muted small' }, 'Load a garment to see its measurements.'));
      basis.textContent = ''; return;
    }
    const u = 'cm';
    const rows = [h('div', { class: 'mrow mhead', role: 'row' }, h('span', { role: 'columnheader' }, 'Measurement'), h('span', { role: 'columnheader' }, 'Now'), h('span', { role: 'columnheader' }, 'Original'), h('span', { role: 'columnheader' }, 'Change'))];
    for (const r of d.rows) {
      const vis = visibleDelta(r.deltaCm, u);
      rows.push(h('div', { class: 'mrow', role: 'row', 'data-key': r.key },
        h('span', { class: 'mlab', role: 'cell' }, r.label),
        h('b', { class: 'mnow', role: 'cell' }, formatMeasure(r.cm, u)),
        h('span', { class: 'morig', role: 'cell' }, formatMeasure(r.origCm, u)),
        h('span', { class: 'mchg ' + (!vis ? 'zero' : r.deltaCm > 0 ? 'up' : 'down'), role: 'cell' }, vis ? formatMeasure(r.deltaCm, u, { sign: true }) : '0')));
    }
    table.replaceChildren(...rows);
    let t = 'Scale from ' + calibrationText(d.cal, u) + '.';
    if (d.cal.adjusted.length && !d.cal.manual) t += ` The picture is drawn with different proportions than a typical ${(KIND_LABELS[d.kind] || '').toLowerCase()}, so ${d.cal.adjusted.map(a => a === 'length' ? 'body length' : 'sleeve length').join(' and ')} follow the size chart.`;
    basis.textContent = t;
  }

  let raf = 0;
  subscribe(r => { if (SKIP.has(r) || raf) return; raf = requestAnimationFrame(() => { raf = 0; sync(); }); });
  sync();
  return { el, sync };
}

/** The ready-made right-panel section. */
export function measureSection() {
  const b = measureBlock();
  return { sec: section('•', 'Measurements', 'Approximate flat-garment measurements in centimetres (cm). They update as you change the garment. Pick the size, or type one real measurement to set the scale.', [b.el], true, 'sec-measure'), sync: b.sync };
}
