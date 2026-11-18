// Threadform - in-browser garment-shape engine: turns parsed prompt ops into three graded variations
// (Subtle / Medium / Bold) using the real warp, fabric and colour engines.
import { REGION_NAMES, alphaOf, canvasFromAlpha, mkCanvas, readRGBA, segmentGarment } from './segment.js';
import { applyShape, DEFAULT_PARAMS, FIT_PRESETS, SLEEVE_PRESETS } from './warp.js';
import { applyColor, applyFabric, mergeChanged, commitPixels } from './fabric.js';

// Share of the requested change applied at each option. Bold is the full request (capped at the slider range);
// Medium and Subtle are clearly smaller so the three options look different.
const LEVELS = [['Subtle', 0.4], ['Medium', 0.75], ['Bold', 1]];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function regionAlpha(seg, name) { const c = seg && seg.regions && seg.regions[name]; return c ? alphaOf(c) : null; }

// returns {geom: Uint8Array|null, paint: Uint8Array|null}; null = whole garment
function targetMasks(seg, mask, ops) {
  const n = seg.w * seg.h || seg.mask.width * seg.mask.height;
  const named = (ops.regions || []).filter(r => REGION_NAMES.includes(r));
  const whole = named.includes('fabric');
  const keep = (ops.keep || []).filter(r => REGION_NAMES.includes(r) && r !== 'fabric');
  let base = null;
  const union = names => { const u = new Uint8Array(n); for (const nm of names) { const a = regionAlpha(seg, nm); if (a) for (let i = 0; i < n; i++) if (a[i] > u[i]) u[i] = a[i]; } return u; };
  if (mask) {
    base = alphaOf(mask);
    if (named.length && !whole) {
      const u = union(named); let cnt = 0; const it = new Uint8Array(n);
      for (let i = 0; i < n; i++) { it[i] = Math.min(base[i], u[i]); if (it[i] > 100) cnt++; }
      if (cnt > 50) base = it;
    }
  } else if (named.length && !whole) base = union(named);
  let paint = base;
  if (keep.length) {
    const k = union(keep), b = base || alphaOf(seg.mask);
    paint = new Uint8Array(n);
    for (let i = 0; i < n; i++) paint[i] = Math.max(0, b[i] - k[i]);
  }
  return { geom: base, paint };
}

// "remove cuffs": replace the cuff band by sleeve fabric taken from further up the same sleeve (stripes skipped)
function removeCuffs(canvas, seg, strength) {
  const w = canvas.width, h = canvas.height, n = w * h, M = seg.metrics || {};
  if (!M.sleeves) return canvas;
  const img = readRGBA(canvas), d = img.data, src = new Uint8ClampedArray(d), flags = new Uint8Array(n);
  const cuffs = regionAlpha(seg, 'cuffs'), stripes = regionAlpha(seg, 'stripes'), sleeve = { L: regionAlpha(seg, 'leftSleeve'), R: regionAlpha(seg, 'rightSleeve') };
  if (!cuffs) return canvas;
  const k = clamp(strength, 0, 1);
  const cmRef = {};
  const okAt = (S, x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) return false;
    for (const [dx, dy] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]]) { const i = (y + dy) * w + x + dx; if (!(sleeve[S][i] > 200 && cuffs[i] < 100 && (!stripes || stripes[i] < 100) && !(cmRef.m && cmRef.m[i]) && Math.hypot(src[i * 4] - cmRef.c[0], src[i * 4 + 1] - cmRef.c[1], src[i * 4 + 2] - cmRef.c[2]) > 70)) return false; }
    return true;
  };
  for (const S of ['L', 'R']) {
    const s = M.sleeves[S]; if (!s || !s.has || !sleeve[S]) continue;
    // cuff pixels = detected end band grown over connected sleeve pixels of the same colour (the full rib)
    const cm = new Uint8Array(n), stack = []; let mr = 0, mg = 0, mb = 0, mc = 0;
    for (let i = 0; i < n; i++) if (cuffs[i] > 100 && sleeve[S][i] > 100) { cm[i] = 1; stack.push(i); mr += src[i * 4]; mg += src[i * 4 + 1]; mb += src[i * 4 + 2]; mc++; }
    if (!mc) continue;
    cmRef.m = cm; cmRef.c = [mr / mc, mg / mc, mb / mc];
    mr /= mc; mg /= mc; mb /= mc;
    while (stack.length) {
      const p = stack.pop(), x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || cm[q] || sleeve[S][q] < 100) continue;
        const o = q * 4;
        if (Math.hypot(src[o] - mr, src[o + 1] - mg, src[o + 2] - mb) < 55) { cm[q] = 1; stack.push(q); }
      }
    }
    const maxStep = 7 * s.cuffLen + 60;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!cm[i]) continue;
      let found = -1;
      for (let step = 3; step < maxStep; step += 3) {
        const qx = x - s.a.x * step, qy = y - s.a.y * step;
        if (okAt(S, qx, qy)) { found = Math.round(qy) * w + Math.round(qx); break; }
      }
      if (found < 0) continue;
      const o = i * 4, q = found * 4;
      for (let c = 0; c < 3; c++) d[o + c] = Math.round(src[o + c] + (src[q + c] - src[o + c]) * k);
      flags[i] = 1;
    }
  }
  return commitPixels(canvas, img, flags);
}

// Parts the user asked us NOT to add (ops.avoid): cuffs are never added as a ribbed band (open hem instead).
const avoids = ops => (ops && Array.isArray(ops.avoid) ? ops.avoid : []);
const sleevePresetFor = ops => (ops.sleevePreset === 'ribbedCuff' && avoids(ops).includes('cuffs') ? 'openHem' : ops.sleevePreset);

function buildParams(ops, s) {
  // Sum the requested change, cap it at the slider range, THEN scale per option. Scaling before capping
  // made Medium and Bold identical whenever a preset and a prompt delta stacked past 100.
  const p = { ...DEFAULT_PARAMS };
  const add = obj => { if (obj) for (const k of Object.keys(DEFAULT_PARAMS)) if (obj[k]) p[k] += obj[k]; };
  add(FIT_PRESETS[ops.fitPreset]);
  add(SLEEVE_PRESETS[sleevePresetFor(ops)]);
  add(ops.paramDeltas);
  if (ops.garmentKind === 'longSleeve' && !(ops.paramDeltas && ops.paramDeltas.sleeveLength > 0)) p.sleeveLength += 100;
  // locked parameters ("without changing the length") are forced to zero after every addition
  for (const k of (Array.isArray(ops.lock) ? ops.lock : [])) if (k in p) p[k] = 0;
  for (const k of Object.keys(p)) p[k] = clamp(clamp(p[k], -100, 100) * s, -100, 100);
  return p;
}

// Regions that must come back exactly as they were: ops.keep, plus logos/text/stripes the user said not to touch.
function keepAlphaFor(seg, ops, n) {
  const names = uniq([...(ops.keep || []), ...avoids(ops).filter(a => ['logos', 'text', 'stripes'].includes(a))])
    .filter(r => REGION_NAMES.includes(r) && r !== 'fabric');
  if (!names.length) return null;
  const u = new Uint8Array(n);
  for (const nm of names) { const a = regionAlpha(seg, nm); if (a) for (let i = 0; i < n; i++) if (a[i] > u[i]) u[i] = a[i]; }
  return u.some(v => v > 0) ? u : null;
}
// Composites the ORIGINAL pixels back over `out` wherever keep>0 (in place), so kept parts stay byte-identical.
function compositeKeep(out, orig, keepA) {
  const w = out.width, h = out.height, n = w * h;
  const octx = out.getContext('2d', { willReadFrequently: true }), od = octx.getImageData(0, 0, w, h);
  const sd = orig.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  for (let i = 0; i < n; i++) {
    const k = keepA[i];
    if (!k) continue;
    if (k >= 255) { od.data.set(sd.subarray(i * 4, i * 4 + 4), i * 4); continue; }
    const f = k / 255;
    for (let c = 0; c < 4; c++) od.data[i * 4 + c] = Math.round(od.data[i * 4 + c] * (1 - f) + sd[i * 4 + c] * f);
  }
  octx.putImageData(od, 0, 0);
  return out;
}

export async function localVariations(canvas, seg, mask, ops = {}) {
  ops = ops || {};
  const w = canvas.width, h = canvas.height;
  if (!seg || !seg.landmarks) seg = await segmentGarment(canvas);
  const { geom: g0, paint } = targetMasks(seg, mask, ops);
  let geom = g0;
  const pd = ops.paramDeltas || {};
  if (geom && !mask && (ops.fitPreset || pd.bodyWidth || pd.shoulderWidth)) {   // widening the body must carry the sleeves along
    geom = new Uint8Array(geom);
    for (const nm of ['leftSleeve', 'rightSleeve']) { const a = regionAlpha(seg, nm); if (a) for (let i = 0; i < geom.length; i++) if (a[i] > geom[i]) geom[i] = a[i]; }
  }
  const geomCanvas = geom ? canvasFromAlpha(geom, w, h) : null;
  const paintCanvas = paint ? canvasFromAlpha(paint, w, h) : null;
  const wantCuffRemoval = !!(ops.removeCuffs || (ops.removeParts || []).includes('cuffs'));
  const hasFabric = ops.fabric && ops.fabric !== 'none';
  const col = ops.color || null;
  const keepA = seg ? keepAlphaFor(seg, ops, w * h) : null;
  const results = [];
  for (const [label, s] of LEVELS) {
    let cur = canvas, cseg = seg;
    const p = buildParams(ops, s);
    if (Object.keys(p).some(k => p[k])) {
      const r = await applyShape(canvas, seg, p, geomCanvas ? { region: geomCanvas } : {});
      cur = r.canvas; cseg = r.seg;
    }
    if (wantCuffRemoval) {
      cur = removeCuffs(cur, cseg, Math.min(1, s * 1.3));
      cseg = { ...cseg, regions: { ...cseg.regions, cuffs: canvasFromAlpha(new Uint8Array(w * h), w, h) } };
    }
    // fabric/colour masks follow the warped content when they are named regions; user masks stay put
    let pm = paintCanvas;
    if (!mask && (ops.regions || ops.keep) && cseg !== seg) {
      const t = targetMasks(cseg, null, ops); pm = t.paint ? canvasFromAlpha(t.paint, w, h) : null;
    }
    if (hasFabric) cur = applyFabric(cur, pm, ops.fabric, clamp((ops.fabricAmount == null ? 0.6 : ops.fabricAmount) * s, 0.1, 1));
    if (col && (col.hue || col.sat || col.light || col.tint)) {
      cur = applyColor(cur, pm, { hue: clamp((col.hue || 0) * s, -180, 180), sat: clamp((col.sat || 0) * s, -100, 100), light: clamp((col.light || 0) * s, -100, 100), tint: col.tint || null, tintAmount: clamp((col.tintAmount == null ? 1 : col.tintAmount) * s, 0, 1) });
    }
    const out = cur === canvas ? (() => { const c = mkCanvas(w, h); c.getContext('2d').drawImage(canvas, 0, 0); return c; })() : mergeChanged(canvas, cur);
    if (keepA) compositeKeep(out, canvas, keepA);
    results.push({ label, canvas: out, seg: cseg });
  }
  return results;
}
