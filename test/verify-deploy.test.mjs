// Tests scripts/verify-deploy.mjs against a local server.mjs (Render itself cannot be reached from CI or the sandbox).
// Run: node test/verify-deploy.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };
const run = (args, env) => new Promise(resolve => {
  const c = spawn(process.execPath, ['scripts/verify-deploy.mjs', ...args], { cwd: ROOT, env: { PATH: process.env.PATH, ...env } });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  c.on('close', code => resolve({ code, out }));
});
const PW = 'verify-deploy-password-1', SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const live = await startServer({ NODE_ENV: 'test', SITE_PASSWORD: PW, SESSION_SECRET: 'v'.repeat(40), RENDER_GIT_COMMIT: SHA }, 0);
const url = `http://127.0.0.1:${live.port}`;

await t('passes against a healthy local server, with and without a login, and prints no secrets', async () => {
  const anon = await run([], { DEPLOY_URL: url, WAIT_SEC: '0' });
  assert.equal(anon.code, 0, anon.out); assert.match(anon.out, /verify:deploy OK/); assert.match(anon.out, /\/healthz answers 200/); assert.match(anon.out, /skipping the logged-in checks/);
  assert.match(anon.out, /\/js\/main\.js is not served to a visitor who is not logged in/);
  const full = await run([url], { DEPLOY_PASSWORD: PW, WAIT_SEC: '0' });
  assert.equal(full.code, 0, full.out); assert.match(full.out, /login succeeds/); assert.match(full.out, /all \d+ JavaScript\/CSS files load/); assert.match(full.out, /index\.html: CSP present and closed/);
  assert.ok(!full.out.includes(PW), 'the password is never printed');
});

await t('EXPECT_COMMIT: matches by prefix, fails on a different commit and on a deploy that reports none', async () => {
  assert.equal((await run([], { DEPLOY_URL: url, EXPECT_COMMIT: SHA.slice(0, 9), WAIT_SEC: '0' })).code, 0);
  assert.equal((await run([], { DEPLOY_URL: url, EXPECT_COMMIT: SHA.toUpperCase(), WAIT_SEC: '0' })).code, 0, 'case-insensitive');
  const wrong = await run([], { DEPLOY_URL: url, EXPECT_COMMIT: 'ffffffff', WAIT_SEC: '0' });
  assert.equal(wrong.code, 1); assert.match(wrong.out, /expected ffffffff/);
  const none = await startServer({ NODE_ENV: 'test', SITE_PASSWORD: PW }, 0);
  const r = await run([], { DEPLOY_URL: `http://127.0.0.1:${none.port}`, EXPECT_COMMIT: 'abc1234', WAIT_SEC: '0' });
  assert.equal(r.code, 1); assert.match(r.out, /reports no commit/);
  assert.equal((await run([], { DEPLOY_URL: `http://127.0.0.1:${none.port}`, WAIT_SEC: '0' })).code, 0, 'no EXPECT_COMMIT: only a warning');
  none.server.close();
});

await t('fails clearly: wrong password, unreachable service, bad usage', async () => {
  const bad = await run([], { DEPLOY_URL: url, DEPLOY_PASSWORD: 'not-the-password-123', WAIT_SEC: '0' });
  assert.equal(bad.code, 1); assert.match(bad.out, /login failed/);
  const t0 = Date.now(); const down = await run([], { DEPLOY_URL: 'http://127.0.0.1:9', WAIT_SEC: '0' });
  assert.equal(down.code, 1); assert.match(down.out, /did not answer 200/); assert.ok(Date.now() - t0 < 10000);
  const retry = await run([], { DEPLOY_URL: 'http://127.0.0.1:9', WAIT_SEC: '2' }); assert.equal(retry.code, 1); assert.match(retry.out, /retrying/);
  assert.equal((await run([], {})).code, 2); assert.equal((await run([], { DEPLOY_URL: 'ftp://x' })).code, 2); assert.equal((await run([], { DEPLOY_URL: url, EXPECT_COMMIT: 'zzz' })).code, 2);
});

await t('detects a missing security header (a proxy or config change that drops them)', async () => {
  const http = await import('node:http');
  const h = http.createServer((req, res) => { if (req.url === '/healthz') { res.writeHead(200); return res.end('{"status":"ok","app":"threadform","version":"1","commit":null}'); } if (req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<input type="password">'); } res.writeHead(401); res.end('no'); });
  await new Promise(r2 => h.listen(0, '127.0.0.1', r2));
  const r2 = await run([], { DEPLOY_URL: `http://127.0.0.1:${h.address().port}`, WAIT_SEC: '0' });
  assert.equal(r2.code, 1); assert.match(r2.out, /FAIL .*CSP missing/); assert.match(r2.out, /FAIL .*X-Frame-Options missing/); h.close();
});

live.server.close();
console.log(`verify-deploy.test: ${n} passed`);
