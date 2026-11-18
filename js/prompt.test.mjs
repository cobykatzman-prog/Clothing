import assert from 'node:assert/strict';
import { parsePrompt, intensityScale } from './prompt.js';

const eq = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL:', name, '\n', e.message); process.exitCode = 1; } };
const SL = ['leftSleeve', 'rightSleeve'];

t('intensity', () => { assert.equal(intensityScale('Subtle'), 0.4); assert.equal(intensityScale('Medium'), 0.75); assert.equal(intensityScale('Bold'), 1); });

t('slightly flared', () => {
  const r = parsePrompt('Make the sleeves slightly flared');
  assert.equal(r.sleevePreset, 'slightFlare'); assert.ok(r.paramDeltas.sleeveFlare > 0 && r.paramDeltas.sleeveFlare <= 40); eq(r.regions, SL);
});
t('remove cuffs keep flared', () => {
  const r = parsePrompt('Remove the cuffs but keep the sleeves flared');
  assert.equal(r.sleevePreset, 'openHem'); assert.ok(r.regions.includes('cuffs')); assert.ok(r.keep.includes('leftSleeve') && r.keep.includes('rightSleeve'));
  assert.ok(!r.regions.includes('leftSleeve'));
});
t('boxy', () => {
  const r = parsePrompt('Make the body more boxy');
  assert.equal(r.fitPreset, 'boxy'); assert.ok(r.paramDeltas.bodyWidth > 30); assert.ok(r.regions.includes('body'));
});
t('oversized', () => {
  const r = parsePrompt('Make the shirt oversized');
  assert.equal(r.fitPreset, 'oversized'); assert.ok(r.paramDeltas.bodyWidth >= 60 && r.paramDeltas.shoulderWidth > 0 && r.paramDeltas.sleeveWidth > 0);
});
t('long sleeve', () => {
  const r = parsePrompt('Change this into a long sleeve shirt');
  assert.ok(r.paramDeltas.sleeveLength >= 60); assert.equal(r.garmentKind, 'longSleeve'); assert.ok(r.regions.includes('leftSleeve'));
});
t('wider from elbow', () => {
  const r = parsePrompt('Make the sleeves wider from the elbow down');
  assert.ok(r.paramDeltas.sleeveWidth > 0); assert.equal(r.sleeveFrom, 'elbow'); assert.ok(r.paramDeltas.sleeveShape > 0); eq(r.regions, SL);
});
t('vintage tennis collar', () => {
  const r = parsePrompt('Change the collar to a vintage tennis collar');
  assert.equal(r.collarStyle, 'tennis'); assert.ok(r.regions.includes('collar')); assert.equal(r.style, undefined);
});
t('brown piping', () => {
  const r = parsePrompt('Add brown piping down the sleeves');
  assert.equal(r.addElements.length, 2); assert.ok(r.addElements.every((e) => e.type === 'piping' && /^#6b4226$/i.test(e.color)));
  eq(r.addElements.map((e) => e.region), SL);
});
t('cropped hem', () => {
  const r = parsePrompt('Make the hem slightly cropped');
  assert.ok(r.paramDeltas.cropLength > 10 && r.paramDeltas.cropLength < 40); assert.ok(r.regions.includes('hem'));
});
t('heavyweight cotton', () => {
  const r = parsePrompt('Make the fabric look like heavyweight cotton');
  assert.equal(r.fabric, 'heavyweightCotton'); assert.ok(r.regions.includes('fabric'));
});
t('greek island', () => {
  const r = parsePrompt('Give this a Greek island summer aesthetic');
  assert.equal(r.style, 'greekIsland'); assert.equal(r.fabric, 'linen'); assert.ok(r.color && r.color.tint); assert.ok(r.palette.length >= 3);
});
t('more vintage', () => {
  const r = parsePrompt('Make it more vintage');
  assert.equal(r.style, 'vintage'); assert.ok(r.color && r.color.sat < 0);
});
t('keep except sleeves', () => {
  const r = parsePrompt('Keep everything the same except the sleeves');
  eq(r.keepAllExcept, SL); eq(r.regions, SL); assert.ok(r.keep.includes('body') && r.keep.includes('collar') && !r.keep.includes('leftSleeve'));
});
t('compound', () => {
  const r = parsePrompt('Keep the cream colour and brown stripes. Make the shirt more boxy, remove the tight cuffs, and give the sleeves a subtle flare toward the wrists.');
  assert.ok(r.keepColor); assert.ok(r.keep.includes('stripes')); assert.equal(r.fitPreset, 'boxy');
  assert.ok(r.removeCuffs); assert.equal(r.sleevePreset, 'slightFlare'); assert.ok(r.paramDeltas.sleeveFlare > 0 && r.paramDeltas.sleeveFlare <= 40);
  assert.equal(r.sleeveFrom, 'wrist'); assert.ok(r.regions.includes('cuffs') && r.regions.includes('body'));
  assert.equal(r.color, undefined); assert.equal(r.addElements.length, 0); assert.ok(r.confidence >= 0.9);
});
t('colour + presets', () => {
  assert.equal(parsePrompt('Make it navy').color.tint, '#1c2a4d');
  assert.equal(parsePrompt('make it streetwear').fitPreset, 'oversized');
  assert.equal(parsePrompt('a minimalist look').style, 'minimalist');
  assert.equal(parsePrompt('preppy').style, 'preppy');
  assert.equal(parsePrompt('90s vibe').style, 'nineties');
  assert.equal(parsePrompt('in linen').fabric, 'linen');
  assert.ok(parsePrompt('Make the sleeves very wide flared').paramDeltas.sleeveFlare === 100);
  assert.ok(parsePrompt('Only change the collar, make it bigger').keepAllExcept.includes('collar'));
});
t('garbage', () => { const r = parsePrompt('asdf qwerty'); assert.equal(r.confidence, 0); assert.deepEqual(r.regions, []); assert.equal(parsePrompt('').summary, ''); });

console.log(`prompt tests passed: ${n}`);
