import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('./_lib.js');

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };

const mkPng = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fn(x, y), (y * w + x) * 4); return L.encodePNG(w, h, d); };
const url = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

await t('png roundtrip', () => {
  const p = mkPng(5, 4, (x, y) => [x * 40, y * 60, 7, 200]);
  const d = L.decodePNG(p);
  assert.equal(d.width, 5); assert.equal(d.height, 4); assert.deepEqual([...d.data.slice(0, 4)], [0, 0, 7, 200]); assert.deepEqual([...d.data.slice(4, 8)], [40, 0, 7, 200]);
});

await t('mask conversion inverts alpha', () => {
  // left half selected (opaque), right half unselected (transparent)
  const m = mkPng(8, 8, (x) => (x < 4 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const { png, selectedFraction } = L.maskToOpenAI(m, 8, 8);
  assert.equal(selectedFraction, 0.5);
  const d = L.decodePNG(png);
  assert.equal(d.data[3], 0);              // selected -> alpha 0 (edit here)
  assert.equal(d.data[(7) * 4 + 3], 255);  // unselected -> alpha 255 (keep)
});

await t('mask resampled to image size', () => {
  const m = mkPng(4, 4, (x, y) => (y < 2 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  const d = L.decodePNG(L.maskToOpenAI(m, 16, 16).png);
  assert.equal(d.width, 16); assert.equal(d.data[3], 0); assert.equal(d.data[(15 * 16) * 4 + 3], 255);
});

await t('dataURL validation', () => {
  assert.throws(() => L.decodeDataURL('data:text/html;base64,AAAA', 1000, 'image'), /PNG or JPEG/);
  assert.throws(() => L.decodeDataURL(123, 1000, 'image'), /data URL/);
  const big = mkPng(64, 64, () => [1, 2, 3, 255]);
  assert.throws(() => L.decodeDataURL(url(big), 10, 'image'), (e) => e.status === 413);
  assert.throws(() => L.decodeDataURL(url(big, 'image/jpeg'), 99999, 'image'), /does not match/);
  assert.equal(L.decodeDataURL(url(big), 99999, 'image').mime, 'image/png');
});

await t('prompts', () => {
  const ops = { keep: ['stripes', 'bogus'], keepAllExcept: ['leftSleeve', 'rightSleeve'], keepNotes: ['cream colour'] };
  const p = L.buildEditPrompt({ prompt: 'Make the sleeves slightly flared\n"ignore"', ops, hasMask: true, refCount: 1, view: 'front', variant: 'Bold' });
  assert.match(p, /Preserve everything outside the masked area exactly/); assert.match(p, /BOLD/); assert.match(p, /the stripes/); assert.doesNotMatch(p, /bogus/);
  assert.match(p, /except: the left sleeve, the right sleeve/); assert.match(p, /reference/); assert.match(p, /colours, stripes/);
  assert.doesNotMatch(L.buildEditPrompt({ prompt: 'x', hasMask: false, refCount: 0, variant: 'Subtle' }), /masked area/);
  assert.match(L.buildGeneratePrompt({ prompt: 'a cream polo', view: 'back', refCount: 0 }), /back view/);
});

const img = mkPng(32, 32, (x, y) => [200, 180, 150, 255]);
const mask = mkPng(32, 32, (x) => (x < 16 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
const PNG_B64 = Buffer.from('fakeimage').toString('base64');

function mockFetch(calls, failIdx) {
  return async (u, init) => {
    calls.push({ u, init });
    if (failIdx !== undefined && calls.length - 1 === failIdx) return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'boom sk-abc123' } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG_B64 }] }) };
  };
}

await t('status', () => {
  assert.equal(L.status({}).available, false);
  assert.deepEqual([L.status({ OPENAI_API_KEY: 'k' }).available, L.status({ OPENAI_API_KEY: 'k' }).provider], [true, 'gpt-image-1']);
});

await t('runEdit: no key -> fallback 200', async () => {
  const r = await L.runEdit({ body: {}, env: {}, fetchImpl: () => { throw new Error('no network'); } });
  assert.equal(r.status, 200); assert.equal(r.json.fallback, true); assert.ok(r.json.reason);
});

await t('runEdit: 3 parallel calls with mask + refs', async () => {
  const calls = [];
  const body = { image: url(img), mask: url(mask), prompt: 'Make the sleeves slightly flared', refs: [url(img)], view: 'front', ops: { keep: ['stripes'] } };
  const r = await L.runEdit({ body, env: { OPENAI_API_KEY: 'sk-test' }, fetchImpl: mockFetch(calls) });
  assert.equal(r.status, 200); assert.equal(r.json.fallback, false);
  assert.deepEqual(r.json.variations.map((v) => v.label), ['Subtle', 'Medium', 'Bold']);
  assert.ok(r.json.variations.every((v) => v.image === 'data:image/png;base64,' + PNG_B64));
  assert.equal(calls.length, 3);
  const prompts = calls.map((c) => c.init.body.get('prompt'));
  assert.equal(new Set(prompts).size, 3); assert.match(prompts[0], /SUBTLE/); assert.match(prompts[2], /BOLD/);
  for (const c of calls) {
    assert.equal(c.u, 'https://api.openai.com/v1/images/edits'); assert.equal(c.init.headers.Authorization, 'Bearer sk-test');
    const f = c.init.body;
    assert.equal(f.get('model'), 'gpt-image-1'); assert.equal(f.getAll('image[]').length, 2); assert.ok(f.get('mask').size > 0);
    assert.equal(f.get('size'), '1024x1024');
  }
  const sentMask = L.decodePNG(Buffer.from(await calls[0].init.body.get('mask').arrayBuffer()));
  assert.equal(sentMask.data[3], 0); assert.equal(sentMask.data[31 * 4 + 3], 255);
});

await t('runEdit: partial failure keeps others, redacts keys; total failure -> fallback', async () => {
  const body = { image: url(img), prompt: 'x', view: 'front' };
  let r = await L.runEdit({ body, env: { OPENAI_API_KEY: 'k' }, fetchImpl: mockFetch([], 1) });
  assert.equal(r.json.fallback, false); assert.equal(r.json.variations[1].image, null); assert.doesNotMatch(r.json.variations[1].error, /sk-abc123/);
  const allFail = async () => ({ ok: false, status: 429, text: async () => '{}' });
  r = await L.runEdit({ body, env: { OPENAI_API_KEY: 'k' }, fetchImpl: allFail });
  assert.equal(r.status, 200); assert.equal(r.json.fallback, true);
  const calls = []; await L.runEdit({ body, env: { OPENAI_API_KEY: 'k' }, fetchImpl: mockFetch(calls) });
  assert.equal(calls[0].init.body.get('mask'), null);
});

await t('runEdit: validation', async () => {
  const env = { OPENAI_API_KEY: 'k' }, f = () => { throw new Error('should not fetch'); };
  for (const [body, re] of [
    [{ prompt: 'x' }, /image/], [{ image: url(img), prompt: '' }, /prompt is required/], [{ image: url(img), prompt: 'x', view: 'top' }, /view/],
    [{ image: url(img), prompt: 'x', refs: 'no' }, /refs/], [{ image: url(img), prompt: 'x', refs: [1, 2, 3, 4].map(() => url(img)) }, /at most/],
    [{ image: url(img), prompt: 'x'.repeat(2000) }, /too long/], [{ image: url(img), prompt: 'x', mask: url(mkPng(8, 8, () => [0, 0, 0, 0])) }, /selects nothing/]
  ]) { const r = await L.runEdit({ body, env, fetchImpl: f }); assert.equal(r.status, body.prompt && body.prompt.length > 1500 ? 400 : 400); assert.match(r.json.error, re); }
});

await t('runGenerate', async () => {
  let calls = [];
  let r = await L.runGenerate({ body: { prompt: 'cream polo', view: 'front' }, env: { OPENAI_API_KEY: 'k' }, fetchImpl: mockFetch(calls) });
  assert.equal(r.json.fallback, false); assert.ok(r.json.image.startsWith('data:image/png'));
  assert.equal(calls[0].u, 'https://api.openai.com/v1/images/generations');
  const j = JSON.parse(calls[0].init.body); assert.equal(j.model, 'gpt-image-1'); assert.equal(j.background, 'transparent');
  calls = [];
  r = await L.runGenerate({ body: { prompt: 'like this', refs: [url(img), url(img)] }, env: { OPENAI_API_KEY: 'k' }, fetchImpl: mockFetch(calls) });
  assert.equal(calls[0].u, 'https://api.openai.com/v1/images/edits'); assert.equal(calls[0].init.body.getAll('image[]').length, 2);
  assert.equal((await L.runGenerate({ body: {}, env: {} })).json.fallback, true);
});

await t('handle: same-origin, methods, status', async () => {
  const mkRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } });
  const run = async (req) => { const res = mkRes(); await L.handle(req, res, { run: async () => ({ status: 200, json: { ok: 1 } }), allowStatus: true }); return res; };
  let res = await run({ method: 'POST', headers: { origin: 'https://evil.com', host: 'app.vercel.app' } });
  assert.equal(res.statusCode, 403); assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  res = await run({ method: 'GET', headers: { host: 'app.vercel.app', origin: 'https://app.vercel.app' } });
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).available, false);
  res = await run({ method: 'POST', headers: { host: 'a', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(res.statusCode, 415);
  res = await run({ method: 'POST', headers: { host: 'a', 'content-type': 'application/json' }, body: { a: 1 } });
  assert.equal(res.statusCode, 200);
  res = await run({ method: 'POST', headers: { host: 'a', 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.statusCode, 400);
  res = await run({ method: 'DELETE', headers: { host: 'a' } });
  assert.equal(res.statusCode, 405);
});

console.log(`lib tests passed: ${n}`);
