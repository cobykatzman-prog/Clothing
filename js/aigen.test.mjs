// Unit tests for Phase 6 (AI generation helpers and the client error mapping): node js/aigen.test.mjs
// ai.js needs a document and a fetch: both are stubbed here, so no network is touched.
import assert from 'node:assert/strict';

globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }), querySelector: () => ({}) };
const { garmentForAi, shapeForAi, describeArtwork, artworkProtection, sectionPrompt, SECTIONS } = await import('./aigen.js');
const { aiGenerate, AiError, resetAiStatus } = await import('./ai.js');
const { parseGarmentText } = await import('./generate.js');
const server = await import('../ai.mjs');

let n = 0, failures = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

t('garmentForAi: type, cut, sleeves, panels, fabric and colour come from the garment spec', () => {
  const g = garmentForAi(parseGarmentText('cream long sleeve shirt with brown stripes, no cuffs, heavyweight cotton'));
  assert.match(g.kind, /long/i); assert.match(g.cut, /long-sleeve/); assert.ok(g.panels.length >= 2); assert.match(g.stripes, /brown/);
  assert.match(g.cuffs, /none/); assert.match(g.sleeves, /plain open|long set-in/); assert.match(g.fabric, /heavyweight cotton/); assert.match(g.color, /cream/);
  const h = garmentForAi(parseGarmentText('navy hoodie'));
  assert.ok(h.panels.some(p => /kangaroo pocket/.test(p))); assert.match(h.collar, /hood/);
  assert.equal(garmentForAi(null), null);
});

t('shapeForAi keeps only moved sliders', () => {
  assert.equal(shapeForAi({ sleeveFlare: 0, bodyWidth: 0 }), null);
  assert.deepEqual(shapeForAi({ sleeveFlare: 35.4, bodyWidth: 0, collarSize: -20 }), { sleeveFlare: 35, collarSize: -20 });
});

t('describeArtwork lists visible layers of that view only', () => {
  const els = [
    { type: 'text', props: { text: 'CLUB ELITE' }, name: 'Back text', view: 'back', visible: true },
    { type: 'logo', props: {}, name: 'logo', view: 'front', visible: true },
    { type: 'logo', props: {}, name: 'Hidden', view: 'front', visible: false },
    { type: 'stripe', props: {}, name: 'stripe', view: 'all', visible: true },
  ];
  const back = describeArtwork(els, 'back'); assert.equal(back.length, 2); assert.match(back[0], /text "CLUB ELITE" \(layer "Back text"\)/);
  assert.equal(describeArtwork(els, 'front').length, 2);
  assert.deepEqual(describeArtwork(null, 'front'), []);
});

t('artworkProtection: logos and text are protected unless the request names artwork', () => {
  assert.deepEqual(artworkProtection('make the sleeves slightly flared', { regions: ['leftSleeve'] }), ['logos', 'text']);
  assert.deepEqual(artworkProtection('wider vintage collar but keep the colour and stripes', {}), ['logos', 'text']);
  assert.deepEqual(artworkProtection('wider collar but keep the logo and the lettering unchanged', {}), ['logos', 'text'], 'keep clauses do not count as naming artwork');
  assert.deepEqual(artworkProtection('remove the logo but keep the text', {}), ['text']);
  assert.deepEqual(artworkProtection('change the lettering to ATHENS', {}), ['logos'], 'naming text frees the text only');
  assert.deepEqual(artworkProtection('remove the logo', {}), ['text'], 'naming the logo frees the logo only');
  assert.deepEqual(artworkProtection('recolour all the artwork', {}), []);
  assert.deepEqual(artworkProtection('tidy this', { regions: ['logos'] }), ['text']);
  assert.deepEqual(artworkProtection('tidy this', { extract: { logo: true } }), ['text']);
  assert.deepEqual(artworkProtection('add a patch on the chest', {}), ['text']);
  assert.deepEqual(artworkProtection('', null), ['logos', 'text']);
});

t('sectionPrompt asks for a fresh take of that section only and keeps artwork', () => {
  const p = sectionPrompt(SECTIONS[0], { spec: parseGarmentText('navy hoodie') });
  assert.match(p, /Regenerate the sleeves/); assert.match(p, /navy hoodie/); assert.match(p, /exactly as they are/); assert.deepEqual(artworkProtection(p, {}), ['logos', 'text'], 'a section prompt never lifts the artwork protection');
});

t('server: sanitizeGarment drops unknown keys and long text, describeShape words the sliders', () => {
  const g = server.sanitizeGarment({ kind: 'hoodie', evil: 'x', panels: ['a', 5, 'b'.repeat(500)], details: 'not a list' });
  assert.deepEqual(Object.keys(g).sort(), ['kind', 'panels']); assert.ok(g.panels[1].length <= 90);
  assert.equal(server.sanitizeGarment('x'), null); assert.equal(server.sanitizeGarment({}), null);
  assert.deepEqual(server.describeShape({ sleeveFlare: 35, bodyWidth: -80, collarSize: 3 }), ['a narrower, slimmer body (strongly)', 'flared sleeve ends (noticeably)']);
});

t('server prompts: garment construction, shape, artwork and front-reference consistency are in the wording', () => {
  const garment = server.sanitizeGarment({ kind: 'long-sleeve top', cut: 'boxy', sleeves: 'open hem, no cuffs', panels: ['two sleeve panels'], fabric: 'heavyweight cotton' });
  const back = server.buildGeneratePrompt({ prompt: 'cream shirt', view: 'back', refCount: 0, garment, shape: ['slightly flared sleeve ends'], artwork: ['text "CLUB"'], frontRef: true });
  assert.match(back, /approved FRONT view/); assert.match(back, /SAME garment/); assert.match(back, /Back view/); assert.match(back, /open hem, no cuffs/);
  assert.match(back, /do not pre-apply/); assert.match(back, /do NOT draw them/);
  const front = server.buildGeneratePrompt({ prompt: 'cream shirt', view: 'front', refCount: 0, garment });
  assert.doesNotMatch(front, /approved FRONT view/); assert.match(front, /Construction to follow exactly/);
  const edit = server.buildEditPrompt({ prompt: 'flare the sleeves', keep: [], avoid: [], hasMask: true, refCount: 0, view: 'front', level: 'medium', garment, shape: ['wider shoulders (strongly)'], artwork: ['logo (layer "Crest")'], section: 'sleeves' });
  assert.match(edit, /selective regeneration of the sleeves ONLY/); assert.match(edit, /must stay exactly as it is/); assert.match(edit, /stay consistent/); assert.match(edit, /wider shoulders \(strongly\)/);
});

// ---- client error mapping: every failure says WHAT failed
const respond = (status, body, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const failWith = async (fetchImpl) => {
  globalThis.fetch = fetchImpl;
  try { await aiGenerate({ prompt: 'a navy tee' }); } catch (e) { return e; }
  throw new Error('expected a failure');
};
t('errors: not configured, key rejected, rate limit, timeout, upstream, declined, bad answer are all distinct and specific', async () => {
  let e = await failWith(respond(404, { error: { code: 'ai_disabled' } })); assert.equal(e.kind, 'disabled'); assert.match(e.message, /not configured/i); assert.equal(e.label, 'Not configured'); assert.equal(e.retryable, false);
  e = await failWith(respond(503, { error: { code: 'ai_auth' } })); assert.equal(e.kind, 'config'); assert.match(e.message, /API key/); assert.equal(e.retryable, false);
  e = await failWith(respond(429, { error: { code: 'ai_provider_busy' } }, { 'retry-after': '7' })); assert.equal(e.kind, 'ratelimit'); assert.equal(e.retryAfter, 7); assert.match(e.message, /rate limit/i); assert.equal(e.retryable, true);
  e = await failWith(respond(429, { error: { code: 'rate_limited' } })); assert.equal(e.kind, 'ratelimit'); assert.match(e.message, /request limit/);
  e = await failWith(respond(503, { error: { code: 'ai_timeout' } })); assert.equal(e.kind, 'timeout'); assert.match(e.message, /timeout/i); assert.equal(e.label, 'Timeout'); assert.equal(e.retryable, true);
  e = await failWith(respond(502, { error: { code: 'ai_upstream' } })); assert.equal(e.kind, 'upstream'); assert.equal(e.label, 'Upstream error'); assert.equal(e.retryable, true);
  e = await failWith(respond(503, { error: { code: 'ai_unreachable' } })); assert.equal(e.kind, 'upstream'); assert.match(e.message, /could not reach the AI provider/);
  e = await failWith(respond(502, { error: { code: 'ai_rejected' } })); assert.equal(e.kind, 'rejected'); assert.match(e.message, /declined/); assert.equal(e.retryable, false);
  e = await failWith(respond(502, { error: { code: 'ai_bad_response' } })); assert.equal(e.kind, 'upstream');
  e = await failWith(async () => { throw new TypeError('network'); }); assert.equal(e.kind, 'offline'); assert.match(e.message, /internet connection/);
  for (const k of ['disabled', 'config', 'ratelimit', 'timeout', 'upstream', 'rejected', 'offline', 'bad']) assert.doesNotMatch(new AiError(k).message, /try another prompt|different words/i, k);
});

for (const [name, fn] of queue) { try { await fn(); n++; console.log('ok -', name); } catch (e) { failures++; process.exitCode = 1; console.error('FAIL -', name, '\n', e.stack); } }
resetAiStatus();
console.log(`\naigen: ${n} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
