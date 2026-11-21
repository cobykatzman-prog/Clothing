// Shared-library e2e: the real server.mjs (login gate + shared library) against the in-memory Supabase mock.
// Two browser sessions: A saves a design, B (a second login) sees it, opens the link, edits, and A receives the change.
// Run: node test/e2e.shared.browser.test.cjs
const { chromium } = require('playwright');
const L = require('./e2e/lib.cjs');
const R = L.runner('e2e-shared'); const { ok } = R;
(async () => {
  const { startServer } = await import('../server.mjs');
  const { startMock } = await import('./mock-supabase.mjs');
  const KEY = 'test-service-key', PW = 'correct-horse-battery';
  const mock = await startMock({ key: KEY });
  const { server, port } = await startServer({ NODE_ENV: 'test', SITE_PASSWORD: PW, SESSION_SECRET: 's'.repeat(40), SUPABASE_URL: mock.url + '/', SUPABASE_SERVICE_KEY: KEY }, 0);
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch(); const errs = [];
  const login = async () => { const { ctx, page } = await L.newPage(browser); L.watch(page, errs, { allow: ['http 401', 'http 303'] }); await page.goto(base); await page.fill('input[type=password]', PW); await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]); await page.waitForSelector('#home:not([hidden])'); return { ctx, page }; };
  const settle = page => page.waitForFunction(() => { const u = window.__threadform.state.ui; return !u.busy && !u.processing; }, null, { timeout: 30000 }).then(() => page.waitForTimeout(250));
  R.section('shared: login + save');
  const A = await login();
  ok(await A.page.isVisible('#home:not([hidden])'), 'login reaches the home page');
  await A.page.waitForSelector('text=Connected', { timeout: 15000 }).catch(() => {});
  await A.page.click('#home >> text=Try a sample shirt'); await A.page.waitForFunction(() => window.__threadform.state.views.front.current); await settle(A.page);
  await A.page.fill('input.name', 'Shared tee');
  await A.page.waitForFunction(() => /Saved to shared library/.test(document.querySelector('.save-status')?.textContent || ''), null, { timeout: 20000 });
  ok(true, 'A: header says Saved to shared library');
  const link = A.page.url(); ok(/#\/design\//.test(link), 'A: design has a shareable link');
  R.section('shared: second session opens the link');
  const B = await login();
  await B.page.goto(link); await B.page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 20000 }); await settle(B.page);
  ok(await B.page.evaluate(() => window.__threadform.state.name) === 'Shared tee', 'B: the shared link opens A\'s design');
  await B.page.click('#rtab-shape'); await B.page.evaluate(() => { const r = document.querySelector('input[type=range][aria-label="Body width"]'); r.value = 50; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
  await B.page.waitForFunction(() => /Saved to shared library/.test(document.querySelector('.save-status')?.textContent || ''), null, { timeout: 20000 });
  ok(true, 'B: edit saved to the shared library');
  await A.page.waitForFunction(() => window.__threadform.state.views.front.params.bodyWidth === 50, null, { timeout: 30000 }).then(() => ok(true, 'A: receives B\'s change automatically'), () => ok(false, 'A: did not receive B\'s change within 30 s'));
  ok(errs.length === 0, 'no JS errors so far ' + JSON.stringify(errs.slice(0, 4)));
  R.section('shared: unknown link');
  await B.page.goto(base + '#/design/nope'); await B.page.waitForTimeout(1500);
  ok(await B.page.isVisible('#home:not([hidden])'), 'B: unknown shared link falls back to home');
  await browser.close(); server.close(); mock.server && mock.server.close && mock.server.close();
  const good = R.done(); process.exit(good ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
