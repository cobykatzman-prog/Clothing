// Design storage (owner: home/gallery).
// IndexedDB first; localStorage if IndexedDB is unavailable; an in-memory map as a last resort.
// Record: { id, meta: {id,name,createdAt,updatedAt,thumb,views,kind}, doc, assets: {key: Blob|dataURL} }
// Every call is async and reports failures as StorageError (quota errors flagged with .quota).

const DB_NAME = 'threadform', DB_VERSION = 1;
const STORE_FULL = 'designs', STORE_META = 'meta';
const LS_INDEX = 'threadform.index.v1', LS_PREFIX = 'threadform.design.v1.';

let mode = null, dbPromise = null;
const memory = new Map();

export class StorageError extends Error {
  constructor(message, { quota = false, cause = null } = {}) {
    super(message); this.name = 'StorageError'; this.quota = quota; this.cause = cause; this.user = true;
  }
}
export const isQuotaError = e => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
export const newId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const storageMode = () => mode || 'unknown';

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
export async function listDesigns() {
  const m = await initStorage();
  try {
    if (m === 'indexeddb') { const db = await openDB(); return await reqP(db.transaction(STORE_META).objectStore(STORE_META).getAll()); }
    if (m === 'localstorage') return lsIndex();
    return [...memory.values()].map(r => r.meta);
  } catch (e) { throw new StorageError('Your saved designs could not be read. Reload the page to try again.', { cause: e }); }
}

/** Full record or null. */
export async function getDesign(id) {
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
export async function putDesign(rec) {
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
export async function patchDesign(id, { meta = {}, doc = {} } = {}) {
  const rec = await getDesign(id);
  if (!rec) throw new StorageError('That design no longer exists. It may have been deleted in another tab.');
  rec.meta = { ...rec.meta, ...meta };
  rec.doc = { ...(rec.doc || {}), ...doc };
  await putDesign(rec);
  return rec.meta;
}

export async function deleteDesign(id) {
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
