// Tests for the login gate in server.mjs. Run: node server.test.mjs
import assert from 'node:assert/strict';
import { startServer, createApp } from './server.mjs';

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };
const PW = 'correct-horse-battery';
const env = { NODE_ENV: 'test', SITE_PASSWORD: PW, SESSION_SECRET: 's'.repeat(40) };

const { server, port } = await startServer(env, 0);
const base = `http://127.0.0.1:${port}`;
const get = (p, o = {}) => fetch(base + p, { redirect: 'manual', ...o });
const post = (p, form, headers = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...headers }, body: new URLSearchParams(form).toString() });
const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
const login = async (pw = PW, extra = {}) => post('/login', { password: pw, ...extra });
const session = async () => cookieOf(await login());

await t('unauthenticated: studio files are never served, only redirects to login', async () => {
  for (const p of ['/', '/index.html', '/js/main.js', '/css/style.css', '/js/state.js']) {
    const r = await get(p, { headers: { accept: 'text/html' } });
    assert.equal(r.status, 303, p); assert.match(r.headers.get('location'), /^\/login/);
    assert.equal(await r.text(), '');
  }
  for (const accept of ['*/*', 'application/json', 'text/javascript']) {      // non-navigation requests get a plain 401
    const r = await get('/js/main.js', { headers: { accept } }); assert.equal(r.status, 401, accept); assert.ok(!(await r.text()).includes('import'));
  }
});

await t('login page: form, hardened headers, no studio content', async () => {
  const r = await get('/login'); const body = await r.text();
  assert.equal(r.status, 200); assert.match(body, /<form method="post" action="\/login"/); assert.match(body, /type="password"/);
  assert.ok(!/main\.js|index\.html/.test(body));
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/); assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('x-robots-tag'), /noindex/); assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal(r.headers.get('strict-transport-security'), null);   // plain http in the test: HSTS only over https
});

await t('wrong password: back to login with an error, no cookie', async () => {
  const r = await login('nope-nope-nope');
  assert.equal(r.status, 303); assert.match(r.headers.get('location'), /^\/login\?e=1/); assert.equal(r.headers.get('set-cookie'), null);
  const page = await (await get(r.headers.get('location'))).text();
  assert.match(page, /did not match/);
});

await t('right password: cookie is HttpOnly + SameSite=Strict and unlocks the studio', async () => {
  const r = await login(); assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/');
  const sc = r.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//); assert.match(sc, /Max-Age=\d+/);
  const c = cookieOf(r);
  const home = await get('/', { headers: { cookie: c } }); const html = await home.text();
  assert.equal(home.status, 200); assert.match(html, /<meta name="threadform-auth" content="1">/); assert.match(home.headers.get('content-type'), /text\/html/);
  const js = await get('/js/main.js', { headers: { cookie: c } });
  assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  const css = await get('/css/style.css', { headers: { cookie: c } }); assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/);
  const etag = js.headers.get('etag'); assert.ok(etag);
  assert.equal((await get('/js/main.js', { headers: { cookie: c, 'if-none-match': etag } })).status, 304);
  assert.equal((await get('/login', { headers: { cookie: c } })).status, 303);   // already logged in -> straight to the app
});

await t('only the studio files are served: no source, config, tests, dotfiles or traversal', async () => {
  const c = await session();
  const bad = ['/server.mjs', '/server.test.mjs', '/package.json', '/render.yaml', '/vercel.json', '/README.md', '/CONTRACT.md', '/.git/config', '/.gitignore',
    '/js/prompt.test.mjs', '/js/../server.mjs', '/%2e%2e/server.mjs', '/js/%2e%2e/%2e%2e/server.mjs', '/js/..%2fserver.mjs', '/js/.hidden', '/css/', '/js/', '/js', '/%00', '/js/main.js%00.png',
    '/..%5cserver.mjs', '/js/\\..\\server.mjs', '//etc/passwd', '/nonexistent.html'];
  for (const p of bad) { const r = await get(p, { headers: { cookie: c } }); assert.ok([404, 400].includes(r.status) || r.status === 303 && r.headers.get('location') === '/login', `${p} -> ${r.status}`); assert.notEqual(r.status, 200, p); }
  const body = await (await get('/server.mjs', { headers: { cookie: c } })).text(); assert.ok(!body.includes('SITE_PASSWORD'));
});

await t('forged, tampered, expired and malformed cookies are rejected', async () => {
  const real = (await session()).split('=')[1];
  const [exp, sig] = real.split('.');
  const bad = [`tf_session=${exp}.${sig.slice(0, -2)}AA`, `tf_session=${Number(exp) + 1000}.${sig}`, 'tf_session=garbage', 'tf_session=', `tf_session=1.${sig}`, `tf_session=${exp}.${sig}.extra`, 'tf_session=9999999999999.abc'];
  for (const c of bad) assert.equal((await get('/', { headers: { cookie: c, accept: 'text/html' } })).status, 303, c);
  const app = createApp(env);
  const tok = app.makeToken(Date.now() - 8 * 86400000);   // issued 8 days ago, so expired
  assert.equal(app.validToken(tok), false);
  assert.equal(app.validToken(app.makeToken()), true);
});

await t('a different SESSION_SECRET or password invalidates old cookies', async () => {
  const c = await session();
  const a = await startServer({ ...env, SESSION_SECRET: 'z'.repeat(40) }, 0), b = await startServer({ ...env, SITE_PASSWORD: 'another-password-1' }, 0);
  for (const s of [a, b]) { const r = await fetch(`http://127.0.0.1:${s.port}/`, { redirect: 'manual', headers: { cookie: c, accept: 'text/html' } }); assert.equal(r.status, 303); s.server.close(); }
});

await t('login POST needs a same-origin Origin/Referer (CSRF)', async () => {
  const noOrigin = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${PW}` });
  assert.equal(noOrigin.status, 403);
  assert.equal((await login(PW, {}).then(() => post('/login', { password: PW }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await post('/login', { password: PW }, { origin: '', referer: base + '/login' })).status, 303);
  // what a real browser sends: "Origin: null" under a strict referrer policy, so the Referer decides
  assert.equal((await post('/login', { password: PW }, { origin: 'null', referer: base + '/login' })).status, 303);
  assert.equal((await post('/login', { password: PW }, { origin: 'null', referer: 'https://evil.example/' })).status, 403);
  assert.equal((await post('/login', { password: PW }, { origin: 'null' })).status, 403);
  // Sec-Fetch-Site is browser-asserted and decisive when present
  assert.equal((await post('/login', { password: PW }, { 'sec-fetch-site': 'same-origin' })).status, 303);
  assert.equal((await post('/login', { password: PW }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/login', { password: PW }, { 'sec-fetch-site': 'same-site' })).status, 403);
  const plain = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', origin: base }, body: '{}' }); assert.equal(plain.status, 415);
  const big = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: 'password=' + 'a'.repeat(20000) }).catch(e => ({ status: 'reset' }));
  assert.ok([413, 'reset', 303].includes(big.status) && big.status !== 200);
});

await t('open-redirect is blocked: next must be a local path', async () => {
  for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '/login', '/logout']) {
    const r = await login(PW, { next }); assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/', next);
  }
  assert.equal((await login(PW, { next: '/css/style.css' })).headers.get('location'), '/css/style.css');
  const page = await (await get('/login?next=%22%3E%3Cscript%3Ealert(1)%3C/script%3E')).text();
  assert.ok(!page.includes('<script>alert')); assert.match(page, /name="next" value="\/"/);
});

await t('logout clears the cookie and needs POST + same origin', async () => {
  const c = await session();
  assert.equal((await get('/logout', { headers: { cookie: c } })).status, 405);
  assert.equal((await post('/logout', {}, { cookie: c, origin: 'https://evil.example' })).status, 403);
  const r = await post('/logout', {}, { cookie: c }); assert.equal(r.status, 303); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

await t('brute force: 5 wrong passwords per IP, then 429 even for the right one', async () => {
  const h = { 'x-forwarded-for': '203.0.113.9' };
  for (let i = 0; i < 5; i++) assert.equal((await post('/login', { password: 'wrong-' + i }, h)).status, 303);
  const r = await post('/login', { password: PW }, h); assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal((await post('/login', { password: PW }, { 'x-forwarded-for': '198.51.100.7' })).status, 303);   // another IP is unaffected
  // a spoofed first x-forwarded-for entry does not buy fresh attempts (only the last, proxy-added entry counts)
  assert.equal((await post('/login', { password: PW }, { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })).status, 429);
});

await t('username mode: both username and password required', async () => {
  const s = await startServer({ ...env, SITE_USERNAME: 'coby' }, 0); const u = `http://127.0.0.1:${s.port}`;
  const p = (form) => fetch(u + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: u }, body: new URLSearchParams(form).toString() });
  assert.match((await p({ username: 'coby', password: 'bad-password-1' })).headers.get('location'), /e=1/);
  assert.match((await p({ username: 'other', password: PW })).headers.get('location'), /e=1/);
  assert.equal((await p({ username: 'coby', password: PW })).headers.get('location'), '/');
  assert.match(await (await fetch(u + '/login')).text(), /name="username"/);
  s.server.close();
});

await t('production: Secure cookie + HSTS, and the server refuses to start without a password', async () => {
  const s = await startServer({ ...env, NODE_ENV: 'production' }, 0); const u = `http://127.0.0.1:${s.port}`;
  const r = await fetch(u + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: u }, body: `password=${PW}` });
  assert.match(r.headers.get('set-cookie'), /; Secure/); assert.match((await fetch(u + '/login')).headers.get('strict-transport-security'), /max-age/);
  s.server.close();
  assert.throws(() => createApp({ NODE_ENV: 'production' }), /SITE_PASSWORD is not set/);
  assert.throws(() => createApp({ NODE_ENV: 'production', SITE_PASSWORD: '' }), /SITE_PASSWORD is not set/);
  assert.throws(() => createApp({ SITE_PASSWORD: 'short' }), /at least 8/);
  assert.doesNotThrow(() => createApp({ NODE_ENV: 'production', ALLOW_OPEN: '1' }));
});

await t('open (dev) mode with no password serves the studio and has no login routes', async () => {
  const s = await startServer({ NODE_ENV: 'test' }, 0); const u = `http://127.0.0.1:${s.port}`;
  const r = await fetch(u + '/'); const html = await r.text(); assert.equal(r.status, 200); assert.ok(!html.includes('threadform-auth'));
  assert.equal((await fetch(u + '/server.mjs')).status, 404); assert.equal((await fetch(u + '/healthz')).status, 200);
  s.server.close();
});

await t('API requests are rate limited after login', async () => {
  const c = await session();
  let last;
  for (let i = 0; i < 241; i++) {
    last = await get('/api/shared/status', { headers: { cookie: c } });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});

await t('healthz is public and reveals nothing; methods are restricted', async () => {
  const r = await get('/healthz'); assert.equal(r.status, 200); assert.equal(await r.text(), 'ok');
  const c = await session();
  assert.equal((await fetch(base + '/', { method: 'POST', redirect: 'manual', headers: { cookie: c } })).status, 405);
  assert.equal((await fetch(base + '/js/main.js', { method: 'DELETE', redirect: 'manual', headers: { cookie: c } })).status, 405);
});

server.close();
console.log(`server tests passed: ${n}`);
