// Shared-library client (owner: sync). Talks only to this site's own server (same origin), see SHARED-API.md.
// Nothing here runs unless <meta name="threadform-shared" content="1"> is present (see storage.js).
// Failures are typed RemoteError objects with a plain-language message, never raw server text.

export const sharedEnabled = () => typeof document !== 'undefined' && !!document.querySelector('meta[name="threadform-shared"][content="1"]');

const MESSAGES = {
  offline: 'Could not reach the shared library. Check your internet connection; Threadform will keep trying.',
  unavailable: 'The shared library is not answering right now. Threadform will keep trying.',
  auth: 'Your login has expired. Reload the page and log in again.',
  conflict: 'Someone else changed this design while you were editing it.',
  notfound: 'That design is no longer in the shared library. It may have been deleted.',
  toolarge: 'This design is too large for the shared library. Remove some images or old versions and try again.',
  bad: 'The shared library could not accept that change. Try again in a moment.',
};
export class RemoteError extends Error {
  /** kind: offline | unavailable | auth | conflict | notfound | toolarge | bad */
  constructor(kind, { status = 0, currentRev = null, cause = null } = {}) {
    super(MESSAGES[kind] || MESSAGES.bad);
    this.name = 'RemoteError'; this.kind = kind; this.status = status; this.currentRev = currentRev; this.cause = cause; this.user = true;
  }
  /** worth retrying later without the user doing anything */
  get transient() { return this.kind === 'offline' || this.kind === 'unavailable'; }
}

const ID = encodeURIComponent;

async function call(method, path, { json, body, type, timeout = 30000, raw = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    const headers = {};
    let payload;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    else if (body !== undefined) { headers['Content-Type'] = type || 'application/octet-stream'; payload = body; }
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new RemoteError('offline', { cause: e });
  }
  clearTimeout(timer);
  const status = res.status;
  if (status === 401 || status === 403) throw new RemoteError('auth', { status });
  if (status === 404) throw new RemoteError('notfound', { status });
  if (status === 413) throw new RemoteError('toolarge', { status });
  if (status === 409) {
    let cur = null; try { cur = (await res.json()).currentRev ?? null; } catch { /* no body */ }
    throw new RemoteError('conflict', { status, currentRev: cur });
  }
  if (status >= 500) throw new RemoteError('unavailable', { status });
  if (!res.ok) throw new RemoteError('bad', { status });
  try {
    if (raw) return await res.blob();
    const ct = res.headers.get('content-type') || '';
    if (!/json/i.test(ct)) throw new RemoteError('auth', { status });   // a login page instead of JSON: the session ended
    return await res.json();
  } catch (e) {
    if (e instanceof RemoteError) throw e;
    throw new RemoteError('offline', { cause: e });   // body cut off mid-way
  }
}

// ---- hashing ----
const hashCache = new WeakMap();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
/** lowercase hex sha-256 of a Blob (cached per Blob object) */
export function hashBlob(blob) {
  if (!hashCache.has(blob)) {
    hashCache.set(blob, (async () => {
      if (!self.crypto?.subtle) throw new RemoteError('bad');
      return hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    })().catch(e => { hashCache.delete(blob); throw e; }));
  }
  return hashCache.get(blob);
}
export const hashCanvas = (canvas) => new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/png')).then(async blob => ({ blob, hash: await hashBlob(blob) }));

export function dataUrlToBlob(u) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(u);
  if (!m) throw new Error('bad data url');
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: m[1] || 'application/octet-stream' });
}
const OK_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** the server checks magic bytes against the type, so find the real type */
export async function mimeOf(blob) {
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return OK_MIME.has(blob.type) ? blob.type : 'image/png';
}

// ---- downloaded assets: kept in memory (they are immutable, addressed by hash) ----
const assetCache = new Map();   // `${id}/${hash}` -> Blob
let assetBytes = 0;
const ASSET_CACHE_MAX = 96 * 1024 * 1024;
function remember(key, blob) {
  if (assetCache.has(key)) return;
  assetCache.set(key, blob); assetBytes += blob.size;
  while (assetBytes > ASSET_CACHE_MAX && assetCache.size > 1) {
    const [k, v] = assetCache.entries().next().value; assetCache.delete(k); assetBytes -= v.size;
  }
}
async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (!(e instanceof RemoteError) || !e.transient) throw e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}

// ---- the contract ----
/** fresh: skip the server's 30 s cache (the "Check connection" button) */
export const status = (fresh = false) => call('GET', '/api/shared/status' + (fresh ? '?fresh=1' : ''), { timeout: 15000 });
export const list = () => call('GET', '/api/designs');
export const get = id => call('GET', `/api/designs/${ID(id)}`);
export const rev = id => call('GET', `/api/designs/${ID(id)}/rev`, { timeout: 12000 });
export const create = body => call('POST', '/api/designs', { json: body });
export const update = (id, body) => call('PUT', `/api/designs/${ID(id)}`, { json: body });
export const del = id => call('DELETE', `/api/designs/${ID(id)}`);
export const duplicate = (id, newId, name) => call('POST', `/api/designs/${ID(id)}/duplicate`, { json: { newId, name } });
export const missing = async (id, hashes) => hashes.length ? (await call('POST', `/api/designs/${ID(id)}/missing`, { json: { hashes } })).missing || [] : [];
export async function putAsset(id, hash, blob) {
  const type = await mimeOf(blob);
  await call('PUT', `/api/designs/${ID(id)}/assets/${hash}`, { body: blob, type, timeout: 90000 });
  remember(`${id}/${hash}`, blob);
}
export async function getAsset(id, hash) {
  const key = `${id}/${hash}`;
  if (assetCache.has(key)) return assetCache.get(key);
  const blob = await retry(() => call('GET', `/api/designs/${ID(id)}/assets/${hash}`, { raw: true, timeout: 60000 }));
  remember(key, blob);
  return blob;
}

export const timeAgo = t => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
export const toMs = v => (typeof v === 'number' ? v : Date.parse(v) || 0);
