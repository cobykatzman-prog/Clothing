// Shared Brand Kit / workspace storage: server side (used by shared.mjs). Zero dependencies.
// Brand assets (images), colour palettes, typography sets, materials and collections live in Supabase next to the designs,
// so everyone in the workspace sees the same kit. Images are stored as blobs by sha-256, never inside item JSON.
// See SHARED-API.md ("Workspace / Brand Kit").
import crypto from 'node:crypto';

export const KINDS = ['asset', 'palette', 'typography', 'material', 'collection'];
const ITEM_RE = /^[A-Za-z0-9_-]{6,64}$/, HASH_RE = /^[0-9a-f]{64}$/;
const MAX_ITEM = 200 * 1024, MAX_ITEMS = 2000, MAX_BLOB = 8 * 1024 * 1024, MAX_BLOBS = 500, MAX_NAME = 120;
const MAGIC = {
  'image/png': b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'
};
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** ctx: { rest, need, HttpErr, readJson, readBody, json, baseHeaders, noInlineImages } */
export function createWorkspace(ctx) {
  const { rest, need, HttpErr, readJson, readBody, json, baseHeaders } = ctx;
  const out = r => ({ kind: r.kind, id: r.id, name: r.name, rev: r.rev, data: r.data, ref: r.ref || null, updatedBy: r.updated_by || null, createdAt: r.created_at, updatedAt: r.updated_at });
  const canWrite = who => who.role === 'owner' || who.role === 'editor';
  const mustWrite = who => { if (!canWrite(who)) throw new HttpErr(403, 'read-only: your role is viewer'); };

  function checkItem(kind, b) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > MAX_NAME) throw new HttpErr(name ? 413 : 400, 'invalid name');
    if (!isObj(b.data)) throw new HttpErr(400, 'invalid data');
    if (Buffer.byteLength(JSON.stringify(b.data)) > MAX_ITEM) throw new HttpErr(413, 'item too large');
    ctx.noInlineImages(b.data);
    let ref = null;
    if (kind === 'asset') {
      if (typeof b.data.hash !== 'string' || !HASH_RE.test(b.data.hash)) throw new HttpErr(400, 'asset items need data.hash (sha-256 of the uploaded image)');
      ref = b.data.hash;
    }
    return { name, data: b.data, ref };
  }

  async function list(kind) {
    const q = kind ? `&kind=eq.${kind}` : '';
    const r = need(await rest('GET', `workspace_items?select=*&order=updated_at.desc&limit=${MAX_ITEMS}${q}`), 200, 206);
    return { items: (Array.isArray(r.json) ? r.json : []).map(out) };
  }
  async function dropBlobIfUnused(hash) {
    if (!hash) return;
    try {
      const u = await rest('GET', `workspace_items?ref=eq.${hash}&select=id&limit=1`);
      if (u.status === 200 && Array.isArray(u.json) && !u.json.length) await rest('DELETE', `workspace_blobs?hash=eq.${hash}`);
    } catch (_) { /* best effort */ }
  }
  async function put(kind, id, b, who) {
    mustWrite(who);
    const baseRev = b.baseRev;
    if (!Number.isInteger(baseRev) || baseRev < 0 || baseRev > 2147483646) throw new HttpErr(400, 'invalid baseRev');
    const { name, data, ref } = checkItem(kind, b);
    const now = new Date().toISOString();
    if (baseRev === 0) {
      const count = await rest('GET', 'workspace_items?select=id&limit=1', { prefer: 'count=exact' });
      const total = Number((count.range.split('/')[1] || '').trim());
      if (Number.isFinite(total) && total >= MAX_ITEMS) throw new HttpErr(413, 'too many items');
      const r = await rest('POST', 'workspace_items?select=rev', { body: { kind, id, name, data, ref, rev: 1, updated_by: who.name, created_at: now, updated_at: now }, prefer: 'return=representation' });
      if (r.status === 409) throw new HttpErr(409, 'exists');
      need(r, 201, 200);
      return { rev: 1, updatedAt: now };
    }
    const prev = need(await rest('GET', `workspace_items?kind=eq.${kind}&id=eq.${id}&select=ref`), 200);
    const r = need(await rest('PATCH', `workspace_items?kind=eq.${kind}&id=eq.${id}&rev=eq.${baseRev}&select=rev,updated_at`, { body: { name, data, ref, rev: baseRev + 1, updated_by: who.name, updated_at: now }, prefer: 'return=representation' }), 200);
    if (!Array.isArray(r.json) || !r.json.length) {
      const cur = need(await rest('GET', `workspace_items?kind=eq.${kind}&id=eq.${id}&select=rev`), 200);
      const row = Array.isArray(cur.json) && cur.json[0];
      if (!row) throw new HttpErr(404, 'not found');
      throw new HttpErr(409, 'conflict', { currentRev: row.rev });
    }
    const oldRef = Array.isArray(prev.json) && prev.json[0] && prev.json[0].ref;
    if (oldRef && oldRef !== ref) await dropBlobIfUnused(oldRef);
    return { rev: baseRev + 1, updatedAt: r.json[0].updated_at || now };
  }
  async function del(kind, id, who) {
    mustWrite(who);
    const r = need(await rest('DELETE', `workspace_items?kind=eq.${kind}&id=eq.${id}&select=ref`, { prefer: 'return=representation' }), 200, 204);
    const row = Array.isArray(r.json) && r.json[0];
    if (row && row.ref) await dropBlobIfUnused(row.ref);
    return { ok: true };
  }
  async function blobsMissing(b) {
    const hashes = b.hashes;
    if (!Array.isArray(hashes) || hashes.length > 200 || !hashes.every(h => typeof h === 'string' && HASH_RE.test(h))) throw new HttpErr(400, 'invalid hashes');
    const uniq = [...new Set(hashes)];
    if (!uniq.length) return { missing: [] };
    const r = need(await rest('GET', `workspace_blobs?hash=in.(${uniq.join(',')})&select=hash`), 200, 206);
    const have = new Set((Array.isArray(r.json) ? r.json : []).map(x => x.hash));
    return { missing: uniq.filter(h => !have.has(h)) };
  }
  async function putBlob(req, hash, who) {
    mustWrite(who);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!MAGIC[mime]) { await readBody(req, 0).catch(() => {}); throw new HttpErr(415, 'unsupported type'); }
    const buf = await readBody(req, MAX_BLOB);
    if (!buf.length || !MAGIC[mime](buf)) throw new HttpErr(400, 'not a valid image');
    if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) throw new HttpErr(400, 'hash mismatch');
    const have = need(await rest('GET', `workspace_blobs?select=hash&limit=${MAX_BLOBS + 1}`), 200, 206);
    const hs = Array.isArray(have.json) ? have.json.map(x => x.hash) : [];
    if (hs.includes(hash)) return { ok: true };
    if (hs.length >= MAX_BLOBS) throw new HttpErr(413, 'too many images');
    const r = await rest('POST', 'workspace_blobs', { body: { hash, mime, data: buf.toString('base64'), bytes: buf.length } });
    if (r.status !== 409) need(r, 201, 200, 204);   // 409 = identical parallel upload
    return { ok: true };
  }
  async function getBlob(req, res, hash) {
    const r = need(await rest('GET', `workspace_blobs?hash=eq.${hash}&select=mime,data`), 200);
    const row = Array.isArray(r.json) && r.json[0];
    if (!row || !MAGIC[row.mime]) throw new HttpErr(404, 'not found');
    const buf = Buffer.from(String(row.data), 'base64');
    res.writeHead(200, baseHeaders(req, { 'Content-Type': row.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${hash}"` }));
    res.end(buf);
  }

  /** parts: ['api','workspace', ...] */
  async function route(req, res, url, parts, who, methodOnly) {
    const m = req.method;
    if (parts.length === 2) {
      methodOnly('GET');
      const k = url.searchParams.get('kind');
      if (k && !KINDS.includes(k)) throw new HttpErr(400, 'invalid kind');
      return json(req, res, 200, await list(k));
    }
    if (parts[2] === 'blobs') {
      if (parts.length === 4 && parts[3] === 'missing') { methodOnly('POST'); return json(req, res, 200, await blobsMissing(await readJson(req))); }
      if (parts.length === 4 && HASH_RE.test(parts[3])) {
        methodOnly('GET', 'PUT');
        return m === 'GET' ? getBlob(req, res, parts[3]) : json(req, res, 200, await putBlob(req, parts[3], who));
      }
      throw new HttpErr(404, 'not found');
    }
    if (parts.length === 4 && KINDS.includes(parts[2])) {
      if (!ITEM_RE.test(parts[3])) throw new HttpErr(400, 'invalid id');
      methodOnly('PUT', 'DELETE');
      return json(req, res, 200, m === 'PUT' ? await put(parts[2], parts[3], await readJson(req), who) : await del(parts[2], parts[3], who));
    }
    throw new HttpErr(404, 'not found');
  }
  return { route };
}
