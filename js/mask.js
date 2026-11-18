// Threadform - selection mask engine (Phase 2).
//
// A mask is a plain Uint8Array alpha plane (width*height, 0-255, 255 = selected). Every function here is a pure function that
// runs in plain Node (no DOM); `toCanvas` / `fromCanvas` are the only browser-touching helpers. Masks carry their size as
// `.width` / `.height` properties on the typed array (see `wrap`); a bare square Uint8Array (e.g. 1024*1024) is also accepted.
// Image inputs are ImageData-like {data (RGBA), width, height}. Coordinates are canvas coordinates: pixel (i,j) covers
// [i,i+1) x [j,j+1), so a brush stamp at (10,10) is centred on the corner shared by four pixels, exactly like ctx.arc(10,10,..).
//
// Where a function takes a `garment` mask it clips its result to it (min), so a selection never leaks off the cloth.
// Colour distances are CIE76 Delta-E in Lab (about 1 = just noticeable, 100 = black vs white); tolerances use that unit.

export const DEFAULT_SIZE = 1024;
const ALPHA_MIN = 24;            // image pixels with alpha below this are "background" for the colour/texture/smart tools
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/* ================================================================= basics */
/** Attach size metadata to a plane (so non-square masks work). Returns the same array. */
export function wrap(arr, w, h) { arr.width = w; arr.height = h; return arr; }
export function emptyMask(w = DEFAULT_SIZE, h = w) { return wrap(new Uint8Array(w * h), w, h); }
const mk = (w, h) => emptyMask(w, h);

export function dimsOf(m) {
  if (m.width > 0 && m.height > 0 && m.width * m.height === m.length) return [m.width, m.height];
  const s = Math.round(Math.sqrt(m.length));
  if (s * s === m.length) return [s, s];
  throw new Error('mask size unknown: wrap(plane, w, h) first');
}

/** Accept a mask plane, an ImageData-like (alpha channel), or a canvas (browser). Returns a plane (never copies a plane). */
export function planeOf(m) {
  if (!m) return null;
  if (m instanceof Uint8Array || m instanceof Uint8ClampedArray) return m;
  if (m.data && m.width && m.height) {
    const n = m.width * m.height, a = mk(m.width, m.height), d = m.data;
    for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3];
    return a;
  }
  if (typeof m.getContext === 'function') return fromCanvas(m);
  throw new Error('not a mask');
}
export function copy(m) { m = planeOf(m); const [w, h] = dimsOf(m); const o = mk(w, h); o.set(m); return o; }

/** Browser: canvas alpha -> plane. */
export function fromCanvas(c) {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height, a = mk(c.width, c.height);
  for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3];
  return a;
}
/** Browser: plane -> canvas whose alpha is the mask (colour white by default, or opts.color [r,g,b]). */
export function toCanvas(m, opts = {}) {
  m = planeOf(m); const [w, h] = dimsOf(m), col = opts.color || [255, 255, 255];
  const c = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h);
  const img = new ImageData(w, h), d = img.data;
  for (let i = 0, n = w * h; i < n; i++) { const o = i * 4; d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = m[i]; }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
/** RGBA overlay bytes for a quick tint of a mask (no DOM needed): tint(mask,[r,g,b],alpha 0..1). */
export function tint(m, rgb = [255, 60, 60], alpha = 0.45) {
  m = planeOf(m); const n = m.length, o = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { const k = i * 4; o[k] = rgb[0]; o[k + 1] = rgb[1]; o[k + 2] = rgb[2]; o[k + 3] = m[i] * alpha; }
  return o;
}

export function isEmpty(m, threshold = 1) { m = planeOf(m); for (let i = 0; i < m.length; i++) if (m[i] >= threshold) return false; return true; }
/** Coverage area in pixels (soft-aware: sum of alpha/255). */
export function area(m) { m = planeOf(m); let s = 0; for (let i = 0; i < m.length; i++) s += m[i]; return s / 255; }
/** Tight pixel bounds of pixels >= threshold -> {x,y,w,h} (w,h = 0 when empty). */
export function bounds(m, threshold = 1) {
  m = planeOf(m); const [w, h] = dimsOf(m);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w; let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (m[o + x] >= threshold) { first = x; break; }
    if (first < 0) continue;
    for (let x = w - 1; x >= first; x--) if (m[o + x] >= threshold) { last = x; break; }
    if (first < x0) x0 = first; if (last > x1) x1 = last; if (y < y0) y0 = y; y1 = y;
  }
  return x1 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
/** min(mask, garment). */
export function clip(m, garment) {
  m = planeOf(m); const [w, h] = dimsOf(m), o = mk(w, h);
  if (!garment) { o.set(m); return o; }
  const g = planeOf(garment);
  for (let i = 0; i < m.length; i++) o[i] = m[i] < g[i] ? m[i] : g[i];
  return o;
}
export function threshold(m, t = 128) { m = planeOf(m); const [w, h] = dimsOf(m), o = mk(w, h); for (let i = 0; i < m.length; i++) o[i] = m[i] >= t ? 255 : 0; return o; }
const finish = (out, opts) => (opts && opts.garment ? clip(out, opts.garment) : out);
const optDims = o => [(o && o.width) || DEFAULT_SIZE, (o && (o.height || o.width)) || DEFAULT_SIZE];

/* ================================================================= combine / invert */
/** Soft-edge-correct boolean algebra on coverage: add = max, intersect = min, subtract = max(0, a-b), replace = b.
 *  Identities: subtract(a,b) + intersect(a,b) = a (exactly), add/intersect idempotent, commutative, associative. */
export function combine(a, b, mode = 'add') {
  a = planeOf(a); b = planeOf(b); const [w, h] = dimsOf(a), o = mk(w, h), n = a.length;
  switch (mode) {
    case 'add': for (let i = 0; i < n; i++) o[i] = a[i] > b[i] ? a[i] : b[i]; break;
    case 'intersect': for (let i = 0; i < n; i++) o[i] = a[i] < b[i] ? a[i] : b[i]; break;
    case 'subtract': for (let i = 0; i < n; i++) { const v = a[i] - b[i]; o[i] = v > 0 ? v : 0; } break;
    case 'replace': o.set(b); break;
    default: throw new Error('combine mode: add|subtract|intersect|replace');
  }
  return o;
}
/** Invert; with a garment mask only the garment is inverted (result = garment minus mask, soft garment edges respected). */
export function invert(m, garmentMask) {
  m = planeOf(m); const [w, h] = dimsOf(m), o = mk(w, h), n = m.length;
  if (garmentMask) { const g = planeOf(garmentMask); for (let i = 0; i < n; i++) { const v = g[i] - m[i]; o[i] = v > 0 ? v : 0; } }
  else for (let i = 0; i < n; i++) o[i] = 255 - m[i];
  return o;
}

/* ================================================================= blur kernels */
// Box blur of a Float32 plane, mode 'zero' (outside = 0) or 'clamp' (edge replicate). Returns a new array (dst optional).
function boxBlur(src, w, h, r, mode, dst) {
  r = Math.round(r);
  const out = dst || new Float32Array(w * h);
  if (r < 1) { if (out !== src) out.set(src); return out; }
  const tmp = new Float32Array(w * h), inv = 1 / (2 * r + 1), cl = mode === 'clamp';
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let k = -r; k <= r; k++) s += k < 0 ? (cl ? src[o] : 0) : k >= w ? (cl ? src[o + w - 1] : 0) : src[o + k];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s * inv;
      const a = x + r + 1, b = x - r;
      s += (a < w ? src[o + a] : cl ? src[o + w - 1] : 0) - (b >= 0 ? src[o + b] : cl ? src[o] : 0);
    }
  }
  const col = new Float32Array(w);
  for (let k = -r; k <= r; k++) {
    const yy = k < 0 ? (cl ? 0 : -1) : k >= h ? (cl ? h - 1 : -1) : k;
    if (yy >= 0) { const o = yy * w; for (let x = 0; x < w; x++) col[x] += tmp[o + x]; }
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = col[x] * inv;
    const a = y + r + 1, b = y - r;
    const ya = a < h ? a : cl ? h - 1 : -1, yb = b >= 0 ? b : cl ? 0 : -1;
    if (ya >= 0) { const oa = ya * w; for (let x = 0; x < w; x++) col[x] += tmp[oa + x]; }
    if (yb >= 0) { const ob = yb * w; for (let x = 0; x < w; x++) col[x] -= tmp[ob + x]; }
  }
  return out;
}
// Separable true gaussian for small sigma, 3 box passes for large sigma. Float32 in/out.
function gaussBlur(src, w, h, sigma, mode = 'zero') {
  if (sigma < 0.05) return src.slice();
  if (sigma < 2.2) {
    const R = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * R + 1); let sum = 0;
    for (let i = -R; i <= R; i++) { k[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + R]; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const cl = mode === 'clamp', tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -R; i <= R; i++) { let xx = x + i; if (xx < 0) { if (!cl) continue; xx = 0; } else if (xx >= w) { if (!cl) continue; xx = w - 1; } s += k[i + R] * src[o + xx]; }
        tmp[o + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let i = -R; i <= R; i++) {
        let yy = y + i; if (yy < 0) { if (!cl) continue; yy = 0; } else if (yy >= h) { if (!cl) continue; yy = h - 1; }
        const kk = k[i + R], oo = yy * w, o = y * w;
        for (let x = 0; x < w; x++) out[o + x] += kk * tmp[oo + x];
      }
    }
    return out;
  }
  // boxes for gauss (Kovesi): 3 passes
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let cur = src;
  for (let i = 0; i < n; i++) cur = boxBlur(cur, w, h, ((i < m ? wl : wu) - 1) / 2, mode);
  return cur === src ? src.slice() : cur;
}
const toF = m => { const f = new Float32Array(m.length); for (let i = 0; i < m.length; i++) f[i] = m[i] * (1 / 255); return f; };
const fromF = (f, w, h) => { const o = mk(w, h); for (let i = 0; i < f.length; i++) { const v = f[i] * 255 + 0.5; o[i] = v <= 0 ? 0 : v >= 255 ? 255 : v; } return o; };

/** Gaussian feather: edge stays at 50% on the original boundary, sigma = px/2 (so ~px of falloff each side). Not a threshold. */
export function feather(m, px, garment) {
  m = planeOf(m); const [w, h] = dimsOf(m);
  if (!(px > 0)) return clip(m, garment);
  return clip(fromF(gaussBlur(toF(m), w, h, px / 2, 'zero'), w, h), garment);
}

/* ================================================================= distance transform */
const INF = 1e9;
/** Exact squared Euclidean distance (Felzenszwalb-Huttenlocher) from every pixel to the nearest pixel where seed(i) is true.
 *  Returns Float64Array of squared distances (INF if there are no seeds). */
export function edt2(seedPlane, w, h, seedThr = 128) {
  const n = w * h, f = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) { if (seedPlane[i] >= seedThr) { f[i] = 0; any = true; } else f[i] = INF; }
  if (!any) return f;
  const L = Math.max(w, h), v = new Int32Array(L), z = new Float64Array(L + 1), col = new Float64Array(L), res = new Float64Array(L);
  const pass = (cnt, len, stride, step) => {
    for (let t = 0; t < cnt; t++) {
      const base = t * step;
      let seedFound = false;
      for (let q = 0; q < len; q++) { const val = f[base + q * stride]; col[q] = val; if (val < INF) seedFound = true; }
      if (!seedFound) continue;
      let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
      for (let q = 1; q < len; q++) {
        let s;
        for (;;) { const p = v[k]; s = ((col[q] + q * q) - (col[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k]) k--; else break; }
        k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const d = q - v[k]; res[q] = d * d + col[v[k]]; }
      for (let q = 0; q < len; q++) f[base + q * stride] = res[q];
    }
  };
  pass(h, w, 1, w);      // rows
  pass(w, h, w, 1);      // columns
  return f;
}

function expandCore(m, w, h, px) {
  const d2 = edt2(m, w, h), o = mk(w, h), lim = (px + 1) * (px + 1);
  for (let i = 0; i < m.length; i++) {
    const c = m[i] * (1 / 255), d = d2[i];
    if (d > lim) { o[i] = m[i]; continue; }
    const dd = d < 1 ? 1 : Math.sqrt(d);
    const v = c + px + 1 - dd;
    const r = (v <= c ? c : v >= 1 ? 1 : v) * 255 + 0.5;
    o[i] = r >= 255 ? 255 : r;
  }
  return o;
}
/** Grow the selection by px (sub-pixel allowed) with a Euclidean distance transform: round things stay round, edges stay anti-aliased. */
export function expand(m, px, garment) {
  m = planeOf(m); const [w, h] = dimsOf(m);
  if (!(px > 0)) return clip(m, garment);
  return clip(expandCore(m, w, h, px), garment);
}
/** Shrink by px (Euclidean). Mask touching the image border is not eroded from the border side. */
export function contract(m, px, garment) {
  m = planeOf(m); const [w, h] = dimsOf(m);
  if (!(px > 0)) return clip(m, garment);
  return clip(invert(expandCore(invert(m), w, h, px)), garment);
}
/** Round off jaggies/corners/specks: gaussian then re-sharpen to a ~1px anti-aliased edge (a rounding of the shape, not a blur). */
export function smooth(m, px, garment) {
  m = planeOf(m); const [w, h] = dimsOf(m);
  if (!(px > 0)) return clip(m, garment);
  const b = gaussBlur(toF(m), w, h, px, 'zero'), k = Math.max(1, px * 2.5), o = mk(w, h);
  for (let i = 0; i < b.length; i++) { const v = ((b[i] - 0.5) * k + 0.5) * 255 + 0.5; o[i] = v <= 0 ? 0 : v >= 255 ? 255 : v; }
  return clip(o, garment);
}
/** Close the gap between a selection and the garment silhouette: where the selection (grown by px) comes within px of the garment
 *  edge, the garment pixels in between are added, so no unselected halo of cloth is left along the outline. Default px = 4. */
export function dilateToGarment(m, garmentMask, px = 4) {
  m = planeOf(m); const g = planeOf(garmentMask), [w, h] = dimsOf(m);
  const grown = expandCore(m, w, h, px);
  const dIn = edt2(invert(g), w, h);             // squared distance from each garment pixel to the nearest non-garment pixel
  const o = mk(w, h), lim = px * px;
  for (let i = 0; i < m.length; i++) {
    let v = m[i];
    if (g[i] >= 128 && dIn[i] <= lim) { const gv = grown[i] < g[i] ? grown[i] : g[i]; if (gv > v) v = gv; }
    o[i] = v;
  }
  return o;
}

/* ================================================================= shapes */
const pt = p => (Array.isArray(p) ? { x: p[0], y: p[1], p: p[2] } : p);

/** Stroke of round stamps along a path: a capsule union (no gaps at any speed). points: [{x,y,p?}] | [[x,y,p?]].
 *  size = diameter px, hardness 0..1 (1 = hard anti-aliased edge, 0 = full soft falloff), pressure = number | array | null (scales the radius).
 *  opts: {width,height,garment}. */
export function fromBrushStroke(points, size, hardness = 1, pressure = null, opts = {}) {
  const [w, h] = optDims(opts), out = mk(w, h);
  if (!points || !points.length || !(size > 0)) return out;
  hardness = clamp01(hardness);
  const R0 = size / 2, P = [];
  points.forEach((q, i) => {
    q = pt(q);
    let p = q.p != null ? q.p : (Array.isArray(pressure) ? pressure[i] : pressure);
    p = p == null ? 1 : Math.min(1, Math.max(0.02, p));
    const last = P[P.length - 1], r = R0 * p;
    if (last && Math.hypot(q.x - last.x, q.y - last.y) < Math.min(2, Math.max(0.35, r * 0.04)) && i < points.length - 1) return;   // decimate dense input
    P.push({ x: q.x, y: q.y, r });
  });
  const prof = (d, r) => {
    const inner = r * hardness;
    if (r - inner < 1) { const v = r + 0.5 - d; return v <= 0 ? 0 : v >= 1 ? 1 : v; }
    if (d <= inner) return 1; if (d >= r) return 0;
    const t = (d - inner) / (r - inner); return 1 - t * t * (3 - 2 * t);
  };
  const seg = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy, rm = Math.max(a.r, b.r) + 1;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - rm)), x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + rm));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - rm)), y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + rm));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - a.x, py = y + 0.5 - a.y;
      let t = L2 > 0 ? (px * dx + py * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx, ey = py - t * dy, d = Math.sqrt(ex * ex + ey * ey), r = a.r + (b.r - a.r) * t;
      if (d > r + 0.5) continue;
      const v = prof(d, r) * 255 + 0.5, i = y * w + x;
      if (v > out[i]) out[i] = v;
    }
  };
  if (P.length === 1) seg(P[0], P[0]); else for (let i = 0; i + 1 < P.length; i++) seg(P[i], P[i + 1]);
  return finish(out, opts);
}

/** Anti-aliased polygon fill, non-zero winding (self-intersections fill, like canvas fill('nonzero')). opts: {width,height,garment}. */
export function fromPolygon(points, opts = {}) {
  const [w, h] = optDims(opts), out = mk(w, h);
  const P = (points || []).map(pt).filter(p => p && isFinite(p.x) && isFinite(p.y));
  if (P.length < 3) return out;
  const E = [];                                    // edges with y0<y1: [x0,y0,x1,y1,dir]
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if (a.y === b.y) continue;
    E.push(a.y < b.y ? [a.x, a.y, b.x, b.y, 1] : [b.x, b.y, a.x, a.y, -1]);
  }
  if (!E.length) return out;
  let ymin = Infinity, ymax = -Infinity;
  for (const e of E) { if (e[1] < ymin) ymin = e[1]; if (e[3] > ymax) ymax = e[3]; }
  const ry0 = Math.max(0, Math.floor(ymin)), ry1 = Math.min(h - 1, Math.ceil(ymax));
  const rows = new Map();                          // row -> edge list
  for (const e of E) {
    const a = Math.max(ry0, Math.floor(e[1])), b = Math.min(ry1, Math.floor(e[3]));
    for (let y = a; y <= b; y++) { let l = rows.get(y); if (!l) rows.set(y, l = []); l.push(e); }
  }
  const S = 16, wg = 1 / S, acc = new Float32Array(w + 2), diff = new Float32Array(w + 2), xs = [], ds = [];
  for (let y = ry0; y <= ry1; y++) {
    const list = rows.get(y); if (!list) continue;
    acc.fill(0); diff.fill(0);
    for (let s = 0; s < S; s++) {
      const ys = y + (s + 0.5) / S; xs.length = 0; ds.length = 0;
      const cr = [];
      for (const e of list) if (ys >= e[1] && ys < e[3]) cr.push([e[0] + (ys - e[1]) * (e[2] - e[0]) / (e[3] - e[1]), e[4]]);
      if (cr.length < 2) continue;
      cr.sort((p, q) => p[0] - q[0]);
      let wind = 0, start = 0;
      for (const [x, dir] of cr) {
        const prev = wind; wind += dir;
        if (prev === 0 && wind !== 0) start = x;
        else if (prev !== 0 && wind === 0) {
          const xa = Math.max(0, Math.min(w, start)), xb = Math.max(0, Math.min(w, x));
          if (xb <= xa) continue;
          const ia = Math.floor(xa), ib = Math.floor(xb);
          if (ia === ib) acc[ia] += (xb - xa) * wg;
          else { acc[ia] += (ia + 1 - xa) * wg; acc[ib] += (xb - ib) * wg; diff[ia + 1] += wg; diff[ib] -= wg; }
        }
      }
    }
    let run = 0; const o = y * w;
    for (let x = 0; x < w; x++) { run += diff[x]; const v = (acc[x] + run) * 255 + 0.5; out[o + x] = v >= 255 ? 255 : v <= 0 ? 0 : v; }
  }
  return finish(out, opts);
}
/** Freehand lasso: same fill as a polygon (closed implicitly); consecutive duplicate points are dropped. */
export function fromLasso(points, opts = {}) {
  const P = []; for (const q of (points || []).map(pt)) { const l = P[P.length - 1]; if (!l || Math.abs(l.x - q.x) > 1e-6 || Math.abs(l.y - q.y) > 1e-6) P.push(q); }
  return fromPolygon(P, opts);
}
/** Axis-aligned rectangle between corners a and b ({x,y} or [x,y]); fractional edges are anti-aliased exactly. */
export function fromRect(a, b, opts = {}) {
  a = pt(a); b = pt(b); const [w, h] = optDims(opts), out = mk(w, h);
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const cov = (i, lo, hi) => Math.max(0, Math.min(i + 1, hi) - Math.max(i, lo));
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1) - 1); y++) {
    const cy = cov(y, y0, y1); if (cy <= 0) continue;
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(w - 1, Math.ceil(x1) - 1); x++) out[y * w + x] = cy * cov(x, x0, x1) * 255 + 0.5;
  }
  return finish(out, opts);
}

/* ================================================================= segmentation-backed */
const _planes = new WeakMap();
function regionPlane(c) { if (c instanceof Uint8Array || c instanceof Uint8ClampedArray) return c; let p = _planes.get(c); if (!p) { p = planeOf(c); _planes.set(c, p); } return p; }
/** Union of seg.regions[name] for one or several region names ('all' = every region). Regions may be canvases or planes. */
export function fromRegions(seg, names) {
  const R = (seg && seg.regions) || {}; let list = Array.isArray(names) ? names : [names];
  if (list.includes('all')) list = Object.keys(R);
  let out = null;
  for (const n of list) {
    const c = R[n]; if (!c) continue;
    const p = regionPlane(c), [w, h] = dimsOf(p);
    if (!out) out = mk(w, h);
    for (let i = 0; i < p.length; i++) if (p[i] > out[i]) out[i] = p[i];
  }
  if (!out) { const w = (seg && seg.w) || DEFAULT_SIZE, h = (seg && seg.h) || w; out = mk(w, h); }
  return out;
}
const AT_ORDER = ['text', 'logos', 'cuffs', 'collar', 'neckline', 'hem', 'stripes', 'shoulders', 'sidePanels', 'leftSleeve', 'rightSleeve', 'body'];
const BASE_REGIONS = new Set(['body', 'leftSleeve', 'rightSleeve', 'collar', 'neckline', 'cuffs', 'hem', 'shoulders', 'sidePanels', 'fabric']);
/** Name of the segmentation region under (x,y) (same priority order as segment.js regionAt), or null. Works on planes or canvases. */
export function regionNameAt(seg, x, y) {
  if (!seg || !seg.regions) return null;
  x = Math.round(x); y = Math.round(y);
  for (const name of [...AT_ORDER, 'fabric']) {
    const c = seg.regions[name]; if (!c) continue;
    const p = regionPlane(c), [w, h] = dimsOf(p);
    if (x >= 0 && y >= 0 && x < w && y < h && p[y * w + x] > 127) return name;
  }
  return null;
}

/* ================================================================= colour science + caches */
const SRGB = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const fLab = t => (t > 0.008856 ? Math.cbrt(t) : 7.787037 * t + 16 / 116);
export function rgbToLab(r, g, b) {
  const R = SRGB[r | 0], G = SRGB[g | 0], B = SRGB[b | 0];
  const x = fLab((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047), y = fLab(0.2126729 * R + 0.7151522 * G + 0.072175 * B), z = fLab((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function rgbOf(c) {
  if (typeof c === 'string') { const m = /^#?([0-9a-f]{6})$/i.exec(c.trim()); if (!m) throw new Error('bad colour'); const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  return Array.isArray(c) ? c : [c.r, c.g, c.b];
}
const imgSig = d => { let s = d.length; const st = Math.max(1, (d.length / 311) | 0); for (let i = 0; i < d.length; i += st) s = (s * 31 + d[i]) | 0; return s; };
const _imgCache = new WeakMap();
// Lab planes + validity for a whole image, cached per ImageData.data (invalidated by a content signature)
function labOf(image) {
  const d = image.data, sig = imgSig(d), hit = _imgCache.get(d);
  if (hit && hit.sig === sig) return hit;
  const n = image.width * image.height, L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), valid = new Uint8Array(n);
  // 3-D memo for repeated colours is not needed: the LUT + cbrt is fast enough (~40 ms at 1M px)
  let pr = -1, pg = -1, pb = -1, pl = 0, pa = 0, pbb = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4, r = d[o], g = d[o + 1], b = d[o + 2];
    valid[i] = d[o + 3] >= ALPHA_MIN ? 1 : 0;
    if (r !== pr || g !== pg || b !== pb) { const lab = rgbToLab(r, g, b); pl = lab[0]; pa = lab[1]; pbb = lab[2]; pr = r; pg = g; pb = b; }
    L[i] = pl; A[i] = pa; B[i] = pbb;
  }
  const e = { sig, w: image.width, h: image.height, L, A, B, valid, G: null };
  _imgCache.set(d, e);
  return e;
}
// edge strength: Sobel of the Lab channels after a 3x3 box (units ~ Delta-E per pixel)
function gradOf(e) {
  if (e.G) return e.G;
  const { w, h } = e, n = w * h, G = new Float32Array(n);
  for (const P of [e.L, e.A, e.B]) {
    const s = boxBlur(P, w, h, 1, 'clamp');
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (s[i - w + 1] + 2 * s[i + 1] + s[i + w + 1] - s[i - w - 1] - 2 * s[i - 1] - s[i + w - 1]) * 0.125;
      const gy = (s[i + w - 1] + 2 * s[i + w] + s[i + w + 1] - s[i - w - 1] - 2 * s[i - w] - s[i - w + 1]) * 0.125;
      G[i] += gx * gx + gy * gy;
    }
  }
  for (let i = 0; i < n; i++) G[i] = Math.sqrt(G[i]);
  e.G = G; return G;
}
function floodFill(w, h, seed, accept) {          // 8-connected; returns visited Uint8Array (1 = selected)
  const vis = new Uint8Array(w * h), st = new Int32Array(w * h); let sp = 0;
  if (!accept(seed)) return vis;
  vis[seed] = 1; st[sp++] = seed;
  while (sp) {
    const p = st[--sp], x = p % w, y = (p - x) / w;
    const x0 = x > 0, x1 = x < w - 1;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx < 0 && !x0) || (dx > 0 && !x1) || (!dx && !dy)) continue;
        const q = yy * w + x + dx;
        if (!vis[q] && accept(q)) { vis[q] = 1; st[sp++] = q; }
      }
    }
  }
  return vis;
}
const meanLab = (e, cx, cy, r) => {
  let sl = 0, sa = 0, sb = 0, c = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(e.h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(e.w - 1, cx + r); x++) {
    const i = y * e.w + x; if (!e.valid[i]) continue; sl += e.L[i]; sa += e.A[i]; sb += e.B[i]; c++;
  }
  return c ? [sl / c, sa / c, sb / c] : [e.L[cy * e.w + cx], e.A[cy * e.w + cx], e.B[cy * e.w + cx]];
};
const imgOk = im => im && im.data && im.width > 0 && im.height > 0;

/* ================================================================= colour / wand */
// Delta-E -> coverage: 1 up to tol, linear fall-off to 0 over `ramp` (anti-aliased boundary, still monotonic in tol)
const rampOf = tol => Math.max(1.5, tol * 0.2);

/** Magic wand: perceptual (Lab Delta-E) distance to the mean colour of a 3x3 patch at the click. tolerance in Delta-E (0-100, ~20 typical).
 *  contiguous = 8-connected flood (default true); false = every similar pixel in the image.
 *  opts: {garment, sample (patch radius, 1), alphaMin}. Transparent pixels are never selected. */
export function magicWand(image, x, y, tolerance = 20, contiguous = true, opts = {}) {
  const e = labOf(image), { w, h } = e, out = mk(w, h);
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h || !e.valid[y * w + x]) return out;
  const ref = meanLab(e, x, y, opts.sample == null ? 1 : opts.sample), ramp = rampOf(tolerance), lim = tolerance + ramp;
  const g = opts.garment ? planeOf(opts.garment) : null, { L, A, B, valid } = e;
  const dist = i => { const dl = L[i] - ref[0], da = A[i] - ref[1], db = B[i] - ref[2]; return Math.sqrt(dl * dl + da * da + db * db); };
  const ok = i => valid[i] && (!g || g[i] > 0) && dist(i) < lim;
  const set = i => { let v = clamp01(1 - (dist(i) - tolerance) / ramp) * 255 + 0.5; if (g && g[i] < v) v = g[i]; out[i] = v; };
  if (contiguous) { const vis = floodFill(w, h, y * w + x, ok); for (let i = 0; i < vis.length; i++) if (vis[i]) set(i); }
  else for (let i = 0; i < out.length; i++) if (ok(i)) set(i);
  return out;
}
/** Every pixel whose colour is within tolerance (Delta-E) of rgb ([r,g,b] | {r,g,b} | '#rrggbb'), anywhere in the image. restrictTo = optional mask. */
export function selectByColor(image, rgb, tolerance = 20, restrictTo = null) {
  const e = labOf(image), { w, h } = e, out = mk(w, h), ref = rgbToLab(...rgbOf(rgb)), ramp = rampOf(tolerance), lim = tolerance + ramp;
  const g = restrictTo ? planeOf(restrictTo) : null, { L, A, B, valid } = e;
  for (let i = 0; i < out.length; i++) {
    if (!valid[i] || (g && !g[i])) continue;
    const dl = L[i] - ref[0], da = A[i] - ref[1], db = B[i] - ref[2], d = Math.sqrt(dl * dl + da * da + db * db);
    if (d >= lim) continue;
    let v = clamp01(1 - (d - tolerance) / ramp) * 255 + 0.5; if (g && g[i] < v) v = g[i];
    out[i] = v;
  }
  return out;
}

/* ================================================================= texture */
// Local texture features per pixel over a (2r+1)^2 window (normalised by the number of valid pixels, so the silhouette does not bias them):
//   log gradient energy, log luminance std-dev, and the double-angle orientation vector (cos2t, sin2t) weighted by how strongly oriented
//   the window is. Distances are measured in this feature space, never in colour, so two fabrics of equal colour can be told apart.
function textureFeatures(image, r) {
  const e = labOf(image), { w, h } = e, n = w * h, Y = e.L, valid = e.valid;
  const Jxx = new Float32Array(n), Jyy = new Float32Array(n), Jxy = new Float32Array(n), Vf = new Float32Array(n), Y1 = new Float32Array(n), Y2 = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!(valid[i] & valid[i - 1] & valid[i + 1] & valid[i - w] & valid[i + w] & valid[i - w - 1] & valid[i - w + 1] & valid[i + w - 1] & valid[i + w + 1])) continue;
    const gx = (Y[i - w + 1] + 2 * Y[i + 1] + Y[i + w + 1] - Y[i - w - 1] - 2 * Y[i - 1] - Y[i + w - 1]) * 0.125;
    const gy = (Y[i + w - 1] + 2 * Y[i + w] + Y[i + w + 1] - Y[i - w - 1] - 2 * Y[i - w] - Y[i - w + 1]) * 0.125;
    Jxx[i] = gx * gx; Jyy[i] = gy * gy; Jxy[i] = gx * gy; Vf[i] = 1; Y1[i] = Y[i]; Y2[i] = Y[i] * Y[i];
  }
  const bl = a => boxBlur(a, w, h, r, 'zero'), V = bl(Vf), bxx = bl(Jxx), byy = bl(Jyy), bxy = bl(Jxy), b1 = bl(Y1), b2 = bl(Y2);
  const F0 = new Float32Array(n), F1 = new Float32Array(n), F2 = new Float32Array(n), F3 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = V[i]; if (v < 0.25) continue;
    const xx = bxx[i] / v, yy = byy[i] / v, xy = bxy[i] / v, tr = xx + yy, g = Math.sqrt(tr);
    const mean = b1[i] / v, sd = Math.sqrt(Math.max(0, b2[i] / v - mean * mean));
    const conf = g / (g + 3), den = tr + 1e-6;
    F0[i] = Math.log(1 + g / 2); F1[i] = Math.log(1 + sd / 3);
    F2[i] = ((xx - yy) / den) * conf; F3[i] = ((2 * xy) / den) * conf;
  }
  return { w, h, n, F: [F0, F1, F2, F3], valid, ok: V };
}
const TEX_SCALE = [0.35, 0.35, 0.35, 0.35];

/** Select every pixel whose local TEXTURE matches the one at (x,y) (anywhere in the image; opts.contiguous:true limits to the connected area).
 *  Texture = gradient energy + local std-dev + orientation of the weave/rib pattern in a (2*win+1)^2 window (opts.win, default 4), compared in feature
 *  space, independent of colour. tolerance 0-100 (default 30).
 *  CAN separate: ribbed vs smooth knit, twill (diagonal) vs plain weave (grid), stripes/waffle vs flat cloth, coarse vs fine pattern of similar colour.
 *  CANNOT: textures that differ only in colour (use selectByColor), patterns finer than ~2px or coarser than the window, photographic folds/shading
 *  (these look like texture), and the boundary is only accurate to ~win px (follow with refineEdge). opts: {garment, win, contiguous}. */
export function selectByTexture(image, x, y, tolerance = 30, opts = {}) {
  const win = opts.win || 4, T = textureFeatures(image, win), { w, h, n, F, valid } = T, out = mk(w, h);
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h || !valid[y * w + x]) return out;
  const ref = [0, 0, 0, 0]; let c = 0;
  for (let yy = Math.max(0, y - 3); yy <= Math.min(h - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(w - 1, x + 3); xx++) {
    const i = yy * w + xx; if (T.ok[i] < 0.25) continue; for (let k = 0; k < 4; k++) ref[k] += F[k][i]; c++;
  }
  if (!c) return out;
  for (let k = 0; k < 4; k++) ref[k] /= c;
  const thr = tolerance / 40, ramp = Math.max(0.08, thr * 0.25), lim = thr + ramp, g = opts.garment ? planeOf(opts.garment) : null;
  const dist = i => { let s = 0; for (let k = 0; k < 4; k++) { const d = (F[k][i] - ref[k]) / TEX_SCALE[k]; s += d * d; } return Math.sqrt(s); };
  const ok = i => valid[i] && T.ok[i] >= 0.25 && (!g || g[i] > 0) && dist(i) < lim;
  const set = i => { let v = clamp01(1 - (dist(i) - thr) / ramp) * 255 + 0.5; if (g && g[i] < v) v = g[i]; out[i] = v; };
  if (opts.contiguous) { const vis = floodFill(w, h, y * w + x, ok); for (let i = 0; i < n; i++) if (vis[i]) set(i); }
  else for (let i = 0; i < n; i++) if (ok(i)) set(i);
  return out;
}

/* ================================================================= refine edge */
/** Edge-aware refinement. Inside a band of `radius` px around the mask boundary (never further: no leaks) every pixel is re-classified against the LOCAL
 *  mean colour inside vs outside the mask (projection on the inside->outside colour axis = a soft alpha matte), de-noised with a guided filter and blended
 *  with the original by `strength` (0 = unchanged, 1 = full snap). Where inside and outside colours are nearly equal the original edge is kept.
 *  opts: {radius=4, strength=1, garment, eps}. */
export function refineEdge(m, image, opts = {}) {
  m = planeOf(m); const [W, H] = dimsOf(m);
  const radius = Math.max(1, Math.round(opts.radius == null ? 4 : opts.radius)), strength = clamp01(opts.strength == null ? 1 : opts.strength);
  const bb = bounds(m, 1);
  if (!bb.w || strength === 0 || !imgOk(image)) return clip(m, opts.garment);
  const pad = radius * 2 + 6;
  const x0 = Math.max(0, bb.x - pad), y0 = Math.max(0, bb.y - pad), x1 = Math.min(W, bb.x + bb.w + pad), y1 = Math.min(H, bb.y + bb.h + pad), w = x1 - x0, h = y1 - y0, n = w * h;
  const mf = new Float32Array(n), L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const cached = _imgCache.get(image.data), full = cached && cached.sig === imgSig(image.data) ? cached : null, d = image.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, gi = (y + y0) * W + x + x0;
    mf[i] = m[gi] * (1 / 255);
    if (full) { L[i] = full.L[gi]; A[i] = full.A[gi]; B[i] = full.B[gi]; }
    else { const o = gi * 4, lab = rgbToLab(d[o], d[o + 1], d[o + 2]); L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2]; }
  }
  const Rw = radius + 3, bz = a => boxBlur(a, w, h, Rw, 'zero');
  const win = mf, wout = new Float32Array(n); for (let i = 0; i < n; i++) wout[i] = 1 - mf[i];
  const prod = (P, Q) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = P[i] * Q[i]; return o; };
  const sWi = bz(win), sWo = bz(wout), iL = bz(prod(L, win)), iA = bz(prod(A, win)), iB = bz(prod(B, win)), oL = bz(prod(L, wout)), oA = bz(prod(A, wout)), oB = bz(prod(B, wout));
  const near = boxBlur(mf, w, h, radius, 'zero');            // box density: 0 = further than `radius` from any selected px, 1 = deeper than `radius`
  const cand = new Float32Array(n), guide = new Float32Array(n), conf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (near[i] <= 1e-4 || near[i] >= 0.9999) { cand[i] = mf[i]; guide[i] = mf[i]; continue; }
    if (sWi[i] < 0.02 || sWo[i] < 0.02) { cand[i] = mf[i]; guide[i] = mf[i]; continue; }
    const ml = iL[i] / sWi[i], ma = iA[i] / sWi[i], mb = iB[i] / sWi[i], nl = oL[i] / sWo[i], na = oA[i] / sWo[i], nb = oB[i] / sWo[i];
    const dl = ml - nl, da = ma - na, db = mb - nb, n2 = dl * dl + da * da + db * db, dn = Math.sqrt(n2);
    if (dn < 2) { cand[i] = mf[i]; guide[i] = mf[i]; continue; }
    const g = ((L[i] - nl) * dl + (A[i] - na) * da + (B[i] - nb) * db) / n2;
    const a = clamp01(g), c = smoothstep(2, 8, dn);
    cand[i] = mf[i] + (a - mf[i]) * c; guide[i] = g < -0.25 ? -0.25 : g > 1.25 ? 1.25 : g; conf[i] = c;
  }
  // guided filter (guide = projected colour g, input = candidate): removes pixel noise but keeps the colour edge
  const gr = 2, eps = opts.eps == null ? 0.03 : opts.eps, bc = a => boxBlur(a, w, h, gr, 'clamp');
  const mI = bc(guide), mP = bc(cand), mIP = bc(prod(guide, cand)), mII = bc(prod(guide, guide)), aa = new Float32Array(n), bb2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i], cv = mIP[i] - mI[i] * mP[i]; aa[i] = cv / (v + eps); bb2[i] = mP[i] - aa[i] * mI[i]; }
  const mA = bc(aa), mB = bc(bb2), gain = 1 + 0.6 * strength, o = mk(W, H), gm = opts.garment ? planeOf(opts.garment) : null;
  o.set(m);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (near[i] <= 1e-4 || near[i] >= 0.9999) continue;
    let q = mA[i] * guide[i] + mB[i]; q = clamp01((q - 0.5) * gain + 0.5);
    const v = (mf[i] + (q - mf[i]) * strength) * 255 + 0.5, gi = (y + y0) * W + x + x0;
    o[gi] = v >= 255 ? 255 : v <= 0 ? 0 : v;
  }
  return gm ? clip(o, gm) : o;
}

/* ================================================================= smart select + components */
function fillHolesBin(bin, w, h, maxArea) {        // bin: Uint8 0/1 over the full plane; fills enclosed background pockets <= maxArea (4-connected)
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bin[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return;
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(w - 1, x1 + 1); y1 = Math.min(h - 1, y1 + 1);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, lab = new Uint8Array(cw * ch), st = new Int32Array(cw * ch), list = new Int32Array(cw * ch);
  for (let sy = 0; sy < ch; sy++) for (let sx = 0; sx < cw; sx++) {
    const s = sy * cw + sx; if (lab[s] || bin[(sy + y0) * w + sx + x0]) continue;
    let sp = 0, cnt = 0, border = false; st[sp++] = s; lab[s] = 1;
    while (sp) {
      const p = st[--sp]; list[cnt++] = p;
      const x = p % cw, y = (p - x) / cw;
      if (x === 0 || y === 0 || x === cw - 1 || y === ch - 1) border = true;
      const nb = [x > 0 ? p - 1 : -1, x < cw - 1 ? p + 1 : -1, y > 0 ? p - cw : -1, y < ch - 1 ? p + cw : -1];
      for (const q of nb) if (q >= 0 && !lab[q] && !bin[(((q / cw) | 0) + y0) * w + (q % cw) + x0]) { lab[q] = 1; st[sp++] = q; }
    }
    if (!border && cnt <= maxArea) for (let k = 0; k < cnt; k++) { const p = list[k]; bin[(((p / cw) | 0) + y0) * w + (p % cw) + x0] = 1; }
  }
}
const planeOfBin = (bin, w, h) => { const o = mk(w, h); for (let i = 0; i < bin.length; i++) if (bin[i]) o[i] = 255; return o; };

// An object is often several flat colours (a crest = brown shield + gold letters + gold rim). Given the seed flood `vis`, find the colour of the
// surrounding cloth (dominant colour of a ring 3-7px outside the seed region) and return the connected component of "not cloth" pixels that touches the
// seed region and lies within a few px of it. Skipped when the seed colour is not clearly different from its surroundings.
function growObject(e, vis, w, h, ref, limit, s) {
  const { L, A, B, valid } = e, n = w * h;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, seed = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (vis[y * w + x]) { if (seed < 0) seed = y * w + x; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return vis;
  const D = Math.min(40, Math.max(8, 0.45 * Math.max(x1 - x0 + 1, y1 - y0 + 1))), D2 = D * D, pad = Math.ceil(D) + 16;
  // cloth colour = dominant colour of the neighbourhood of the seed region (not counting the region itself)
  const bins = new Map();
  for (let y = Math.max(0, y0 - pad); y <= Math.min(h - 1, y1 + pad); y++) for (let x = Math.max(0, x0 - pad); x <= Math.min(w - 1, x1 + pad); x++) {
    const i = y * w + x; if (vis[i] || !valid[i]) continue;
    const key = ((L[i] / 6) | 0) * 10000 + (((A[i] + 128) / 6) | 0) * 100 + (((B[i] + 128) / 6) | 0);
    let b = bins.get(key); if (!b) bins.set(key, b = [0, 0, 0, 0]); b[0]++; b[1] += L[i]; b[2] += A[i]; b[3] += B[i];
  }
  let best = null; for (const b of bins.values()) if (!best || b[0] > best[0]) best = b;
  if (!best || best[0] < 30) return vis;
  const bg = [best[1] / best[0], best[2] / best[0], best[3] / best[0]];
  const dBg = (l, a, b) => Math.sqrt((l - bg[0]) ** 2 + (a - bg[1]) ** 2 + (b - bg[2]) ** 2), dSeed = dBg(ref[0], ref[1], ref[2]);
  if (dSeed < 14) return vis;
  const tol = Math.min(40, Math.max(14, 0.42 * dSeed)) * (0.8 + 0.4 * s);
  // Only grow when the seed region is mostly walled in by OTHER ink rather than by bare cloth (a crest's gold rim and band do that; a lone stripe or
  // letter is bordered by cloth), otherwise seams and shading shadows would leak into neighbouring objects.
  const d2 = edt2(vis, w, h, 1);
  let ring = 0, inkRing = 0, cnt = 0;
  for (let y = Math.max(0, y0 - 7); y <= Math.min(h - 1, y1 + 7); y++) for (let x = Math.max(0, x0 - 7); x <= Math.min(w - 1, x1 + 7); x++) {
    const i = y * w + x; if (vis[i]) { cnt++; continue; }
    if (d2[i] < 6.25 || d2[i] > 30.25 || !valid[i]) continue;      // the band 2.5-5.5px outside the region (beyond its anti-aliased fringe)
    ring++; if (dBg(L[i], A[i], B[i]) > tol) inkRing++;
  }
  if (ring < 10 || inkRing / ring < 0.08) return vis;
  const ok = i => valid[i] && d2[i] <= D2 && (!limit || limit[i] >= 128) && dBg(L[i], A[i], B[i]) > tol;
  const grown = floodFill(w, h, seed, i => vis[i] || ok(i));
  let ga = 0; for (let i = 0; i < n; i++) { if (vis[i]) grown[i] = 1; ga += grown[i]; }
  return ga > 3 * cnt ? vis : grown;
}

/** Edge-aware region growing from a click: grows over pixels whose colour is within a tolerance of the clicked material and that are not separated
 *  from it by a strong edge, stays inside the garment (seg.mask) and, when the click is on base fabric (body/sleeve/collar/...), inside that segmentation
 *  region; fills pockets enclosed by the object (crest letters, ink dropout), then snaps the boundary with refineEdge. Returns the object/part the
 *  user means: one stripe, the crest, one letter, a sleeve. opts: {sensitivity 0..1 (0.5), fillHoles (true), garment, refine (true), snapRadius}. */
export function smartSelect(image, seg, x, y, opts = {}) {
  const e = labOf(image), { w, h } = e, out = mk(w, h);
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h || !e.valid[y * w + x]) return out;
  const s = clamp01(opts.sensitivity == null ? 0.5 : opts.sensitivity), tolC = 8 + 30 * s, tolG = 4 + 14 * s, G = gradOf(e);
  const garment = opts.garment ? planeOf(opts.garment) : seg && seg.mask ? regionPlane(seg.mask) : null;
  const name = regionNameAt(seg, x, y), base = !!name && BASE_REGIONS.has(name);
  let limit = garment;
  if (base) { const rp = regionPlane(seg.regions[name]); limit = garment ? combine(rp, garment, 'intersect') : rp; }
  // seed: the calmest pixel within 3px of the click (so clicks on an anti-aliased edge land on the object they touch)
  let sx = x, sy = y, bestG = G[y * w + x], bestD = 0;
  if (bestG > tolG) for (let yy = Math.max(0, y - 3); yy <= Math.min(h - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(w - 1, x + 3); xx++) {
    const i = yy * w + xx; if (!e.valid[i]) continue; const dd = (xx - x) * (xx - x) + (yy - y) * (yy - y);
    if (G[i] < bestG - 0.5 || (G[i] <= bestG + 0.5 && dd < bestD && G[i] < bestG)) { bestG = G[i]; sx = xx; sy = yy; bestD = dd; }
  }
  const ref = meanLab(e, sx, sy, 2), { L, A, B, valid } = e, lim2 = tolC * tolC;
  const ok = i => {
    if (!valid[i] || G[i] > tolG || (limit && limit[i] < 128)) return false;
    const dl = L[i] - ref[0], da = A[i] - ref[1], db = B[i] - ref[2];
    return dl * dl + da * da + db * db <= lim2;
  };
  let vis = floodFill(w, h, sy * w + sx, ok), cnt = 0;
  for (let i = 0; i < vis.length; i++) cnt += vis[i];
  if (cnt < 12) {                                  // clicked a tiny speck/edge: fall back to the plain colour wand around the click
    const wd = magicWand(image, x, y, tolC, true, { garment: limit });
    vis = new Uint8Array(w * h); cnt = 0; for (let i = 0; i < vis.length; i++) if (wd[i] >= 128) { vis[i] = 1; cnt++; }
  }
  let ga = 0; if (garment) { for (let i = 0; i < garment.length; i++) ga += garment[i] >= 128; } else for (let i = 0; i < valid.length; i++) ga += valid[i];
  if (!base && cnt && cnt <= 0.15 * ga && opts.growObject !== false) vis = growObject(e, vis, w, h, ref, limit, s);
  if (opts.fillHoles !== false && cnt) {
    // a big flood (> 15% of the garment) is base fabric: only tiny pockets (specks) are filled so prints/stripes inside stay unselected
    fillHolesBin(vis, w, h, Math.max(40, cnt * (base || cnt > 0.15 * ga ? 0.02 : 0.4)));
  }
  // recover the soft fringe / thin tips the edge barrier cut off: 3 colour-limited dilations (<= 1.9x the colour tolerance, no gradient test), then 1 plain px
  { let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (vis[yy * w + xx]) { if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx; if (yy < by0) by0 = yy; if (yy > by1) by1 = yy; }
    const fl2 = lim2 * 3.6;
    for (let pass = 0; pass < 4 && bx1 >= 0; pass++) {
      const add = [];
      for (let yy = Math.max(1, by0 - 2); yy <= Math.min(h - 2, by1 + 2); yy++) for (let xx = Math.max(1, bx0 - 2); xx <= Math.min(w - 2, bx1 + 2); xx++) {
        const i = yy * w + xx; if (vis[i] || !valid[i] || (limit && limit[i] < 128)) continue;
        if (!(vis[i - 1] | vis[i + 1] | vis[i - w] | vis[i + w])) continue;
        if (pass < 3) { const dl = L[i] - ref[0], da = A[i] - ref[1], db = B[i] - ref[2]; if (dl * dl + da * da + db * db > fl2) continue; }
        add.push(i);
      }
      for (const i of add) vis[i] = 1;
      bx0 -= 1; by0 -= 1; bx1 += 1; by1 += 1;
    }
  }
  const dil = vis;
  let res = planeOfBin(dil, w, h);
  if (opts.refine !== false) {
    res = refineEdge(res, image, { radius: opts.snapRadius || 3, strength: 1 });
    // the grown/flooded body (minus its outer pixel) is certain: the two-colour edge model must only refine the rim, never erode multi-colour interiors
    for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) { const i = yy * w + xx; if (vis[i] && vis[i - 1] && vis[i + 1] && vis[i - w] && vis[i + w]) res[i] = 255; }
  }
  if (limit) res = clip(res, limit);
  for (let i = 0; i < res.length; i++) if (!valid[i]) res[i] = 0;
  return res;
}

function componentOf(plane, w, h, idx) {            // 8-connected component of plane>=128 containing idx; soft fringe pixels next to it are kept
  const out = mk(w, h);
  if (plane[idx] < 128) return out;
  const vis = floodFill(w, h, idx, i => plane[i] >= 128);
  for (let i = 0; i < vis.length; i++) if (vis[i]) out[i] = plane[i];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (vis[i] || !plane[i]) continue;
    if ((x > 0 && vis[i - 1]) || (x < w - 1 && vis[i + 1]) || (y > 0 && vis[i - w]) || (y < h - 1 && vis[i + w])
      || (x > 0 && y > 0 && vis[i - w - 1]) || (x < w - 1 && y > 0 && vis[i - w + 1]) || (x > 0 && y < h - 1 && vis[i + w - 1]) || (x < w - 1 && y < h - 1 && vis[i + w + 1])) out[i] = plane[i];
  }
  return out;
}
/** Whole garment component under the point. Call as selectComponent(seg, image, x, y, opts) or selectComponent(seg, x, y, opts).
 *  opts.mode: 'region' (default) = the segmentation region under the point (a sleeve, the body, the collar...; falls back to 'similar' off-region);
 *  'garment' = the connected garment silhouette; 'blob' = just the connected blob of that region under the point (ONE stripe, the crest, one letter group);
 *  'similar' = connected pixels of similar material/colour (needs image; opts.tolerance 14). */
export function selectComponent(seg, a, b, c, d) {
  let image = null, x, y, opts;
  if (typeof a === 'number') { x = a; y = b; opts = c || {}; } else { image = a; x = b; y = c; opts = d || {}; }
  const mode = opts.mode || 'region';
  const gp = seg && seg.mask ? regionPlane(seg.mask) : null, [w, h] = gp ? dimsOf(gp) : [(seg && seg.w) || (image && image.width) || DEFAULT_SIZE, (seg && seg.h) || (image && image.height) || DEFAULT_SIZE];
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return mk(w, h);
  const idx = y * w + x;
  if (mode === 'garment') return gp ? componentOf(gp, w, h, idx) : mk(w, h);
  const name = regionNameAt(seg, x, y);
  if (name && mode === 'region') return copy(regionPlane(seg.regions[name]));
  if (name && mode === 'blob') return componentOf(regionPlane(seg.regions[name]), w, h, idx);
  if (!image) return mk(w, h);
  return magicWand(image, x, y, opts.tolerance == null ? 14 : opts.tolerance, true, { garment: gp });
}

/* ================================================================= outline */
function simplifyOpen(P, a, b, tol, keep) {         // Douglas-Peucker on P[a..b] (inclusive), marks kept indices
  if (b <= a + 1) return;
  const ax = P[a][0], ay = P[a][1], dx = P[b][0] - ax, dy = P[b][1] - ay, L = Math.hypot(dx, dy);
  let best = -1, bd = tol;
  for (let i = a + 1; i < b; i++) {
    const d = L > 1e-9 ? Math.abs((P[i][0] - ax) * dy - (P[i][1] - ay) * dx) / L : Math.hypot(P[i][0] - ax, P[i][1] - ay);
    if (d > bd) { bd = d; best = i; }
  }
  if (best >= 0) { keep[best] = 1; simplifyOpen(P, a, best, tol, keep); simplifyOpen(P, best, b, tol, keep); }
}
function simplifyClosed(P, tol) {
  if (P.length < 8 || !(tol > 0)) return P;
  let far = 0, fd = -1; for (let i = 1; i < P.length; i++) { const d = Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]); if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(P.length + 1); keep[0] = keep[far] = keep[P.length] = 1;
  const Q = P.concat([P[0]]); simplifyOpen(Q, 0, far, tol, keep); simplifyOpen(Q, far, P.length, tol, keep);
  const o = []; for (let i = 0; i < P.length; i++) if (keep[i]) o.push(P[i]); return o;
}
/** Marching squares at 50% coverage with linear interpolation (sub-pixel accurate on anti-aliased masks), chained into closed loops and simplified
 *  (Douglas-Peucker, opts.simplify px, default 0.25). Returns [{points:[{x,y}], closed:true, hole:boolean, area:number}] - outer loops have area > 0,
 *  holes < 0. Image-border contact is closed along the border. Coordinates are canvas px (a hard pixel edge lies exactly on the pixel boundary). */
export function outline(m, opts = {}) {
  m = planeOf(m); const [w, h] = dimsOf(m), bb = bounds(m, 1), res = [];
  if (!bb.w) return res;
  const iso = 127.5, W = w + 3, v = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : m[j * w + i]);
  const sk = [], ek = [], sxy = [], next = new Map();
  const hKey = (i, j) => ((j + 1) * W + (i + 1)) * 2, vKey = (i, j) => hKey(i, j) + 1;
  const ptH = (i, j) => { const a = v(i, j), b = v(i + 1, j); return [i + 0.5 + (iso - a) / (b - a), j + 0.5]; };
  const ptV = (i, j) => { const a = v(i, j), b = v(i, j + 1); return [i + 0.5, j + 0.5 + (iso - a) / (b - a)]; };
  const CO = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let j = bb.y - 1; j <= bb.y + bb.h - 1; j++) for (let i = bb.x - 1; i <= bb.x + bb.w - 1; i++) {
    const va = v(i, j), vb = v(i + 1, j), vc = v(i + 1, j + 1), vd = v(i, j + 1);
    const ins = [va >= 128, vb >= 128, vc >= 128, vd >= 128], cnt = ins[0] + ins[1] + ins[2] + ins[3];
    if (cnt === 0 || cnt === 4) continue;
    // edge descriptors: T=(h at i,j) B=(h at i,j+1) L=(v at i,j) R=(v at i+1,j)
    const E = { T: [hKey(i, j), () => ptH(i, j)], B: [hKey(i, j + 1), () => ptH(i, j + 1)], L: [vKey(i, j), () => ptV(i, j)], R: [vKey(i + 1, j), () => ptV(i + 1, j)] };
    const cut = [['L', 'T'], ['T', 'R'], ['R', 'B'], ['B', 'L']], segs = [];
    if (cnt === 1) { const k = ins.indexOf(true); segs.push([...cut[k], k]); }
    else if (cnt === 3) { const k = ins.indexOf(false); segs.push([...cut[k], (k + 2) % 4]); }
    else if (ins[0] && ins[1]) segs.push(['L', 'R', 0]); else if (ins[1] && ins[2]) segs.push(['T', 'B', 1]);
    else if (ins[2] && ins[3]) segs.push(['L', 'R', 2]); else if (ins[3] && ins[0]) segs.push(['T', 'B', 3]);
    else {                                          // saddle
      const centreIn = (va + vb + vc + vd) / 4 >= 127.5;
      if (ins[0]) { if (centreIn) { segs.push([...cut[1], 0], [...cut[3], 0]); } else { segs.push([...cut[0], 0], [...cut[2], 2]); } }
      else { if (centreIn) { segs.push([...cut[0], 1], [...cut[2], 1]); } else { segs.push([...cut[1], 1], [...cut[3], 3]); } }
    }
    for (const [e1, e2, ref] of segs) {
      const P = E[e1][1](), Q = E[e2][1](), cx = i + 0.5 + CO[ref][0], cy = j + 0.5 + CO[ref][1];
      const cr = (Q[0] - P[0]) * (cy - P[1]) - (Q[1] - P[1]) * (cx - P[0]);
      const s = sk.length;
      if (cr > 0) { sk.push(E[e1][0]); ek.push(E[e2][0]); sxy.push(P); next.set(E[e1][0], s); }
      else { sk.push(E[e2][0]); ek.push(E[e1][0]); sxy.push(Q); next.set(E[e2][0], s); }
    }
  }
  const used = new Uint8Array(sk.length), tol = opts.simplify == null ? 0.25 : opts.simplify;
  for (let s0 = 0; s0 < sk.length; s0++) {
    if (used[s0]) continue;
    let cur = s0, P = [];
    while (cur !== undefined && !used[cur]) { used[cur] = 1; P.push(sxy[cur]); cur = next.get(ek[cur]); }
    if (P.length < 3) continue;
    P = simplifyClosed(P, tol);
    let A = 0; for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; A += a[0] * b[1] - b[0] * a[1]; }
    A /= 2;
    res.push({ points: P.map(p => ({ x: p[0], y: p[1] })), closed: true, hole: A < 0, area: A });
  }
  return res;
}
/** Total length of the polylines returned by outline() (px). */
export function perimeter(contours) {
  let s = 0; for (const c of contours) { const P = c.points; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += Math.hypot(a.x - b.x, a.y - b.y); } } return s;
}
