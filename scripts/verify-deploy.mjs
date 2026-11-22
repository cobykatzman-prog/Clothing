#!/usr/bin/env node
// Post-deploy smoke test for a running Threadform server (Render, or local). Zero dependencies (Node 18+ built-ins only).
//
//   DEPLOY_URL=https://your-service.onrender.com npm run verify:deploy
//
// Environment:
//   DEPLOY_URL        required (or pass it as the first argument). The site's base URL.
//   EXPECT_COMMIT     optional. The commit the deploy should be running (full or at least 7 characters of the sha). When set, the check FAILS
//                     unless /healthz reports that commit. (Render sets RENDER_GIT_COMMIT on the service; /healthz reports it.)
//   DEPLOY_PASSWORD   optional. A login (the shared SITE_PASSWORD, or a SITE_USERS password with DEPLOY_USERNAME). Enables the logged-in checks:
//                     index.html and every JavaScript / CSS file it loads are fetched, and the API status routes answer. Never printed.
//   DEPLOY_USERNAME   optional, with DEPLOY_PASSWORD (when the site uses SITE_USERNAME / SITE_USERS).
//   WAIT_SEC          optional. How long to keep retrying /healthz while the service wakes up / finishes deploying (default 120; 0 = one try).
//
// Exit code 0 = every check passed (warnings allowed), 1 = a check failed, 2 = bad usage. It only ever sends GET requests plus one login POST.
const raw = process.argv[2] || process.env.DEPLOY_URL || '';
if (!raw) { console.error('Usage: DEPLOY_URL=https://your-service.onrender.com [EXPECT_COMMIT=<sha>] [DEPLOY_PASSWORD=...] npm run verify:deploy'); process.exit(2); }
let base; try { base = new URL(raw); if (!/^https?:$/.test(base.protocol)) throw new Error('scheme'); } catch { console.error('DEPLOY_URL must be a full http(s) URL, e.g. https://your-service.onrender.com'); process.exit(2); }
const ORIGIN = base.origin;
const EXPECT = String(process.env.EXPECT_COMMIT || '').trim().toLowerCase();
if (EXPECT && !/^[0-9a-f]{7,40}$/.test(EXPECT)) { console.error('EXPECT_COMMIT must be a git sha (7 to 40 hex characters).'); process.exit(2); }
const PASSWORD = process.env.DEPLOY_PASSWORD || '', USERNAME = process.env.DEPLOY_USERNAME || '';
const WAIT = process.env.WAIT_SEC === undefined ? 120 : Math.max(0, Number(process.env.WAIT_SEC) || 0);
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(base.hostname);

let failed = 0, warned = 0;
const out = (tag, msg) => console.log(`${tag.padEnd(5)} ${msg}`);
const pass = m => out('PASS', m), info = m => out('INFO', m);
const fail = m => { failed++; out('FAIL', m); }, warn = m => { warned++; out('WARN', m); };
const check = (cond, good, bad) => (cond ? pass(good) : fail(bad), !!cond);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async (p, { headers = {}, method = 'GET', body } = {}) => {
  const res = await fetch(new URL(p, ORIGIN), { method, redirect: 'manual', headers, body, signal: AbortSignal.timeout(20000) });
  const text = await res.text(); return { status: res.status, headers: res.headers, text };
};

console.log(`Verifying ${ORIGIN}${EXPECT ? ' (expecting commit ' + EXPECT.slice(0, 12) + ')' : ''}`);

/* 1. the service is up (retry: a free Render service takes a while to wake up or to finish a deploy) */
let hz = null, last = '';
const deadline = Date.now() + WAIT * 1000;
for (let attempt = 0; ; attempt++) {
  try {
    const r = await get('/healthz');
    if (r.status === 200) {
      let j = null; try { j = JSON.parse(r.text); } catch { /* an old deploy answers plain "ok" */ }
      hz = { r, j };
      // while waiting for a new deploy to go live, keep trying until the expected commit shows up
      if (!EXPECT || !j || (j.commit && (j.commit.startsWith(EXPECT) || EXPECT.startsWith(j.commit))) || Date.now() >= deadline) break;
      last = `still running commit ${String(j.commit || 'unknown').slice(0, 12)}`;
    } else last = 'HTTP ' + r.status;
  } catch (e) { last = e.name === 'TimeoutError' ? 'timed out' : String((e.cause && e.cause.code) || e.message || e); }
  if (Date.now() >= deadline) break;
  if (attempt === 0) info(`waiting for the service (${last}); retrying for up to ${WAIT} s`);
  await sleep(Math.min(5000, 1000 + attempt * 500));
}
if (!hz) { fail(`/healthz did not answer 200 (${last || 'no answer'}) within ${WAIT} s`); summary(); }
check(true, `/healthz answers 200`, '');
if (!hz.j) fail('/healthz did not return JSON: this is an older build that cannot report its version (redeploy the latest commit)');
else {
  check(hz.j.status === 'ok', '/healthz status is ok', `/healthz status is ${JSON.stringify(hz.j.status)}`);
  check(hz.j.app === 'threadform', 'it is Threadform', `/healthz app is ${JSON.stringify(hz.j.app)}`);
  info(`version ${hz.j.version || 'unknown'}, commit ${hz.j.commit ? hz.j.commit.slice(0, 12) : 'not reported'}`);
  if (EXPECT) {
    if (!hz.j.commit) fail('EXPECT_COMMIT is set but /healthz reports no commit (the service has no RENDER_GIT_COMMIT; on Render it is set automatically for Git deploys)');
    else check(hz.j.commit.startsWith(EXPECT) || EXPECT.startsWith(hz.j.commit), `running the expected commit ${EXPECT.slice(0, 12)}`, `running commit ${hz.j.commit.slice(0, 12)} but expected ${EXPECT.slice(0, 12)} (the new deploy is not live yet, or the wrong branch deployed)`);
  } else if (!hz.j.commit) warn('no commit reported (set EXPECT_COMMIT to verify a specific deploy)');
  const leak = JSON.stringify(hz.j); check(!/password|secret|key|token/i.test(leak), '/healthz carries no secrets', '/healthz body mentions a secret-like word: ' + leak.slice(0, 80));
}

/* 2. security headers (same set on every page; checked on the login page, the one page anybody can load) */
function headerChecks(h, where) {
  const csp = h.get('content-security-policy') || '';
  check(/default-src 'self'/.test(csp) && /connect-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp), `${where}: CSP present and closed`, `${where}: CSP missing or too open: ${csp.slice(0, 80)}`);
  check(!/unsafe-eval/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), `${where}: CSP allows no eval and no inline scripts`, `${where}: CSP allows eval or inline scripts`);
  check(h.get('x-content-type-options') === 'nosniff', `${where}: X-Content-Type-Options nosniff`, `${where}: X-Content-Type-Options missing`);
  check(h.get('x-frame-options') === 'DENY', `${where}: X-Frame-Options DENY`, `${where}: X-Frame-Options missing`);
  check(!!h.get('referrer-policy'), `${where}: Referrer-Policy set`, `${where}: Referrer-Policy missing`);
  check(!!h.get('permissions-policy'), `${where}: Permissions-Policy set`, `${where}: Permissions-Policy missing`);
  check(h.get('cross-origin-opener-policy') === 'same-origin' && h.get('cross-origin-resource-policy') === 'same-origin', `${where}: COOP / CORP same-origin`, `${where}: COOP / CORP missing`);
  check(/no-store|no-cache/.test(h.get('cache-control') || ''), `${where}: not cached by shared caches`, `${where}: Cache-Control missing`);
  check(/noindex/.test(h.get('x-robots-tag') || ''), `${where}: X-Robots-Tag noindex`, `${where}: X-Robots-Tag missing`);
  check(!h.get('x-powered-by'), `${where}: no X-Powered-By`, `${where}: X-Powered-By leaks the stack`);
  if (base.protocol === 'https:') check(/max-age=\d{6,}/.test(h.get('strict-transport-security') || ''), `${where}: HSTS`, `${where}: Strict-Transport-Security missing on https`);
  else if (!local) warn(`${where}: ${ORIGIN} is plain http (use https for a real deploy)`);
}
let gated = true;
try {
  const login = await get('/login', { headers: { accept: 'text/html' } });
  if (login.status === 404) { gated = false; warn('no login page: the site is running OPEN (no SITE_PASSWORD). Anyone can use it.'); }
  else {
    check(login.status === 200 && /<input[^>]+type="password"/i.test(login.text), '/login serves the login form', `/login did not serve a login form (HTTP ${login.status})`);
    check(!/main\.js|__threadform/.test(login.text), '/login contains no studio code', '/login leaks studio code');
    headerChecks(login.headers, '/login');
  }
} catch (e) { fail('/login failed: ' + (e.message || e)); }

/* 3. the gate: nothing but /login and /healthz without a session */
if (gated) {
  for (const p of ['/', '/js/main.js', '/css/style.css', '/api/designs', '/server.mjs', '/.env', '/package.json']) {
    try { const r = await get(p, { headers: { accept: p === '/' ? 'text/html' : '*/*' } }); check([301, 302, 303, 401, 403, 404].includes(r.status) && !/import |SITE_PASSWORD|function/.test(r.text.slice(0, 2000)), `${p} is not served to a visitor who is not logged in (${r.status})`, `${p} answered ${r.status} without a login`); }
    catch (e) { fail(`${p} failed: ${e.message}`); }
  }
}

/* 4. logged in: index.html and everything it loads */
if (!PASSWORD) info('DEPLOY_PASSWORD not set: skipping the logged-in checks (index.html, JavaScript/CSS assets, API status)');
else if (!gated) warn('open site: checking index.html without a login');
if (PASSWORD || !gated) {
  let cookie = '';
  if (gated) {
    const body = new URLSearchParams({ ...(USERNAME ? { username: USERNAME } : {}), password: PASSWORD, next: '/' }).toString();
    const r = await get('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body });
    const sc = r.headers.get('set-cookie') || '';
    if (r.status === 429) fail('login is rate limited (too many recent attempts); wait 15 minutes');
    else if (!check(r.status === 303 && /tf_session=/.test(sc), 'login succeeds', `login failed (HTTP ${r.status}): check DEPLOY_PASSWORD${USERNAME ? ' / DEPLOY_USERNAME' : ''}`)) cookie = '';
    else {
      cookie = sc.split(';')[0];
      check(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc), 'session cookie is HttpOnly + SameSite=Strict', 'session cookie lacks HttpOnly or SameSite=Strict');
      if (base.protocol === 'https:') check(/;\s*Secure/i.test(sc), 'session cookie is Secure', 'session cookie is not marked Secure');
    }
  }
  if (!gated || cookie) {
    const H = cookie ? { cookie } : {};
    const idx = await get('/', { headers: { ...H, accept: 'text/html' } });
    if (check(idx.status === 200 && /<title>/i.test(idx.text), 'index.html loads', `index.html answered ${idx.status}`)) {
      headerChecks(idx.headers, 'index.html');
      const assets = [...idx.text.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map(m => '/' + m[1]);
      check(assets.some(a => /\.js$/.test(a)), 'index.html references the app script', 'index.html references no script');
      const seen = new Set(), queue = [...assets]; let bad = 0, total = 0, bytes = 0;
      while (queue.length) {
        const p = queue.shift(); if (seen.has(p)) continue; seen.add(p);
        let r; try { r = await get(p, { headers: H }); } catch (e) { bad++; fail(`${p} failed: ${e.message}`); continue; }
        total++; bytes += r.text.length;
        const ct = r.headers.get('content-type') || '';
        if (r.status !== 200 || (/\.js$/.test(p) && !/javascript/.test(ct)) || (/\.css$/.test(p) && !/text\/css/.test(ct))) { bad++; fail(`${p} -> HTTP ${r.status} ${ct}`); continue; }
        if (/\.js$/.test(p)) for (const m of r.text.matchAll(/^import\s[^'"]*?from\s+['"](\.[^'"]+)['"]|^import\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/gm)) {
          const rel = m[1] || m[2] || m[3]; const next = new URL(rel, new URL(p, ORIGIN)).pathname; if (!seen.has(next)) queue.push(next);
        }
      }
      check(bad === 0 && total > 30, `all ${total} JavaScript/CSS files load (${(bytes / 1024).toFixed(0)} KB, status 200, correct types)`, `${bad} asset(s) failed to load, ${total} loaded`);
    }
    for (const [p, what] of [['/api/shared/status', 'shared library'], ['/api/ai/status', 'AI']]) {
      try {
        const r = await get(p, { headers: H }); let j = null; try { j = JSON.parse(r.text); } catch { /* not json */ }
        if (check(r.status === 200 && j, `${p} answers JSON`, `${p} answered ${r.status}`)) {
          if (p.includes('shared')) j.enabled ? (j.ok ? pass(`shared library connected (${j.designs} design(s))`) : warn(`shared library is configured but NOT healthy: ${j.error}`)) : info('shared library is off (designs stay in each browser)');
          else info(`AI editing ${j.enabled ? 'on' : 'off (no OPENAI_API_KEY: the built-in engine is used)'}`);
        }
      } catch (e) { fail(`${p} failed: ${e.message}`); }
    }
    if (gated) { try { await get('/logout', { method: 'POST', headers: { ...H, origin: ORIGIN } }); } catch { /* best effort */ } }
  }
}
summary();

function summary() {
  console.log(failed ? `\nverify:deploy FAILED: ${failed} check(s) failed${warned ? `, ${warned} warning(s)` : ''}` : `\nverify:deploy OK${warned ? ` with ${warned} warning(s)` : ''}`);
  process.exit(failed ? 1 : 0);
}
