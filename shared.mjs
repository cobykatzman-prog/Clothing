// Shared design library: server side. Zero dependencies (Node built-ins + global fetch).
// Stores designs and their images in a Supabase Postgres project through PostgREST. The Supabase key lives only
// in this process: it is never logged and never sent to the browser. See SHARED-API.md for the contract.
//
//   SUPABASE_URL          e.g. https://abcdxyz.supabase.co
//   SUPABASE_SERVICE_KEY  the project's service_role key (server only)
import crypto from 'node:crypto';
import { createWorkspace } from './workspace.mjs';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_ASSET = 8 * 1024 * 1024, MAX_DOC = 1.5 * 1024 * 1024, MAX_META = 80 * 1024, MAX_NAME = 120, MAX_ASSETS = 200;
const MAX_JSON_BODY = MAX_DOC + MAX_META + 16 * 1024;
const UPSTREAM_TIMEOUT = 15000, STATUS_TTL = 30000;
const GENERIC = 'shared library unavailable';
const RANK = { viewer: 1, editor: 2, owner: 3 };
const INLINE_LIMIT = 16 * 1024, THUMB_LIMIT = 64 * 1024;   // inline data: URLs bigger than this belong in asset storage

const MAGIC = {
  'image/png': b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'
};

export class Upstream extends Error { constructor(kind, status) { super(kind); this.kind = kind; this.status = status; } }
export class HttpErr extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; this.extra = extra; } }

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteLen = v => Buffer.byteLength(JSON.stringify(v));

export const OWNS = /^\/api\/(shared|designs|workspace)(\/|$)/;

export function createShared({ env = process.env, baseHeaders, sameOriginPost }) {
  const rawUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const KEY = String(env.SUPABASE_SERVICE_KEY || '').trim();
  const enabled = !!(rawUrl && KEY);
  const REV_KEEP = Math.max(2, Math.min(100, Number(env.WORKSPACE_REV_KEEP) || 20));                 // versions kept per design
  const REV_INTERVAL = (Number.isFinite(Number(env.WORKSPACE_REV_INTERVAL_SEC)) && env.WORKSPACE_REV_INTERVAL_SEC !== undefined && env.WORKSPACE_REV_INTERVAL_SEC !== '' ? Math.max(0, Number(env.WORKSPACE_REV_INTERVAL_SEC)) : 300) * 1000;   // autosaves closer together than this share one version

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
          else {
            for (const t of ['design_revs', 'workspace_items', 'workspace_blobs']) {
              const c = await rest('GET', `${t}?select=*&limit=1`);
              if (c.status !== 200 && c.status !== 206) { v = { enabled: true, ok: false, error: c.status === 404 ? 'The database is missing the newer shared-workspace tables (versions, brand kit). Run the latest supabase/schema.sql again in the Supabase SQL editor; it is safe to repeat.' : reason(c) }; break; }
            }
            if (!v) { const n = Number((a.range.split('/')[1] || '').trim()); v = { enabled: true, ok: true, designs: Number.isFinite(n) ? n : (Array.isArray(a.json) ? a.json.length : 0) }; }
          }
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
  function checkMeta(m) { if (!isObj(m)) throw new HttpErr(400, 'invalid meta'); if (byteLen(m) > MAX_META) throw new HttpErr(413, 'meta too large'); noInlineImages(m); return m; }
  function checkDoc(d) { if (!isObj(d)) throw new HttpErr(400, 'invalid doc'); if (byteLen(d) > MAX_DOC) throw new HttpErr(413, 'doc too large'); noInlineImages(d); return d; }
  function checkHashes(a, max = MAX_ASSETS) {
    if (!Array.isArray(a) || a.length > max || !a.every(h => typeof h === 'string' && HASH_RE.test(h))) throw new HttpErr(400, 'invalid hashes');
    return [...new Set(a)];
  }
  // Large images must be uploaded as assets: reject inline base64 pictures in design/meta/kit JSON (small thumbnails are fine).
  function noInlineImages(v, key = '') {
    if (typeof v === 'string') {
      if (v.startsWith('data:') && v.length > (key === 'thumb' ? THUMB_LIMIT : INLINE_LIMIT)) throw new HttpErr(413, 'inline image too large: upload it as an asset');
    } else if (Array.isArray(v)) { for (const x of v) noInlineImages(x, key); }
    else if (isObj(v)) { for (const k of Object.keys(v)) noInlineImages(v[k], k); }
  }
  const roleName = x => (x === 'owner' || x === 'editor' || x === 'viewer' ? x : null);
  const aclOf = r => (isObj(r.acl) ? r.acl : {});
  /** the caller's effective role on a design row: workspace owners and the design's owner own it; else a per-design entry beats the workspace role */
  function roleOn(row, who) {
    if (who.role === 'owner' || (row.owner && row.owner === who.name)) return 'owner';
    return roleName(aclOf(row)[who.name]) || who.role;
  }
  const rowOut = (r, who) => ({ id: r.id, name: r.name, rev: r.rev, meta: r.meta, createdAt: r.created_at, updatedAt: r.updated_at, owner: r.owner || null, updatedBy: r.updated_by || null, members: aclOf(r), ...(who ? { role: roleOn(r, who) } : {}) });
  const atLeast = (have, want) => RANK[have] >= RANK[want];
  const q = s => encodeURIComponent(s);

  /* ---------------- handlers ---------------- */
  const LIST_COLS = 'id,name,rev,meta,created_at,updated_at,owner,updated_by,acl';
  async function listDesigns(who) {
    const r = need(await rest('GET', `designs?select=${LIST_COLS}&order=updated_at.desc&limit=1000`), 200, 206);
    return { designs: (Array.isArray(r.json) ? r.json : []).map(x => rowOut(x, who)) };
  }
  async function fetchRow(id, select = '*') {
    const r = need(await rest('GET', `designs?id=eq.${id}&select=${select}`), 200);
    const row = Array.isArray(r.json) && r.json[0];
    if (!row) throw new HttpErr(404, 'not found');
    return row;
  }
  /** loads the row and checks the caller may do `want` on it (viewer = read, editor = write, owner = delete / share) */
  async function authorize(id, who, want) {
    const row = await fetchRow(id, 'id,owner,acl');
    if (!atLeast(roleOn(row, who), want)) throw new HttpErr(403, want === 'owner' ? 'only the owner can do that' : 'read-only: you can view this design but not change it');
    return row;
  }
  async function getDesign(id, who) {
    const row = await fetchRow(id);
    const a = need(await rest('GET', `assets?design_id=eq.${id}&select=hash`), 200, 206);
    return { ...rowOut(row, who), doc: row.doc, assets: (Array.isArray(a.json) ? a.json : []).map(x => x.hash) };
  }
  async function getRev(id) {
    const row = await fetchRow(id, 'rev,updated_at,updated_by');
    return { id, rev: row.rev, updatedAt: row.updated_at, updatedBy: row.updated_by || null };
  }

  /* ---- version history: a snapshot per save (autosaves within WORKSPACE_REV_INTERVAL_SEC by the same person share one) ---- */
  async function snapshot(id, rev, { name, meta, doc, assets, who, note = null, force = false, at }) {
    try {
      const row = { design_id: id, rev, name, meta, doc, assets, edited_by: who.name, saved_at: at, note };
      if (!force && REV_INTERVAL > 0) {
        const last = await rest('GET', `design_revs?design_id=eq.${id}&select=rev,edited_by,saved_at,note&order=rev.desc&limit=1`);
        const l = last.status === 200 && Array.isArray(last.json) && last.json[0];
        if (l && l.edited_by === who.name && !l.note && Date.now() - Date.parse(l.saved_at) < REV_INTERVAL) {
          const u = await rest('PATCH', `design_revs?design_id=eq.${id}&rev=eq.${l.rev}`, { body: row });   // same editing session: replace its latest snapshot
          if (u.status === 200 || u.status === 204) return;
        }
      }
      const ins = await rest('POST', 'design_revs', { body: row });
      if (ins.status !== 201 && ins.status !== 200 && ins.status !== 204 && ins.status !== 409) return;
      if (rev > REV_KEEP) await rest('DELETE', `design_revs?design_id=eq.${id}&rev=lte.${rev - REV_KEEP}`);   // prune old ones
    } catch (_) { /* history is best effort: the save itself already succeeded */ }
  }
  /** hashes any retained version still needs, so restoring one never finds its images deleted */
  async function revAssets(id) {
    const r = await rest('GET', `design_revs?design_id=eq.${id}&select=assets`);
    if (r.status !== 200 || !Array.isArray(r.json)) return null;
    const s = new Set();
    for (const x of r.json) if (Array.isArray(x.assets)) for (const h of x.assets) if (typeof h === 'string' && HASH_RE.test(h)) s.add(h);
    return s;
  }
  async function gc(id, keep) {
    try {
      const extra = await revAssets(id);
      if (!extra) return;   // cannot tell what history needs: keep everything
      const all = [...new Set([...keep, ...extra])];
      await rest('DELETE', all.length ? `assets?design_id=eq.${id}&hash=not.in.(${all.join(',')})` : `assets?design_id=eq.${id}`);
    } catch (_) { /* ignore */ }
  }

  async function createDesign(b, who) {
    if (!atLeast(who.role, 'editor')) throw new HttpErr(403, 'read-only: your role is viewer');
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) throw new HttpErr(400, 'invalid id');
    const now = new Date().toISOString();
    const row = { id: b.id, name: checkName(b.name), meta: checkMeta(b.meta === undefined ? {} : b.meta), doc: checkDoc(b.doc), rev: 1, owner: who.name, updated_by: who.name, acl: {}, created_at: now, updated_at: now };
    const r = await rest('POST', 'designs?select=rev', { body: row, prefer: 'return=representation' });
    if (r.status === 409) throw new HttpErr(409, 'exists', { currentRev: undefined });
    need(r, 201, 200);
    await snapshot(b.id, 1, { name: row.name, meta: row.meta, doc: row.doc, assets: [], who, at: now, force: true });
    return { rev: 1, updatedAt: now, updatedBy: who.name };
  }
  async function writeRevision(id, baseRev, { name, meta, doc, keep, who, note, force }) {
    const updatedAt = new Date().toISOString();
    const r = need(await rest('PATCH', `designs?id=eq.${id}&rev=eq.${baseRev}&select=rev,updated_at`, { body: { name, meta, doc, rev: baseRev + 1, updated_at: updatedAt, updated_by: who.name }, prefer: 'return=representation' }), 200);
    if (!Array.isArray(r.json) || !r.json.length) {
      const cur = need(await rest('GET', `designs?id=eq.${id}&select=rev,updated_by`), 200);
      const row = Array.isArray(cur.json) && cur.json[0];
      if (!row) throw new HttpErr(404, 'not found');
      throw new HttpErr(409, 'conflict', { currentRev: row.rev, by: row.updated_by || null });
    }
    const at = r.json[0].updated_at || updatedAt;
    await snapshot(id, baseRev + 1, { name, meta, doc, assets: keep || [], who, note, force, at });
    if (keep) await gc(id, keep);   // garbage-collect images neither the design nor any kept version uses (best effort)
    return { rev: baseRev + 1, updatedAt: at, updatedBy: who.name };
  }
  async function updateDesign(id, b, who) {
    await authorize(id, who, 'editor');
    const baseRev = b.baseRev;
    if (!Number.isInteger(baseRev) || baseRev < 1 || baseRev > 2147483646) throw new HttpErr(400, 'invalid baseRev');
    const name = checkName(b.name), meta = checkMeta(b.meta === undefined ? {} : b.meta), doc = checkDoc(b.doc);
    const keep = b.keepAssets === undefined ? null : checkHashes(b.keepAssets);
    return writeRevision(id, baseRev, { name, meta, doc, keep, who });
  }
  async function deleteDesign(id, who) {
    await authorize(id, who, 'owner');
    need(await rest('DELETE', `designs?id=eq.${id}`), 200, 204);
    return { ok: true };
  }
  async function duplicateDesign(id, b, who) {
    if (!atLeast(who.role, 'editor')) throw new HttpErr(403, 'read-only: your role is viewer');
    const newId = b.newId === undefined ? crypto.randomBytes(12).toString('base64url') : b.newId;
    if (typeof newId !== 'string' || !ID_RE.test(newId)) throw new HttpErr(400, 'invalid newId');
    const row = await fetchRow(id, 'name,meta,doc,owner,acl');
    if (RANK[roleOn(row, who)] < RANK.viewer) throw new HttpErr(403, 'forbidden');
    const name = b.name === undefined ? `${row.name} copy`.slice(0, MAX_NAME) : checkName(b.name);
    const now = new Date().toISOString();
    const ins = await rest('POST', 'designs?select=rev', { body: { id: newId, name, meta: row.meta, doc: row.doc, rev: 1, owner: who.name, updated_by: who.name, acl: {}, created_at: now, updated_at: now }, prefer: 'return=representation' });
    if (ins.status === 409) throw new HttpErr(409, 'exists');
    need(ins, 201, 200);
    const hashes = [];
    try {
      const list = need(await rest('GET', `assets?design_id=eq.${id}&select=hash`), 200, 206);
      for (const { hash } of Array.isArray(list.json) ? list.json : []) {
        const a = need(await rest('GET', `assets?design_id=eq.${id}&hash=eq.${hash}&select=hash,mime,data,bytes`), 200);
        const x = Array.isArray(a.json) && a.json[0]; if (!x) continue;
        const c = await rest('POST', 'assets', { body: { design_id: newId, hash: x.hash, mime: x.mime, data: x.data, bytes: x.bytes } });
        if (c.status !== 409) need(c, 201, 200, 204);
        hashes.push(x.hash);
      }
    } catch (e) { try { await rest('DELETE', `designs?id=eq.${newId}`); } catch (_) { /* ignore */ } throw e; }
    await snapshot(newId, 1, { name, meta: row.meta, doc: row.doc, assets: hashes, who, at: now, force: true });
    return { id: newId, rev: 1, name };
  }
  async function missing(id, b, who) {
    await authorize(id, who, 'editor');
    const hashes = checkHashes(b.hashes);
    if (!hashes.length) return { missing: [] };
    const r = need(await rest('GET', `assets?design_id=eq.${id}&hash=in.(${hashes.join(',')})&select=hash`), 200, 206);
    const have = new Set((Array.isArray(r.json) ? r.json : []).map(x => x.hash));
    return { missing: hashes.filter(h => !have.has(h)) };
  }
  async function putAsset(req, id, hash, who) {
    try { await authorize(id, who, 'editor'); } catch (e) { await readBody(req, 0).catch(() => {}); throw e; }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!MAGIC[mime]) { await readBody(req, 0).catch(() => {}); throw new HttpErr(415, 'unsupported type'); }
    const buf = await readBody(req, MAX_ASSET);
    if (!buf.length || !MAGIC[mime](buf)) throw new HttpErr(400, 'not a valid image');
    if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) throw new HttpErr(400, 'hash mismatch');
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

  /* ---- history + restore + sharing ---- */
  async function history(id) {
    await fetchRow(id, 'id');
    const r = need(await rest('GET', `design_revs?design_id=eq.${id}&select=rev,name,edited_by,saved_at,note&order=rev.desc&limit=${REV_KEEP}`), 200, 206);
    return { revs: (Array.isArray(r.json) ? r.json : []).map(x => ({ rev: x.rev, name: x.name, editedBy: x.edited_by || null, savedAt: x.saved_at, note: x.note || null })) };
  }
  async function historyEntry(id, rev) {
    const r = need(await rest('GET', `design_revs?design_id=eq.${id}&rev=eq.${rev}&select=*`), 200);
    const x = Array.isArray(r.json) && r.json[0];
    if (!x) throw new HttpErr(404, 'not found');
    return { rev: x.rev, name: x.name, meta: x.meta, doc: x.doc, assets: Array.isArray(x.assets) ? x.assets : [], editedBy: x.edited_by || null, savedAt: x.saved_at, note: x.note || null };
  }
  async function restore(id, b, who) {
    await authorize(id, who, 'editor');
    if (!Number.isInteger(b.rev) || b.rev < 1) throw new HttpErr(400, 'invalid rev');
    if (!Number.isInteger(b.baseRev) || b.baseRev < 1) throw new HttpErr(400, 'invalid baseRev');
    const old = await historyEntry(id, b.rev);
    // every image that version used must still be stored (the server keeps them while the version is kept)
    const have = need(await rest('GET', `assets?design_id=eq.${id}&select=hash&limit=${MAX_ASSETS + 1}`), 200, 206);
    const hs = new Set((Array.isArray(have.json) ? have.json : []).map(x => x.hash));
    const lost = old.assets.filter(h => !hs.has(h));
    if (lost.length) throw new HttpErr(422, 'images of that version are no longer stored');
    const out = await writeRevision(id, b.baseRev, { name: old.name, meta: old.meta, doc: old.doc, keep: old.assets, who, note: `restored from version ${b.rev}`, force: true });
    return { ...out, restoredFrom: b.rev };
  }
  async function getAcl(id, who) {
    const row = await fetchRow(id, 'owner,acl');
    return { owner: row.owner || null, members: aclOf(row), role: roleOn(row, who) };
  }
  async function putAcl(id, b, who) {
    await authorize(id, who, 'owner');
    if (!isObj(b.members)) throw new HttpErr(400, 'invalid members');
    const members = {};
    for (const [n, r] of Object.entries(b.members)) {
      if (!/^[a-z0-9._-]{1,32}$/.test(n) || !roleName(r)) throw new HttpErr(400, 'members look like {"name":"owner|editor|viewer"}');
      members[n] = r;
    }
    if (Object.keys(members).length > 50) throw new HttpErr(413, 'too many members');
    need(await rest('PATCH', `designs?id=eq.${id}`, { body: { acl: members } }), 200, 204);
    return { members };
  }

  /* ---------------- router ---------------- */
  async function route(req, res, url, who) {
    const m = req.method, parts = url.pathname.split('/').filter(Boolean);   // ['api', 'designs', id, sub, hash]
    const methodOnly = (...allowed) => { if (!allowed.includes(m)) throw new HttpErr(405, 'method not allowed', { allow: allowed.join(', ') }); };
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(m) && !sameOriginPost(req)) throw new HttpErr(403, 'forbidden');

    if (parts[1] === 'shared') {
      if (parts.length === 3 && parts[2] === 'me') { methodOnly('GET'); return json(req, res, 200, { user: who.name, role: who.role, shared: !!who.shared, multiUser: !!who.multi }); }
      if (parts.length !== 3 || parts[2] !== 'status') throw new HttpErr(404, 'not found');
      methodOnly('GET');
      if (!enabled) return json(req, res, 200, { enabled: false });
      return json(req, res, 200, await status(url.searchParams.get('fresh') === '1'));
    }
    if (!enabled) throw new HttpErr(404, 'not found');
    if (parts[1] === 'workspace') return workspace.route(req, res, url, parts, who, methodOnly);
    if (parts.length === 2) {
      methodOnly('GET', 'POST');
      if (m === 'GET') return json(req, res, 200, await listDesigns(who));
      return json(req, res, 200, await createDesign(await readJson(req), who));
    }
    const id = parts[2];
    if (!ID_RE.test(id)) throw new HttpErr(400, 'invalid id');
    if (parts.length === 3) {
      methodOnly('GET', 'PUT', 'DELETE');
      if (m === 'GET') return json(req, res, 200, await getDesign(id, who));
      if (m === 'PUT') return json(req, res, 200, await updateDesign(id, await readJson(req), who));
      return json(req, res, 200, await deleteDesign(id, who));
    }
    const sub = parts[3];
    if (parts.length === 4 && sub === 'rev') { methodOnly('GET'); return json(req, res, 200, await getRev(id)); }
    if (parts.length === 4 && sub === 'duplicate') { methodOnly('POST'); return json(req, res, 200, await duplicateDesign(id, await readJson(req), who)); }
    if (parts.length === 4 && sub === 'missing') { methodOnly('POST'); return json(req, res, 200, await missing(id, await readJson(req), who)); }
    if (parts.length === 4 && sub === 'history') { methodOnly('GET'); return json(req, res, 200, await history(id)); }
    if (parts.length === 5 && sub === 'history') {
      methodOnly('GET');
      if (!/^[1-9]\d{0,9}$/.test(parts[4])) throw new HttpErr(400, 'invalid rev');
      return json(req, res, 200, await historyEntry(id, Number(parts[4])));
    }
    if (parts.length === 4 && sub === 'restore') { methodOnly('POST'); return json(req, res, 200, await restore(id, await readJson(req), who)); }
    if (parts.length === 4 && sub === 'acl') {
      methodOnly('GET', 'PUT');
      return json(req, res, 200, m === 'GET' ? await getAcl(id, who) : await putAcl(id, await readJson(req), who));
    }
    if (parts.length === 5 && sub === 'assets') {
      const hash = parts[4];
      if (!HASH_RE.test(hash)) throw new HttpErr(400, 'invalid hash');
      methodOnly('GET', 'PUT');
      if (m === 'GET') return getAsset(req, res, id, hash);
      return json(req, res, 200, await putAsset(req, id, hash, who));
    }
    throw new HttpErr(404, 'not found');
  }

  const workspace = createWorkspace({ rest, need, HttpErr, readJson, readBody, json, baseHeaders, noInlineImages });

  async function handle(req, res, url, identity) {
    const who = identity || { name: 'local', role: 'owner', shared: true };
    try { await route(req, res, url, who); }
    catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpErr) return json(req, res, e.status, { error: e.message, ...(e.extra && e.extra.currentRev !== undefined ? { currentRev: e.extra.currentRev } : {}), ...(e.extra && e.extra.by ? { by: e.extra.by } : {}) }, e.extra && e.extra.allow ? { Allow: e.extra.allow } : {});
      if (e instanceof Upstream) { cache = null; return json(req, res, e.kind === 'http' && e.status < 500 ? 502 : 503, { error: GENERIC }); }   // next status check is fresh
      return json(req, res, 500, { error: 'something went wrong' });   // never echo internals
    }
  }
  return { enabled, handle };
}
