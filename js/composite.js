// Threadform - preservation by compositing (pure, no DOM, runs in the browser and in Node).
// Whatever a model returns, the edit is only ever written INSIDE the selection:
//   mask alpha 0    -> the ORIGINAL pixel, copied byte for byte (the model's output is never read there)
//   mask alpha 255  -> the EDITED pixel (when it is at least `feather` px away from the selection edge)
//   inside a thin band (<= feather px deep, measured inward from the selection edge) -> a linear blend,
//                      so the change fades out at the edge instead of leaving a hard seam.
// The band is inward on purpose: a band that spilled outside the selection would change alpha-0 pixels,
// which the preservation rule forbids.
export const DEFAULT_FEATHER = 2;
export const MAX_FEATHER = 8;

const SQRT2 = Math.SQRT2;

/** Clamps a feather width to the supported 0-8 px range (whole pixels). */
export function clampFeather(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_FEATHER, n)) : DEFAULT_FEATHER;
}

/** Alpha plane (Uint8Array, one byte per pixel) from a plane, or from an ImageData-like {width,height,data} (alpha channel). */
export function alphaPlane(m, w, h) {
  if (m instanceof Uint8Array || m instanceof Uint8ClampedArray) {
    if (m.length !== w * h) throw new TypeError('mask length does not match the image size');
    return m;
  }
  if (m && m.data && m.width === w && m.height === h) {
    const n = w * h, a = new Uint8Array(n), d = m.data;
    for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3];
    return a;
  }
  throw new TypeError('mask must be an alpha plane or ImageData of the same size as the image');
}

/**
 * Distance (px, chamfer approximation) from every selected pixel to the nearest unselected pixel.
 * Unselected pixels are 0. The image border is not a boundary, so a selection touching the border is not feathered there.
 */
export function depthInside(alpha, w, h) {
  const n = w * h, INF = 1e9, d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = alpha[i] === 0 ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + SQRT2);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + SQRT2);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + SQRT2);
        if (x > 0) v = Math.min(v, d[i + w - 1] + SQRT2);
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * Pure compositing. Returns a NEW {width, height, data} (RGBA, Uint8ClampedArray); the inputs are never modified.
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} original  the untouched image
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} edited    what the model (or the local engine) returned
 * @param {Uint8Array|Uint8ClampedArray|{width,height,data}} mask  alpha: 255 = editable, 0 = never changed
 * @param {{feather?:number}} [opts]  band width in px, 0-8 (default 2); 0 = hard edge (a partial mask alpha still blends)
 */
export function compositeThroughMask(original, edited, mask, { feather = DEFAULT_FEATHER } = {}) {
  const w = original.width, h = original.height;
  if (!(w > 0 && h > 0)) throw new TypeError('empty image');
  if (edited.width !== w || edited.height !== h) throw new TypeError('edited image must be the same size as the original');
  const n = w * h;
  if (original.data.length !== n * 4 || edited.data.length !== n * 4) throw new TypeError('RGBA data does not match the image size');
  const a = alphaPlane(mask, w, h);
  const F = clampFeather(feather);
  const dist = F > 0 ? depthInside(a, w, h) : null;
  const o = original.data, e = edited.data, out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    let wgt = a[i] / 255;
    if (F > 0 && wgt > 0) wgt *= Math.min(1, dist[i] / F);
    if (wgt <= 0) { out[k] = o[k]; out[k + 1] = o[k + 1]; out[k + 2] = o[k + 2]; out[k + 3] = o[k + 3]; continue; }
    if (wgt >= 1) { out[k] = e[k]; out[k + 1] = e[k + 1]; out[k + 2] = e[k + 2]; out[k + 3] = e[k + 3]; continue; }
    for (let c = 0; c < 4; c++) out[k + c] = Math.round(o[k + c] + (e[k + c] - o[k + c]) * wgt);
  }
  return { width: w, height: h, data: out };
}
