// Shared design library: server side. Zero dependencies (Node built-ins + global fetch).
// Stores designs and their images in a Supabase Postgres project through PostgREST. The Supabase key lives only
// in this process: it is never logged and never sent to the browser. See SHARED-API.md for the contract.
//
//   SUPABASE_URL          e.g. https://abcdxyz.supabase.co
//   SUPABASE_SERVICE_KEY  the project's service_role key (server only)
import crypto from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_ASSET = 8 * 1024 * 1024, MAX_DOC = 1.5 * 1024 * 1024, MAX_META = 80 * 1024, MAX_NAME = 120, MAX_ASSETS = 200;
const MAX_JSON_BODY = MAX_DOC + MAX_META + 16 * 1024;
const UPSTREAM_TIMEOUT = 15000, STATUS_TTL = 30000;
const GENERIC = 'shared library unavailable';

const MAGIC = {
  'image/png': b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'
};

class Upstream extends Error { constructor(kind, status) { super(kind); this.kind = kind; this.status = status; } }
class HttpErr extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; this.extra = extra; } }

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteLen = v => Buffer.byteLength(JSON.stringify(v));

export const OWNS = /^\/api\/(shared|designs)(\/|$)/;

export function createShared({ env = process.env, baseHeaders, sameOriginPost }) {
  const rawUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const KEY = String(env.SUPABASE_SERVICE_KEY || '').trim();
  const enabled = !!(rawUrl && KEY);

  let origin = null, urlProblem = '';
  if (enabled) {
    try {
      const u = new URL(rawUrl);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) urlProblem = 'SUPABASE_URL must start with https://';
      else origin = u.origin + u.pathname.replace(/\/+$/, '');
    } catch (_) { urlProblem = 'SUPABASE_URL is not a valid web address.'; }
  }

  /* ---------------- PostgREST ---------------- */
  async function rest(method, pathQuery, { body, prefer } = {}) {
    if (!origin) throw new Upstream('config');
    const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    if (prefer) headers.Prefer = prefer;
    let res, text;
    try {
      res = await fetch(`${origin}/rest/v1/${pathQuery}`, { method, headers, body: payload, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT), redirect: 'error' });
      text = await res.text();
    } catch (_) { throw new Upstream('network'); }    // never include the error: it may mention the URL or headers
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* HTML from a gateway, etc. */ }
    return { status: res.status, json, range: res.headers.get('content-range') || '' };
  }
  const code = r => (r.json && typeof r.json.code === 'string' ? r.json.code : '');
  const need = (r, ...okStatuses) => { if (!okStatuses.includes(r.status)) throw new Upstream('http', r.status); return r; };

  /* ---------------- status ---------------- */
  function reason(r) {
    if (r.status === 401 || r.status === 403) return 'Supabase rejected the key. Check that SUPABASE_SERVICE_KEY is the service_role key from Project Settings > API.';
    if (r.status === 404 && ['PGRST205', '42P01', 'PGRST200'].includes(code(r))) return 'The database tables are missing. Run supabase/schema.sql in the Supabase SQL editor.';
    if (r.status === 404) return 'Supabase project not found. Check SUPABASE_URL.';
    if (r.status >= 500 || r.status === 429) return 'The Supabase project is not responding. Free projects pause after about a week of inactivity: open the Supabase dashboard and restore it.';
    return 'Supabase returned an unexpected answer (HTTP ' + r.status + ').';
  }
  let cache = null;
  async function status(fresh) {
    if (!fresh && cache && Date.now() - cache.at < STATUS_TTL) return cache.v;
    let v;
    if (urlProblem) v = { enabled: true, ok: false, error: urlProblem };
    else {
      try {
        const a = await rest('GET', 'designs?select=id&limit=1', { prefer: 'count=exact' });
        if (a.status !== 200 && a.status !== 206) v = { enabled: true, ok: false, error: reason(a) };
        else {
          const b = await rest('GET', 'assets?select=hash&limit=1');
          if (b.status !== 200 && b.status !== 206) v = { enabled: true, ok: false, error: reason(b) };
          else { const n = Number((a.range.split('/')[1] || '').trim()); v = { enabled: true, ok: true, designs: Number.isFinite(n) ? n : (Array.isArray(a.json) ? a.json.length : 0) }; }
        }
      } catch (e) {
        v = { enabled: true, ok: false, error: e instanceof Upstream && e.kind === 'network' ? 'Cannot reach Supabase. Check SUPABASE_URL, and that the project is not paused (restore it in the Supabase dashboard).' : 'The shared library is not configured correctly.' };
      }
    }
    cache = { at: Date.now(), v };
    return v;
  }

  /* ---------------- request helpers ---------------- */
  const json = (req, res, status, obj, extra = {}) => { res.writeHead(status, baseHeaders(req, { 'Content-Type': 'application/json; charset=utf-8', ...extra })); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(obj)); };

  // Reads the body up to `limit` bytes. Past the limit the rest is drained (not stored) so a normal 413 can be sent.
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      let size = 0, over = Number.isFinite(declared) && declared > limit; const chunks = [];
      req.on('data', c => { size += c.length; if (size > limit) over = true; else if (!over) chunks.push(c); });
      req.on('end', () => over ? reject(new HttpErr(413, 'too large')) : resolve(Buffer.concat(chunks)));
      req.on('error', () => reject(new HttpErr(400, 'bad request')));
    });
  }
  async function readJson(req) {
    const buf = await readBody(req, MAX_JSON_BODY);
    let v; try { v = JSON.parse(buf.toString('utf8')); } catch (_) { throw new HttpErr(400, 'invalid JSON'); }
    if (!isObj(v)) throw new HttpErr(400, 'invalid JSON');
    return v;
  }
  function checkName(n) { if (typeof n !== 'string' || !n.trim() || n.length > MAX_NAME) throw new HttpErr(n && typeof n === 'string' && n.length > MAX_NAME ? 413 : 400, 'invalid name'); return n.trim(); }
  function checkMeta(m) { if (!isObj(m)) throw new HttpErr(400, 'invalid meta'); if (byteLen(m) > MAX_META) throw new HttpErr(413, 'meta too large'); return m; }
  function checkDoc(d) { if (!isObj(d)) throw new HttpErr(400, 'invalid doc'); if (byteLen(d) > MAX_DOC) throw new HttpErr(413, 'doc too large'); return d; }
  function checkHashes(a, max = MAX_ASSETS) {
    if (!Array.isArray(a) || a.length > max || !a.every(h => typeof h === 'string' && HASH_RE.test(h))) throw new HttpErr(400, 'invalid hashes');
    return [...new Set(a)];
  }
  const rowOut = r => ({ id: r.id, name: r.name, rev: r.rev, meta: r.meta, createdAt: r.created_at, updatedAt: r.updated_at });
  const q = s => encodeURIComponent(s);

  /* ---------------- handlers ---------------- */
  async function listDesigns() {
    const r = need(await rest('GET', 'designs?select=id,name,rev,meta,created_at,updated_at&order=updated_at.desc&limit=1000'), 200, 206);
    return { designs: (Array.isArray(r.json) ? r.json : []).map(rowOut) };
  }
  async function getDesign(id) {
    const r = need(await rest('GET', `designs?id=eq.${id}&select=*`), 200);
    const row = Array.isArray(r.json) && r.json[0];
    if (!row) throw new HttpErr(404, 'not found');
    const a = need(await rest('GET', `assets?design_id=eq.${id}&select=hash`), 200, 206);
    return { ...rowOut(row), doc: row.doc, assets: (Array.isArray(a.json) ? a.json : []).map(x => x.hash) };
  }
  async function getRev(id) {
    const r = need(await rest('GET', `designs?id=eq.${id}&select=rev,updated_at`), 200);
    const row = Array.isArray(r.json) && r.json[0];
    if (!row) throw new HttpErr(404, 'not found');
    return { id, rev: row.rev, updatedAt: row.updated_at };
  }
  async function createDesign(b) {
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) throw new HttpErr(400, 'invalid id');
    const row = { id: b.id, name: checkName(b.name), meta: checkMeta(b.meta === undefined ? {} : b.meta), doc: checkDoc(b.doc), rev: 1 };
    const r = await rest('POST', 'designs?select=rev', { body: row, prefer: 'return=representation' });
    if (r.status === 409) throw new HttpErr(409, 'exists', { currentRev: undefined });
    need(r, 201, 200);
    return { rev: 1 };
  }
  async function updateDesign(id, b) {
    const baseRev = b.baseRev;
    if (!Number.isInteger(baseRev) || baseRev < 1 || baseRev > 2147483646) throw new HttpErr(400, 'invalid baseRev');
    const name = checkName(b.name), meta = checkMeta(b.meta === undefined ? {} : b.meta), doc = checkDoc(b.doc);
    const keep = b.keepAssets === undefined ? null : checkHashes(b.keepAssets);
    const updatedAt = new Date().toISOString();
    const r = need(await rest('PATCH', `designs?id=eq.${id}&rev=eq.${baseRev}&select=rev,updated_at`, { body: { name, meta, doc, rev: baseRev + 1, updated_at: updatedAt }, prefer: 'return=representation' }), 200);
    if (!Array.isArray(r.json) || !r.json.length) {
      const cur = need(await rest('GET', `designs?id=eq.${id}&select=rev`), 200);
      const row = Array.isArray(cur.json) && cur.json[0];
      if (!row) throw new HttpErr(404, 'not found');
      throw new HttpErr(409, 'conflict', { currentRev: row.rev });
    }
    if (keep) {      // garbage-collect images this design no longer uses (best effort: the save itself already succeeded)
      try { await rest('DELETE', keep.length ? `assets?design_id=eq.${id}&hash=not.in.(${keep.join(',')})` : `assets?design_id=eq.${id}`); } catch (_) { /* ignore */ }
    }
    return { rev: baseRev + 1, updatedAt: r.json[0].updated_at || updatedAt };
  }
  async function deleteDesign(id) {
    need(await rest('DELETE', `designs?id=eq.${id}`), 200, 204);
    return { ok: true };
  }
  async function duplicateDesign(id, b) {
    const newId = b.newId === undefined ? crypto.randomBytes(12).toString('base64url') : b.newId;
    if (typeof newId !== 'string' || !ID_RE.test(newId)) throw new HttpErr(400, 'invalid newId');
    const src = need(await rest('GET', `designs?id=eq.${id}&select=name,meta,doc`), 200);
    const row = Array.isArray(src.json) && src.json[0];
    if (!row) throw new HttpErr(404, 'not found');
    const name = b.name === undefined ? `${row.name} copy`.slice(0, MAX_NAME) : checkName(b.name);
    const ins = await rest('POST', 'designs?select=rev', { body: { id: newId, name, meta: row.meta, doc: row.doc, rev: 1 }, prefer: 'return=representation' });
    if (ins.status === 409) throw new HttpErr(409, 'exists');
    need(ins, 201, 200);
    try {
      const list = need(await rest('GET', `assets?design_id=eq.${id}&select=hash`), 200, 206);
      for (const { hash } of Array.isArray(list.json) ? list.json : []) {
        const a = need(await rest('GET', `assets?design_id=eq.${id}&hash=eq.${hash}&select=hash,mime,data,bytes`), 200);
        const x = Array.isArray(a.json) && a.json[0]; if (!x) continue;
        const c = await rest('POST', 'assets', { body: { design_id: newId, hash: x.hash, mime: x.mime, data: x.data, bytes: x.bytes } });
        if (c.status !== 409) need(c, 201, 200, 204);
      }
    } catch (e) { try { await rest('DELETE', `designs?id=eq.${newId}`); } catch (_) { /* ignore */ } throw e; }
    return { id: newId, rev: 1, name };
  }
  async function missing(id, b) {
    const hashes = checkHashes(b.hashes);
    if (!hashes.length) return { missing: [] };
    const r = need(await rest('GET', `assets?design_id=eq.${id}&hash=in.(${hashes.join(',')})&select=hash`), 200, 206);
    const have = new Set((Array.isArray(r.json) ? r.json : []).map(x => x.hash));
    return { missing: hashes.filter(h => !have.has(h)) };
  }
  async function putAsset(req, id, hash) {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!MAGIC[mime]) { await readBody(req, 0).catch(() => {}); throw new HttpErr(415, 'unsupported type'); }
    const buf = await readBody(req, MAX_ASSET);
    if (!buf.length || !MAGIC[mime](buf)) throw new HttpErr(400, 'not a valid image');
    if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) throw new HttpErr(400, 'hash mismatch');
    const d = need(await rest('GET', `designs?id=eq.${id}&select=id`), 200);
    if (!Array.isArray(d.json) || !d.json.length) throw new HttpErr(404, 'not found');
    const have = need(await rest('GET', `assets?design_id=eq.${id}&select=hash&limit=${MAX_ASSETS + 1}`), 200, 206);
    const hs = Array.isArray(have.json) ? have.json.map(x => x.hash) : [];
    if (hs.includes(hash)) return { ok: true };
    if (hs.length >= MAX_ASSETS) throw new HttpErr(413, 'too many images');
    const r = await rest('POST', 'assets', { body: { design_id: id, hash, mime, data: buf.toString('base64'), bytes: buf.length } });
    if (r.status === 409 && code(r) === '23503') throw new HttpErr(404, 'not found');
    if (r.status !== 409) need(r, 201, 200, 204);   // 409 duplicate = a parallel identical upload: fine (idempotent)
    return { ok: true };
  }
  async function getAsset(req, res, id, hash) {
    const r = need(await rest('GET', `assets?design_id=eq.${id}&hash=eq.${hash}&select=mime,data`), 200);
    const row = Array.isArray(r.json) && r.json[0];
    if (!row || !MAGIC[row.mime]) throw new HttpErr(404, 'not found');
    const buf = Buffer.from(String(row.data), 'base64');
    res.writeHead(200, baseHeaders(req, { 'Content-Type': row.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${hash}"` }));
    res.end(buf);
  }

  /* ---------------- router ---------------- */
  async function route(req, res, url) {
    const m = req.method, parts = url.pathname.split('/').filter(Boolean);   // ['api', 'designs', id, sub, hash]
    const methodOnly = (...allowed) => { if (!allowed.includes(m)) throw new HttpErr(405, 'method not allowed', { allow: allowed.join(', ') }); };
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(m) && !sameOriginPost(req)) throw new HttpErr(403, 'forbidden');

    if (parts[1] === 'shared') {
      if (parts.length !== 3 || parts[2] !== 'status') throw new HttpErr(404, 'not found');
      methodOnly('GET');
      if (!enabled) return json(req, res, 200, { enabled: false });
      return json(req, res, 200, await status(url.searchParams.get('fresh') === '1'));
    }
    if (!enabled) throw new HttpErr(404, 'not found');
    if (parts.length === 2) {
      methodOnly('GET', 'POST');
      if (m === 'GET') return json(req, res, 200, await listDesigns());
      return json(req, res, 200, await createDesign(await readJson(req)));
    }
    const id = parts[2];
    if (!ID_RE.test(id)) throw new HttpErr(400, 'invalid id');
    if (parts.length === 3) {
      methodOnly('GET', 'PUT', 'DELETE');
      if (m === 'GET') return json(req, res, 200, await getDesign(id));
      if (m === 'PUT') return json(req, res, 200, await updateDesign(id, await readJson(req)));
      return json(req, res, 200, await deleteDesign(id));
    }
    const sub = parts[3];
    if (parts.length === 4 && sub === 'rev') { methodOnly('GET'); return json(req, res, 200, await getRev(id)); }
    if (parts.length === 4 && sub === 'duplicate') { methodOnly('POST'); return json(req, res, 200, await duplicateDesign(id, await readJson(req))); }
    if (parts.length === 4 && sub === 'missing') { methodOnly('POST'); return json(req, res, 200, await missing(id, await readJson(req))); }
    if (parts.length === 5 && sub === 'assets') {
      const hash = parts[4];
      if (!HASH_RE.test(hash)) throw new HttpErr(400, 'invalid hash');
      methodOnly('GET', 'PUT');
      if (m === 'GET') return getAsset(req, res, id, hash);
      return json(req, res, 200, await putAsset(req, id, hash));
    }
    throw new HttpErr(404, 'not found');
  }

  async function handle(req, res, url) {
    try { await route(req, res, url); }
    catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpErr) return json(req, res, e.status, { error: e.message, ...(e.extra && e.extra.currentRev !== undefined ? { currentRev: e.extra.currentRev } : {}) }, e.extra && e.extra.allow ? { Allow: e.extra.allow } : {});
      if (e instanceof Upstream) return json(req, res, e.kind === 'http' && e.status < 500 ? 502 : 503, { error: GENERIC });
      return json(req, res, 500, { error: 'something went wrong' });   // never echo internals
    }
  }
  return { enabled, handle };
}
