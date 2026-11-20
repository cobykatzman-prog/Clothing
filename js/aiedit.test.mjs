// Unit tests for the preservation compositor and the keep-phrase parsing (node js/aiedit.test.mjs).
// aiedit.js imports state.js, which builds a canvas at load time: a minimal document stub is enough in Node.
import assert from 'node:assert/strict';

globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
const { compositeThroughMask, clampFeather, depthInside, DEFAULT_FEATHER } = await import('./composite.js');
const { regionsFrom, keepPhrasesRegions } = await import('./aiedit.js');

let n = 0, failures = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok -', name); } catch (e) { failures++; process.exitCode = 1; console.error('FAIL -', name, '\n', e.message); } };

// deterministic pseudo-random RGBA image
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const image = (w, h, f = () => [0, 0, 0, 255]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
};
const noisy = (w, h) => image(w, h, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255]);
const alphaOfRect = (w, h, x0, y0, x1, y1) => { const a = new Uint8Array(w * h); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 255; return a; };
const pixelAt = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const W = 60, H = 50;
const orig = noisy(W, H);
const edit = image(W, H, (x, y) => { const p = pixelAt(orig, x, y); return [255 - p[0], 255 - p[1], 255 - p[2], p[3]]; });   // every pixel changed
const sel = alphaOfRect(W, H, 15, 12, 45, 38);                                                                                 // 30 x 26 selection

t('alpha 0 pixels are copied byte-for-byte from the original (even when the edit differs everywhere)', () => {
  for (const feather of [0, 2, 8]) {
    const out = compositeThroughMask(orig, edit, sel, { feather });
    for (let i = 0; i < W * H; i++) if (sel[i] === 0) assert.ok(sameBytes(out.data.slice(i * 4, i * 4 + 4), orig.data.slice(i * 4, i * 4 + 4)), `pixel ${i} changed at feather ${feather}`);
  }
});

t('deep inside the selection (further than the feather band) the edited pixel is taken exactly', () => {
  const out = compositeThroughMask(orig, edit, sel, { feather: 2 });
  assert.deepEqual(pixelAt(out, 30, 25), pixelAt(edit, 30, 25));
  assert.deepEqual(pixelAt(out, 20, 20), pixelAt(edit, 20, 20));
});

t('the changed band never leaves the selection, and is no wider than the feather', () => {
  for (const feather of [0, 1, 2, 4, 8]) {
    const out = compositeThroughMask(orig, edit, sel, { feather });
    let outside = 0;
    const d = depthInside(sel, W, H);
    for (let i = 0; i < W * H; i++) {
      const changed = !sameBytes(out.data.slice(i * 4, i * 4 + 4), orig.data.slice(i * 4, i * 4 + 4));
      if (!changed) continue;
      if (sel[i] === 0) outside++;

    }
    assert.equal(outside, 0, `changed pixels outside the mask at feather ${feather}`);
    // every partly-blended pixel is inside the band (within `feather` px of the edge; the edge pixel is depth 1)
    for (let i = 0; i < W * H; i++) {
      if (sel[i] === 0) continue;
      const k = i * 4;
      const blended = [0, 1, 2, 3].some(c => out.data[k + c] !== orig.data[k + c] && out.data[k + c] !== edit.data[k + c]);
      if (blended) assert.ok(d[i] < feather + 1e-6, `blended pixel at depth ${d[i]} with feather ${feather}`);
    }
  }
});

t('feather 2: pixels on the selection edge blend, pixels two or more px inside take the edit', () => {
  const out = compositeThroughMask(orig, edit, sel, { feather: 2 });
  const edgeX = 15, innerX = 17;                    // the selection starts at x=15
  const y = 25;
  assert.notDeepEqual(pixelAt(out, edgeX, y), pixelAt(edit, edgeX, y), 'edge pixel should be a blend, not the raw edit');
  assert.notDeepEqual(pixelAt(out, edgeX, y), pixelAt(orig, edgeX, y), 'edge pixel should differ from the original');
  assert.deepEqual(pixelAt(out, innerX, y), pixelAt(edit, innerX, y));
});

t('feather 0 is a hard edge: alpha 255 = edit, alpha 0 = original', () => {
  const out = compositeThroughMask(orig, edit, sel, { feather: 0 });
  for (let i = 0; i < W * H; i++) {
    const want = sel[i] ? edit.data.slice(i * 4, i * 4 + 4) : orig.data.slice(i * 4, i * 4 + 4);
    assert.ok(sameBytes(out.data.slice(i * 4, i * 4 + 4), want), `pixel ${i}`);
  }
});

t('partial mask alpha blends linearly even with a hard feather', () => {
  const half = new Uint8Array(W * H).fill(128);
  const flat = image(W, H, () => [0, 0, 0, 255]), white = image(W, H, () => [200, 200, 200, 255]);
  const out = compositeThroughMask(flat, white, half, { feather: 0 });
  assert.equal(out.data[0], Math.round(200 * 128 / 255));
});

t('feather is clamped to 0-8 and defaults to 2', () => {
  assert.equal(clampFeather(99), 8);
  assert.equal(clampFeather(-3), 0);
  assert.equal(clampFeather('x'), DEFAULT_FEATHER);
  assert.equal(clampFeather(2.4), 2);
  assert.equal(DEFAULT_FEATHER, 2);
});

t('inputs are never modified', () => {
  const o2 = noisy(W, H), e2 = image(W, H, () => [9, 9, 9, 255]), before = [o2.data.slice(), e2.data.slice(), sel.slice()];
  compositeThroughMask(o2, e2, sel, { feather: 3 });
  assert.ok(sameBytes(o2.data, before[0]) && sameBytes(e2.data, before[1]) && sameBytes(sel, before[2]));
});

t('mask may be ImageData-like (alpha channel) as well as an alpha plane', () => {
  const md = image(W, H, (x, y) => [0, 0, 0, sel[y * W + x]]);
  const a = compositeThroughMask(orig, edit, sel, { feather: 2 }), b = compositeThroughMask(orig, edit, md, { feather: 2 });
  assert.ok(sameBytes(a.data, b.data));
});

t('mismatched sizes are rejected', () => {
  assert.throws(() => compositeThroughMask(orig, image(W + 1, H, () => [0, 0, 0, 255]), sel), /same size/);
  assert.throws(() => compositeThroughMask(orig, edit, new Uint8Array(10)), /mask/);
});

t('depthInside: distance from selected pixels to the nearest unselected pixel', () => {
  const a = alphaOfRect(20, 20, 5, 5, 15, 15);
  const d = depthInside(a, 20, 20);
  assert.equal(d[5 * 20 + 5], 1);       // corner-ish edge pixel
  assert.equal(d[6 * 20 + 6], 2);
  assert.equal(d[10 * 20 + 10], 5);     // centre of the 10x10 square
  assert.equal(d[0], 0);                // unselected stays 0
});

t('a 1024 x 1024 composite runs well inside the interactive budget', () => {
  const S = 1024, big = noisy(S, S), be = image(S, S, () => [1, 2, 3, 255]), bm = alphaOfRect(S, S, 100, 100, 900, 900);
  const t0 = Date.now(); compositeThroughMask(big, be, bm, { feather: 2 }); const ms = Date.now() - t0;
  assert.ok(ms < 1500, `took ${ms} ms`);
});

t('regionsFrom maps phrases to segmentation region names', () => {
  assert.deepEqual(regionsFrom(['collar']), ['collar']);
  assert.deepEqual(regionsFrom(['the collar']), ['collar', 'neckline']);
  assert.deepEqual(regionsFrom(['both sleeves']), ['leftSleeve', 'rightSleeve']);
  assert.deepEqual(regionsFrom(['leftSleeve', 'nonsense']), ['leftSleeve']);
  assert.deepEqual(regionsFrom(['the brown stripes', 'cuffs']), ['stripes', 'cuffs']);
});

t('keepPhrasesRegions reads "keep ... unchanged" clauses and stops at the next clause', () => {
  assert.deepEqual(keepPhrasesRegions('keep the collar unchanged'), ['collar', 'neckline']);
  assert.deepEqual(keepPhrasesRegions('Keep the collar unchanged but make the sleeves flared'), ['collar', 'neckline']);
  assert.deepEqual(keepPhrasesRegions('make these slightly flared but do not add cuffs'), []);
  assert.deepEqual(keepPhrasesRegions('change the sleeves without changing the chest logo'), ['logos']);
  assert.deepEqual(keepPhrasesRegions('keep everything else unchanged'), []);
});

console.log(`\naiedit: ${n} passed, ${failures} failed`);
if (failures) process.exit(1);
