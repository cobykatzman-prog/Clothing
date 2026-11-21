// Threadform - measurement spec: point-of-measure (POM) catalogue, per-size values, grading increments, tolerances,
// validation and the exportable table (roadmap v2 phase 4). Pure logic, no DOM, no state import (state is passed in).
//
// HONESTY / TRACEABILITY: every number in the spec table carries a SOURCE:
//   calibrated  the base-size value of the one measurement the user calibrated the on-screen scale with ("my chest is 54 cm")
//   manual      a value the user typed in for that size (kept with the time it was entered)
//   estimated   everything else: read off the picture with the typical-size scale, or graded from the base size by
//               increments. Estimates are NEVER presented as production-verified.
// Values for the base size come from the live garment geometry (measure.js), so they follow shape changes; other
// sizes are base value + grading increments (configurable per POM, default = the size-chart steps); a manual entry
// replaces one cell only.
import { SIZES, SIZE_CHARTS, chartValue, formatMeasure, KIND_LABELS, designMeasure, designKind, referenceSeg } from './measure.js';

/* ------------------------------------------------------------------ POM catalogue (same codes and names in every view) */
/**
 * key        spec key (neck drop is two POMs: the front and back seams are different measurements)
 * measureKey key used by measure.js (rows of designMeasure)
 * views      views where the POM is defined; 'side' is reference only (no image measurement is made on a side view)
 * tol        default tolerance, +/- cm (typical knit-garment spec tolerances)
 * range      plausible flat-garment range, cm (outside it a warning is shown)
 */
export const POMS = [
  { key: 'chest', measureKey: 'chest', code: 'POM-01', name: 'Chest width (pit to pit)', how: 'Flat, straight across, 2.5 cm below the armhole seam, armhole to armhole', views: ['front', 'back'], tol: 1.5, range: [30, 90] },
  { key: 'length', measureKey: 'length', code: 'POM-02', name: 'Body length (HPS to hem)', how: 'From the high point shoulder (where shoulder seam meets neck) straight down to the bottom hem', views: ['front', 'back', 'side'], tol: 1.5, range: [40, 110] },
  { key: 'shoulder', measureKey: 'shoulder', code: 'POM-03', name: 'Shoulder width', how: 'Shoulder seam to shoulder seam, straight across the back or front', views: ['front', 'back'], tol: 1, range: [28, 70] },
  { key: 'sleeve', measureKey: 'sleeve', code: 'POM-04', name: 'Sleeve length', how: 'From the shoulder seam (armhole) along the top of the sleeve to the sleeve opening', views: ['front', 'back', 'side'], tol: 1, range: [5, 80] },
  { key: 'sleeveOpening', measureKey: 'sleeveOpening', code: 'POM-05', name: 'Sleeve opening', how: 'Flat width of the sleeve opening or cuff, edge to edge', views: ['front', 'back'], tol: 0.5, range: [5, 35] },
  { key: 'hem', measureKey: 'hem', code: 'POM-06', name: 'Hem width', how: 'Flat width of the bottom hem, edge to edge, relaxed', views: ['front', 'back'], tol: 1.5, range: [30, 90] },
  { key: 'neck', measureKey: 'neck', code: 'POM-07', name: 'Neck opening width', how: 'Neck seam to neck seam, straight across', views: ['front', 'back'], tol: 0.5, range: [10, 35] },
  { key: 'neckDrop', measureKey: 'neckDrop', code: 'POM-08', name: 'Front neck drop (HPS to seam)', how: 'From HPS straight down to the front neck seam', views: ['front'], tol: 0.5, range: [1, 20] },
  { key: 'backNeckDrop', measureKey: 'neckDrop', code: 'POM-09', name: 'Back neck drop (HPS to seam)', how: 'From HPS straight down to the back neck seam', views: ['back'], tol: 0.5, range: [0.5, 10] },
];
export const POM_KEYS = POMS.map(p => p.key);
const POM = Object.fromEntries(POMS.map(p => [p.key, p]));
export const VIEW_LABEL = { front: 'Front', back: 'Back', side: 'Side' };

export const SOURCES = {
  calibrated: { label: 'Calibrated', short: 'C', note: 'Set from a real measurement you typed to calibrate the scale.' },
  manual: { label: 'Manual', short: 'M', note: 'Typed in by you. Not checked against the drawing.' },
  estimated: { label: 'Estimated', short: 'E', note: 'Read from the picture and the typical size chart, or graded from the base size. Not production-verified.' },
  missing: { label: 'No value', short: '-', note: 'This garment does not have this point of measure yet.' },
};

/* ------------------------------------------------------------------ per-design spec settings (stored in state.spec) */
export function defaultSpecState() { return { inc: {}, tol: {}, manual: {} }; }
const num = v => typeof v === 'number' && isFinite(v);
export function normalizeSpecState(o) {
  const d = defaultSpecState(); if (!o || typeof o !== 'object') return d;
  for (const k of POM_KEYS) {
    const inc = o.inc && o.inc[k]; if (num(inc) && Math.abs(inc) <= 20) d.inc[k] = Math.round(inc * 100) / 100;
    const tol = o.tol && o.tol[k]; if (num(tol) && tol >= 0 && tol <= 20) d.tol[k] = Math.round(tol * 100) / 100;
    const m = o.manual && o.manual[k];
    if (m && typeof m === 'object') {
      for (const sz of SIZES) {
        const e = m[sz]; if (e && num(e.cm) && e.cm > 0 && e.cm < 400) {
          (d.manual[k] = d.manual[k] || {})[sz] = { cm: Math.round(e.cm * 100) / 100, at: typeof e.at === 'string' ? e.at.slice(0, 32) : '' };
        }
      }
    }
  }
  return d;
}
export const cloneSpecState = s => normalizeSpecState(JSON.parse(JSON.stringify(s || defaultSpecState())));
export const hasManual = s => !!s && Object.values(s.manual || {}).some(m => m && Object.keys(m).length);

/** Chart grading steps of one POM for a garment kind: 5 increments (XS>S, S>M, M>L, L>XL, XL>XXL), cm. */
export function chartSteps(kind, key) {
  const p = POM[key]; if (!p) return [0, 0, 0, 0, 0];
  const out = [];
  for (let i = 0; i < SIZES.length - 1; i++) {
    const a = chartValue(kind, SIZES[i], p.measureKey, key === 'backNeckDrop' ? 'back' : 'front');
    const b = chartValue(kind, SIZES[i + 1], p.measureKey, key === 'backNeckDrop' ? 'back' : 'front');
    out.push(a == null || b == null ? 0 : Math.round((b - a) * 100) / 100);
  }
  return out;
}
/** The steps actually used: a uniform increment when the user set one, else the chart steps. */
export function effectiveSteps(kind, key, spec) {
  const inc = spec && spec.inc && spec.inc[key];
  return num(inc) ? Array(SIZES.length - 1).fill(inc) : chartSteps(kind, key);
}

/* ------------------------------------------------------------------ the table */
const r2 = n => n == null ? null : Math.round(n * 100) / 100;
/**
 * Pure builder. input:
 *   kind, baseSize, spec (normalized), calibratedKey (measure.js key the scale was calibrated on, or null),
 *   base: { [specKey]: { cm, view } }   image-derived values at the base size (geometry), missing keys = no value
 *   views: { front: {[specKey]: cm}, back: {...} }   optional, for the front/back consistency check
 * Returns { rows, warnings, counts, baseSize, kind }.
 */
export function buildSpec({ kind = 'tee', baseSize = 'M', spec = defaultSpecState(), calibratedKey = null, base = {}, views = {} } = {}) {
  const bi = Math.max(0, SIZES.indexOf(baseSize)), now = {};
  const rows = [], warnings = [];
  const warn = (level, key, size, msg) => warnings.push({ level, key: key || null, size: size || null, msg });
  for (const p of POMS) {
    const steps = effectiveSteps(kind, p.key, spec), man = (spec.manual && spec.manual[p.key]) || {};
    const img = base[p.key] && num(base[p.key].cm) ? base[p.key].cm : null;
    const tol = num(spec.tol && spec.tol[p.key]) ? spec.tol[p.key] : p.tol;
    // anchor: a manual base-size entry wins over the picture
    const anchor = man[baseSize] ? man[baseSize].cm : img;
    const calKey = calibratedKey === p.measureKey && p.key !== 'backNeckDrop';
    const cells = {};
    SIZES.forEach((sz, j) => {
      let cm = null, source = 'missing', note = '';
      if (man[sz]) { cm = man[sz].cm; source = 'manual'; note = 'Typed in' + (man[sz].at ? ' on ' + man[sz].at.slice(0, 10) : ''); }
      else if (anchor != null) {
        let v = anchor;
        if (j > bi) for (let i = bi; i < j; i++) v += steps[i];
        else if (j < bi) for (let i = j; i < bi; i++) v -= steps[i];
        cm = v;
        if (j === bi) {
          source = calKey ? 'calibrated' : 'estimated';
          note = calKey ? 'Garment scale calibrated on this measurement' : 'Read from the picture with the typical ' + (KIND_LABELS[kind] || 'garment').toLowerCase() + ' size scale';
        } else {
          source = 'estimated';
          const bsrc = man[baseSize] ? 'manual' : calKey ? 'calibrated' : 'estimated';
          note = `Graded from base size ${baseSize} (${bsrc}) with ${num(spec.inc && spec.inc[p.key]) ? 'your ' + spec.inc[p.key] + ' cm' : 'size-chart'} steps`;
        }
      }
      cm = cm == null ? null : r2(cm);
      cells[sz] = { cm, source, note, min: cm == null ? null : r2(cm - tol), max: cm == null ? null : r2(cm + tol) };
    });
    now[p.key] = cells;
    rows.push({ key: p.key, code: p.code, name: p.name, how: p.how, views: p.views, tol, tolIsDefault: !(spec.tol && num(spec.tol[p.key])), steps, incIsDefault: !(spec.inc && num(spec.inc[p.key])), img: r2(img), base: cells[baseSize], cells });
  }

  /* ---- validation ---- */
  for (const r of rows) {
    const p = POM[r.key], vals = SIZES.map(s => r.cells[s].cm);
    if (vals.every(v => v == null)) {
      if (p.views.some(v => views[v])) warn('note', r.key, null, `${r.code} ${r.name}: no value (this garment has no ${p.name.toLowerCase()} to measure). Type values in if you need them.`);
      continue;
    }
    SIZES.forEach((sz, j) => {
      const c = r.cells[sz]; if (c.cm == null) return;
      if (c.cm < p.range[0] || c.cm > p.range[1]) warn('warn', r.key, sz, `${r.code} ${r.name} at ${sz} is ${formatMeasure(c.cm)}: outside the usual ${p.range[0]} to ${p.range[1]} cm for a flat garment. Check the number.`);
      if (j > 0 && vals[j - 1] != null && c.cm < vals[j - 1] - 1e-9) warn('error', r.key, sz, `${r.code} ${r.name}: ${sz} (${formatMeasure(c.cm)}) is smaller than ${SIZES[j - 1]} (${formatMeasure(vals[j - 1])}). Sizes should not shrink going up.`);
    });
    const st = r.steps.map(Math.abs).filter(v => v > 0);
    if (!r.incIsDefault && r.steps[0] === 0) warn('note', r.key, null, `${r.code} ${r.name}: grading increment is 0, so every size gets the same value.`);
    if (st.length > 2) { const lo = Math.min(...st), hi = Math.max(...st); if (hi > lo * 2.5) warn('note', r.key, null, `${r.code} ${r.name}: grading steps are uneven (${lo} to ${hi} cm per size).`); }
    if (r.tol <= 0) warn('warn', r.key, null, `${r.code} ${r.name}: tolerance is 0, so no factory sample could ever be in spec.`);
    else if (r.base && r.base.cm != null && r.tol > r.base.cm * 0.2) warn('warn', r.key, null, `${r.code} ${r.name}: tolerance ±${r.tol} cm is more than 20% of the value.`);
    // a typed value for the base size that the drawing no longer shows
    const m = (spec.manual && spec.manual[r.key] && spec.manual[r.key][baseSize]);
    if (m && r.img != null && Math.abs(m.cm - r.img) > Math.max(r.tol, 0.5)) {
      warn('warn', r.key, baseSize, `${r.code} ${r.name}: you typed ${formatMeasure(m.cm)} for ${baseSize}, but the drawing now measures ${formatMeasure(r.img)}. The picture will not match the typed value; change the shape, or clear the typed value to follow the drawing.`);
    }
  }
  // relations that must hold for a real garment, checked per size
  for (const sz of SIZES) {
    const g = k => now[k] && now[k][sz].cm;
    const chest = g('chest'), sh = g('shoulder'), neck = g('neck'), hem = g('hem'), op = g('sleeveOpening'), fd = g('neckDrop'), bd = g('backNeckDrop');
    if (chest != null && sh != null && sh > chest * 1.05) warn('warn', 'shoulder', sz, `${sz}: shoulder width (${formatMeasure(sh)}) is wider than the chest (${formatMeasure(chest)}).`);
    if (sh != null && neck != null && neck >= sh) warn('error', 'neck', sz, `${sz}: neck opening (${formatMeasure(neck)}) is as wide as the shoulders (${formatMeasure(sh)}).`);
    if (chest != null && hem != null && Math.abs(hem - chest) > chest * 0.15) warn('warn', 'hem', sz, `${sz}: hem (${formatMeasure(hem)}) differs from the chest (${formatMeasure(chest)}) by more than 15%.`);
    if (chest != null && op != null && op > chest / 2) warn('warn', 'sleeveOpening', sz, `${sz}: sleeve opening (${formatMeasure(op)}) is more than half the chest width.`);
    if (fd != null && bd != null && bd >= fd) warn('warn', 'backNeckDrop', sz, `${sz}: back neck drop (${formatMeasure(bd)}) should be shallower than the front (${formatMeasure(fd)}).`);
  }
  // front and back are the same physical garment: shared POMs must agree
  if (views.front && views.back) {
    for (const p of POMS) {
      if (!(p.views.includes('front') && p.views.includes('back'))) continue;
      const a = views.front[p.key], b = views.back[p.key]; if (a == null || b == null) continue;
      const tol = (rows.find(r => r.key === p.key) || {}).tol || p.tol;
      if (Math.abs(a - b) > tol) warn('warn', p.key, baseSize, `${p.code} ${p.name}: front view reads ${formatMeasure(a)} and back view ${formatMeasure(b)} (more than ±${tol} cm apart). Front and back should be the same garment: check the shape link or calibrate the scale.`);
    }
  }
  const counts = { calibrated: 0, manual: 0, estimated: 0, missing: 0, total: 0 };
  for (const r of rows) for (const sz of SIZES) { counts[r.cells[sz].source]++; counts.total++; }
  const baseCounts = { calibrated: 0, manual: 0, estimated: 0, missing: 0 };
  for (const r of rows) baseCounts[r.base.source]++;
  if (counts.estimated + baseCounts.estimated > 0) warn('note', null, null, 'Estimated values come from the picture and a typical size chart. They are not production-verified: measure a physical sample before you manufacture.');
  return { rows, warnings, counts, baseCounts, baseSize, kind };
}

/* ------------------------------------------------------------------ glue with the design state */
/** Spec table of the whole design, from the live front/back geometry. null while there is no garment to measure. */
export function designSpec(state) {
  const fr = designMeasure(state, 'front'), bk = designMeasure(state, 'back');
  if (!fr && !bk) return null;
  const ref = referenceSeg(state), kind = (fr || bk).kind;
  const base = {}, views = {};
  const take = (d, view) => {
    if (!d) return;
    views[view] = {};
    for (const r of d.rows) {
      const sk = r.key === 'neckDrop' ? (view === 'back' ? 'backNeckDrop' : 'neckDrop') : r.key;
      views[view][sk] = r.cm;
    }
  };
  take(fr, 'front'); take(bk, 'back');
  for (const p of POMS) {
    const pref = ['front', 'back'].filter(v => p.views.includes(v));
    for (const v of pref) if (views[v] && views[v][p.key] != null) { base[p.key] = { cm: views[v][p.key], view: v }; break; }
  }
  const man = state.measure && state.measure.manual;
  const t = buildSpec({ kind, baseSize: state.measure.size, spec: normalizeSpecState(state.spec), calibratedKey: man ? man.key : null, base, views });
  t.cal = (fr || bk).cal; t.hasFront = !!fr; t.hasBack = !!bk; t.ref = ref;
  return t;
}
export const designKindOf = (state, ref) => designKind(state, ref);

/** On-screen scale: cm per pixel of the 1024 px canvas and where it comes from. */
export function scaleInfo(cal, state) {
  if (!cal || !(cal.s > 0)) return null;
  const man = cal.manual;
  return {
    cmPerPx: cal.s, pxPerCm: 1 / cal.s, calibrated: !!man, key: man ? man.key : null, cm: man ? man.cm : null,
    source: man ? 'calibrated' : 'estimated',
    text: man ? `Scale calibrated on your ${man.key === 'length' ? 'body length' : man.key} of ${formatMeasure(man.cm)}` : `Scale estimated from a typical ${(KIND_LABELS[cal.kind] || 'garment').toLowerCase()} size ${cal.size}`,
  };
}

/* ------------------------------------------------------------------ exports */
const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const line = a => a.map(cell).join(',');
export const SPEC_DISCLAIMER = 'Calibrated, Manual and Estimated labels show where each number came from. Only values you measured on a physical sample and entered yourself are your own data; Threadform has not verified any value for production. Estimates come from the picture and a typical size chart. Confirm every point of measure, tolerance, grading step, shrinkage and fit on a physical sample before bulk production.';

/** CSV of the full graded spec: values, status per size, tolerances, increments, trace. data = designSpec(...) */
export function specCSV(data, { design = 'Untitled design' } = {}) {
  if (!data || !Array.isArray(data.rows)) throw new TypeError('Spec data is required');
  const L = [
    line(['THREADFORM MEASUREMENT SPEC']),
    line(['Style', design]), line(['Garment type', KIND_LABELS[data.kind] || data.kind]),
    line(['Base size', data.baseSize]), line(['Units', 'cm']),
    line(['Value status key', 'Calibrated = scale set from a real measurement you typed; Manual = typed by you; Estimated = from the picture / size chart (not production-verified)']),
    line(['Scale', data.cal ? scaleInfo(data.cal).text : '']),
    '',
    line(['POM code', 'Point of measure', 'Views', 'How to measure', 'Tolerance +/- (cm)', 'Grading step (cm)', 'Base size', ...SIZES.map(s => s + ' (cm)'), ...SIZES.map(s => s + ' min'), ...SIZES.map(s => s + ' max'), ...SIZES.map(s => s + ' status'), 'Trace (base size)']),
  ];
  for (const r of data.rows) {
    const step = r.incIsDefault ? r.steps.join(' / ') : String(r.steps[0]);
    L.push(line([r.code, r.name, r.views.map(v => VIEW_LABEL[v]).join(' + '), r.how, r.tol, step, data.baseSize,
      ...SIZES.map(s => r.cells[s].cm ?? ''), ...SIZES.map(s => r.cells[s].min ?? ''), ...SIZES.map(s => r.cells[s].max ?? ''),
      ...SIZES.map(s => SOURCES[r.cells[s].source].label), r.base.note]));
  }
  L.push('');
  L.push(line(['Checks']));
  if (!data.warnings.length) L.push(line(['OK', 'No validation warnings']));
  for (const w of data.warnings) L.push(line([w.level === 'error' ? 'ERROR' : w.level === 'warn' ? 'WARNING' : 'NOTE', w.msg]));
  L.push('');
  L.push(line(['IMPORTANT', SPEC_DISCLAIMER]));
  return L.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ scale bar (canvas overlay) */
/** A scale bar of a round length (10 or 20 cm) in image pixels, bottom-left of the 1024 canvas. */
export function scaleBar(cal, { canvasSize = 1024, fontPx = 16 } = {}) {
  const info = scaleInfo(cal); if (!info) return null;
  const cm = info.pxPerCm * 10 > canvasSize * 0.5 ? 5 : info.pxPerCm * 10 < canvasSize * 0.12 ? 20 : 10;
  const w = cm * info.pxPerCm, x = canvasSize * 0.04, y = canvasSize - fontPx * 3.6;
  return { x, y, w, cm, label: `${cm} cm${info.calibrated ? ' (calibrated scale)' : ' (estimated scale)'}`, calibrated: info.calibrated };
}
export function drawScaleBar(ctx, cal, opts = {}) {
  const b = scaleBar(cal, opts); if (!b) return;
  const fp = opts.fontPx || 16, lw = opts.lineW || 2;
  ctx.save();
  ctx.strokeStyle = b.calibrated ? '#0f766e' : '#5b6170'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = lw;
  if (!b.calibrated) ctx.setLineDash([lw * 3, lw * 2]);
  ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + b.w, b.y); ctx.moveTo(b.x, b.y - fp * 0.35); ctx.lineTo(b.x, b.y + fp * 0.35); ctx.moveTo(b.x + b.w, b.y - fp * 0.35); ctx.lineTo(b.x + b.w, b.y + fp * 0.35); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `600 ${fp}px "Helvetica Neue", Helvetica, Arial, sans-serif`; ctx.textBaseline = 'top';
  const tw = ctx.measureText(b.label).width;
  ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(b.x - 2, b.y + fp * 0.45, tw + 6, fp * 1.3);
  ctx.fillStyle = b.calibrated ? '#0f766e' : '#3f4552'; ctx.fillText(b.label, b.x + 1, b.y + fp * 0.55);
  ctx.restore();
}

export { SIZES, SIZE_CHARTS };
