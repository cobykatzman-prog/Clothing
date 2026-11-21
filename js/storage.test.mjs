import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveDesignMeta } from './storage.js';

test('studio autosave preserves gallery, material and review metadata', () => {
  const previous = {
    tags: ['summer'], order: 4, collection: 'Teamwear',
    material: { id: 'mat-1', name: 'Heavyweight cotton' },
    review: { status: 'approved', reviewer: 'Designer', note: 'Ready' },
  };
  const next = preserveDesignMeta({ id: 'design-1', name: 'Club tee', updatedAt: 123 }, previous);
  assert.deepEqual(next.tags, previous.tags);
  assert.equal(next.order, 4);
  assert.equal(next.collection, 'Teamwear');
  assert.deepEqual(next.material, previous.material);
  assert.deepEqual(next.review, previous.review);
});

test('explicitly changed or cleared metadata wins over the previous value', () => {
  const next = preserveDesignMeta({
    tags: [], order: 0, collection: '', material: null,
    review: { status: 'draft' },
  }, {
    tags: ['old'], order: 5, collection: 'Archive',
    material: { id: 'mat-old' }, review: { status: 'approved' },
  });
  assert.deepEqual(next.tags, []);
  assert.equal(next.order, 0);
  assert.equal(next.collection, '');
  assert.equal(next.material, null);
  assert.deepEqual(next.review, { status: 'draft' });
});
