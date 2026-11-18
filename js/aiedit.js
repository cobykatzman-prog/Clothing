// Threadform - localised AI editing (Phase 3a). One pipeline for "Create 3 options":
//   1. understand the instruction (AI when on, else / on failure the rule-based parsePrompt)
//   2. decide the EDIT MASK: the user's selection; else the named segmentation regions (dilated, inside the garment);
//      else the whole garment. Regions the person asked to keep unchanged (and ops.keep) are always subtracted.
//   3. one edit per level (Subtle / Medium / Bold), in parallel; a failed level falls back to the built-in engine
//   4. every result is COMPOSITED through the edit mask into the original (compositeThroughMask), so the pixels
//      outside the mask are never changed, whatever the model returned.
import { state, activeView, hasMask } from './state.js';
import { makeCanvas, userError } from './util.js';
import { REGION_NAMES, alphaOf, canvasFromAlpha } from './segment.js';
import * as M from './mask.js';
import { parsePrompt } from './prompt.js';
import { localVariations } from './variations.js';
import { aiEdit, aiUnderstand, AiError, useAi } from './ai.js';
import { compositeThroughMask, clampFeather, DEFAULT_FEATHER, MAX_FEATHER } from './composite.js';

export { compositeThroughMask, clampFeather, DEFAULT_FEATHER, MAX_FEATHER };

export const LEVELS = [{ label: 'Subtle', level: 'subtle' }, { label: 'Medium', level: 'medium' }, { label: 'Bold', level: 'bold' }];
const GROW_PX = 6;            // implicit (region) masks grow a little so the edit has room, then stay inside the garment
const MIN_PIXELS = 24;        // alpha threshold for "something is selected"

const uniq = a => [...new Set(a)];
const arr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

// ---------------------------------------------------------------- words -> regions
const WORD_REGIONS = [
  [/\bcollars?\b|\bnecklines?\b|\bneck\b/, ['collar', 'neckline']],
  [/\bsleeves?\b/, ['leftSleeve', 'rightSleeve']],
  [/\bcuffs?\b|\brib(?:bing)?\b/, ['cuffs']],
  [/\bstripes?\b|\bpiping\b/, ['stripes']],
  [/\blogos?\b|\bemblems?\b|\bcrest\b/, ['logos']],
  [/\btext\b|\blettering\b|\btypography\b/, ['text']],
  [/\bbody\b|\btorso\b|\bfront panel\b/, ['body']],
  [/\bhems?\b/, ['hem']],
  [/\bshoulders?\b/, ['shoulders']],
  [/\bside panels?\b/, ['sidePanels']],
  [/\bfabric\b|\bmaterial\b/, ['fabric']]
];
const REGION_WORDS = { leftSleeve: 'left sleeve', rightSleeve: 'right sleeve', sidePanels: 'side panels' };
const prettyRegion = r => REGION_WORDS[r] || r;

/** Region names from a list of region ids or plain phrases ("the collar", "both sleeves"). Unknown words are ignored. */
export function regionsFrom(list) {
  const out = [];
  for (const s of arr(list)) {
    if (REGION_NAMES.includes(s)) { out.push(s); continue; }
    const low = s.toLowerCase();
    for (const [re, names] of WORD_REGIONS) if (re.test(low)) out.push(...names);
  }
  return uniq(out.filter(r => REGION_NAMES.includes(r)));
}

const KEEP_CLAUSE = /\b(?:keep|preserve|retain|leave|maintain|don'?t change|do not change|don'?t touch|do not touch|without changing|without touching)\b([^.;!?]{0,80})/gi;
/** The parts the person asked to stay unchanged, e.g. "keep the collar unchanged" -> ['collar']. */
export function keepPhrasesRegions(text) {
  const found = [];
  for (const m of String(text || '').toLowerCase().matchAll(KEEP_CLAUSE)) {
    // the clause ends at the next conjunction: "keep the collar unchanged but make the sleeves flared" freezes the collar only
    const tail = m[1].split(/\b(?:but|and|while|then|so|except|although|however)\b|,/)[0];
    if (/\beverything\b|\bthe rest\b/.test(tail)) continue;   // "keep everything else" is handled by parsePrompt's keepAllExcept
    found.push(...regionsFrom([tail]));
  }
  return uniq(found);
}

function normaliseOps(raw) {
  const o = raw && typeof raw === 'object' ? { ...raw } : {};
  return {
    ...o,
    regions: arr(o.regions), keep: arr(o.keep), lock: arr(o.lock), avoid: arr(o.avoid), keepNotes: arr(o.keepNotes),
    summary: typeof o.summary === 'string' ? o.summary : '',
  };
}

// ---------------------------------------------------------------- masks
function alphaOfSized(canvas, w, h) {
  if (canvas.width === w && canvas.height === h) return alphaOf(canvas);
  const c = makeCanvas(w, h); c.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return alphaOf(c);
}
const countAbove = (a, t = MIN_PIXELS) => { let c = 0; for (let i = 0; i < a.length; i++) if (a[i] > t) c++; return c; };

/** Edit alpha (Uint8Array) for a set of region names, grown a little and kept inside the garment. */
function regionAlpha(seg, names, garmentA, n) {
  const u = M.fromRegions(seg, names);        // plane, same size as the segmentation
  const g = garmentA || (() => { const f = new Uint8Array(n); f.fill(255); return f; })();
  return Uint8Array.from(M.dilateToGarment(u, g, GROW_PX));
}

// ---------------------------------------------------------------- understanding + planning
/**
 * Everything before the model is called: the instruction, the constraints and the edit mask.
 * @returns {Promise<object>} plan (passed to editOneLevel)
 */
export async function prepareEdit({ prompt, view = 'front', mask = null, src, seg = null, refs = [], feather = DEFAULT_FEATHER, signal = null } = {}) {
  const text = String(prompt || '').trim();
  if (!src) throw userError('Load or generate a garment first.');
  const w = src.width, h = src.height, n = w * h;
  const hasSel = !!mask && countAbove(alphaOfSized(mask, w, h)) > 0;

  // 1. understand
  let ops = null, understood = 'local', understandError = null;
  if (useAi()) {
    try { ops = await aiUnderstand({ prompt: text, image: src, view, hasSelection: hasSel, signal }); understood = 'ai'; }
    catch (e) { if (signal?.aborted || e?.kind === 'aborted') throw e; understandError = e; }
  }
  if (!ops) ops = parsePrompt(text);
  ops = normaliseOps(ops);

  // 2. constraints: ops.keep / ops.lock / the person's "keep ... unchanged" phrases are all regions that must not change
  const keep = uniq([...regionsFrom(ops.keep), ...regionsFrom(ops.lock), ...keepPhrasesRegions(text)]);
  const keepText = uniq([...keep.map(prettyRegion), ...ops.keepNotes.slice(0, 6)]).slice(0, 12);
  const avoid = ops.avoid.map(s => s.slice(0, 120)).slice(0, 8);
  const regions = regionsFrom(ops.regions).filter(r => r !== 'fabric');
  const wholeGarment = regionsFrom(ops.regions).includes('fabric');

  const parts = [text];
  if (keepText.length) parts.push(`Keep these exactly as they are: ${keepText.join(', ')}.`);
  if (avoid.length) parts.push(`Do not: ${avoid.join('; ')}.`);
  parts.push('Change only the selected area. Keep everything else, including colours, fabric, stripes, logos, text and stitching, exactly as it is.');
  const augmented = parts.join(' ');

  // 3. the edit mask (alpha: 255 = editable)
  const garmentA = seg && seg.mask ? alphaOfSized(seg.mask, w, h) : null;
  const subtractKeep = a => {
    for (const r of keep) {
      const c = seg && seg.regions && seg.regions[r];
      if (!c) continue;
      const k = alphaOfSized(c, w, h);
      for (let i = 0; i < n; i++) if (k[i]) a[i] = Math.round(a[i] * (255 - k[i]) / 255);
    }
    return a;
  };
  let source, alpha;
  if (hasSel) {
    source = 'selection';
    alpha = Uint8Array.from(alphaOfSized(mask, w, h));
  } else if (regions.length && !wholeGarment && seg && seg.regions) {
    source = 'regions';
    alpha = regionAlpha(seg, regions, garmentA, n);
  } else {
    source = 'garment';
    alpha = garmentA ? Uint8Array.from(garmentA) : (() => { const f = new Uint8Array(n); f.fill(255); return f; })();
  }
  alpha = subtractKeep(alpha);
  if (countAbove(alpha) === 0) {
    if (source === 'selection') throw userError('Everything you selected is also marked to stay unchanged, so there is nothing to change. Adjust the selection or the words.');
    // the named parts were all "keep" parts: change the rest of the garment instead
    source = 'garment';
    alpha = subtractKeep(garmentA ? Uint8Array.from(garmentA) : (() => { const f = new Uint8Array(n); f.fill(255); return f; })());
    if (countAbove(alpha) === 0) throw userError('Nothing is left to change once the parts you asked to keep are excluded.');
  }

  const plan = {
    text, prompt: augmented, ops, keep, constraints: { keep: keepText, avoid },
    src, seg, view, refs, feather: clampFeather(feather), understood, understandError,
    hasSelection: hasSel, maskSource: source, alpha,
    editMaskCanvas: canvasFromAlpha(alpha, w, h),
    // the built-in engine keeps its own region rules; it only gets the user's selection and the keep list
    localMask: hasSel ? mask : null,
    localOps: { ...ops, keep: uniq([...ops.keep, ...keep]) },
    local: null
  };
  return plan;
}

// ---------------------------------------------------------------- one level
function localResults(plan) {
  if (!plan.local) plan.local = localVariations(plan.src, plan.seg, plan.localMask, plan.localOps);
  return plan.local;
}
async function localOption(plan, index, source) {
  const lv = await localResults(plan);
  const r = lv[index];
  const canvas = plan.localMask ? compositeOn(plan.src, r.canvas, plan.localMask, 0) : r.canvas;
  return {
    label: LEVELS[index].label, level: LEVELS[index].level, canvas, seg: plan.localMask ? null : (r.seg || null),
    source, mask: plan.localMask, ops: plan.ops, prompt: plan.text, feather: 0
  };
}
function compositeOn(original, edited, mask, feather) {
  const w = original.width, h = original.height;
  const o = original.getContext('2d').getImageData(0, 0, w, h);
  const e = edited.getContext('2d').getImageData(0, 0, w, h);
  const m = alphaOfSized(mask, w, h);
  const r = compositeThroughMask(o, e, m, { feather });
  const c = makeCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(r.data, w, h), 0, 0);
  return c;
}

/**
 * One option (index 0 = Subtle, 1 = Medium, 2 = Bold). AI when on; a failed AI level falls back to the built-in engine
 * for THAT level and says so (`note`, `reason`, `retryAfter`). Cancellation rejects with an AiError of kind 'aborted'.
 */
export async function editOneLevel({ plan, index, signal = null } = {}) {
  const L = LEVELS[index];
  if (!L) throw new TypeError('bad level index');
  if (signal && signal.aborted) throw new AiError('aborted');
  if (!useAi()) return localOption(plan, index, 'local');
  try {
    const r = await aiEdit({
      image: plan.src, mask: plan.editMaskCanvas, prompt: plan.prompt, constraints: plan.constraints,
      refs: plan.refs, view: plan.view, level: L.level, signal
    });
    const canvas = compositeOn(plan.src, r.canvas, plan.editMaskCanvas, plan.feather);
    return {
      label: L.label, level: L.level, canvas, seg: null, source: 'ai', mask: plan.editMaskCanvas, ops: plan.ops,
      prompt: plan.text, feather: plan.feather, model: r.model, ms: r.ms
    };
  } catch (e) {
    if ((signal && signal.aborted) || (e && e.kind === 'aborted')) throw e instanceof AiError ? e : new AiError('aborted');
    const err = e instanceof AiError ? e : new AiError('upstream');
    const opt = await localOption(plan, index, 'local-fallback');
    return { ...opt, note: err.message, reason: err.kind, retryAfter: err.retryAfter };
  }
}

/**
 * The whole pipeline in one call: understand, plan, then the three levels in parallel.
 * `onOption(index, option)` is called as each option arrives. Resolves { plan, options }.
 */
export async function runAiEdit({ prompt, view = state.activeView, mask, signal = null, src, seg, refs = state.references || [], feather = DEFAULT_FEATHER, onOption = null } = {}) {
  const V = activeView();
  if (src === undefined) src = V.current;
  if (seg === undefined) seg = V.seg;
  if (mask === undefined) mask = hasMask(V) ? V.mask : null;
  const plan = await prepareEdit({ prompt, view, mask, src, seg, refs, feather, signal });
  const settled = await Promise.allSettled(LEVELS.map((_, i) => editOneLevel({ plan, index: i, signal }).then(o => { if (onOption) onOption(i, o); return o; })));
  if (signal && signal.aborted) throw new AiError('aborted');
  const bad = settled.find(s => s.status === 'rejected');
  if (bad) throw bad.reason;
  return { plan, options: settled.map(s => s.value) };
}

/** Feathered composite of a canvas result through a mask canvas (exported for the browser-side combine). */
export function compositeCanvases(original, edited, mask, { feather = DEFAULT_FEATHER } = {}) {
  return compositeOn(original, edited, mask, clampFeather(feather));
}
