// Unit tests for js/backup.js (export-all / restore). Run: node js/backup.test.mjs
import assert from 'node:assert/strict';
import { buildBackup, parseBackup, planRestore, restoreEntries, exportAll, backupFileName, BackupError, BACKUP_FORMAT } from './backup.js';

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const rec = (id, name, extra = {}) => ({ id, meta: { id, name, createdAt: 1, updatedAt: 2, rev: 7, updatedBy: 'bob', role: 'editor', tags: ['a'], ...extra }, doc: { name, layers: [{ k: 1 }], views: { front: { base: 'h1' } } }, assets: { h1: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), h2: PNG } });
const fakeStore = (initial = []) => {
  const db = new Map(initial.map(r => [r.id, r])); let k = 0;
  return { db, newId: () => 'new' + (++k), listDesigns: async () => [...db.values()].map(r => r.meta), getDesign: async id => db.get(id) || null, putDesign: async r => { if (r.meta.name === 'FAIL') throw new Error('disk full'); db.set(r.id, r); } };
};

await t('round trip: every design, document, metadata and image comes back; server-owned meta is dropped', async () => {
  const text = await buildBackup([rec('d1', 'One'), rec('d2', 'Two')], new Date('2026-01-02T03:04:05Z'));
  const j = JSON.parse(text); assert.equal(j.format, BACKUP_FORMAT); assert.equal(j.count, 2); assert.equal(j.exportedAt, '2026-01-02T03:04:05.000Z');
  const { designs, skipped } = parseBackup(text);
  assert.equal(skipped.length, 0); assert.deepEqual(designs.map(d => d.id), ['d1', 'd2']);
  assert.deepEqual(designs[0].doc, rec('d1', 'One').doc); assert.deepEqual(designs[0].meta.tags, ['a']);
  for (const k of ['rev', 'updatedBy', 'role']) assert.ok(!(k in designs[0].meta), k + ' is not carried');
  assert.match(designs[0].assets.h1, /^data:image\/png;base64,iVBORw0KGgo=$/); assert.equal(designs[0].assets.h2, PNG);
});

await t('an empty library still makes a valid backup that restores zero designs', async () => {
  const { designs } = parseBackup(await buildBackup([])); assert.equal(designs.length, 0);
});

await t('bad files get a friendly error and change nothing', () => {
  const bad = ['', '   ', 'not json', '{"a":1}', '[]', JSON.stringify({ format: BACKUP_FORMAT }), JSON.stringify({ format: BACKUP_FORMAT, version: 1 }), JSON.stringify({ format: BACKUP_FORMAT, version: 99, designs: [] }), JSON.stringify({ format: 'other', version: 1, designs: [] })];
  for (const b of bad) assert.throws(() => parseBackup(b), e => e instanceof BackupError && e.user && e.message.length > 10, JSON.stringify(b));
  assert.throws(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, designs: new Array(501).fill({}) })), /500/);
});

await t('malformed designs are skipped with a reason, good ones still restore', () => {
  const ok = { id: 'good', meta: {}, doc: {}, assets: {} };
  const text = JSON.stringify({ format: BACKUP_FORMAT, version: 1, designs: [ok, { id: '../etc/passwd', doc: {} }, { id: 'nodoc' }, { id: 'good', doc: {} }, { id: 'badimg', doc: {}, assets: { x: 'javascript:alert(1)' } }, { id: 'svg', doc: {}, assets: { x: 'data:image/svg+xml;base64,AAAA' } }, 5, null, { id: 'arr', doc: [] }] });
  const { designs, skipped } = parseBackup(text);
  assert.deepEqual(designs.map(d => d.id), ['good']);
  assert.equal(skipped.length, 8); assert.ok(skipped.every(s => s.reason.length > 3));
});

await t('restore never overwrites: an existing id becomes a new design named (restored); a free id is kept', () => {
  const entries = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, designs: [{ id: 'a', meta: { name: 'Keep', createdAt: 5 }, doc: {} }, { id: 'b', meta: { name: 'Clash' }, doc: { name: 'Clash' } }] })).designs;
  let k = 0; const plan = planRestore(entries, ['b'], () => 'fresh' + (++k), 1000);
  assert.equal(plan[0].rec.id, 'a'); assert.equal(plan[0].rec.meta.name, 'Keep'); assert.equal(plan[0].rec.meta.createdAt, 5); assert.ok(!plan[0].renamed);
  assert.equal(plan[1].rec.id, 'fresh1'); assert.equal(plan[1].rec.meta.name, 'Clash (restored)'); assert.equal(plan[1].rec.doc.name, 'Clash (restored)'); assert.ok(plan[1].renamed);
});

await t('end to end through a store: export all, wipe, restore all; and restoring twice never loses or duplicates over originals', async () => {
  const s = fakeStore([rec('d1', 'One'), rec('d2', 'Two'), rec('d3', 'Three')]);
  const { text, count, missing } = await exportAll(s); assert.equal(count, 3); assert.deepEqual(missing, []);
  const before = JSON.stringify([...s.db.values()].map(r => r.doc));
  s.db.clear();
  const r1 = await restoreEntries(s, parseBackup(text).designs); assert.deepEqual([r1.restored, r1.renamed, r1.failed.length], [3, 0, 0]);
  assert.equal(JSON.stringify([...s.db.values()].map(r => r.doc)), before, 'documents identical after restore');
  assert.ok([...s.db.values()].every(r => typeof r.assets.h2 === 'string' && r.assets.h2 === PNG));
  const r2 = await restoreEntries(s, parseBackup(text).designs); assert.deepEqual([r2.restored, r2.renamed], [3, 3]);
  assert.equal(s.db.size, 6); assert.ok(s.db.has('d1') && s.db.get('d1').meta.name === 'One', 'originals untouched');
});

await t('failures are reported by name, the rest still restore, progress is reported', async () => {
  const s = fakeStore(); const ticks = [];
  const text = await buildBackup([rec('x1', 'Fine'), rec('x2', 'FAIL'), rec('x3', 'Also fine')]);
  const r = await restoreEntries(s, parseBackup(text).designs, (d, total) => ticks.push([d, total]));
  assert.equal(r.restored, 2); assert.deepEqual(r.failed, [{ name: 'FAIL', message: 'disk full' }]); assert.deepEqual(ticks.at(-1), [3, 3]);
});

await t('export lists designs it could not read instead of silently dropping them', async () => {
  const s = fakeStore([rec('ok1', 'Readable'), rec('bad1', 'Broken')]);
  const get = s.getDesign; s.getDesign = async id => { if (id === 'bad1') throw new Error('boom'); return get(id); };
  const r = await exportAll(s); assert.equal(r.count, 1); assert.deepEqual(r.missing, ['Broken']);
});

await t('file name is dated', () => assert.equal(backupFileName(new Date('2026-03-04T10:00:00Z')), 'threadform-backup-2026-03-04.json'));
console.log(`backup.test: ${n} passed`);
