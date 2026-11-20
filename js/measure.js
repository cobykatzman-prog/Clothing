// Threadform - garment measurements (pure logic + canvas/SVG drawing helpers, no state import).
//
// What this does: turns the segmentation of the garment picture (landmarks + metrics from segment.js, pushed
// through the warp by warp.js) into flat-garment measurements in cm / inches, compares them with the original,
// and draws tech-pack style dimension lines (canvas overlay, exported PNG, SVG <g id="measurements">).
//
// HONESTY: these are APPROXIMATE flat-garment measurements. The picture has no ruler in it, so the scale
// (cm per pixel) is anchored on the typical chest width of the chosen size (SIZE_CHARTS) or on a real
// measurement the user types in. Edits (sliders, presets, variations) change the measurements because the
// pixels change; the numbers are never exact tailoring data.

/* ------------------------------------------------------------------ size charts */
export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
export const KINDS = ['tee', 'longSleeve', 'polo', 'hoodie'];
export const KIND_LABELS = { tee: 'T-shirt', longSleeve: 'Long-sleeve tee', polo: 'Polo', hoodie: 'Hoodie' };

/**
 * Typical industry size-chart values for adult unisex garments, FLAT garment measurements in cm, sizes XS..XXL.
 * (Rounded values in line with common blank-garment spec sheets, not a specific brand. Real brands vary by a few cm.)
 *  chest         pit to pit, 2.5 cm below the armhole
 *  length        high point shoulder (HPS) to hem
 *  shoulder      shoulder seam to shoulder seam
 *  sleeve        shoulder seam to sleeve end (short sleeve for tee/polo, full for long sleeve/hoodie)
 *  sleeveOpening flat width of the sleeve opening / cuff
 *  hem           flat width of the bottom hem
 *  neck          neck opening width, seam to seam
 *  neckDrop      HPS to the front neck seam
 */
export const SIZE_CHARTS = {
  tee: {
    chest: [47, 50, 53, 56, 59, 62], length: [66, 68, 70, 72, 74, 76], shoulder: [41, 43, 45, 47, 49, 51],
    sleeve: [18, 19, 20, 21, 22, 23], sleeveOpening: [16, 17, 18, 19, 20, 21], hem: [47, 50, 53, 56, 59, 62],
    neck: [17, 17.5, 18, 18.5, 19, 19.5], neckDrop: [7, 7.5, 8, 8.5, 9, 9.5],
  },
  longSleeve: {
    chest: [47, 50, 53, 56, 59, 62], length: [67, 69, 71, 73, 75, 77], shoulder: [42, 44, 46, 48, 50, 52],
    sleeve: [60, 61, 62, 64, 65, 66], sleeveOpening: [8.5, 9, 9.5, 10, 10.5, 11], hem: [46, 49, 52, 55, 58, 61],
    neck: [17, 17.5, 18, 18.5, 19, 19.5], neckDrop: [7, 7.5, 8, 8.5, 9, 9.5],
  },
  polo: {
    chest: [49, 52, 55, 58, 61, 64], length: [68, 70, 72, 74, 76, 78], shoulder: [42, 44, 46, 48, 50, 52],
    sleeve: [20, 21, 22, 23, 24, 25], sleeveOpening: [17.5, 18.5, 19.5, 20.5, 21.5, 22.5], hem: [49, 52, 55, 58, 61, 64],
    neck: [17.5, 18, 18.5, 19, 19.5, 20], neckDrop: [9, 9.5, 10, 10.5, 11, 11.5],
  },
  hoodie: {
    chest: [54, 56, 59, 62, 64, 66], length: [64, 66, 68, 70, 72, 74], shoulder: [47, 49, 51, 53, 55, 57],
    sleeve: [59, 60, 61, 62, 63, 64], sleeveOpening: [8, 8.5, 9, 9.5, 10, 10.5], hem: [48, 50, 53, 56, 58, 60],
    neck: [20, 21, 22, 23, 24, 25], neckDrop: [9, 9.5, 10, 10.5, 11, 11.5],
  },
};

export const MEASURES = [
  { key: 'chest', label: 'Chest width (pit to pit)', short: 'Chest' },
  { key: 'length', label: 'Body length (HPS to hem)', short: 'Length' },
  { key: 'shoulder', label: 'Shoulder width', short: 'Shoulder' },
  { key: 'sleeve', label: 'Sleeve length', short: 'Sleeve' },
  { key: 'sleeveOpening', label: 'Sleeve opening', short: 'Sleeve opening' },
  { key: 'hem', label: 'Hem width', short: 'Hem' },
  { key: 'neck', label: 'Neck opening width', short: 'Neck' },
  { key: 'neckDrop', label: 'Neck drop', short: 'Neck drop' },
];
const LABEL = Object.fromEntries(MEASURES.map(m => [m.key, m.label]));
const SHORT = Object.fromEntries(MEASURES.map(m => [m.key, m.short]));
/** Which measurements can be used to calibrate by typing a real value. */
export const CALIBRATE_KEYS = ['chest', 'length', 'shoulder', 'hem'];

export function chartValue(kind, size, key) {
  const c = SIZE_CHARTS[kind] || SIZE_CHARTS.tee, i = Math.max(0, SIZES.indexOf(size));
  return c[key] ? c[key][i] : null;
}

// Seam-to-seam shoulder width is narrower than the pit-to-pit width on a set-in sleeve (45 vs 53 cm at M).
// The segmentation's shoulder points sit on the armpit line, so the seam is estimated at this fraction.
const SHOULDER_SEAM = 0.85;
// A neck width edge-to-edge is 0.937 x the ellipse radius used by segment.js (see its neck fit).
const NECK_K = 0.937;

/* ------------------------------------------------------------------ per-design settings (stored in state) */
export function defaultMeasureState() {
  return { size: 'M', unit: 'cm', kind: null, manual: null, show: false };
}
export function normalizeMeasureState(o) {
  const d = defaultMeasureState(); if (!o || typeof o !== 'object') return d;
  const man = o.manual && typeof o.manual === 'object' && CALIBRATE_KEYS.includes(o.manual.key) && o.manual.cm > 0 && o.manual.cm < 400
    ? { key: o.manual.key, cm: +o.manual.cm } : null;
  return {
    size: SIZES.includes(o.size) ? o.size : d.size, unit: 'cm',
    kind: KINDS.includes(o.kind) ? o.kind : null, manual: man, show: !!o.show,
  };
}

/* ------------------------------------------------------------------ units and formatting */
export const cmToIn = cm => cm / 2.54;
export const inToCm = i => i * 2.54;
/** cm values are shown to the nearest 0.5 cm, inch values to the nearest 0.25 in (tailor's quarter inch). */
export const STEP = { cm: 0.5, in: 0.25 };
export function toUnit(cm, unit) { return unit === 'in' ? cmToIn(cm) : cm; }
export function fromUnit(v, unit) { return unit === 'in' ? inToCm(v) : v; }
/** Rounded display number in `unit` (not a string). */
export function roundValue(cm, unit = 'cm') {
  const s = STEP[unit] || 0.5, v = Math.round(toUnit(cm, unit) / s) * s;
  return v === 0 ? 0 : v;   // no "-0"
}
const trim = n => (Math.round(n * 100) / 100).toString();
/** "53 cm", "20.75 in"; with {sign:true}: "+3.5 cm", "-2 in", "0 cm". */
export function formatMeasure(cm, unit = 'cm', { sign = false, unitLabel = true } = {}) {
  if (cm == null || !isFinite(cm)) return '–';
  const v = roundValue(cm, unit);
  const s = (sign && v > 0 ? '+' : v < 0 ? '-' : '') + trim(Math.abs(v));
  return unitLabel ? s + ' ' + unit : s;
}

/* ------------------------------------------------------------------ pixel measurements of a segmentation */
const rawCache = new WeakMap(), alphaCache = new WeakMap();
const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function maskAlpha(c) {
  let a = alphaCache.get(c);
  if (!a) {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    a = new Uint8Array(c.width * c.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    alphaCache.set(c, a);
  }
  return a;
}
/** Width of the garment mask through point p along unit direction n (px). Falls back to `fallback` without a mask. */
function crossWidth(seg, p, n, fallback) {
  try {
    const c = seg.mask || (seg.regions && seg.regions.fabric); if (!c) return fallback;
    const a = maskAlpha(c), w = c.width, h = c.height;
    const at = (x, y) => { const ix = Math.round(x), iy = Math.round(y); return ix >= 0 && iy >= 0 && ix < w && iy < h && a[iy * w + ix] > 127; };
    let sx = p.x, sy = p.y;
    if (!at(sx, sy)) {
      let ok = false;
      for (let t = 1; t <= 60 && !ok; t++) for (const sg of [1, -1]) if (at(p.x + n.x * t * sg, p.y + n.y * t * sg)) { sx = p.x + n.x * t * sg; sy = p.y + n.y * t * sg; ok = true; break; }
      if (!ok) return fallback;
    }
    let t1 = 0, t2 = 0;
    while (t1 < 500 && at(sx + n.x * (t1 + 0.5), sy + n.y * (t1 + 0.5))) t1 += 0.5;
    while (t2 < 500 && at(sx - n.x * (t2 + 0.5), sy - n.y * (t2 + 0.5))) t2 += 0.5;
    return t1 + t2 > 4 ? t1 + t2 : fallback;
  } catch (e) { return fallback; }
}

/** Width of the garment through the central body at row y: run of mask pixels containing x0. {x0,x1} or null. */
function bodyRun(seg, y, x0) {
  try {
    const c = seg.mask || (seg.regions && seg.regions.fabric); if (!c) return null;
    const a = maskAlpha(c), w = c.width, h = c.height, iy = Math.round(y);
    if (iy < 0 || iy >= h) return null;
    const at = x => x >= 0 && x < w && a[iy * w + x] > 127;
    let x = Math.round(x0); if (!at(x)) return null;
    let l = x, r = x; while (at(l - 1)) l--; while (at(r + 1)) r++;
    return { x0: l, x1: r + 1 };
  } catch (e) { return null; }
}

/** Raw pixel measurements of a segmentation (already divided by the warp's uniform fit scale). */
export function rawPixels(seg) {
  if (!seg || !seg.landmarks || (seg.metrics && seg.metrics.empty)) return null;
  const cached = rawCache.get(seg); if (cached) return cached;
  const L = seg.landmarks, M = seg.metrics || {}, fs = M.fitScale || 1;
  const hemY = (L.hemL.y + L.hemR.y) / 2;
  // Chest (pit to pit): the body width a little below the armholes, read from the picture mask, so it is not
  // disturbed by sleeve edits (the armpit landmarks move with the sleeve in the warp). Landmarks are the fallback.
  const ay = (L.armpitL.y + L.armpitR.y) / 2, hemYc = (L.hemL.y + L.hemR.y) / 2;
  const cy = ay + Math.max(6, 0.035 * (hemYc - L.neckTop.y));
  const run = bodyRun(seg, cy, L.centerX);
  const lmChest = hyp(L.armpitL, L.armpitR);
  const useRun = run && run.x1 - run.x0 > 0.6 * lmChest && run.x1 - run.x0 < 1.5 * lmChest;
  // HPS-to-hem is the standard body-length POM. The topmost neck pixel is not HPS:
  // using it overstates body length by the neck rise and makes front/back photos disagree.
  const hpsY = (L.shoulderL.y + L.shoulderR.y) / 2;
  const neckBottomY = L.neckBottom && Number.isFinite(L.neckBottom.y)
    ? L.neckBottom.y : L.neckTop.y + (M.neckRy || 0);
  const raw = {
    chestLine: useRun ? { y: cy, x0: run.x0, x1: run.x1 } : { y: ay, x0: L.armpitR.x, x1: L.armpitL.x },
    chest: (useRun ? run.x1 - run.x0 : lmChest) / fs,
    hem: hyp(L.hemL, L.hemR) / fs,
    shoulder: hyp(L.shoulderL, L.shoulderR) / fs,
    length: Math.max(0, hemY - hpsY) / fs,
    neck: 2 * (M.neckRx || 0) * NECK_K / fs,
    neckDrop: Math.max(0, neckBottomY - hpsY) / fs,
    sleeves: {},
  };
  for (const k of ['L', 'R']) {
    const s = M.sleeves && M.sleeves[k], cuff = k === 'L' ? L.cuffL : L.cuffR;
    if (!s || !s.has || !(s.L > 0)) continue;
    const n = s.n || { x: -s.a.y, y: s.a.x };
    const wpx = crossWidth(seg, cuff, n, 2 * (s.hw || 0) * 0.85);
    // Sleeve length is measured from the shoulder seam to the cuff, not from the
    // sleeve's internal warp root (which sits part-way down the armhole).
    const shoulderPoint = s.shoulder || s.root;
    const cuffPoint = s.cuff || cuff;
    const sleeveLen = shoulderPoint && cuffPoint ? hyp(shoulderPoint, cuffPoint) : s.L;
    raw.sleeves[k] = { len: sleeveLen / fs, open: wpx / fs, n, a: s.a };
  }
  rawCache.set(seg, raw);
  return raw;
}

/** Best guess of the garment type when the user has not chosen one. */
export function guessKind(seg, sampleKind) {
  if (sampleKind && KINDS.includes(sampleKind)) return sampleKind;
  const raw = rawPixels(seg); if (!raw) return 'tee';
  const ls = Object.values(raw.sleeves);
  if (ls.length && raw.length > 0) { const r = ls.reduce((a, s) => a + s.len, 0) / ls.length / raw.length; if (r > 0.5) return 'longSleeve'; }
  return 'tee';
}

/* ------------------------------------------------------------------ calibration */
/**
 * Calibration derived from the ORIGINAL (unedited) segmentation of the reference view:
 *   s  cm per pixel across the garment  = chart chest width of the size / original chest width in px
 *   sy cm per pixel along the body      = s, unless the picture is much taller/shorter than the size chart
 *      (stylised drawings, cropped photos): then body length is matched to the chart instead, and is listed in `adjusted`
 *   ss cm per pixel along the sleeve    = same rule for the sleeve length
 * manual {key, cm}: the user typed a real measurement; every scale is multiplied so that measurement reads exactly that.
 */
export function makeCalibration(refSeg, { kind = 'tee', size = 'M', manual = null } = {}) {
  const raw = rawPixels(refSeg);
  const chart = Object.fromEntries(MEASURES.map(m => [m.key, chartValue(kind, size, m.key)]));
  const cal = { s: 0, sy: 0, ss: 0, shoulderScale: 0, hemScale: 0, neckScale: 0, neckDropScale: 0, kind, size, manual: null, adjusted: [], chart, mode: 'chart' };
  if (!raw || !(raw.chest > 1)) return cal;
  const s = chart.chest / raw.chest;
  cal.s = s; cal.sy = s; cal.ss = s;
  // Front and back are calibrated point-by-point to the same base spec. This corrects
  // small differences in camera scale, cropping and segmentation between the two photos.
  const widthScale = (rawValue, target) => rawValue > 1 && target > 0 ? target / rawValue : s;
  cal.shoulderScale = widthScale(raw.shoulder * SHOULDER_SEAM, chart.shoulder);
  cal.hemScale = widthScale(raw.hem, chart.hem);
  cal.neckScale = widthScale(raw.neck, chart.neck);
  cal.neckDropScale = widthScale(raw.neckDrop, chart.neckDrop);
  // Calibrate each physical axis independently to the selected size chart. Do not use
  // broad percentage thresholds here: that made the same selected size report different
  // body and sleeve lengths depending on the proportions of the source image.
  if (raw.length > 1 && chart.length) {
    cal.sy = chart.length / raw.length;
    if (Math.abs(raw.length * s / chart.length - 1) > 0.05) cal.adjusted.push('length');
  }
  const sl = Object.values(raw.sleeves);
  if (sl.length && chart.sleeve) {
    const len = sl.reduce((a, q) => a + q.len, 0) / sl.length;
    if (len > 1) {
      cal.ss = chart.sleeve / len;
      if (Math.abs(len * s / chart.sleeve - 1) > 0.05) cal.adjusted.push('sleeve');
    }
  }
  // A manual measurement must only change its own axis. Multiplying all three scales
  // caused entering a body length to silently change chest width and sleeve length too.
  if (manual && CALIBRATE_KEYS.includes(manual.key) && manual.cm > 0) {
    const v = measureGarment(refSeg, cal)[manual.key];
    if (v > 0) {
      const f = manual.cm / v;
      if (manual.key === 'length') cal.sy *= f;
      else if (manual.key === 'shoulder') cal.shoulderScale *= f;
      else if (manual.key === 'hem') cal.hemScale *= f;
      else cal.s *= f;
      cal.manual = { key: manual.key, cm: manual.cm };
      cal.mode = 'manual';
    }
  }
  return cal;
}

/** Measurements in cm of one segmentation under a calibration. Missing parts (no sleeves) are null. */
export function measureGarment(seg, cal) {
  const empty = Object.fromEntries(MEASURES.map(m => [m.key, null]));
  const raw = rawPixels(seg);
  if (!raw || !cal || !(cal.s > 0)) return { ...empty, sleeveLeft: null, sleeveRight: null };
  const sl = Object.entries(raw.sleeves);
  const avg = f => (sl.length ? sl.reduce((a, [, q]) => a + f(q), 0) / sl.length : null);
  return {
    chest: raw.chest * cal.s,
    length: raw.length * cal.sy,
    shoulder: raw.shoulder * SHOULDER_SEAM * (cal.shoulderScale || cal.s),
    sleeve: avg(q => q.len * cal.ss),
    sleeveOpening: avg(q => Math.hypot(q.n.x * q.open * cal.s, q.n.y * q.open * cal.sy)),
    hem: raw.hem * (cal.hemScale || cal.s),
    neck: raw.neck * (cal.neckScale || cal.s),
    neckDrop: raw.neckDrop * (cal.neckDropScale || cal.sy),
    sleeveLeft: raw.sleeves.L ? raw.sleeves.L.len * cal.ss : null,
    sleeveRight: raw.sleeves.R ? raw.sleeves.R.len * cal.ss : null,
  };
}

/** Deltas edited - original, per key (cm). Parts missing on either side are null. */
export function compareMeasurements(original, edited) {
  const out = {};
  for (const { key } of MEASURES) {
    const a = original && original[key], b = edited && edited[key];
    out[key] = a == null || b == null ? null : b - a;
  }
  return out;
}

/** Rows for the UI and exports: [{key,label,short,cm,origCm,deltaCm}] (only measurements the garment has). */
export function measurementRows(seg, origSeg, cal) {
  const cur = measureGarment(seg, cal), org = measureGarment(origSeg || seg, cal), d = compareMeasurements(org, cur);
  return MEASURES.filter(m => cur[m.key] != null).map(m => ({
    key: m.key, label: m.label, short: m.short, cm: cur[m.key], origCm: org[m.key], deltaCm: d[m.key],
  }));
}
/** Is the change big enough to show at the display rounding? */
export function visibleDelta(deltaCm, unit) { return deltaCm != null && roundValue(deltaCm, unit) !== 0; }

/* ------------------------------------------------------------------ whole-design glue (state is passed in) */
const calCache = new WeakMap();
const VIEW_ORDER = ['front', 'back', 'side', 'detail'];
/** The view whose ORIGINAL segmentation defines the scale: front first (all views of a design share it). */
export function referenceSeg(state) {
  for (const n of VIEW_ORDER) { const s = state.views[n] && state.views[n].baseSeg; if (s && rawPixels(s)) return s; }
  return null;
}
export function designKind(state, ref) {
  const m = state.measure || defaultMeasureState();
  if (m.kind) return m.kind;
  const sample = VIEW_ORDER.map(n => state.views[n] && state.views[n].sample).find(Boolean);
  return guessKind(ref, sample && sample.kind);
}
export function designCalibration(state, viewName = state.activeView) {
  // Each view is calibrated from its own untouched base image against the SAME selected
  // size chart. This removes differences caused by photo scale, crop and camera distance,
  // while keeping all views on one shared garment specification.
  const fallback = referenceSeg(state);
  const viewBase = ['front', 'back'].includes(viewName) && state.views[viewName] && state.views[viewName].baseSeg;
  const ref = viewBase && rawPixels(viewBase) ? viewBase : fallback;
  if (!ref) return null;
  const m = state.measure || defaultMeasureState(), kind = designKind(state, fallback || ref);
  const key = [kind, m.size, m.manual ? m.manual.key + ':' + m.manual.cm : ''].join('|');
  let per = calCache.get(ref); if (!per) { per = new Map(); calCache.set(ref, per); }
  let cal = per.get(key); if (!cal) { cal = makeCalibration(ref, { kind, size: m.size, manual: m.manual }); per.set(key, cal); }
  return cal;
}
/** Live measurements of one view: {rows, cal, kind, size, unit, seg} or null while there is nothing to measure. */
export function designMeasure(state, viewName = state.activeView) {
  const V = state.views[viewName]; if (!V || !V.seg || !rawPixels(V.seg)) return null;
  const cal = designCalibration(state, viewName); if (!cal) return null;
  const m = state.measure || defaultMeasureState();
  const rows = measurementRows(V.seg, V.baseSeg || V.seg, cal);
  return { rows, cal, kind: cal.kind, size: m.size, unit: m.unit, seg: V.seg, view: viewName };
}
/** Same, shaped for the exporters: {seg, rows, unit, size, kind, basis, view}. */
export function exportMeasureData(state, viewName = state.activeView, { unit } = {}) {
  const d = designMeasure(state, viewName); if (!d) return null;
  return { ...d, unit: 'cm', basis: calibrationText(d.cal, 'cm') };
}
export function calibrationText(cal, unit = 'cm') {
  if (cal.manual) return `your ${SHORT[cal.manual.key].toLowerCase()} = ${formatMeasure(cal.manual.cm, unit)}`;
  return `typical ${KIND_LABELS[cal.kind] || 'garment'} size ${cal.size}`;
}
export const NOTE = 'Approximate flat-garment measurements estimated from the picture and the selected size.';

/* ------------------------------------------------------------------ CSV */
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
/** Measurements as CSV text. data = exportMeasureData(...). Values are in data.unit; the change column carries a sign. */
export function measurementsCSV(data, { design = 'design', view = 'front' } = {}) {
  const u = 'cm', head = ['design', 'view', 'garment', 'size', 'measurement', 'unit', 'original_cm', 'edited_cm', 'change_cm', 'basis'];
  const lines = [head.join(',')];
  for (const r of data.rows) {
    lines.push([design, view, KIND_LABELS[data.kind] || data.kind, data.size, r.label, u,
      formatMeasure(r.origCm, u, { unitLabel: false }), formatMeasure(r.cm, u, { unitLabel: false }),
      formatMeasure(r.deltaCm, u, { sign: true, unitLabel: false }), data.basis].map(csvCell).join(','));
  }
  lines.push('');
  lines.push(csvCell('# ' + NOTE));
  return lines.join('\r\n') + '\r\n';
}

/** Manufacturer-facing measurement CSV. Values are centimetres and remain explicitly marked
 * as estimates until the garment has been physically measured and approved.
 */
export function manufacturerSpecCSV(data, { design = 'Untitled design', view = 'front', toleranceCm = '' } = {}) {
  if (!data || !Array.isArray(data.rows)) throw new TypeError('Measurement data is required');
  const codes = { chest: 'POM-01', length: 'POM-02', shoulder: 'POM-03', sleeve: 'POM-04',
    sleeveOpening: 'POM-05', hem: 'POM-06', neck: 'POM-07', neckDrop: 'POM-08' };
  const definitions = {
    chest: 'Half chest width, measured flat from 2.5 cm below armhole to armhole',
    length: 'Body length from high point shoulder (HPS) to bottom hem',
    shoulder: 'Shoulder width, seam to seam',
    sleeve: 'Sleeve length from shoulder seam to sleeve opening',
    sleeveOpening: 'Sleeve opening width, measured flat',
    hem: 'Bottom hem width, measured flat',
    neck: 'Neck opening width, seam to seam',
    neckDrop: 'Front neck drop from HPS to neck seam',
  };
  const cell = csvCell;
  const lines = [
    ['THREADFORM MANUFACTURER MEASUREMENT SPEC'].map(cell).join(','),
    ['Style', design].map(cell).join(','),
    ['View used for measurements', view].map(cell).join(','),
    ['Garment type', KIND_LABELS[data.kind] || data.kind].map(cell).join(','),
    ['Base size', data.size].map(cell).join(','),
    ['Units', 'cm'].map(cell).join(','),
    ['Measurement status', 'ESTIMATE - verify against a physical sample before production'].map(cell).join(','),
    ['Scale basis', data.basis || 'Selected size chart'].map(cell).join(','),
    [],
    ['POM code', 'Point of measure', 'How to measure', 'Target (cm)', 'Tolerance (cm)', 'Factory actual (cm)', 'Comments'].map(cell).join(','),
  ];
  for (const r of data.rows) {
    lines.push([codes[r.key] || '', r.label, definitions[r.key] || r.label,
      formatMeasure(r.cm, 'cm', { unitLabel: false }), toleranceCm, '', ''].map(cell).join(','));
  }
  lines.push([]);
  lines.push(['Factory / sample comments', ''].map(cell).join(','));
  lines.push(['IMPORTANT', 'These values are image-derived estimates, not verified pattern measurements. Measure a physical sample, confirm all points of measure, tolerances, grading, fabric shrinkage and construction before bulk production.'].map(cell).join(','));
  return lines.map(line => Array.isArray(line) ? line.join(',') : line).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ dimension lines: layout */
const INK = '#1f2937', MUTE = '#5b6170', EXT = '#8a8f9c';
const estW = (text, fp) => text.length * fp * 0.58 + fp * 0.9;

/**
 * Geometry of the dimension lines, in image pixels (1024 space). Shared by the canvas and SVG renderers.
 * Lines sit OUTSIDE the silhouette (above, left, below, beside the sleeve) with extension lines to the garment,
 * except the chest line which crosses the body at the armpits like a tech pack.
 * opts: {unit, fontPx (default 19), canvasSize (clamp inside, e.g. 1024), only:[keys]}
 */
export function dimensionLayout(seg, rows, opts = {}) {
  const raw = rawPixels(seg); if (!raw || !rows || !rows.length) return { dims: [], exts: [] };
  const unit = opts.unit || 'cm', fp = opts.fontPx || 19, cs = opts.canvasSize || 0;
  const by = {}; rows.forEach(r => { by[r.key] = r; });
  const L = seg.landmarks, M = seg.metrics, bb = seg.bbox && seg.bbox.w ? seg.bbox : { x: L.hemR.x, y: L.neckTop.y, w: L.hemL.x - L.hemR.x, h: 1 };
  const hemY = (L.hemL.y + L.hemR.y) / 2, cx = L.centerX;
  const dims = [], exts = [];
  const lim = (v, lo, hi) => (cs ? Math.min(hi, Math.max(lo, v)) : v);
  const pad = fp * 0.9;
  const want = k => by[k] && (!opts.only || opts.only.includes(k));
  const text = k => ({ name: SHORT[k], value: formatMeasure(by[k].cm, unit) });
  const add = (k, a, b, extra = {}) => {
    const t = text(k), w = estW(t.name + ' ' + t.value, fp), len = Math.hypot(b.x - a.x, b.y - a.y);
    let ang = Math.atan2(b.y - a.y, b.x - a.x); if (Math.cos(ang) < -1e-6 || (Math.abs(Math.cos(ang)) < 1e-6 && Math.sin(ang) > 0)) ang += Math.PI;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let off = 0;
    if (len < w + fp * 2.6) off = (extra.side || -1) * (fp * 1.5);   // too short for the label on the line: lift it clear
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    dims.push({ key: k, a, b, name: t.name, value: t.value, w, h: fp * 1.5, ang, lx: mid.x + nx * off, ly: mid.y + ny * off, lifted: !!off });
  };
  const top = Math.max(lim(L.neckTop.y, 0, 1e9), 0);

  if (want('shoulder')) {   // above the garment, extension lines drop to the shoulder seams
    const half = hyp(L.shoulderL, L.shoulderR) / 2 * SHOULDER_SEAM, y = lim(top - fp * 5.4, fp * 1.3, 1e9);
    const sy = (L.shoulderL.y + L.shoulderR.y) / 2;
    add('shoulder', { x: cx - half, y }, { x: cx + half, y });
    exts.push({ a: { x: cx - half, y: y + 6 }, b: { x: cx - half, y: sy - 3 } }, { a: { x: cx + half, y: y + 6 }, b: { x: cx + half, y: sy - 3 } });
  }
  if (want('neck')) {
    const e = (M.neckRx || 40) * NECK_K, y = lim(top - fp * 1.0, fp * 1.3, 1e9);
    add('neck', { x: cx - e, y }, { x: cx + e, y }, { side: -1 });
    exts.push({ a: { x: cx - e, y: y + 4 }, b: { x: cx - e, y: top + 2 } }, { a: { x: cx + e, y: y + 4 }, b: { x: cx + e, y: top + 2 } });
  }
  if (want('length')) {     // left of the garment
    const x = lim(bb.x - fp * 2.2, fp * 1.5, 1e9);
    add('length', { x, y: L.neckTop.y }, { x, y: hemY });
    exts.push({ a: { x: x + 6, y: L.neckTop.y }, b: { x: cx - (M.neckRx || 40), y: L.neckTop.y } }, { a: { x: x + 6, y: hemY }, b: { x: L.hemR.x - 3, y: hemY } });
  }
  if (want('hem')) {        // below the garment
    const y = lim(hemY + fp * 2.0, 0, (cs || 1e9) - fp * 1.3);
    add('hem', { x: L.hemR.x, y }, { x: L.hemL.x, y });
    exts.push({ a: { x: L.hemR.x, y: hemY + 3 }, b: { x: L.hemR.x, y: y - 6 } }, { a: { x: L.hemL.x, y: hemY + 3 }, b: { x: L.hemL.x, y: y - 6 } });
  }
  if (want('chest')) {      // across the body at the armpits
    const cl = raw.chestLine;
    add('chest', { x: cl.x0, y: cl.y }, { x: cl.x1, y: cl.y });
  }
  if (want('sleeve')) {     // along the outside of one sleeve
    const key = M.sleeves && M.sleeves.L && M.sleeves.L.has ? 'L' : (M.sleeves && M.sleeves.R && M.sleeves.R.has ? 'R' : null);
    if (key) {
      const s = M.sleeves[key], a = s.a;
      let n = { x: -a.y, y: a.x }; if (n.y > 0) n = { x: -n.x, y: -n.y };   // the side facing up
      const d = (s.hw || 30) + fp * 1.7;
      const A = { x: s.root.x + n.x * d, y: s.root.y + n.y * d }, B = { x: s.root.x + a.x * s.L + n.x * d, y: s.root.y + a.y * s.L + n.y * d };
      add('sleeve', A, B, { side: -1 });
      const e = (s.hw || 30) * 0.9;
      exts.push({ a: { x: A.x - n.x * 6, y: A.y - n.y * 6 }, b: { x: s.root.x + n.x * e, y: s.root.y + n.y * e } },
        { a: { x: B.x - n.x * 6, y: B.y - n.y * 6 }, b: { x: s.root.x + a.x * s.L + n.x * e, y: s.root.y + a.y * s.L + n.y * e } });
    }
  }
  return { dims, exts, fp };
}

/* ------------------------------------------------------------------ dimension lines: canvas */
function arrowPts(p, q, size) {   // arrowhead at p pointing away from q
  const ang = Math.atan2(p.y - q.y, p.x - q.x), s = size, w = size * 0.36;
  const bx = p.x - Math.cos(ang) * s, by = p.y - Math.sin(ang) * s;
  return [p, { x: bx - Math.sin(ang) * w, y: by + Math.cos(ang) * w }, { x: bx + Math.sin(ang) * w, y: by - Math.cos(ang) * w }];
}
/**
 * Draws tech-pack style dimension lines on a canvas context (image pixel space).
 * seg: segmentation of the picture being drawn on. rows: from measurementRows. opts: {unit, fontPx, lineW, canvasSize, only}
 */
export function drawDimensionLines(ctx, seg, rows, opts = {}) {
  const lay = dimensionLayout(seg, rows, opts); if (!lay.dims.length) return;
  const fp = lay.fp, lw = opts.lineW || Math.max(1.4, fp * 0.085), ah = fp * 0.62;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = EXT; ctx.lineWidth = lw * 0.75; ctx.setLineDash([lw * 2.6, lw * 2.2]);
  for (const e of lay.exts) { ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke(); }
  ctx.setLineDash([]);
  for (const d of lay.dims) {
    // casing so the line reads on dark and light cloth
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = lw * 2.6;
    ctx.beginPath(); ctx.moveTo(d.a.x, d.a.y); ctx.lineTo(d.b.x, d.b.y); ctx.stroke();
    ctx.strokeStyle = INK; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(d.a.x, d.a.y); ctx.lineTo(d.b.x, d.b.y); ctx.stroke();
    ctx.fillStyle = INK;
    for (const [p, q] of [[d.a, d.b], [d.b, d.a]]) {
      const t = arrowPts(p, q, ah); ctx.beginPath(); ctx.moveTo(t[0].x, t[0].y); ctx.lineTo(t[1].x, t[1].y); ctx.lineTo(t[2].x, t[2].y); ctx.closePath(); ctx.fill();
    }
  }
  ctx.font = `500 ${fp}px system-ui, "Helvetica Neue", Arial, sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const d of lay.dims) {
    const nw = ctx.measureText(d.name + ' ').width, vw = (ctx.font = `700 ${fp}px system-ui, "Helvetica Neue", Arial, sans-serif`, ctx.measureText(d.value).width);
    const tw = nw + vw, pw = tw + fp * 0.9, ph = d.h;
    ctx.save(); ctx.translate(d.lx, d.ly); ctx.rotate(d.ang);
    ctx.fillStyle = 'rgba(255,255,255,.96)'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.6;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-pw / 2, -ph / 2, pw, ph, ph * 0.28); else ctx.rect(-pw / 2, -ph / 2, pw, ph);
    ctx.fill(); ctx.stroke();
    ctx.font = `500 ${fp}px system-ui, "Helvetica Neue", Arial, sans-serif`; ctx.fillStyle = MUTE; ctx.fillText(d.name + ' ', -tw / 2, 1);
    ctx.font = `700 ${fp}px system-ui, "Helvetica Neue", Arial, sans-serif`; ctx.fillStyle = INK; ctx.fillText(d.value, -tw / 2 + nw, 1);
    ctx.restore();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ dimension lines: SVG */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = n => Math.round(n * 10) / 10;
/** The same dimension lines as a self-contained <g id="measurements"> string (1024 viewBox coordinates). */
export function dimensionLinesSVG(seg, rows, opts = {}) {
  const lay = dimensionLayout(seg, rows, { canvasSize: 1024, ...opts }); if (!lay.dims.length) return '';
  const fp = lay.fp, lw = opts.lineW || Math.max(1.4, fp * 0.085), ah = fp * 0.62;
  const o = [`<g id="measurements" font-family="Helvetica, Arial, sans-serif" font-size="${fp}">`];
  o.push(`<g id="measurement-extensions" stroke="${EXT}" stroke-width="${r1(lw * 0.75)}" stroke-dasharray="${r1(lw * 2.6)} ${r1(lw * 2.2)}" fill="none" stroke-linecap="round">`);
  for (const e of lay.exts) o.push(`<line x1="${r1(e.a.x)}" y1="${r1(e.a.y)}" x2="${r1(e.b.x)}" y2="${r1(e.b.y)}"/>`);
  o.push('</g>');
  for (const d of lay.dims) {
    o.push(`<g id="dim-${d.key}">`);
    o.push(`<line x1="${r1(d.a.x)}" y1="${r1(d.a.y)}" x2="${r1(d.b.x)}" y2="${r1(d.b.y)}" stroke="${INK}" stroke-width="${r1(lw)}" stroke-linecap="round"/>`);
    for (const [p, q] of [[d.a, d.b], [d.b, d.a]]) {
      const t = arrowPts(p, q, ah);
      o.push(`<polygon points="${t.map(v => r1(v.x) + ',' + r1(v.y)).join(' ')}" fill="${INK}"/>`);
    }
    const pw = d.w, ph = d.h;
    o.push(`<g transform="translate(${r1(d.lx)} ${r1(d.ly)}) rotate(${r1(d.ang * 180 / Math.PI)})">`);
    o.push(`<rect x="${r1(-pw / 2)}" y="${r1(-ph / 2)}" width="${r1(pw)}" height="${r1(ph)}" rx="${r1(ph * 0.28)}" fill="#fff" fill-opacity="0.96" stroke="${INK}" stroke-width="${r1(lw * 0.6)}"/>`);
    o.push(`<text x="0" y="${r1(fp * 0.35)}" text-anchor="middle"><tspan fill="${MUTE}">${esc(d.name)} </tspan><tspan fill="${INK}" font-weight="700">${esc(d.value)}</tspan></text>`);
    o.push('</g></g>');
  }
  o.push('</g>');
  return o.join('\n');
}

/* ------------------------------------------------------------------ table on the design sheet */
/**
 * Draws the measurements table (name, original, edited, change) on a canvas. Returns the y below the table.
 * data = exportMeasureData(...). box: {x, y, w}. Font sizes are for the 2400x1700 sheet.
 */
export function drawMeasureTable(ctx, data, box, { ink = '#1f2328', mute = '#6b7280', line = '#d9d4c7', sans = '"Helvetica Neue", Helvetica, Arial, sans-serif' } = {}) {
  const { x, w } = box; let y = box.y;
  const u = data.unit;
  ctx.save(); ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink; ctx.font = `700 28px ${sans}`; ctx.textAlign = 'left'; ctx.fillText('MEASUREMENTS', x, y + 24);
  ctx.textAlign = 'left'; ctx.fillStyle = mute; ctx.font = `400 21px ${sans}`;
  ctx.fillText(`${KIND_LABELS[data.kind] || 'Garment'} · size ${data.size} · ${u === 'in' ? 'inches' : 'cm'}`, x, y + 56);
  ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y + 40); ctx.lineTo(x + w, y + 40); ctx.stroke();
  y += 96;
  const cName = x, cOrig = x + w * 0.56, cEdit = x + w * 0.77, cChg = x + w;
  ctx.font = `700 18px ${sans}`; ctx.fillStyle = mute;
  ctx.textAlign = 'left'; ctx.fillText('MEASUREMENT', cName, y);
  ctx.textAlign = 'right'; ctx.fillText('ORIGINAL', cOrig, y); ctx.fillText('EDITED', cEdit, y); ctx.fillText('CHANGE', cChg, y);
  y += 12; ctx.strokeStyle = '#ece8dc'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke();
  y += 33;
  for (const r of data.rows) {
    ctx.font = `400 23px ${sans}`; ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.fillText(r.short, cName, y);
    ctx.textAlign = 'right'; ctx.fillStyle = mute; ctx.fillText(formatMeasure(r.origCm, u, { unitLabel: false }), cOrig, y);
    ctx.fillStyle = ink; ctx.font = `700 23px ${sans}`; ctx.fillText(formatMeasure(r.cm, u, { unitLabel: false }), cEdit, y);
    const vis = visibleDelta(r.deltaCm, u);
    ctx.font = `700 22px ${sans}`; ctx.fillStyle = !vis ? mute : r.deltaCm > 0 ? '#15803d' : '#b91c1c';
    ctx.fillText(vis ? formatMeasure(r.deltaCm, u, { sign: true, unitLabel: false }) : '0', cChg, y);
    ctx.strokeStyle = '#ece8dc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y + 13); ctx.lineTo(x + w, y + 13); ctx.stroke();
    y += 41;
  }
  ctx.textAlign = 'left'; ctx.fillStyle = mute; ctx.font = `italic 400 18px ${sans}`;
  ctx.fillText('Approximate flat-garment measurements', x, y + 14);
  ctx.fillText('estimated from the picture and the size.', x, y + 38);
  ctx.fillText('Basis: ' + data.basis + '.', x, y + 62);
  ctx.restore();
  return y + 70;
}
