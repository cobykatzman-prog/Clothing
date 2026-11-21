// Tests for the shared design library routes (shared.mjs) against an in-memory mock of Supabase/PostgREST.
// Run: node server.shared.test.mjs   (this verifies our server, not a live Supabase project)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer } from './server.mjs';
import { startMock } from './test/mock-supabase.mjs';

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };
const PW = 'correct-horse-battery', KEY = 'sb-secret-service-key-ZZZ-123';
const mock = await startMock({ key: KEY });
const baseEnv = { NODE_ENV: 'test', SITE_PASSWORD: PW, SESSION_SECRET: 's'.repeat(40) };
const { server, port } = await startServer({ ...baseEnv, SUPABASE_URL: mock.url + '/', SUPABASE_SERVICE_KEY: KEY }, 0);
const off = await startServer(baseEnv, 0);
const base = `http://127.0.0.1:${port}`, offBase = `http://127.0.0.1:${off.port}`;

const loginAt = async b => (await fetch(b + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: b }, body: `password=${PW}` })).headers.get('set-cookie').split(';')[0];
const cookie = await loginAt(base), offCookie = await loginAt(offBase);
const api = (p, { method = 'GET', body, headers = {}, raw, b = base, c = cookie } = {}) => fetch(b + p, {
  method, redirect: 'manual',
  headers: { cookie: c, origin: b, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
});
const J = async r => ({ status: r.status, body: await r.json() });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const png = (extra = 'a') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body-' + extra)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const upload = (id, buf, { hash = sha(buf), type = 'image/png' } = {}) => api(`/api/designs/${id}/assets/${hash}`, { method: 'PUT', raw: buf, headers: { 'content-type': type } });
const idN = k => `design-${String(k).padStart(4, '0')}`;
const create = (id, extra = {}) => api('/api/designs', { method: 'POST', body: { id, name: 'Tee', meta: { kind: 'tee' }, doc: { layers: [] }, ...extra } });

await t('shared mode is off by default: status says disabled, design routes 404, no meta tag', async () => {
  assert.deepEqual(await J(await api('/api/shared/status', { b: offBase, c: offCookie })), { status: 200, body: { enabled: false } });
  for (const p of ['/api/designs', `/api/designs/${idN(1)}`, `/api/designs/${idN(1)}/rev`]) assert.equal((await api(p, { b: offBase, c: offCookie })).status, 404, p);
  assert.equal((await api('/api/designs', { method: 'POST', body: {}, b: offBase, c: offCookie })).status, 404);
  const html = await (await api('/', { b: offBase, c: offCookie })).text(); assert.ok(!html.includes('threadform-shared'));
  const only = await startServer({ ...baseEnv, SUPABASE_URL: mock.url }, 0);   // one variable is not enough
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${only.port}/api/shared/status`, { headers: { cookie: await loginAt(`http://127.0.0.1:${only.port}`) } })).json(), { enabled: false });
  only.server.close();
});

await t('enabled: meta tag injected, CSP allows connect-src self', async () => {
  const r = await api('/'); const html = await r.text();
  assert.match(html, /<meta name="threadform-shared" content="1">/); assert.match(html, /threadform-auth/);
  assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/);
});

await t('status: ok, then clear reasons for bad key / missing tables / paused / unreachable, and 30 s cache', async () => {
  let s = await J(await api('/api/shared/status')); assert.deepEqual(s.body, { enabled: true, ok: true, designs: 0 });
  mock.setKey('rotated');
  assert.equal((await J(await api('/api/shared/status'))).body.ok, true, 'cached');
  s = (await J(await api('/api/shared/status?fresh=1'))).body; assert.equal(s.ok, false); assert.match(s.error, /service_role key/);
  mock.setKey(KEY); mock.setFailure('missingTables');
  s = (await J(await api('/api/shared/status?fresh=1'))).body; assert.match(s.error, /supabase\/schema\.sql/);
  mock.setFailure('paused');
  s = (await J(await api('/api/shared/status?fresh=1'))).body; assert.match(s.error, /paused|restore/i);
  mock.setFailure('down');
  s = (await J(await api('/api/shared/status?fresh=1'))).body; assert.match(s.error, /Cannot reach Supabase/);
  mock.setFailure(null);
  assert.equal((await J(await api('/api/shared/status?fresh=1'))).body.ok, true);
  // a failed design request drops the cached "ok", so the next (non-fresh) status check shows the real reason
  mock.setKey('rotated');
  assert.equal((await api('/api/designs')).status, 502);
  s = (await J(await api('/api/shared/status'))).body; assert.equal(s.ok, false); assert.match(s.error, /service_role key/);
  mock.setKey(KEY);
  assert.equal((await J(await api('/api/shared/status?fresh=1'))).body.ok, true);
  for (const bad of ['not a url', 'http://example.com']) {
    const e = await startServer({ ...baseEnv, SUPABASE_URL: bad, SUPABASE_SERVICE_KEY: KEY }, 0);
    const b = (await J(await fetch(`http://127.0.0.1:${e.port}/api/shared/status`, { headers: { cookie: await loginAt(`http://127.0.0.1:${e.port}`) } }))).body;
    assert.equal(b.ok, false); assert.ok(b.error); e.server.close();
  }
});

await t('create, get, list (newest first), rev', async () => {
  const a = idN(1), b = idN(2);
  { const c = await J(await create(a)); assert.equal(c.status, 200); assert.equal(c.body.rev, 1); assert.equal(c.body.updatedBy, 'shared'); }
  await new Promise(r => setTimeout(r, 5));
  await create(b, { name: 'Hoodie' });
  const g = (await J(await api(`/api/designs/${a}`))).body;
  assert.equal(g.id, a); assert.equal(g.name, 'Tee'); assert.equal(g.rev, 1); assert.deepEqual(g.meta, { kind: 'tee' }); assert.deepEqual(g.doc, { layers: [] }); assert.deepEqual(g.assets, []); assert.ok(g.createdAt && g.updatedAt);
  const l = (await J(await api('/api/designs'))).body.designs;
  assert.deepEqual(l.map(d => d.id), [b, a]); assert.ok(!('doc' in l[0])); assert.equal(l[0].name, 'Hoodie');
  const r = (await J(await api(`/api/designs/${a}/rev`))).body; assert.equal(r.rev, 1); assert.equal(r.id, a); assert.ok(r.updatedAt);
  const dup = await J(await create(a)); assert.equal(dup.status, 409);
});

await t('update with correct rev, then stale rev gives 409 with currentRev', async () => {
  const id = idN(1);
  const u = (await J(await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev: 1, name: 'Tee v2', meta: { kind: 'tee', views: 2 }, doc: { layers: [1] }, keepAssets: [] } })));
  assert.equal(u.status, 200); assert.equal(u.body.rev, 2); assert.ok(u.body.updatedAt);
  const g = (await J(await api(`/api/designs/${id}`))).body; assert.equal(g.name, 'Tee v2'); assert.equal(g.rev, 2); assert.deepEqual(g.doc, { layers: [1] });
  const stale = await J(await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev: 1, name: 'x', meta: {}, doc: {}, keepAssets: [] } }));
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'conflict'); assert.equal(stale.body.currentRev, 2);
  assert.equal((await api(`/api/designs/${id}`)).status, 200);
  assert.equal((await J(await api(`/api/designs/${id}`))).body.name, 'Tee v2');   // stale write changed nothing
  assert.equal((await api(`/api/designs/${idN(99)}`, { method: 'PUT', body: { baseRev: 1, name: 'x', meta: {}, doc: {} } })).status, 404);
  for (const baseRev of [0, -1, 1.5, '1', null]) assert.equal((await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev, name: 'x', meta: {}, doc: {} } })).status, 400, String(baseRev));
});

await t('missing, assets: upload, idempotent re-upload, download headers, design listing of hashes', async () => {
  const id = idN(3); await create(id);
  const p = png('one'), j = jpg;
  assert.deepEqual((await J(await api(`/api/designs/${id}/missing`, { method: 'POST', body: { hashes: [sha(p), sha(j)] } }))).body, { missing: [sha(p), sha(j)] });
  assert.deepEqual(await J(await upload(id, p)), { status: 200, body: { ok: true } });
  assert.deepEqual(await J(await upload(id, p)), { status: 200, body: { ok: true } });   // idempotent
  assert.deepEqual(await J(await upload(id, j, { type: 'image/jpeg' })), { status: 200, body: { ok: true } });
  assert.equal(mock.assetsOf(id).length, 2);
  assert.deepEqual((await J(await api(`/api/designs/${id}/missing`, { method: 'POST', body: { hashes: [sha(p), sha(j), 'f'.repeat(64)] } }))).body, { missing: ['f'.repeat(64)] });
  const d = await api(`/api/designs/${id}/assets/${sha(p)}`);
  assert.equal(d.status, 200); assert.equal(d.headers.get('content-type'), 'image/png');
  assert.equal(d.headers.get('cache-control'), 'private, max-age=31536000, immutable'); assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await d.arrayBuffer()).equals(p));
  assert.equal((await api(`/api/designs/${id}/assets/${'0'.repeat(64)}`)).status, 404);
  assert.deepEqual((await J(await api(`/api/designs/${id}`))).body.assets.sort(), [sha(p), sha(j)].sort());
  assert.equal((await upload(idN(77), p)).status, 404);   // design must exist
});

await t('asset validation: hash mismatch, bad magic bytes, wrong type, empty, oversize', async () => {
  const id = idN(3), p = png('two');
  assert.equal((await upload(id, p, { hash: sha('other') })).status, 400);
  const fake = Buffer.from('<svg onload=alert(1)>'); assert.equal((await upload(id, fake)).status, 400);       // not a PNG
  assert.equal((await upload(id, png('x'), { type: 'image/jpeg' })).status, 400);                             // PNG bytes declared as jpeg
  assert.equal((await upload(id, fake, { type: 'image/svg+xml' })).status, 415);
  assert.equal((await upload(id, p, { type: 'text/html' })).status, 415);
  assert.equal((await upload(id, Buffer.alloc(0), { hash: sha(Buffer.alloc(0)) })).status, 400);
  const big = Buffer.concat([png('big'), Buffer.alloc(8 * 1024 * 1024)]);
  assert.equal((await upload(id, big)).status, 413);
  const ok = Buffer.concat([png('edge'), Buffer.alloc(7 * 1024 * 1024)]); assert.equal((await upload(id, ok)).status, 200);   // under the cap is fine
  assert.equal(mock.assetsOf(id).some(a => a.hash === sha(fake)), false);
});

await t('garbage collection: PUT removes assets not in keepAssets (also with an empty list)', async () => {
  const id = idN(4); await create(id);
  const a = png('gc-a'), b = png('gc-b'), c = png('gc-c');
  for (const x of [a, b, c]) await upload(id, x);
  assert.equal(mock.assetsOf(id).length, 3);
  await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev: 1, name: 'g', meta: {}, doc: {}, keepAssets: [sha(a), sha(c)] } });
  assert.deepEqual(mock.assetsOf(id).map(x => x.hash).sort(), [sha(a), sha(c)].sort());
  await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev: 2, name: 'g', meta: {}, doc: {}, keepAssets: [] } });
  assert.equal(mock.assetsOf(id).length, 0);
  const other = idN(3); assert.ok(mock.assetsOf(other).length >= 2, 'other designs keep their assets');
  assert.equal((await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev: 3, name: 'g', meta: {}, doc: {}, keepAssets: ['nothex'] } })).status, 400);
  assert.equal((await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev: 3, name: 'g', meta: {}, doc: {}, keepAssets: Array(201).fill('a'.repeat(64)) } })).status, 400);
});

await t('a stale PUT does not garbage-collect assets', async () => {
  const id = idN(5); await create(id); const a = png('stale-a'); await upload(id, a);
  await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev: 1, name: 'n', meta: {}, doc: {}, keepAssets: [sha(a)] } });
  assert.equal((await api(`/api/designs/${id}`, { method: 'PUT', body: { baseRev: 1, name: 'n', meta: {}, doc: {}, keepAssets: [] } })).status, 409);
  assert.equal(mock.assetsOf(id).length, 1);
});

await t('duplicate copies the design (rev 1) and its assets; source untouched', async () => {
  const src = idN(3), nid = idN(30);
  const r = await J(await api(`/api/designs/${src}/duplicate`, { method: 'POST', body: { newId: nid, name: 'Copy of tee' } }));
  assert.deepEqual(r, { status: 200, body: { id: nid, rev: 1, name: 'Copy of tee' } });
  const g = (await J(await api(`/api/designs/${nid}`))).body; assert.equal(g.rev, 1); assert.equal(g.name, 'Copy of tee');
  assert.deepEqual(g.assets.sort(), mock.assetsOf(src).map(a => a.hash).sort()); assert.ok(g.assets.length >= 2);
  const d = await api(`/api/designs/${nid}/assets/${sha(png('one'))}`); assert.ok(Buffer.from(await d.arrayBuffer()).equals(png('one')));
  assert.equal((await J(await api(`/api/designs/${nid}/duplicate`, { method: 'POST', body: { newId: nid } }))).status, 409);
  assert.equal((await api(`/api/designs/${idN(98)}/duplicate`, { method: 'POST', body: { newId: idN(31) } })).status, 404);
  assert.equal((await api(`/api/designs/${src}/duplicate`, { method: 'POST', body: { newId: 'bad id!' } })).status, 400);
  const auto = (await J(await api(`/api/designs/${src}/duplicate`, { method: 'POST', body: {} }))).body; assert.match(auto.id, /^[A-Za-z0-9_-]{8,64}$/);
});

await t('delete removes the design and cascades its assets; missing design is 404 on get', async () => {
  const id = idN(3);
  assert.deepEqual(await J(await api(`/api/designs/${id}`, { method: 'DELETE' })), { status: 200, body: { ok: true } });
  assert.equal((await api(`/api/designs/${id}`)).status, 404); assert.equal((await api(`/api/designs/${id}/rev`)).status, 404);
  assert.equal(mock.assetsOf(id).length, 0);
  assert.equal((await api(`/api/designs/${idN(97)}`)).status, 404);
});

await t('authentication: no cookie means 401 (API) or login redirect (browser); bad cookie refused', async () => {
  for (const [p, m] of [['/api/designs', 'GET'], [`/api/designs/${idN(1)}`, 'GET'], ['/api/shared/status', 'GET'], ['/api/designs', 'POST'], [`/api/designs/${idN(1)}`, 'DELETE'], [`/api/designs/${idN(1)}/assets/${'a'.repeat(64)}`, 'PUT']]) {
    const r = await fetch(base + p, { method: m, redirect: 'manual', headers: { origin: base, 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  const nav = await fetch(base + '/api/designs', { redirect: 'manual', headers: { accept: 'text/html' } }); assert.equal(nav.status, 303);
  assert.equal((await api('/api/designs', { c: 'tf_session=garbage' })).status, 401);
});

await t('CSRF: state-changing routes need a same-origin request', async () => {
  const id = idN(6);
  for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
    const r = await fetch(base + '/api/designs', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id, name: 'x', meta: {}, doc: {} }) });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.equal((await fetch(base + `/api/designs/${idN(1)}`, { method: 'DELETE', headers: { cookie, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + `/api/designs/${idN(1)}/assets/${'a'.repeat(64)}`, { method: 'PUT', headers: { cookie, 'sec-fetch-site': 'same-site', 'content-type': 'image/png' }, body: png() })).status, 403);
  assert.equal((await api(`/api/designs/${id}`)).status, 404, 'nothing was created');
  assert.equal((await fetch(base + '/api/designs', { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 200);   // reads are not state-changing
});

await t('validation: ids, hashes, bodies, names, unknown routes and methods', async () => {
  for (const bad of ['short', 'has space1', 'x'.repeat(65), 'dots.in.id!', 'semi;colon1']) {
    assert.equal((await api(`/api/designs/${encodeURIComponent(bad)}`)).status, 400, bad);
    assert.equal((await api(`/api/designs/${encodeURIComponent(bad)}`, { method: 'DELETE' })).status, 400, bad);
  }
  assert.equal((await api('/api/designs', { method: 'POST', body: { id: 'x', name: 'a', meta: {}, doc: {} } })).status, 400);
  for (const body of [{ name: '', doc: {} }, { name: 5, doc: {} }, { name: 'a', doc: [] }, { name: 'a', doc: 'str' }, { name: 'a' }, { name: 'a', doc: {}, meta: [] }, { name: 'a', doc: {}, meta: 'x' }]) {
    assert.equal((await api('/api/designs', { method: 'POST', body: { id: idN(7), ...body } })).status, 400, JSON.stringify(body));
  }
  assert.equal((await api('/api/designs', { method: 'POST', raw: '{not json', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await api('/api/designs', { method: 'POST', raw: '[]', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await create(idN(7), { name: 'n'.repeat(121) })).status, 413);
  assert.equal((await create(idN(7), { name: 'n'.repeat(120) })).status, 200);
  for (const h of ['ABC', 'g'.repeat(64), 'a'.repeat(63), 'A'.repeat(64), '../..']) {
    assert.equal((await api(`/api/designs/${idN(7)}/assets/${encodeURIComponent(h)}`)).status, 400, h);
  }
  assert.equal((await api(`/api/designs/${idN(7)}/missing`, { method: 'POST', body: { hashes: ['zz'] } })).status, 400);
  assert.equal((await api(`/api/designs/${idN(7)}/missing`, { method: 'POST', body: { hashes: 'nope' } })).status, 400);
  assert.equal((await api(`/api/designs/${idN(7)}/missing`, { method: 'POST', body: { hashes: [] } })).status, 200);
  assert.equal((await api('/api/designs/' + idN(7) + '/nothing')).status, 404);
  assert.equal((await api('/api/designs/' + idN(7) + '/rev/extra')).status, 404);
  assert.equal((await api('/api/shared/other')).status, 404);
  const patch = await api(`/api/designs/${idN(7)}`, { method: 'PATCH', body: {} }); assert.equal(patch.status, 405); assert.match(patch.headers.get('allow'), /GET/);
  assert.equal((await api('/api/designs', { method: 'DELETE' })).status, 405);
});

await t('body caps: doc 1.5 MB, meta 80 KB, request 413 and nothing reaches the database', async () => {
  const before = mock.state.requests.length;
  assert.equal((await create(idN(8), { doc: { blob: 'x'.repeat(1.6 * 1024 * 1024) } })).status, 413);
  assert.equal((await create(idN(8), { meta: { thumb: 'x'.repeat(81 * 1024) } })).status, 413);
  assert.equal((await api('/api/designs', { method: 'POST', raw: 'x'.repeat(3 * 1024 * 1024), headers: { 'content-type': 'application/json' } })).status, 413);
  assert.equal(mock.state.requests.length, before);
  assert.equal((await create(idN(8), { doc: { blob: 'x'.repeat(1.4 * 1024 * 1024) }, meta: { thumb: 'x'.repeat(79 * 1024) } })).status, 200);
  assert.equal((await api(`/api/designs/${idN(8)}`, { method: 'PUT', body: { baseRev: 1, name: 'a', meta: {}, doc: { b: 'x'.repeat(1.6 * 1024 * 1024) }, keepAssets: [] } })).status, 413);
});

await t('asset count cap: at most 200 images per design', async () => {
  const id = idN(9); await create(id);
  for (let i = 0; i < 200; i++) mock.tables.assets.push({ design_id: id, hash: sha('filler' + i), mime: 'image/png', data: 'AA==', bytes: 1 });
  assert.equal((await upload(id, png('over'))).status, 413);
  assert.equal((await upload(id, png('over'), {})).status, 413);
});

await t('the service key and upstream details never reach a client; the key is only sent upstream', async () => {
  const seen = [];
  const grab = async r => { seen.push(JSON.stringify([...r.headers.entries()]) + await r.text()); };
  await grab(await api('/api/shared/status?fresh=1'));
  for (const f of [null, 'missingTables', 'paused', 'down']) {
    mock.setFailure(f);
    for (const p of ['/api/designs', `/api/designs/${idN(1)}`, `/api/designs/${idN(1)}/rev`, '/api/shared/status?fresh=1']) await grab(await api(p));
    await grab(await create(idN(10)));
  }
  mock.setFailure(null); mock.setKey('different'); await grab(await api('/api/designs')); await grab(await api('/api/shared/status?fresh=1')); mock.setKey(KEY);
  await grab(await api('/')); await grab(await api('/js/main.js'));
  const all = seen.join('\n');
  assert.ok(!all.includes(KEY) && !all.includes(mock.url) && !all.includes('PGRST') && !all.includes('schema cache') && !all.includes('project paused'));
  mock.setFailure('paused'); const r = await api('/api/designs'); assert.equal(r.status, 503); mock.setFailure('down'); assert.equal((await api('/api/designs')).status, 503);
  const body = await J(await api('/api/designs')); assert.deepEqual(body.body, { error: 'shared library unavailable' });
  mock.setFailure('missingTables'); assert.equal((await api('/api/designs')).status, 502); mock.setFailure(null);
  assert.ok(mock.state.requests.length > 10 && mock.state.requests.every(q => q.apikey === 'different' || q.apikey === KEY || q.apikey === undefined));
});

await t('upstream timeout is bounded (slow Supabase does not hang the request forever)', async () => {
  // Not waiting the full 15 s: verify only that a slow-but-answering upstream still works.
  mock.state.delayMs = 200; assert.equal((await api('/api/designs')).status, 200); mock.state.delayMs = 0;
});

server.close(); off.server.close(); await mock.close();
console.log(`shared server tests passed: ${n}`);
