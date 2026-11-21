// Shared helpers for the browser (Playwright) tests. CommonJS so it can be used with `require('playwright')`.
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.env.OUT || path.join(require('os').tmpdir(), 'threadform-e2e');
fs.mkdirSync(OUT, { recursive: true });

/** Static server that sends the production CSP / security headers from vercel.json (so CSP violations show up). */
function staticServer(port = 0) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const hdrs = Object.fromEntries(cfg.headers[0].headers.map(h => [h.key, h.value]));
  hdrs['Content-Security-Policy'] = hdrs['Content-Security-Policy'].replace('upgrade-insecure-requests', '').replace(/;\s*;/g, ';');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || /\/(test|\.git)\//.test(p) && !p.startsWith('/js/') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, hdrs); return res.end('nf'); }
    res.writeHead(200, { ...hdrs, 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}

/** Tiny test runner: ok(cond, msg) counts, errors collected per page by watch(). */
function runner(name) {
  const R = { pass: 0, fail: 0, fails: [], name };
  R.ok = (c, m) => { if (c) R.pass++; else { R.fail++; R.fails.push(m); console.log('  FAIL: ' + m); } return !!c; };
  R.section = t => console.log('- ' + t);
  R.done = () => { console.log(`${name}: ${R.pass} passed, ${R.fail} failed`); return R.fail === 0; };
  return R;
}

/** Collects JS errors / failed requests / CSP violations; `errs` must be empty at the end of every journey. */
function watch(page, errs, { allow = [] } = {}) {
  const skip = s => allow.some(a => s.includes(a));
  const add = s => { if (!skip(s)) errs.push(s); };
  page.on('pageerror', e => add('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') add('console: ' + m.text()); });
  page.on('requestfailed', r => add('requestfailed ' + r.url()));
  page.on('response', r => { if (r.status() >= 400) add(`http ${r.status()} ${r.url()}`); });
  page.on('request', r => { const u = r.url(); if (!/^(data:|blob:|http:\/\/(127\.0\.0\.1|localhost))/.test(u)) add('external request ' + u); });
}

async function newPage(browser, { mode = 'advanced', width = 1440, height = 900, storageState } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, storageState });
  await ctx.addInitScript(m => { try { if (!localStorage.getItem('threadform.tour')) localStorage.setItem('threadform.tour', 'done'); if (m && !localStorage.getItem('threadform.mode')) localStorage.setItem('threadform.mode', m); } catch {} }, mode);
  const page = await ctx.newPage();
  return { ctx, page };
}

const T = (page) => ({
  /** state accessor */
  ev: (fn, arg) => page.evaluate(fn, arg),
  settle: () => page.waitForFunction(() => { const u = window.__threadform.state.ui; return !u.busy && !u.processing; }, null, { timeout: 30000 }).then(() => page.waitForTimeout(200)),
});

/** A solid-colour PNG (w x h) as a Buffer, for upload tests. */
function pngBuf(w = 80, h = 40, [r, g, b] = [200, 40, 40]) {
  const zlib = require('zlib');
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of buf) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; const edge = x < 4 || y < 4 || x >= w - 4 || y >= h - 4; raw[o] = edge ? 20 : r; raw[o + 1] = edge ? 20 : g; raw[o + 2] = edge ? 20 : b; raw[o + 3] = 255; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { pngBuf, ROOT, OUT, staticServer, runner, watch, newPage, T };
