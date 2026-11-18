// Threadform - colour and procedural fabric texture, applied through an optional alpha mask.
// Only pixels that actually change are written back; everything else keeps its exact original bytes.
import { mkCanvas, readRGBA, alphaOf } from './segment.js';

export const FABRICS = ['cotton', 'heavyweightCotton', 'linen', 'denim', 'silk', 'wool', 'knit', 'corduroy', 'leather', 'satin'];

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/* write only flagged pixels of imgData over a copy of orig (no round-trip noise elsewhere) */
export function commitPixels(orig, img, flags) {
  const w = orig.width, h = orig.height, n = w * h;
  const out = mkCanvas(w, h), ox = out.getContext('2d');
  ox.drawImage(orig, 0, 0);
  const er = new ImageData(w, h), ed = er.data, d = img.data;
  for (let i = 0; i < n; i++) { if (flags[i]) { ed[i * 4 + 3] = 255; } else d[i * 4 + 3] = 0; }
  const ec = mkCanvas(w, h); ec.getContext('2d').putImageData(er, 0, 0);
  ox.globalCompositeOperation = 'destination-out'; ox.drawImage(ec, 0, 0);
  const pc = mkCanvas(w, h); pc.getContext('2d').putImageData(img, 0, 0);
  ox.globalCompositeOperation = 'source-over'; ox.drawImage(pc, 0, 0);
  return out;
}
// keep only the pixels of `result` that differ from `orig` (byte-identical elsewhere)
export function mergeChanged(orig, result, tol = 2) {
  const a = readRGBA(orig), b = readRGBA(result), n = orig.width * orig.height, flags = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (Math.abs(a.data[o] - b.data[o]) > tol || Math.abs(a.data[o + 1] - b.data[o + 1]) > tol || Math.abs(a.data[o + 2] - b.data[o + 2]) > tol || Math.abs(a.data[o + 3] - b.data[o + 3]) > tol) flags[i] = 1;
  }
  return commitPixels(orig, b, flags);
}

function maskWeights(canvas, mask) {
  const w = canvas.width, h = canvas.height, n = w * h;
  if (!mask) return null;
  let a;
  if (mask.width === w && mask.height === h) a = alphaOf(mask);
  else { const c = mkCanvas(w, h); c.getContext('2d').drawImage(mask, 0, 0, w, h); a = alphaOf(c); }
  return a;
}

/* ---------------------------------------------------------------- colour */
function rgb2hsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  return [h, s, l];
}
function hue2rgb(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
function hsl2rgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}
const hex2rgb = hx => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hx || '')); if (!m) return null; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

export function applyColor(canvas, mask, opt = {}) {
  const w = canvas.width, h = canvas.height, n = w * h;
  const hue = opt.hue || 0, sat = opt.sat || 0, light = opt.light || 0;
  const tint = hex2rgb(opt.tint), tAmt = tint ? (opt.tintAmount == null ? 1 : opt.tintAmount) : 0;
  if (!hue && !sat && !light && !(tint && tAmt > 0)) { const c = mkCanvas(w, h); c.getContext('2d').drawImage(canvas, 0, 0); return c; }
  const img = readRGBA(canvas), d = img.data, ma = maskWeights(canvas, mask), flags = new Uint8Array(n);
  // mean lightness of the affected garment, so a tint keeps the shading relative to it
  let ls = 0, lc = 0;
  for (let i = 0; i < n; i += 3) { const a = d[i * 4 + 3]; if (a > 200 && (!ma || ma[i] > 100)) { ls += (Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) + Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])) / 510; lc++; } }
  const Lbar = Math.max(0.05, lc ? ls / lc : 0.5);
  const th = tint ? rgb2hsl(tint[0] / 255, tint[1] / 255, tint[2] / 255) : null;
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = d[o + 3];
    if (!a) continue;
    const wgt = (ma ? ma[i] / 255 : 1);
    if (wgt <= 0) continue;
    const r0 = d[o] / 255, g0 = d[o + 1] / 255, b0 = d[o + 2] / 255;
    let [H, S, L] = rgb2hsl(r0, g0, b0);
    if (hue) H = (H + hue / 360 + 1) % 1;
    if (sat) S = sat > 0 ? S + (1 - S) * sat / 100 * (S < 0.04 ? 0.15 : 1) : S * (1 + sat / 100);
    if (light) L = light > 0 ? L + (1 - L) * light / 100 : L * (1 + light / 100);
    let [r, g, b] = hsl2rgb(H, clamp01(S), clamp01(L));
    if (tint && tAmt > 0) {
      const Lt = clamp01(th[2] * Math.pow(Math.max(L, 0.001) / Lbar, 0.9));
      const St = th[1] * (1 - 0.35 * Math.max(0, Lt - 0.8) / 0.2);
      const [tr, tg, tb] = hsl2rgb(th[0], clamp01(St), Lt);
      const k = clamp01(tAmt);
      r = r + (tr - r) * k; g = g + (tg - g) * k; b = b + (tb - b) * k;
    }
    d[o] = Math.round((r0 + (r - r0) * wgt) * 255); d[o + 1] = Math.round((g0 + (g - g0) * wgt) * 255); d[o + 2] = Math.round((b0 + (b - b0) * wgt) * 255);
    flags[i] = 1;
  }
  return commitPixels(canvas, img, flags);
}

/* ---------------------------------------------------------------- fabric */
function hash(x, y, s) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return (hash(ix, iy, s) * (1 - u) + hash(ix + 1, iy, s) * u) * (1 - v) + (hash(ix, iy + 1, s) * (1 - u) + hash(ix + 1, iy + 1, s) * u) * v;
}
const TAU = Math.PI * 2;
function worley(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y); let d1 = 9, d2 = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, px = cx + hash(cx, cy, s), py = cy + hash(cx, cy, s + 7), d = Math.hypot(px - x, py - y);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}

// per-fabric: height(x,y) in about [-1,1]; gain = contrast of the weave; sheen = highlight/shadow stretching; sat = saturation scale
const SPEC = {
  cotton:  { gain: 0.20, h: (x, y) => 0.55 * Math.sin(x * TAU / 3.1) * Math.sin(y * TAU / 3.1) + 0.8 * (vnoise(x * 0.9, y * 0.9, 1) - 0.5) + 0.5 * (vnoise(x * 0.06, y * 0.5, 4) - 0.5) },
  heavyweightCotton: { gain: 0.30, h: (x, y) => 0.6 * Math.sin(x * TAU / 4.6) * Math.sin(y * TAU / 4.6) + 0.8 * (vnoise(x * 0.5, y * 0.5, 2) - 0.5) + 0.35 * (vnoise(x * 0.04, y * 0.4, 5) - 0.5) + 0.4 * (hash(x, y, 3) - 0.5) },
  linen:   { gain: 0.30, h: (x, y) => 1.4 * (vnoise(x * 0.07, y * 1.3, 6) - 0.5) + 1.4 * (vnoise(x * 1.3, y * 0.07, 7) - 0.5) + 0.5 * (hash(x, y, 8) - 0.5) },
  denim:   { gain: 0.32, h: (x, y) => 0.9 * Math.sin((x + y) * TAU / 4.4) + 0.7 * (vnoise(x * 1.1, y * 0.12, 9) - 0.5) + 0.5 * (hash(x, y, 10) - 0.5), sat: 0.92 },
  silk:    { gain: 0.07, sheen: 0.55, h: (x, y) => 0.5 * (vnoise(x * 0.9, y * 0.05, 11) - 0.5) + 0.3 * (hash(x, y, 12) - 0.5), sat: 1.05 },
  satin:   { gain: 0.05, sheen: 0.9, h: (x, y) => 0.35 * (vnoise(x * 0.8, y * 0.04, 13) - 0.5) + 0.2 * (hash(x, y, 14) - 0.5), sat: 1.08 },
  wool:    { gain: 0.32, h: (x, y) => 0.8 * (vnoise(x * 0.35, y * 0.35, 15) - 0.5) + 0.9 * (hash(x, y, 16) - 0.5) + 0.35 * Math.sin((x - y) * TAU / 5.5) },
  knit:    { gain: 0.40, h: (x, y) => { const px = 6.5, py = 7.5, u = x / px, k = Math.abs(((u % 1) + 1) % 1 - 0.5) * 2, r = y / py + k * 0.6; return Math.sin(r * TAU) * 0.8 + 0.35 * Math.sin(u * TAU * 0.5) + 0.35 * (hash(x, y, 17) - 0.5); } },
  corduroy:{ gain: 0.38, h: (x, y) => Math.sin(x * TAU / 7.2) * 0.95 + 0.4 * (vnoise(x * 0.3, y * 0.05, 18) - 0.5) + 0.25 * (hash(x, y, 19) - 0.5) },
  leather: { gain: 0.34, sheen: 0.35, h: (x, y) => { const wv = worley(x / 9, y / 9, 20); return Math.min(1, wv * 3.2) * 1.4 - 0.9 + 0.3 * (hash(x, y, 21) - 0.5); }, sat: 0.95 }
};

export function applyFabric(canvas, mask, fabricName, amount = 0.6) {
  const w = canvas.width, h = canvas.height, n = w * h, spec = SPEC[fabricName];
  if (!spec || amount <= 0) { const c = mkCanvas(w, h); c.getContext('2d').drawImage(canvas, 0, 0); return c; }
  const img = readRGBA(canvas), d = img.data, ma = maskWeights(canvas, mask), flags = new Uint8Array(n);
  const gain = spec.gain * amount * 1.6, sheen = (spec.sheen || 0) * amount;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 4;
    if (!d[o + 3]) continue;
    const wgt = ma ? ma[i] / 255 : 1;
    if (wgt <= 0) continue;
    let r = d[o], g = d[o + 1], b = d[o + 2];
    const f = 1 + gain * spec.h(x, y);
    let nr = r * f, ng = g * f, nb = b * f;
    if (sheen) {
      const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255, flow = vnoise(x * 0.006 + y * 0.002, y * 0.02, 31) - 0.5;
      const k = 1 + sheen * (0.9 * (L - 0.5) + 0.7 * flow);
      nr *= k; ng *= k; nb *= k;
      const hl = Math.max(0, sheen * (flow * 1.4 + (L - 0.6))) * 90;
      nr += hl; ng += hl; nb += hl;
    }
    if (spec.sat && spec.sat !== 1) { const m = (nr + ng + nb) / 3, s = 1 + (spec.sat - 1) * amount; nr = m + (nr - m) * s; ng = m + (ng - m) * s; nb = m + (nb - m) * s; }
    d[o] = Math.max(0, Math.min(255, Math.round(r + (nr - r) * wgt)));
    d[o + 1] = Math.max(0, Math.min(255, Math.round(g + (ng - g) * wgt)));
    d[o + 2] = Math.max(0, Math.min(255, Math.round(b + (nb - b) * wgt)));
    flags[i] = 1;
  }
  return commitPixels(canvas, img, flags);
}
