// Threadform - garment segmentation: background removal, landmarks, region masks.
// Pure canvas / typed-array image processing, no dependencies.

export const REGION_NAMES = ['body', 'leftSleeve', 'rightSleeve', 'collar', 'neckline', 'cuffs', 'hem', 'shoulders', 'sidePanels', 'stripes', 'logos', 'text', 'fabric'];

/* ------------------------------------------------------------------ helpers */
export function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
export function readRGBA(c) { return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height); }
export function alphaOf(c) {
  const d = readRGBA(c).data, n = c.width * c.height, a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3];
  return a;
}
export function canvasFromAlpha(a, w, h) {
  const c = mkCanvas(w, h), img = new ImageData(w, h), d = img.data;
  for (let i = 0; i < w * h; i++) { const o = i * 4; d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = a[i]; }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// separable box blur of a Float32Array (in place copy returned)
export function boxBlurF(src, w, h, r) {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s * inv;
      s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s * inv;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// connected components (4-neighbour) of a binary array -> {labels(1..n), count, areas}
export function labelComponents(bin, w, h) {
  const labels = new Int32Array(w * h), stack = new Int32Array(w * h), areas = [0];
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (!bin[i] || labels[i]) continue;
    count++; let sp = 0, area = 0; stack[sp++] = i; labels[i] = count;
    while (sp) {
      const p = stack[--sp]; area++;
      const x = p % w, y = (p - x) / w;
      if (x > 0 && bin[p - 1] && !labels[p - 1]) { labels[p - 1] = count; stack[sp++] = p - 1; }
      if (x < w - 1 && bin[p + 1] && !labels[p + 1]) { labels[p + 1] = count; stack[sp++] = p + 1; }
      if (y > 0 && bin[p - w] && !labels[p - w]) { labels[p - w] = count; stack[sp++] = p - w; }
      if (y < h - 1 && bin[p + w] && !labels[p + w]) { labels[p + w] = count; stack[sp++] = p + w; }
    }
    areas.push(area);
  }
  return { labels, count, areas };
}

function erode(bin, w, h, r) {
  let cur = bin;
  for (let k = 0; k < r; k++) {
    const nx = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w]) nx[i] = 1;
    }
    cur = nx;
  }
  return cur;
}

/* ------------------------------------------------------------ alpha / bg removal */
function computeAlpha(d, w, h) {
  const n = w * h;
  let nTrans = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] < 250) nTrans++;
  if (nTrans > 0.02 * n) {            // already a cut-out (transparent PNG)
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const v = d[i * 4 + 3]; a[i] = v < 10 ? 0 : v; }
    return a;
  }
  // ---- photo with plain background: border colour flood fill
  const rs = [], gs = [], bs = [], ring = 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < ring || y < ring || x >= w - ring || y >= h - ring) { const o = (y * w + x) * 4; rs.push(d[o]); gs.push(d[o + 1]); bs.push(d[o + 2]); }
  }
  const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  const bg = [med(rs), med(gs), med(bs)];
  let sd = 0;
  for (let i = 0; i < rs.length; i += 7) sd += Math.hypot(rs[i] - bg[0], gs[i] - bg[1], bs[i] - bg[2]);
  sd /= Math.ceil(rs.length / 7);
  const thr = Math.min(90, Math.max(22, 14 + 2.8 * sd)), thr2 = thr * thr;
  const dist2 = o => { const a = d[o] - bg[0], b = d[o + 1] - bg[1], c = d[o + 2] - bg[2]; return a * a + b * b + c * c; };
  const vis = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  const seed = (x, y) => { const i = y * w + x; if (!vis[i] && dist2(i * 4) < thr2) { vis[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  const grow = (q, p) => {
    if (vis[q]) return;
    const dq = dist2(q * 4);
    let ok = dq < thr2;
    if (!ok && dq < thr2 * 2.2) {                    // soft gradients / shadows: follow if locally smooth
      const o = q * 4, e = p * 4, a = d[o] - d[e], b = d[o + 1] - d[e + 1], c = d[o + 2] - d[e + 2];
      ok = a * a + b * b + c * c < 40;
    }
    if (ok) { vis[q] = 1; stack[sp++] = q; }
  };
  while (sp) {
    const p = stack[--sp], x = p % w, y = (p - x) / w;
    if (x > 0) grow(p - 1, p); if (x < w - 1) grow(p + 1, p);
    if (y > 0) grow(p - w, p); if (y < h - 1) grow(p + w, p);
  }
  // enclosed background pockets (gap between sleeve and body): large bg-coloured enclosed areas
  const pocket = new Uint8Array(n), t85 = thr2 * 0.72;
  for (let i = 0; i < n; i++) if (!vis[i] && dist2(i * 4) < t85) pocket[i] = 1;
  const pc = labelComponents(pocket, w, h);
  for (let i = 0; i < n; i++) if (pocket[i] && pc.areas[pc.labels[i]] > 1500) vis[i] = 1;
  let fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg[i] = vis[i] ? 0 : 1;
  // keep significant components only
  const lc = labelComponents(fg, w, h);
  let big = 0; for (let k = 1; k <= lc.count; k++) big = Math.max(big, lc.areas[k]);
  for (let i = 0; i < n; i++) if (fg[i] && lc.areas[lc.labels[i]] < Math.max(60, big * 0.04)) fg[i] = 0;
  // 1px shave of the background halo, then 3x3 soften for an anti-aliased edge
  fg = erode(fg, w, h, 1);
  const a = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (fg[i] && x > 0 && y > 0 && x < w - 1 && y < h - 1 && fg[i - 1] && fg[i + 1] && fg[i - w] && fg[i + w] && fg[i - w - 1] && fg[i - w + 1] && fg[i + w - 1] && fg[i + w + 1]) { a[i] = 255; continue; }
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) s += fg[yy * w + xx];
    }
    a[i] = Math.round(s / 9 * 255);
  }
  return a;
}

export function removeBackground(canvas) {
  const w = canvas.width, h = canvas.height, img = readRGBA(canvas), d = img.data;
  const a = computeAlpha(d, w, h);
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = Math.min(d[i * 4 + 3], a[i]);
  const out = mkCanvas(w, h); out.getContext('2d').putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ analysis */
const median = a => { if (!a.length) return 0; const b = Float64Array.from(a).sort(); return b[b.length >> 1]; };
function fitLine(ys, xs) {           // x = a + b*y, one outlier-rejection pass
  let pts = ys.map((y, i) => [y, xs[i]]);
  let a = xs[0] || 0, b = 0;
  for (let pass = 0; pass < 2; pass++) {
    const n = pts.length; if (n < 2) break;
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (const [y, x] of pts) { sy += y; sx += x; syy += y * y; sxy += x * y; }
    const den = n * syy - sy * sy;
    b = Math.abs(den) < 1e-6 ? 0 : (n * sxy - sx * sy) / den; a = (sx - b * sy) / n;
    if (pass === 0) {
      const res = pts.map(([y, x]) => Math.abs(x - (a + b * y))), m = median(res) + 1.5;
      pts = pts.filter((p, i) => res[i] <= m * 2.5);
    }
  }
  return { a, b };
}

export async function segmentGarment(canvas) {
  const w = canvas.width, h = canvas.height, n = w * h;
  const img = readRGBA(canvas), d = img.data;
  const alpha = computeAlpha(d, w, h);
  let bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = alpha[i] >= 96 ? 1 : 0;
  { // drop specks / unrelated bits
    const lc = labelComponents(bin, w, h); let big = 0;
    for (let k = 1; k <= lc.count; k++) big = Math.max(big, lc.areas[k]);
    for (let i = 0; i < n; i++) if (bin[i] && lc.areas[lc.labels[i]] < big * 0.03) { bin[i] = 0; alpha[i] = 0; }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1, sxm = 0, cnt = 0;
  const topY = new Int32Array(w).fill(-1), botY = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!bin[y * w + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    sxm += x; cnt++;
    if (topY[x] < 0) topY[x] = y; botY[x] = y;
  }
  const maskCanvas = canvasFromAlpha(alpha, w, h);
  const empty = () => {
    const regions = {}; for (const r of REGION_NAMES) regions[r] = canvasFromAlpha(new Uint8Array(n), w, h);
    const p = { x: w / 2, y: h / 2 };
    return { mask: maskCanvas, bbox: { x: 0, y: 0, w: 0, h: 0 }, regions, w, h, metrics: { empty: true, sleeves: {}, neckRx: 40, neckRy: 40, bodyHalfW: 100 },
      landmarks: { neckTop: p, neckBottom: p, shoulderL: p, shoulderR: p, hemL: p, hemR: p, cuffL: p, cuffR: p, armpitL: p, armpitR: p, centerX: w / 2 } };
  };
  if (cnt < 200) return empty();
  const W = x1 - x0 + 1, H = y1 - y0 + 1, cx0 = sxm / cnt;

  // ---------- central run per row (the torso column)
  const cl = new Int16Array(h).fill(-1), cr = new Int16Array(h).fill(-1);
  const centralRun = (y, seed) => {
    let x = Math.round(seed);
    if (!bin[y * w + x]) {
      let found = -1;
      for (let k = 1; k < W * 0.12; k++) { if (bin[y * w + x + k]) { found = x + k; break; } if (bin[y * w + x - k]) { found = x - k; break; } }
      if (found < 0) return false;
      x = found;
    }
    let l = x, r = x;
    while (l > 0 && bin[y * w + l - 1]) l--;
    while (r < w - 1 && bin[y * w + r + 1]) r++;
    cl[y] = l; cr[y] = r; return true;
  };
  for (let y = y0; y <= y1; y++) centralRun(y, cx0);
  const widthsAt = (fa, fb) => { const a = []; for (let y = Math.round(y0 + fa * H); y <= Math.round(y0 + fb * H); y++) if (cl[y] >= 0) a.push(cr[y] - cl[y]); return a; };
  const w60 = median(widthsAt(0.6, 0.85));
  let hemY = y1;
  for (let y = y1; y > y0; y--) if (cl[y] >= 0 && cr[y] - cl[y] > 0.5 * w60) { hemY = y; break; }
  const Ht = hemY - y0;
  const fy0 = Math.round(y0 + 0.62 * Ht), fy1 = Math.round(y0 + 0.9 * Ht);
  const ysR = [], xsR = [], xsL = [];
  for (let y = fy0; y <= fy1; y++) if (cl[y] >= 0) { ysR.push(y); xsR.push(cr[y]); xsL.push(cl[y]); }
  const lineR = fitLine(ysR, xsR), lineL = fitLine(ysR, xsL);
  const bandR = median(xsR), bandL = median(xsL), cx = (bandL + bandR) / 2, bandW = bandR - bandL;
  const tolJ = Math.max(5, 0.025 * bandW);

  const findArmpit = (sgn) => {            // sgn +1: viewer-right side (garment left)
    const ln = sgn > 0 ? lineR : lineL;
    let run = 0;
    for (let y = fy0; y >= y0 + Math.round(0.06 * Ht); y--) {
      if (cl[y] < 0) continue;
      const e = sgn > 0 ? cr[y] : cl[y], dev = sgn * (e - (ln.a + ln.b * y));
      if (dev > tolJ) { run++; if (run >= 2) return Math.min(hemY - 1, y + 2); } else run = 0;
    }
    return Math.round(y0 + 0.3 * Ht);
  };
  const sides = {};
  for (const [key, sgn, ln] of [['L', +1, lineR], ['R', -1, lineL]]) {
    const yA = Math.max(y0 + 2, findArmpit(sgn));
    const xA = ln.a + ln.b * yA;
    sides[key] = { sgn, ln, yA, xA, sideX: y => (y >= yA ? ln.a + ln.b * y : xA) };
  }

  // ---------- sleeves
  const sleeves = {}, sleeveSets = {};
  for (const key of ['L', 'R']) {
    const S = sides[key], sgn = S.sgn, set = new Uint8Array(n);
    for (let y = y0; y <= y1; y++) {
      const sx = S.sideX(y) + sgn * 2;
      if (sgn > 0) for (let x = Math.max(0, Math.ceil(sx)); x <= x1; x++) { if (bin[y * w + x]) set[y * w + x] = 1; }
      else for (let x = Math.min(w - 1, Math.floor(sx)); x >= x0; x--) { if (bin[y * w + x]) set[y * w + x] = 1; }
    }
    const lc = labelComponents(set, w, h); let best = 0, ba = 0;
    for (let k = 1; k <= lc.count; k++) if (lc.areas[k] > ba) { ba = lc.areas[k]; best = k; }
    const keep = new Uint8Array(n);
    if (ba > 0.002 * n) for (let i = 0; i < n; i++) if (lc.labels[i] === best) keep[i] = 1;
    const shY = topY[Math.max(0, Math.min(w - 1, Math.round(S.xA)))];
    const shoulder = { x: S.xA, y: shY >= 0 ? shY : y0 };
    const armpit = { x: S.xA, y: S.yA };
    const root = { x: S.xA, y: (shoulder.y + armpit.y) / 2 };
    const info = { has: ba > 0.002 * n, root, shoulder, armpit };
    if (info.has) {
      let dmax = 0; const idx = [];
      for (let i = 0; i < n; i++) if (keep[i]) { idx.push(i); const x = i % w, y = (i - x) / w; dmax = Math.max(dmax, Math.hypot(x - root.x, y - root.y)); }
      let sx = 0, sy = 0, c = 0;
      for (const i of idx) { const x = i % w, y = (i - x) / w; if (Math.hypot(x - root.x, y - root.y) >= 0.88 * dmax) { sx += x; sy += y; c++; } }
      let ax = sx / c - root.x, ay = sy / c - root.y, L0 = Math.hypot(ax, ay); ax /= L0; ay /= L0;
      let tmax = 0;
      for (const i of idx) { const x = i % w, y = (i - x) / w; tmax = Math.max(tmax, (x - root.x) * ax + (y - root.y) * ay); }
      const band = Math.max(4, 0.05 * tmax); let tx = 0, ty = 0, tc = 0, hw = 0;
      for (const i of idx) {
        const x = i % w, y = (i - x) / w, t = (x - root.x) * ax + (y - root.y) * ay, v = (x - root.x) * -ay + (y - root.y) * ax;
        if (t > tmax - band) { tx += x; ty += y; tc++; }
        if (t > 0) hw = Math.max(hw, Math.abs(v));
      }
      const mx = tx / tc, my = ty / tc, vm = (mx - root.x) * -ay + (my - root.y) * ax;
      const cuff = { x: root.x + ax * tmax - ay * vm, y: root.y + ay * tmax + ax * vm };
      Object.assign(info, { a: { x: ax, y: ay }, n: { x: -ay, y: ax }, L: tmax, hw, cuff, cuffLen: Math.max(12, 0.16 * tmax) });
      if (tmax < 20) info.has = false;
    }
    if (!info.has) { info.cuff = { ...armpit }; info.L = 0; info.hw = 0; info.a = { x: sgn, y: 0.3 }; info.n = { x: -0.3, y: sgn }; info.cuffLen = 0; }
    sleeves[key] = info; sleeveSets[key] = info.has ? keep : new Uint8Array(n);
  }

  // ---------- neck
  let yTopMin = h;
  for (let x = Math.round(cx - 0.28 * W); x <= Math.round(cx + 0.28 * W); x++) if (topY[x] >= 0 && topY[x] < yTopMin) yTopMin = topY[x];
  if (yTopMin === h) yTopMin = y0;
  const xc = Math.round(cx), notch = (topY[xc] >= 0 ? topY[xc] : yTopMin) - yTopMin;
  const Wsh = Math.max(40, sides.L.xA - sides.R.xA);
  let neckRx, neckRy;
  if (notch > 0.025 * Ht) {
    const lvl = yTopMin + 0.35 * notch;
    let xl = xc, xr = xc;
    while (xl > x0 && topY[xl - 1] > lvl) xl--;
    while (xr < x1 && topY[xr + 1] > lvl) xr++;
    neckRx = Math.max(10, (xr - xl) / 2 / 0.937); neckRy = notch;
  } else { neckRx = 0.19 * Wsh; neckRy = 0.85 * neckRx; }
  const ringW = Math.min(36, Math.max(8, 0.28 * neckRx));

  // ---------- region masks
  const R = {}; for (const r of REGION_NAMES) R[r] = new Uint8Array(n);
  const rho = (x, y) => Math.hypot((x - cx) / neckRx, (y - yTopMin) / neckRy);
  const hemBand = Math.max(10, 0.07 * Ht);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x; if (!bin[i]) continue;
    R.fabric[i] = alpha[i];
    const isSL = sleeveSets.L[i], isSR = sleeveSets.R[i];
    if (isSL) R.leftSleeve[i] = 255;
    if (isSR) R.rightSleeve[i] = 255;
    const rr = (y >= yTopMin - 2) ? rho(x, y) : 99;
    const inNeck = rr < 1.12, inCollar = rr >= 1.0 && rr < 1 + ringW / neckRx;
    if (inNeck) R.neckline[i] = 255;
    if (inCollar) R.collar[i] = 255;
    if (!isSL && !isSR) {
      if (!inNeck && !inCollar) R.body[i] = 255;
      if (y > hemY - hemBand && y <= hemY) R.hem[i] = 255;
      if (y <= topY[x] + 0.075 * Ht && !inNeck && !inCollar && x > sides.R.xA - 0.1 * W && x < sides.L.xA + 0.1 * W) R.shoulders[i] = 255;
      if (y > Math.min(sides.L.yA, sides.R.yA) + 4) {
        const dl = Math.abs(x - sides.L.sideX(y)), dr = Math.abs(x - sides.R.sideX(y));
        if (Math.min(dl, dr) < 0.11 * bandW) R.sidePanels[i] = 255;
      }
    } else if (R.shoulders[i] === 0 && y <= topY[x] + 0.06 * Ht) R.shoulders[i] = 255;
  }
  for (const key of ['L', 'R']) {            // cuffs: last stretch of each sleeve along its axis
    const s = sleeves[key]; if (!s.has) continue;
    const set = sleeveSets[key];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * w + x; if (!set[i]) continue;
      if ((x - s.root.x) * s.a.x + (y - s.root.y) * s.a.y > s.L - s.cuffLen) R.cuffs[i] = 255;
    }
  }

  // ---------- stripes / logos / text: contrast bands against the dominant garment colour
  const inner = erode(bin, w, h, 4);
  const hist = new Uint32Array(4096), hr = new Float64Array(4096), hg = new Float64Array(4096), hb = new Float64Array(4096);
  for (let i = 0; i < n; i += 2) {
    if (!inner[i]) continue; const o = i * 4, k = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
    hist[k]++; hr[k] += d[o]; hg[k] += d[o + 1]; hb[k] += d[o + 2];
  }
  let bk = 0; for (let k = 1; k < 4096; k++) if (hist[k] > hist[bk]) bk = k;
  // refine base colour as mean of the 3 strongest neighbouring bins
  let bR = hr[bk], bG = hg[bk], bB = hb[bk], bC = hist[bk];
  const base = hist[bk] ? [bR / bC, bG / bC, bB / bC] : [128, 128, 128];
  const Lb = 0.299 * base[0] + 0.587 * base[1] + 0.114 * base[2];
  const accent = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inner[i]) continue;
    const o = i * 4, r = d[o], g = d[o + 1], b = d[o + 2], Lp = 0.299 * r + 0.587 * g + 0.114 * b;
    const sc = (Lp + 8) / (Lb + 8);
    const dc = Math.hypot(r - Math.min(255, base[0] * sc), g - Math.min(255, base[1] * sc), b - Math.min(255, base[2] * sc));
    const dl = Math.max(0, Math.abs(Lp - Lb) - 0.22 * Lb - 10);
    if (dc + dl * 1.2 > 38) accent[i] = 1;
  }
  const lc = labelComponents(accent, w, h), cn = lc.count;
  if (cn > 0 && cn < 60000) {
    const N = new Float64Array(cn + 1), SX = new Float64Array(cn + 1), SY = new Float64Array(cn + 1), SXX = new Float64Array(cn + 1), SYY = new Float64Array(cn + 1), SXY = new Float64Array(cn + 1);
    const MNX = new Int32Array(cn + 1).fill(w), MXX = new Int32Array(cn + 1).fill(-1), MNY = new Int32Array(cn + 1).fill(h), MXY = new Int32Array(cn + 1).fill(-1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = lc.labels[y * w + x]; if (!k) continue;
      N[k]++; SX[k] += x; SY[k] += y; SXX[k] += x * x; SYY[k] += y * y; SXY[k] += x * y;
      if (x < MNX[k]) MNX[k] = x; if (x > MXX[k]) MXX[k] = x; if (y < MNY[k]) MNY[k] = y; if (y > MXY[k]) MXY[k] = y;
    }
    const G = Math.max(W, H), cls = new Uint8Array(cn + 1); // 1 stripe, 2 logo, 3 text
    const small = [];
    for (let k = 1; k <= cn; k++) {
      if (N[k] < 24) continue;
      const mx = SX[k] / N[k], my = SY[k] / N[k];
      const cxx = SXX[k] / N[k] - mx * mx, cyy = SYY[k] / N[k] - my * my, cxy = SXY[k] / N[k] - mx * my;
      const tr = cxx + cyy, dt = Math.sqrt(Math.max(0, (cxx - cyy) * (cxx - cyy) / 4 + cxy * cxy));
      const l1 = tr / 2 + dt, l2 = Math.max(0, tr / 2 - dt);
      const len = Math.sqrt(12 * l1), thick = Math.sqrt(12 * l2);
      if (len > 0.22 * G && thick < 0.17 * G && thick / len < 0.42) cls[k] = 1;
      else if (len < 0.2 * G && N[k] < 0.04 * W * H && mx > bandL + 0.05 * bandW && mx < bandR - 0.05 * bandW && my > y0 + 0.12 * Ht && my < hemY - 0.03 * Ht) small.push({ k, mx, my, hh: MXY[k] - MNY[k] + 1 });
    }
    for (const s of small) {
      let nb = 0;
      for (const o of small) if (o !== s && Math.abs(o.my - s.my) < 0.6 * Math.max(s.hh, o.hh) + 4 && Math.abs(o.mx - s.mx) < 0.09 * G && o.hh < 2.2 * s.hh + 4 && s.hh < 2.2 * o.hh + 4) nb++;
      cls[s.k] = nb >= 2 && s.hh < 0.07 * G ? 3 : 2;
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = lc.labels[y * w + x]; if (!k) continue;
      const c = cls[k];
      if (c === 1) R.stripes[y * w + x] = 255; else if (c === 2) R.logos[y * w + x] = 255; else if (c === 3) R.text[y * w + x] = 255;
    }
  }

  const regions = {}; for (const r of REGION_NAMES) regions[r] = canvasFromAlpha(R[r], w, h);
  const lm = {
    neckTop: { x: cx, y: yTopMin }, neckBottom: { x: cx, y: yTopMin + neckRy },
    shoulderL: sleeves.L.shoulder, shoulderR: sleeves.R.shoulder,
    hemL: { x: sides.L.sideX(hemY), y: hemY }, hemR: { x: sides.R.sideX(hemY), y: hemY },
    cuffL: sleeves.L.cuff, cuffR: sleeves.R.cuff,
    armpitL: sleeves.L.armpit, armpitR: sleeves.R.armpit, centerX: cx
  };
  return {
    mask: maskCanvas, bbox: { x: x0, y: y0, w: W, h: H }, regions, landmarks: lm, w, h,
    metrics: { neckRx, neckRy, ringW, bodyHalfW: bandW / 2, hemY, bodyH: Ht, sleeves, baseColor: base, notch: notch > 0.025 * Ht }
  };
}

/* ------------------------------------------------------------------ queries */
const _cache = new WeakMap();
function regionArr(c) {
  let a = _cache.get(c);
  if (!a) { a = alphaOf(c); _cache.set(c, a); }
  return a;
}
const AT_ORDER = ['text', 'logos', 'cuffs', 'collar', 'neckline', 'hem', 'stripes', 'shoulders', 'sidePanels', 'leftSleeve', 'rightSleeve', 'body'];
export function regionAt(seg, x, y) {
  if (!seg || !seg.regions) return null;
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0) return null;
  for (const name of AT_ORDER) {
    const c = seg.regions[name]; if (!c || x >= c.width || y >= c.height) continue;
    if (regionArr(c)[y * c.width + x] > 127) return name;
  }
  const f = seg.regions.fabric;
  if (f && x < f.width && y < f.height && regionArr(f)[y * f.width + x] > 127) return 'fabric';
  return null;
}
