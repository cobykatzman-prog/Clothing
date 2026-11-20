import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGarmentText } from './generate.js';

test('Generate uses the colour selected in the controls when the prompt has no colour', () => {
  const spec = parseGarmentText('a hoodie', { defaultKind: 'tee', defaultColor: '#6f8fb5' });
  assert.equal(spec.kind, 'hoodie');
  assert.equal(spec.color, '#6f8fb5');
  assert.equal(spec.sample.color, '#6f8fb5');
});

test('an explicit prompt colour takes precedence over the colour picker', () => {
  const spec = parseGarmentText('a red hoodie', { defaultColor: '#6f8fb5' });
  assert.equal(spec.color, '#c1272d');
  assert.equal(spec.colourName, 'red');
});

test('the stripes checkbox adds contrasting stripes when the prompt omits them', () => {
  const spec = parseGarmentText('a cream long sleeve shirt', { defaultColor: '#efe6d2', addStripes: true });
  assert.ok(spec.stripe);
  assert.equal(spec.sample.stripe, spec.stripe);
});

test('explicit no-stripes wording wins over the stripes checkbox', () => {
  const spec = parseGarmentText('a blue hoodie with no stripes', { addStripes: true });
  assert.equal(spec.stripe, false);
});

test('explicit stripe colour is preserved', () => {
  const spec = parseGarmentText('a cream shirt with chocolate stripes', { defaultColor: '#6f8fb5' });
  assert.equal(spec.color, '#efe6d2');
  assert.equal(spec.stripe, '#4a2c1a');
});
