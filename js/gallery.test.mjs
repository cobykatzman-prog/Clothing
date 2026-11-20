import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_STATES, normalizeReview, filterDesigns, canReorderDesigns } from './gallery.js';

const designs = [
  { id: '1', name: 'Club tee', collection: 'Teamwear', tags: ['summer', 'club'], material: { name: 'Heavy cotton' }, review: { status: 'approved', reviewer: 'Alex', note: 'Ready for sample' } },
  { id: '2', name: 'Training hoodie', collection: 'Training', tags: ['winter'], material: { name: 'Fleece' }, review: { status: 'review', reviewer: 'Sam', note: 'Check cuff' } },
  { id: '3', name: 'Away polo', collection: 'Teamwear', tags: ['club'], review: { status: 'draft' } },
];

test('gallery search covers material, collection, reviewer, review notes and tags', () => {
  assert.deepEqual(filterDesigns(designs, { query: 'heavy cotton' }).map(x => x.id), ['1']);
  assert.deepEqual(filterDesigns(designs, { query: 'check cuff' }).map(x => x.id), ['2']);
  assert.deepEqual(filterDesigns(designs, { query: 'teamwear' }).map(x => x.id), ['1', '3']);
  assert.deepEqual(filterDesigns(designs, { query: 'winter' }).map(x => x.id), ['2']);
});

test('gallery filters combine collection, tags and review status', () => {
  assert.deepEqual(filterDesigns(designs, { collection: 'Teamwear', tags: ['club'], review: 'approved' }).map(x => x.id), ['1']);
  assert.deepEqual(filterDesigns(designs, { collection: 'Teamwear', tags: ['club'], review: 'draft' }).map(x => x.id), ['3']);
});

test('unknown review values safely default to Draft', () => {
  assert.deepEqual(normalizeReview({ status: 'unknown', reviewer: 4 }), { status: 'draft', reviewer: '4', note: '', updatedAt: 0 });
  assert.equal(REVIEW_STATES.approved, 'Approved');
});

test('drag reordering is available only in unfiltered custom order', () => {
  assert.equal(canReorderDesigns({ sortKey: 'custom' }), true);
  assert.equal(canReorderDesigns({ sortKey: 'edited' }), false);
  assert.equal(canReorderDesigns({ sortKey: 'custom', query: 'tee' }), false);
  assert.equal(canReorderDesigns({ sortKey: 'custom', tags: ['club'] }), false);
  assert.equal(canReorderDesigns({ sortKey: 'custom', collection: 'Teamwear' }), false);
  assert.equal(canReorderDesigns({ sortKey: 'custom', review: 'approved' }), false);
  assert.equal(canReorderDesigns({ sortKey: 'custom', selectMode: true }), false);
});
