// Tests for Phase 3: individual users, per-design permissions, last-edited-by, version history/restore, inline-image guard and the
// shared Brand Kit, against test/mock-supabase.mjs. Run: node server.workspace.test.mjs  (verifies our server, not a live Supabase project)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, createApp, parseIdentities } from './server.mjs';
import { startMock } from './test/mock-supabase.mjs';

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };
const KEY = 'sb-secret-service-key-ZZZ-123', PW = 'shared-password-123';
const mock = await startMock({ key: KEY });
const env = {
  NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(40), SITE_PASSWORD: PW,
  SITE_USERS: 'Alice:alice-password-1,bob:bob-password-22,carol:carol-password-3', SITE_ROLES: 'alice:owner,bob:editor,carol:viewer',
  SITE_SHARED_ROLE: 'viewer', SUPABASE_URL: mock.url, SUPABASE_SERVICE_KEY: KEY, WORKSPACE_REV_INTERVAL_SEC: '0', WORKSPACE_REV_KEEP: '4'
};
const { server, port } = await startServer(env, 0);
const base = `http://127.0.0.1:${port}`;
const login = async (username, password) => {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ username, password }).toString() });
  const c = r.headers.get('set-cookie'); return c ? c.split(';')[0] : null;
};
const cookies = { alice: await login('alice', 'alice-password-1'), bob: await login('Bob', 'bob-password-22'), carol: await login('carol', 'carol-password-3'), shared: await login('', PW) };
const as = who => (p, { method = 'GET', body, raw, headers = {} } = {}) => fetch(base + p, {
  method, redirect: 'manual',
  headers: { cookie: cookies[who], origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
});
const J = async r => ({ status: r.status, body: await r.json() });
const A = as('alice'), B = as('bob'), C = as('carol'), S = as('shared');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const png = x => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-' + x)]);
const idN = k => `design-${String(k).padStart(4, '0')}`;
const mk = (who, id, extra = {}) => who('/api/designs', { method: 'POST', body: { id, name: 'Tee', meta: {}, doc: { v: 1 }, ...extra } });
const put = (who, id, baseRev, extra = {}) => who(`/api/designs/${id}`, { method: 'PUT', body: { baseRev, name: 'Tee', meta: {}, doc: { v: baseRev + 1 }, keepAssets: [], ...extra } });
const up = (who, id, buf) => who(`/api/designs/${id}/assets/${sha(buf)}`, { method: 'PUT', raw: buf, headers: { 'content-type': 'image/png' } });

await t('identity config: parsing, errors, and single-password mode still works', async () => {
  const p = parseIdentities(env);
  assert.deepEqual([...p.users.keys()], ['alice', 'bob', 'carol']); assert.equal(p.roles.get('carol'), 'viewer'); assert.equal(p.sharedRole, 'viewer');
  assert.equal(parseIdentities({ SITE_USERS: 'dan:long-enough-pw' }).roles.get('dan'), 'owner', 'first user owns the workspace when no roles are set');
  assert.throws(() => parseIdentities({ SITE_USERS: 'dan:short' }), /at least 8/);
  assert.throws(() => parseIdentities({ SITE_USERS: 'dan' }), /name:password/);
  assert.throws(() => parseIdentities({ SITE_USERS: 'dan:long-enough-pw,dan:long-enough-pw2' }), /twice/);
  assert.throws(() => parseIdentities({ SITE_USERS: 'dan:long-enough-pw', SITE_ROLES: 'eve:owner' }), /SITE_ROLES/);
  assert.throws(() => parseIdentities({ SITE_SHARED_ROLE: 'king' }), /SITE_SHARED_ROLE/);
  assert.doesNotThrow(() => createApp({ NODE_ENV: 'production', SITE_USERS: 'dan:long-enough-pw' }));   // users alone are enough to gate the site
  const solo = await startServer({ NODE_ENV: 'test', SITE_PASSWORD: PW, SESSION_SECRET: 'x'.repeat(40), SUPABASE_URL: mock.url, SUPABASE_SERVICE_KEY: KEY }, 0);
  const sb = `http://127.0.0.1:${solo.port}`;
  const r = await fetch(sb + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: sb }, body: `password=${PW}` });
  const me = await (await fetch(sb + '/api/shared/me', { headers: { cookie: r.headers.get('set-cookie').split(';')[0] } })).json();
  assert.deepEqual(me, { user: 'shared', role: 'owner', shared: true, multiUser: false });
  solo.server.close();
});

await t('login: users, shared password, wrong passwords, tampered cookies', async () => {
  assert.ok(cookies.alice && cookies.bob && cookies.carol && cookies.shared);
  assert.equal(await login('alice', 'wrong-password-1'), null);
  assert.equal(await login('alice', PW), null, 'the shared password does not work for a named user');
  assert.equal(await login('mallory', PW), null, 'unknown username');
  assert.equal(await login('', 'alice-password-1'), null);
  const me = async who => (await J(await as(who)('/api/shared/me'))).body;
  assert.deepEqual(await me('alice'), { user: 'alice', role: 'owner', shared: false, multiUser: true });
  assert.deepEqual(await me('bob'), { user: 'bob', role: 'editor', shared: false, multiUser: true });
  assert.deepEqual(await me('carol'), { user: 'carol', role: 'viewer', shared: false, multiUser: true });
  assert.deepEqual(await me('shared'), { user: 'shared', role: 'viewer', shared: true, multiUser: true });
  // a cookie for bob cannot be turned into alice's
  const [exp, , sig] = cookies.bob.split('=')[1].split('.');
  const forged = `tf_session=${exp}.${Buffer.from('alice').toString('base64url')}.${sig}`;
  assert.equal((await fetch(base + '/api/shared/me', { headers: { cookie: forged } })).status, 401);
  const html = await (await A('/')).text();
  assert.match(html, /<meta name="threadform-user" content="alice" data-role="owner" data-multi="1">/);
  assert.match(await (await fetch(base + '/login')).text(), /name="username"/);
});

await t('designs record owner and last editor; list and get show them with the caller role', async () => {
  const id = idN(1);
  assert.equal((await mk(B, id)).status, 200);
  assert.equal((await J(await put(A, id, 1))).body.updatedBy, 'alice');
  const g = (await J(await B(`/api/designs/${id}`))).body;
  assert.equal(g.owner, 'bob'); assert.equal(g.updatedBy, 'alice'); assert.equal(g.rev, 2); assert.equal(g.role, 'owner');
  const l = (await J(await C('/api/designs'))).body.designs.find(d => d.id === id);
  assert.equal(l.role, 'viewer'); assert.equal(l.updatedBy, 'alice');
  assert.equal((await J(await B(`/api/designs/${id}/rev`))).body.updatedBy, 'alice');
  const stale = await J(await put(B, id, 1));
  assert.equal(stale.status, 409); assert.equal(stale.body.currentRev, 2); assert.equal(stale.body.by, 'alice');
});

await t('permissions: viewers read only; editors cannot delete others designs; owners can; shared role applies', async () => {
  const id = idN(2);
  await mk(A, id);
  assert.equal((await C(`/api/designs/${id}`)).status, 200);
  assert.equal((await put(C, id, 1)).status, 403);
  assert.equal((await mk(C, idN(3))).status, 403);
  assert.equal((await mk(S, idN(3))).status, 403, 'shared login was configured as viewer');
  assert.equal((await up(C, id, png('x'))).status, 403);
  assert.equal((await C(`/api/designs/${id}/duplicate`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await C(`/api/designs/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await put(B, id, 1)).status, 200, 'editor may edit someone elses design');
  assert.equal((await B(`/api/designs/${id}`, { method: 'DELETE' })).status, 403, 'but not delete it');
  assert.equal((await B(`/api/designs/${id}/acl`, { method: 'PUT', body: { members: { carol: 'editor' } } })).status, 403);
  assert.equal((await A(`/api/designs/${id}/duplicate`, { method: 'POST', body: { newId: idN(4) } })).status, 200);
  assert.equal((await A(`/api/designs/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await A(`/api/designs/${id}`)).status, 404);
});

await t('per-design members: an entry beats the workspace role, the design owner always owns it', async () => {
  const id = idN(5);
  await mk(B, id);                                                   // bob owns it
  assert.equal((await put(C, id, 1)).status, 403);
  assert.equal((await B(`/api/designs/${id}/acl`, { method: 'PUT', body: { members: { carol: 'editor', bob: 'viewer' } } })).status, 200);
  assert.equal((await put(C, id, 1)).status, 200, 'carol is an editor of this one design');
  assert.equal((await B(`/api/designs/${id}`)).status, 200);
  assert.equal((await put(B, id, 2)).status, 200, 'the owner stays owner whatever the list says');
  assert.deepEqual((await J(await C(`/api/designs/${id}/acl`))).body, { owner: 'bob', members: { carol: 'editor', bob: 'viewer' }, role: 'editor' });
  assert.equal((await A(`/api/designs/${idN(5)}/acl`, { method: 'PUT', body: { members: { 'Bad Name': 'owner' } } })).status, 400);
  assert.equal((await A(`/api/designs/${idN(5)}/acl`, { method: 'PUT', body: { members: { dan: 'god' } } })).status, 400);
  await mk(A, idN(6));
  assert.equal((await A(`/api/designs/${idN(6)}/acl`, { method: 'PUT', body: { members: { bob: 'viewer' } } })).status, 200);
  assert.equal((await put(B, idN(6), 1)).status, 403, 'downgraded to viewer on this design');
});

await t('version history: snapshots, listing, fetching one, pruning to WORKSPACE_REV_KEEP', async () => {
  const id = idN(10);
  await mk(A, id, { doc: { v: 1 } });
  for (let r = 1; r <= 6; r++) assert.equal((await put(r % 2 ? A : B, id, r, { doc: { v: r + 1 }, name: 'Tee ' + (r + 1) })).status, 200);
  const h = (await J(await C(`/api/designs/${id}/history`))).body.revs;
  assert.deepEqual(h.map(x => x.rev), [7, 6, 5, 4], 'newest first, only the newest 4 kept');
  assert.equal(h[0].editedBy, 'bob'); assert.equal(h[1].editedBy, 'alice'); assert.ok(h[0].savedAt); assert.ok(!('doc' in h[0]));
  const one = (await J(await C(`/api/designs/${id}/history/5`))).body;
  assert.deepEqual(one.doc, { v: 5 }); assert.equal(one.name, 'Tee 5');
  assert.equal((await C(`/api/designs/${id}/history/1`)).status, 404, 'pruned');
  assert.equal((await C(`/api/designs/${id}/history/abc`)).status, 400);
});

await t('restore: saves the old version as a new revision; viewers and stale baseRev are refused', async () => {
  const id = idN(10);
  assert.equal((await C(`/api/designs/${id}/restore`, { method: 'POST', body: { rev: 5, baseRev: 7 } })).status, 403);
  const stale = await J(await B(`/api/designs/${id}/restore`, { method: 'POST', body: { rev: 5, baseRev: 3 } }));
  assert.equal(stale.status, 409); assert.equal(stale.body.currentRev, 7);
  assert.equal((await B(`/api/designs/${id}/restore`, { method: 'POST', body: { rev: 99, baseRev: 7 } })).status, 404);
  const r = await J(await B(`/api/designs/${id}/restore`, { method: 'POST', body: { rev: 5, baseRev: 7 } }));
  assert.equal(r.status, 200); assert.equal(r.body.rev, 8); assert.equal(r.body.restoredFrom, 5); assert.equal(r.body.updatedBy, 'bob');
  const g = (await J(await A(`/api/designs/${id}`))).body;
  assert.deepEqual(g.doc, { v: 5 }); assert.equal(g.rev, 8); assert.equal(g.name, 'Tee 5');
  const h = (await J(await A(`/api/designs/${id}/history`))).body.revs;
  assert.equal(h[0].rev, 8); assert.match(h[0].note, /restored from version 5/);
});

await t('autosaves by the same person share one version when the interval has not passed', async () => {
  const s2 = await startServer({ ...env, WORKSPACE_REV_INTERVAL_SEC: '3600', WORKSPACE_REV_KEEP: '10' }, 0);
  const b2 = `http://127.0.0.1:${s2.port}`;
  const c = (await (await fetch(b2 + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: b2 }, body: 'username=alice&password=alice-password-1' })).headers.get('set-cookie')).split(';')[0];
  const call = (p, method, body) => fetch(b2 + p, { method, headers: { cookie: c, origin: b2, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const id = idN(11);
  await call('/api/designs', 'POST', { id, name: 'T', meta: {}, doc: {} });
  for (let r = 1; r <= 4; r++) await call(`/api/designs/${id}`, 'PUT', { baseRev: r, name: 'T', meta: {}, doc: { v: r }, keepAssets: [] });
  const h = (await (await fetch(b2 + `/api/designs/${id}/history`, { headers: { cookie: c } })).json()).revs;
  assert.equal(h.length, 1, 'one rolling version for the editing session'); assert.equal(h[0].rev, 5);
  s2.server.close();
});

await t('images that a kept version uses are not garbage-collected, so restore finds them', async () => {
  const id = idN(12), p1 = png('one'), p2 = png('two');
  await mk(A, id);
  assert.equal((await up(A, id, p1)).status, 200);
  assert.equal((await put(A, id, 1, { doc: { img: sha(p1) }, keepAssets: [sha(p1)] })).status, 200);
  assert.equal((await up(A, id, p2)).status, 200);
  assert.equal((await put(A, id, 2, { doc: { img: sha(p2) }, keepAssets: [sha(p2)] })).status, 200);
  const have = mock.assetsOf(id).map(a => a.hash).sort();
  assert.deepEqual(have, [sha(p1), sha(p2)].sort(), 'the first image is still needed by version 2');
  const r = await J(await A(`/api/designs/${id}/restore`, { method: 'POST', body: { rev: 2, baseRev: 3 } }));
  assert.equal(r.status, 200);
  assert.equal((await A(`/api/designs/${id}/assets/${sha(p1)}`)).status, 200);
  // when history rolls past the old versions their images are collected
  for (let b = 4; b <= 9; b++) await put(A, id, b, { doc: { img: sha(p2) }, keepAssets: [sha(p2)] });
  assert.deepEqual(mock.assetsOf(id).map(a => a.hash), [sha(p2)]);
});

await t('inline base64 images are refused in design, meta and kit data; small thumbnails are fine', async () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(20000);
  assert.equal((await mk(A, idN(20), { doc: { elements: [{ props: { img: big } }] } })).status, 413);
  assert.equal((await mk(A, idN(20), { meta: { logo: big } })).status, 413);
  assert.equal((await mk(A, idN(20), { meta: { thumb: 'data:image/jpeg;base64,' + 'A'.repeat(30000) }, doc: { versions: [{ thumb: 'data:image/jpeg;base64,' + 'A'.repeat(20000) }], tiny: 'data:image/png;base64,AAAA' } })).status, 200);
  assert.equal((await put(A, idN(20), 1, { doc: { deep: { list: [big] } } })).status, 413);
  const kit = await A('/api/workspace/palette/pal-00001', { method: 'PUT', body: { baseRev: 0, name: 'P', data: { swatch: big } } });
  assert.equal(kit.status, 413);
});

await t('Brand Kit items: create, list by kind, update with rev, conflicts, roles, delete', async () => {
  const id = 'pal-00001';
  const mkItem = (who, kind, i, baseRev, extra = {}) => who(`/api/workspace/${kind}/${i}`, { method: 'PUT', body: { baseRev, name: 'Club colours', data: { colors: ['#112233', '#ffffff'] }, ...extra } });
  let r = await J(await mkItem(B, 'palette', id, 0)); assert.equal(r.status, 200); assert.equal(r.body.rev, 1);
  assert.equal((await mkItem(B, 'palette', id, 0)).status, 409, 'creating twice conflicts');
  r = await J(await mkItem(A, 'palette', id, 1, { name: 'Club colours v2', data: { colors: ['#000'] } })); assert.equal(r.body.rev, 2);
  const stale = await J(await mkItem(B, 'palette', id, 1)); assert.equal(stale.status, 409); assert.equal(stale.body.currentRev, 2);
  await mkItem(A, 'typography', 'type-0001', 0, { data: { heading: 'Georgia' } });
  await mkItem(A, 'material', 'mat-00001', 0, { name: 'Cotton', data: { gsm: 180 } });
  await mkItem(A, 'collection', 'col-00001', 0, { name: 'Spring', data: { designIds: [idN(1)] } });
  const all = (await J(await C('/api/workspace'))).body.items;
  assert.deepEqual(all.map(x => x.kind).sort(), ['collection', 'material', 'palette', 'typography']);
  const pal = all.find(x => x.kind === 'palette'); assert.equal(pal.name, 'Club colours v2'); assert.equal(pal.updatedBy, 'alice'); assert.deepEqual(pal.data, { colors: ['#000'] });
  assert.equal((await J(await C('/api/workspace?kind=material'))).body.items.length, 1);
  assert.equal((await C('/api/workspace?kind=nope')).status, 400);
  assert.equal((await mkItem(C, 'palette', 'pal-00002', 0)).status, 403, 'viewer cannot write');
  assert.equal((await C(`/api/workspace/palette/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await mkItem(A, 'banana', 'pal-00002', 0)).status, 404);
  assert.equal((await mkItem(A, 'palette', 'x', 0)).status, 400);
  assert.equal((await A(`/api/workspace/palette/${id}`, { method: 'PUT', body: { baseRev: 0, name: '', data: {} } })).status, 400);
  assert.equal((await A(`/api/workspace/palette/pal-00009`, { method: 'PUT', body: { baseRev: 5, name: 'x', data: {} } })).status, 404);
  assert.equal((await B(`/api/workspace/palette/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await J(await A('/api/workspace?kind=palette'))).body.items.length, 0);
  assert.equal((await A('/api/workspace/palette/pal-00001', { method: 'POST', body: {} })).status, 405);
});

await t('Brand Kit images: upload once by hash, asset items reference them, blob freed with the last reference', async () => {
  const buf = png('logo'), h = sha(buf);
  const blob = (who, b = buf, hash = sha(b)) => who(`/api/workspace/blobs/${hash}`, { method: 'PUT', raw: b, headers: { 'content-type': 'image/png' } });
  assert.deepEqual((await J(await A('/api/workspace/blobs/missing', { method: 'POST', body: { hashes: [h] } }))).body, { missing: [h] });
  assert.equal((await blob(C)).status, 403);
  assert.equal((await blob(A, buf, 'f'.repeat(64))).status, 400, 'hash must match the bytes');
  assert.equal((await A(`/api/workspace/blobs/${h}`, { method: 'PUT', raw: Buffer.from('not an image'), headers: { 'content-type': 'image/png' } })).status, 400);
  assert.equal((await A(`/api/workspace/blobs/${h}`, { method: 'PUT', raw: buf, headers: { 'content-type': 'text/html' } })).status, 415);
  assert.equal((await blob(B)).status, 200); assert.equal((await blob(B)).status, 200, 'idempotent');
  assert.deepEqual((await J(await C('/api/workspace/blobs/missing', { method: 'POST', body: { hashes: [h] } }))).body, { missing: [] });
  const got = await C(`/api/workspace/blobs/${h}`);
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.ok(Buffer.from(await got.arrayBuffer()).equals(buf));
  assert.equal((await A('/api/workspace/asset/ast-00001', { method: 'PUT', body: { baseRev: 0, name: 'Crest', data: { name: 'crest.png' } } })).status, 400, 'asset items need a hash');
  assert.equal((await A('/api/workspace/asset/ast-00001', { method: 'PUT', body: { baseRev: 0, name: 'Crest', data: { hash: h, mime: 'image/png' } } })).status, 200);
  assert.equal((await A('/api/workspace/asset/ast-00002', { method: 'PUT', body: { baseRev: 0, name: 'Crest copy', data: { hash: h } } })).status, 200);
  assert.equal((await A('/api/workspace/asset/ast-00001', { method: 'DELETE' })).status, 200);
  assert.equal((await C(`/api/workspace/blobs/${h}`)).status, 200, 'still referenced by the copy');
  assert.equal((await A('/api/workspace/asset/ast-00002', { method: 'DELETE' })).status, 200);
  assert.equal((await C(`/api/workspace/blobs/${h}`)).status, 404, 'no references left');
  assert.equal(mock.tables.workspace_blobs.length, 0);
});

await t('without Supabase the workspace routes are 404 (clients fall back to per-browser storage) but identity still works', async () => {
  const off = await startServer({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), SITE_USERS: 'dan:dan-password-1' }, 0);
  const ob = `http://127.0.0.1:${off.port}`;
  const c = (await (await fetch(ob + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ob }, body: 'username=dan&password=dan-password-1' })).headers.get('set-cookie')).split(';')[0];
  assert.equal((await fetch(ob + '/api/workspace', { headers: { cookie: c } })).status, 404);
  assert.deepEqual(await (await fetch(ob + '/api/shared/me', { headers: { cookie: c } })).json(), { user: 'dan', role: 'owner', shared: false, multiUser: true });
  assert.equal((await fetch(ob + '/api/workspace')).status, 401, 'still behind the login');
  off.server.close();
});

await t('status reports a missing new table with a clear instruction; upstream errors are generic', async () => {
  mock.setFailure('missingTables');
  const s = (await J(await A('/api/shared/status?fresh=1'))).body;
  assert.equal(s.ok, false); assert.match(s.error, /schema\.sql/);
  mock.setFailure(null);
  mock.setFailure('down');
  const r = await J(await A('/api/workspace'));
  assert.equal(r.status, 503); assert.deepEqual(r.body, { error: 'shared library unavailable' });
  assert.ok(!JSON.stringify(r.body).includes(KEY));
  mock.setFailure(null);
});

server.close(); await mock.close();
console.log(`server.workspace.test.mjs: ${n} tests passed`);
