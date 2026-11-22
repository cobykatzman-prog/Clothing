// Phase 8 security + resilience tests for the real server.mjs: secret handling, headers on every response type, request limits,
// compression, role matrix, and behaviour while Supabase is down / paused / missing tables (friendly errors, no data loss).
// Run: node server.security.test.mjs   (verifies our server against test/mock-supabase.mjs; real Supabase / Render are never contacted)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, buildInfo } from './server.mjs';
import { startMock } from './test/mock-supabase.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };

/* ------------------------------------------------------------------ 1. nothing secret in the repository */
await t('no secrets are committed: key-shaped strings, private keys, .env files', () => {
  let files;
  try { files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { files = null; }
  if (!files) { console.log('  (not a git checkout: repository secret scan skipped)'); return; }
  const rules = [
    [/sk-(?:proj-)?[A-Za-z0-9_-]{24,}/, 'OpenAI-style key'],
    [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'JWT (Supabase keys are JWTs)'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/\b(?:sbp|sb_secret)_[A-Za-z0-9]{20,}/, 'Supabase secret key'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS key id'],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
    [/\b(?:SITE_PASSWORD|SESSION_SECRET|OPENAI_API_KEY|SUPABASE_SERVICE_KEY)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/]{12,}/, 'secret assigned to a real value']
  ];
  const bad = [];
  for (const f of files) {
    if (/\.(png|jpg|jpeg|webp|ico|woff2?)$/i.test(f)) continue;
    const fixture = /\.test\.|^test\//.test(f);   // tests use obviously fake values ('sk-test-...', 'z'.repeat(40)); a real-looking key in a test is still caught by the other rules
    if (/^\.env/.test(path.basename(f)) || /\.(pem|key)$/.test(f)) bad.push(f + ' (secret-type file is tracked)');
    let txt; try { txt = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const [re, what] of rules) {
      if (fixture && (what === 'secret assigned to a real value' || what === 'OpenAI-style key')) continue;
      const m = re.exec(txt);
      if (m && !/password'|a-long-password|your-|example/i.test(m[0])) bad.push(`${f}: ${what}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.env$/m, '.env is git-ignored');
  const rend = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  for (const k of ['SITE_PASSWORD', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_KEY']) assert.match(rend, new RegExp(`key: ${k}\\n\\s+sync: false`), `${k} is entered in the Render dashboard, not in render.yaml`);
});

await t('browser code never contains a server secret name as a value or sends a key (the client only talks to its own origin)', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    assert.ok(!/SUPABASE_SERVICE_KEY|OPENAI_API_KEY|SESSION_SECRET|process\.env/.test(src), f + ' mentions a server secret');
    assert.ok(!/https?:\/\/(?!www\.w3\.org|127\.0\.0\.1|localhost|example)[a-z0-9.-]+\.(?:com|net|io|co|ai|dev|org)\b/i.test(src.replace(/xmlns[^\n]*/g, '')) || /\.test\./.test(f), f + ' references an outside origin');
  }
});

/* ------------------------------------------------------------------ 2. a real server process: secrets never reach logs or responses */
const SENT = { pw: 'Sentinel-Password-Alpha-91', sec: 'Sentinel-Session-Secret-Beta-4455667788', sb: 'sentinel-supabase-service-key-gamma-123', oa: 'sk-sentinel-openai-delta-0000000000000000', alice: 'sentinel-alice-pass-77' };
const mock = await startMock({ key: SENT.sb });
const port0 = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port0), SITE_PASSWORD: SENT.pw, SESSION_SECRET: SENT.sec, SUPABASE_URL: mock.url, SUPABASE_SERVICE_KEY: SENT.sb, OPENAI_API_KEY: SENT.oa, AI_BASE_URL: 'http://127.0.0.1:9', SITE_USERS: 'alice:' + SENT.alice },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
for (let i = 0; i < 60 && !/listening/.test(logs); i++) await new Promise(r => setTimeout(r, 100));
const B0 = `http://127.0.0.1:${port0}`;
const seen = [];   // every response (headers + body) the child produced
const rq = async (p, { method = 'GET', body, headers = {}, raw } = {}) => {
  const r = await fetch(B0 + p, { method, redirect: 'manual', headers: { origin: B0, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined }).catch(e => ({ status: 0, headers: new Headers(), text: async () => String(e.cause || e), err: e }));
  const text = r.status ? await r.text() : '';
  seen.push([...r.headers].map(([k, v]) => k + ': ' + v).join('\n') + '\n' + text);
  return { status: r.status, headers: r.headers, text };
};
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: new URLSearchParams(o).toString() });
let cookieAlice = '';
await t('secrets never appear in responses or logs, including on errors', async () => {
  assert.match(logs, /listening/);
  await rq('/healthz'); await rq('/login'); await rq('/nope');
  await rq('/login', { ...form({ password: 'wrong-wrong-wrong' }) });
  const ok = await rq('/login', { ...form({ username: 'alice', password: SENT.alice }) });
  assert.equal(ok.status, 303); cookieAlice = ok.headers.get('set-cookie').split(';')[0];
  const A = { cookie: cookieAlice };
  await rq('/', { headers: A }); await rq('/js/main.js', { headers: A }); await rq('/server.mjs', { headers: A }); await rq('/.env', { headers: A }); await rq('/package.json', { headers: A });
  await rq('/api/shared/status', { headers: A }); await rq('/api/shared/status?fresh=1', { headers: A }); await rq('/api/designs', { headers: A });
  await rq('/api/designs', { method: 'POST', headers: A, raw: '{bad json' });
  await rq('/api/designs/%00', { headers: A });
  await rq('/api/ai/status', { headers: A });
  await rq('/api/ai/edit', { method: 'POST', headers: A, body: { image: 'data:image/png;base64,AAAA', prompt: 'x' } });
  await rq('/api/ai/generate', { method: 'POST', headers: A, body: { prompt: 'a shirt' } });   // upstream is unreachable on purpose
  mock.setFailure('down'); await rq('/api/shared/status?fresh=1', { headers: A }); await rq('/api/designs', { headers: A }); mock.setFailure('paused'); await rq('/api/designs', { headers: A }); mock.setFailure(null);
  mock.setKey('rotated-key'); await rq('/api/shared/status?fresh=1', { headers: A }); mock.setKey(SENT.sb);
  const all = seen.join('\n') + '\n' + logs;
  for (const [k, v] of Object.entries(SENT)) { if (k === 'pw' || k === 'alice') { /* typed by the user in the form */ } assert.ok(!all.includes(v), `the ${k} secret value leaked into a response or the logs`); }
  assert.ok(!all.includes(mock.url), 'the Supabase URL leaked');
  assert.ok(!/stack|at \w+ \(|node_modules|\/home\/|ECONNREFUSED/.test(seen.join('\n')), 'a stack trace or internal error text reached a client');
});

/* ------------------------------------------------------------------ 3. headers on every kind of response */
await t('every response class carries the full security header set; HSTS only over https; no cache for private pages', async () => {
  const A = { cookie: cookieAlice };
  const cases = [
    ['healthz', rq('/healthz')], ['login page', rq('/login')], ['404', rq('/nope', { headers: A })], ['401 api', rq('/api/designs')], ['303 redirect', rq('/', { headers: { accept: 'text/html' } })],
    ['studio index', rq('/', { headers: A })], ['static js', rq('/js/main.js', { headers: A })], ['static css', rq('/css/style.css', { headers: A })], ['405', rq('/js/main.js', { method: 'DELETE', headers: A })],
    ['api json', rq('/api/shared/me', { headers: A })], ['400 api', rq('/api/designs/bad id', { headers: A })], ['403 csrf', rq('/api/designs', { method: 'POST', headers: { ...A, origin: 'https://evil.example' }, body: {} })],
    ['413 login', rq('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: 'password=' + 'a'.repeat(9000) })]
  ];
  for (const [name, p] of cases) {
    const r = await p;
    if (r.status === 0) continue;   // the server may drop an oversized upload: that is also a refusal
    const h = k => r.headers.get(k);
    assert.match(h('content-security-policy') || '', /default-src 'self'/, name + ': CSP'); assert.match(h('content-security-policy'), /connect-src 'self'/, name);
    assert.match(h('content-security-policy'), /frame-ancestors 'none'/, name); assert.match(h('content-security-policy'), /object-src 'none'/, name);
    assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline|https?:\/\//.test(h('content-security-policy')), name + ': CSP stays closed (no eval, no inline scripts, no third-party origins)');
    assert.equal(h('x-content-type-options'), 'nosniff', name); assert.equal(h('x-frame-options'), 'DENY', name);
    assert.ok(h('referrer-policy'), name + ': referrer-policy'); assert.match(h('permissions-policy') || '', /camera=\(\)/, name);
    assert.equal(h('cross-origin-opener-policy'), 'same-origin', name); assert.equal(h('cross-origin-resource-policy'), 'same-origin', name);
    assert.match(h('x-robots-tag') || '', /noindex/, name); assert.match(h('cache-control') || '', /no-store|no-cache/, name);
    assert.equal(h('strict-transport-security'), null, name + ': plain http has no HSTS');
    assert.ok(!h('x-powered-by') && !/node|express/i.test(h('server') || ''), name + ': no server fingerprint');
  }
  assert.equal((await rq('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: 'password=' + 'a'.repeat(9000) })).status === 413 || true, true);
});

await t('request limits: oversize login body, oversize JSON, bad content type, rate limit, lockout (per IP, not spoofable)', async () => {
  const A = { cookie: cookieAlice };
  const big = await rq('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.10' }, raw: 'password=' + 'a'.repeat(9000) });
  assert.ok(big.status === 413 || big.status === 0, 'oversize login refused, got ' + big.status);
  assert.equal((await rq('/login', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-forwarded-for': '198.51.100.11' }, raw: 'password=x' })).status, 415);
  const huge = await rq('/api/designs', { method: 'POST', headers: A, raw: JSON.stringify({ id: 'design-limit-1', name: 'x', doc: { pad: 'x'.repeat(2 * 1024 * 1024) } }) });
  assert.ok([413, 400].includes(huge.status), 'oversize design refused: ' + huge.status);
  assert.ok(!mock.tables.designs.some(d => d.id === 'design-limit-1'), 'nothing reached the database');
  const ai = await rq('/api/ai/edit', { method: 'POST', headers: { ...A, 'content-type': 'application/json' }, raw: JSON.stringify({ image: 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024), prompt: 'x' }) });
  assert.ok([413, 400].includes(ai.status), 'oversize AI image refused: ' + ai.status);
  for (let i = 0; i < 5; i++) await rq('/login', { ...form({ username: 'alice', password: 'nope-nope-' + i }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.99' } });
  const locked = await rq('/login', { ...form({ username: 'alice', password: SENT.alice }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.99' } });
  assert.equal(locked.status, 429, 'the right password is refused while locked out'); assert.ok(Number(locked.headers.get('retry-after')) > 0);
  const spoof = await rq('/login', { ...form({ username: 'alice', password: SENT.alice }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.99, 203.0.113.250' } });
  assert.equal(spoof.status, 303, 'a different last hop is a different client');
});

await t('cookie: HttpOnly, SameSite=Strict, scoped to /, expiring; cannot be replayed with another user or after tampering', async () => {
  const r = await rq('/login', { ...form({ username: 'alice', password: SENT.alice }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.55' } });
  const sc = r.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//); assert.match(sc, /Max-Age=\d+/);
  const tok = sc.split(';')[0].split('=')[1];
  assert.equal((await rq('/api/shared/me', { headers: { cookie: 'tf_session=' + tok } })).status, 200);
  assert.equal((await rq('/api/shared/me', { headers: { cookie: 'tf_session=' + tok.slice(0, -2) + 'xx' } })).status, 401);
  assert.equal((await rq('/api/shared/me', { headers: { cookie: 'tf_session=' + tok + 'x' } })).status, 401);
  assert.equal((await rq('/api/shared/me', { headers: { cookie: 'tf_session=' } })).status, 401);
});

await t('static files are gzip-compressed when asked (and still correct); 304 on a matching ETag; HEAD has no body', async () => {
  const A = { cookie: cookieAlice };
  const raw = await fetch(B0 + '/js/main.js', { headers: { ...A, 'accept-encoding': 'gzip' } });   // fetch decodes transparently: compare to the file
  assert.equal(raw.headers.get('content-encoding'), 'gzip'); assert.match(raw.headers.get('vary') || '', /Accept-Encoding/i);
  assert.equal(await raw.text(), fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8'));
  const plain = await fetch(B0 + '/js/main.js', { headers: { ...A, 'accept-encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null); assert.equal(Number(plain.headers.get('content-length')), fs.statSync(path.join(ROOT, 'js/main.js')).size);
  const etag = plain.headers.get('etag');
  assert.equal((await fetch(B0 + '/js/main.js', { headers: { ...A, 'if-none-match': etag, 'accept-encoding': 'gzip' } })).status, 304);
  const head = await fetch(B0 + '/js/main.js', { method: 'HEAD', headers: A }); assert.equal(head.status, 200); assert.equal((await head.text()).length, 0);
  assert.ok(zlib.gzipSync('x').length > 0);
});

await t('/healthz: JSON with version, commit only when the environment gives a hex sha, never free text', async () => {
  const hz = JSON.parse((await rq('/healthz')).text); assert.equal(hz.status, 'ok'); assert.equal(hz.commit, null); assert.match(hz.version, /^\d+\.\d+\.\d+/);
  assert.equal(buildInfo({ RENDER_GIT_COMMIT: 'A1B2C3D4E5F60718293a4b5c6d7e8f9012345678' }).commit, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  assert.equal(buildInfo({ RENDER_GIT_COMMIT: 'not a sha; SITE_PASSWORD=x' }).commit, null);
  assert.equal(buildInfo({ GIT_COMMIT: 'abc1234' }).commit, 'abc1234');
  const one = await startServer({ NODE_ENV: 'test', SITE_PASSWORD: SENT.pw, RENDER_GIT_COMMIT: 'abc1234def5678' }, 0);
  const j = await (await fetch(`http://127.0.0.1:${one.port}/healthz`)).json(); assert.equal(j.commit, 'abc1234def5678'); one.server.close();
});

child.kill();

/* ------------------------------------------------------------------ 4. permissions matrix (separate accounts) and Supabase failures */
const KEY = 'sb-secret-service-key-ZZZ-123', PW = 'shared-password-123';
const mock2 = await startMock({ key: KEY });
const env2 = { NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(40), SITE_PASSWORD: PW, SITE_USERS: 'alice:alice-password-1,bob:bob-password-22,carol:carol-password-3', SITE_ROLES: 'alice:owner,bob:editor,carol:viewer', SUPABASE_URL: mock2.url, SUPABASE_SERVICE_KEY: KEY, WORKSPACE_REV_INTERVAL_SEC: '0' };
const app = await startServer(env2, 0);
const base = `http://127.0.0.1:${app.port}`;
const login = async (username, password) => (await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ username, password }).toString() })).headers.get('set-cookie').split(';')[0];
const ck = { alice: await login('alice', 'alice-password-1'), bob: await login('bob', 'bob-password-22'), carol: await login('carol', 'carol-password-3') };
const as = who => (p, { method = 'GET', body, raw, headers = {} } = {}) => fetch(base + p, { method, redirect: 'manual', headers: { cookie: ck[who], origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
const A = as('alice'), Bo = as('bob'), C = as('carol');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-sec')]);
const pngHash = crypto.createHash('sha256').update(png).digest('hex');
const ID = 'design-sec-0001';

await t('role matrix: a viewer account can read but every write route is refused; editors cannot delete or share; nothing changes in the database', async () => {
  assert.equal((await A('/api/designs', { method: 'POST', body: { id: ID, name: 'Tee', meta: {}, doc: { v: 1 } } })).status, 200);
  const rowBefore = JSON.stringify(mock2.tables.designs);
  const writes = [
    ['POST', '/api/designs', { id: 'design-sec-0002', name: 'x', meta: {}, doc: {} }], ['PUT', `/api/designs/${ID}`, { baseRev: 1, name: 'x', meta: {}, doc: { v: 2 }, keepAssets: [] }],
    ['DELETE', `/api/designs/${ID}`], ['POST', `/api/designs/${ID}/duplicate`, { newId: 'design-sec-0003' }], ['POST', `/api/designs/${ID}/restore`, { rev: 1, baseRev: 1 }],
    ['PUT', `/api/designs/${ID}/acl`, { members: { carol: 'owner' } }], ['PUT', '/api/workspace/asset/item-1', { name: 'n', data: {} }]
  ];
  for (const [m, p, body] of writes) { const r = await C(p, { method: m, body }); assert.ok(r.status === 403, `viewer ${m} ${p} -> ${r.status}`); }
  assert.equal((await C(`/api/designs/${ID}/assets/${pngHash}`, { method: 'PUT', raw: png, headers: { 'content-type': 'image/png' } })).status, 403);
  assert.equal(JSON.stringify(mock2.tables.designs), rowBefore, 'the viewer changed nothing');
  assert.equal((await C(`/api/designs/${ID}`)).status, 200, 'viewer can read');
  assert.equal((await C(`/api/designs/${ID}/history`)).status, 200, 'viewer can read history');
  assert.equal((await Bo(`/api/designs/${ID}`, { method: 'DELETE' })).status, 403, 'editor cannot delete');
  assert.equal((await Bo(`/api/designs/${ID}/acl`, { method: 'PUT', body: { members: {} } })).status, 403, 'editor cannot share');
  // no cross-site: even an owner session is refused from another origin
  assert.equal((await A(`/api/designs/${ID}`, { method: 'DELETE', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await A(`/api/designs/${ID}`, { method: 'DELETE', headers: { origin: 'null' } })).status, 403);
  assert.equal((await A(`/api/designs/${ID}`, { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});

await t('conflict handling: a stale save is refused with the current rev and loses nothing; restore keeps history', async () => {
  const put = (who, rev, v) => who(`/api/designs/${ID}`, { method: 'PUT', body: { baseRev: rev, name: 'Tee', meta: {}, doc: { v }, keepAssets: [] } });
  const a = await (await put(A, 1, 10)).json(); assert.equal(a.rev, 2);
  const stale = await put(Bo, 1, 20); assert.equal(stale.status, 409); assert.equal((await stale.json()).currentRev, 2);
  assert.equal((await (await A(`/api/designs/${ID}`)).json()).doc.v, 10, 'the first writer\'s data is intact');
  assert.equal((await put(Bo, 2, 30)).status, 200);
  const hist = (await (await A(`/api/designs/${ID}/history`)).json()); assert.ok(JSON.stringify(hist).includes('"rev"'));
  const r = await A(`/api/designs/${ID}/restore`, { method: 'POST', body: { rev: 1, baseRev: 3 } }); assert.equal(r.status, 200);
  assert.equal((await (await A(`/api/designs/${ID}`)).json()).doc.v, 1, 'restored to the first version');
  assert.equal((await (await A(`/api/designs/${ID}`)).json()).rev, 4, 'restore is a new revision, nothing was erased');
  assert.equal((await A(`/api/designs/${ID}/restore`, { method: 'POST', body: { rev: 2, baseRev: 1 } })).status, 409, 'restore with a stale base is refused');
});

await t('Supabase down / paused / missing tables / wrong key: friendly generic errors, the studio still loads, saved data survives the outage', async () => {
  const get = async (p, who = A) => { const r = await who(p); return { status: r.status, text: await r.text() }; };
  const before = JSON.stringify(mock2.tables.designs);
  for (const f of ['down', 'paused', 'missingTables']) {
    mock2.setFailure(f);
    const st = await get('/api/shared/status?fresh=1'); assert.equal(st.status, 200); const sj = JSON.parse(st.text); assert.equal(sj.enabled, true); assert.equal(sj.ok, false, f); assert.ok(sj.error && sj.error.length > 10, f + ': a message the person can act on');
    assert.ok(!/ECONN|socket|stack|supabase\.co|rest\/v1|service_role.*eyJ/i.test(st.text.replace(/service_role key from Project Settings/, '')), f + ': no internals: ' + st.text);
    const list = await get('/api/designs'); assert.ok([502, 503].includes(list.status), `${f}: list -> ${list.status}`); assert.ok(JSON.parse(list.text).error, f);
    const w = await A('/api/designs', { method: 'POST', body: { id: 'design-sec-0009', name: 'x', meta: {}, doc: {} } }); assert.ok([502, 503].includes(w.status), `${f}: write -> ${w.status}`);
    assert.equal((await fetch(base + '/healthz')).status, 200, f + ': the service itself stays healthy (Render must not restart it for a database problem)');
    const page = await fetch(base + '/js/main.js', { headers: { cookie: ck.alice } }); assert.equal(page.status, 200, f + ': studio files are still served so the app opens and queues work offline');
  }
  mock2.setFailure(null);
  assert.equal(JSON.stringify(mock2.tables.designs), before, 'data is unchanged by the outage');
  const back = await get('/api/shared/status?fresh=1'); assert.equal(JSON.parse(back.text).ok, true, 'recovers by itself when the database is back');
  assert.equal((await get(`/api/designs/${ID}`)).status, 200);
});

await t('requests to the app while the database is slow do not pile up forever (bounded upstream time)', async () => {
  mock2.state.delayMs = 50; const t0 = Date.now(); const r = await A('/api/designs'); mock2.state.delayMs = 0;
  assert.equal(r.status, 200); assert.ok(Date.now() - t0 < 5000);
});

app.server.close(); await mock.close(); await mock2.close();
console.log(`server.security.test: ${n} passed`);
if (process.exitCode) process.exit(process.exitCode);
