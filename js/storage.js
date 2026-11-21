// Design storage (owner: home/gallery).
// With <meta name="threadform-shared" content="1"> the shared library (remote.js, via the server) is the source of truth;
// otherwise everything below is per-browser exactly as before. The exports keep one interface for both.
// IndexedDB first; localStorage if IndexedDB is unavailable; an in-memory map as a last resort.
// Record: { id, meta: {id,name,createdAt,updatedAt,thumb,views,kind}, doc, assets: {key: Blob|dataURL} }
// Every call is async and reports failures as StorageError (quota errors flagged with .quota).

const DB_NAME = 'threadform', DB_VERSION = 1;
const STORE_FULL = 'designs', STORE_META = 'meta';
const LS_INDEX = 'threadform.index.v1', LS_PREFIX = 'threadform.design.v1.';

import * as R from './remote.js';
import { RemoteError } from './remote.js';
export { RemoteError };

let mode = null, dbPromise = null;
const memory = new Map();

export class StorageError extends Error {
  constructor(message, { quota = false, cause = null } = {}) {
    super(message); this.name = 'StorageError'; this.quota = quota; this.cause = cause; this.user = true;
  }
}
export const isQuotaError = e => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
export const newId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const shared = () => R.sharedEnabled();
export const storageMode = () => (R.sharedEnabled() ? 'shared' : (mode || 'unknown'));

const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = tx => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new DOMException('Transaction aborted', 'AbortError'));
});

function openDB() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    if (!self.indexedDB) return rej(new Error('IndexedDB unavailable'));
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of [STORE_FULL, STORE_META]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IndexedDB is blocked'));
  });
  return dbPromise;
}

/** Picks the storage backend once. Never throws. */
export async function initStorage() {
  if (mode) return mode;
  try { await openDB(); mode = 'indexeddb'; return mode; }
  catch (e) { console.warn('IndexedDB unavailable, falling back', e); }
  try {
    const k = 'threadform.probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k);
    mode = 'localstorage';
  } catch { mode = 'memory'; }
  return mode;
}

function lsIndex() {
  try { return JSON.parse(localStorage.getItem(LS_INDEX) || '[]'); } catch { return []; }
}
const blobToDataURL = b => new Promise((res, rej) => {
  const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b);
});
async function assetsToStrings(assets = {}) {
  const out = {};
  for (const [k, v] of Object.entries(assets)) out[k] = typeof v === 'string' ? v : await blobToDataURL(v);
  return out;
}

/** Lightweight list of design metadata (no artwork). */
async function localList() {
  const m = await initStorage();
  try {
    if (m === 'indexeddb') { const db = await openDB(); return await reqP(db.transaction(STORE_META).objectStore(STORE_META).getAll()); }
    if (m === 'localstorage') return lsIndex();
    return [...memory.values()].map(r => r.meta);
  } catch (e) { throw new StorageError('Your saved designs could not be read. Reload the page to try again.', { cause: e }); }
}

/** Full record or null. */
async function localGet(id) {
  const m = await initStorage();
  try {
    if (m === 'indexeddb') { const db = await openDB(); return (await reqP(db.transaction(STORE_FULL).objectStore(STORE_FULL).get(id))) || null; }
    if (m === 'localstorage') { const s = localStorage.getItem(LS_PREFIX + id); return s ? JSON.parse(s) : null; }
    return memory.get(id) || null;
  } catch (e) { throw new StorageError('That design could not be opened. Reload the page to try again.', { cause: e }); }
}

/**
 * Home-page fields (tags, order) survive saves that do not carry them: the studio's autosave writes the whole
 * record without them, so they are copied over from the stored meta.
 */
async function withKeptMeta(rec, m, db) {
  const meta = { ...rec.meta };
  if (meta.tags !== undefined && meta.order !== undefined) return meta;
  let prev = null;
  try {
    if (m === 'indexeddb') prev = await reqP(db.transaction(STORE_META).objectStore(STORE_META).get(rec.id));
    else if (m === 'localstorage') prev = lsIndex().find(x => x.id === rec.id);
    else prev = memory.get(rec.id)?.meta;
  } catch { prev = null; }
  if (meta.tags === undefined && prev?.tags) meta.tags = prev.tags;
  if (meta.order === undefined && prev?.order !== undefined) meta.order = prev.order;
  return meta;
}

/** Creates or replaces a record. Throws StorageError (quota: true when the browser is full). */
async function localPut(rec) {
  const m = await initStorage();
  try {
    if (m === 'indexeddb') {
      const db = await openDB();
      const meta = await withKeptMeta(rec, m, db);
      const tx = db.transaction([STORE_FULL, STORE_META], 'readwrite');
      tx.objectStore(STORE_FULL).put({ ...rec, meta });
      tx.objectStore(STORE_META).put(meta);
      await txDone(tx);
    } else if (m === 'localstorage') {
      const meta = await withKeptMeta(rec, m);
      const body = JSON.stringify({ ...rec, meta, assets: await assetsToStrings(rec.assets) });
      localStorage.setItem(LS_PREFIX + rec.id, body);
      const idx = lsIndex().filter(x => x.id !== rec.id); idx.push(meta);
      localStorage.setItem(LS_INDEX, JSON.stringify(idx));
    } else {
      const meta = await withKeptMeta(rec, m);
      memory.set(rec.id, { ...rec, meta });
    }
  } catch (e) {
    const quota = isQuotaError(e);
    throw new StorageError(quota ? 'Browser storage is full. Delete a design you no longer need, then try again.' : 'The design could not be saved. Try again in a moment.', { quota, cause: e });
  }
}

/**
 * Changes home-page fields of a stored design: `meta` is merged into the meta and `doc` into the saved document.
 * Reads the whole record first so the artwork is not touched. Throws StorageError.
 */
async function localPatch(id, { meta = {}, doc = {} } = {}) {
  const rec = await localGet(id);
  if (!rec) throw new StorageError('That design no longer exists. It may have been deleted in another tab.');
  rec.meta = { ...rec.meta, ...meta };
  rec.doc = { ...(rec.doc || {}), ...doc };
  await localPut(rec);
  return rec.meta;
}

async function localDelete(id) {
  const m = await initStorage();
  try {
    if (m === 'indexeddb') {
      const db = await openDB();
      const tx = db.transaction([STORE_FULL, STORE_META], 'readwrite');
      tx.objectStore(STORE_FULL).delete(id); tx.objectStore(STORE_META).delete(id);
      await txDone(tx);
    } else if (m === 'localstorage') {
      localStorage.removeItem(LS_PREFIX + id);
      localStorage.setItem(LS_INDEX, JSON.stringify(lsIndex().filter(x => x.id !== id)));
    } else memory.delete(id);
  } catch (e) { throw new StorageError('That design could not be deleted. Reload the page and try again.', { cause: e }); }
}


/* ======================================================================== shared library ======================================================================== */
// Record shape stays { id, meta, doc, assets: {key: Blob|dataURL} } so the studio does not care where it is stored.
// Over the wire, images are referenced by their sha-256 (see SHARED-API.md); doc keys are rewritten on the way out and kept as hashes on the way in.
const MAX_VERSIONS_SHARED = 20, MAX_THUMB = 40000;
const revs = new Map();       // id -> last rev this browser saw or wrote
const metaSeen = new Map();   // id -> last meta from the server (tags / order survive autosaves that do not carry them)
const REF_FIELDS = ['original', 'base', 'current', 'mask'];

export const revOf = id => revs.get(id) ?? null;
export const forgetRev = id => { revs.delete(id); metaSeen.delete(id); };
export const setRev = (id, r) => revs.set(id, r);

/** Returns a copy of a design document with fn(key) applied to every image reference. */
function mapRefs(doc, fn) {
  const out = JSON.parse(JSON.stringify(doc || {}));
  const views = v => { for (const n of Object.keys(v || {})) { const d = v[n]; if (d) for (const f of REF_FIELDS) if (d[f]) d[f] = fn(d[f]); } };
  views(out.views);
  if (Array.isArray(out.references)) out.references = out.references.map(k => (k ? fn(k) : k));
  if (Array.isArray(out.versions)) for (const ver of out.versions) if (ver?.snapshot) views(ver.snapshot.views);
  return out;
}
const IS_HASH = /^[0-9a-f]{64}$/;
/** every image hash a document references (keys that never became an upload are left out: the server accepts hashes only) */
const refsOf = doc => { const s = new Set(); mapRefs(doc, k => (s.add(k), k)); return [...s].filter(k => typeof k === 'string' && IS_HASH.test(k)); };

const toBlob = v => (typeof v === 'string' ? R.dataUrlToBlob(v) : v);
const stamp = (meta, row) => ({ ...meta, id: row.id, name: row.name, rev: row.rev, createdAt: R.toMs(row.createdAt), updatedAt: R.toMs(row.updatedAt) });
const wireMeta = (meta = {}) => {
  const { id, name, rev, createdAt, updatedAt, backupBaseRev, sharedCopy, ...rest } = meta;
  if (typeof rest.thumb === 'string' && rest.thumb.length > MAX_THUMB) delete rest.thumb;
  for (const k of Object.keys(rest)) if (rest[k] === undefined) delete rest[k];
  return rest;
};
const wrap = e => (e instanceof RemoteError ? e : Object.assign(new StorageError('The shared library could not be reached. Try again in a moment.', { cause: e }), { kind: 'offline' }));

/** doc + assets -> { doc (hash keys), blobs: Map(hash -> Blob), keep: [hash] } */
async function prepare(rec) {
  const assets = rec.assets || {};
  const hashOf = new Map(), blobs = new Map();
  // Hash independent image assets concurrently; Web Crypto handles these without blocking the UI.
  await Promise.all(Object.entries(assets).map(async ([k, v]) => {
    if (v == null) return;
    const b = toBlob(v), h = await R.hashBlob(b);
    hashOf.set(k, h); blobs.set(h, b);
  }));
  const doc0 = JSON.parse(JSON.stringify(rec.doc || {}));
  if (Array.isArray(doc0.versions) && doc0.versions.length > MAX_VERSIONS_SHARED) doc0.versions = doc0.versions.slice(0, MAX_VERSIONS_SHARED);   // free database: newest 20 only
  const doc = mapRefs(doc0, k => hashOf.get(k) || k);
  return { doc, blobs, keep: refsOf(doc) };
}
async function uploadMissing(id, blobs, keep) {
  const have = keep.filter(h => blobs.has(h));
  const need = await R.missing(id, have);
  // Upload a few images at once instead of waiting for each network round-trip.
  let next = 0;
  const worker = async () => {
    while (next < need.length) {
      const h = need[next++];
      await R.putAsset(id, h, blobs.get(h));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, need.length) }, worker));
}

/** Saves a design. First save creates it; later saves send baseRev. Throws RemoteError (kind: conflict, offline, unavailable, ...). */
async function remotePut(rec, { createOnly = false } = {}) {
  const { doc, blobs, keep } = await prepare(rec);
  const prev = metaSeen.get(rec.id) || {};
  const meta = { ...rec.meta };
  if (meta.tags === undefined && prev.tags) meta.tags = prev.tags;
  if (meta.order === undefined && prev.order !== undefined) meta.order = prev.order;
  const name = String(meta.name || doc.name || 'Untitled design').slice(0, 120);
  const body = { name, meta: wireMeta(meta), doc };
  let base = revs.get(rec.id), row = null;
  if (base == null) {
    try { row = await R.create({ id: rec.id, ...body }); }
    catch (e) {
      if (e.kind !== 'conflict') throw e;
      if (createOnly) return 'exists';
      base = (await R.rev(rec.id)).rev;   // an earlier create reached the server but its answer was lost: carry on from the rev it has
    }
    if (row) {
      revs.set(rec.id, 1); metaSeen.set(rec.id, meta);
      await uploadMissing(rec.id, blobs, keep);
      return { rev: 1, updatedAt: Date.now(), created: true };
    }
  }
  await uploadMissing(rec.id, blobs, keep);
  try { row = await R.update(rec.id, { baseRev: base, ...body, keepAssets: keep }); }
  catch (e) {
    if (e.kind === 'conflict') {
      // maybe our own earlier attempt landed and only its answer was lost: then the server already holds exactly this document
      try {
        const cur = await R.get(rec.id);
        if (JSON.stringify(cur.doc) === JSON.stringify(doc)) { revs.set(rec.id, cur.rev); metaSeen.set(rec.id, meta); return { rev: cur.rev, updatedAt: R.toMs(cur.updatedAt) }; }
        e.currentRev = cur.rev;
      } catch { /* keep the conflict */ }
    }
    throw e;
  }
  revs.set(rec.id, row.rev); metaSeen.set(rec.id, meta);
  return { rev: row.rev, updatedAt: R.toMs(row.updatedAt) || Date.now() };
}

async function remoteList() {
  const { designs = [] } = await R.list();
  return designs.map(d => { metaSeen.set(d.id, d.meta || {}); return stamp(d.meta || {}, d); });
}

async function remoteGet(id) {
  let d;
  try { d = await R.get(id); } catch (e) { if (e.kind === 'notfound') return null; throw e; }
  const assets = {};
  // The server's asset list is authoritative. Older documents can retain hashes in
  // saved-version snapshots after those images have been garbage-collected. Trying
  // to download every hash found anywhere in the document made one stale snapshot
  // prevent the entire design from opening.
  const hashes = [...new Set(d.assets || [])].filter(h => /^[0-9a-f]{64}$/.test(h));
  let i = 0;
  const worker = async () => {
    while (i < hashes.length) {
      const h = hashes[i++];
      try { assets[h] = await R.getAsset(id, h); }
      catch (e) {
        // A missing image should not make the whole design inaccessible. Hydration
        // treats absent assets as null; connection/server errors still surface.
        if (e.kind !== 'assetmissing' && e.kind !== 'notfound') throw e;
        console.warn('Shared design has a missing image asset', id, h);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, hashes.length) }, worker));
  revs.set(id, d.rev); metaSeen.set(id, d.meta || {});
  return { id, rev: d.rev, meta: stamp(d.meta || {}, d), doc: d.doc, assets };
}

/** Meta and/or doc fields change without touching images. Retries when someone else saved in between. */
async function remotePatch(id, { meta = {}, doc = {} } = {}) {
  for (let tries = 0; ; tries++) {
    const d = await R.get(id);
    const newMeta = { ...(d.meta || {}), ...meta }, newDoc = { ...(d.doc || {}), ...doc };
    const name = String(newMeta.name || newDoc.name || d.name || 'Untitled design').slice(0, 120);
    try {
      const row = await R.update(id, { baseRev: d.rev, name, meta: wireMeta(newMeta), doc: newDoc, keepAssets: refsOf(newDoc) });
      metaSeen.set(id, newMeta);
      if (revs.has(id)) revs.set(id, row.rev);
      return stamp(newMeta, { id, name, rev: row.rev, createdAt: d.createdAt, updatedAt: row.updatedAt });
    } catch (e) { if (e.kind !== 'conflict' || tries >= 3) throw e; }
  }
}

/* ---------------------------------------------------------------- public interface */
export async function listDesigns() {
  if (!R.sharedEnabled()) return localList();
  try { return await remoteList(); } catch (e) { throw wrap(e); }
}
export async function getDesign(id) {
  if (!R.sharedEnabled()) return localGet(id);
  try { return await remoteGet(id); } catch (e) { throw wrap(e); }
}
export async function putDesign(rec, opts) {
  if (!R.sharedEnabled()) return localPut(rec);
  try { return await remotePut(rec, opts); } catch (e) { throw wrap(e); }
}
export async function patchDesign(id, p) {
  if (!R.sharedEnabled()) return localPatch(id, p);
  try { return await remotePatch(id, p); } catch (e) { throw wrap(e); }
}
export async function deleteDesign(id) {
  if (!R.sharedEnabled()) return localDelete(id);
  try { await R.del(id); } catch (e) { if (e.kind !== 'notfound') throw wrap(e); }
  forgetRev(id); await localDelete(id).catch(() => { });
}
/** Makes a copy named `name` and returns its id. */
export async function duplicateDesign(srcId, name) {
  const now = Date.now(), id = newId();
  if (!R.sharedEnabled()) {
    const rec = await localGet(srcId);
    if (!rec) throw Object.assign(new Error('That design no longer exists. It may have been deleted in another tab.'), { user: true });
    await localPut({
      id,
      meta: { ...rec.meta, id, name, createdAt: now, updatedAt: now, order: undefined },
      doc: { ...rec.doc, name, createdAt: now, updatedAt: now },
      assets: rec.assets,
    });
    return id;
  }
  try {
    await R.duplicate(srcId, id, name);
    await remotePatch(id, { meta: { name, order: undefined }, doc: { name, createdAt: now, updatedAt: now } });
    return id;
  } catch (e) {
    if (e.kind === 'notfound') throw Object.assign(new Error('That design no longer exists. It may have been deleted by someone else.'), { user: true });
    throw wrap(e);
  }
}

/* ---------------------------------------------------------------- per-browser copies next to the shared library */
/** The old per-browser store, used in shared mode for backups of unsaved work and for moving old designs across. */
export const local = {
  list: async () => { await initStorage(); return localList(); },
  get: localGet, put: localPut, patch: localPatch, delete: localDelete,
};
/** Backup of unsynced changes to a shared design (never offered for moving). */
export async function backupLocally(rec, baseRev) {
  await initStorage();
  await localPut({ ...rec, meta: { ...rec.meta, backupBaseRev: baseRev ?? null } });
}
export async function getBackup(id) { await initStorage(); try { const r = await localGet(id); return r && r.meta && 'backupBaseRev' in r.meta ? r : null; } catch { return null; } }
export const dropBackup = id => localDelete(id).catch(() => { });
/** Designs saved only in this browser (before the shared library) that have not been moved yet. */
export async function movableLocalDesigns() {
  if (!R.sharedEnabled()) return [];
  try { return (await local.list()).filter(m => !('backupBaseRev' in m) && !m.sharedCopy); } catch { return []; }
}
/** Uploads one per-browser design to the shared library under the same id. Returns 'created', 'exists' or 'missing'. */
export async function moveLocalDesign(id) {
  const rec = await localGet(id);
  if (!rec) return 'missing';
  try {
    const r = await remotePut({ ...rec, meta: { ...rec.meta, order: undefined } }, { createOnly: true });
    forgetRev(id);
    return r === 'exists' ? 'exists' : 'created';
  } catch (e) { throw wrap(e); }
}
