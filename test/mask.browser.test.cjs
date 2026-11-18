// Browser test of the mask engine on the Club Elite fixture.  Run: node test/mask.browser.test.cjs
// (starts `python3 -m http.server 8123` itself; writes overlay PNGs to $OUT or the scratchpad dir)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const OUT = process.env.OUT || '/tmp/claude-0/-home-user-Clothing/89298eb2-7696-52de-9189-1aa44322c92a/scratchpad';
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };
const within = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} +- ${tol})`);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('python3', ['-m', 'http.server', '8123'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 900));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => { fail++; console.log('  PAGE ERROR: ' + e.message); });
    await page.route('**/__mask.html', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>mask</title><body></body>' }));
    await page.goto('http://localhost:8123/__mask.html');
    const res = await page.evaluate(async () => {
      const M = await import('/js/mask.js'), S = await import('/js/segment.js'), C = await import('/js/samples-club.js');
      const { front } = C.clubEliteViews();
      const seg = await S.segmentGarment(front);
      const ctx = front.getContext('2d'), img = ctx.getImageData(0, 0, 1024, 1024), W = 1024;
      const A = C.CLUB_ELITE_ARTWORK, px = b => ({ x: b.x * W, y: b.y * W, w: b.w * W, h: b.h * W });
      const overlay = (mask, name, extra = []) => {
        const c = document.createElement('canvas'); c.width = c.height = W; const x = c.getContext('2d');
        x.fillStyle = '#7a7a7a'; x.fillRect(0, 0, W, W); x.drawImage(front, 0, 0);
        x.drawImage(M.toCanvas(mask, { color: [255, 40, 40] }), 0, 0); x.globalAlpha = 0.0; x.globalAlpha = 1;
        // dim = tint: redraw mask at 50% using a second pass
        const t = document.createElement('canvas'); t.width = t.height = W; const tc = t.getContext('2d'); tc.drawImage(front, 0, 0);
        x.drawImage(front, 0, 0);
        const m = M.toCanvas(mask, { color: [255, 30, 30] }); x.globalAlpha = 0.55; x.drawImage(m, 0, 0); x.globalAlpha = 1;
        x.strokeStyle = '#00e0ff'; x.lineWidth = 1.5;
        for (const ct of M.outline(mask)) { x.beginPath(); ct.points.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.closePath(); x.stroke(); }
        x.strokeStyle = '#00ff66'; x.lineWidth = 1; for (const b of extra) x.strokeRect(b.x, b.y, b.w, b.h);
        return { name, url: c.toDataURL('image/png') };
      };
      const shots = [], out = {};
      const t = () => performance.now();
      // 1. colour select: brown (stripes + crest)
      let t0 = t(); const brown = M.selectByColor(img, [90, 58, 34], 22); out.msColor = t() - t0;
      out.brownBounds = M.bounds(brown, 128); out.brownArea = M.area(brown);
      shots.push(overlay(brown, 'color-brown'));
      const crestBB = px(A.front[0].bbox);
      out.crestHit = brown[Math.round(crestBB.y + crestBB.h * 0.3) * W + Math.round(crestBB.x + crestBB.w * 0.15)];
      // find a brown pixel in the left sleeve stripes, and one in the right
      const pick = (x0, x1) => { let best = null; for (let y = 300; y < 800; y++) for (let x = x0; x < x1; x++) if (brown[y * W + x] > 250) { best = best || []; best.push([x, y]); } return best ? best[(best.length / 2) | 0] : null; };
      const pl = pick(60, 400), pr = pick(620, 960); out.pl = pl; out.pr = pr;
      // 2. smart select on a stripe
      t0 = t(); const stripe = M.smartSelect(img, seg, pl[0], pl[1]); out.msSmartStripe = t() - t0;
      out.stripeBounds = M.bounds(stripe, 128); out.stripeArea = M.area(stripe);
      shots.push(overlay(stripe, 'smart-stripe', [px(A.front[1].bbox)]));
      // 3. smart select on the crest (click on the brown shield, left of the monogram)
      const cc = [Math.round(crestBB.x + crestBB.w * 0.12), Math.round(crestBB.y + crestBB.h * 0.35)];
      t0 = t(); const crest = M.smartSelect(img, seg, cc[0], cc[1]); out.msSmartCrest = t() - t0;
      out.crestBounds = M.bounds(crest, 128); out.crestArea = M.area(crest); out.crestBB = crestBB;
      shots.push(overlay(crest, 'smart-crest', [crestBB]));
      // 4. magic wand on the cream body
      t0 = t(); const wand = M.magicWand(img, 512, 650, 20, true); out.msWand = t() - t0;
      out.wandBounds = M.bounds(wand, 128); out.wandArea = M.area(wand); out.garmentArea = M.area(seg.mask ? M.fromCanvas(seg.mask) : M.emptyMask());
      out.wandOnCrest = wand[Math.round(crestBB.y + crestBB.h / 2) * W + Math.round(crestBB.x + crestBB.w / 2)];
      out.wandOnStripe = wand[pl[1] * W + pl[0]];
      shots.push(overlay(wand, 'wand-cream'));
      // 5. component / regions / texture / refine (smoke on real pixels)
      const comp = M.selectComponent(seg, img, pl[0], pl[1], { mode: 'region' }); out.compArea = M.area(comp);
      const sleeves = M.fromRegions(seg, ['leftSleeve', 'rightSleeve']); out.sleeveArea = M.area(sleeves);
      shots.push(overlay(sleeves, 'regions-sleeves'));
      t0 = t(); const tex = M.selectByTexture(img, 512, 650, 30); out.msTexture = t() - t0; out.texArea = M.area(tex);
      const rough = M.expand(M.fromRect([crestBB.x - 12, crestBB.y - 10], [crestBB.x + crestBB.w + 14, crestBB.y + crestBB.h + 12]), 0); // too loose box around the crest
      t0 = t(); const ref = M.refineEdge(M.fromBrushStroke([[crestBB.x + crestBB.w / 2, crestBB.y + crestBB.h / 2]], 70, 0.6), img, { radius: 8 }); out.msRefine = t() - t0; out.refineArea = M.area(ref);
      shots.push(overlay(ref, 'refine-crest-blob'));
      // 6. back view: select the title text by colour+smart
      return { out, shots: shots.map(s => ({ name: s.name, url: s.url })) };
    });
    for (const s of res.shots) fs.writeFileSync(path.join(OUT, `mask-${s.name}.png`), Buffer.from(s.url.split(',')[1], 'base64'));
    const o = res.out; console.log(JSON.stringify(o));
    // brown colour select: stripes (both sleeves) + crest, nothing else
    ok(o.crestHit >= 250, 'brown colour select includes the crest shield');
    ok(o.brownBounds.x < 0.2 * 1024 && o.brownBounds.x + o.brownBounds.w > 0.8 * 1024, `brown select spans both sleeves (x ${o.brownBounds.x}..${o.brownBounds.x + o.brownBounds.w})`);
    ok(o.brownArea > 3000 && o.brownArea < 40000, `brown area plausible (${Math.round(o.brownArea)})`);
    // smart stripe: thin, single stripe, inside the drawn left stripe bbox (approx)
    ok(o.stripeArea > 1500 && o.stripeArea < o.brownArea * 0.4, `smartSelect stripe is ONE stripe, not all brown (${Math.round(o.stripeArea)} of ${Math.round(o.brownArea)})`);
    ok(o.stripeBounds.x >= 0.085 * 1024 - 30 && o.stripeBounds.x + o.stripeBounds.w <= (0.085 + 0.29) * 1024 + 30, `stripe stays in the left sleeve stripe bbox (x ${o.stripeBounds.x}..${o.stripeBounds.x + o.stripeBounds.w})`);
    ok(o.stripeBounds.y >= 0.31 * 1024 - 60 && o.stripeBounds.y + o.stripeBounds.h <= (0.31 + 0.45) * 1024 + 60, `stripe within stripe bbox vertically (y ${o.stripeBounds.y}..${o.stripeBounds.y + o.stripeBounds.h})`);
    // crest: bounds match the drawn crest bbox within a few px
    const b = o.crestBounds, c = o.crestBB;
    within(b.x, c.x, 5, 'crest left'); within(b.y, c.y, 5, 'crest top'); within(b.x + b.w, c.x + c.w, 5, 'crest right'); within(b.y + b.h, c.y + c.h, 6, 'crest bottom');
    ok(o.crestArea > 0.55 * c.w * c.h && o.crestArea < 1.02 * c.w * c.h, `crest area plausible (${Math.round(o.crestArea)} of bbox ${Math.round(c.w * c.h)})`);
    // wand on the cream body: large, excludes crest and stripe
    ok(o.wandArea > 0.35 * o.garmentArea, `wand on cream covers a large part of the shirt (${Math.round(o.wandArea)} / ${Math.round(o.garmentArea)})`);
    ok(o.wandOnCrest === 0 && o.wandOnStripe === 0, 'wand leaves the crest and the stripes unselected');
    ok(o.sleeveArea > 20000 && o.compArea > 20000, 'regions/components return real areas');
    for (const k of ['msColor', 'msSmartStripe', 'msSmartCrest', 'msWand', 'msTexture', 'msRefine']) ok(o[k] < 800, `${k} ${o[k].toFixed(0)} ms in the browser`);
  } finally { await browser.close(); srv.kill(); }
  console.log(`\nmask browser test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
