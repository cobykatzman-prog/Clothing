// Threadform - linked front/back geometry: shape the BACK view so its proportions match the FRONT.
// Both views are measured with the same calibration (one cm-per-pixel scale for the physical garment), then the
// back's shape parameters are solved from the measured ratios using the same scale laws as warp.js:
//   body width   x (1 + 0.45 P/100)     body length  ~ 0.30 P/100 of the body height
//   shoulders    x (1 + 0.25 P/100)     sleeve len   x (1 + 1.7 P/100)  (0.7 when shortening)
//   sleeve width x (1 + 0.6 P/100)
// Only the parameters that have a measurement are solved; the rest (flare, shape, collar, neck, hem) are left alone.
import { makeCalibration, measureGarment } from './measure.js';
import { applyShape } from './warp.js';

const SHAPE_KEYS = ['bodyWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength', 'sleeveWidth', 'sleeveFlare', 'sleeveShape', 'collarSize', 'neckOpening', 'hemShape', 'cropLength'];

/** The shape parameter names shared by the front and the back when LINK FRONT & BACK SHAPE is on. */
export function shapeKeys() { return [...SHAPE_KEYS]; }

const clamp = (v, a = -100, b = 100) => Math.min(b, Math.max(a, v));
const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
const ok = v => v != null && isFinite(v) && v > 0;

/**
 * Back parameter values (and deltas from backParams) that make the back's chest width, body length, shoulder width,
 * sleeve length and sleeve width equal the front's, measured with the shared calibration `calib`.
 * The first solve is analytic. Parameters interact (shoulder width also widens the chest), so when `backCanvas` is
 * given the back is re-shaped with the real warp and the error is corrected (`refine` passes, damped).
 * -> {deltas, target, front, back, ratios, unmatched, refined}. deltas/target only contain shapeKeys() names.
 */
export async function matchBackToFront({ frontSeg, backSeg, backCanvas = null, frontParams = {}, backParams = {}, calib = null, refine = 8 } = {}) {
  const cal = calib && calib.s > 0 ? calib : makeCalibration(frontSeg);
  const fm = measureGarment(frontSeg, cal), bm = measureGarment(backSeg, cal);
  const pb = k => clamp(num(backParams[k]));
  const target = {}, ratios = {}, unmatched = [];
  const solve = (key, pairFront, pairBack, fn) => {
    if (!ok(pairFront) || !ok(pairBack)) { unmatched.push(key); return; }
    const r = pairFront / pairBack;
    ratios[key] = +r.toFixed(4);
    target[key] = Math.round(clamp(fn(r)));
  };
  // body width: the back's current width factor times the front/back ratio
  solve('bodyWidth', fm.chest, bm.chest, r => ((1 + 0.45 * pb('bodyWidth') / 100) * r - 1) * 100 / 0.45);
  // body length: the length change needed, in cm, expressed in the 0.30 length law of the body height
  if (ok(fm.length) && ok(bm.length)) {
    ratios.bodyLength = +(fm.length / bm.length).toFixed(4);
    const dCm = fm.length - bm.length;
    target.bodyLength = Math.round(clamp(pb('bodyLength') + dCm * 100 / (0.30 * bm.length)));
  } else unmatched.push('bodyLength');
  solve('shoulderWidth', fm.shoulder, bm.shoulder, r => ((1 + 0.25 * pb('shoulderWidth') / 100) * r - 1) * 100 / 0.25);
  // sleeve length: law differs for lengthening (1.7) and shortening (0.7)
  solve('sleeveLength', fm.sleeve, bm.sleeve, r => {
    const sv = pb('sleeveLength'), cur = sv >= 0 ? 1 + 1.7 * sv / 100 : 1 + 0.7 * sv / 100, want = cur * r;
    return want >= 1 ? (want - 1) * 100 / 1.7 : (want - 1) * 100 / 0.7;
  });
  solve('sleeveWidth', fm.sleeveOpening, bm.sleeveOpening, r => ((1 + 0.6 * pb('sleeveWidth') / 100) * r - 1) * 100 / 0.6);
  // refinement with the real warp: measure the shaped back, correct each parameter by its remaining error
  let refined = 0, final = bm;
  if (backCanvas && Object.keys(target).length) {
    const SLOPE = { bodyWidth: ['chest', 0.45], shoulderWidth: ['shoulder', 0.25], sleeveLength: ['sleeve', 1.7], sleeveWidth: ['sleeveOpening', 0.6] };
    for (; refined < refine; refined++) {
      const r = await applyShape(backCanvas, backSeg, target);
      const bmi = measureGarment(r.seg, cal);
      final = bmi;
      let worst = 0;
      for (const [k, [mk, slope]] of Object.entries(SLOPE)) {
        const f = fm[mk], b = bmi[mk];
        if (!ok(f) || !ok(b) || target[k] === undefined) continue;
        const err = f / b - 1; worst = Math.max(worst, Math.abs(err));
        if (Math.abs(err) > 0.004) target[k] = Math.round(clamp(target[k] + err * 100 / slope * 0.9));
      }
      if (ok(fm.length) && ok(bmi.length) && target.bodyLength !== undefined) {
        const err = fm.length - bmi.length; worst = Math.max(worst, Math.abs(err / fm.length));
        if (Math.abs(err / fm.length) > 0.004) target.bodyLength = Math.round(clamp(target.bodyLength + err * 100 / (0.30 * bmi.length) * 0.9));
      }
      if (worst <= 0.004) { refined++; break; }
    }
  }
  // parameters with no measurement keep the back's own value
  const deltas = {};
  for (const k of Object.keys(target)) deltas[k] = target[k] - pb(k);
  return { deltas, target, front: fm, back: final, ratios, unmatched, refined, calibration: cal };
}
