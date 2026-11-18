// Tests for the optional AI backend (ai.mjs) against an in-process mock of the OpenAI API (test/mock-openai.mjs).
// Run: node server.ai.test.mjs   (this verifies our server against a mock, NOT the real OpenAI service)
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';
import { startMock } from './test/mock-openai.mjs';
import { encodePNG, decodePNG } from './ai.mjs';

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.stack); process.exitCode = 1; } };
const PW = 'correct-horse-battery', KEY = 'sk-test-SECRET-key-0123456789';
const mock = await startMock({ key: KEY });
const baseEnv = { NODE_ENV: 'test', SITE_PASSWORD: PW, SESSION_SECRET: 's'.repeat(40) };
const aiEnv = { ...baseEnv, OPENAI_API_KEY: KEY, AI_BASE_URL: mock.url, AI_RATE_LIMIT: '1000', AI_DAILY_LIMIT: '100000' };
const servers = [];
const boot = async env => { const s = await startServer(env, 0); servers.push(s.server); const b = `http://127.0.0.1:${s.port}`; return { b, c: await login(b) }; };
const login = async b => (await fetch(b + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: b }, body: `password=${PW}` })).headers.get('set-cookie').split(';')[0];

const seen = [];   // every response body/header text the browser side ever got: scanned for leaks at the end
const mk = ctx => async (p, { method = 'GET', body, headers = {}, raw, auth = true } = {}) => {
  const r = await fetch(ctx.b + p, { method, redirect: 'manual', headers: { ...(auth ? { cookie: ctx.c } : {}), origin: ctx.b, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); seen.push(text, JSON.stringify([...r.headers]));
  let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, headers: r.headers, text, json };
};

const on = await boot(aiEnv), off = await boot(baseEnv);
const api = mk(on), apiOff = mk(off);

// test pictures: 8x8 RGBA PNGs
const px = (w, h, f) => { const a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set(f(x, y), (y * w + x) * 4); return a; };
const durl = b => 'data:image/png;base64,' + b.toString('base64');
const IMG = durl(encodePNG(8, 8, px(8, 8, (x, y) => [200, 180, 150, 255])));
const IMG_ALPHA = durl(encodePNG(8, 8, px(8, 8, (x, y) => [200, 180, 150, x < 2 ? 0 : 255])));
const MASK = durl(encodePNG(8, 8, px(8, 8, (x, y) => [255, 255, 255, x < 4 ? 255 : 0])));   // ours: opaque = selected (left half)
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body-bytes')]).toString('base64');
const edit = (extra = {}, o = {}) => api('/api/ai/edit', { method: 'POST', body: { image: IMG, mask: MASK, prompt: 'make the sleeves slightly flared', constraints: { keep: [], avoid: [] }, refs: [], view: 'front', level: 'medium', ...extra }, ...o });
const JSONH = { 'content-type': 'application/json' };
const last = () => mock.requests[mock.requests.length - 1];
const promptOf = r => (Array.isArray(r.fields.prompt) ? r.fields.prompt[0] : r.fields.prompt);

await t('status: off without a key (200, enabled false), AI routes answer ai_disabled, no meta tag', async () => {
  const s = await apiOff('/api/ai/status'); assert.equal(s.status, 200); assert.deepEqual(s.json, { enabled: false });
  for (const r of ['edit', 'generate', 'understand', 'analyze']) { const x = await apiOff('/api/ai/' + r, { method: 'POST', body: {} }); assert.equal(x.status, 404, r); assert.equal(x.json.error.code, 'ai_disabled'); assert.ok(x.json.error.message); }
  assert.ok(!(await apiOff('/')).text.includes('threadform-ai'));
  assert.equal((await apiOff('/api/ai/nope')).status, 404);
});

await t('status: on with key, defaults, meta tag injected, CSP unchanged', async () => {
  const s = await api('/api/ai/status');
  assert.deepEqual(s.json, { enabled: true, provider: 'openai', imageModel: 'gpt-image-1', visionModel: 'gpt-4.1-mini', quality: 'medium' });
  const home = await api('/'); assert.match(home.text, /<meta name="threadform-ai" content="1">/); assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);
  const o = await boot({ ...aiEnv, AI_PROVIDER: 'openai-compatible', AI_IMAGE_MODEL: 'img-x', AI_VISION_MODEL: 'vis-y', AI_IMAGE_QUALITY: 'high', OPENAI_API_KEY: '', AI_API_KEY: KEY });
  assert.deepEqual((await mk(o)('/api/ai/status')).json, { enabled: true, provider: 'openai-compatible', imageModel: 'img-x', visionModel: 'vis-y', quality: 'high' });
});

await t('base URL validation: http only for loopback, openai-compatible needs a URL, junk disables AI', async () => {
  for (const env of [{ AI_BASE_URL: 'http://example.com/v1' }, { AI_BASE_URL: 'not a url' }, { AI_BASE_URL: 'https://user:pw@example.com/v1' }, { AI_PROVIDER: 'openai-compatible', AI_BASE_URL: '' }, { AI_PROVIDER: 'mystery' }]) {
    const o = await boot({ ...aiEnv, ...env }); assert.deepEqual((await mk(o)('/api/ai/status')).json, { enabled: false }, JSON.stringify(env));
  }
  const o = await boot({ ...baseEnv, OPENAI_API_KEY: KEY, AI_BASE_URL: 'https://example.com/v1/' }); assert.equal((await mk(o)('/api/ai/status')).json.enabled, true);
  const none = await boot({ ...baseEnv, OPENAI_API_KEY: '   ' }); assert.equal((await mk(none)('/api/ai/status')).json.enabled, false);
});

await t('edit with a mask: mask inverted for OpenAI, key only in Authorization, sensible form fields', async () => {
  mock.reset();
  const r = await edit(); assert.equal(r.status, 200, r.text);
  assert.match(r.json.image, /^data:image\/png;base64,/); assert.equal(r.json.level, 'medium'); assert.equal(r.json.model, 'gpt-image-1'); assert.equal(typeof r.json.ms, 'number');
  const q = last(); assert.equal(q.path, '/v1/images/edits'); assert.equal(q.auth, `Bearer ${KEY}`);
  assert.equal(q.fields.model, 'gpt-image-1'); assert.equal(q.fields.size, '1024x1024'); assert.equal(q.fields.input_fidelity, 'high'); assert.equal(q.fields.output_format, 'png'); assert.equal(q.fields.quality, 'medium'); assert.equal(q.fields.n, '1');
  assert.equal(q.fields.background, undefined, 'opaque source: no transparent background');
  const files = q.files.map(f => f.name); assert.deepEqual(files.sort(), ['image[]', 'mask']);
  const m = decodePNG(q.files.find(f => f.name === 'mask').data); assert.equal(m.width, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.equal(m.data[(y * 8 + x) * 4 + 3], x < 4 ? 0 : 255, `mask alpha at ${x},${y}: selected (left) must be transparent`);
  // the mock tints everything it gets, ignoring the mask: the result is visibly changed everywhere
  const out = decodePNG(Buffer.from(r.json.image.split(',')[1], 'base64')); assert.ok(out.data[0] !== 200 && out.data[2] > 150);
});

await t('edit without a mask: no mask part; transparent source asks for a transparent background; quality from env', async () => {
  mock.reset();
  let r = await edit({ mask: null, image: IMG_ALPHA }); assert.equal(r.status, 200, r.text);
  assert.deepEqual(last().files.map(f => f.name), ['image[]']); assert.equal(last().fields.background, 'transparent');
  assert.match(promptOf(last()), /Change only the garment parts the request mentions/); assert.ok(!/masked area/.test(promptOf(last())));
  r = await edit({ mask: null, image: JPG }); assert.equal(r.status, 200); assert.equal(last().files[0].filename, 'image.jpg');
  const o = await boot({ ...aiEnv, AI_IMAGE_QUALITY: 'low', AI_IMAGE_MODEL: 'gpt-image-1.5' }); mock.reset();
  r = await mk(o)('/api/ai/edit', { method: 'POST', body: { image: IMG, prompt: 'x', mask: null } }); assert.equal(r.status, 200);
  assert.equal(last().fields.quality, 'low'); assert.equal(last().fields.model, 'gpt-image-1.5'); assert.equal(r.json.level, 'medium');
});

await t('edit: constraints, level wording, refs and the mask rule reach the prompt', async () => {
  mock.reset();
  let r = await edit({ level: 'subtle', constraints: { keep: ['brown stripes', 'boxy body'], avoid: ['adding cuffs'] }, refs: [IMG, IMG_ALPHA], view: 'back' }); assert.equal(r.status, 200, r.text);
  const p = promptOf(last());
  assert.match(p, /SUBTLE/); assert.match(p, /Preserve everything outside the masked area exactly/); assert.match(p, /brown stripes; boxy body/); assert.match(p, /Do NOT do any of the following: adding cuffs/);
  assert.match(p, /camera angle/i); assert.match(p, /lighting/i); assert.match(p, /composition/i); assert.match(p, /same colours and stripes/i); assert.match(p, /back view/); assert.match(p, /other 2 images are style or material reference/);
  assert.deepEqual(last().files.map(f => f.name), ['image[]', 'image[]', 'image[]', 'mask']);
  for (const [level, word] of [['medium', 'MEDIUM'], ['bold', 'BOLD']]) { await edit({ level }); assert.match(promptOf(last()), new RegExp(word)); }
  assert.equal(last().fields.model, 'gpt-image-1');
});

await t('generate: plain generations call, and edits when refs are given', async () => {
  mock.reset();
  let r = await api('/api/ai/generate', { method: 'POST', body: { prompt: 'a cream long-sleeve shirt with brown stripes', refs: [], view: 'front' } });
  assert.equal(r.status, 200, r.text); assert.match(r.json.image, /^data:image\/png;base64,/); assert.equal(r.json.model, 'gpt-image-1');
  assert.equal(last().path, '/v1/images/generations'); assert.match(last().json.prompt, /cream long-sleeve shirt/); assert.equal(last().json.size, '1024x1024'); assert.equal(last().auth, `Bearer ${KEY}`);
  r = await api('/api/ai/generate', { method: 'POST', body: { prompt: 'like this', refs: [IMG], view: 'back' } });
  assert.equal(r.status, 200); assert.equal(last().path, '/v1/images/edits'); assert.deepEqual(last().files.map(f => f.name), ['image[]']);
  assert.equal((await api('/api/ai/generate', { method: 'POST', body: { prompt: '  ' } })).status, 400);
});

await t('understand: the five owner examples give sensible, sanitised ops', async () => {
  const ask = async prompt => { const r = await api('/api/ai/understand', { method: 'POST', body: { prompt, image: null, view: 'front', hasSelection: false } }); assert.equal(r.status, 200, r.text); return r.json.ops; };
  let o = await ask("make the sleeves slightly flared but don't add cuffs");
  assert.deepEqual(o.regions, ['leftSleeve', 'rightSleeve']); assert.equal(o.sleevePreset, 'slightFlare'); assert.equal(o.paramDeltas.sleeveFlare, 35); assert.equal(o.removeCuffs, true); assert.ok(o.avoid.includes('adding cuffs')); assert.equal(o.text, "make the sleeves slightly flared but don't add cuffs");
  o = await ask('make the body more boxy without changing the length');
  assert.equal(o.fitPreset, 'boxy'); assert.deepEqual(o.regions, ['body']); assert.ok(o.keep.includes('hem')); assert.equal(o.paramDeltas.bodyLength, undefined);
  o = await ask('wider vintage collar but keep the colour and stripes');
  assert.deepEqual(o.regions, ['collar']); assert.ok(o.keep.includes('stripes')); assert.equal(o.keepColor, true); assert.ok(o.paramDeltas.collarSize > 0);
  o = await ask('remove the logo and put it on a separate editable layer');
  assert.deepEqual(o.extract, { logo: true, text: false, graphics: false }); assert.deepEqual(o.removeParts, ['logos']);
  o = await ask('make the back match the front proportions');
  assert.equal(o.matchBackToFront, true); assert.ok(o.confidence > 0 && o.confidence <= 1);
  for (const k of ['summary', 'paramDeltas', 'regions', 'keep', 'addElements', 'avoid', 'extract', 'matchBackToFront', 'confidence']) assert.ok(k in o, k);
  // the system prompt teaches the vocabulary and carries the examples; the model name comes from env
  const q = last(); assert.equal(q.path, '/v1/chat/completions'); assert.equal(q.json.model, 'gpt-4.1-mini'); assert.deepEqual(q.json.response_format, { type: 'json_object' });
  assert.match(q.json.messages[0].content, /raglan|bell|ribbing|tennis|piping/i); assert.match(q.json.messages[0].content, /slightly flared but don't add cuffs/);
});

await t('understand: hostile or garbage model output is whitelisted, clamped and cannot widen a selection', async () => {
  const hostile = { summary: 'x'.repeat(900) + '<script>', paramDeltas: { sleeveFlare: 9999, bodyWidth: -9999, evil: 5, __proto__: { polluted: 1 }, bodyLength: 'abc' }, regions: ['body', 'hackRegion', 'leftSleeve', 'body'], keep: ['logos', 'body'], sleevePreset: 'ninjaSleeve', fitPreset: 'boxy', fabric: 'unobtanium', color: { tint: 'javascript:alert(1)', light: 500 }, collarStyle: 'polo', addElements: [{ type: 'rocket', region: 'body' }, { type: 'text', region: 'body', text: 'HI', color: '#ABC' }, { type: 'logo', region: 'nowhere' }], removeParts: ['logos', 'everything'], avoid: ['a'.repeat(500), 5, 'ok'], extract: { logo: 'yes', text: true }, matchBackToFront: 'true', confidence: 7, unknownKey: { deep: 1 }, keepAllExcept: ['collar', 'bogus'] };
  mock.setChatReply(JSON.stringify(hostile));
  let r = await api('/api/ai/understand', { method: 'POST', body: { prompt: 'anything', image: IMG, view: 'front', hasSelection: false } }); assert.equal(r.status, 200, r.text);
  let o = r.json.ops;
  assert.ok(o.summary.length <= 200); assert.deepEqual(o.paramDeltas, { sleeveFlare: 100, bodyWidth: -100 }); assert.deepEqual(Object.keys(o).filter(k => !['summary', 'paramDeltas', 'regions', 'keep', 'addElements', 'sleevePreset', 'fitPreset', 'collarStyle', 'removeParts', 'avoid', 'extract', 'matchBackToFront', 'confidence', 'text', 'keepAllExcept', 'color'].includes(k)), []);
  assert.deepEqual(o.regions, ['body', 'leftSleeve', 'collar']); assert.deepEqual(o.keep, ['logos']); assert.equal(o.sleevePreset, undefined); assert.equal(o.fitPreset, 'boxy'); assert.equal(o.fabric, undefined);   assert.equal(o.color && o.color.tint, undefined); assert.equal(o.color && o.color.light, 100);
  assert.deepEqual(o.addElements, [{ type: 'text', region: 'body', color: '#aabbcc', text: 'HI' }]); assert.deepEqual(o.removeParts, ['logos']);
  assert.deepEqual(o.avoid.map(s => s.length), [100, 2]); assert.deepEqual(o.extract, { logo: false, text: true, graphics: false }); assert.equal(o.matchBackToFront, false); assert.equal(o.confidence, 1); assert.equal(({}).polluted, undefined);
  // with a selection the region is never widened
  r = await api('/api/ai/understand', { method: 'POST', body: { prompt: 'anything', image: null, view: 'front', hasSelection: true } });
  o = r.json.ops; assert.deepEqual(o.regions, []); assert.equal(o.keepAllExcept, undefined); assert.deepEqual(o.keep, ['logos', 'body']);
  // not JSON at all, fenced JSON, and JSON in prose
  mock.setChatReply('I am sorry, I cannot do that.');
  r = await api('/api/ai/understand', { method: 'POST', body: { prompt: 'x', hasSelection: false } }); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'ai_bad_response');
  mock.setChatReply('```json\n{"summary":"fenced","regions":["collar"],"confidence":0.4}\n```');
  r = await api('/api/ai/understand', { method: 'POST', body: { prompt: 'x', hasSelection: false } }); assert.equal(r.status, 200); assert.deepEqual(r.json.ops.regions, ['collar']);
  mock.setChatReply(JSON.stringify({ ops: { summary: 'nested', regions: ['hem'] } }));
  r = await api('/api/ai/understand', { method: 'POST', body: { prompt: 'x', hasSelection: false } }); assert.deepEqual(r.json.ops.regions, ['hem']);
  mock.setChatReply(null);
});

await t('analyze: elements with exact text, normalised boxes, colours; garbage dropped and clamped', async () => {
  mock.reset();
  let r = await api('/api/ai/analyze', { method: 'POST', body: { image: IMG, view: 'back' } }); assert.equal(r.status, 200, r.text);
  const e = r.json.elements; assert.equal(e.length, 3); assert.equal(e[0].type, 'text'); assert.equal(e[0].text, 'CLUB ELITE'); assert.deepEqual(e[0].bbox, { x: 0.2, y: 0.3, w: 0.6, h: 0.1 }); assert.equal(e[0].color, '#6b4226'); assert.equal(e[0].rotationDeg, 0);
  assert.deepEqual(e.map(x => x.type), ['text', 'graphic', 'logo']);
  const q = last(); assert.equal(q.path, '/v1/chat/completions'); assert.match(q.json.messages[0].content, /exact words/); assert.ok(q.json.messages[1].content.some(p => p.type === 'image_url' && p.image_url.url === IMG));
  mock.setChatReply(JSON.stringify({ elements: [{ type: 'text', bbox: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, text: 'EDGE', rotationDeg: 999 }, { type: 'sparkle', bbox: { x: 0, y: 0, w: 1, h: 1 } }, { type: 'logo', bbox: { x: 'a', y: 0, w: 1, h: 1 } }, { type: 'logo', bbox: { x: 0.5, y: 0.5, w: 0, h: 0.2 } }, 'junk', { type: 'stripe', bbox: { x: -3, y: 0.1, w: 2, h: 0.1 }, color: 'red' }] }));
  r = await api('/api/ai/analyze', { method: 'POST', body: { image: IMG, view: 'front' } }); assert.equal(r.status, 200);
  assert.deepEqual(r.json.elements.map(x => x.type), ['text', 'stripe']); assert.deepEqual(r.json.elements[0].bbox, { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }); assert.equal(r.json.elements[0].rotationDeg, 180);
  assert.deepEqual(r.json.elements[1].bbox, { x: 0, y: 0.1, w: 1, h: 0.1 }); assert.equal(r.json.elements[1].color, undefined);
  mock.setChatReply(null);
  assert.equal((await api('/api/ai/analyze', { method: 'POST', body: { view: 'front' } })).status, 400);
});

await t('auth required (401), CSRF refused (403), wrong method (405), wrong content type (415)', async () => {
  const before = mock.requests.length;
  const noCookie = await api('/api/ai/edit', { method: 'POST', body: { image: IMG, prompt: 'x' }, auth: false }); assert.equal(noCookie.status, 401);
  assert.equal((await api('/api/ai/status', { auth: false })).status, 401);
  for (const headers of [{ origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) { const r = await edit({}, { headers }); assert.equal(r.status, 403, JSON.stringify(headers)); assert.equal(r.json.error.code, 'forbidden'); }
  const noSignal = await fetch(on.b + '/api/ai/edit', { method: 'POST', headers: { cookie: on.c, 'content-type': 'application/json' }, body: '{}' }); assert.equal(noSignal.status, 403);
  assert.equal((await api('/api/ai/edit')).status, 405); assert.equal((await api('/api/ai/status', { method: 'POST', body: {} })).status, 405);
  assert.equal((await api('/api/ai/edit', { method: 'POST', raw: 'x=1', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(mock.requests.length, before, 'nothing reached the upstream');
});

await t('validation: oversize 413, bad magic bytes 400, bad fields 400', async () => {
  const before = mock.requests.length;
  const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3.4 * 1024 * 1024)]).toString('base64');
  let r = await edit({ image: big }); assert.equal(r.status, 413); assert.equal(r.json.error.code, 'too_large');
  r = await edit({ refs: [big] }); assert.equal(r.status, 413);
  r = await api('/api/ai/edit', { method: 'POST', raw: JSON.stringify({ image: 'data:image/png;base64,' + 'A'.repeat(15 * 1024 * 1024), prompt: 'x' }), headers: JSONH }); assert.equal(r.status, 413);
  const fake = (mime, bytes) => `data:${mime};base64,` + Buffer.from(bytes).toString('base64');
  for (const image of [fake('image/png', 'GIF89a-not-a-png-at-all-really-not'), fake('image/jpeg', '\x89PNG\r\n\x1a\n....'), fake('image/gif', 'GIF89a'), 'not a data url', 123, null]) { r = await edit({ image }); assert.equal(r.status, 400, String(image).slice(0, 40)); assert.ok(r.json.error.message); }
  r = await edit({ mask: fake('image/png', 'GIF89a-not-a-png-at-all-really-not') }); assert.equal(r.status, 400);
  r = await edit({ mask: JPG }); assert.equal(r.status, 400, 'mask must be a PNG');
  r = await edit({ mask: durl(encodePNG(8, 8, px(8, 8, () => [255, 255, 255, 0]))) }); assert.equal(r.status, 400, 'empty selection'); assert.match(r.json.error.message, /empty/i);
  r = await edit({ prompt: 'a'.repeat(1501) }); assert.equal(r.status, 400); r = await edit({ prompt: '' }); assert.equal(r.status, 400);
  r = await edit({ refs: [IMG, IMG, IMG, IMG] }); assert.equal(r.status, 400); r = await edit({ refs: 'nope' }); assert.equal(r.status, 400);
  r = await edit({ level: 'extreme' }); assert.equal(r.status, 400); r = await edit({ view: 'top' }); assert.equal(r.status, 400);
  assert.equal((await api('/api/ai/edit', { method: 'POST', raw: '{bad json', headers: JSONH })).status, 400); assert.equal((await api('/api/ai/edit', { method: 'POST', raw: '[]', headers: JSONH })).status, 400);
  r = await edit({ prompt: 'a'.repeat(1500) }); assert.equal(r.status, 200, 'exactly 1500 characters is allowed');
  assert.equal(mock.requests.length, before + 1, 'only the valid request reached the upstream');
});

await t('rate limiting: per-IP 429 with Retry-After (keyed on the last x-forwarded-for entry), daily cap', async () => {
  const o = await boot({ ...aiEnv, AI_RATE_LIMIT: '2', AI_RATE_WINDOW_MIN: '10' }), a = mk(o);
  const go = ip => a('/api/ai/edit', { method: 'POST', body: { image: IMG, prompt: 'x', mask: null }, headers: ip ? { 'x-forwarded-for': ip } : {} });
  assert.equal((await go('9.9.9.9')).status, 200); assert.equal((await go('1.1.1.1, 9.9.9.9')).status, 200);   // spoofed first entry changes nothing
  const r = await go('2.2.2.2, 9.9.9.9'); assert.equal(r.status, 429); assert.equal(r.json.error.code, 'rate_limited'); assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal((await go('8.8.8.8')).status, 200, 'another client is unaffected');
  assert.equal((await a('/api/ai/status')).status, 200, 'status is not rate limited');
  const d = await boot({ ...aiEnv, AI_DAILY_LIMIT: '1' }), b = mk(d);
  assert.equal((await b('/api/ai/analyze', { method: 'POST', body: { image: IMG } })).status, 200);
  const x = await b('/api/ai/generate', { method: 'POST', body: { prompt: 'x' } }); assert.equal(x.status, 429); assert.ok(Number(x.headers.get('retry-after')) >= 60);
});

await t('at most 4 upstream calls at once: extra calls queue and still succeed', async () => {
  mock.reset(); mock.setDelay(150);
  const rs = await Promise.all(Array.from({ length: 9 }, () => edit({ mask: null })));
  assert.ok(rs.every(r => r.status === 200), rs.map(r => r.status).join()); assert.ok(mock.maxActive() <= 4 && mock.maxActive() >= 2, 'max in flight ' + mock.maxActive());
  mock.setDelay(0);
});

await t('upstream failures map to friendly errors; no secret, URL or upstream text leaks', async () => {
  const cases = [['401', 503, 'ai_auth'], ['429', 429, 'ai_provider_busy'], ['500', 502, 'ai_upstream'], ['400', 502, 'ai_rejected'], ['badjson', 502, 'ai_bad_response'], ['noimage', 502, 'ai_bad_response']];
  for (const [f, status, code] of cases) {
    mock.reset(); if (f === '401') mock.setKey('rotated-key'); else mock.setFailure(f);
    for (const [path, body] of [['edit', { image: IMG, prompt: 'x' }], ['generate', { prompt: 'x' }], ['understand', { prompt: 'x' }], ['analyze', { image: IMG }]]) {
      if (['noimage'].includes(f) && ['understand', 'analyze'].includes(path)) continue;
      const r = await api('/api/ai/' + path, { method: 'POST', body }); assert.equal(r.status, status, `${f} ${path}`); assert.equal(r.json.error.code, code, `${f} ${path}`);
      assert.ok(r.json.error.message.length > 10); assert.deepEqual(Object.keys(r.json), ['error']);
      if (f === '429') assert.equal(r.headers.get('retry-after'), '7');
    }
    mock.setKey(KEY);
  }
  mock.reset();
  // timeout: a server whose upstream timeout is short
  const o = await boot({ ...aiEnv, AI_TIMEOUT_MS: '500' }); mock.setFailure('timeout');
  const t0 = Date.now(); const r = await mk(o)('/api/ai/edit', { method: 'POST', body: { image: IMG, prompt: 'x' } });
  assert.equal(r.status, 503); assert.equal(r.json.error.code, 'ai_timeout'); assert.ok(Date.now() - t0 < 5000);
  mock.reset();
  // unreachable upstream
  const dead = await startMock({ key: KEY }); const deadUrl = dead.url; await dead.close();
  const u = await boot({ ...aiEnv, AI_BASE_URL: deadUrl }); const x = await mk(u)('/api/ai/edit', { method: 'POST', body: { image: IMG, prompt: 'x' } });
  assert.equal(x.status, 503); assert.equal(x.json.error.code, 'ai_unreachable');
});

await t('the key, the base URL and upstream bodies never appear in any response, header or index.html', async () => {
  assert.ok(seen.length > 40);
  const all = seen.join('\n');
  for (const secret of [KEY, 'SECRET-key', mock.url, '127.0.0.1:' + mock.port, mock.MARK, 'sk-leaked-from-upstream', 'invalid_api_key', 'rate_limit_exceeded']) assert.ok(!all.includes(secret), 'leaked: ' + secret);
  assert.ok(!(await api('/')).text.includes('sk-'));
});

for (const s of servers) s.close();
await mock.close();
console.log(`server.ai.test.mjs: ${n} tests passed`);
process.exit(process.exitCode || 0);
