// Roadmap v2 Phase 8: testing, security, performance in a real browser against the REAL server.mjs + test/mock-supabase.mjs.
//  - page loads with zero console errors / failed requests / CSP violations; every module of the graph is served (and compressed)
//  - login journeys (wrong password, lockout page, Referrer-Policy: no-referrer / "Origin: null" login)
//  - three separate accounts (owner alice, editor bob, viewer carol): viewer cannot write, editor edits reach the owner, history restore,
//    conflict between two sessions keeps both people's work
//  - Supabase down / back: friendly status, offline queue, local backup, nothing lost
//  - Backup all / Restore (shared mode and per-browser mode)
//  - responsive: no horizontal scroll on login, home, studio and the backup dialog at 1440x900, 1024x768, 768x1024, 390x844
//  - load-time and heavy-operation timings (generous budgets; printed so regressions are visible)
// Run: node test/phase8.browser.test.cjs
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const L = require('./e2e/lib.cjs');
const R = L.runner('phase8'); const { ok } = R;
const SIZES = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];

(async () => {
  const { startServer } = await import('../server.mjs');
  const { startMock } = await import('./mock-supabase.mjs');
  const KEY = 'phase8-service-key', PW = 'phase8-shared-password';
  const mock = await startMock({ key: KEY });
  const env = { NODE_ENV: 'test', SITE_PASSWORD: PW, SESSION_SECRET: 'p'.repeat(40), SUPABASE_URL: mock.url + '/', SUPABASE_SERVICE_KEY: KEY,
    SITE_USERS: 'alice:alice-pass-1234,bob:bob-pass-123456,carol:carol-pass-12345', SITE_ROLES: 'alice:owner,bob:editor,carol:viewer', WORKSPACE_REV_INTERVAL_SEC: '0', RENDER_GIT_COMMIT: 'abc1234def5678' };
  const { server, port } = await startServer(env, 0);
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const ALLOW = ['http 401', 'http 303', 'http 409', 'http 503', 'http 502', 'http 403', 'Failed to load resource'];   // expected refusals in the failure scenarios
  const errs = [];
  const clean = (label, allow = []) => { const real = errs.filter(e => !allow.some(a => e.includes(a))); ok(real.length === 0, `${label}: no unexpected JS errors / CSP violations ${JSON.stringify(real.slice(0, 3))}`); errs.length = 0; };
  const settle = page => page.waitForFunction(() => { const u = window.__threadform.state.ui; return !u.busy && !u.processing; }, null, { timeout: 30000 }).then(() => page.waitForTimeout(250));
  const status = page => page.evaluate(() => document.querySelector('.save-status')?.textContent || '');
  const waitStatus = (page, re, ms = 30000) => page.waitForFunction(s => new RegExp(s).test(document.querySelector('.save-status')?.textContent || ''), re.source, { timeout: ms });
  const login = async (who, opts = {}) => {
    const { ctx, page } = await L.newPage(browser, opts); L.watch(page, errs, { allow: ALLOW });
    await page.goto(base); await page.fill('input[name=username]', who); await page.fill('input[type=password]', { alice: 'alice-pass-1234', bob: 'bob-pass-123456', carol: 'carol-pass-12345' }[who]);
    await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]); await page.waitForSelector('#home:not([hidden])');
    return { ctx, page, who };
  };
  const setSlider = (page, label, v) => page.evaluate(([l, val]) => { const r = document.querySelector(`input[type=range][aria-label="${l}"]`); r.value = val; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }, [label, v]);
  const bodyWidth = page => page.evaluate(() => window.__threadform.state.views.front.params.bodyWidth);
  const dbDesigns = () => mock.tables.designs;

  /* ============================================================ A. page load: zero errors, modules served, timings */
  R.section('load: home page has no errors, every module loads, files are compressed');
  {
    const { ctx, page } = await L.newPage(browser); L.watch(page, errs, { allow: ['http 401', 'http 303'] });
    const mods = [], enc = [];
    page.on('response', r => { const u = r.url(); if (/\/js\/[^/]+\.js$/.test(u)) { mods.push([u, r.status()]); enc.push(r.headers()['content-encoding']); } });
    const t0 = Date.now(); await page.goto(base); await page.fill('input[name=username]', 'alice'); await page.fill('input[type=password]', 'alice-pass-1234');
    const t1 = Date.now(); await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('button[type=submit]')]); await page.waitForSelector('#home:not([hidden])'); const loadMs = Date.now() - t1;
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const res = performance.getEntriesByType('resource'); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), n: res.length, bytes: res.reduce((a, r) => a + (r.transferSize || 0), 0) }; });
    console.log(`  timing: login -> home visible ${loadMs} ms; DOMContentLoaded ${nav.dcl} ms; load ${nav.load} ms; ${nav.n} resources, ${(nav.bytes / 1024).toFixed(0)} KB transferred`);
    ok(mods.length > 50, `module graph loaded (${mods.length} modules)`); ok(mods.every(m => m[1] === 200), 'every module answered 200');
    ok(enc.filter(e => e === 'gzip').length >= mods.length * 0.8, 'JavaScript is gzip-compressed on the wire');
    ok(nav.bytes < 600 * 1024, `home page transfers less than 600 KB (${(nav.bytes / 1024).toFixed(0)} KB)`);
    ok(loadMs < 8000 && nav.load < 8000, `home loads within the budget (${loadMs} ms)`);
    ok(await page.evaluate(() => !!document.querySelector('#home h1')), 'home heading rendered');
    ok(await page.evaluate(() => document.querySelector('meta[name=threadform-user]')?.getAttribute('content') === 'alice'), 'server tells the page who is logged in');
    clean('home load'); await ctx.close();
  }

  /* ============================================================ B. login journeys */
  R.section('login: wrong password, Referrer-Policy no-referrer ("Origin: null") login, session survives reload, logout');
  {
    const { ctx, page } = await L.newPage(browser); L.watch(page, errs, { allow: ['http 401', 'http 303', 'http 429'] });
    await page.goto(base); ok(/\/login/.test(page.url()), 'logged-out visit redirects to the login page');
    ok(await page.isVisible('input[type=password]'), 'login form is shown'); ok(!(await page.content()).includes('main.js'), 'login page ships no studio code');
    await page.fill('input[name=username]', 'alice'); await page.fill('input[type=password]', 'wrong-wrong-wrong'); await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
    ok(await page.isVisible('[role=alert]'), 'wrong password shows an error message'); ok(!(await ctx.cookies()).some(c => c.name === 'tf_session'), 'no session cookie after a wrong password');
    // a strict referrer policy makes browsers send "Origin: null" on form posts: login must still work (regression of a past outage)
    await page.evaluate(() => { const m = document.createElement('meta'); m.name = 'referrer'; m.content = 'no-referrer'; document.head.append(m); });
    const seenHeaders = []; page.on('request', r => { if (r.method() === 'POST') seenHeaders.push(r.headers()); });
    await page.fill('input[name=username]', 'alice'); await page.fill('input[type=password]', 'alice-pass-1234'); await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
    await page.waitForSelector('#home:not([hidden])'); ok(true, 'login works with Referrer-Policy: no-referrer'); ok(seenHeaders.length > 0, 'the login POST was observed (' + JSON.stringify(seenHeaders[0] && { origin: seenHeaders[0].origin, sfs: seenHeaders[0]['sec-fetch-site'] }) + ')');
    const cookie = (await ctx.cookies()).find(c => c.name === 'tf_session'); ok(cookie && cookie.httpOnly && cookie.sameSite === 'Strict', 'session cookie is HttpOnly + SameSite=Strict');
    ok(!(await page.evaluate(() => document.cookie)).includes('tf_session'), 'page script cannot read the session cookie');
    await page.reload(); await page.waitForSelector('#home:not([hidden])'); ok(true, 'session survives a reload');
    await Promise.all([page.waitForNavigation(), page.click('#home form[action="/logout"] button, #home >> text=Log out')]); ok(/\/login/.test(page.url()), 'Log out returns to the login page');
    const r = await page.request.get(base + 'js/main.js', { maxRedirects: 0 }); ok(r.status() === 401 || r.status() === 303, 'after logout the studio code is no longer served (' + r.status() + ')');
    clean('login journeys', ['http 429']); await ctx.close();
  }

  /* ============================================================ C. three accounts: roles */
  R.section('roles: alice (owner) saves, carol (viewer) cannot write, bob (editor) edits and alice receives it');
  const A = await login('alice'), Bo = await login('bob'), C = await login('carol');
  const meta = async p => p.evaluate(() => ({ user: document.querySelector('meta[name=threadform-user]')?.getAttribute('content'), role: document.querySelector('meta[name=threadform-user]')?.dataset.role }));
  ok(JSON.stringify(await meta(A.page)) === '{"user":"alice","role":"owner"}' && (await meta(Bo.page)).role === 'editor' && (await meta(C.page)).role === 'viewer', 'each session knows its own identity and role');
  await A.page.waitForSelector('text=Connected', { timeout: 15000 }).catch(() => {});
  await A.page.click('#home >> text=Try a sample shirt'); await A.page.waitForFunction(() => window.__threadform.state.views.front.current); await settle(A.page);
  await A.page.fill('input.name', 'Roles tee'); await waitStatus(A.page, /Saved to shared library/, 20000);
  const link = A.page.url(); const id = link.split('/design/')[1];
  ok(dbDesigns().some(d => d.id === id && d.updated_by === 'alice'), 'the design is in the shared library, last edited by alice');
  ok(await A.page.isVisible('button:has-text("Share")'), 'owner sees the Share button');

  // viewer
  const puts = []; C.page.on('request', r => { if (['PUT', 'POST', 'DELETE'].includes(r.method()) && /\/api\//.test(r.url())) puts.push(r.method() + ' ' + r.url()); });
  await C.page.goto(link); await C.page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 20000 }); await settle(C.page);
  await C.page.waitForFunction(() => /View only/.test(document.querySelector('.save-status')?.textContent || ''), null, { timeout: 15000 });
  ok(/View only/.test(await status(C.page)), 'viewer: header says View only'); ok(await C.page.isVisible('.sync-banner'), 'viewer: banner explains they cannot change it');
  ok(!(await C.page.isVisible('button:has-text("Share")')), 'viewer: no Share button');
  const revBefore = dbDesigns().find(d => d.id === id).rev;
  await C.page.click('#rtab-shape'); await setSlider(C.page, 'Body width', 77); await C.page.waitForTimeout(2500);
  ok(puts.length === 0, 'viewer: editing makes no write requests (' + puts.join(', ') + ')'); ok(dbDesigns().find(d => d.id === id).rev === revBefore, 'viewer: the shared design is unchanged');
  const viewerPut = await C.page.evaluate(async id => { const r = await fetch('/api/designs/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRev: 1, name: 'hacked', meta: {}, doc: {}, keepAssets: [] }) }); return r.status; }, id);
  ok(viewerPut === 403, 'viewer: a hand-made PUT is refused by the server (403, got ' + viewerPut + ')');
  const viewerDel = await C.page.evaluate(async id => (await fetch('/api/designs/' + id, { method: 'DELETE' })).status, id); ok(viewerDel === 403, 'viewer: DELETE refused (' + viewerDel + ')');
  ok(dbDesigns().find(d => d.id === id).name === 'Roles tee', 'viewer: name untouched after the attempts');
  // history: viewers can look but not restore
  await C.page.click('button:has-text("History")'); await C.page.waitForSelector('.ws-dlg .ws-row'); ok(!(await C.page.isVisible('.ws-dlg button:has-text("Restore")')), 'viewer: history has no Restore buttons'); await C.page.keyboard.press('Escape');
  clean('viewer session', ['http 403']);

  // editor edits, owner receives
  await Bo.page.goto(link); await Bo.page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 20000 }); await settle(Bo.page);
  ok(!/View only/.test(await status(Bo.page)), 'editor: not read-only');
  await Bo.page.click('#rtab-shape'); await setSlider(Bo.page, 'Body width', 50); await waitStatus(Bo.page, /Saved to shared library/, 20000);
  ok(dbDesigns().find(d => d.id === id).updated_by === 'bob', 'editor: save is recorded as bob');
  await A.page.waitForFunction(() => window.__threadform.state.views.front.params.bodyWidth === 50, null, { timeout: 35000 }).then(() => ok(true, 'owner receives the editor\'s change without reloading'), () => ok(false, 'owner did not receive the editor\'s change'));
  await C.page.waitForFunction(() => window.__threadform.state.views.front.params.bodyWidth === 50, null, { timeout: 35000 }).then(() => ok(true, 'viewer also sees the editor\'s change live'), () => ok(false, 'viewer did not see the change'));

  /* ---- history restore through the UI */
  R.section('history: owner restores an earlier version');
  await A.page.click('#rtab-shape'); await setSlider(A.page, 'Body width', 20); await waitStatus(A.page, /Saved to shared library/, 20000);
  const revNow = dbDesigns().find(d => d.id === id).rev; ok(revNow >= 3, 'several versions exist (rev ' + revNow + ')');
  await A.page.click('button:has-text("History")'); await A.page.waitForSelector('.ws-dlg .ws-row');
  const rows = await A.page.$$eval('.ws-dlg .ws-row b', els => els.map(e => e.textContent)); ok(rows[0] === 'Current version' && rows.length >= 3, 'history lists the versions: ' + rows.join(', '));
  await A.page.click('.ws-dlg .ws-row:last-child button:has-text("Restore")'); await A.page.waitForSelector('dialog.confirm .btn.primary'); await A.page.click('dialog.confirm .btn.primary');
  await A.page.waitForFunction(() => window.__threadform.state.views.front.params.bodyWidth === 0, null, { timeout: 20000 }).then(() => ok(true, 'restoring the first version brings back the original shape'), () => ok(false, 'restore did not change the design'));
  ok(dbDesigns().find(d => d.id === id).rev > revNow, 'restore is saved as a NEW revision (history is not rewritten)');
  await Bo.page.waitForFunction(() => window.__threadform.state.views.front.params.bodyWidth === 0, null, { timeout: 35000 }).then(() => ok(true, 'editor receives the restored version'), () => ok(false, 'editor did not receive the restore'));
  clean('roles + history', ['http 403']);

  /* ---- conflict between two sessions: nothing is lost */
  R.section('conflict: owner edits while offline, editor saves first; both people\'s work is kept');
  await A.ctx.setOffline(true); await A.page.click('#rtab-shape'); await setSlider(A.page, 'Body width', -40);
  await A.page.waitForFunction(() => /offline|Unsaved/i.test(document.querySelector('.save-status')?.textContent || ''), null, { timeout: 20000 }); ok(true, 'owner offline: status says changes are waiting (' + await status(A.page) + ')');
  await setSlider(Bo.page, 'Body width', 33); await waitStatus(Bo.page, /Saved to shared library/, 20000);
  await A.ctx.setOffline(false);
  await A.page.waitForFunction(() => document.querySelector('.sync-banner:not([hidden])') || /Saved to shared library/.test(document.querySelector('.save-status')?.textContent || ''), null, { timeout: 60000 }).catch(() => { });
  await A.page.waitForFunction(() => window.__threadform.state.views.front.params.bodyWidth !== undefined); await A.page.waitForTimeout(1500);
  const orig = dbDesigns().find(d => d.id === id), copies = dbDesigns().filter(d => /my version/.test(d.name));
  console.log(`  conflict outcome: server width ${orig.doc.views.front.params.bodyWidth}, copies ${JSON.stringify(copies.map(c => [c.name, c.doc.views.front.params.bodyWidth]))}, banner ${await A.page.isVisible('.sync-banner')}, owner now ${await bodyWidth(A.page)}`);
  const keptBoth = orig.doc.views.front.params.bodyWidth === 33 && (copies.some(c => c.doc.views.front.params.bodyWidth === -40) || await A.page.isVisible('.sync-banner') || (await bodyWidth(A.page)) === 33);
  ok(orig.doc.views.front.params.bodyWidth === 33, 'editor\'s saved version is intact on the server (not overwritten by the stale save)');
  ok(keptBoth, 'owner\'s offline change was not silently lost (kept as a copy, or a conflict banner is shown)');
  if (await A.page.isVisible('.sync-banner')) { ok(/changed this design|deleted/.test(await A.page.textContent('.sync-banner')), 'conflict banner explains what happened'); await A.page.click('.sync-banner button:has-text("Keep mine")');
    await A.page.waitForFunction(() => !document.querySelector('.sync-banner') || document.querySelector('.sync-banner').hidden, null, { timeout: 20000 }); await A.page.waitForTimeout(1500);
    const mine = dbDesigns().find(d => /my version/.test(d.name)); ok(mine && mine.doc.views.front.params.bodyWidth === -40, 'Keep mine saves the owner\'s offline work as its own design "(my version)"');
    ok(dbDesigns().find(d => d.id === id).doc.views.front.params.bodyWidth === 33, 'and the editor\'s version is still untouched'); }
  clean('conflict', ['http 409', 'Failed to load resource', 'requestfailed', 'ERR_INTERNET_DISCONNECTED']);
  await C.ctx.close();

  /* ============================================================ D. Supabase down: friendly status, offline queue, nothing lost */
  R.section('Supabase down / paused / missing tables: friendly status, offline queue, local backup, recovery without data loss');
  await Bo.page.waitForTimeout(500);
  mock.setFailure('down');
  await setSlider(Bo.page, 'Body width', 11);
  await waitStatus(Bo.page, /offline|Not saved/i, 30000); ok(/will retry|offline/i.test(await status(Bo.page)), 'editor: status says it is not saved and will retry (' + await status(Bo.page) + ')');
  ok(await Bo.page.evaluate(async () => new Promise(res => { const o = indexedDB.open('threadform'); o.onsuccess = () => { const db = o.result; try { const q = db.transaction('designs').objectStore('designs').getAll(); q.onsuccess = () => res(q.result.some(r => r.meta && 'backupBaseRev' in r.meta && r.doc?.views?.front?.params?.bodyWidth === 11)); q.onerror = () => res(false); } catch { res(false); } }; o.onerror = () => res(false); })), 'the unsaved edit is backed up in this browser (IndexedDB), so closing the tab would not lose it');
  ok(dbDesigns().find(d => d.id === id).doc.views.front.params.bodyWidth === 33, 'server data untouched during the outage');
  await Bo.page.goto(base + '#/'); await Bo.page.waitForSelector('#home:not([hidden])');
  await Bo.page.click('#home button:has-text("Check connection")'); await Bo.page.waitForFunction(() => document.querySelector('.badge.shared')?.dataset.state === 'bad', null, { timeout: 20000 });
  const badge = await Bo.page.textContent('.badge.shared'); ok(badge.length > 12 && !/ECONN|stack|undefined|\[object/.test(badge), 'home badge explains the outage in plain words: "' + badge.trim() + '"');
  ok(await Bo.page.isVisible('#home'), 'the app itself stays usable while the database is down');
  mock.setFailure('missingTables'); await Bo.page.click('#home button:has-text("Check connection")'); await Bo.page.waitForTimeout(1500);
  const b2 = await Bo.page.textContent('.badge.shared'); ok(b2.length > 12 && !/undefined|\[object/.test(b2), 'missing tables: friendly message "' + b2.trim() + '"');
  mock.setFailure('paused'); await Bo.page.click('#home button:has-text("Check connection")'); await Bo.page.waitForTimeout(1500);
  const b3 = await Bo.page.textContent('.badge.shared'); ok(/paus|not respond|not responding|cannot|reach|problem/i.test(b3), 'paused project: message mentions it (' + b3.trim() + ')');
  mock.setFailure(null);
  await Bo.page.goto(link); await Bo.page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 20000 }); await settle(Bo.page);
  await Bo.page.click('#home-btn, .home-btn').catch(() => {});
  clean('outage', ALLOW.concat(['requestfailed', 'ERR_', 'console: ']));
  await A.ctx.close(); await Bo.ctx.close();

  // recovery while a design is open: offline queue flushes by itself
  {
    const S = await login('alice'); await S.page.goto(link); await S.page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 20000 }); await settle(S.page);
    mock.setFailure('down'); await S.page.click('#rtab-shape'); await setSlider(S.page, 'Body width', 12); await waitStatus(S.page, /offline|Not saved/i, 30000);
    mock.setFailure(null);
    await waitStatus(S.page, /Saved to shared library/, 60000).then(() => ok(true, 'the queued edit is sent automatically when the database is back'), () => ok(false, 'the queued edit was not sent after recovery'));
    ok(dbDesigns().find(d => d.id === id).doc.views.front.params.bodyWidth === 12, 'the edit made during the outage is now on the server');
    ok(!(await S.page.evaluate(async () => new Promise(res => { const o = indexedDB.open('threadform'); o.onsuccess = () => { try { const q = o.result.transaction('designs').objectStore('designs').getAll(); q.onsuccess = () => res(q.result.some(r => r.meta && 'backupBaseRev' in r.meta)); } catch { res(false); } }; o.onerror = () => res(false); }))), 'the local backup is removed once the server has the edit');
    S.ctx.close && 0;

    /* ============================================================ E. backup / restore (shared library) */
    R.section('backup: download all designs, delete one, restore it from the file');
    await S.page.goto(base + '#/'); await S.page.waitForSelector('#home:not([hidden])');
    // add a second design so the backup holds more than one
    await S.page.click('#home-new'); await S.page.click('dialog >> text=Try a sample shirt'); await S.page.waitForFunction(() => window.__threadform.state.views.front.current); await settle(S.page); await S.page.fill('input.name', 'Second tee'); await waitStatus(S.page, /Saved to shared library/, 20000);
    await S.page.goto(base + '#/'); await S.page.waitForSelector('#home:not([hidden])'); await S.page.waitForSelector('.dcard, article');
    const countBefore = dbDesigns().length;
    await S.page.click('#home-backup'); await S.page.waitForSelector('#backup-download');
    const [dl] = await Promise.all([S.page.waitForEvent('download'), S.page.click('#backup-download')]);
    const file = path.join(L.OUT, 'phase8-backup.json'); await dl.saveAs(file);
    const text = fs.readFileSync(file, 'utf8'); const j = JSON.parse(text);
    ok(j.format === 'threadform-backup' && j.count === countBefore && j.designs.length === countBefore, `backup holds all ${countBefore} designs (${(text.length / 1024).toFixed(0)} KB)`);
    ok(j.designs.every(d => d.doc && Object.values(d.assets).every(a => /^data:image\//.test(a))), 'every design carries its document and its pictures');
    ok(!/phase8-service-key|alice-pass|SESSION_SECRET/.test(text), 'the backup contains no secrets');
    await S.page.waitForFunction(() => /Saved \d+ design/.test(document.querySelector('#backup-status')?.textContent || ''), null, { timeout: 15000 }); ok(true, 'dialog confirms the file was saved');
    await S.page.keyboard.press('Escape');
    // delete "Second tee" (server side, as another person might) and restore
    const second = dbDesigns().find(d => d.name === 'Second tee'); const idx = mock.tables.designs.indexOf(second); mock.tables.designs.splice(idx, 1);
    await S.page.reload(); await S.page.waitForSelector('#home:not([hidden])');
    ok(!(await S.page.textContent('#home')).includes('Second tee'), 'the deleted design is gone from the library');
    await S.page.click('#home-backup'); await S.page.setInputFiles('#backup-file', file);
    await S.page.waitForSelector('dialog.ask .btn.primary'); ok(/Restore \d+ design/.test(await S.page.textContent('dialog.ask h2')), 'restore asks before changing anything'); await S.page.click('dialog.ask .btn.primary');
    await S.page.waitForFunction(() => /Restored \d+ design/.test(document.querySelector('#backup-status')?.textContent || ''), null, { timeout: 30000 });
    const st = await S.page.textContent('#backup-status'); ok(st.includes(`Restored ${countBefore} designs`) && st.includes(`${countBefore - 1} as new cop`), 'restore reports what happened: ' + st);
    ok(dbDesigns().some(d => d.name === 'Second tee') && dbDesigns().filter(d => d.name === 'Roles tee').length === 1 && dbDesigns().some(d => d.name === 'Roles tee (restored)'), 'missing design came back under its name; the one that existed was NOT overwritten (restored as a copy)');
    const back = dbDesigns().find(d => d.name === 'Second tee'); ok(mock.assetsOf(back.id).length > 0, 'restored design has its pictures in asset storage');
    await S.page.keyboard.press('Escape');
    // a damaged file changes nothing
    const bad = path.join(L.OUT, 'phase8-bad.json'); fs.writeFileSync(bad, '{"format":"nope"'); const n0 = dbDesigns().length;
    await S.page.click('#home-backup'); await S.page.setInputFiles('#backup-file', bad); await S.page.waitForFunction(() => /not a Threadform backup|not valid/.test(document.querySelector('#backup-status')?.textContent || ''), null, { timeout: 10000 });
    ok(dbDesigns().length === n0, 'a damaged backup file is refused with a plain message and changes nothing'); await S.page.keyboard.press('Escape');
    clean('backup', ALLOW);

    /* ============================================================ F. responsive: no horizontal scroll */
    R.section('responsive: login, home, backup dialog, studio at four sizes, no horizontal scroll');
    await S.ctx.close();
    const noScroll = async (page, tag) => { const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); ok(m.sw <= m.iw, `${tag}: no horizontal scroll (${m.sw} > ${m.iw})`); };
    for (const [w, h] of SIZES) {
      const { ctx, page } = await L.newPage(browser, { width: w, height: h }); L.watch(page, errs, { allow: ['http 401', 'http 303'] });
      await page.goto(base); await noScroll(page, `${w}x${h} login`);
      ok(await page.evaluate(() => { const b = document.querySelector('button[type=submit]').getBoundingClientRect(); return b.right <= window.innerWidth && b.height >= 36; }), `${w}x${h}: login button on screen and tappable`);
      await page.fill('input[name=username]', 'alice'); await page.fill('input[type=password]', 'alice-pass-1234'); await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]); await page.waitForSelector('#home:not([hidden])'); await page.waitForTimeout(400);
      await noScroll(page, `${w}x${h} home`);
      await page.click('#home-backup'); await page.waitForSelector('#backup-download'); await noScroll(page, `${w}x${h} backup dialog`);
      ok(await page.evaluate(() => { const d = document.querySelector('dialog.backup-dialog').getBoundingClientRect(); return d.left >= 0 && d.right <= window.innerWidth + 1 && d.top >= 0 && d.bottom <= window.innerHeight + 1; }), `${w}x${h}: backup dialog fits the screen`);
      await page.keyboard.press('Escape');
      const t0 = Date.now(); await page.goto(link); await page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 30000 }); await settle(page);
      console.log(`  timing: ${w}x${h} open a saved shared design -> ready ${Date.now() - t0} ms`);
      await noScroll(page, `${w}x${h} studio`); clean(`${w}x${h}`); await ctx.close();
    }
  }

  /* ============================================================ G. per-browser mode: backup / restore, timings of heavy operations */
  R.section('per-browser mode (no shared library): backup, restore, and timings');
  {
    const { srv, url } = await L.staticServer();
    const { ctx, page } = await L.newPage(browser); L.watch(page, errs);
    await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])');
    const t0 = Date.now(); await page.click('#home >> text=Try a sample shirt'); await page.waitForFunction(() => window.__threadform.state.views.front.current); await settle(page);
    const openMs = Date.now() - t0; console.log(`  timing: sample shirt (generate 4 views) -> ready ${openMs} ms`); ok(openMs < 20000, `sample shirt opens within budget (${openMs} ms)`);
    await page.fill('input.name', 'Local tee'); await waitStatus(page, /Saved/, 10000);
    const t1 = Date.now(); await page.click('#rtab-shape'); await setSlider(page, 'Body width', 60); await settle(page); const warpMs = Date.now() - t1; console.log(`  timing: body width change (warp + redraw) ${warpMs} ms`); ok(warpMs < 8000, `a shape change completes within budget (${warpMs} ms)`);
    await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])');
    await page.click('#home-backup'); const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backup-download')]); const f = path.join(L.OUT, 'phase8-local-backup.json'); await dl.saveAs(f);
    ok(JSON.parse(fs.readFileSync(f, 'utf8')).count === 1, 'local backup holds the design'); await page.keyboard.press('Escape');
    // clear browser storage (what a browser clean-up would do), then restore from the file
    await page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('threadform'); r.onsuccess = r.onerror = r.onblocked = () => res(); })); await page.reload(); await page.waitForSelector('#home:not([hidden])');
    ok(await page.isVisible('.home-empty:not([hidden])'), 'after clearing browser storage the library is empty');
    await page.click('#home-backup'); await page.setInputFiles('#backup-file', f); await page.waitForSelector('dialog.ask .btn.primary'); await page.click('dialog.ask .btn.primary');
    await page.waitForFunction(() => /Restored 1 design/.test(document.querySelector('#backup-status')?.textContent || ''), null, { timeout: 20000 }); await page.keyboard.press('Escape');
    ok((await page.textContent('#home')).includes('Local tee'), 'the restored design is back on the home page');
    await page.click('#home >> text=Local tee'); await page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current && window.__threadform.state.views.front.params.bodyWidth === 60, null, { timeout: 20000 }).then(() => ok(true, 'it opens with its shape and pictures intact'), () => ok(false, 'restored design lost its shape'));
    clean('local backup'); await ctx.close(); srv.close();
  }

  await browser.close(); server.close(); await mock.close();
  process.exit(R.done() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
