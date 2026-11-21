// Client-side tests for the Brand Kit store and the sync state (js/kit.js, js/syncstate.js, js/remote.js) against a real
// Threadform server backed by test/mock-supabase.mjs. Run: node js/workspace.test.mjs
import assert from 'node:assert/strict';
import { createSyncState, backoff } from './syncstate.js';
import { startServer } from '../server.mjs';
import { startMock } from '../test/mock-supabase.mjs';

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };

await t('syncState: precedence, pending counts, labels, unsubscribe', () => {
  const s = createSyncState(); const seen = [];
  const off = s.subscribe(v => seen.push(v.kind));
  assert.equal(s.get().kind, 'saved');
  s.set('design', 'saving'); assert.equal(s.get().kind, 'saving');
  s.set('kit', 'offline', { pending: 3, detail: 'x' }); assert.equal(s.get().kind, 'offline'); assert.equal(s.get().label, 'Offline: will retry (3 waiting)');
  s.set('design', 'conflict', { detail: 'they changed it' }); assert.equal(s.get().kind, 'conflict'); assert.equal(s.get().detail, 'they changed it');
  s.set('design', 'error'); assert.equal(s.get().kind, 'error');
  s.set('design', 'saved'); s.set('kit', 'saved'); assert.equal(s.get().kind, 'saved'); assert.ok(s.get().at > 0);
  assert.throws(() => s.set('x', 'bogus'));
  off(); s.set('design', 'saving'); assert.equal(seen.at(-1), 'saved');
  s.clear('design'); assert.equal(s.get().kind, 'saved');
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(i => backoff(i, () => 0.5)), [2000, 4000, 8000, 16000, 30000, 30000]);
});

// ---- the kit store in per-browser mode (no shared library) ----
const png = x => new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('kit-' + x)])], { type: 'image/png' });
globalThis.self = globalThis;
const K = await import('./kit.js');
const { syncState } = await import('./syncstate.js');

await t('local fallback: items and images work without the shared library', async () => {
  K._resetKit({ storage: true });
  const p = await K.saveKitItem('palette', { name: 'Club', data: { colors: ['#123456'] } });
  assert.equal(p.rev, 0); assert.ok(p.id);
  const a = await K.addKitAsset(png('local'), 'Crest');
  assert.match(a.data.hash, /^[0-9a-f]{64}$/); assert.equal(a.data.mime, 'image/png'); assert.ok(!JSON.stringify(a).includes('base64'));
  const { items, offline } = await K.listKit();
  assert.equal(offline, false); assert.deepEqual(items.map(i => i.kind).sort(), ['asset', 'palette']);
  assert.ok((await K.getKitAssetBlob(a.data.hash)).size > 8);
  await K.saveKitItem('palette', { id: p.id, name: 'Club v2', data: { colors: [] } });
  assert.equal((await K.listKit('palette')).items[0].name, 'Club v2');
  await K.deleteKitItem('palette', p.id);
  assert.equal((await K.listKit('palette')).items.length, 0);
  assert.equal(K.pendingCount(), 0, 'nothing is queued when there is no server');
  await assert.rejects(() => K.saveKitItem('nope', { name: 'x' }));
});

// ---- shared mode against the real server ----
const KEY = 'sb-test-key-123456', PW = 'client-test-password';
const mock = await startMock({ key: KEY });
const env = { NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(40), SITE_USERS: 'alice:alice-password-1,bob:bob-password-22,vic:vic-password-333', SITE_ROLES: 'alice:owner,bob:editor,vic:viewer', SUPABASE_URL: mock.url, SUPABASE_SERVICE_KEY: KEY };
const { server, port } = await startServer(env, 0);
const base = `http://127.0.0.1:${port}`;
const loginCookie = async u => (await (await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: `username=${u}&password=${u}-password-${{ alice: 1, bob: 22, vic: 333 }[u]}` })).headers.get('set-cookie')).split(';')[0];
const cookies = { alice: await loginCookie('alice'), bob: await loginCookie('bob'), vic: await loginCookie('vic') };

const realFetch = globalThis.fetch;
const net = { who: 'alice', down: false, calls: 0 };
globalThis.document = { querySelector: sel => (/threadform-shared/.test(sel) ? {} : null) };
globalThis.fetch = (path, opt = {}) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return realFetch(path, opt);
  net.calls++;
  if (net.down) return Promise.reject(new TypeError('network down'));
  return realFetch(base + path, { ...opt, redirect: 'manual', headers: { ...(opt.headers || {}), cookie: cookies[net.who], origin: base } });
};
const direct = async (who, path, method = 'GET', body) => { const r = await realFetch(base + path, { method, headers: { cookie: cookies[who], origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };

await t('shared: saving uploads to the server, images by hash only, other users see them', async () => {
  K._resetKit({ storage: true }); net.who = 'alice';
  const pal = await K.saveKitItem('palette', { name: 'Club colours', data: { colors: ['#112233'] } });
  await K.flush();
  assert.equal(K.pendingCount(), 0); assert.equal(syncState.get().kind, 'saved');
  const remote = (await direct('bob', '/api/workspace?kind=palette')).body.items;
  assert.equal(remote.length, 1); assert.equal(remote[0].id, pal.id); assert.equal(remote[0].updatedBy, 'alice');
  assert.equal(K.cachedKit('palette')[0].rev, 1, 'rev from the server is remembered');
  const asset = await K.addKitAsset(png('shared'), 'Crest');
  await K.flush();
  assert.equal(mock.tables.workspace_blobs.length, 1);
  const row = mock.tables.workspace_items.find(r => r.kind === 'asset');
  assert.equal(row.ref, asset.data.hash); assert.ok(JSON.stringify(row.data).length < 400, 'no image bytes in the item');
  // another browser (empty cache) lists and downloads
  K._resetKit(); net.who = 'bob';
  const { items } = await K.listKit();
  assert.equal(items.length, 2);
  const blob = await K.getKitAssetBlob(asset.data.hash);
  assert.ok(blob.size > 8);
});

await t('offline: edits are queued, status says offline with a count, and everything is sent when the network is back', async () => {
  K._resetKit({ storage: true }); net.who = 'alice'; net.down = true;
  const a = await K.saveKitItem('material', { name: 'Cotton', data: { gsm: 180 } });
  await K.saveKitItem('material', { id: a.id, name: 'Cotton 200', data: { gsm: 200 } });   // same item again: one queued edit
  await K.saveKitItem('collection', { name: 'Spring', data: { designIds: [] } });
  await K.flush();
  assert.equal(K.pendingCount(), 2);
  assert.equal(syncState.get().kind, 'offline'); assert.equal(syncState.get().pending, 2);
  assert.equal(K.cachedKit('material')[0].name, 'Cotton 200', 'reads see the local edit meanwhile');
  assert.equal((await K.listKit()).offline, true);
  net.down = false;
  await K.flush();
  assert.equal(K.pendingCount(), 0); assert.equal(syncState.get().kind, 'saved');
  const m = (await direct('bob', '/api/workspace?kind=material')).body.items;
  assert.equal(m.length, 1); assert.equal(m[0].name, 'Cotton 200'); assert.equal(m[0].rev, 1);
});

await t('server trouble (503) also queues and retries; deletes are queued too', async () => {
  K._resetKit({ storage: true }); net.who = 'alice';
  const a = await K.saveKitItem('typography', { name: 'Serif', data: { heading: 'Georgia' } }); await K.flush();
  mock.setFailure('down');
  await K.deleteKitItem('typography', a.id); await K.flush();
  assert.equal(K.pendingCount(), 1); assert.equal(syncState.get().kind, 'offline');
  mock.setFailure(null); await K.flush();
  assert.equal(K.pendingCount(), 0);
  assert.equal((await direct('bob', '/api/workspace?kind=typography')).body.items.length, 0);
});

await t('conflict: their version stays, ours is kept as "(my version)", nothing is lost, status says conflict', async () => {
  K._resetKit({ storage: true }); net.who = 'alice';
  const a = await K.saveKitItem('palette', { name: 'Brand', data: { colors: ['#000000'] } }); await K.flush();
  // bob changes it on the server while alice's copy is stale
  const cur = (await direct('bob', '/api/workspace?kind=palette')).body.items.find(i => i.id === a.id);
  assert.equal((await direct('bob', `/api/workspace/palette/${a.id}`, 'PUT', { baseRev: cur.rev, name: 'Brand (bob)', data: { colors: ['#ff0000'] } })).status, 200);
  await K.saveKitItem('palette', { id: a.id, name: 'Brand', data: { colors: ['#00ff00'] } });
  await K.flush();
  const pals = K.cachedKit('palette').filter(p => /^Brand/.test(p.name));
  const theirs = pals.find(p => p.id === a.id), mine = pals.find(p => p.id !== a.id);
  assert.equal(theirs.name, 'Brand (bob)'); assert.deepEqual(theirs.data.colors, ['#ff0000']);
  assert.equal(mine.name, 'Brand (my version)'); assert.deepEqual(mine.data.colors, ['#00ff00']);
  assert.equal(syncState.get().kind, 'conflict'); assert.match(syncState.get().detail, /Someone else changed/);
  assert.equal(K.pendingCount(), 0);
  const remote = (await direct('alice', '/api/workspace?kind=palette')).body.items;
  assert.equal(remote.filter(i => /^Brand/.test(i.name)).length, 2); assert.ok(remote.some(i => i.name === 'Brand (my version)' && i.data.colors[0] === '#00ff00'));
  K.acknowledgeKit(); assert.equal(syncState.get().kind, 'saved');
});

await t('conflict where both sides made the same change just adopts the server revision; remote deletion brings ours back', async () => {
  K._resetKit({ storage: true }); net.who = 'alice';
  const a = await K.saveKitItem('material', { name: 'Wool', data: { gsm: 300 } }); await K.flush();
  await direct('bob', `/api/workspace/material/${a.id}`, 'PUT', { baseRev: 1, name: 'Wool', data: { gsm: 320 } });
  await K.saveKitItem('material', { id: a.id, name: 'Wool', data: { gsm: 320 } }); await K.flush();
  assert.equal(K.cachedKit('material').length, 1); assert.equal(K.cachedKit('material')[0].rev, 2); assert.equal(K.pendingCount(), 0);
  await direct('bob', `/api/workspace/material/${a.id}`, 'DELETE');
  await K.saveKitItem('material', { id: a.id, name: 'Wool 2', data: { gsm: 1 } }); await K.flush();
  assert.equal((await direct('alice', '/api/workspace?kind=material')).body.items[0].name, 'Wool 2');
  assert.equal(K.pendingCount(), 0);
});

await t('a view-only user cannot change the shared kit: the edit is dropped and the status explains why', async () => {
  K._resetKit({ storage: true }); net.who = 'vic';
  await K.saveKitItem('palette', { name: 'Nope', data: {} }); await K.flush();
  assert.equal(K.pendingCount(), 0); assert.equal(syncState.get().kind, 'error'); assert.match(syncState.get().detail, /view-only/);
  assert.equal((await direct('alice', '/api/workspace?kind=palette')).body.items.some(i => i.name === 'Nope'), false);
  K.acknowledgeKit();
});

await t('moving per-browser kit items into the shared kit', async () => {
  globalThis.localStorage = (() => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })();
  K._resetKit();
  localStorage.setItem('threadform.kit.v1', JSON.stringify({ items: { palette: { kloc00001: { id: 'kloc00001', kind: 'palette', name: 'Old local', data: { colors: ['#abc'] } } } }, queue: [] }));
  net.who = 'alice';
  assert.equal(K.movableKitItems().length, 1);
  assert.equal(await K.moveLocalKit(), 1);
  assert.equal(K.movableKitItems().length, 0);
  assert.ok((await direct('bob', '/api/workspace?kind=palette')).body.items.some(i => i.id === 'kloc00001'));
  delete globalThis.localStorage;
});


await t('storage: big inline images in layer data become assets, come back as data URLs, history lists and restores', async () => {
  const S = await import('./storage.js');
  net.who = 'alice';
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(9000, 7)]);
  const url = 'data:image/png;base64,' + bytes.toString('base64');
  const id = 'design-inline-1';
  const rec = v => ({ id, meta: { id, name: 'Inline', thumb: 'data:image/jpeg;base64,' + 'A'.repeat(9000) }, doc: { v, elements: [{ type: 'image', props: { src: url, small: 'data:image/png;base64,AAAA' } }], versions: [{ thumb: 'data:image/jpeg;base64,' + 'B'.repeat(9000) }] }, assets: {} });
  await S.putDesign(rec(1));
  const row = mock.tables.designs.find(d => d.id === id);
  const json = JSON.stringify(row.doc);
  assert.ok(!json.includes(url.slice(0, 200)), 'no big base64 in the stored design'); assert.match(row.doc.elements[0].props.src, /^asset:[0-9a-f]{64}$/);
  assert.equal(row.doc.elements[0].props.small, 'data:image/png;base64,AAAA', 'tiny data URLs stay');
  assert.equal(mock.assetsOf(id).length, 1);
  const back = await S.getDesign(id);
  assert.equal(back.doc.elements[0].props.src, url); assert.equal(back.meta.updatedBy, 'alice'); assert.equal(back.role, 'owner');
  await S.putDesign(rec(2)); await S.putDesign(rec(3));
  assert.equal(mock.assetsOf(id).length, 1, 'the image is kept (still referenced)');
  const vs = await S.listVersions(id);
  assert.ok(vs.length >= 1 && vs[0].editedBy === 'alice' && vs[0].savedAt > 0);
  const old = vs.find(v => v.rev === 2) || vs.at(-1);
  const r = await S.restoreVersion(id, old.rev);
  assert.ok(r.rev > 3); assert.equal((await S.getDesign(id)).doc.v, old.rev === 2 ? 2 : (await S.getDesign(id)).doc.v);
  net.who = 'vic';
  await assert.rejects(() => S.putDesign(rec(9)), e => e.kind === 'conflict' || e.kind === 'forbidden');
});

globalThis.fetch = realFetch; K._resetKit();
server.close(); await mock.close();
console.log(`js/workspace.test.mjs: ${n} tests passed`);
