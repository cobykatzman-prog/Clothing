// Phase 3b browser tests: instruction semantics (avoid / lock / keep), lift-to-layer repair, back-to-front matching.
// Run: node test/phase3b.browser.test.cjs   (starts `python3 -m http.server 8123` itself if the port is free)
// Writes before/after PNGs to $OUT (default: the session scratchpad) so the repair can be looked at.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const OUT = process.env.OUT || '/tmp/claude-0/-home-user-Clothing/89298eb2-7696-52de-9189-1aa44322c92a/scratchpad/p3b';
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('python3', ['-m', 'http.server', '8123'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 900));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => { fail++; console.log('  PAGE ERROR: ' + e.message); });
    await page.route('**/__p3b.html', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>p3b</title><body></body>' }));
    await page.goto('http://localhost:8123/__p3b.html');

    /* ---------------- variations: avoid / lock / keep ---------------- */
    const v = await page.evaluate(async () => {
      const S = await import('/js/segment.js'), C = await import('/js/samples-club.js'), V = await import('/js/variations.js');
      const P = await import('/js/prompt.js'), M = await import('/js/measure.js');
      const { front } = C.clubEliteViews();
      const seg = await S.segmentGarment(front);
      const cal = M.makeCalibration(seg);
      const base = M.measureGarment(seg, cal);
      const A = front.getContext('2d').getImageData(0, 0, 1024, 1024).data;
      const px = (c) => c.getContext('2d').getImageData(0, 0, 1024, 1024).data;
      const regionMask = (name) => { const a = seg.regions[name]; const d = a.getContext('2d').getImageData(0, 0, 1024, 1024).data; const m = new Uint8Array(1024 * 1024); for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0; return m; };
      const diffIn = (B, m) => { let c = 0; for (let i = 0; i < m.length; i++) if (m[i]) { const q = i * 4; if (A[q] !== B[q] || A[q + 1] !== B[q + 1] || A[q + 2] !== B[q + 2] || A[q + 3] !== B[q + 3]) c++; } return c; };
      const out = {};

      // (a) flare the sleeves, no cuffs: sleeve opening grows, no ribbed cuff, body pixels untouched
      const opsA = P.parsePrompt("Make the sleeves slightly flared but don't add cuffs");
      const va = await V.localVariations(front, seg, null, opsA);
      const bold = va.find(r => r.label === 'Bold');
      const segB = bold.seg;
      const mA = M.measureGarment(segB, cal);
      out.sleeveOpen = [base.sleeveOpening, mA.sleeveOpening];
      out.sleeveAlpha = [regionMask('leftSleeve').reduce((s, v) => s + v, 0)];
      const bodyM = regionMask('body'), sleeveM = new Uint8Array(1024 * 1024);
      { const l = regionMask('leftSleeve'), r = regionMask('rightSleeve'); for (let i = 0; i < sleeveM.length; i++) sleeveM[i] = l[i] | r[i]; }
      // body pixels that are at least 12 px away from any sleeve pixel
      const far = new Uint8Array(1024 * 1024);
      for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) { const i = y * 1024 + x; if (!bodyM[i]) continue; let near = false; for (let dy = -12; dy <= 12 && !near; dy += 3) for (let dx = -12; dx <= 12 && !near; dx += 3) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < 1024 && yy < 1024 && sleeveM[yy * 1024 + xx]) near = true; } if (!near) far[i] = 1; }
      out.bodyFarPx = far.reduce((s, v) => s + v, 0);
      out.bodyFarChangedBold = diffIn(px(bold.canvas), far);
      out.preset = opsA.sleevePreset; out.avoid = opsA.avoid; out.removeCuffs = opsA.removeCuffs;

      // (b) boxy without changing the length: hem line stays put, the chest grows
      const opsB = P.parsePrompt('Make the body more boxy without changing the length');
      const vb = await V.localVariations(front, seg, null, opsB);
      // hem = the lowest row of the BODY region (sleeve cuffs hang lower and are judged separately)
      const bodyBottom = (sg) => { const d = sg.regions.body.getContext('2d').getImageData(0, 0, 1024, 1024).data; let y1 = -1; for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) if (d[(y * 1024 + x) * 4 + 3] > 128) y1 = y; return y1; };
      const bottomOf = bodyBottom;
      const boxyBold = vb.find(r => r.label === 'Bold');
      out.hemY = [bodyBottom(seg), bodyBottom(boxyBold.seg)];
      out.chest = [base.chest, M.measureGarment(boxyBold.seg, cal).chest];
      out.lock = opsB.lock; out.bodyLengthParam = opsB.paramDeltas.bodyLength;

      // (c) keep: stripes/collar kept byte-identical while the collar grows over them
      const opsC = { regions: ['collar'], keep: ['stripes'], paramDeltas: { collarSize: 30 }, avoid: [], lock: [] };
      const vc = await V.localVariations(front, seg, null, opsC);
      const stripeM = regionMask('stripes');
      out.keepStripeChanged = [diffIn(px(vc[0].canvas), stripeM), diffIn(px(vc[2].canvas), stripeM)];
      out.keepStripePx = stripeM.reduce((s, v) => s + v, 0);
      // (d) lock forces zero even when a preset asks for length
      const lk = await V.localVariations(front, seg, null, { paramDeltas: { bodyLength: 60 }, lock: ['bodyLength', 'cropLength'], regions: ['body'], avoid: [], keep: [] });
      out.lockedBodyLengthSame = bodyBottom(lk[2].seg) === bodyBottom(seg);
      // (e) unselected pixels stay byte-identical when there is no change at all
      const none = await V.localVariations(front, seg, null, { regions: [], keep: [], avoid: [], lock: [], paramDeltas: {} });
      out.noopChanged = diffIn(px(none[2].canvas), new Uint8Array(1024 * 1024).fill(1));
      return out;
    });
    console.log('variations:', JSON.stringify(v));
    ok(v.sleeveOpen[1] > v.sleeveOpen[0] * 1.03, `flared sleeves open wider (${v.sleeveOpen})`);
    ok(v.preset === 'slightFlare' && v.avoid.includes('cuffs') && v.removeCuffs === true, 'parse of (a) reaches variations');
    ok(v.bodyFarChangedBold === 0, `body pixels away from the sleeves stay identical (changed ${v.bodyFarChangedBold} of ${v.bodyFarPx})`);
    ok(Math.abs(v.hemY[0] - v.hemY[1]) <= 1, `boxy without length: hem y unchanged (${v.hemY})`);
    ok(v.chest[1] > v.chest[0] * 1.03, `boxy body is wider (${v.chest})`);
    ok(v.lock.includes('bodyLength') && v.bodyLengthParam === undefined, 'lock reaches the ops');
    ok(v.keepStripeChanged[0] === 0 && v.keepStripeChanged[1] === 0, `kept stripes stay identical (changed ${v.keepStripeChanged} of ${v.keepStripePx})`);
    ok(v.lockedBodyLengthSame, 'locked length stays put even when the parameters ask for more length');
    ok(v.noopChanged === 0, 'no-op variation leaves every pixel identical');

    /* ---------------- lift to layer ---------------- */
    const L = await page.evaluate(async () => {
      const S = await import('/js/segment.js'), C = await import('/js/samples-club.js'), LF = await import('/js/lift.js');
      const { front } = C.clubEliteViews();
      const seg = await S.segmentGarment(front);
      const art = C.CLUB_ELITE_ARTWORK.front[0].bbox;
      const mask = LF.autoSelectLogo(seg, front);
      if (!mask) return { none: true };
      const lift = LF.liftToLayer(front, mask, { name: 'Crest' });
      const org = lift.origin;
      const N = 1024, a = front.getContext('2d').getImageData(0, 0, N, N).data, b = lift.repaired.getContext('2d').getImageData(0, 0, N, N).data;
      const bx = lift.bbox;
      // ring: pixels 8-adjacent to the mask (the repair grows the shape by one pixel, so the ring is allowed to change)
      const near = new Uint8Array(N * N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (mask[y * N + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N) near[yy * N + xx] = 1; }
      let outsideChanged = 0;
      for (let i = 0; i < N * N; i++) if (!near[i]) { const q = i * 4; if (a[q] !== b[q] || a[q + 1] !== b[q + 1] || a[q + 2] !== b[q + 2] || a[q + 3] !== b[q + 3]) outsideChanged++; }
      // layer: opaque pixels equal the original crest pixels, transparent elsewhere
      const lw = lift.layerCanvas.width, lh = lift.layerCanvas.height, la = lift.layerCanvas.getContext('2d').getImageData(0, 0, lw, lh).data;
      let opaque = 0, opaqueBad = 0, anyAlpha = 0;
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
        const li = (y * lw + x) * 4, gx = org.x + x, gy = org.y + y;
        const gi = ((gy) * N + gx) * 4;
        if (la[li + 3] === 255) { opaque++; if (la[li] !== a[gi] || la[li + 1] !== a[gi + 1] || la[li + 2] !== a[gi + 2]) opaqueBad++; }
        if (la[li + 3] > 0) anyAlpha++;
      }
      // colour check inside the old box: brown and gold crest colours must be gone
      const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
      const brown = hex('#5a3a22'), gold = hex('#c9a24a'), cream = [0xef, 0xe6, 0xd2];
      const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      let crestLeft = 0, residual = 0, inBox = 0;
      for (let y = art.y * N | 0; y < (art.y + art.h) * N; y++) for (let x = art.x * N | 0; x < (art.x + art.w) * N; x++) {
        const q = (y * N + x) * 4; inBox++;
        const c = [b[q], b[q + 1], b[q + 2]];
        if (dist(c, brown) < 45 || dist(c, gold) < 45) crestLeft++;
        if (dist(c, cream) > 38) residual++;
      }
      // baseline: the same-size clean fabric box left of the crest
      const bw = Math.round(art.w * N), bh = Math.round(art.h * N), bx0 = Math.round(art.x * N) - 160, by0 = Math.round(art.y * N) + 60;
      let baseline = 0;
      for (let y = by0; y < by0 + bh; y++) for (let x = bx0; x < bx0 + bw; x++) { const q = (y * N + x) * 4; if (dist([a[q], a[q + 1], a[q + 2]], cream) > 38) baseline++; }
      // layer offset and visual outputs
      const png = (src, sx, sy, sw, sh, scale) => { const c = document.createElement('canvas'); c.width = sw * scale; c.height = sh * scale; const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(src, sx, sy, sw, sh, 0, 0, sw * scale, sh * scale); return c.toDataURL('image/png'); };
      const cx = Math.max(0, bx.x - 70), cy = Math.max(0, bx.y - 70), cw = Math.min(N - cx, bx.w + 140), ch = Math.min(N - cy, bx.h + 140);
      return {
        auto: { x: bx.x, y: bx.y, w: bx.w, h: bx.h }, want: art,
        outsideChanged, opaque, opaqueBad, anyAlpha, layerSize: [lw, lh],
        crestLeft, residual, baseline, inBox,
        before: png(front, cx, cy, cw, ch, 3), after: png(lift.repaired, cx, cy, cw, ch, 3), layer: lift.layerCanvas.toDataURL('image/png'),
        layerChecker: null
      };
    });
    if (L.none) { ok(false, 'autoSelectLogo found no chest logo'); }
    else {
      const N = 1024, want = { x: L.want.x * N, y: L.want.y * N, w: L.want.w * N, h: L.want.h * N };
      ok(Math.abs(L.auto.x - want.x) <= 3 && Math.abs(L.auto.y - want.y) <= 3 && Math.abs(L.auto.w - want.w) <= 4 && Math.abs(L.auto.h - want.h) <= 4,
        `auto-selected crest bbox ${JSON.stringify(L.auto)} matches the artwork ${JSON.stringify(want)}`);
      ok(L.opaque > 5000 && L.opaqueBad === 0, `layer opaque pixels equal the original crest (${L.opaque} opaque, ${L.opaqueBad} differ)`);
      ok(L.outsideChanged === 0, `pixels outside the lifted shape are byte-identical (changed ${L.outsideChanged})`);
      ok(L.crestLeft === 0, `no brown/gold crest colour left in the old box (${L.crestLeft} px)`);
      ok(L.residual <= 2 * L.baseline + 40, `repaired patch looks like fabric: ${L.residual} off-cream px vs ${L.baseline} on clean fabric of the same size`);
      console.log(`  lift: bbox ${JSON.stringify(L.auto)}, layer ${L.layerSize.join('x')}, residual ${L.residual}/${L.inBox} (fabric baseline ${L.baseline})`);
      const save = (n, u) => fs.writeFileSync(path.join(OUT, n), Buffer.from(u.split(',')[1], 'base64'));
      save('lift-before.png', L.before); save('lift-after.png', L.after); save('lift-layer.png', L.layer);
    }

    /* ---------------- match back to front ---------------- */
    const m = await page.evaluate(async () => {
      const S = await import('/js/segment.js'), C = await import('/js/samples-club.js'), W = await import('/js/warp.js');
      const MA = await import('/js/match.js'), M = await import('/js/measure.js');
      const { front, back } = C.clubEliteViews();
      const sf = await S.segmentGarment(front), sb = await S.segmentGarment(back);
      const cal = M.makeCalibration(sf);
      // change only the front body width, then match the back to it
      const f2 = await W.applyShape(front, sf, { bodyWidth: 30 });
      const mm = await MA.matchBackToFront({ frontSeg: f2.seg, backSeg: sb, backCanvas: back, frontParams: { bodyWidth: 30 }, backParams: {}, calib: cal });
      const b2 = await W.applyShape(back, sb, mm.target);
      const F = M.measureGarment(f2.seg, cal), B0 = M.measureGarment(sb, cal), B = M.measureGarment(b2.seg, cal);
      const pct = (a, b) => (a && b ? Math.abs(a - b) / b * 100 : null);
      return { keys: MA.shapeKeys(), deltas: mm.deltas, target: mm.target, unmatched: mm.unmatched, refined: mm.refined,
        front: { chest: F.chest, length: F.length, shoulder: F.shoulder, sleeve: F.sleeve, sleeveOpening: F.sleeveOpening },
        backBefore: { chest: B0.chest, length: B0.length, shoulder: B0.shoulder, sleeve: B0.sleeve, sleeveOpening: B0.sleeveOpening },
        backAfter: { chest: B.chest, length: B.length, shoulder: B.shoulder, sleeve: B.sleeve, sleeveOpening: B.sleeveOpening },
        err: { chest: pct(B.chest, F.chest), length: pct(B.length, F.length), shoulder: pct(B.shoulder, F.shoulder), sleeve: pct(B.sleeve, F.sleeve), sleeveOpening: pct(B.sleeveOpening, F.sleeveOpening) } };
    });
    console.log('match:', JSON.stringify({ deltas: m.deltas, refined: m.refined, unmatched: m.unmatched, err: m.err }));
    console.log('  front:', JSON.stringify(m.front)); console.log('  back before:', JSON.stringify(m.backBefore)); console.log('  back after:', JSON.stringify(m.backAfter));
    ok(m.keys.length === 11 && ['bodyWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength', 'sleeveWidth', 'sleeveFlare', 'sleeveShape', 'collarSize', 'neckOpening', 'hemShape', 'cropLength'].every(k => m.keys.includes(k)), 'shapeKeys lists the shared parameters');
    ok(m.err.chest !== null && m.err.chest <= 1.5, `back chest equals front chest within 1.5% (${m.err.chest && m.err.chest.toFixed(2)}%)`);
    ok(m.err.length !== null && m.err.length <= 1.5, `back body length equals front within 1.5% (${m.err.length && m.err.length.toFixed(2)}%)`);
    ok(m.err.shoulder !== null && m.err.shoulder <= 1.5, `back shoulder width equals front within 1.5% (${m.err.shoulder && m.err.shoulder.toFixed(2)}%)`);
    if (m.err.sleeve !== null) ok(m.err.sleeve <= 1.5, `back sleeve length equals front within 1.5% (${m.err.sleeve.toFixed(2)}%)`);
    if (m.err.sleeveOpening !== null) console.log(`  note: sleeve opening error ${m.err.sleeveOpening && m.err.sleeveOpening.toFixed(2)}% (informational)`);
  } catch (e) {
    fail++; console.log('  ERROR: ' + (e && e.stack || e));
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(`phase3b browser: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
