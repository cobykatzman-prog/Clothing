// Threadform - geometric garment reshaping.
// A landmark-driven displacement field (body / shoulders / sleeves in sleeve-local axes / neckline / hem) is
// evaluated on a fine triangle mesh and the ORIGINAL pixels are re-sampled through it (bilinear, premultiplied),
// so stripes, cuffs and shading bend with the new silhouette. Region masks are carried through the same warp.
import { segmentGarment, REGION_NAMES, alphaOf, canvasFromAlpha, mkCanvas, readRGBA, boxBlurF, smooth } from './segment.js';

export const DEFAULT_PARAMS = { bodyWidth: 0, bodyLength: 0, shoulderWidth: 0, sleeveLength: 0, sleeveWidth: 0, sleeveFlare: 0, sleeveShape: 0, collarSize: 0, neckOpening: 0, hemShape: 0, cropLength: 0 };

export const SLEEVE_PRESETS = {
  straight:   { sleeveWidth: 0, sleeveFlare: 0, sleeveShape: 0 },
  relaxed:    { sleeveWidth: 28, sleeveFlare: 8, sleeveShape: 22, sleeveLength: 6 },
  oversized:  { sleeveWidth: 60, sleeveFlare: 14, sleeveLength: 18, sleeveShape: 10 },
  tapered:    { sleeveWidth: -18, sleeveFlare: -60 },
  bell:       { sleeveWidth: 12, sleeveFlare: 100, sleeveShape: 30 },
  slightFlare:{ sleeveFlare: 38 },
  wideFlare:  { sleeveWidth: 14, sleeveFlare: 80, sleeveShape: 12 },
  openHem:    { sleeveWidth: 18, sleeveFlare: 28, sleeveShape: 10 },
  ribbedCuff: { sleeveWidth: 6, sleeveFlare: -38 }
};

export const FIT_PRESETS = {
  slim:      { bodyWidth: -26, shoulderWidth: -8, sleeveWidth: -22, bodyLength: 2 },
  regular:   {},
  relaxed:   { bodyWidth: 22, shoulderWidth: 6, sleeveWidth: 18, bodyLength: 5 },
  boxy:      { bodyWidth: 42, bodyLength: -10, shoulderWidth: 16, sleeveWidth: 26, sleeveLength: -4 },
  oversized: { bodyWidth: 62, bodyLength: 20, shoulderWidth: 30, sleeveWidth: 48, sleeveLength: 16 },
  cropped:   { cropLength: 52, bodyWidth: 12, bodyLength: -4 }
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);

/* ------------------------------------------------------------ displacement field */
function sleeveGeom(seg, key, M) {
  const L = seg.landmarks, sg = key === 'L' ? 1 : -1;
  const m = M.sleeves && M.sleeves[key];
  const sh = key === 'L' ? L.shoulderL : L.shoulderR, ar = key === 'L' ? L.armpitL : L.armpitR, cu = key === 'L' ? L.cuffL : L.cuffR;
  const root = m ? m.root : { x: (sh.x + ar.x) / 2, y: (sh.y + ar.y) / 2 };
  let a, n, len, hw, cl, has;
  if (m && m.a) { a = m.a; n = m.n; len = m.L; hw = m.hw; cl = m.cuffLen; has = m.has; }
  else {
    const dx = cu.x - root.x, dy = cu.y - root.y; len = Math.hypot(dx, dy);
    has = len > 30; a = has ? { x: dx / len, y: dy / len } : { x: sg, y: 0.3 }; n = { x: -a.y, y: a.x };
    hw = Math.max(30, 0.55 * Math.hypot(sh.x - ar.x, sh.y - ar.y)); cl = Math.max(12, 0.16 * len);
  }
  const nd = n.y >= 0 ? n : { x: -n.x, y: -n.y };            // perpendicular pointing "down"
  return { sgn: sg, root, a, n, nd, L: len, hw: Math.max(hw, 10), cl, has, xA: ar.x, yA: ar.y, ln: m && m.ln };
}

function makeField(seg, P, sleeveMaskW) {
  const L = seg.landmarks, M = seg.metrics || {};
  const cx = L.centerX, y0 = L.neckTop.y, hemY = (L.hemL.y + L.hemR.y) / 2;
  const bw2 = Math.max(20, (L.hemL.x - L.hemR.x) / 2);
  const yA = Math.min((L.armpitL.y + L.armpitR.y) / 2, hemY - 20);
  const Ht = Math.max(60, hemY - y0), hemBand = Math.max(10, 0.07 * Ht), yH0 = hemY - hemBand;
  const nrx = M.neckRx || Math.max(20, 0.19 * (L.shoulderL.x - L.shoulderR.x));
  const nry = M.neckRy || Math.max(20, L.neckBottom.y - y0);
  const ringW = M.ringW || Math.min(36, Math.max(8, 0.28 * nrx)), ringR = ringW / nrx;
  const bboxW = seg.bbox && seg.bbox.w ? seg.bbox.w : 2 * bw2;

  // ---- body parameters
  const kb = 1 + 0.45 * P.bodyWidth / 100, ks = 1 + 0.25 * P.shoulderWidth / 100;
  let dH = 0.30 * Ht * P.bodyLength / 100 - 0.45 * Ht * P.cropLength / 100;
  dH = clamp(dH, -0.8 * (yH0 - yA), 0.5 * Ht);
  const hemAmp = 0.09 * Ht * P.hemShape / 100;
  // ---- neck parameters
  const kn = 0.4 * P.neckOpening / 100, kc = 0.6 * P.collarSize / 100;
  // ---- sleeve parameters
  const sv = P.sleeveLength, sLen = sv >= 0 ? 1 + 1.7 * sv / 100 : 1 + 0.7 * sv / 100;
  const kw = 0.6 * P.sleeveWidth / 100, kf = P.sleeveFlare >= 0 ? 1.8 * P.sleeveFlare / 100 : 0.6 * P.sleeveFlare / 100;
  const bendAmp = 0.28 * P.sleeveShape / 100 + 0.2 * Math.min(1.2, Math.max(0, sLen - 1));
  const sl = { L: sleeveGeom(seg, 'L', M), R: sleeveGeom(seg, 'R', M) };
  const tw = Math.max(6, 0.02 * bboxW);

  const body = (x, y, o) => {
    let dy;
    if (y <= yA) dy = 0; else if (y <= yH0) dy = dH * (y - yA) / (yH0 - yA); else dy = dH;
    const ramp = y <= yA ? 0 : Math.min(1, (y - yA) / (hemY - yA)), u = Math.min(1.4, Math.abs(x - cx) / bw2);
    dy -= hemAmp * u * u * ramp * ramp;
    const sw = 1 - smooth(yA, yA + 0.4 * (hemY - yA), y);
    let kx = kb * (1 + (ks - 1) * sw);
    const rho = Math.hypot((x - cx) / nrx, (y - y0) / nry);
    kx = 1 + (kx - 1) * (1 - 0.85 * (1 - smooth(1.1, 2.6, rho)));
    o.x = (x - cx) * (kx - 1); o.y = dy;
  };
  const neck = (x, y, o) => {
    o.x = 0; o.y = 0;
    if (!kn && !kc) return;
    const dx = x - cx, dy = y - y0, rho = Math.hypot(dx / nrx, dy / nry);
    if (rho < 1e-6) return;
    let r2;
    if (rho <= 1) r2 = rho * (1 + kn);
    else if (rho <= 1 + ringR) r2 = 1 + kn + (rho - 1) * (1 + kc);
    else r2 = rho + (kn + ringR * kc) * (1 - smooth(0, 1.6, rho - 1 - ringR));
    const f = r2 / rho - 1; o.x = dx * f; o.y = dy * f;
  };
  const tmp = { x: 0, y: 0 };
  // prepare per-sleeve derived numbers
  for (const k of ['L', 'R']) {
    const S = sl[k]; body(S.root.x, S.root.y, tmp);
    S.root2 = { x: S.root.x + tmp.x, y: S.root.y + tmp.y };
    S.Lnew = Math.max(0.2 * S.L, S.L * sLen);
    S.tb = Math.max(1, S.L - S.cl); S.tbNew = Math.max(0.05 * S.L, S.Lnew - S.cl); S.sBody = S.tbNew / S.tb;
  }
  const wfac = (S, fp) => Math.max(0.2, (1 + kw * smooth(0, 0.35, fp)) * (1 + kf * Math.pow(fp, 1.6)));
  const sleeveD = (S, x, y, o) => {
    const rx = x - S.root.x, ry = y - S.root.y;
    const t = rx * S.a.x + ry * S.a.y, v = rx * S.n.x + ry * S.n.y;
    const tp = t <= 0 ? t : t <= S.tb ? t * S.sBody : S.tbNew + (t - S.tb);
    const fp = clamp(tp / S.Lnew, 0, 1), wf = wfac(S, fp), av = Math.abs(v), vmax = 2.5 * S.hw;
    const vp = av <= vmax ? v * wf : Math.sign(v) * (vmax * wf + (av - vmax));
    const bend = bendAmp * S.Lnew * fp * fp;
    o.x = S.root2.x + S.a.x * tp + S.n.x * vp + S.nd.x * bend - x;
    o.y = S.root2.y + S.a.y * tp + S.n.y * vp + S.nd.y * bend - y;
  };
  const sleeveW = (S, x, y) => {
    if (!S.has) return 0;
    const sideX = y >= S.yA && S.ln ? S.ln.a + S.ln.b * y : S.xA;
    const wside = smooth(-tw, tw, S.sgn * (x - sideX));
    if (wside <= 0) return 0;
    const rx = x - S.root.x, ry = y - S.root.y;
    const t = rx * S.a.x + ry * S.a.y, v = rx * S.n.x + ry * S.n.y;
    let wm = 1;
    const mf = sleeveMaskW && sleeveMaskW[S.sgn > 0 ? 'L' : 'R'];
    if (mf) { const wy = smooth(S.yA, S.yA + 30, y); wm = (1 - wy) + wy * mf(x, y); wm = 1 - (1 - wm) * (1 - smooth(0.7 * S.L, 0.9 * S.L, t)); }
    return wside * wm * (1 - smooth(3 * S.hw, 6 * S.hw, Math.abs(v))) * (1 - smooth(1.4 * S.L, 2.2 * S.L, t));
  };
  const b = { x: 0, y: 0 }, nk = { x: 0, y: 0 }, sd = { x: 0, y: 0 };
  // core: displacement of a source point (before region weighting / fit)
  const disp = (x, y, o) => {
    const S = x >= cx ? sl.L : sl.R;
    const w = sleeveW(S, x, y);
    body(x, y, b); neck(x, y, nk);
    let dx = b.x + nk.x, dy = b.y + nk.y;
    if (w > 0) { sleeveD(S, x, y, sd); dx = dx * (1 - w) + sd.x * w; dy = dy * (1 - w) + sd.y * w; }
    o.x = dx; o.y = dy; o.w = w;
  };
  return { disp, sl, kb, kw, kf, wfac, cx, y0, hemY };
}

// region weight: dilated + blurred user mask evaluated at a point (1 = fully free to move)
function makeRegionWeight(regionCanvas, w, h, dil = 7, bl = 5) {
  const G = 4, gw = Math.ceil(w / G), gh = Math.ceil(h / G);
  let a;
  if (regionCanvas.width === w && regionCanvas.height === h) a = alphaOf(regionCanvas);
  else { const c = mkCanvas(w, h); c.getContext('2d').drawImage(regionCanvas, 0, 0, w, h); a = alphaOf(c); }
  let g = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[y * w + x] > 100) g[((y / G) | 0) * gw + ((x / G) | 0)] = 1;
  for (let pass = 0; pass < 2; pass++) {       // dilate ~ 2*7 cells = 56px along each axis
    const t = new Float32Array(gw * gh), r = dil;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let m = 0; for (let k = -r; k <= r && !m; k++) { const xx = x + k; if (xx >= 0 && xx < gw && g[y * gw + xx]) m = 1; } t[y * gw + x] = m;
    }
    const u = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let m = 0; for (let k = -r; k <= r && !m; k++) { const yy = y + k; if (yy >= 0 && yy < gh && t[yy * gw + x]) m = 1; } u[y * gw + x] = m;
    }
    g = u; if (pass === 0) break;
  }
  g = boxBlurF(boxBlurF(g, gw, gh, bl), gw, gh, Math.max(1, bl - 1));
  return (x, y) => {
    const fx = clamp(x / G - 0.5, 0, gw - 1.001), fy = clamp(y / G - 0.5, 0, gh - 1.001), ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const i = iy * gw + ix;
    return clamp((g[i] * (1 - tx) + g[i + 1] * tx) * (1 - ty) + (g[i + gw] * (1 - tx) + g[i + gw + 1] * tx) * ty, 0, 1);
  };
}

const PLANES = REGION_NAMES.filter(n => n !== 'fabric');

/* ------------------------------------------------------------------ applyShape */
export async function applyShape(srcCanvas, seg, params, opts = {}) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const P = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(DEFAULT_PARAMS)) P[k] = clamp(num(params && params[k]), -100, 100);
  if (!seg || !seg.landmarks) seg = await segmentGarment(srcCanvas);
  const copy = mkCanvas(w, h); copy.getContext('2d').drawImage(srcCanvas, 0, 0);
  if (Object.keys(DEFAULT_PARAMS).every(k => !P[k]) || (seg.metrics && seg.metrics.empty)) return { canvas: copy, seg };

  const smw = {};
  if (seg.regions && seg.regions.leftSleeve) { smw.L = makeRegionWeight(seg.regions.leftSleeve, w, h, 3, 3); smw.R = makeRegionWeight(seg.regions.rightSleeve, w, h, 3, 3); }
  const F = makeField(seg, P, smw);
  const rw = opts.region ? makeRegionWeight(opts.region, w, h) : null;
  const tmp = { x: 0, y: 0, w: 0 };
  const map0 = (x, y) => {
    F.disp(x, y, tmp);
    const k = rw ? rw(x, y) : 1;
    return [x + tmp.x * k, y + tmp.y * k, tmp.w * k];
  };

  // ---- predicted output bbox -> uniform fit if the garment would leave the canvas
  const srcA = alphaOf(srcCanvas);
  let fit = { s: 1, tx: 0, ty: 0 };
  {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      if (srcA[i] > 100 && (srcA[i - 1] < 100 || srcA[i + 1] < 100 || srcA[i - w] < 100 || srcA[i + w] < 100)) {
        const p = map0(x, y);
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      }
    }
    const m = 10, bw = x1 - x0, bh = y1 - y0;
    if (x0 < m || y0 < m || x1 > w - m || y1 > h - m) {
      const s = Math.min(1, (w - 2 * m) / bw, (h - 2 * m) / bh);
      const cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2;
      let tx = (cxm - cxm * s) , ty = cym - cym * s;   // scale about bbox centre
      const nx0 = x0 * s + tx, nx1 = x1 * s + tx, ny0 = y0 * s + ty, ny1 = y1 * s + ty;
      if (nx0 < m) tx += m - nx0; else if (nx1 > w - m) tx -= nx1 - (w - m);
      if (ny0 < m) ty += m - ny0; else if (ny1 > h - m) ty -= ny1 - (h - m);
      fit = { s, tx, ty };
    }
  }
  const map = (x, y) => { const p = map0(x, y); return [p[0] * fit.s + fit.tx, p[1] * fit.s + fit.ty, p[2]]; };

  // ---- source planes
  const sd = readRGBA(srcCanvas).data, n = w * h;
  const pre = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const o = i * 4, a = sd[o + 3]; pre[o] = sd[o] * a / 255; pre[o + 1] = sd[o + 1] * a / 255; pre[o + 2] = sd[o + 2] * a / 255; pre[o + 3] = a; }
  const planes = PLANES.map(nm => (seg.regions && seg.regions[nm] ? alphaOf(seg.regions[nm]) : new Uint8Array(n)));
  const outPlanes = PLANES.map(() => new Uint8Array(n));
  const out = new Float32Array(n * 4);

  // ---- mesh
  const STEP = 12, cols = Math.ceil(w / STEP), rows = Math.ceil(h / STEP), vc = cols + 1, vr = rows + 1;
  const VU = new Float32Array(vc * vr), VV = new Float32Array(vc * vr), VX = new Float32Array(vc * vr), VY = new Float32Array(vc * vr), VW = new Float32Array(vc * vr);
  for (let j = 0; j < vr; j++) for (let i = 0; i < vc; i++) {
    const u = Math.min(w, i * STEP), v = Math.min(h, j * STEP), k = j * vc + i, p = map(u, v);
    VU[k] = u; VV[k] = v; VX[k] = p[0]; VY[k] = p[1]; VW[k] = p[2];
  }
  const live = new Uint8Array(cols * rows);          // cells that contain any source pixel
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pre[(y * w + x) * 4 + 3] > 0) {
    const cx_ = (x / STEP) | 0, cy_ = (y / STEP) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = cx_ + dx, yy = cy_ + dy; if (xx >= 0 && yy >= 0 && xx < cols && yy < rows) live[yy * cols + xx] = 1; }
  }
  const np = PLANES.length;

  const tri = (a, b, c) => {
    const X0 = VX[a], Y0 = VY[a], X1 = VX[b], Y1 = VY[b], X2 = VX[c], Y2 = VY[c];
    const den = (Y1 - Y2) * (X0 - X2) + (X2 - X1) * (Y0 - Y2);
    if (Math.abs(den) < 1e-7) return;
    const inv = 1 / den;
    const minx = Math.max(0, Math.floor(Math.min(X0, X1, X2) - 0.5)), maxx = Math.min(w - 1, Math.ceil(Math.max(X0, X1, X2) - 0.5));
    const miny = Math.max(0, Math.floor(Math.min(Y0, Y1, Y2) - 0.5)), maxy = Math.min(h - 1, Math.ceil(Math.max(Y0, Y1, Y2) - 0.5));
    const u0 = VU[a], u1 = VU[b], u2 = VU[c], v0 = VV[a], v1 = VV[b], v2 = VV[c];
    const eps = -0.0008;
    for (let py = miny; py <= maxy; py++) {
      const cyp = py + 0.5;
      for (let px = minx; px <= maxx; px++) {
        const cxp = px + 0.5;
        const l0 = ((Y1 - Y2) * (cxp - X2) + (X2 - X1) * (cyp - Y2)) * inv;
        if (l0 < eps) continue;
        const l1 = ((Y2 - Y0) * (cxp - X2) + (X0 - X2) * (cyp - Y2)) * inv;
        if (l1 < eps) continue;
        const l2 = 1 - l0 - l1;
        if (l2 < eps) continue;
        let sx = l0 * u0 + l1 * u1 + l2 * u2 - 0.5, sy = l0 * v0 + l1 * v1 + l2 * v2 - 0.5;
        if (sx < 0) sx = 0; else if (sx > w - 1.0001) sx = w - 1.0001;
        if (sy < 0) sy = 0; else if (sy > h - 1.0001) sy = h - 1.0001;
        const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
        const i00 = (iy * w + ix) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const sa = pre[i00 + 3] * w00 + pre[i10 + 3] * w10 + pre[i01 + 3] * w01 + pre[i11 + 3] * w11;
        if (sa < 0.5) continue;
        const o = (py * w + px) * 4;
        if (sa < out[o + 3] - 0.01) continue;
        out[o] = pre[i00] * w00 + pre[i10] * w10 + pre[i01] * w01 + pre[i11] * w11;
        out[o + 1] = pre[i00 + 1] * w00 + pre[i10 + 1] * w10 + pre[i01 + 1] * w01 + pre[i11 + 1] * w11;
        out[o + 2] = pre[i00 + 2] * w00 + pre[i10 + 2] * w10 + pre[i01 + 2] * w01 + pre[i11 + 2] * w11;
        out[o + 3] = sa;
        const p00 = i00 >> 2, p10 = i10 >> 2, p01 = i01 >> 2, p11 = i11 >> 2, po = o >> 2;
        for (let q = 0; q < np; q++) {
          const pl = planes[q];
          outPlanes[q][po] = pl[p00] * w00 + pl[p10] * w10 + pl[p01] * w01 + pl[p11] * w11 + 0.5;
        }
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      if (!live[j * cols + i]) continue;
      const a = j * vc + i, b = a + 1, c = a + vc, d = c + 1;
      const sw = (VW[a] + VW[b] + VW[c] + VW[d]) / 4;
      if ((sw >= 0.5 ? 1 : 0) !== pass) continue;
      tri(a, b, c); tri(b, d, c);
    }
  }

  // ---- compose result
  const img = new ImageData(w, h), od = img.data, alpha = new Uint8Array(n);
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = out[o + 3];
    if (a <= 0) continue;
    const k = 255 / a;
    od[o] = Math.min(255, out[o] * k + 0.5); od[o + 1] = Math.min(255, out[o + 1] * k + 0.5); od[o + 2] = Math.min(255, out[o + 2] * k + 0.5);
    od[o + 3] = Math.min(255, a + 0.5); alpha[i] = od[o + 3];
  }
  const canvas = mkCanvas(w, h); canvas.getContext('2d').putImageData(img, 0, 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] >= 96) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }

  // ---- new segmentation (regions warped with the pixels, landmarks pushed through the field)
  const regions = {};
  PLANES.forEach((nm, q) => { regions[nm] = canvasFromAlpha(outPlanes[q], w, h); });
  regions.fabric = canvasFromAlpha(alpha, w, h);
  const L = seg.landmarks, mp = p => { const r = map(p.x, p.y); return { x: r[0], y: r[1] }; };
  const lm = {};
  for (const k of ['neckTop', 'neckBottom', 'shoulderL', 'shoulderR', 'hemL', 'hemR', 'cuffL', 'cuffR', 'armpitL', 'armpitR']) lm[k] = mp(L[k]);
  lm.centerX = map(L.centerX, L.neckTop.y)[0];
  const M = seg.metrics || {}, nm = { ...M, sleeves: {} };
  const nx = mp({ x: L.centerX + (M.neckRx || 40), y: L.neckTop.y }), nxl = mp({ x: L.centerX - (M.neckRx || 40), y: L.neckTop.y });
  nm.neckRx = Math.max(8, Math.abs(nx.x - nxl.x) / 2);
  nm.neckRy = Math.max(8, lm.neckBottom.y - lm.neckTop.y);
  nm.bodyHalfW = Math.abs(lm.hemL.x - lm.hemR.x) / 2; nm.hemY = (lm.hemL.y + lm.hemR.y) / 2; nm.bodyH = nm.hemY - lm.neckTop.y;
  for (const k of ['L', 'R']) {
    const S = F.sl[k], sh = k === 'L' ? lm.shoulderL : lm.shoulderR, ar = k === 'L' ? lm.armpitL : lm.armpitR, cu = k === 'L' ? lm.cuffL : lm.cuffR;
    const root = { x: (sh.x + ar.x) / 2, y: (sh.y + ar.y) / 2 }, dx = cu.x - root.x, dy = cu.y - root.y, len = Math.hypot(dx, dy) || 1;
    const a = S.has ? { x: dx / len, y: dy / len } : S.a;
    nm.sleeves[k] = { has: S.has, root, shoulder: sh, armpit: ar, cuff: cu, a, n: { x: -a.y, y: a.x }, L: S.has ? len : 0, hw: S.hw * F.wfac(S, 0.8) * fit.s, cuffLen: S.cl * fit.s };
  }
  const nseg = { mask: regions.fabric, bbox: bx1 >= 0 ? { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } : { x: 0, y: 0, w: 0, h: 0 }, regions, landmarks: lm, w, h, metrics: nm };
  return { canvas, seg: nseg };
}
