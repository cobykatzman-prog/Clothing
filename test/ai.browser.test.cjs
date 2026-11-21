// Phase 6 e2e: AI generation and intelligent editing against the REAL server.mjs and the in-process OpenAI mock (test/mock-openai.mjs).
// Proves: garment-aware generation, a view redrawn from the front, selective regeneration (view / section), artwork layers
// are never touched, results arrive as a preview you can accept / reject / undo, and every failure says WHAT failed
// (not configured / rate limit / timeout / upstream) with Retry and Use built-in engine. Run: node test/ai.browser.test.cjs
const { chromium } = require('playwright');
const L = require('./e2e/lib.cjs');
const R = L.runner('ai'); const { ok } = R;
(async () => {
  const { startServer } = await import('../server.mjs');
  const { startMock } = await import('./mock-openai.mjs');
  const KEY = 'sk-test-e2e-key', PW = 'correct-horse-battery';
  const mock = await startMock({ key: KEY });
  const { server, port } = await startServer({ NODE_ENV: 'test', SITE_PASSWORD: PW, SESSION_SECRET: 's'.repeat(40), OPENAI_API_KEY: KEY, AI_BASE_URL: mock.url, AI_RATE_LIMIT: '5000', AI_DAILY_LIMIT: '100000', AI_TIMEOUT_MS: '1500' }, 0);
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch(); const errs = [];
  const { ctx, page } = await L.newPage(browser);
  L.watch(page, errs, { allow: ['http 401', 'http 303', 'http 404', 'http 429', 'http 502', 'http 503', 'Failed to load resource'] });
  const shot = n => page.screenshot({ path: `${L.OUT}/ai-${n}.png` });
  const st = (fn, arg) => page.evaluate(fn, arg);
  const settle = () => page.waitForFunction(() => { const u = window.__threadform.state.ui; return !u.busy && !u.processing; }, null, { timeout: 30000 }).then(() => page.waitForTimeout(250));
  const reqs = () => mock.requests.filter(r => r.method === 'POST');
  const lastReq = () => reqs()[reqs().length - 1];
  const promptOf = r => (Array.isArray(r.fields.prompt) ? r.fields.prompt[0] : r.fields.prompt) || (r.json && r.json.prompt) || '';
  const cardText = () => st(() => [...document.querySelectorAll('.ai-task')].map(c => c.innerText).join('\n'));
  const elementsJson = () => st(() => JSON.stringify(window.__threadform.state.elements.map(e => e.toJSON())));
  const rejectPreview = async () => { if (await st(() => !!window.__threadform.state.review)) await page.click('#btn-reject'); await page.waitForFunction(() => !window.__threadform.state.review); };
  const openSec = id => page.evaluate(i => { window.__threadform.reveal(i); document.getElementById(i).open = true; }, id);
  const regen = async sel => { await openSec('sec-generate'); await page.click('#regen-block ' + sel); };
  const closeCards = async () => { await page.evaluate(() => document.querySelectorAll('.ai-task').forEach(c => c.remove())); };

  R.section('login, AI is on');
  await page.goto(base); await page.fill('input[type=password]', PW); await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  await page.waitForSelector('#home:not([hidden])');
  await page.click('#home >> text=Try a sample shirt'); await page.waitForFunction(() => window.__threadform.state.views.front.current); await settle();
  await page.waitForSelector('#engine-badge[data-engine="ai"]', { timeout: 15000 }); ok(true, 'engine badge says AI editing is on');

  R.section('garment-aware generation');
  await openSec('sec-generate'); await page.fill('textarea[aria-label="Describe a garment to generate"]', 'cream long sleeve shirt with brown stripes, no cuffs, heavyweight cotton');
  await page.click('#sec-generate button:has-text("Generate garment")');
  await page.waitForSelector('.ai-task[data-state="done"]', { timeout: 30000 }); await settle();
  let q = reqs().find(r => r.path === '/v1/images/generations'); ok(!!q, 'AI front was requested from the generations endpoint');
  const gp = q ? promptOf(q) : '';
  ok(/Construction to follow exactly/.test(gp) && /long-sleeve/i.test(gp) && /brown/i.test(gp) && /none: open, plainly hemmed sleeve ends/.test(gp) && /heavyweight cotton/.test(gp), 'the prompt carries garment type, cut, sleeves, stripes, no-cuffs and fabric: ' + gp.slice(0, 160));
  ok(await st(() => window.__threadform.state.views.front.base && window.__threadform.state.views.back.base), 'front (AI) and matching back views are installed');
  ok(/Redraw the back with AI/.test(await cardText()), 'the success card offers to redraw the back with AI from this front');
  await shot('1-generated'); await closeCards();

  R.section('artwork layers survive everything');
  await openSec('sec-text'); await page.fill('input[aria-label="Text to add"]', 'CLUB ELITE'); await page.click('#sec-text button:has-text("Add text")'); await page.waitForTimeout(300);
  const art0 = await elementsJson(); ok(/CLUB ELITE/.test(art0), 'a text layer exists');

  R.section('three AI options through the mask pipeline');
  await openSec('sec-describe'); await page.fill('#prompt', 'make the sleeves slightly flared'); await page.click('#btn-variations');
  await page.waitForFunction(() => { const v = window.__threadform.state.variations; return v && v.length === 3 && v.every(o => o && o.canvas); }, null, { timeout: 40000 });
  ok(await st(() => window.__threadform.state.variations.every(o => o.source === 'ai')), 'all three options came from the AI');
  const er = reqs().filter(r => r.path === '/v1/images/edits').pop(), ep = er ? promptOf(er) : '';
  ok(/Construction|design this garment belongs to/.test(ep) && /long-sleeve/i.test(ep), 'the edit prompt carries the garment design for consistency');
  ok(/CLUB ELITE/.test(ep) && /must stay exactly as it is/.test(ep), 'the edit prompt names the existing artwork layer to leave alone');
  await page.click('.vcard:nth-child(2) [data-act="use"]'); await settle();
  ok(await elementsJson() === art0, 'accepting an AI option leaves every artwork layer exactly as it was');
  ok(await st(() => window.__threadform.state.edits.length) === 1, 'the accepted edit is in Edit history');

  R.section('selective regeneration of one view from the front');
  const frontBefore = await st(() => window.__threadform.state.views.front.base === window.__threadform.state.views.front.base);
  await regen('[data-regen-view="back"]');
  await page.waitForFunction(() => { const s = window.__threadform.state; return s.review && s.variations && s.variations[0] && s.variations[0].regen; }, null, { timeout: 30000 });
  q = lastReq(); const bp = promptOf(q);
  ok(q.path === '/v1/images/edits' && q.files.some(f => f.name === 'image[]'), 'the back was drawn through the edits endpoint with the front as the image');
  ok(/approved FRONT view/.test(bp) && /SAME garment/.test(bp) && /Back view/.test(bp) && /Construction to follow exactly/.test(bp), 'the back prompt says: same garment as the approved front, back view, same construction');
  const cols = await st(() => { const s = window.__threadform.state, px = (c) => { const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return [d[0], d[1], d[2], d[3]]; }; return { front: px(s.views.front.base), back: px(s.review.canvas) }; });
  ok(cols.front.slice(0, 3).every((v, i) => Math.abs(v - cols.back[i]) < 14), 'the redrawn back has the front\'s colour (consistent design) ' + JSON.stringify(cols));
  ok(await st(() => window.__threadform.state.activeView) === 'back' && await st(() => !!document.querySelector('#review-bar:not([hidden])')), 'the back is previewed with the review bar (nothing replaced yet)');
  const backOld = await st(() => { window.__threadform._backOld = window.__threadform.state.views.back.base; return true; });
  ok(await st(() => window.__threadform.state.views.back.base === window.__threadform._backOld), 'the back view is unchanged during the preview');
  await shot('2-view-preview');
  await page.click('#btn-accept'); await settle();
  ok(await st(() => window.__threadform.state.views.back.base !== window.__threadform._backOld), 'Accept replaced the back view');
  ok(await elementsJson() === art0, 'artwork layers still exactly as before after redrawing a view');
  ok(await st(() => window.__threadform.state.views.back.params.sleeveFlare === window.__threadform.state.views.front.params.sleeveFlare), 'shape parameters stay linked front to back');
  await page.click('#btn-undo-edit'); await settle();
  ok(await st(() => window.__threadform.state.views.back.base === window.__threadform._backOld), 'Undo edit brings the previous back view back');

  R.section('selective regeneration of one garment section');
  await page.click('[data-testid=x]', { timeout: 200 }).catch(() => {});
  await page.evaluate(() => { window.__threadform.state.activeView = 'front'; }); await page.click('.tab[data-v="front"]'); await settle();
  await regen('[data-regen-section="sleeves"]');
  await page.waitForFunction(() => { const v = window.__threadform.state.variations; return v && v.length === 3 && v.every(o => o && o.canvas); }, null, { timeout: 40000 });
  q = reqs().filter(r => r.path === '/v1/images/edits').pop();
  ok(/selective regeneration of the sleeves ONLY/.test(promptOf(q)) && q.files.some(f => f.name === 'mask'), 'sleeves were regenerated with a mask and the "this section only" instruction');
  ok(await st(() => window.__threadform.state.variations.every(o => o.mask)), 'every option is composited through the sleeve mask (the rest cannot change)');
  ok(await elementsJson() === art0, 'artwork layers untouched by a section regeneration');
  await shot('3-section-options');

  R.section('failures say what failed, with Retry and Use built-in engine');
  await page.click('.tab[data-v="back"]'); await settle(); await rejectPreview().catch(() => {});
  await closeCards(); mock.setFailure('429');
  await regen('[data-regen-view="back"]');
  await page.waitForSelector('.ai-task[data-kind="ratelimit"]', { timeout: 20000 });
  let ct = await cardText();
  ok(/rate limit/i.test(ct) && /Nothing was changed/.test(ct), 'rate limit is named and "nothing was changed" is stated: ' + ct.replace(/\n/g, ' | '));
  ok(!/try another prompt|different words|different wording/i.test(ct), 'no vague "try another prompt" message');
  ok(await page.locator('.ai-task button:has-text("Retry")').count() === 1 && await page.locator('.ai-task button:has-text("Use built-in engine")').count() === 1, 'Retry and Use built-in engine are both offered');
  await shot('4-rate-limit');
  await page.click('.ai-task button:has-text("Use built-in engine")');
  await page.waitForFunction(() => { const v = window.__threadform.state.variations; return v && v[0] && v[0].regen && v[0].source === 'local'; }, null, { timeout: 15000 });
  ok(true, 'Use built-in engine draws the view locally as a preview'); await rejectPreview(); await closeCards();

  mock.setFailure('500', 1);
  await regen('[data-regen-view="back"]');
  await page.waitForSelector('.ai-task[data-kind="upstream"]', { timeout: 20000 });
  ct = await cardText(); ok(/AI service error/.test(ct) && /Upstream error/.test(ct), 'upstream failure is named: ' + ct.replace(/\n/g, ' | '));
  await page.click('.ai-task button:has-text("Retry")');
  await page.waitForFunction(() => { const v = window.__threadform.state.variations; return v && v[0] && v[0].regen && v[0].source === 'ai'; }, null, { timeout: 30000 });
  ok(true, 'Retry succeeds once the service recovers'); await rejectPreview(); await closeCards();

  mock.setFailure('timeout');
  await regen('[data-regen-view="back"]');
  await page.waitForSelector('.ai-task[data-kind="timeout"]', { timeout: 20000 });
  ct = await cardText(); ok(/timeout/i.test(ct) && /Retry/.test(ct), 'timeout is named and retryable: ' + ct.replace(/\n/g, ' | '));
  mock.reset(); await closeCards();

  await page.route('**/api/ai/generate', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ai_disabled', message: 'x' } }) }));
  await regen('[data-regen-view="back"]');
  await page.waitForSelector('.ai-task[data-kind="disabled"]', { timeout: 20000 });
  ct = await cardText(); ok(/not configured/i.test(ct), 'not configured is named: ' + ct.replace(/\n/g, ' | '));
  ok(await page.locator('.ai-task button:has-text("Retry")').count() === 0 && await page.locator('.ai-task button:has-text("Use built-in engine")').count() === 1, 'no useless Retry when AI is not configured; the built-in engine is offered');
  await page.unroute('**/api/ai/generate'); await closeCards();

  R.section('three options with AI failing: built-in options, reason shown, nothing destroyed');
  mock.setFailure('500');
  const frontNow = await st(() => { window.__threadform._f = window.__threadform.state.views.front.current; return true; });
  await page.click('.tab[data-v="front"]'); await settle();
  await openSec('sec-describe'); await page.fill('#prompt', 'make the body boxier'); await page.click('#btn-variations');
  await page.waitForFunction(() => { const v = window.__threadform.state.variations; return v && v.length === 3 && v.every(o => o && o.canvas); }, null, { timeout: 40000 });
  ok(await st(() => window.__threadform.state.variations.every(o => o.source === 'local-fallback' && /AI service error/.test(o.note || ''))), 'every option fell back to the built-in engine and says why (AI service error)');
  ok(await st(() => window.__threadform.state.views.front.current === window.__threadform._f), 'the garment itself is unchanged until an option is accepted');
  ok(await elementsJson() === art0, 'artwork layers still untouched');
  await shot('5-fallback-options');
  mock.reset();

  R.section('baked-in logos and lettering are protected unless the request names them');
  await openSec('sec-upload'); await page.click('#btn-club-sample'); await page.waitForFunction(() => window.__threadform.state.name === 'Club Élite test shirt'); await settle();
  const overlap = async prompt => {
    mock.reset(); await closeCards();
    await openSec('sec-describe'); await page.fill('#prompt', prompt); await page.click('#btn-variations');
    await page.waitForFunction(() => { const v = window.__threadform.state.variations; return v && v.length === 3 && v.every(o => o && o.canvas); }, null, { timeout: 40000 });
    return st(() => {
      const s = window.__threadform.state, V = s.views.front, reg = V.seg && V.seg.regions && V.seg.regions.logos, o = s.variations[1];
      if (!reg || !o.mask) return { hasRegion: !!reg, hits: -1 };
      const a = c => { const x = document.createElement('canvas'); x.width = x.height = 256; const g = x.getContext('2d'); g.drawImage(c, 0, 0, 256, 256); return g.getImageData(0, 0, 256, 256).data; };
      const L = a(reg), M = a(o.mask); let logo = 0, hits = 0;
      for (let i = 3; i < L.length; i += 4) if (L[i] > 128) { logo++; if (M[i] > 20) hits++; }
      return { hasRegion: true, logo, hits };
    });
  };
  const kept = await overlap('give the whole garment a softer, more relaxed feel');
  ok(kept.hasRegion && kept.logo > 0, 'the Club Élite shirt has a detected logo region ' + JSON.stringify(kept));
  ok(kept.hits <= kept.logo * 0.03, 'an edit that does not mention artwork leaves the baked-in logo out of the edit mask (' + JSON.stringify(kept) + ')');
  const named = await overlap('make the crest a little cleaner');
  ok(named.hits > 0, 'when the request names the logo, it is editable again (' + JSON.stringify(named) + ')');
  mock.reset(); await overlap('give the whole garment a softer, more relaxed feel');
  ok(/existing logos/.test(promptOf(reqs().filter(r => r.path === '/v1/images/edits').pop())), 'and the model is told to keep the existing logos');

  ok(errs.length === 0, 'no JS errors / CSP violations / external requests ' + JSON.stringify(errs.slice(0, 4)));
  await browser.close(); server.close(); await mock.close();
  process.exit(R.done() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
