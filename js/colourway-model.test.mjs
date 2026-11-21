import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeColourways, normalizeColourway, makeColourway, branchColourway, uniqueName, fabricForMaterial, materialSnapshot, appearanceOfView, captureElementColours, specRows, specCsv, safeFileName, MAX_COLOURWAYS, SECTION_IDS, colourwaysDoc } from './colourway-model.js';

const look = (c, extra = {}) => ({ color: { hue: 0, sat: 0, light: 0, tint: null, tintAmount: 0.5 }, fabric: { name: null, amount: 0.6 }, parts: { collar: { color: c, ...extra } } });

test('malformed saved colourways become a safe empty set', () => {
  for (const bad of [null, undefined, 5, 'x', [], { list: 'no' }]) assert.deepEqual(normalizeColourways(bad), { list: [], activeId: null });
});

test('normalising drops unknown fields, bad colours, unknown sections and unknown fabrics', () => {
  const c = normalizeColourway({ id: 'a', name: ' Navy ', evil: '<script>', views: { front: { parts: { collar: { color: '#ABCDEF', fabric: { name: 'denim', amount: 7 } }, hacker: { color: '#000000' }, cuffs: { color: 'red' } }, fabric: { name: 'nope', amount: -3 } }, nowhere: look('#111111') } });
  assert.equal(c.name, 'Navy'); assert.equal(c.evil, undefined);
  assert.deepEqual(Object.keys(c.views), ['front']);
  assert.deepEqual(Object.keys(c.views.front.parts), ['collar']);
  assert.equal(c.views.front.parts.collar.color, '#abcdef');
  assert.equal(c.views.front.parts.collar.fabric.amount, 1);
  assert.equal(c.views.front.fabric.name, null);
  assert.equal(c.views.front.fabric.amount, 0);
});

test('active id falls back to the first colourway, duplicate ids are made unique, the list is capped', () => {
  const r = normalizeColourways({ list: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }], activeId: 'gone' });
  assert.equal(r.list.length, 2); assert.notEqual(r.list[0].id, r.list[1].id); assert.equal(r.activeId, 'x');
  const many = normalizeColourways({ list: Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i })) });
  assert.equal(many.list.length, MAX_COLOURWAYS);
});

test('a branch shares nothing mutable with its parent and remembers it', () => {
  const a = makeColourway({ name: 'Navy', views: { front: look('#112233') }, sections: { collar: { note: 'rib' } } });
  const b = branchColourway(a, 'Navy (red collar)');
  assert.equal(b.parent, a.id); assert.notEqual(b.id, a.id);
  b.views.front.parts.collar.color = '#ff0000'; b.sections.collar.note = 'changed';
  assert.equal(a.views.front.parts.collar.color, '#112233'); assert.equal(a.sections.collar.note, 'rib');
});

test('a colourway never carries shape or pictures, and stays far below the shared document limit', () => {
  const a = makeColourway({ name: 'X', views: { front: { ...look('#112233'), params: { bodyWidth: 50 }, original: 'data:image/png;base64,AAAA' } } });
  assert.equal(JSON.stringify(a).includes('bodyWidth'), false); assert.equal(JSON.stringify(a).includes('data:image'), false);
  const all = Array.from({ length: MAX_COLOURWAYS }, (_, i) => makeColourway({ name: 'C' + i, notes: 'n'.repeat(5000), supplierNotes: 's'.repeat(5000),
    views: Object.fromEntries(['front', 'back', 'side', 'detail'].map(v => [v, { ...look('#112233'), parts: Object.fromEntries(SECTION_IDS.map(s => [s, { color: '#112233', fabric: { name: 'cotton', amount: 0.5 } }])) }])) }, i));
  assert.ok(JSON.stringify(colourwaysDoc({ list: all, activeId: all[0].id })).length < 150 * 1024, 'worst case colourways JSON under 150 KB (server doc cap is 1.5 MB)');
});

test('unique names, file names and fabric mapping', () => {
  assert.equal(uniqueName([{ name: 'A' }, { name: 'A 2' }], 'A'), 'A 3'); assert.equal(uniqueName([], 'A'), 'A');
  assert.equal(safeFileName('Navy / Red!'), 'navy-red'); assert.equal(safeFileName(''), 'colourway');
  assert.equal(fabricForMaterial('Denim'), 'denim'); assert.equal(fabricForMaterial('Rib knit'), 'knit'); assert.equal(fabricForMaterial('French terry'), 'knit');
  assert.equal(fabricForMaterial('Polyester'), 'satin'); assert.equal(fabricForMaterial('Wool'), 'wool'); assert.equal(fabricForMaterial('???'), 'cotton');
});

test('material snapshots keep only the specification fields and sane values', () => {
  const m = materialSnapshot({ id: 'm1', name: 'Pique', type: 'Cotton', color: 'bad', supplier: 'Mill', sku: 'P1', weightGsm: '220', pricePerMetre: '', secret: 'x' });
  assert.equal(m.color, '#d6d3d1'); assert.equal(m.weightGsm, 220); assert.equal(m.pricePerMetre, undefined); assert.equal(m.secret, undefined);
  assert.equal(materialSnapshot(null), null);
});

test('appearance and layer colours are captured as plain data', () => {
  const v = { color: { hue: 5, sat: 0, light: 0, tint: null, tintAmount: 0.5 }, fabric: { name: 'linen', amount: 0.4 }, parts: { hem: { color: '#aabbcc', hue: 0, sat: 0, light: 0 } }, params: { bodyWidth: 9 } };
  const a = appearanceOfView(v);
  assert.equal(a.params, undefined); assert.equal(a.color.hue, 5); assert.equal(a.fabric.name, 'linen'); assert.equal(a.parts.hem.color, '#aabbcc');
  assert.deepEqual(captureElementColours([{ id: 'e1', props: { color: '#FF0000', size: 4 } }, { id: 'e2', props: { image: 'data:...' } }]), { e1: { color: '#ff0000' } });
});

test('spec rows and CSV list sections, materials and notes (with CSV escaping)', () => {
  const a = makeColourway({ name: 'Navy, deep', views: { front: look('#112233', { fabric: { name: 'knit', amount: 0.5 } }) }, sections: { collar: { material: { name: 'Rib "1x1"', supplier: 'Mill A', sku: 'R1' }, note: 'matches\ncuffs' } }, notes: 'Autumn' });
  const b = makeColourway({ name: 'Plain' });
  const rows = specRows([a, b]);
  assert.equal(rows.length, 1); assert.equal(rows[0].cells[0].material, 'Rib "1x1"'); assert.equal(rows[0].cells[1].colour, '');
  const csv = specCsv([a, b], 'Tee');
  assert.ok(csv.startsWith('Design,Colourway,Section')); assert.ok(csv.includes('"Navy, deep"')); assert.ok(csv.includes('"Rib ""1x1"""')); assert.ok(csv.includes('(colourway notes)'));
});
