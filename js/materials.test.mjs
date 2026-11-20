import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMaterial, normalizeMaterials } from './materials.js';

test('legacy material entries migrate with stable fallback fields', () => {
  const [item] = normalizeMaterials([{ name: 'Cotton jersey', type: 'Cotton', color: '#abcdef', notes: 'Soft' }]);
  assert.equal(item.id, 'mat-legacy-0');
  assert.equal(item.name, 'Cotton jersey');
  assert.equal(item.color, '#abcdef');
  assert.equal(item.notes, 'Soft');
  assert.equal(item.composition, '');
  assert.equal(item.weightGsm, '');
  assert.equal(item.supplier, '');
});

test('expanded material specifications and future fields survive normalisation', () => {
  const input = { id: 'mat-1', name: 'Heavy fleece', type: 'Fleece', color: '#123456', composition: '80% cotton', weightGsm: 360, widthCm: 160, supplier: 'Mill A', sku: 'HF-360', pricePerMetre: 12.5, care: 'Cold wash', customField: 'keep' };
  const item = normalizeMaterial(input);
  for (const key of Object.keys(input)) assert.deepEqual(item[key], input[key]);
});

test('malformed entries and invalid swatch colours are made safe', () => {
  const item = normalizeMaterial({ name: null, color: 'not-a-colour' }, 2);
  assert.equal(item.id, 'mat-legacy-2');
  assert.equal(item.name, 'Untitled material');
  assert.equal(item.color, '#d6d3d1');
  assert.deepEqual(normalizeMaterials(null), []);
});
