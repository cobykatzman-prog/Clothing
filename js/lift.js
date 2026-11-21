// Threadform - lifting artwork (a chest logo, crest or graphic) off the garment into its own editable layer.
// inpaintMask fills the masked pixels from the surrounding fabric by copying real patches of the same cloth
// (so the weave and shading carry on instead of a flat smear). Pixels outside the mask are never written.
// Pure canvas + typed arrays; deterministic (seeded), so the same input always gives the same repair.
import { alphaOf, labelComponents, mkCanvas, readRGBA } from './segment.js';

const RING = 1; // grow the lifted shape by this many px before repairing, so anti-aliased fringe is repaired too

/* ------------------------------------------------------------------ masks */

// Accepts a Uint8Array (alpha 0..255, length w*h), or a canvas; returns Uint8Array(w*h).
function planeOf(mask, w, h) {
  if (mask && typeof mask.getContext === 'function') return alphaOf(mask);
  const n = w * h, out = new Uint8Array(n);
  if (mask) for (let i = 0; i < n; i++) out[i] = mask[i] || 0;
  return out;
}

// Square dilation by r px (cheap: separable max over rows then columns).
function dilate(m, w, h, r) {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) if (m[row + k] > v) { v = m[row + k]; if (v === 255) break; }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = y0; k <= y1; k++) { const t = tmp[k * w + x]; if (t > v) { v = t; if (v === 255) break; } }
      out[y * w + x] = v;
    }
  }
  return out;
}

// Bounding box of pixels with value >= thr. null when empty.
function boundsOf(m, w, h, thr = 1) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (m[y * w + x] >= thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ------------------------------------------------------------------ patch fill */

// Small seeded PRNG (mulberry32): the repair is reproducible.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * Fills `hole` pixels of RGBA `d` (Uint8ClampedArray, w*h*4) in place from known fabric.
 * Onion-peel: repeatedly take the frontier pixel whose patch is most complete, find the best-matching fully-known
 * source patch near the hole (sum of squared differences on the known pixels), copy the missing pixels from it
 * (with a colour offset so the patch sits on the surrounding tone), and continue inward.
 */
function patchFill(d, w, h, hole, opts = {}) {
  const r = opts.radius || 6, P = 2 * r + 1, samples = opts.samples || 600, seed = opts.seed || 5;
  const known = new Uint8Array(w * h);
  let holeList = [];
  for (let i = 0; i < w * h; i++) { if (hole[i]) holeList.push(i); else known[i] = 1; }
  if (!holeList.length) return d;
  // search radius from the hole's size: far enough to find the same fabric on both sides, small enough to stay local
  const hb = boundsOf(hole, w, h) || { w: 1, h: 1 };
  const R = opts.searchRadius || Math.max(24, Math.round(Math.max(hb.w, hb.h) * 0.9) + 2 * r);
  const rand = rng(seed);
  const fullyKnown = (cx, cy) => {
    if (cx - r < 0 || cy - r < 0 || cx + r >= w || cy + r >= h) return false;
    for (let dy = -r; dy <= r; dy++) { const row = (cy + dy) * w + cx; for (let dx = -r; dx <= r; dx++) if (!known[row + dx]) return false; }
    return true;
  };
  let guard = 0;
  while (holeList.length && guard++ < 100000) {
    // frontier priority: how many known pixels are in the patch (most complete first); ties by position for determinism
    let best = -1, bestC = -1;
    const remaining = [];
    for (const p of holeList) {
      if (known[p]) continue;
      remaining.push(p);
      const px = p % w, py = (p - px) / w;
      let c = 0;
      for (let dy = -r; dy <= r; dy++) { const yy = py + dy; if (yy < 0 || yy >= h) continue; for (let dx = -r; dx <= r; dx++) { const xx = px + dx; if (xx >= 0 && xx < w && known[yy * w + xx]) c++; } }
      if (c > bestC) { bestC = c; best = p; }
    }
    holeList = remaining;
    if (best < 0 || bestC === 0) break;
    const px = best % w, py = (best - px) / w;
    // target window: which pixels are known (to compare) and which must be filled
    const cx = Math.round(px), cy = Math.round(py);
    // candidate source centres: random points around the hole, whose whole patch is known
    let bestSrc = -1, bestScore = Infinity;
    for (let s = 0; s < samples; s++) {
      const ang = rand() * Math.PI * 2, rad = Math.sqrt(rand()) * R;
      const sx = Math.round(cx + Math.cos(ang) * rad), sy = Math.round(cy + Math.sin(ang) * rad);
      if (!fullyKnown(sx, sy)) continue;
      let ssd = 0, cnt = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = cy + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = cx + dx; if (xx < 0 || xx >= w) continue;
          const t = yy * w + xx; if (!known[t]) continue;
          const u = ((sy + dy) * w + sx + dx) * 4, q = t * 4;
          const e0 = d[q] - d[u], e1 = d[q + 1] - d[u + 1], e2 = d[q + 2] - d[u + 2];
          ssd += e0 * e0 + e1 * e1 + e2 * e2; cnt++;
        }
      }
      if (!cnt) continue;
      const score = ssd / cnt;
      if (score < bestScore) { bestScore = score; bestSrc = sy * w + sx; }
    }
    if (bestSrc < 0) { // no clean source nearby: widen the search once with more samples
      for (let s = 0; s < samples * 4 && bestSrc < 0; s++) {
        const sx = Math.round(cx + (rand() * 2 - 1) * R * 1.5), sy = Math.round(cy + (rand() * 2 - 1) * R * 1.5);
        if (fullyKnown(sx, sy)) bestSrc = sy * w + sx;
      }
      if (bestSrc < 0) break;
    }
    const sxC = bestSrc % w, syC = (bestSrc - sxC) / w;
    // colour offset: tone of the known target pixels versus the source patch, applied to the copied pixels
    let oR = 0, oG = 0, oB = 0, oc = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = cy + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = cx + dx; if (xx < 0 || xx >= w) continue;
        const t = yy * w + xx; if (!known[t]) continue;
        const u = ((syC + dy) * w + sxC + dx) * 4, q = t * 4;
        oR += d[q] - d[u]; oG += d[q + 1] - d[u + 1]; oB += d[q + 2] - d[u + 2]; oc++;
      }
    }
    if (oc) { oR /= oc; oG /= oc; oB /= oc; }
    for (let dy = -r; dy <= r; dy++) {
      const yy = cy + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = cx + dx; if (xx < 0 || xx >= w) continue;
        const t = yy * w + xx; if (known[t] || !hole[t]) continue;
        const u = ((syC + dy) * w + sxC + dx) * 4, q = t * 4;
        d[q] = clamp(d[u] + oR); d[q + 1] = clamp(d[u + 1] + oG); d[q + 2] = clamp(d[u + 2] + oB); d[q + 3] = d[u + 3];
        known[t] = 1;
      }
    }
  }
  return d;
}
const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Low-frequency tone of the repaired area comes from the real fabric around it (normalised convolution over the
// known pixels), and only the fine weave grain comes from the copied patches. This removes the faint ghost of the
// artwork that a plain patch copy can leave when the source patches carry a different local tone.
function prefixSums(a, cw, ch) {
  const P = new Float64Array((cw + 1) * (ch + 1)), W = cw + 1;
  for (let y = 0; y < ch; y++) { let row = 0; for (let x = 0; x < cw; x++) { row += a[y * cw + x]; P[(y + 1) * W + x + 1] = P[y * W + x + 1] + row; } }
  return P;
}
function rectSum(P, cw, ch, x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(cw - 1, x1); y1 = Math.min(ch - 1, y1);
  if (x1 < x0 || y1 < y0) return 0;
  const W = cw + 1;
  return P[(y1 + 1) * W + x1 + 1] - P[y0 * W + x1 + 1] - P[(y1 + 1) * W + x0] + P[y0 * W + x0];
}
function lowFreqTone(d, w, h, hole) {
  const hb = boundsOf(hole, w, h);
  if (!hb) return;
  const M = 96, x0 = Math.max(0, hb.x - M), y0 = Math.max(0, hb.y - M);
  const x1 = Math.min(w - 1, hb.x + hb.w - 1 + M), y1 = Math.min(h - 1, hb.y + hb.h - 1 + M);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, n = cw * ch;
  const K = new Float64Array(n), VR = new Float64Array(n), VG = new Float64Array(n), VB = new Float64Array(n);
  const FR = new Float64Array(n), FG = new Float64Array(n), FB = new Float64Array(n), H = new Uint8Array(n);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = y * cw + x, g = (y + y0) * w + (x + x0), q = g * 4;
    FR[i] = d[q]; FG[i] = d[q + 1]; FB[i] = d[q + 2];
    if (hole[g]) H[i] = 1; else { K[i] = 1; VR[i] = d[q]; VG[i] = d[q + 1]; VB[i] = d[q + 2]; }
  }
  const PK = prefixSums(K, cw, ch), PR = prefixSums(VR, cw, ch), PG = prefixSums(VG, cw, ch), PB = prefixSums(VB, cw, ch);
  const PFR = prefixSums(FR, cw, ch), PFG = prefixSums(FG, cw, ch), PFB = prefixSums(FB, cw, ch);
  const grain = 6, area = (2 * grain + 1) * (2 * grain + 1);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = y * cw + x;
    if (!H[i]) continue;
    let cnt = 0, rad = 12, sr = 0, sg = 0, sb = 0;
    for (; rad <= 192; rad *= 2) {
      cnt = rectSum(PK, cw, ch, x - rad, y - rad, x + rad, y + rad);
      if (cnt >= 8) break;
    }
    if (cnt > 0) {
      sr = rectSum(PR, cw, ch, x - rad, y - rad, x + rad, y + rad) / cnt;
      sg = rectSum(PG, cw, ch, x - rad, y - rad, x + rad, y + rad) / cnt;
      sb = rectSum(PB, cw, ch, x - rad, y - rad, x + rad, y + rad) / cnt;
    } else { sr = FR[i]; sg = FG[i]; sb = FB[i]; }
    const br = rectSum(PFR, cw, ch, x - grain, y - grain, x + grain, y + grain) / area;
    const bg = rectSum(PFG, cw, ch, x - grain, y - grain, x + grain, y + grain) / area;
    const bb = rectSum(PFB, cw, ch, x - grain, y - grain, x + grain, y + grain) / area;
    const g = (y + y0) * w + (x + x0), q = g * 4;
    d[q] = clamp(sr + (FR[i] - br)); d[q + 1] = clamp(sg + (FG[i] - bg)); d[q + 2] = clamp(sb + (FB[i] - bb));
  }
}

/**
 * Removes the masked pixels of `canvas` by filling them from the surrounding fabric.
 * Returns a NEW canvas. Pixels outside `mask` keep their values (checked in the tests).
 * opts: {radius, samples, seed, searchRadius}
 */
export function inpaintMask(canvas, mask, opts = {}) {
  const w = canvas.width, h = canvas.height, n = w * h;
  const m = planeOf(mask, w, h);
  const out = mkCanvas(w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const hole = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) if (m[i] > 8) { hole[i] = 1; any = true; }
  if (!any) return out;
  patchFill(img.data, w, h, hole, opts);
  if (opts.lowFreq !== false) lowFreqTone(img.data, w, h, hole);
  ctx.putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ lifting */

/**
 * Lifts the masked artwork into its own transparent layer and repairs the garment underneath.
 * -> { layerCanvas: transparent crop of exactly the masked pixels with a 1 px soft edge (PNG-ready),
 *      bbox: {x,y,w,h} of the lifted pixels, origin: {x,y} where the layer crop starts on the canvas,
 *      repaired: the garment canvas with the artwork filled in, name }
 * Use: createElement('logo', { image: layerCanvas, x: bbox.x + bbox.w/2, y: ... }) to make it an editable layer.
 */
export function liftToLayer(canvas, mask, { name = 'Logo', opts = {} } = {}) {
  const w = canvas.width, h = canvas.height;
  const m = planeOf(mask, w, h);
  const bb = boundsOf(m, w, h, 8);
  if (!bb) return { layerCanvas: null, bbox: null, repaired: canvas, name };
  // soft edge for the layer: the mask itself plus a one-pixel falloff just outside it
  const grown = dilate(m, w, h, RING);
  const src = readRGBA(canvas).data;
  const pad = RING + 1;
  const x0 = Math.max(0, bb.x - pad), y0 = Math.max(0, bb.y - pad);
  const x1 = Math.min(w - 1, bb.x + bb.w - 1 + pad), y1 = Math.min(h - 1, bb.y + bb.h - 1 + pad);
  const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
  const layerCanvas = mkCanvas(lw, lh);
  const lctx = layerCanvas.getContext('2d', { willReadFrequently: true });
  const li = lctx.createImageData(lw, lh), ld = li.data;
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    const gi = (y + y0) * w + (x + x0), o = (y * lw + x) * 4;
    if (!m[gi] && !grown[gi]) continue;
    let a = m[gi];
    if (!a) { // one-pixel ring outside the mask: a soft falloff of the nearest mask alpha
      let best = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + x0 + dx, yy = y + y0 + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (m[yy * w + xx] > best) best = m[yy * w + xx];
      }
      a = Math.round(best * 0.35);
    }
    const s = gi * 4;
    const srcAlpha = src[s + 3];
    ld[o] = src[s]; ld[o + 1] = src[s + 1]; ld[o + 2] = src[s + 2];
    ld[o + 3] = Math.round(a * srcAlpha / 255);
  }
  lctx.putImageData(li, 0, 0);
  const repaired = inpaintMask(canvas, grown, opts);
  return { layerCanvas, bbox: { x: bb.x, y: bb.y, w: bb.w, h: bb.h }, origin: { x: x0, y: y0 }, repaired, name };
}

/* ------------------------------------------------------------------ selection */

/**
 * The chest artwork (logo / crest) as a 1024-style mask (Uint8Array with width/height, 255 = selected), or null.
 * Uses the segmentation's logo region when there is one; otherwise the most distinct compact blob on the chest.
 */
export function autoSelectLogo(seg, image) {
  const w = image.width, h = image.height, n = w * h;
  let bin = new Uint8Array(n);
  if (seg && seg.regions && seg.regions.logos) {
    const a = alphaOf(seg.regions.logos);
    for (let i = 0; i < n; i++) bin[i] = a[i] > 128 ? 1 : 0;
  }
  if (!bin.some(v => v)) bin = chestContrast(seg, image);
  if (!bin || !bin.some(v => v)) return null;
  const { labels, count, areas } = labelComponents(bin, w, h);
  // per-component bounds in one pass (compactness test: aspect and fill ratio of the bounding box)
  const bx0 = new Int32Array(count + 1).fill(w), by0 = new Int32Array(count + 1).fill(h), bx1 = new Int32Array(count + 1).fill(-1), by1 = new Int32Array(count + 1).fill(-1);
  for (let i = 0; i < n; i++) {
    const c = labels[i]; if (!c) continue;
    const x = i % w, y = (i - x) / w;
    if (x < bx0[c]) bx0[c] = x; if (x > bx1[c]) bx1[c] = x; if (y < by0[c]) by0[c] = y; if (y > by1[c]) by1[c] = y;
  }
  let best = -1, bestArea = 0;
  for (let c = 1; c <= count; c++) {
    const a = areas[c];
    if (a < 40 || a <= bestArea) continue;
    const bw = bx1[c] - bx0[c] + 1, bh = by1[c] - by0[c] + 1;
    const aspect = bw / bh, fill = a / (bw * bh);
    if (aspect < 0.3 || aspect > 3.3 || fill < 0.18) continue;
    best = c; bestArea = a;
  }
  if (best < 0) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] === best) out[i] = 255;
  out.width = w; out.height = h;
  return out;
}

// Pixels on the chest that differ clearly from the garment's own base colour (the artwork, not the fabric).
function chestContrast(seg, image) {
  const w = image.width, h = image.height, n = w * h, bin = new Uint8Array(n);
  const L = seg && seg.landmarks, base = seg && seg.metrics && seg.metrics.baseColor;
  if (!L || !base) return bin;
  const b = typeof base === 'string' ? [parseInt(base.slice(1, 3), 16), parseInt(base.slice(3, 5), 16), parseInt(base.slice(5, 7), 16)] : base;
  const top = L.neckBottom.y, bottom = Math.min(L.armpitL.y, L.armpitR.y);
  const half = Math.abs(L.shoulderL.x - L.shoulderR.x) * 0.3;
  const d = readRGBA(image).data;
  const xa = Math.max(0, Math.round(L.centerX - half)), xb = Math.min(w - 1, Math.round(L.centerX + half));
  for (let y = Math.max(0, Math.round(top)); y <= Math.min(h - 1, Math.round(bottom)); y++) for (let x = xa; x <= xb; x++) {
    const i = y * w + x;
    if (d[i * 4 + 3] < 200) continue;
    const dist = Math.hypot(d[i * 4] - b[0], d[i * 4 + 1] - b[1], d[i * 4 + 2] - b[2]);
    if (dist > 60) bin[i] = 1;
  }
  return bin;
}
