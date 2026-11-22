// Threadform web server: serves the static studio behind a password set in the environment.
// Zero dependencies (Node built-ins only). The only outside service it ever calls is your own Supabase project, and only when SUPABASE_URL + SUPABASE_SERVICE_KEY are set.
//
//   SITE_PASSWORD   required in production (min 8 chars, 12+ recommended). Visitors must log in with it.
//   SITE_USERNAME   optional. If set, visitors must also enter this username.
//   SITE_USERS      optional. Individual logins: "alice:her-password,bob:his-password" (comma separated; passwords 8+ chars, no commas).
//                   Can be used with or without SITE_PASSWORD (the shared password then still works when the username is left blank).
//   SITE_ROLES      optional. Workspace roles, "alice:owner,bob:viewer" (owner | editor | viewer). Users not listed are editors; with no
//                   SITE_ROLES at all the first user in SITE_USERS is the owner. SITE_SHARED_ROLE sets the role of the shared password (default owner).
//   SESSION_SECRET  optional. Signs login cookies. If unset, a random one is made at start-up
//                   (everyone is logged out when the server restarts).
//   SESSION_DAYS    optional, how long a login lasts (default 7).
//   NODE_ENV=production  makes the server refuse to start without SITE_PASSWORD.
//   ALLOW_OPEN=1    explicitly allow running with no password (local development only).
//   SUPABASE_URL + SUPABASE_SERVICE_KEY  optional. Both set = shared design library (see shared.mjs, README).
//   OPENAI_API_KEY  optional. Set = AI editing is on (see ai.mjs, README "AI editing"). Also AI_PROVIDER, AI_BASE_URL, AI_IMAGE_MODEL, AI_VISION_MODEL, AI_IMAGE_QUALITY, AI_RATE_LIMIT.
//   PORT            listen port (Render sets this).
//
// Until a visitor is logged in, no studio file is served at all: only the login page and /healthz.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createShared, OWNS as SHARED_ROUTES } from './shared.mjs';
import { createAi, OWNS as AI_ROUTES } from './ai.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'tf_session';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

const PKG_VERSION = (() => { try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''); } catch (_) { return ''; } })();
/** The commit this server runs: Render sets RENDER_GIT_COMMIT at build time. Only a hex sha is ever reported (never free text from the environment). */
export function buildInfo(env = process.env) {
  const raw = String(env.RENDER_GIT_COMMIT || env.GIT_COMMIT || env.VERCEL_GIT_COMMIT_SHA || env.SOURCE_VERSION || '').trim();
  return { version: PKG_VERSION || null, commit: /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : null };
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));   // constant-time, length-independent
const b64u = buf => Buffer.from(buf).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadSecurityHeaders() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return Object.fromEntries(cfg.headers[0].headers.map(h => [h.key, h.value]));   // single source of truth for the CSP etc.
  } catch (_) {
    return { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
  }
}

/** SITE_USERS / SITE_ROLES / SITE_SHARED_ROLE -> { users: Map(name -> password), roles: Map(name -> role), sharedRole } */
export function parseIdentities(env) {
  const ROLE_OK = new Set(['owner', 'editor', 'viewer']);
  const users = new Map(), roles = new Map();
  for (const raw of String(env.SITE_USERS || '').split(',')) {
    const entry = raw.trim(); if (!entry) continue;
    const i = entry.indexOf(':');
    const name = (i < 0 ? '' : entry.slice(0, i)).trim().toLowerCase(), pw = i < 0 ? '' : entry.slice(i + 1);
    if (!/^[a-z0-9._-]{1,32}$/.test(name)) throw new Error('SITE_USERS: each entry must look like name:password, with a name of letters, digits, . _ - (max 32).');
    if (pw.length < 8) throw new Error(`SITE_USERS: the password for "${name}" must be at least 8 characters.`);
    if (users.has(name)) throw new Error(`SITE_USERS: "${name}" is listed twice.`);
    users.set(name, pw);
  }
  const explicit = String(env.SITE_ROLES || '').trim();
  for (const raw of explicit.split(',')) {
    const entry = raw.trim(); if (!entry) continue;
    const [n, r] = entry.split(':').map(x => (x || '').trim().toLowerCase());
    if (!users.has(n) || !ROLE_OK.has(r)) throw new Error('SITE_ROLES: entries look like name:owner|editor|viewer and the name must be in SITE_USERS.');
    roles.set(n, r);
  }
  if (!explicit && users.size) roles.set([...users.keys()][0], 'owner');   // nobody configured: the first user runs the workspace
  const sr = String(env.SITE_SHARED_ROLE || 'owner').trim().toLowerCase();
  if (!ROLE_OK.has(sr)) throw new Error('SITE_SHARED_ROLE must be owner, editor or viewer.');
  return { users, roles, sharedRole: sr };
}

export function createApp(env = process.env) {
  const PASSWORD = env.SITE_PASSWORD || '';
  const USERNAME = env.SITE_USERNAME || '';
  const prod = env.NODE_ENV === 'production';
  const { users: USERS, roles: ROLES, sharedRole: SHARED_ROLE } = parseIdentities(env);
  if (!PASSWORD && !USERS.size) {
    if (prod && env.ALLOW_OPEN !== '1') throw new Error('SITE_PASSWORD is not set (or use SITE_USERS). Set it in the environment (or ALLOW_OPEN=1 to run without a login, development only).');
  } else if (PASSWORD && PASSWORD.length < 8) throw new Error('SITE_PASSWORD must be at least 8 characters (12 or more is recommended).');
  const gated = !!PASSWORD || USERS.size > 0;
  const multiUser = USERS.size > 0;
  const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  // Keep sessions short-lived even if an environment value is accidentally excessive.
  const SESSION_DAYS = Math.min(30, Number(env.SESSION_DAYS) > 0 ? Number(env.SESSION_DAYS) : 7);
  const SESSION_MS = SESSION_DAYS * 86400000;
  const SEC = loadSecurityHeaders();
  const BUILD = buildInfo(env);
  const pwTag = sha(PASSWORD).toString('hex');   // changing the password invalidates every existing session
  const usersTag = sha([...USERS].map(([n, p]) => n + '\n' + p).join('\0')).toString('hex');   // so does changing any user's password

  /* ---------------- sessions: stateless signed cookie "<expiry>.<hmac>" (shared password) or "<expiry>.<user>.<hmac>" (individual user) ---------------- */
  const mac = exp => b64u(crypto.createHmac('sha256', SECRET).update(`v1.${exp}.${pwTag}`).digest());
  const macUser = (exp, u) => b64u(crypto.createHmac('sha256', SECRET).update(`v2.${exp}.${u}.${usersTag}`).digest());
  const makeToken = (now = Date.now(), user = null) => {
    const exp = now + SESSION_MS;
    if (user) { const u = b64u(user); return `${exp}.${u}.${macUser(exp, u)}`; }
    return `${exp}.${mac(exp)}`;
  };
  const sharedIdentity = () => ({ name: USERNAME || 'shared', role: SHARED_ROLE, shared: true, multi: multiUser });
  /** token -> { name, role, shared } or null */
  function identityOfToken(tok, now = Date.now()) {
    if (typeof tok !== 'string') return null;
    const parts = tok.split('.');
    if (parts.length < 2 || parts.length > 3 || !/^\d{10,16}$/.test(parts[0] || '') || !parts[parts.length - 1]) return null;
    const exp = parts[0];
    if (Number(exp) < now) return null;
    const sig = parts[parts.length - 1];
    const want = parts.length === 3 ? macUser(exp, parts[1]) : mac(exp);
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (parts.length === 2) return PASSWORD ? sharedIdentity() : null;
    let name = ''; try { name = Buffer.from(parts[1], 'base64url').toString('utf8'); } catch (_) { return null; }
    return USERS.has(name) ? { name, role: ROLES.get(name) || 'editor', shared: false, multi: true } : null;
  }
  const validToken = (tok, now = Date.now()) => !!identityOfToken(tok, now);
  const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => { const i = s.indexOf('='); return i < 0 ? ['', ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()]; }));
  const authed = req => !gated || validToken(cookies(req)[COOKIE]);
  const identityOf = req => (gated ? identityOfToken(cookies(req)[COOKIE]) : { name: 'local', role: 'owner', shared: true, multi: false });
  const isSecure = req => prod || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const setCookie = (req, value, maxAgeSec) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;

  /* ---------------- brute-force protection ---------------- */
  const fails = new Map();                 // per client IP
  const FAIL_MAX = 5, FAIL_WINDOW = 15 * 60000, GLOBAL_MAX = 50;
  let global = { n: 0, start: Date.now() };
  // The LAST x-forwarded-for entry is the one our own proxy appended; earlier ones are client-controlled.
  const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || 'unknown';
  function lockedOut(ip, now = Date.now()) {
    if (now - global.start > FAIL_WINDOW) global = { n: 0, start: now };
    const r = fails.get(ip);
    if (r && now - r.start > FAIL_WINDOW) fails.delete(ip);
    const rec = fails.get(ip);
    if ((rec && rec.n >= FAIL_MAX) || global.n >= GLOBAL_MAX) return Math.max(1, Math.ceil((FAIL_WINDOW - (now - ((rec && rec.start) || global.start))) / 1000));
    return 0;
  }
  function recordFail(ip, now = Date.now()) {
    const r = fails.get(ip) || { n: 0, start: now }; r.n++; fails.set(ip, r); global.n++;
    if (fails.size > 5000) for (const [k, v] of fails) if (now - v.start > FAIL_WINDOW) fails.delete(k);
  }

  /* ---------------- API abuse protection ----------------
   * This is an in-process safety net. For multiple server instances, use a shared
   * rate-limit store at the hosting/proxy layer as well.
   */
  const apiHits = new Map();
  const API_WINDOW = 5 * 60 * 1000, API_MAX = 240;
  function apiRateLimit(ip, now = Date.now()) {
    let rec = apiHits.get(ip);
    if (!rec || now - rec.start >= API_WINDOW) {
      rec = { start: now, n: 0 };
      apiHits.set(ip, rec);
    }
    if (rec.n >= API_MAX) return Math.max(1, Math.ceil((rec.start + API_WINDOW - now) / 1000));
    rec.n++;
    if (apiHits.size > 5000) {
      for (const [key, value] of apiHits) {
        if (now - value.start >= API_WINDOW) apiHits.delete(key);
      }
      // Bound memory even if requests arrive from many unique addresses.
      while (apiHits.size > 5000) apiHits.delete(apiHits.keys().next().value);
    }
    return 0;
  }

  /* ---------------- helpers ---------------- */
  function baseHeaders(req, extra = {}) {
    const h = { ...SEC, 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store', ...extra };
    if (!isSecure(req)) delete h['Strict-Transport-Security'];
    return h;
  }
  const send = (req, res, status, body, extra = {}) => { res.writeHead(status, baseHeaders(req, { 'Content-Type': 'text/plain; charset=utf-8', ...extra })); res.end(req.method === 'HEAD' ? undefined : body); };
  const redirect = (req, res, to, extra = {}) => { res.writeHead(303, baseHeaders(req, { Location: to, ...extra })); res.end(); };
  const safeNext = n => (typeof n === 'string' && /^\/(?![/\\])[\w\-./%~?=&#]*$/.test(n) && !n.startsWith('/login') && !n.startsWith('/logout') ? n : '/');
  // CSRF defence on top of SameSite=Strict. Browsers state where a request came from in Sec-Fetch-Site, which page
  // script cannot forge, so that wins when present. Otherwise require a matching Origin, or (when a strict referrer
  // policy makes the browser send "Origin: null") a matching Referer. No signal at all is refused.
  const sameOriginPost = req => {
    const sfs = req.headers['sec-fetch-site'];
    if (sfs) return sfs === 'same-origin';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const matches = v => { try { return new URL(v).host === host; } catch (_) { return false; } };
    const origin = req.headers.origin;
    if (origin && origin !== 'null') return matches(origin);
    return !!req.headers.referer && matches(req.headers.referer);
  };
  function readForm(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function loginPage(next, failed) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Threadform - log in</title>
<style>:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1c1b19;--mut:#6b6a66;--line:#dcdad4;--acc:#4338ca;--err:#b42318}@media(prefers-color-scheme:dark){:root{--bg:#161614;--card:#201f1d;--ink:#f1f0ec;--mut:#a3a29c;--line:#34332f;--acc:#8b87ff;--err:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}h1{margin:0 0 4px;font-size:22px}p{margin:0 0 18px;color:var(--mut);font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:inherit;font:inherit}input:focus-visible,button:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:9px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}@media(prefers-color-scheme:dark){button{color:#111}}
.err{margin:14px 0 0;color:var(--err);font-size:14px}</style></head><body><main>
<h1>Threadform</h1><p>This studio is private. Log in to continue.</p>
<form method="post" action="/login" autocomplete="on">
<input type="hidden" name="next" value="${esc(next)}">
${USERNAME || multiUser ? `<label for="u">Username${!USERNAME && PASSWORD ? ' (leave empty to use the shared password)' : ''}</label><input id="u" name="username" autocomplete="username"${USERNAME || !PASSWORD ? ' required' : ''} autofocus>` : ''}
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required${USERNAME || multiUser ? '' : ' autofocus'}>
${failed ? '<p class="err" role="alert">That did not match. Please try again.</p>' : ''}
<button type="submit">Log in</button></form></main></body></html>`;
  }

  /* ---------------- static files (allowlist) ---------------- */
  const PUBLIC_DIRS = ['css', 'js'];
  function resolveStatic(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath); } catch (_) { return null; }
    if (p.includes('\0') || p.includes('\\')) return null;
    if (p === '/' || p === '') p = '/index.html';
    const parts = p.split('/').filter(Boolean);
    if (parts.some(s => s === '..' || s === '.' || s.startsWith('.'))) return null;      // no traversal, no dotfiles
    const ok = (parts.length === 1 && parts[0] === 'index.html') || (parts.length >= 2 && PUBLIC_DIRS.includes(parts[0]));
    if (!ok) return null;
    const file = path.join(ROOT, ...parts);
    if (!file.startsWith(ROOT + path.sep)) return null;
    if (/\.test\.|\.map$/.test(file)) return null;                                         // never serve tests or sourcemaps
    if (!MIME[path.extname(file).toLowerCase()]) return null;
    try { const real = fs.realpathSync(file); if (!real.startsWith(fs.realpathSync(ROOT) + path.sep) || !fs.statSync(real).isFile()) return null; return real; } catch (_) { return null; }
  }
  const shared = createShared({ env, baseHeaders, sameOriginPost });
  const ai = createAi({ env, baseHeaders, sameOriginPost, clientIp });
  const indexHtml = me => {
    let t = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    if (gated) t = t.replace('</head>', '<meta name="threadform-auth" content="1">\n</head>');
    if (me) t = t.replace('</head>', `<meta name="threadform-user" content="${esc(me.name)}" data-role="${esc(me.role)}" data-multi="${multiUser ? 1 : 0}">\n</head>`);
    if (shared.enabled) t = t.replace('</head>', '<meta name="threadform-shared" content="1">\n</head>');
    if (ai.enabled) t = t.replace('</head>', '<meta name="threadform-ai" content="1">\n</head>');
    return t;
  };

  const gzCache = new Map();   // file -> { etag, buf }: each static file is compressed once per change
  function gzipOf(file, etag) {
    const c = gzCache.get(file);
    if (c && c.etag === etag) return c.buf;
    const buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
    gzCache.set(file, { etag, buf });
    return buf;
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      const m = req.method;

      if (pathname === '/healthz') {   // public: liveness + which build is running (a commit sha and a version, no secrets, no configuration)
        if (m !== 'GET' && m !== 'HEAD') return send(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
        return send(req, res, 200, JSON.stringify({ status: 'ok', app: 'threadform', ...BUILD }), { 'Content-Type': 'application/json; charset=utf-8' });
      }

      if (gated && pathname === '/login') {
        if (m === 'GET' || m === 'HEAD') {
          const next = safeNext(url.searchParams.get('next'));
          if (authed(req)) return redirect(req, res, next);
          res.writeHead(200, baseHeaders(req, { 'Content-Type': 'text/html; charset=utf-8' }));
          return res.end(m === 'HEAD' ? undefined : loginPage(next, url.searchParams.get('e') === '1'));
        }
        if (m === 'POST') {
          if (!sameOriginPost(req)) return send(req, res, 403, 'Forbidden');
          if (!/application\/x-www-form-urlencoded/i.test(String(req.headers['content-type'] || ''))) return send(req, res, 415, 'Unsupported');
          const ip = clientIp(req), wait = lockedOut(ip);
          if (wait) return send(req, res, 429, 'Too many attempts. Please wait and try again.', { 'Retry-After': String(wait) });
          const f = await readForm(req);
          const next = safeNext(f.get('next'));
          const given = String(f.get('username') || '').trim().toLowerCase(), pw = f.get('password') || '';
          let token = null;
          if (given && USERS.has(given)) { if (same(pw, USERS.get(given))) token = makeToken(Date.now(), given); else same(pw, pw); }
          else if (PASSWORD) {
            const okUser = USERNAME ? same(given, USERNAME.toLowerCase()) : !given;   // blank username = shared password (when no SITE_USERNAME)
            const okPass = same(pw, PASSWORD);
            if (okUser && okPass) token = makeToken();
          } else same(pw, pw);
          if (token) { fails.delete(ip); return redirect(req, res, next, { 'Set-Cookie': setCookie(req, token, Math.floor(SESSION_MS / 1000)) }); }
          recordFail(ip); await sleep(env.NODE_ENV === 'test' ? 0 : 400);
          return redirect(req, res, `/login?e=1&next=${encodeURIComponent(next)}`);
        }
        return send(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
      }

      if (gated && pathname === '/logout') {
        if (m !== 'POST') return send(req, res, 405, 'Method not allowed', { Allow: 'POST' });
        if (!sameOriginPost(req)) return send(req, res, 403, 'Forbidden');
        return redirect(req, res, '/login', { 'Set-Cookie': setCookie(req, '', 0) });
      }

      if (!authed(req)) {
        if ((m === 'GET' || m === 'HEAD') && /text\/html/.test(String(req.headers.accept || 'text/html'))) return redirect(req, res, `/login?next=${encodeURIComponent(safeNext(pathname + url.search))}`);
        return send(req, res, 401, 'Please log in.');
      }
      if (pathname.startsWith('/api/')) {
        const wait = apiRateLimit(clientIp(req));
        if (wait) return send(req, res, 429, 'Too many requests. Please wait and try again.', { 'Retry-After': String(wait) });
      }
      if (SHARED_ROUTES.test(pathname)) return shared.handle(req, res, url, identityOf(req));
      if (AI_ROUTES.test(pathname)) return ai.handle(req, res, url);
      if (m !== 'GET' && m !== 'HEAD') return send(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

      const file = resolveStatic(pathname);
      if (!file) return send(req, res, 404, 'Not found');
      const ext = path.extname(file).toLowerCase();
      if (path.basename(file) === 'index.html' && path.dirname(file) === fs.realpathSync(ROOT)) {
        res.writeHead(200, baseHeaders(req, { 'Content-Type': MIME['.html'] }));
        return res.end(m === 'HEAD' ? undefined : indexHtml(identityOf(req)));
      }
      const st = fs.statSync(file), etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const hdrs = baseHeaders(req, { 'Content-Type': MIME[ext], 'Cache-Control': 'private, no-cache', ETag: etag });
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, hdrs); return res.end(); }
      const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && /^\.(js|mjs|css|svg|json|txt)$/.test(ext) && st.size > 1024 ? gzipOf(file, etag) : null;
      hdrs.Vary = 'Accept-Encoding';
      if (gz) { res.writeHead(200, { ...hdrs, 'Content-Encoding': 'gzip', 'Content-Length': gz.length }); return res.end(m === 'HEAD' ? undefined : gz); }
      res.writeHead(200, { ...hdrs, 'Content-Length': st.size });
      if (m === 'HEAD') return res.end();
      const rs = fs.createReadStream(file);
      rs.on('error', () => res.destroy());   // a file removed mid-request must not crash the process
      rs.pipe(res);
    } catch (err) {
      if (err && err.status === 413) return send(req, res, 413, 'Too large');
      console.error('request failed:', err && err.name, err && err.code || '');   // name/code only: never the message, which could hold a URL or a value
      return send(req, res, 500, 'Something went wrong.');   // never echo internals
    }
  }
  return { handler, gated, makeToken, validToken, identityOfToken, config: { prod, multiUser } };
}

export function startServer(env = process.env, port = env.PORT ? Number(env.PORT) : 8080) {
  const app = createApp(env);
  const server = http.createServer(app.handler);
  server.headersTimeout = 15000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000;
  return new Promise(resolve => server.listen(port, '0.0.0.0', () => resolve({ server, app, port: server.address().port })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { app, port } = await startServer();
    console.log(`Threadform listening on :${port} (${app.gated ? 'login required' : 'OPEN: no SITE_PASSWORD set'})`);
    if (!app.gated) console.warn('WARNING: SITE_PASSWORD is not set, so anyone can use this server.');
  } catch (e) { console.error('Cannot start:', e.message); process.exit(1); }
  // One bad request must not take the whole service down for everyone; log the kind of failure only.
  process.on('unhandledRejection', e => console.error('unhandled rejection:', e && e.name));
  process.on('uncaughtException', e => console.error('uncaught exception:', e && e.name));
}
