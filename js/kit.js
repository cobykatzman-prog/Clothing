// Brand Kit storage (owner: sync): brand assets (images), colour palettes, typography sets, materials and collections.
// With the shared library on (<meta name="threadform-shared">) they live on the server so everybody in the workspace
// sees the same kit; otherwise they stay in this browser exactly as before. No DOM: UI code calls this module.
//
// Edits are applied locally first and queued; the queue is flushed with retries (offline-safe, survives a reload).
// Conflicts never overwrite someone else's work: the other version is kept and yours is saved as "<name> (my version)".
// Images are stored once by sha-256 (assets), items only reference the hash: no base64 in item data.
import * as R from './remote.js';
import { syncState, backoff } from './syncstate.js';

export const KINDS = ['asset', 'palette', 'typography', 'material', 'collection'];
const LS_LOCAL = 'threadform.kit.v1', LS_SHARED = 'threadform.kit.shared.v1';
const SRC = 'brandkit';

let state = null;            // { items: {kind: {id: item}}, queue: [op] }
let loadedFor = null;        // which key state was loaded from
const subs = new Set();
const shared = () => R.sharedEnabled();
const key = () => (shared() ? LS_SHARED : LS_LOCAL);
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };

function load() {
  if (state && loadedFor === key()) return state;
  loadedFor = key(); state = { items: {}, queue: [] };
  try {
    const s = JSON.parse(lsGet(key()) || 'null');
    if (s && s.items && typeof s.items === 'object') state = { items: s.items, queue: Array.isArray(s.queue) ? s.queue : [] };
  } catch { /* start empty */ }
  for (const k of KINDS) state.items[k] = state.items[k] || {};
  return state;
}
function persist() { lsSet(key(), JSON.stringify(load())); }
function changed() { subs.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }
export function onKitChange(fn) { subs.add(fn); return () => subs.delete(fn); }
/** test helper: forget the in-memory copy (and optionally storage) */
export function _resetKit({ storage = false } = {}) {
  state = null; loadedFor = null; blobMem.clear(); clearTimeout(timer); retryN = 0; flushP = null;
  if (storage) for (const k of [LS_LOCAL, LS_SHARED]) { try { localStorage.removeItem(k); } catch { /* no storage */ } }
}

export const newKitId = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = (kind, it) => ({ kind, id: it.id, name: String(it.name || 'Untitled').slice(0, 120), data: it.data || {}, rev: it.rev || 0, updatedBy: it.updatedBy || null, updatedAt: it.updatedAt || 0 });
const sortItems = a => a.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0) || String(x.name).localeCompare(String(y.name)));

/* ---------------------------------------------------------------- image blobs (kept locally until uploaded) */
const blobMem = new Map();
let idbP = null;
function idb() {
  if (!idbP) idbP = new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
    const r = indexedDB.open('threadform-kit', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('blobs');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return idbP;
}
async function blobPut(hash, blob) {
  blobMem.set(hash, blob);
  try {
    const db = await idb();
    await new Promise((res, rej) => { const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put(blob, hash); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch { /* memory only */ }
}
async function blobGet(hash) {
  if (blobMem.has(hash)) return blobMem.get(hash);
  try {
    const db = await idb();
    const b = await new Promise((res, rej) => { const q = db.transaction('blobs').objectStore('blobs').get(hash); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    if (b) { blobMem.set(hash, b); return b; }
  } catch { /* not stored locally */ }
  return null;
}
/** The image of a brand asset: local copy first, then the shared kit. */
export async function getKitAssetBlob(hash) {
  const b = await blobGet(hash);
  if (b) return b;
  if (!shared()) return null;
  const r = await R.kitGetBlob(hash);
  await blobPut(hash, r);
  return r;
}

/* ---------------------------------------------------------------- reading */
/** Items of one kind (or all), newest first. In shared mode refreshes from the server; offline it answers from the local copy. Returns { items, offline }. */
export async function listKit(kind) {
  const st = load();
  let offline = false;
  if (shared()) {
    try {
      const { items = [] } = await R.kitList();
      const pend = new Set(st.queue.map(o => `${o.kind}/${o.id}`));
      const fresh = Object.fromEntries(KINDS.map(k => [k, {}]));
      for (const it of items) {
        if (!KINDS.includes(it.kind)) continue;
        const mine = st.items[it.kind][it.id];
        fresh[it.kind][it.id] = pend.has(`${it.kind}/${it.id}`) && mine ? { ...mine, rev: it.rev } : norm(it.kind, { ...it, updatedAt: R.toMs(it.updatedAt) });
      }
      for (const k of KINDS) for (const [id, it] of Object.entries(st.items[k])) if (!fresh[k][id] && pend.has(`${k}/${id}`)) fresh[k][id] = it;   // created here, not uploaded yet
      st.items = fresh; persist();
      flush();
    } catch (e) { if (!(e instanceof R.RemoteError)) throw e; offline = true; }
  }
  const kinds = kind ? [kind] : KINDS;
  return { items: sortItems(kinds.flatMap(k => Object.values(st.items[k] || {}))), offline };
}
export const cachedKit = kind => { const st = load(); return sortItems((kind ? [kind] : KINDS).flatMap(k => Object.values(st.items[k] || {}))); };
export const pendingCount = () => load().queue.length;

/* ---------------------------------------------------------------- writing */
function enqueue(op) {
  const st = load();
  st.queue = st.queue.filter(o => !(o.kind === op.kind && o.id === op.id && (op.type === 'delete' || o.type === 'put')));   // newest edit wins inside the queue
  st.queue.push(op);
}
/** Creates or updates an item. item: { id?, name, data }. Returns the stored item (rev is updated when the server confirms). */
export async function saveKitItem(kind, item) {
  if (!KINDS.includes(kind)) throw new Error('unknown kit kind');
  const st = load(), id = item.id || newKitId(), prev = st.items[kind][id];
  const rec = norm(kind, { ...item, id, rev: prev ? prev.rev : 0, updatedAt: Date.now() });
  st.items[kind][id] = rec;
  if (shared()) { enqueue({ type: 'put', kind, id }); syncState.set(SRC, 'saving', { pending: st.queue.length }); }
  persist(); changed();
  if (shared()) flush();
  return rec;
}
export async function deleteKitItem(kind, id) {
  const st = load();
  delete st.items[kind][id];
  if (shared()) { enqueue({ type: 'delete', kind, id }); syncState.set(SRC, 'saving', { pending: st.queue.length }); }
  persist(); changed();
  if (shared()) flush();
}
/** Adds an image to the brand assets. The bytes are uploaded once by hash; the item only holds the hash. */
export async function addKitAsset(blob, name, extra = {}) {
  const hash = await R.hashBlob(blob), mime = await R.mimeOf(blob);
  await blobPut(hash, blob);
  return saveKitItem('asset', { name: name || 'Image', data: { hash, mime, bytes: blob.size, ...extra } });
}

/* ---------------------------------------------------------------- syncing */
let timer = 0, retryN = 0;
const scheduleRetry = () => { clearTimeout(timer); timer = setTimeout(flush, backoff(retryN++)); if (timer.unref) timer.unref(); };
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', () => { retryN = 0; flush(); });

async function runOp(op) {
  const st = load(), it = st.items[op.kind][op.id];
  if (op.type === 'delete') {
    try { await R.kitDelete(op.kind, op.id); } catch (e) { if (e.kind !== 'notfound') throw e; }
    return;
  }
  if (!it) return;   // deleted again meanwhile
  if (op.kind === 'asset' && it.data.hash) {
    const [need] = await R.kitMissing([it.data.hash]).then(m => m);
    if (need) { const b = await blobGet(need); if (!b) throw Object.assign(new R.RemoteError('bad'), { message: 'The image for this brand asset is no longer on this device.' }); await R.kitPutBlob(need, b); }
  }
  const res = await R.kitPut(op.kind, op.id, { baseRev: it.rev || 0, name: it.name, data: it.data });
  it.rev = res.rev; it.updatedAt = R.toMs(res.updatedAt) || Date.now(); it.updatedBy = res.updatedBy || it.updatedBy;
}
const sameContent = (a, b) => a.name === b.name && JSON.stringify(a.data) === JSON.stringify(b.data);

/** Someone else changed the same item: keep their version in place and save ours as a separate "(my version)" item. */
async function resolveConflict(op) {
  const st = load(), mine = st.items[op.kind][op.id];
  if (!mine) return null;
  const { items = [] } = await R.kitList(op.kind);
  const theirs = items.find(x => x.id === op.id);
  if (!theirs) { mine.rev = 0; return null; }   // they deleted it: our version simply comes back
  if (sameContent(mine, theirs)) { mine.rev = theirs.rev; return 'same'; }   // already identical: nothing to send
  st.items[op.kind][op.id] = norm(op.kind, { ...theirs, updatedAt: R.toMs(theirs.updatedAt) });
  const copyId = newKitId();
  st.items[op.kind][copyId] = norm(op.kind, { id: copyId, name: String(mine.name).replace(/ \(my version\)$/, '').slice(0, 100) + ' (my version)', data: mine.data, rev: 0, updatedAt: Date.now() });
  st.queue.push({ type: 'put', kind: op.kind, id: copyId });
  return `Someone else changed "${mine.name}" at the same time. Their version is shown, and yours was kept as "${st.items[op.kind][copyId].name}".`;
}

/** Sends queued edits to the server in order. Safe to call any time; one run at a time. */
export function flush() {
  if (!shared()) return Promise.resolve();
  if (!flushP) flushP = runFlush().catch(e => { console.error('Brand Kit sync failed', e); syncState.set(SRC, 'error', { pending: load().queue.length, detail: 'Brand Kit changes could not be sent. They are kept on this device.' }); }).finally(() => { flushP = null; });
  return flushP;
}
let flushP = null;
async function runFlush() {
  const st = load();
  if (!st.queue.length) { syncState.set(SRC, 'saved'); return; }
  {
    while (st.queue.length) {
      const op = st.queue[0];
      try { await runOp(op); st.queue.shift(); retryN = 0; persist(); changed(); }
      catch (e) {
        if (!(e instanceof R.RemoteError)) throw e;
        if (e.transient || e.kind === 'auth') { syncState.set(SRC, 'offline', { pending: st.queue.length, detail: e.message }); scheduleRetry(); return; }
        if (e.kind === 'conflict' || (e.kind === 'notfound' && op.type === 'put' && !op.retried)) {
          let note = null;
          if (e.kind === 'notfound') { op.retried = true; const it = st.items[op.kind][op.id]; if (it) it.rev = 0; continue; }
          try { note = await resolveConflict(op); } catch (e2) { if (e2 instanceof R.RemoteError && e2.transient) { syncState.set(SRC, 'offline', { pending: st.queue.length }); scheduleRetry(); return; } throw e2; }
          if (note === 'same') { st.queue.shift(); persist(); changed(); continue; }
          if (note) { st.queue.shift(); persist(); changed(); syncState.set(SRC, 'conflict', { pending: st.queue.length, detail: note }); lastConflict = note; continue; }
          continue;   // identical content or they deleted it: run the same op again with the corrected rev
        }
        // a permanent refusal (view-only role, too large...): drop this edit so the queue is not stuck, and say so
        st.queue.shift(); persist();
        if (e.kind === 'forbidden' || e.kind === 'toolarge' || e.kind === 'bad' || e.kind === 'notfound') { syncState.set(SRC, 'error', { pending: st.queue.length, detail: e.message }); lastError = e.message; }
        else throw e;
      }
    }
    if (syncState.get().kind !== 'conflict' && syncState.get().kind !== 'error') syncState.set(SRC, 'saved');
    else syncState.set(SRC, lastError ? 'error' : 'conflict', { pending: 0, detail: lastError || lastConflict });
  }
}
let lastConflict = '', lastError = '';
/** the user has seen the conflict/error message: back to a normal state */
export function acknowledgeKit() { lastConflict = ''; lastError = ''; syncState.set(SRC, load().queue.length ? 'saving' : 'saved', { pending: load().queue.length }); }

/* ---------------------------------------------------------------- moving per-browser kit items to the shared kit */
export function movableKitItems() {
  if (!shared()) return [];
  try {
    const s = JSON.parse(lsGet(LS_LOCAL) || 'null');
    return s && s.items ? KINDS.flatMap(k => Object.values(s.items[k] || {}).map(it => norm(k, { ...it, id: it.id || newKitId() }))) : [];
  } catch { return []; }
}
/** Queues every per-browser item for upload (new ids are kept, so running it twice is harmless: existing ids are skipped by the server with a conflict that resolves to "same content"). */
export async function moveLocalKit() {
  const items = movableKitItems();
  for (const it of items) { const st = load(); if (!st.items[it.kind][it.id]) { st.items[it.kind][it.id] = { ...it, rev: 0 }; enqueue({ type: 'put', kind: it.kind, id: it.id }); } }
  persist(); changed();
  try { localStorage.removeItem(LS_LOCAL); } catch { /* ignore */ }
  await flush();
  return items.length;
}
