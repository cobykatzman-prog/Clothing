// Threadform - procedural sample garments (flat-lay), drawn with Canvas 2D at 1024x1024 on a transparent background.
// Self-contained (no imports) so it can be used / tested stand-alone.

const S = 1024;

export const SAMPLE_KINDS = ['tee', 'longSleeve', 'polo', 'hoodie'];
export const SAMPLE_KIND_LABELS = { tee: 'T-shirt', longSleeve: 'Long sleeve', polo: 'Polo shirt', hoodie: 'Hoodie' };
export const SAMPLE_VIEWS = ['front', 'back', 'side', 'detail'];
export const SAMPLE_DEFAULTS = { color: '#efe6d2', stripe: '#6b4423' };

/* ------------------------------------------------------------------ helpers */
function mk(w = S, h = S) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function hexToRgb(h) {
  h = String(h || '#cccccc').trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  const n = parseInt(h, 16);
  if (isNaN(n)) return [200, 200, 200];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
// t>0 lighten toward white, t<0 darken toward black
function shade(hex, t) {
  const [r, g, b] = hexToRgb(hex); const tgt = t >= 0 ? 255 : 0; const a = Math.abs(t);
  return rgbToHex(r + (tgt - r) * a, g + (tgt - g) * a, b + (tgt - b) * a);
}
function mixHex(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
function lum(hex) { const [r, g, b] = hexToRgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mxp = p => [S - p[0], p[1]];
const norm = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

let Z = 1; // current zoom (shadow blur does not follow ctx transforms, so we scale it manually)
const OFF = 4000;

// Soft (blurred) stroke / fill: draws the shape far off-canvas and keeps only its shadow.
function soft(ctx, pathFn, { color = '#000', blur = 12, alpha = 0.3, width = 8, fill = false, dx = 0, dy = 0 } = {}) {
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = blur * Z; ctx.shadowOffsetX = OFF * Z; ctx.shadowOffsetY = 0;
  ctx.translate(-OFF + dx, dy);
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); pathFn(ctx);
  if (fill) ctx.fill(); else ctx.stroke();
  ctx.restore();
}

let grainCanvas = null;
function grainPattern(ctx) {
  if (!grainCanvas) {
    const N = 192; grainCanvas = mk(N, N); const g = grainCanvas.getContext('2d');
    const id = g.createImageData(N, N); const r = rng(11);
    for (let i = 0; i < N * N; i++) {
      const v = r() < 0.5 ? 0 : 255; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = r() * 26;
    }
    g.putImageData(id, 0, 0);
    g.fillStyle = 'rgba(0,0,0,0.045)';
    for (let y = 0; y < N; y += 3) g.fillRect(0, y, N, 1);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = 1; x < N; x += 3) g.fillRect(x, 0, 1, N);
  }
  return ctx.createPattern(grainCanvas, 'repeat');
}

/* ------------------------------------------------------------------ geometry */
const DEF = {
  tee:        { sh: [326, 224], nl: [432, 178], ap: [352, 436], hem: [350, 880], dir: [-0.72, 0.69], len: 170, hw: 50, depth: 88, hemBand: 0 },
  longSleeve: { sh: [326, 224], nl: [432, 178], ap: [350, 440], hem: [350, 880], dir: [-0.43, 0.90], len: 500, hw: 40, depth: 90, hemBand: 0 },
  polo:       { sh: [326, 224], nl: [432, 176], ap: [352, 436], hem: [350, 880], dir: [-0.74, 0.67], len: 160, hw: 50, depth: 70, hemBand: 0 },
  hoodie:     { sh: [316, 238], nl: [436, 196], ap: [334, 456], hem: [340, 872], dir: [-0.45, 0.89], len: 490, hw: 46, depth: 70, hemBand: 50 },
};

function geometry(kind) {
  const d = DEF[kind];
  const dir = norm(d.dir); const perp = [dir[1], -dir[0]];
  const Lc = {};
  Lc.sh = d.sh; Lc.ap = d.ap; Lc.nl = d.nl; Lc.hem = d.hem;
  Lc.B = mid(d.sh, d.ap);
  Lc.dir = dir;
  Lc.C = add(Lc.B, dir, d.len);
  Lc.O = add(Lc.C, perp, -d.hw);
  Lc.I = add(Lc.C, perp, d.hw);
  Lc.armCtrl = [d.sh[0] + 78, d.sh[1] + 70 + (kind === 'hoodie' ? 8 : 0)];
  Lc.sideCtrl = [mid(d.ap, d.hem)[0] + 3, mid(d.ap, d.hem)[1]];
  const Rc = {
    sh: mxp(Lc.sh), ap: mxp(Lc.ap), nl: mxp(Lc.nl), hem: mxp(Lc.hem), B: mxp(Lc.B), C: mxp(Lc.C), O: mxp(Lc.I), I: mxp(Lc.O),
    dir: [-dir[0], dir[1]], armCtrl: mxp(Lc.armCtrl), sideCtrl: mxp(Lc.sideCtrl),
  };
  // for right side we want O=outer(top) I=inner(bottom) like left
  Rc.O = mxp(Lc.O); Rc.I = mxp(Lc.I);
  return { kind, d, L: Lc, R: Rc, hemSag: 8 };
}

/* ------------------------------------------------------------------ paths */
function neckCurve(ctx, g, depth, fromLeft = true) {
  const { L, R } = g;
  const y0 = L.nl[1], x0 = L.nl[0], x1 = R.nl[0];
  if (fromLeft) {
    ctx.bezierCurveTo(x0 + 6, y0 + depth * 0.72, 512 - 52, y0 + depth, 512, y0 + depth);
    ctx.bezierCurveTo(512 + 52, y0 + depth, x1 - 6, y0 + depth * 0.72, x1, y0);
  } else {
    ctx.bezierCurveTo(x1 - 6, y0 + depth * 0.72, 512 + 52, y0 + depth, 512, y0 + depth);
    ctx.bezierCurveTo(512 - 52, y0 + depth, x0 + 6, y0 + depth * 0.72, x0, y0);
  }
}
function neckOpen(ctx, g, depth) { ctx.moveTo(g.L.nl[0], g.L.nl[1]); neckCurve(ctx, g, depth); }
function bodyPath(ctx, g, depth) {
  const { L, R } = g;
  ctx.moveTo(L.nl[0], L.nl[1]);
  neckCurve(ctx, g, depth);
  ctx.lineTo(R.sh[0], R.sh[1]);
  ctx.quadraticCurveTo(R.armCtrl[0], R.armCtrl[1], R.ap[0], R.ap[1]);
  ctx.quadraticCurveTo(R.sideCtrl[0], R.sideCtrl[1], R.hem[0], R.hem[1]);
  ctx.quadraticCurveTo(512, R.hem[1] + g.hemSag * 2, L.hem[0], L.hem[1]);
  ctx.quadraticCurveTo(L.sideCtrl[0], L.sideCtrl[1], L.ap[0], L.ap[1]);
  ctx.quadraticCurveTo(L.armCtrl[0], L.armCtrl[1], L.sh[0], L.sh[1]);
  ctx.closePath();
}
function sleevePath(ctx, s) {
  const bulge = (a, b, k) => { const m = mid(a, b); const dv = norm([b[0] - a[0], b[1] - a[1]]); return [m[0] + dv[1] * k, m[1] - dv[0] * k]; };
  ctx.moveTo(s.sh[0], s.sh[1]);
  const c1 = bulge(s.sh, s.O, s === undefined ? 0 : (s.dir[0] < 0 ? 7 : -7));
  ctx.quadraticCurveTo(c1[0], c1[1], s.O[0], s.O[1]);
  ctx.lineTo(s.I[0], s.I[1]);
  const c2 = bulge(s.I, s.ap, s.dir[0] < 0 ? 5 : -5);
  ctx.quadraticCurveTo(c2[0], c2[1], s.ap[0], s.ap[1]);
  ctx.quadraticCurveTo(s.armCtrl[0], s.armCtrl[1], s.sh[0], s.sh[1]);
  ctx.closePath();
}
function armholePath(ctx, s) { ctx.moveTo(s.sh[0], s.sh[1]); ctx.quadraticCurveTo(s.armCtrl[0], s.armCtrl[1], s.ap[0], s.ap[1]); }

/* ------------------------------------------------------------------ painting primitives */
function bbox(pathFn) { return null; }

// fills a shape with colour, adds lighting, runs `inside` clipped, then edge shadow + grain
function panel(ctx, pathFn, color, inside, o = {}) {
  ctx.save();
  ctx.beginPath(); pathFn(ctx); ctx.fillStyle = color; ctx.fill();
  ctx.clip();
  const lg = ctx.createLinearGradient(0, 120, 0, 920);
  lg.addColorStop(0, 'rgba(255,255,255,0.15)'); lg.addColorStop(0.45, 'rgba(255,255,255,0)'); lg.addColorStop(1, 'rgba(0,0,0,0.13)');
  ctx.fillStyle = lg; ctx.fillRect(-10, -10, S + 20, S + 20);
  if (o.sideShade !== false) {
    const hg = ctx.createLinearGradient(130, 0, 894, 0);
    hg.addColorStop(0, 'rgba(0,0,0,0.12)'); hg.addColorStop(0.28, 'rgba(0,0,0,0)'); hg.addColorStop(0.72, 'rgba(0,0,0,0)'); hg.addColorStop(1, 'rgba(0,0,0,0.14)');
    ctx.fillStyle = hg; ctx.fillRect(-10, -10, S + 20, S + 20);
  }
  if (inside) inside(ctx);
  soft(ctx, pathFn, { color: '#1a0f05', blur: o.edgeBlur ?? 20, alpha: o.edgeAlpha ?? 0.5, width: 7 });
  ctx.globalAlpha = o.grain ?? 1; ctx.fillStyle = grainPattern(ctx); ctx.fillRect(-10, -10, S + 20, S + 20); ctx.globalAlpha = 1;
  ctx.restore();
}

function line(ctx, pts, style) {
  ctx.save(); ctx.strokeStyle = style.color || '#000'; ctx.lineWidth = style.w || 1.5; ctx.globalAlpha = style.alpha ?? 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (style.dash) ctx.setLineDash(style.dash);
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke(); ctx.restore();
}

// Stitched seam: dark line + dashed lighter thread line next to it along arbitrary path
function seam(ctx, pathFn, { color = '#000', alpha = 0.32, dash = false, w = 1.4, offset = [0, 0] } = {}) {
  ctx.save(); ctx.translate(offset[0], offset[1]);
  ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = w; ctx.lineCap = 'butt';
  if (dash) ctx.setLineDash([5, 3.5]);
  ctx.beginPath(); pathFn(ctx); ctx.stroke(); ctx.restore();
}

// Rib knit block. along='x' => ribs run along x (e.g. sleeve cuffs in local sleeve coords); along='y' => vertical ribs (hem band).
function ribBlock(ctx, x, y, w, h, color, along) {
  ctx.save();
  ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const step = 5.5;
  if (along === 'y') {
    for (let xx = x; xx < x + w; xx += step) {
      ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(xx, y, 2.3, h);
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(xx + 2.8, y, 1.6, h);
    }
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.20)'); g.addColorStop(0.18, 'rgba(255,255,255,0.06)'); g.addColorStop(0.5, 'rgba(255,255,255,0.10)'); g.addColorStop(0.82, 'rgba(255,255,255,0.02)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  } else {
    for (let yy = y; yy < y + h; yy += step) {
      ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(x, yy, w, 2.3);
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(x, yy + 2.8, w, 1.6);
    }
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(0,0,0,0.22)'); g.addColorStop(0.3, 'rgba(255,255,255,0.08)'); g.addColorStop(0.55, 'rgba(255,255,255,0.10)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ sleeves */
function drawSleeve(ctx, g, s, o, behind = false) {
  const kind = g.kind; const { body, trim, stripe, cuffs } = o;
  const hw = g.d.hw;
  const ang = Math.atan2(s.dir[1], s.dir[0]);
  const long = kind === 'longSleeve' || kind === 'hoodie';
  const ribLen = long ? 52 : 40;
  panel(ctx, c => sleevePath(c, s), body, c => {
    c.save(); c.translate(s.C[0], s.C[1]); c.rotate(ang);
    const half = hw + 90; const len = g.d.len + 60;
    // sleeve cylinder shading across axis
    const cg = c.createLinearGradient(0, -hw * 1.6, 0, hw * 1.6);
    cg.addColorStop(0, 'rgba(0,0,0,0.14)'); cg.addColorStop(0.35, 'rgba(255,255,255,0.10)'); cg.addColorStop(0.7, 'rgba(255,255,255,0)'); cg.addColorStop(1, 'rgba(0,0,0,0.14)');
    c.fillStyle = cg; c.fillRect(-len, -half, len + 10, half * 2);
    // fabric creases along sleeve
    const r = rng(kind.length * 17 + (s.dir[0] < 0 ? 1 : 2));
    for (let i = 0; i < 4; i++) {
      const yy = (r() - 0.5) * hw * 1.7; const x0 = -len * (0.35 + r() * 0.5);
      soft(c, k => { k.moveTo(x0, yy); k.quadraticCurveTo(x0 / 2, yy + (r() - 0.5) * 16, -ribLen - 8, yy * 0.8); }, { color: '#000', blur: 7, alpha: 0.12, width: 9 });
      soft(c, k => { k.moveTo(x0, yy + 11); k.quadraticCurveTo(x0 / 2, yy + 12, -ribLen - 8, yy * 0.8 + 11); }, { color: '#fff', blur: 7, alpha: 0.16, width: 7 });
    }
    // stripes (above the cuff)
    if (stripe) {
      let x = -(cuffs === 'rib' ? ribLen : 34) - stripe.gap;
      for (let i = 0; i < stripe.count; i++) {
        const sw = stripe.w * (i === 0 ? 1 : 0.78);
        c.fillStyle = stripe.color; c.fillRect(x - sw, -half, sw, half * 2);
        const sg = c.createLinearGradient(0, -hw * 1.3, 0, hw * 1.3);
        sg.addColorStop(0, 'rgba(0,0,0,0.20)'); sg.addColorStop(0.4, 'rgba(255,255,255,0.10)'); sg.addColorStop(1, 'rgba(0,0,0,0.20)');
        c.fillStyle = sg; c.fillRect(x - sw, -half, sw, half * 2);
        c.fillStyle = 'rgba(255,255,255,0.12)'; for (let yy = -half; yy < half; yy += 3) c.fillRect(x - sw, yy, sw, 0.8);
        c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(x - sw, -half, 1.2, half * 2); c.fillRect(x - 1.2, -half, 1.2, half * 2);
        x -= sw + stripe.gap;
      }
    }
    // cuff / hem
    if (cuffs === 'rib') {
      ribBlock(c, -ribLen, -half, ribLen + 4, half * 2, trim, 'x');
      soft(c, k => { k.moveTo(-ribLen, -half); k.lineTo(-ribLen, half); }, { color: '#000', blur: 6, alpha: 0.35, width: 4, dx: -2 });
      seam(c, k => { k.moveTo(-ribLen, -half); k.lineTo(-ribLen, half); }, { color: '#000', alpha: 0.35, w: 1.2 });
    } else {
      // turned hem: slightly darker band with double stitch
      c.fillStyle = 'rgba(0,0,0,0.07)'; c.fillRect(-32, -half, 36, half * 2);
      seam(c, k => { k.moveTo(-30, -half); k.lineTo(-30, half); }, { color: '#000', alpha: 0.30, w: 1.2, dash: true });
      seam(c, k => { k.moveTo(-24, -half); k.lineTo(-24, half); }, { color: '#000', alpha: 0.30, w: 1.2, dash: true });
      soft(c, k => { k.moveTo(-33, -half); k.lineTo(-33, half); }, { color: '#000', blur: 5, alpha: 0.28, width: 3 });
    }
    // cuff end shadow
    soft(c, k => { k.moveTo(0, -half); k.lineTo(0, half); }, { color: '#000', blur: 8, alpha: 0.28, width: 4, dx: 2 });
    c.restore();
  });
}

/* ------------------------------------------------------------------ body decorations (shared) */
function bodyFolds(ctx, g, o) {
  const { L, R } = g; const r = rng(g.kind.length * 31 + 5);
  const hoodie = g.kind === 'hoodie';
  const sets = [[L, 1], [R, -1]];
  for (const [s, sgn] of sets) {
    for (let i = 0; i < 3; i++) {
      const sx = s.ap[0] + sgn * (6 + i * 10), sy = s.ap[1] + 4 + i * 10;
      const ex = 512 - sgn * (30 + i * 55 + r() * 25), ey = sy + 130 + i * 55 + r() * 40;
      const cx = sx + sgn * (30 + i * 30), cy = sy + 70 + i * 20;
      soft(ctx, k => { k.moveTo(sx, sy); k.quadraticCurveTo(cx, cy, ex, ey); }, { color: '#000', blur: 12, alpha: 0.11 - i * 0.02, width: 16 });
      soft(ctx, k => { k.moveTo(sx + sgn * 14, sy + 6); k.quadraticCurveTo(cx + sgn * 14, cy + 4, ex + sgn * 12, ey + 4); }, { color: '#fff', blur: 10, alpha: 0.20, width: 12 });
    }
  }
  // chest highlight + belly roll
  const rg = ctx.createRadialGradient(512, 380, 20, 512, 420, 300);
  rg.addColorStop(0, 'rgba(255,255,255,0.14)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, S, S);
  soft(ctx, k => { k.moveTo(L.hem[0] + 20, 780); k.bezierCurveTo(420, 760, 600, 800, R.hem[0] - 20, 770); }, { color: '#000', blur: 14, alpha: 0.10, width: 18 });
  soft(ctx, k => { k.moveTo(L.hem[0] + 24, 800); k.bezierCurveTo(430, 782, 590, 818, R.hem[0] - 24, 792); }, { color: '#fff', blur: 12, alpha: 0.16, width: 12 });
  // under-neck shadow cast by collar
  const dep = g.d.depth;
  soft(ctx, k => neckOpen(k, g, dep + 6), { color: '#000', blur: 10, alpha: 0.30, width: 6, dy: 4 });
}

function hemTreatment(ctx, g, o) {
  const { L, R } = g; const y = L.hem[1];
  const hb = g.d.hemBand;
  if (hb) {
    // ribbed hem band
    ctx.save();
    ctx.beginPath(); ctx.rect(0, y - hb + g.hemSag, S, S); ctx.clip();
    ribBlock(ctx, 250, y - hb + g.hemSag - 2, 524, hb + 40, o.trim, 'y');
    ctx.restore();
    soft(ctx, k => { k.moveTo(250, y - hb + g.hemSag); k.quadraticCurveTo(512, y - hb + g.hemSag + 4, 774, y - hb + g.hemSag); }, { color: '#000', blur: 6, alpha: 0.35, width: 4, dy: -2 });
    seam(ctx, k => { k.moveTo(250, y - hb + g.hemSag); k.quadraticCurveTo(512, y - hb + g.hemSag + 4, 774, y - hb + g.hemSag); }, { color: '#000', alpha: 0.35 });
  } else {
    const yy = y - 20;
    seam(ctx, k => { k.moveTo(L.hem[0] - 10, yy); k.quadraticCurveTo(512, yy + g.hemSag * 2, R.hem[0] + 10, yy); }, { color: '#000', alpha: 0.30, dash: true });
    seam(ctx, k => { k.moveTo(L.hem[0] - 10, yy - 7); k.quadraticCurveTo(512, yy - 7 + g.hemSag * 2, R.hem[0] + 10, yy - 7); }, { color: '#000', alpha: 0.30, dash: true });
    soft(ctx, k => { k.moveTo(L.hem[0], yy - 12); k.quadraticCurveTo(512, yy - 12 + g.hemSag * 2, R.hem[0], yy - 12); }, { color: '#000', blur: 6, alpha: 0.18, width: 4 });
  }
}

function armholeSeams(ctx, g, o) {
  for (const s of [g.L, g.R]) {
    const k = s.sh[0] < 512 ? 4 : -4;
    seam(ctx, c => armholePath(c, s), { color: '#000', alpha: 0.40, w: 1.5 });
    seam(ctx, c => armholePath(c, s), { color: '#000', alpha: 0.28, w: 1.2, dash: true, offset: [k, 1] });
  }
}

/* ------------------------------------------------------------------ collars */
function ribCollar(ctx, g, trim, depth, width, back) {
  // band following the neckline, clipped to current clip
  ctx.save();
  const p = k => neckOpen(k, g, depth);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = shade(trim, -0.25); ctx.lineWidth = width * 2 + 3; ctx.beginPath(); p(ctx); ctx.stroke();
  ctx.strokeStyle = trim; ctx.lineWidth = width * 2; ctx.beginPath(); p(ctx); ctx.stroke();
  ctx.setLineDash([2.2, 3.4]); ctx.strokeStyle = 'rgba(0,0,0,0.20)'; ctx.lineWidth = width * 2; ctx.beginPath(); p(ctx); ctx.stroke();
  ctx.setLineDash([1.6, 4.0]); ctx.lineDashOffset = -2.6; ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.beginPath(); p(ctx); ctx.stroke();
  ctx.setLineDash([]);
  // cylinder shading: lighten the middle by drawing narrower stroke
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = width * 0.8; ctx.beginPath(); p(ctx); ctx.stroke();
  ctx.restore();
  soft(ctx, p, { color: '#000', blur: 6, alpha: 0.4, width: 4, dy: 0 });
}

function neckHole(ctx, g, o, depthFront, depthBack, backCollar = true) {
  // fills the inside-back of the garment visible through the neck opening
  const inner = shade(o.body, -0.28);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(g.L.nl[0], g.L.nl[1]);
  ctx.bezierCurveTo(g.L.nl[0] + 10, g.L.nl[1] + depthBack * 0.8, 512 - 40, g.L.nl[1] + depthBack, 512, g.L.nl[1] + depthBack);
  ctx.bezierCurveTo(512 + 40, g.L.nl[1] + depthBack, g.R.nl[0] - 10, g.L.nl[1] + depthBack * 0.8, g.R.nl[0], g.R.nl[1]);
  neckCurve(ctx, g, depthFront, false);
  ctx.closePath();
  ctx.fillStyle = inner; ctx.fill();
  ctx.clip();
  const gr = ctx.createLinearGradient(0, g.L.nl[1], 0, g.L.nl[1] + depthFront);
  gr.addColorStop(0, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0.05)');
  ctx.fillStyle = gr; ctx.fillRect(300, 100, 424, 300);
  if (backCollar) {
    const p = k => { k.moveTo(g.L.nl[0], g.L.nl[1]); k.bezierCurveTo(g.L.nl[0] + 10, g.L.nl[1] + depthBack * 0.8, 512 - 40, g.L.nl[1] + depthBack, 512, g.L.nl[1] + depthBack); k.bezierCurveTo(512 + 40, g.L.nl[1] + depthBack, g.R.nl[0] - 10, g.L.nl[1] + depthBack * 0.8, g.R.nl[0], g.R.nl[1]); };
    ctx.lineCap = 'butt';
    ctx.strokeStyle = shade(o.trim, -0.22); ctx.lineWidth = 2 * 24; ctx.beginPath(); p(ctx); ctx.stroke();
    ctx.setLineDash([2.2, 3.4]); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); p(ctx); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawButton(ctx, x, y, col) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 4 * Z; ctx.shadowOffsetY = 2 * Z;
  const g = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, 10);
  g.addColorStop(0, shade(col, 0.35)); g.addColorStop(1, shade(col, -0.2));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 7); ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (const [dx, dy] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) { ctx.beginPath(); ctx.arc(x + dx, y + dy, 1.1, 0, 7); ctx.fill(); }
  ctx.strokeStyle = 'rgba(240,235,220,0.8)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(x - 2.2, y - 2.2); ctx.lineTo(x + 2.2, y + 2.2); ctx.moveTo(x + 2.2, y - 2.2); ctx.lineTo(x - 2.2, y + 2.2); ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ FRONT / BACK */
function drawFrontBack(ctx, kind, view, o) {
  const g = geometry(kind); const back = view === 'back';
  const { body } = o;
  const hoodie = kind === 'hoodie', polo = kind === 'polo';
  const depthF = back ? 22 : g.d.depth;

  // hood behind (hoodie)
  if (hoodie) drawHoodBack(ctx, g, o, back);

  // sleeves (behind body)
  const sleeves = [g.L, g.R];
  for (const s of sleeves) drawSleeve(ctx, g, s, o);

  // neck inner (back of garment seen through neckline) -- body panel clipped later
  // body base
  if (!hoodie || back) {
    // inner back colour drawn first so it's visible through the neck hole
    ctx.save();
    ctx.beginPath(); bodyPath(ctx, g, 16); ctx.fillStyle = shade(body, -0.28); ctx.fill();
    ctx.restore();
  }
  const bodyFn = c => bodyPath(c, g, depthF);

  panel(ctx, bodyFn, body, c => {
    bodyFolds(c, g, o);
    if (back) {
      // yoke seam across shoulder blades
      const yk = k => { k.moveTo(g.L.sh[0] + 22, g.L.sh[1] + 42); k.quadraticCurveTo(512, 300, g.R.sh[0] - 22, g.R.sh[1] + 42); };
      seam(c, yk, { color: '#000', alpha: 0.32 }); seam(c, yk, { color: '#000', alpha: 0.26, dash: true, offset: [0, 5] });
      // spine centre shadow
      soft(c, k => { k.moveTo(512, 300); k.lineTo(512, 780); }, { color: '#000', blur: 16, alpha: 0.05, width: 30 });
    }
    hemTreatment(c, g, o);
    if (hoodie && !back) hoodieFrontDetails(c, g, o);
    if (hoodie && back) { /* hoodie back plain */ }
  });

  // neckline
  if (hoodie) { hoodieNeck(ctx, g, o, back); }
  else if (polo && !back) { poloFront(ctx, g, o); }
  else {
    // crew collar: clip to body path so band stays on garment
    ctx.save(); ctx.beginPath(); bodyFn(ctx); ctx.clip();
    if (polo && back) ribCollar(ctx, g, o.collar, depthF, 20, true); else ribCollar(ctx, g, o.collar, depthF, 24, true);
    ctx.restore();
    ctx.save(); ctx.beginPath(); neckHoleClip(ctx, g, depthF, 16); ctx.clip();
    ctx.restore();
    // inside back showing through the hole (draw over hole only)
    neckHole(ctx, g, o, depthF, 16, true);
    // collar again, outlined crisp over the hole's lower edge
    ctx.save(); ctx.beginPath(); bodyFn(ctx); ctx.clip();
    ribCollar(ctx, g, o.collar, depthF, back ? 18 : 24, true);
    ctx.restore();
    if (back) backLabel(ctx, g, o);
  }

  // seams
  armholeSeams(ctx, g, o);
  // shoulder seams
  for (const s of [g.L, g.R]) {
    const sx = s.nl, sh = s.sh;
    seam(ctx, c => { c.moveTo(sx[0], sx[1]); c.lineTo(sh[0], sh[1]); }, { color: '#000', alpha: 0.25, w: 1.2 });
  }
  // shadow of body onto sleeve at armhole
  for (const s of [g.L, g.R]) {
    ctx.save(); ctx.beginPath(); sleevePath(ctx, s); ctx.clip();
    soft(ctx, c => armholePath(c, s), { color: '#000', blur: 10, alpha: 0.30, width: 6, dx: s.sh[0] < 512 ? -4 : 4 });
    ctx.restore();
  }
  // soft overall silhouette edge to avoid hard aliasing look
}
function neckHoleClip(ctx, g, df, db) { /* placeholder to keep structure simple */ ctx.rect(0, 0, 0, 0); }

function backLabel(ctx, g, o) {
  const y = g.L.nl[1] + 34;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 4 * Z; ctx.shadowOffsetY = 2 * Z;
  ctx.fillStyle = '#f4f1ea'; ctx.fillRect(490, y, 44, 32);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(40,30,20,0.55)'; ctx.fillRect(497, y + 7, 30, 2.2); ctx.fillRect(497, y + 13, 22, 2); ctx.fillRect(497, y + 19, 26, 2); ctx.fillRect(497, y + 25, 14, 2);
  ctx.restore();
  seam(ctx, c => { c.moveTo(490, y); c.lineTo(534, y); c.moveTo(490, y + 32); c.lineTo(534, y + 32); }, { color: '#000', alpha: 0.2 });
}

/* ---- polo */
function poloFront(ctx, g, o) {
  const collar = o.collar; const { L, R } = g;
  const bodyFn = c => bodyPath(c, g, g.d.depth);
  // neck inside back + back collar standing
  neckHole(ctx, g, o, g.d.depth, 20, false);
  // back collar band behind neck (stands up)
  ctx.save();
  const backBand = k => { k.moveTo(L.nl[0] - 8, L.nl[1] + 6); k.bezierCurveTo(L.nl[0] + 10, L.nl[1] - 36, R.nl[0] - 10, L.nl[1] - 36, R.nl[0] + 8, L.nl[1] + 6); k.lineTo(R.nl[0] - 10, L.nl[1] + 20); k.bezierCurveTo(R.nl[0] - 30, L.nl[1] - 8, L.nl[0] + 30, L.nl[1] - 8, L.nl[0] + 10, L.nl[1] + 20); k.closePath(); };
  ctx.beginPath(); backBand(ctx); ctx.fillStyle = shade(collar, -0.10); ctx.fill();
  ctx.save(); ctx.clip();
  ctx.setLineDash([2, 3.4]); ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 80; ctx.beginPath(); ctx.moveTo(380, 160); ctx.lineTo(650, 160); ctx.stroke(); ctx.setLineDash([]);
  const gg = ctx.createLinearGradient(0, L.nl[1] - 30, 0, L.nl[1] + 20); gg.addColorStop(0, 'rgba(255,255,255,0.2)'); gg.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = gg; ctx.fillRect(380, 100, 270, 150);
  ctx.restore();
  seam(ctx, backBand, { color: '#000', alpha: 0.3 });
  ctx.restore();

  // placket
  const px0 = 494, px1 = 530, py0 = L.nl[1] + 70, py1 = 392;
  ctx.save(); ctx.beginPath(); bodyFn(ctx); ctx.clip();
  // placket opening: V cut shadow
  soft(ctx, k => { k.moveTo(L.nl[0] + 10, L.nl[1] + 12); k.lineTo(512, py0 + 8); k.lineTo(R.nl[0] - 10, R.nl[1] + 12); }, { color: '#000', blur: 8, alpha: 0.35, width: 5, dy: 3 });
  const pg = ctx.createLinearGradient(px0, 0, px1, 0);
  pg.addColorStop(0, shade(o.body, -0.06)); pg.addColorStop(0.5, shade(o.body, 0.06)); pg.addColorStop(1, shade(o.body, -0.10));
  ctx.fillStyle = pg; ctx.fillRect(px0, py0 - 6, px1 - px0, py1 - py0 + 12);
  soft(ctx, k => { k.moveTo(px0, py0); k.lineTo(px0, py1); k.moveTo(px1, py0); k.lineTo(px1, py1); }, { color: '#000', blur: 4, alpha: 0.30, width: 3 });
  seam(ctx, k => { k.moveTo(px0, py0); k.lineTo(px0, py1); k.lineTo(px1, py1); k.lineTo(px1, py0); }, { color: '#000', alpha: 0.40, w: 1.3 });
  seam(ctx, k => { k.moveTo(px0 + 5, py0); k.lineTo(px0 + 5, py1 - 5); k.lineTo(px1 - 5, py1 - 5); k.lineTo(px1 - 5, py0); }, { color: '#000', alpha: 0.28, dash: true, w: 1.1 });
  ctx.restore();
  const bc = shade(o.body, lum(o.body) > 0.55 ? -0.55 : 0.55);
  for (let i = 0; i < 3; i++) drawButton(ctx, 512, py0 + 30 + i * 46, mixHex(bc, o.body, 0.3));

  // collar flaps
  for (const side of [-1, 1]) {
    const s = side < 0 ? L : R; const sx = side < 0 ? 1 : -1; // sx: direction toward centre
    const P = (x, y) => side < 0 ? [x, y] : [S - x, y];
    const a = P(L.nl[0] - 10, L.nl[1] - 4), b = P(508, L.nl[1] - 6), tip = P(500, py0 + 14), mp = P(470, L.nl[1] + 76);
    const flap = k => {
      k.moveTo(a[0], a[1]);
      k.quadraticCurveTo((a[0] + b[0]) / 2, a[1] - 18 * 0 - 2, b[0], b[1]);
      k.lineTo(tip[0], tip[1]);
      k.quadraticCurveTo(mp[0] + (side < 0 ? -24 : 24), mp[1] + 14, a[0], a[1]);
      k.closePath();
    };
    ctx.save();
    // cast shadow of flap on shirt
    soft(ctx, flap, { color: '#000', blur: 9, alpha: 0.4, fill: true, dy: 6, dx: side < 0 ? -2 : 2 });
    ctx.beginPath(); flap(ctx); ctx.fillStyle = collar; ctx.fill(); ctx.clip();
    const fg = ctx.createLinearGradient(a[0], a[1], tip[0], tip[1]);
    fg.addColorStop(0, 'rgba(255,255,255,0.18)'); fg.addColorStop(0.6, 'rgba(0,0,0,0)'); fg.addColorStop(1, 'rgba(0,0,0,0.20)');
    ctx.fillStyle = fg; ctx.fillRect(300, 100, 424, 300);
    ctx.fillStyle = grainPattern(ctx); ctx.fillRect(300, 100, 424, 300);
    // fold edge highlight
    soft(ctx, k => { k.moveTo(a[0], a[1] + 4); k.quadraticCurveTo(mp[0] + (side < 0 ? -24 : 24), mp[1] + 14, tip[0], tip[1]); }, { color: '#000', blur: 5, alpha: 0.35, width: 3 });
    ctx.restore();
    seam(ctx, flap, { color: '#000', alpha: 0.38, w: 1.4 });
    seam(ctx, k => { k.moveTo(a[0] + sx * 3, a[1] + 8); k.quadraticCurveTo(mp[0] + (side < 0 ? -18 : 18), mp[1] + 10, tip[0] + sx * 2, tip[1] - 6); }, { color: '#000', alpha: 0.25, dash: true, w: 1.1 });
  }
}

/* ---- hoodie */
function drawHoodBack(ctx, g, o, back) {
  const { L, R } = g; const hc = o.body;
  const dome = k => {
    k.moveTo(L.nl[0] - 36, 262);
    k.bezierCurveTo(L.nl[0] - 70, 140, 440, 52, 512, 52);
    k.bezierCurveTo(584, 52, R.nl[0] + 70, 140, R.nl[0] + 36, 262);
    k.closePath();
  };
  panel(ctx, dome, back ? hc : shade(hc, -0.04), c => {
    if (back) {
      seam(c, k => { k.moveTo(512, 52); k.lineTo(512, 250); }, { color: '#000', alpha: 0.35 });
      seam(c, k => { k.moveTo(512, 56); k.lineTo(512, 250); }, { color: '#000', alpha: 0.25, dash: true, offset: [5, 0] });
      soft(c, k => { k.moveTo(512, 70); k.lineTo(512, 250); }, { color: '#000', blur: 10, alpha: 0.2, width: 6 });
      // hood rim stitching following dome edge
      seam(c, k => { k.moveTo(L.nl[0] - 22, 262); k.bezierCurveTo(L.nl[0] - 54, 150, 444, 74, 512, 74); k.bezierCurveTo(580, 74, R.nl[0] + 54, 150, R.nl[0] + 22, 262); }, { color: '#000', alpha: 0.25, dash: true });
    }
    const rg = c.createRadialGradient(512, 110, 10, 512, 150, 220); rg.addColorStop(0, 'rgba(255,255,255,0.14)'); rg.addColorStop(1, 'rgba(0,0,0,0.12)');
    c.fillStyle = rg; c.fillRect(300, 40, 424, 240);
  });
}
function hoodieNeck(ctx, g, o, back) {
  const { L, R } = g; const bodyFn = c => bodyPath(c, g, back ? 30 : g.d.depth);
  if (back) {
    // binding along neck at back (hood attached): rounded collar seam
    ctx.save(); ctx.beginPath(); bodyFn(ctx); ctx.clip();
    const p = k => neckOpen(k, g, 30);
    ctx.strokeStyle = shade(o.body, -0.08); ctx.lineWidth = 36; ctx.beginPath(); p(ctx); ctx.stroke();
    soft(ctx, p, { color: '#000', blur: 7, alpha: 0.4, width: 4 });
    seam(ctx, k => { neckOpen(k, g, 30 + 18); }, { color: '#000', alpha: 0.3, dash: true });
    ctx.restore();
    seam(ctx, k => neckOpen(k, g, 30), { color: '#000', alpha: 0.4 });
    return;
  }
  // front: hood lining visible between hood dome and body neckline
  const depth = g.d.depth + 34;
  ctx.save();
  // lining
  const lining = shade(o.body, -0.30);
  ctx.beginPath();
  ctx.moveTo(L.nl[0] - 4, L.nl[1] + 4);
  ctx.bezierCurveTo(L.nl[0] + 4, 110, 448, 78, 512, 78);
  ctx.bezierCurveTo(576, 78, R.nl[0] - 4, 110, R.nl[0] + 4, R.nl[1] + 4);
  ctx.lineTo(R.nl[0] + 2, R.nl[1] + 2);
  neckCurve(ctx, g, depth, false);
  ctx.closePath();
  ctx.fillStyle = lining; ctx.fill(); ctx.clip();
  const lg = ctx.createLinearGradient(0, 80, 0, 300); lg.addColorStop(0, 'rgba(0,0,0,0.35)'); lg.addColorStop(1, 'rgba(0,0,0,0.05)');
  ctx.fillStyle = lg; ctx.fillRect(300, 60, 424, 260);
  ctx.fillStyle = grainPattern(ctx); ctx.fillRect(300, 60, 424, 260);
  ctx.restore();
  // hood front rim (the folded edge) - band around the neckline
  const rim = k => neckOpen(k, g, depth);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();
  // clip to union of body so band doesn't escape outside shoulders
  ctx.beginPath(); bodyPath(ctx, g, depth + 30); ctx.clip();
  soft(ctx, rim, { color: '#000', blur: 10, alpha: 0.5, width: 8, dy: 3 });
  ctx.strokeStyle = shade(o.body, 0.03); ctx.lineWidth = 36; ctx.lineCap = 'butt'; ctx.beginPath(); rim(ctx); ctx.stroke();
  ctx.setLineDash([]);
  const rg = ctx.createLinearGradient(0, 180, 0, 300); rg.addColorStop(0, 'rgba(255,255,255,0.12)'); rg.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.strokeStyle = rg; ctx.lineWidth = 34; ctx.beginPath(); rim(ctx); ctx.stroke();
  ctx.restore();
  ctx.save(); ctx.beginPath(); bodyPath(ctx, g, depth + 30); ctx.clip();
  seam(ctx, k => neckOpen(k, g, depth + 18), { color: '#000', alpha: 0.35 });
  seam(ctx, k => neckOpen(k, g, depth + 24), { color: '#000', alpha: 0.28, dash: true });
  seam(ctx, rim, { color: '#000', alpha: 0.25, w: 1.2 });
  ctx.restore();
  // eyelets + drawstrings
  const ex = [470, 554], ey = g.L.nl[1] + depth - 4;
  const cord = o.cord;
  const strands = [
    [[ex[0], ey + 8], [ex[0] - 6, ey + 70], [ex[0] + 4, ey + 130], [ex[0] - 2, ey + 190]],
    [[ex[1], ey + 8], [ex[1] + 6, ey + 56], [ex[1] - 2, ey + 106], [ex[1] + 3, ey + 150]],
  ];
  for (const st of strands) {
    const path = k => { k.moveTo(st[0][0], st[0][1]); k.bezierCurveTo(st[1][0], st[1][1], st[2][0], st[2][1], st[3][0], st[3][1]); };
    soft(ctx, path, { color: '#000', blur: 5, alpha: 0.5, width: 9, dx: 2, dy: 4 });
    ctx.save(); ctx.lineCap = 'round';
    ctx.strokeStyle = shade(cord, -0.18); ctx.lineWidth = 9; ctx.beginPath(); path(ctx); ctx.stroke();
    ctx.strokeStyle = cord; ctx.lineWidth = 6.5; ctx.beginPath(); path(ctx); ctx.stroke();
    ctx.setLineDash([2, 3]); ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 6.5; ctx.beginPath(); path(ctx); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.translate(-1.5, 0); path(ctx); ctx.stroke(); ctx.translate(1.5, 0);
    // aglet
    const e = st[3]; ctx.fillStyle = '#2a2420'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(e[0] - 4, e[1] - 2, 8, 20, 3) : ctx.rect(e[0] - 4, e[1] - 2, 8, 20); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(e[0] - 2.5, e[1], 1.6, 16);
    ctx.restore();
  }
  for (const x of ex) {
    ctx.save();
    ctx.fillStyle = '#c9c3b6'; ctx.beginPath(); ctx.arc(x, ey, 8, 0, 7); ctx.fill();
    ctx.fillStyle = '#26211c'; ctx.beginPath(); ctx.arc(x, ey, 4.4, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, ey, 8, 0.6, 2.4); ctx.stroke();
    ctx.restore();
  }
}
function hoodieFrontDetails(ctx, g, o) {
  // kangaroo pocket
  const pk = k => {
    k.moveTo(430, 628); k.lineTo(594, 628); k.quadraticCurveTo(620, 700, 640, 790); k.lineTo(384, 790); k.quadraticCurveTo(404, 700, 430, 628); k.closePath();
  };
  soft(ctx, pk, { color: '#000', blur: 12, alpha: 0.42, fill: true, dy: 6 });
  ctx.save();
  ctx.beginPath(); pk(ctx); ctx.fillStyle = shade(o.body, -0.01); ctx.fill(); ctx.clip();
  const pg = ctx.createLinearGradient(0, 628, 0, 790); pg.addColorStop(0, 'rgba(0,0,0,0.16)'); pg.addColorStop(0.25, 'rgba(255,255,255,0.08)'); pg.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = pg; ctx.fillRect(360, 600, 300, 220);
  soft(ctx, k => { k.moveTo(440, 640); k.quadraticCurveTo(420, 720, 400, 780); }, { color: '#000', blur: 8, alpha: 0.12, width: 14 });
  ctx.fillStyle = grainPattern(ctx); ctx.fillRect(360, 600, 300, 220);
  ctx.restore();
  // pocket openings (slanted)
  for (const sgn of [-1, 1]) {
    const x0 = sgn < 0 ? 430 : 594, x1 = sgn < 0 ? 410 : 614;
    ctx.save(); ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x0, 632); ctx.lineTo(x1 - sgn * 0, 690); ctx.stroke();
    ctx.restore();
  }
  seam(ctx, pk, { color: '#000', alpha: 0.42, w: 1.4 });
  seam(ctx, k => { k.moveTo(437, 640); k.lineTo(587, 640); k.moveTo(437, 652); k.lineTo(587, 652); }, { color: '#000', alpha: 0.28, dash: true, w: 1.1 });
  seam(ctx, k => { k.moveTo(430, 636); k.lineTo(594, 636); }, { color: '#fff', alpha: 0.25, w: 1 });
  // centre front slight fold
  soft(ctx, k => { k.moveTo(512, 380); k.lineTo(512, 620); }, { color: '#000', blur: 18, alpha: 0.05, width: 22 });
}

/* ------------------------------------------------------------------ SIDE */
function drawSide(ctx, kind, o) {
  const hoodie = kind === 'hoodie', long = kind === 'longSleeve' || hoodie, polo = kind === 'polo';
  const body = o.body;
  const tw = hoodie ? 26 : 0;
  // torso (as seen from the side, slightly tilted flat-lay)
  const torso = k => {
    k.moveTo(468, 204);
    k.bezierCurveTo(470, 190, 540, 188, 566, 208);
    k.bezierCurveTo(588, 228, 592 + tw * 0.3, 300, 596 + tw * 0.4, 460);
    k.bezierCurveTo(600 + tw * 0.5, 620, 604 + tw * 0.5, 760, 606 + tw * 0.5, 872 + (hoodie ? 0 : 6));
    k.quadraticCurveTo(512, 888 + 14, 420 - tw * 0.5, 874);
    k.bezierCurveTo(414 - tw * 0.4, 760, 410 - tw * 0.3, 620, 424 - tw * 0.2, 470);
    k.bezierCurveTo(436, 360, 450, 280, 468, 204);
    k.closePath();
  };
  if (hoodie) {
    const hood = k => {
      k.moveTo(440, 250); k.bezierCurveTo(380, 170, 410, 70, 500, 62); k.bezierCurveTo(560, 58, 590, 120, 574, 214); k.lineTo(520, 250); k.closePath();
    };
    panel(ctx, hood, shade(body, -0.05), c => {
      seam(c, k => { k.moveTo(458, 232); k.bezierCurveTo(414, 160, 432, 100, 496, 90); }, { color: '#000', alpha: 0.28, dash: true });
      const rg = c.createRadialGradient(480, 110, 10, 480, 150, 160); rg.addColorStop(0, 'rgba(255,255,255,0.14)'); rg.addColorStop(1, 'rgba(0,0,0,0.14)'); c.fillStyle = rg; c.fillRect(350, 40, 260, 230);
    });
  }
  panel(ctx, torso, body, c => {
    const g1 = c.createLinearGradient(410, 0, 610, 0); g1.addColorStop(0, 'rgba(0,0,0,0.20)'); g1.addColorStop(0.3, 'rgba(255,255,255,0.08)'); g1.addColorStop(0.6, 'rgba(255,255,255,0)'); g1.addColorStop(1, 'rgba(0,0,0,0.22)');
    c.fillStyle = g1; c.fillRect(380, 150, 260, 780);
    // gentle side folds
    soft(c, k => { k.moveTo(500, 420); k.quadraticCurveTo(520, 560, 500, 740); }, { color: '#000', blur: 14, alpha: 0.10, width: 18 });
    soft(c, k => { k.moveTo(520, 430); k.quadraticCurveTo(540, 560, 520, 740); }, { color: '#fff', blur: 12, alpha: 0.18, width: 12 });
    // side seam
    seam(c, k => { k.moveTo(470, 360); k.bezierCurveTo(472, 560, 476, 720, 478, 880); }, { color: '#000', alpha: 0.28 });
    seam(c, k => { k.moveTo(476, 360); k.bezierCurveTo(478, 560, 482, 720, 484, 880); }, { color: '#000', alpha: 0.2, dash: true });
    // hem
    if (hoodie) {
      ribBlock(c, 380, 826, 280, 70, o.trim, 'y');
      seam(c, k => { k.moveTo(380, 826); k.lineTo(660, 826); }, { color: '#000', alpha: 0.35 });
    } else {
      seam(c, k => { k.moveTo(410, 856); k.lineTo(620, 858); }, { color: '#000', alpha: 0.3, dash: true });
      seam(c, k => { k.moveTo(410, 849); k.lineTo(620, 851); }, { color: '#000', alpha: 0.3, dash: true });
    }
    if (hoodie) {
      // pocket edge visible at the front
      soft(c, k => { k.moveTo(560, 628); k.quadraticCurveTo(596, 700, 604, 790); }, { color: '#000', blur: 8, alpha: 0.25, width: 6 });
    }
  });
  // collar (side view: a wedge at neck)
  if (!hoodie) {
    ctx.save();
    const collarFn = k => { k.moveTo(462, 206); k.bezierCurveTo(480, 176, 548, 176, 566, 210); k.lineTo(548, 232); k.bezierCurveTo(528, 208, 494, 208, 478, 234); k.closePath(); };
    ctx.beginPath(); collarFn(ctx); ctx.fillStyle = o.collar; ctx.fill(); ctx.clip();
    ctx.setLineDash([2, 3.4]); ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 40; ctx.beginPath(); ctx.moveTo(470, 214); ctx.bezierCurveTo(490, 190, 540, 190, 560, 216); ctx.stroke(); ctx.setLineDash([]);
    const cg = ctx.createLinearGradient(0, 176, 0, 236); cg.addColorStop(0, 'rgba(255,255,255,0.18)'); cg.addColorStop(1, 'rgba(0,0,0,0.25)'); ctx.fillStyle = cg; ctx.fillRect(450, 170, 130, 80);
    ctx.restore();
    seam(ctx, k => { k.moveTo(462, 206); k.bezierCurveTo(480, 176, 548, 176, 566, 210); k.lineTo(548, 232); k.bezierCurveTo(528, 208, 494, 208, 478, 234); k.closePath(); }, { color: '#000', alpha: 0.4 });
  }
  // sleeve lying across the torso, angled forward/down
  const dir = long ? norm([0.42, 0.9]) : norm([0.66, 0.75]);
  const perp = [-dir[1], dir[0]];
  const B = [522, 300];
  const len = long ? 500 : 190;
  const base = 74, hwC = long ? 40 : 52;
  const C = add(B, dir, len);
  const pA = add(B, perp, base), pB = add(B, perp, -base);
  const cA = add(C, perp, hwC), cB = add(C, perp, -hwC);
  const sleeve = k => {
    k.moveTo(pB[0], pB[1]);
    k.quadraticCurveTo((pB[0] + cB[0]) / 2 + 6, (pB[1] + cB[1]) / 2 - 6, cB[0], cB[1]);
    k.lineTo(cA[0], cA[1]);
    k.quadraticCurveTo((pA[0] + cA[0]) / 2 - 6, (pA[1] + cA[1]) / 2 + 4, pA[0], pA[1]);
    k.quadraticCurveTo(B[0] - dir[0] * 34 - perp[0] * 2, B[1] - dir[1] * 34, pB[0], pB[1]);
    k.closePath();
  };
  soft(ctx, sleeve, { color: '#000', blur: 14, alpha: 0.45, fill: true, dx: -8, dy: 8 });
  const ribLen = long ? 52 : 40; const ang = Math.atan2(dir[1], dir[0]);
  panel(ctx, sleeve, body, c => {
    c.save(); c.translate(C[0], C[1]); c.rotate(ang);
    const half = 150;
    const cg = c.createLinearGradient(0, -base, 0, base);
    cg.addColorStop(0, 'rgba(255,255,255,0.12)'); cg.addColorStop(0.5, 'rgba(0,0,0,0)'); cg.addColorStop(1, 'rgba(0,0,0,0.20)');
    c.fillStyle = cg; c.fillRect(-len - 60, -half, len + 70, half * 2);
    const r = rng(9);
    for (let i = 0; i < 4; i++) {
      const yy = (r() - 0.5) * base * 1.2; const x0 = -len * (0.35 + r() * 0.5);
      soft(c, k => { k.moveTo(x0, yy); k.quadraticCurveTo(x0 / 2, yy + 10 * (r() - .5), -ribLen - 8, yy * 0.8); }, { color: '#000', blur: 7, alpha: 0.13, width: 9 });
      soft(c, k => { k.moveTo(x0, yy + 11); k.quadraticCurveTo(x0 / 2, yy + 12, -ribLen - 8, yy * 0.8 + 11); }, { color: '#fff', blur: 7, alpha: 0.16, width: 7 });
    }
    if (o.stripe) {
      let x = -(o.cuffs === 'rib' ? ribLen : 34) - o.stripe.gap;
      for (let i = 0; i < o.stripe.count; i++) {
        const sw = o.stripe.w * (i === 0 ? 1 : 0.78);
        c.fillStyle = o.stripe.color; c.fillRect(x - sw, -half, sw, half * 2);
        const sg = c.createLinearGradient(0, -base, 0, base); sg.addColorStop(0, 'rgba(255,255,255,0.12)'); sg.addColorStop(1, 'rgba(0,0,0,0.22)'); c.fillStyle = sg; c.fillRect(x - sw, -half, sw, half * 2);
        c.fillStyle = 'rgba(255,255,255,0.12)'; for (let yy = -half; yy < half; yy += 3) c.fillRect(x - sw, yy, sw, 0.8);
        x -= sw + o.stripe.gap;
      }
    }
    if (o.cuffs === 'rib') {
      ribBlock(c, -ribLen, -half, ribLen + 4, half * 2, o.trim, 'x');
      seam(c, k => { k.moveTo(-ribLen, -half); k.lineTo(-ribLen, half); }, { color: '#000', alpha: 0.35 });
    } else {
      c.fillStyle = 'rgba(0,0,0,0.07)'; c.fillRect(-32, -half, 36, half * 2);
      seam(c, k => { k.moveTo(-30, -half); k.lineTo(-30, half); }, { color: '#000', alpha: 0.3, dash: true });
      seam(c, k => { k.moveTo(-24, -half); k.lineTo(-24, half); }, { color: '#000', alpha: 0.3, dash: true });
    }
    soft(c, k => { k.moveTo(0, -half); k.lineTo(0, half); }, { color: '#000', blur: 8, alpha: 0.28, width: 4, dx: 2 });
    c.restore();
    // shoulder seam + armhole stitching at the sleeve top
    seam(c, k => { k.moveTo(pB[0], pB[1]); k.quadraticCurveTo(B[0] - dir[0] * 34, B[1] - dir[1] * 34, pA[0], pA[1]); }, { color: '#000', alpha: 0.35 });
  });
  if (polo) {
    // side placket hint: small collar flap and buttons on far edge
    ctx.save(); ctx.fillStyle = shade(o.collar, 0.05);
    ctx.beginPath(); ctx.moveTo(556, 196); ctx.quadraticCurveTo(586, 220, 584, 262); ctx.lineTo(560, 246); ctx.closePath(); ctx.fill();
    ctx.restore();
    seam(ctx, k => { k.moveTo(556, 196); k.quadraticCurveTo(586, 220, 584, 262); k.lineTo(560, 246); k.closePath(); }, { color: '#000', alpha: 0.4 });
  }
}

/* ------------------------------------------------------------------ public */
function parseStripe(s, count) {
  if (!s) return null;
  if (s === true) return { color: SAMPLE_DEFAULTS.stripe, count: count, w: 15, gap: 11 };
  if (typeof s === 'string') return { color: s, count, w: 15, gap: 11 };
  return { color: s.color || SAMPLE_DEFAULTS.stripe, count: s.count ?? count, w: s.width ?? 15, gap: s.gap ?? 11 };
}

/**
 * sampleGarment(kind, view, {color, stripe, trim, cuffs}) -> 1024x1024 canvas (transparent bg)
 *  - called without options => showpiece (cream body, brown sleeve stripes + ribbed brown collar/cuffs)
 *  - stripe: false|undefined => none; true|'#hex'|{color,count,width,gap}
 *  - trim: ribbing/collar colour (defaults to the stripe colour, else a tone of the body colour)
 *  - cuffs: 'rib' | 'hem' (default: rib for longSleeve/hoodie/polo, rib when a stripe is set on a tee, else hem)
 */
export function sampleGarment(kind = 'tee', view = 'front', opts) {
  if (!DEF[kind]) kind = 'tee';
  if (!SAMPLE_VIEWS.includes(view)) view = 'front';
  const showpiece = opts == null;
  const body = (opts && opts.color) || SAMPLE_DEFAULTS.color;
  const long = kind === 'longSleeve' || kind === 'hoodie';
  let stripeSrc = showpiece ? SAMPLE_DEFAULTS.stripe : opts.stripe;
  const stripe = parseStripe(stripeSrc, long ? 3 : 2);
  const trimDefault = stripe ? stripe.color : shade(body, lum(body) > 0.5 ? -0.07 : 0.07);
  const trim = (opts && opts.trim) || trimDefault;
  const cuffs = (opts && opts.cuffs) || (long || kind === 'polo' || stripe ? 'rib' : 'hem');
  const collar = (opts && opts.collar) || (kind === 'polo' && !stripe ? shade(body, -0.04) : trim);
  const cord = lum(body) > 0.5 ? '#e9e2cf' : '#d8d2c2';
  const o = { body, stripe, trim, cuffs, collar, cord };

  const c = mk(); const ctx = c.getContext('2d');
  Z = 1;
  ctx.save();
  if (view === 'detail') {
    Z = 2.3;
    const fy = kind === 'hoodie' ? 250 : 270;
    ctx.translate(512, 520); ctx.scale(Z, Z); ctx.translate(-512, -fy);
    drawFrontBack(ctx, kind, 'front', o);
  } else if (view === 'side') {
    drawSide(ctx, kind, o);
  } else {
    drawFrontBack(ctx, kind, view, o);
  }
  ctx.restore();
  Z = 1;
  return c;
}
