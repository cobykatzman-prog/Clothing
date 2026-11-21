// A small in-memory imitation of the PostgREST subset that shared.mjs uses (tables: designs, assets).
// Used only by tests: it is NOT Supabase, just enough of its HTTP behaviour to exercise our server.
import http from 'node:http';

const SCHEMA = {
  designs: { pk: ['id'], required: ['id', 'name', 'doc'], defaults: () => ({ rev: 1, meta: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) },
  assets: { pk: ['design_id', 'hash'], required: ['design_id', 'hash', 'mime', 'data', 'bytes'], defaults: () => ({ created_at: new Date().toISOString() }) },
  design_revs: { pk: ['design_id', 'rev'], required: ['design_id', 'rev', 'name', 'doc'], fk: 'designs', defaults: () => ({ meta: {}, assets: [], saved_at: new Date().toISOString() }) },
  workspace_items: { pk: ['kind', 'id'], required: ['kind', 'id', 'name'], defaults: () => ({ rev: 1, data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) },
  workspace_blobs: { pk: ['hash'], required: ['hash', 'mime', 'data', 'bytes'], defaults: () => ({ created_at: new Date().toISOString() }) }
};
// designs also has owner, updated_by (text) and acl (jsonb, default {}) in the real schema
SCHEMA.designs.defaults = () => ({ rev: 1, meta: {}, acl: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

export async function startMock({ key = 'service-key-for-tests' } = {}) {
  const tables = { designs: [], assets: [], design_revs: [], workspace_items: [], workspace_blobs: [] };
  const state = { key, failure: null, requests: [], delayMs: 0 };   // failure: null | 'missingTables' | 'paused' | 'down'

  const send = (res, status, body, headers = {}) => {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers });
    res.end(text);
  };
  const pgErr = (res, status, code, message) => send(res, status, { code, message, details: null, hint: null });

  const splitList = s => s.replace(/^\(|\)$/g, '').split(',').filter(x => x !== '');
  function matcher(params) {
    const conds = [];
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      let m;
      if ((m = /^eq\.(.*)$/.exec(v))) conds.push(r => String(r[k]) === m[1]);
      else if ((m = /^(lt|lte|gt|gte)\.(.*)$/.exec(v))) { const n = Number(m[2]), op = m[1]; conds.push(r => (op === 'lt' ? Number(r[k]) < n : op === 'lte' ? Number(r[k]) <= n : op === 'gt' ? Number(r[k]) > n : Number(r[k]) >= n)); }
      else if ((m = /^not\.in\.(\(.*\))$/.exec(v))) { const l = splitList(m[1]); conds.push(r => !l.includes(String(r[k]))); }
      else if ((m = /^in\.(\(.*\))$/.exec(v))) { const l = splitList(m[1]); conds.push(r => l.includes(String(r[k]))); }
      else throw Object.assign(new Error('unsupported filter ' + k), { code: 'PGRST100' });
    }
    return r => conds.every(c => c(r));
  }
  const project = (row, sel) => {
    if (!sel || sel === '*') return { ...row };
    const out = {}; for (const c of sel.split(',')) out[c.trim()] = row[c.trim()]; return out;
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
      const url = new URL(req.url, 'http://x');
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, apikey: req.headers.apikey, auth: req.headers.authorization });
      if (state.failure === 'down') return req.socket.destroy();
      if (state.failure === 'paused') return send(res, 503, '<html>project paused</html>');
      if (req.headers.apikey !== state.key || req.headers.authorization !== `Bearer ${state.key}`) return pgErr(res, 401, 'PGRST301', 'Invalid API key');
      const m = /^\/rest\/v1\/(\w+)$/.exec(url.pathname);
      if (!m) return pgErr(res, 404, 'PGRST125', 'Invalid path');
      const name = m[1], spec = SCHEMA[name];
      if (!spec || state.failure === 'missingTables') return pgErr(res, 404, 'PGRST205', `Could not find the table 'public.${name}' in the schema cache`);
      const rows = tables[name], prefer = String(req.headers.prefer || '');
      const wantRep = /return=representation/.test(prefer), sel = url.searchParams.get('select');
      let body; const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) { try { body = JSON.parse(raw); } catch (_) { return pgErr(res, 400, 'PGRST102', 'Invalid JSON'); } }
      let match; try { match = matcher(url.searchParams); } catch (e) { return pgErr(res, 400, e.code, e.message); }

      if (req.method === 'GET') {
        let out = rows.filter(match);
        const ord = url.searchParams.get('order');
        if (ord) { const [col, dir] = ord.split('.'); out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1)); }
        const total = out.length;
        const lim = url.searchParams.get('limit'); if (lim) out = out.slice(0, Number(lim));
        const hdr = /count=exact/.test(prefer) ? { 'Content-Range': `${out.length ? `0-${out.length - 1}` : '*'}/${total}` } : {};
        return send(res, 200, out.map(r => project(r, sel)), hdr);
      }
      if (req.method === 'POST') {
        const items = Array.isArray(body) ? body : [body];
        const added = [];
        for (const it of items) {
          if (!it || typeof it !== 'object') return pgErr(res, 400, 'PGRST102', 'Invalid body');
          for (const c of spec.required) if (it[c] === undefined || it[c] === null) return pgErr(res, 400, '23502', `null value in column "${c}"`);
          const row = { ...spec.defaults(), ...it };
          if (rows.some(r => spec.pk.every(c => r[c] === row[c]))) {
            if (/resolution=ignore-duplicates/.test(prefer)) continue;
            return pgErr(res, 409, '23505', 'duplicate key value violates unique constraint');
          }
          if ((name === 'assets' || name === 'design_revs') && !tables.designs.some(d => d.id === row.design_id)) return pgErr(res, 409, '23503', 'violates foreign key constraint');
          added.push(row);
        }
        rows.push(...added);
        return wantRep ? send(res, 201, added.map(r => project(r, sel))) : send(res, 201);
      }
      if (req.method === 'PATCH') {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, body);
        return wantRep ? send(res, 200, hit.map(r => project(r, sel))) : send(res, 204);
      }
      if (req.method === 'DELETE') {
        const hit = rows.filter(match);
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        if (name === 'designs') for (const r of hit) { tables.assets = tables.assets.filter(a => a.design_id !== r.id); tables.design_revs = tables.design_revs.filter(a => a.design_id !== r.id); }   // on delete cascade
        return wantRep ? send(res, 200, hit.map(r => project(r, sel))) : send(res, 204);
      }
      return pgErr(res, 405, 'PGRST000', 'method');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, key, state,
    get tables() { return tables; },
    assetsOf: id => tables.assets.filter(a => a.design_id === id),
    setFailure: f => { state.failure = f; },
    setKey: k => { state.key = k; },
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); })
  };
}
