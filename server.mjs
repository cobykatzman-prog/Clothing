// Threadform web server: serves the static studio behind a password set in the environment.
// Zero dependencies (Node built-ins only). Nothing is sent to any third party.
//
//   SITE_PASSWORD   required in production (min 8 chars, 12+ recommended). Visitors must log in with it.
//   SITE_USERNAME   optional. If set, visitors must also enter this username.
//   SESSION_SECRET  optional. Signs login cookies. If unset, a random one is made at start-up
//                   (everyone is logged out when the server restarts).
//   SESSION_DAYS    optional, how long a login lasts (default 7).
//   NODE_ENV=production  makes the server refuse to start without SITE_PASSWORD.
//   ALLOW_OPEN=1    explicitly allow running with no password (local development only).
//   PORT            listen port (Render sets this).
//
// Until a visitor is logged in, no studio file is served at all: only the login page and /healthz.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'tf_session';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));   // constant-time, length-independent
const b64u = buf => Buffer.from(buf).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadSecurityHeaders() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return Object.fromEntries(cfg.headers[0].headers.map(h => [h.key, h.value]));   // single source of truth for the CSP etc.
  } catch (_) {
    return { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
  }
}

export function createApp(env = process.env) {
  const PASSWORD = env.SITE_PASSWORD || '';
  const USERNAME = env.SITE_USERNAME || '';
  const prod = env.NODE_ENV === 'production';
  if (!PASSWORD) {
    if (prod && env.ALLOW_OPEN !== '1') throw new Error('SITE_PASSWORD is not set. Set it in the environment (or ALLOW_OPEN=1 to run without a login, development only).');
  } else if (PASSWORD.length < 8) throw new Error('SITE_PASSWORD must be at least 8 characters (12 or more is recommended).');
  const gated = !!PASSWORD;
  const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const SESSION_MS = (Number(env.SESSION_DAYS) > 0 ? Number(env.SESSION_DAYS) : 7) * 86400000;
  const SEC = loadSecurityHeaders();
  const pwTag = sha(PASSWORD).toString('hex');   // changing the password invalidates every existing session

  /* ---------------- sessions: stateless signed cookie "<expiry>.<hmac>" ---------------- */
  const mac = exp => b64u(crypto.createHmac('sha256', SECRET).update(`v1.${exp}.${pwTag}`).digest());
  const makeToken = (now = Date.now()) => { const exp = now + SESSION_MS; return `${exp}.${mac(exp)}`; };
  function validToken(tok, now = Date.now()) {
    if (typeof tok !== 'string') return false;
    const [exp, sig, extra] = tok.split('.');
    if (extra !== undefined || !/^\d{10,16}$/.test(exp || '') || !sig) return false;
    if (Number(exp) < now) return false;
    const a = Buffer.from(sig), b = Buffer.from(mac(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => { const i = s.indexOf('='); return i < 0 ? ['', ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()]; }));
  const authed = req => !gated || validToken(cookies(req)[COOKIE]);
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
${USERNAME ? '<label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus>' : ''}
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required${USERNAME ? '' : ' autofocus'}>
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
  const indexHtml = () => { const t = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); return gated ? t.replace('</head>', '<meta name="threadform-auth" content="1">\n</head>') : t; };

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      const m = req.method;

      if (pathname === '/healthz') return send(req, res, 200, 'ok');

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
          const okUser = USERNAME ? same(f.get('username') || '', USERNAME) : true;
          const okPass = same(f.get('password') || '', PASSWORD);
          if (okUser && okPass) { fails.delete(ip); return redirect(req, res, next, { 'Set-Cookie': setCookie(req, makeToken(), Math.floor(SESSION_MS / 1000)) }); }
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
      if (m !== 'GET' && m !== 'HEAD') return send(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

      const file = resolveStatic(pathname);
      if (!file) return send(req, res, 404, 'Not found');
      const ext = path.extname(file).toLowerCase();
      if (path.basename(file) === 'index.html' && path.dirname(file) === fs.realpathSync(ROOT)) {
        res.writeHead(200, baseHeaders(req, { 'Content-Type': MIME['.html'] }));
        return res.end(m === 'HEAD' ? undefined : indexHtml());
      }
      const st = fs.statSync(file), etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const hdrs = baseHeaders(req, { 'Content-Type': MIME[ext], 'Cache-Control': 'private, no-cache', ETag: etag });
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, hdrs); return res.end(); }
      res.writeHead(200, { ...hdrs, 'Content-Length': st.size });
      if (m === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (err && err.status === 413) return send(req, res, 413, 'Too large');
      return send(req, res, 500, 'Something went wrong.');   // never echo internals
    }
  }
  return { handler, gated, makeToken, validToken, config: { prod } };
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
}
