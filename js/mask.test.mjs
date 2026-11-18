// Mask engine tests: plain Node, synthetic ImageData, no DOM.  Run: node js/mask.test.mjs
import * as M from './mask.js';

let pass = 0, fail = 0;
const t0 = Date.now();
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + msg); } }
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b} +- ${tol})`); }
const section = s => console.log('- ' + s);
const SZ = 1024;
const timings = {};
function timed(name, budget, fn) {
  fn();                                            // warm-up (JIT)
  let r, ms = Infinity;
  for (let k = 0; k < 3; k++) { const t = performance.now(); r = fn(); ms = Math.min(ms, performance.now() - t); }   // best of 3: robust against CI noise
  timings[name] = Math.round(ms);
  ok(ms <= budget, `${name} took ${ms.toFixed(0)} ms (budget ${budget})`);
  return r;
}
function timedCold(name, budget, fn) {            // first call including cache fill
  const t = performance.now(); const r = fn(); const ms = performance.now() - t;
  timings[name + ' (cold)'] = Math.round(ms);
  ok(ms <= budget, `${name} cold took ${ms.toFixed(0)} ms (budget ${budget})`);
  return r;
}

// ---- synthetic helpers
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 0.7071; };
function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), o = (y * w + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c[3] == null ? 255 : c[3]; }
  return { data, width: w, height: h };
}
const noisy = (c, s) => [c[0] + gauss() * s, c[1] + gauss() * s, c[2] + gauss() * s];
const CREAM = [239, 230, 210], BROWN = [90, 58, 34], GOLD = [201, 162, 74], BLUE = [40, 80, 170];
const sum = m => { let s = 0; for (let i = 0; i < m.length; i++) m[i] > 0 && (s += m[i]); return s; };
const disc = (cx, cy, r, w = SZ, h = SZ) => { const m = M.emptyMask(w, h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); const v = r + 0.5 - d; m[y * w + x] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255; } return m; };
const rectMask = (x0, y0, x1, y1, w = SZ, h = SZ) => M.fromRect({ x: x0, y: y0 }, { x: x1, y: y1 }, { width: w, height: h });
const equal = (a, b, tol = 0) => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) return false; return true; };
const maxDiff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };

/* ------------------------------------------------------------------ shapes */
section('shapes: rect / polygon / lasso areas');
{
  const r = M.fromRect([100.3, 200.7], [400.2, 500.9]); near(M.area(r), (400.2 - 100.3) * (500.9 - 200.7), 2, 'rect sub-pixel area');
  near(M.area(M.fromRect({ x: 50, y: 60 }, { x: 10, y: 20 })), 40 * 40, 0.01, 'rect corners in any order');
  ok(M.isEmpty(M.fromRect([5, 5], [5, 5])), 'zero-size rect is empty');
  const tri = M.fromPolygon([{ x: 100, y: 100 }, { x: 500, y: 150 }, { x: 250, y: 600 }]);
  const triA = Math.abs((400 * 500 - 150 * 50)) / 2; near(M.area(tri) / triA, 1, 0.005, 'triangle area within 0.5%');
  const N = 200, circ = []; for (let i = 0; i < N; i++) circ.push({ x: 512 + 300 * Math.cos(i * 2 * Math.PI / N), y: 512 + 300 * Math.sin(i * 2 * Math.PI / N) });
  const trueA = 0.5 * N * 300 * 300 * Math.sin(2 * Math.PI / N); near(M.area(M.fromLasso(circ)) / trueA, 1, 0.005, 'lasso circle area within 0.5%');
  // winding: self-intersecting bow-tie fills both lobes; star (pentagram) fills centre under non-zero
  const star = []; for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 4 * Math.PI / 5; star.push([512 + 300 * Math.cos(a), 512 + 300 * Math.sin(a)]); }
  const sm = M.fromPolygon(star); ok(sm[512 * SZ + 512] === 255, 'pentagram centre filled (non-zero winding)');
  const bow = M.fromPolygon([[100, 100], [200, 200], [200, 100], [100, 200]]); near(M.area(bow), 5000, 5, 'bow-tie (self-intersecting) fills both lobes');
  const cw = M.fromPolygon([[300, 300], [400, 300], [400, 400], [300, 400]]), ccw = M.fromPolygon([[300, 300], [300, 400], [400, 400], [400, 300]]); ok(equal(cw, ccw), 'winding direction does not matter');
  ok(M.isEmpty(M.fromPolygon([{ x: 1, y: 1 }, { x: 9, y: 9 }])), 'degenerate polygon is empty');
  const off = M.fromPolygon([{ x: -100, y: -100 }, { x: 300, y: -100 }, { x: 300, y: 300 }, { x: -100, y: 300 }]); near(M.area(off), 300 * 300, 0.5, 'polygon clipped to the canvas');
  const gar = rectMask(0, 0, 200, 1024); ok(M.bounds(M.fromRect([0, 0], [500, 500], { garment: gar })).w === 200, 'garment option clips shape');
  const nonsq = M.fromRect([0, 0], [50, 10], { width: 80, height: 20 }); ok(nonsq.length === 1600 && M.dimsOf(nonsq)[0] === 80, 'non-square dims');
}

section('brush: no gaps, size accuracy, pressure, hardness');
{
  const stroke = []; for (let i = 0; i <= 3; i++) stroke.push({ x: 100 + i * 300, y: 200 + (i % 2) * 400 });   // 3 huge jumps = "fast stroke"
  const b = M.fromBrushStroke(stroke, 40, 1);
  // no gaps: the centre line of every segment is fully selected
  let gaps = 0; for (let i = 0; i < 3; i++) for (let t = 0; t <= 1; t += 0.005) { const x = stroke[i].x + (stroke[i + 1].x - stroke[i].x) * t, y = stroke[i].y + (stroke[i + 1].y - stroke[i].y) * t; if (b[Math.floor(y) * SZ + Math.floor(x)] < 250) gaps++; }
  ok(gaps === 0, `fast stroke has no gaps (${gaps})`);
  const len = 3 * Math.hypot(300, 400) ; const expectA = len * 40 + Math.PI * 20 * 20;   // capsule path area (joins overlap a little)
  near(M.area(b) / expectA, 1, 0.03, 'stroke area ~ length*size + caps');
  const dot = M.fromBrushStroke([{ x: 512, y: 512 }], 60, 1); near(M.area(dot) / (Math.PI * 900), 1, 0.01, 'single stamp is a disc of the right size');
  const bb = M.bounds(dot, 128); ok(bb.w === 60 && bb.h === 60, `dot bounds 60x60 (${bb.w}x${bb.h})`);
  const sub = M.fromBrushStroke([[300.37, 400.81]], 30.5, 1); near(M.area(sub) / (Math.PI * 15.25 * 15.25), 1, 0.01, 'sub-pixel coords + size area');
  const cx = (() => { let sx = 0, s = 0; for (let y = 380; y < 420; y++) for (let x = 280; x < 320; x++) { sx += (x + 0.5) * sub[y * SZ + x]; s += sub[y * SZ + x]; } return sx / s; })(); near(cx, 300.37, 0.05, 'sub-pixel centroid x');
  const soft = M.fromBrushStroke([{ x: 512, y: 512 }], 100, 0); ok(soft[512 * SZ + 512] >= 250 && soft[512 * SZ + 512 + 25] > 20 && soft[512 * SZ + 512 + 25] < 235 && soft[512 * SZ + 512 + 49] < 20, 'hardness 0 falls off smoothly');
  const half = M.fromBrushStroke([{ x: 512, y: 512 }], 100, 0.5); ok(half[512 * SZ + 512 + 20] === 255 && half[512 * SZ + 512 + 45] > 0 && half[512 * SZ + 512 + 45] < 255, 'hardness 0.5 has a solid core and soft rim');
  const pr = M.fromBrushStroke([{ x: 100, y: 500, p: 0.2 }, { x: 900, y: 500, p: 1 }], 100, 1);
  ok(M.bounds(wrapCol(pr, 110)).h < 25 && M.bounds(wrapCol(pr, 890)).h > 90, 'pressure ramps the width along the stroke');
  const pr2 = M.fromBrushStroke([[100, 500], [900, 500]], 100, 1, 0.5); ok(M.bounds(pr2, 128).h === 50, 'constant pressure scales size');
  const dense = []; for (let i = 0; i < 4000; i++) dense.push({ x: 100 + i * 0.2, y: 500 + Math.sin(i / 100) * 50 }); ok(M.area(M.fromBrushStroke(dense, 20)) > 0, 'dense input handled');
  ok(M.isEmpty(M.fromBrushStroke([], 20)), 'empty stroke');
  const e = M.fromBrushStroke([[-50, -50], [20, 20]], 30); ok(!M.isEmpty(e), 'stroke partly off-canvas');
}
function wrapCol(m, x) { const c = M.emptyMask(1, SZ); for (let y = 0; y < SZ; y++) c[y] = m[y * SZ + x]; return c; }

/* ------------------------------------------------------------------ algebra */
section('combine algebra / invert');
{
  const a = M.feather(M.fromPolygon([[100, 100], [600, 120], [500, 700], [150, 600]]), 12), b = M.feather(disc(400, 400, 220), 9), c = M.fromBrushStroke([[50, 50], [900, 800]], 80, 0.4);
  const O = (x, y, m) => M.combine(x, y, m);
  ok(equal(O(a, b, 'add'), O(b, a, 'add')), 'add commutative'); ok(equal(O(a, b, 'intersect'), O(b, a, 'intersect')), 'intersect commutative');
  ok(equal(O(O(a, b, 'add'), c, 'add'), O(a, O(b, c, 'add'), 'add')), 'add associative');
  ok(equal(O(a, a, 'add'), a) && equal(O(a, a, 'intersect'), a), 'idempotent');
  ok(M.isEmpty(O(a, a, 'subtract')), 'a - a is empty (soft edges too)');
  const s = O(a, b, 'subtract'), i = O(a, b, 'intersect'), sumv = new Uint8Array(a.length); for (let k = 0; k < a.length; k++) sumv[k] = s[k] + i[k];
  ok(equal(sumv, a), 'subtract + intersect partition a exactly');
  ok(equal(O(a, b, 'replace'), b), 'replace returns b');
  ok(equal(O(a, M.emptyMask(), 'add'), a) && M.isEmpty(O(a, M.emptyMask(), 'intersect')), 'empty is the identity for add / absorbing for intersect');
  ok(equal(M.invert(M.invert(a)), a), 'invert twice = identity');
  const g = M.fromPolygon([[0, 0], [1000, 50], [900, 1000], [30, 950]]), inside = O(a, g, 'intersect');
  ok(equal(M.invert(M.invert(inside, g), g), inside), 'garment-restricted invert twice = identity (mask inside garment)');
  ok(equal(M.invert(inside, g), O(g, inside, 'subtract')), 'garment invert = garment minus mask');
  const inv = M.invert(a, g); let leak = 0; for (let k = 0; k < inv.length; k++) if (inv[k] > g[k]) leak++; ok(leak === 0, 'garment invert never leaves the garment');
  let bad = 0; try { M.combine(a, b, 'xor'); } catch { bad = 1; } ok(bad === 1, 'unknown mode throws');
  ok(M.bounds(M.fromRect([10, 20], [30, 60])).w === 20 && M.bounds(M.emptyMask()).w === 0, 'bounds'); ok(M.isEmpty(M.emptyMask()) && !M.isEmpty(a), 'isEmpty');
}

/* ------------------------------------------------------------------ feather / expand / contract / smooth */
section('feather: symmetric, monotonic, gaussian');
{
  const half = rectMask(0, 0, 512, 1024), f = M.feather(half, 20), row = y => f[y * SZ + 512 - 1];
  const prof = []; for (let x = 440; x < 584; x++) prof.push(f[300 * SZ + x]);
  let mono = true; for (let i = 1; i < prof.length; i++) if (prof[i] > prof[i - 1]) mono = false; ok(mono, 'feather profile monotonic non-increasing across the edge');
  let sym = 0; for (let d = 0; d < 40; d++) sym = Math.max(sym, Math.abs(f[300 * SZ + 511 - d] + f[300 * SZ + 512 + d] - 255)); ok(sym <= 2, `feather symmetric about the edge (max asym ${sym})`);
  ok(f[300 * SZ + 512 - 40] === 255 && f[300 * SZ + 512 + 40] === 0, 'feather reaches 0/255 away from the edge');
  const mid = f[300 * SZ + 511]; ok(mid > 128 && mid < 200 && f[300 * SZ + 512] < 128 && f[300 * SZ + 512] > 55, 'edge sits at ~50%');
  let distinct = new Set(prof).size; ok(distinct > 12, `feather is a real ramp, not a threshold (${distinct} levels)`);
  const small = M.feather(disc(300, 300, 50), 1.5); ok(small[300 * SZ + 300] === 255 && M.area(small) > 0, 'small feather ok');
  near(M.area(M.feather(disc(512, 512, 200), 30)) / M.area(disc(512, 512, 200)), 1, 0.01, 'feather preserves area (mass)');
  ok(equal(M.feather(half, 0), half), 'feather 0 is a copy');
  const fg = M.feather(half, 20, rectMask(0, 0, 500, 1024)); ok(fg[300 * SZ + 505] === 0 && fg[300 * SZ + 495] > 0, 'feather clips to garment');
  const big = M.feather(rectMask(300, 300, 700, 700), 60); ok(big[500 * SZ + 500] === 255 && big[500 * SZ + 300] > 100 && big[500 * SZ + 300] < 160, 'large (box-approx) feather ok');
}
section('EDT vs brute force');
{
  for (let trial = 0; trial < 6; trial++) {
    const w = 23 + trial * 5, h = 17 + trial * 3, m = M.emptyMask(w, h), pts = [];
    for (let i = 0; i < 4 + trial * 2; i++) { const x = (rnd() * w) | 0, y = (rnd() * h) | 0; m[y * w + x] = 255; pts.push([x, y]); }
    const d2 = M.edt2(m, w, h); let bad = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let best = Infinity; for (const [px, py] of pts) best = Math.min(best, (x - px) ** 2 + (y - py) ** 2); if (d2[y * w + x] !== best) bad++; }
    ok(bad === 0, `edt2 exact (trial ${trial}, ${bad} wrong)`);
  }
  const w = 40, h = 40, none = M.emptyMask(w, h); ok(M.edt2(none, w, h)[0] >= 1e9, 'edt2 without seeds = INF');
}
section('expand / contract / smooth');
{
  const d = disc(512, 512, 100), e = M.expand(d, 20), c = M.contract(d, 20);
  near(M.area(e) / (Math.PI * 120 * 120), 1, 0.01, 'expand circle r100 by 20 -> r120 (EDT keeps it round)');
  near(M.area(c) / (Math.PI * 80 * 80), 1, 0.01, 'contract circle r100 by 20 -> r80');
  const eh = M.expand(disc(512, 512, 100), 0.5); near(M.area(eh) / (Math.PI * 100.5 * 100.5), 1, 0.01, 'sub-pixel expand 0.5');
  const r = rectMask(300, 300, 700, 600), er = M.expand(r, 10);   // a square dilated by a disc has ROUNDED corners
  near(M.area(er), 400 * 300 + 2 * 10 * (400 + 300) + Math.PI * 100, 150, 'rect expand has rounded corners (Euclidean), area = A + P*r + pi*r^2');
  ok(er[291 * SZ + 291] < 128 && er[295 * SZ + 295] > 128, 'corner of expanded rect is rounded (diagonal pixel not selected)');
  const round = M.contract(M.expand(r, 15), 15); ok(maxDiff(round, r) <= 255 && M.area(round) > M.area(r) * 0.995 && M.area(round) < M.area(r) * 1.005, 'expand then contract returns near original (area)');
  let wrong = 0; for (let k = 0; k < r.length; k++) if (Math.abs(round[k] - r[k]) > 128) wrong++; ok(wrong < 10, `expand-then-contract differs on ${wrong} px`);
  const sm = M.contract(M.expand(d, 7.5), 7.5); near(M.area(sm) / M.area(d), 1, 0.005, 'sub-pixel round trip on a disc');
  ok(equal(M.expand(d, 0), d) && equal(M.contract(d, 0), d), 'zero amounts are copies');
  const full = M.invert(M.emptyMask()); ok(equal(M.contract(full, 30), full), 'contract does not erode from the image border');
  ok(M.isEmpty(M.expand(M.emptyMask(), 20)), 'expanding nothing stays empty');
  ok(M.isEmpty(M.contract(disc(100, 100, 10), 15)), 'contract past the shape = empty');
  const clipped = M.expand(d, 50, disc(512, 512, 110)); ok(M.area(clipped) < M.area(disc(512, 512, 110)) * 1.01, 'expand clips to garment');
  // smooth: jagged boundary becomes smooth, specks vanish, area preserved
  const jag = rectMask(200, 200, 800, 800); for (let y = 200; y < 800; y += 2) for (let x = 190; x < 200; x++) if ((x + y) % 3 === 0) jag[y * SZ + x] = 255; jag[500 * SZ + 100] = 255; jag[501 * SZ + 100] = 255;
  const sj = M.smooth(jag, 4); ok(sj[500 * SZ + 100] === 0, 'smooth removes specks'); near(M.area(sj) / M.area(rectMask(200, 200, 800, 800)), 1, 0.03, 'smooth keeps overall area');
  const c0 = M.perimeter(M.outline(jag, { simplify: 0 })), c1 = M.perimeter(M.outline(sj, { simplify: 0 })); ok(c1 < c0 * 0.9, 'smooth shortens the jagged outline');
  const sq = M.smooth(rectMask(300, 300, 700, 700), 10); ok(sq[300 * SZ + 300] < 128 && sq[500 * SZ + 500] === 255, 'smooth rounds sharp corners');
}

/* ------------------------------------------------------------------ colour / wand */
section('wand / colour select');
{
  // cream ground, brown band, two blue squares (one touching nothing) + noise
  const img = image(SZ, SZ, (x, y) => {
    if (y >= 400 && y < 460) return noisy(BROWN, 2);
    if (x >= 100 && x < 200 && y >= 100 && y < 200) return noisy(BLUE, 2);
    if (x >= 700 && x < 800 && y >= 700 && y < 800) return noisy(BLUE, 2);
    return noisy(CREAM, 2);
  });
  const w1 = M.magicWand(img, 150, 150, 20, true); near(M.area(w1), 100 * 100, 40, 'contiguous wand selects exactly the clicked square');
  ok(w1[750 * SZ + 750] === 0, 'contiguous wand does not jump to the other square');
  const w2 = M.magicWand(img, 150, 150, 20, false); near(M.area(w2), 2 * 100 * 100, 80, 'non-contiguous wand selects both squares');
  const cr = M.magicWand(img, 500, 100, 20, true); near(M.area(cr), 400 * SZ - 1e4, 300, 'wand on cream selects the connected cream above the band');
  ok(cr[500 * SZ + 500] === 0, 'wand does not cross the brown band (contiguous)');
  const crAll = M.magicWand(img, 500, 100, 20, false); ok(crAll[500 * SZ + 500] === 255, 'non-contiguous wand reaches the cream below the band');
  let prev = -1, monotone = true; for (const tol of [2, 8, 16, 30, 50, 70, 100]) { const a = M.area(M.magicWand(img, 500, 100, tol, true)); if (a < prev) monotone = false; prev = a; }
  ok(monotone, 'wand area monotonic in tolerance'); ok(M.area(M.magicWand(img, 500, 100, 100, true)) > M.area(M.magicWand(img, 500, 100, 8, true)), 'high tolerance selects more');
  let sub = true; { const lo = M.magicWand(img, 500, 100, 10, true), hi = M.magicWand(img, 500, 100, 40, true); for (let i = 0; i < lo.length; i++) if (lo[i] > hi[i]) sub = false; } ok(sub, 'wand mask at low tolerance is a subset of high tolerance');
  ok(M.isEmpty(M.magicWand(img, -5, 10, 20)), 'wand outside the image is empty');
  const gar = rectMask(0, 0, 1024, 300); const wg = M.magicWand(img, 500, 100, 20, true, { garment: gar }); ok(M.bounds(wg).h === 300, 'wand respects the garment mask');
  const sel = M.selectByColor(img, BROWN, 12); near(M.area(sel), 60 * SZ, 60, 'selectByColor picks exactly the brown band'); ok(M.bounds(sel).y === 400 && M.bounds(sel).h === 60, 'colour select bounds');
  const sel2 = M.selectByColor(img, '#2850aa', 15); near(M.area(sel2), 2e4, 80, 'selectByColor non-contiguous: both blue squares (hex input)');
  ok(M.isEmpty(M.selectByColor(img, [0, 255, 0], 15)), 'colour absent from the image = empty');
  const rs = M.selectByColor(img, CREAM, 15, rectMask(0, 0, 1024, 100)); ok(M.bounds(rs).h === 100, 'selectByColor restrictTo');
  const tr = image(64, 64, (x, y) => (x < 32 ? [200, 20, 20, 255] : [200, 20, 20, 0])); near(M.area(M.selectByColor(tr, [200, 20, 20], 10)), 32 * 64, 1, 'transparent pixels are never selected');
  // anti-aliased edge: gradient between brown and cream gets partial coverage
  const edgeImg = image(100, 20, x => { const t = Math.min(1, Math.max(0, (x - 30) / 40)); return [BROWN[0] + (CREAM[0] - BROWN[0]) * t, BROWN[1] + (CREAM[1] - BROWN[1]) * t, BROWN[2] + (CREAM[2] - BROWN[2]) * t]; });
  const es = M.selectByColor(edgeImg, BROWN, 10); let part = 0; for (let x = 30; x < 70; x++) { const v = es[10 * 100 + x]; if (v > 0 && v < 255) part++; } ok(part >= 1, 'anti-aliased colour edge yields partial coverage');
  const fresh = image(SZ, SZ, (x, y) => noisy(y >= 400 && y < 460 ? BROWN : CREAM, 2));
  timedCold('selectByColor (first call on a new image)', 250, () => M.selectByColor(fresh, BROWN, 12));
  timed('selectByColor', 200, () => M.selectByColor(img, BROWN, 12));
  timed('magicWand contiguous', 200, () => M.magicWand(img, 500, 100, 20, true));
  timed('magicWand non-contiguous', 200, () => M.magicWand(img, 500, 100, 20, false));
}

/* ------------------------------------------------------------------ texture */
section('texture select');
{
  // left: flat cream with grain; right: ribbed (vertical ribs period 5) of the SAME mean colour; bottom-left band: diagonal twill
  const img = image(SZ, SZ, (x, y) => {
    let base = 0;
    if (x >= 512) base = 24 * Math.sin(x * 2 * Math.PI / 5);                           // ribbed
    else if (y >= 700) base = 24 * Math.sin((x + y) * 2 * Math.PI / 5);                // diagonal twill
    return noisy([CREAM[0] + base, CREAM[1] + base, CREAM[2] + base], 1.5);
  });
  const rib = M.selectByTexture(img, 800, 300, 30), flat = M.selectByTexture(img, 200, 300, 30), twill = M.selectByTexture(img, 200, 900, 30);
  const frac = (m, x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += m[y * SZ + x] >= 128; n++; } return s / n; };
  ok(frac(rib, 540, 20, 1000, 1000) > 0.97, `ribbed click selects the ribbed region (${frac(rib, 540, 20, 1000, 1000).toFixed(3)})`);
  ok(frac(rib, 20, 20, 480, 650) < 0.02 && frac(rib, 20, 730, 480, 1000) < 0.05, 'ribbed click leaves flat and twill alone');
  ok(frac(flat, 20, 20, 480, 650) > 0.97 && frac(flat, 540, 20, 1000, 1000) < 0.02 && frac(flat, 20, 730, 480, 1000) < 0.05, 'flat click selects only the flat cloth');
  ok(frac(twill, 30, 740, 470, 1000) > 0.95 && frac(twill, 20, 20, 480, 650) < 0.02 && frac(twill, 540, 20, 1000, 1000) < 0.05, 'twill (diagonal) separated from the vertical rib of equal strength');
  ok(M.area(M.selectByTexture(img, 800, 300, 80)) >= M.area(rib), 'texture tolerance monotonic (area grows)');
  ok(M.area(M.selectByTexture(img, 800, 300, 30, { contiguous: true, garment: rectMask(0, 0, 1024, 500) })) < M.area(rib), 'garment + contiguous options');
  const tri = image(64, 64, (x) => (x < 32 ? [10, 10, 10, 255] : [10, 10, 10, 0])); ok(M.isEmpty(M.selectByTexture(tri, 50, 10, 30)), 'texture click on background = empty');
  timedCold('texture (features)', 400, () => M.selectByTexture(img, 800, 300, 30));
  timed('selectByTexture', 200, () => M.selectByTexture(img, 800, 300, 30));
}

/* ------------------------------------------------------------------ smart select / component */
section('smartSelect / selectComponent');
{
  // a "shirt": cream garment, two brown stripes, a brown crest with a gold letter, text-like blobs; transparent background around
  const gm = (x, y) => x > 100 && x < 924 && y > 100 && y < 924;
  const stripe1 = (x, y) => x >= 200 && x < 230 && y >= 150 && y < 700, stripe2 = (x, y) => x >= 250 && x < 280 && y >= 150 && y < 700;
  const crest = (x, y) => x >= 600 && x < 700 && y >= 300 && y < 400, gold = (x, y) => x >= 630 && x < 670 && y >= 320 && y < 360;
  const L1 = (x, y) => x >= 400 && x < 440 && y >= 700 && y < 760, L2 = (x, y) => x >= 460 && x < 500 && y >= 700 && y < 760;
  const img = image(SZ, SZ, (x, y) => {
    if (!gm(x, y)) return [0, 0, 0, 0];
    if (gold(x, y)) return noisy(GOLD, 2);
    if (stripe1(x, y) || stripe2(x, y) || crest(x, y) || L1(x, y) || L2(x, y)) return noisy(BROWN, 2);
    return noisy(CREAM, 2);
  });
  const gmask = M.emptyMask(); for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) if (gm(x, y)) gmask[y * SZ + x] = 255;
  const seg = { mask: gmask, regions: {}, w: SZ, h: SZ };
  const st = M.smartSelect(img, seg, 215, 400); let b = M.bounds(st, 128);
  ok(Math.abs(b.x - 200) <= 1 && Math.abs(b.w - 30) <= 2 && Math.abs(b.y - 150) <= 1 && Math.abs(b.h - 550) <= 2, `smartSelect isolates ONE stripe (bounds ${JSON.stringify(b)})`);
  ok(st[400 * SZ + 265] === 0, 'second stripe not selected'); near(M.area(st), 30 * 550, 60, 'stripe area');
  const cr = M.smartSelect(img, seg, 610, 310); b = M.bounds(cr, 128);
  ok(Math.abs(b.x - 600) <= 1 && Math.abs(b.w - 100) <= 2 && Math.abs(b.h - 100) <= 2, `smartSelect on the crest returns the whole crest incl. its letter hole (${JSON.stringify(b)})`);
  ok(cr[340 * SZ + 650] >= 250, 'enclosed gold letter is filled into the crest'); near(M.area(cr), 1e4, 80, 'crest area');
  const lt = M.smartSelect(img, seg, 420, 730); b = M.bounds(lt, 128); ok(b.w === 40 && b.h === 60 && lt[730 * SZ + 480] === 0, `smartSelect on a letter = that letter only (${JSON.stringify(b)})`);
  const gd = M.smartSelect(img, seg, 650, 340); b = M.bounds(gd, 128); ok(Math.abs(b.w - 40) <= 2 && Math.abs(b.h - 40) <= 2, `smartSelect on the gold letter = the letter (${JSON.stringify(b)})`);
  const body = M.smartSelect(img, seg, 800, 800); ok(body[800 * SZ + 800] === 255 && body[400 * SZ + 215] === 0, 'body click selects cream, not the stripes'); ok(M.area(body) > 0.6 * M.area(gmask), 'body click selects the large cream area');
  ok(M.isEmpty(M.smartSelect(img, seg, 20, 20)), 'click on background = empty');
  const hi = M.smartSelect(img, seg, 215, 400, { sensitivity: 1 }), lo = M.smartSelect(img, seg, 215, 400, { sensitivity: 0 }); ok(M.area(hi) >= M.area(lo) - 1, 'sensitivity monotonic');
  const edgeClick = M.smartSelect(img, seg, 200, 400); ok(M.area(edgeClick) > 30 * 500, 'click on the stripe edge still picks the stripe');
  // seg regions as limit: click on cream inside a "sleeve" region only returns that region
  const reg = M.emptyMask(); for (let y = 100; y < 924; y++) for (let x = 100; x < 500; x++) if (gm(x, y)) reg[y * SZ + x] = 255;
  const seg2 = { mask: gmask, regions: { body: reg }, w: SZ, h: SZ }; const rb = M.smartSelect(img, seg2, 350, 500); ok(rb[500 * SZ + 700] === 0 && rb[500 * SZ + 350] === 255, 'smartSelect on base fabric stays inside the segmentation region');
  // components
  const seg3 = { mask: gmask, regions: { stripes: M.selectByColor(img, BROWN, 15, gmask), body: reg }, w: SZ, h: SZ };
  const blob = M.selectComponent(seg3, img, 215, 400, { mode: 'blob' }); b = M.bounds(blob, 128); ok(Math.abs(b.w - 30) <= 1 && blob[400 * SZ + 265] === 0, 'selectComponent blob = ONE stripe');
  const regm = M.selectComponent(seg3, 215, 400); ok(regm[400 * SZ + 265] === 255 && regm[730 * SZ + 480] === 255, 'selectComponent region mode returns the whole region (all stripes) [(seg,x,y) signature]');
  const gar = M.selectComponent(seg3, img, 500, 500, { mode: 'garment' }); near(M.area(gar), M.area(gmask), 2, 'garment mode = whole silhouette');
  const sim = M.selectComponent({ mask: gmask, regions: {}, w: SZ, h: SZ }, img, 800, 800, { mode: 'similar' }); ok(sim[800 * SZ + 800] === 255 && sim[400 * SZ + 215] === 0, 'similar mode without regions = connected similar material');
  ok(M.isEmpty(M.selectComponent(seg3, img, 20, 20, { mode: 'garment' })), 'component off garment = empty');
  const fr = M.fromRegions(seg3, ['stripes', 'body']); ok(M.area(fr) > M.area(reg), 'fromRegions unions several regions'); ok(M.isEmpty(M.fromRegions(seg3, 'nothing')), 'fromRegions unknown name = empty');
  ok(M.regionNameAt(seg3, 215, 400) === 'stripes' && M.regionNameAt(seg3, 350, 500) === 'body' && M.regionNameAt(seg3, 20, 20) === null, 'regionNameAt priority');
  // noisy photo-like input: robust
  const fresh = image(SZ, SZ, (x, y) => (gm(x, y) ? noisy(stripe1(x, y) ? BROWN : CREAM, 2) : [0, 0, 0, 0]));
  timedCold('smartSelect (first click on a new image: Lab + gradient)', 450, () => M.smartSelect(fresh, seg, 215, 400));
  timed('smartSelect (stripe)', 300, () => M.smartSelect(img, seg, 215, 400));
  timed('smartSelect (crest)', 300, () => M.smartSelect(img, seg, 610, 310));
  timed('smartSelect (body, large)', 300, () => M.smartSelect(img, seg, 800, 800));
}

/* ------------------------------------------------------------------ refine edge */
section('refineEdge');
{
  const EDGE = 400.3;                               // true edge (vertical), anti-aliased, noise sigma 3
  const img = image(SZ, SZ, x => { const t = Math.min(1, Math.max(0, x + 0.5 - EDGE + 0.5)); const c = CREAM.map((v, k) => BROWN[k] + (v - BROWN[k]) * (1 - 0)); const a = (1 - t); return noisy(BROWN.map((v, k) => v * (1 - t) + CREAM[k] * t), 3); });
  // selected = the brown side (x < EDGE)
  const edgeAt = (m, y) => { let s = 0; for (let x = 300; x < 500; x++) s += m[y * SZ + x]; return 300 + s / 255; };
  for (const off of [3, -3, 2.5]) {
    const m = rectMask(0, 0, 400 + off, 1024), r = M.refineEdge(m, img, { radius: 5, strength: 1 });
    let worst = 0; for (let y = 50; y < 970; y += 20) worst = Math.max(worst, Math.abs(edgeAt(r, y) - EDGE)); near(worst, 0, 0.8, `refineEdge snaps an edge that is off by ${off}px to the image edge`);
    const rowErr = Math.abs(edgeAt(m, 500) - EDGE); ok(rowErr > 2, `(before refine error was ${rowErr.toFixed(1)}px)`);
  }
  // does not leak: a second edge 9px away from the mask boundary must not be crossed (radius 4)
  const img2 = image(SZ, SZ, x => (x < 400 ? noisy(BROWN, 3) : x < 410 ? noisy(CREAM, 3) : noisy(BROWN, 3)));
  const m2 = rectMask(0, 0, 403, 1024), r2 = M.refineEdge(m2, img2, { radius: 4 });
  let leakMax = 0; for (let y = 0; y < SZ; y++) for (let x = 409; x < 1024; x++) leakMax = Math.max(leakMax, r2[y * SZ + x]); ok(leakMax === 0, `refineEdge never leaks beyond radius (max ${leakMax})`);
  let farChanged = 0; for (let y = 0; y < SZ; y++) for (let x = 0; x < 1024; x++) if (Math.abs(x - 403) > 6 && r2[y * SZ + x] !== m2[y * SZ + x]) farChanged++; ok(farChanged === 0, `pixels farther than the band are untouched (${farChanged})`);
  // identical colours in/out -> unchanged; strength 0 -> unchanged; strength blends
  const flat = image(SZ, SZ, () => noisy(CREAM, 2)), mm = rectMask(100, 100, 600, 600); ok(maxDiff(M.refineEdge(mm, flat, { radius: 4 }), mm) <= 1, 'no image edge -> mask edge kept');
  ok(equal(M.refineEdge(mm, img, { strength: 0 }), mm), 'strength 0 = unchanged'); ok(M.isEmpty(M.refineEdge(M.emptyMask(), img)), 'empty mask stays empty');
  const half = M.refineEdge(rectMask(0, 0, 403, 1024), img, { strength: 0.5 }), e0 = Math.abs(edgeAt(rectMask(0, 0, 403, 1024), 500) - EDGE), eh = Math.abs(edgeAt(half, 500) - EDGE); ok(eh < e0 && eh > 0.3, 'strength 0.5 moves part of the way');
  // a disc mask (round) vs a hard circular image shape, mask 4px too large and noisy colours
  const circleImg = image(SZ, SZ, (x, y) => { const d = Math.hypot(x + 0.5 - 512, y + 0.5 - 512), t = Math.min(1, Math.max(0, d - 150 + 0.5)); return noisy(BROWN.map((v, k) => v * (1 - t) + CREAM[k] * t), 3); });
  const big = disc(512, 512, 154), rc = M.refineEdge(big, circleImg, { radius: 6 });
  near(M.area(rc) / (Math.PI * 150 * 150), 1, 0.012, 'refineEdge shrinks an over-large round mask to the real circle');
  const fth = M.refineEdge(M.feather(disc(512, 512, 146), 4), circleImg, { radius: 6 }); near(M.area(fth) / (Math.PI * 150 * 150), 1, 0.015, 'refineEdge grows an under-sized feathered mask to the real circle');
  timedCold('refineEdge (cold, full-frame mask)', 700, () => M.refineEdge(rectMask(5, 5, 1019, 1019), img, { radius: 6 }));
  timed('refineEdge (full-frame mask)', 400, () => M.refineEdge(rectMask(5, 5, 1019, 1019), img, { radius: 6 }));
  timed('refineEdge (typical 400x400 selection)', 400, () => M.refineEdge(disc(512, 512, 200), circleImg, { radius: 6 }));
}

/* ------------------------------------------------------------------ outline */
section('outline');
{
  const r = rectMask(100, 100, 300, 200), o = M.outline(r); ok(o.length === 1 && o[0].closed && !o[0].hole, 'rect = one closed outer contour');
  near(M.perimeter(o), 600, 1.5, 'rect perimeter (marching squares chamfers hard corners: -0.29px each)'); near(o[0].area, 200 * 100, 0.5, 'rect contour area'); ok(o[0].points.length <= 8, `rect simplifies to its corners (${o[0].points.length} pts)`);
  const c = disc(512, 512, 150), oc = M.outline(c); near(M.perimeter(oc) / (2 * Math.PI * 150), 1, 0.01, 'circle perimeter within 1%'); near(oc[0].area / (Math.PI * 150 * 150), 1, 0.01, 'circle contour area');
  let rMin = 1e9, rMax = 0; for (const p of oc[0].points) { const d = Math.hypot(p.x - 512, p.y - 512); rMin = Math.min(rMin, d); rMax = Math.max(rMax, d); } ok(rMax - rMin < 0.6, `contour hugs the circle at sub-pixel accuracy (${(rMax - rMin).toFixed(2)})`);
  const ring = M.combine(disc(512, 512, 200), disc(512, 512, 100), 'subtract'), orr = M.outline(ring); ok(orr.length === 2 && orr.filter(k => k.hole).length === 1, 'ring = outer + hole contour');
  near(M.perimeter(orr) / (2 * Math.PI * 300), 1, 0.01, 'ring perimeter = both circles');
  const two = M.combine(rectMask(10, 10, 50, 50), rectMask(100, 100, 150, 140), 'add'); ok(M.outline(two).length === 2, 'two blobs = two contours');
  const diag = M.emptyMask(); diag[10 * SZ + 10] = 255; diag[11 * SZ + 11] = 255; ok(M.outline(diag).length >= 1, 'diagonal pixels (saddle) handled');
  const touch = rectMask(0, 0, 100, 100); const ot = M.outline(touch); near(M.perimeter(ot), 400, 1.5, 'shape touching the image border is closed along the border');
  ok(M.outline(M.emptyMask()).length === 0, 'empty mask = no contours');
  for (const ct of M.outline(ring)) { const P = ct.points; ok(P.length > 8 && Math.hypot(P[0].x - P[P.length - 1].x, P[0].y - P[P.length - 1].y) < 40, 'closed loop (implicit closing segment is short)'); }
  const aa = M.fromRect([100.25, 100.25], [300.75, 200.5]), oa = M.outline(aa, { simplify: 0 }); const xs = oa[0].points.map(p => p.x), ys = oa[0].points.map(p => p.y);
  near(Math.min(...xs), 100.25, 0.2, 'sub-pixel contour x (anti-aliased edge)'); near(Math.max(...ys), 200.5, 0.2, 'sub-pixel contour y');
  const brush = M.fromBrushStroke([[100, 100], [800, 700]], 40, 0.6), ob = M.outline(brush); ok(ob.length >= 1 && ob[0].area > 0, 'soft brush outline');
  timed('outline (circle r300)', 150, () => M.outline(disc(512, 512, 300)));
  const many = M.emptyMask(); for (let i = 0; i < 60; i++) { const d = disc(60 + rnd() * 900, 60 + rnd() * 900, 8 + rnd() * 30); for (let k = 0; k < many.length; k++) if (d[k] > many[k]) many[k] = d[k]; }
  timed('outline (60 blobs)', 150, () => M.outline(many));
}

/* ------------------------------------------------------------------ dilateToGarment / misc */
section('dilateToGarment, canvases, timing');
{
  const g = M.fromPolygon([[100, 100], [900, 100], [900, 900], [100, 900]]), sel = rectMask(104, 300, 600, 600);   // 4px short of the garment's left edge
  const d = M.dilateToGarment(sel, g, 5); ok(d[400 * SZ + 100] === 255 && d[400 * SZ + 101] === 255, 'sliver between selection and garment edge is closed');
  ok(d[400 * SZ + 99] === 0, 'never selects outside the garment'); ok(d[400 * SZ + 700] === 0 && d[250 * SZ + 300] === 0, 'does not grow into the garment interior');
  const far = rectMask(150, 300, 600, 600); ok(equal(M.dilateToGarment(far, g, 5), far), 'selection far from the edge is unchanged');
  ok(equal(M.copy(far), far) && M.copy(far) !== far, 'copy'); ok(M.threshold(M.feather(far, 6)).length === far.length, 'threshold');
  ok(M.planeOf({ data: new Uint8ClampedArray([0, 0, 0, 7, 0, 0, 0, 9]), width: 2, height: 1 })[1] === 9, 'planeOf(ImageData-like) reads alpha');
  ok(M.tint(M.fromRect([0, 0], [1, 1], { width: 2, height: 2 }), [1, 2, 3], 1)[3] === 255, 'tint');
  const f = M.feather(M.expand(M.smooth(disc(512, 512, 250), 3), 5), 10);
  const a = disc(300, 400, 280), b = disc(700, 600, 300), mp = M.fromPolygon([[0, 0], [1000, 100], [500, 1000]]);
  timed('combine', 150, () => M.combine(a, b, 'add'));
  timed('invert', 150, () => M.invert(a, mp));
  timed('feather(40)', 150, () => M.feather(a, 40));
  timed('feather(6)', 150, () => M.feather(a, 6));
  timed('expand(25)', 150, () => M.expand(a, 25));
  timed('contract(25)', 150, () => M.contract(a, 25));
  timed('smooth(8)', 150, () => M.smooth(a, 8));
  timed('fromPolygon (200 pts, large)', 150, () => M.fromPolygon(Array.from({ length: 200 }, (_, i) => ({ x: 512 + 450 * Math.cos(i * 0.0314), y: 512 + 450 * Math.sin(i * 0.0314) }))));
  timed('fromBrushStroke (long, size 120)', 150, () => M.fromBrushStroke(Array.from({ length: 600 }, (_, i) => ({ x: 60 + i * 1.5, y: 500 + Math.sin(i / 40) * 200 })), 120, 0.5));
  timed('dilateToGarment', 200, () => M.dilateToGarment(a, mp, 4));
  ok(f.length === SZ * SZ, 'pipeline smoke');
}

console.log(`\nmask engine: ${pass} passed, ${fail} failed in ${Date.now() - t0} ms`);
console.log('timings (ms @1024x1024): ' + JSON.stringify(timings));
if (fail) process.exit(1);
