import test from 'node:test';
import assert from 'node:assert/strict';
import { chartValue, makeCalibration, measureGarment, normalizeMeasureState, manufacturerSpecCSV, designCalibration, designMeasure } from './measure.js';

function mockGarment({ chest = 100, length = 150, sleeve = 90, shoulder = 80, hem = 100, neck = 18, neckDrop = 8 } = {}) {
  return {
    landmarks: {
      armpitL: { x: 100 + chest / 2, y: 80 },
      armpitR: { x: 100 - chest / 2, y: 80 },
      hemL: { x: 100 + hem / 2, y: 40 + length },
      hemR: { x: 100 - hem / 2, y: 40 + length },
      shoulderL: { x: 100 + shoulder / 2, y: 40 },
      shoulderR: { x: 100 - shoulder / 2, y: 40 },
      neckTop: { x: 100, y: 30 },
      neckBottom: { x: 100, y: 40 + neckDrop },
      centerX: 100,
      cuffL: { x: 20, y: 120 },
      cuffR: { x: 180, y: 120 },
    },
    metrics: {
      fitScale: 1,
      neckRx: neck / (2 * 0.937),
      neckRy: neckDrop,
      sleeves: {
        L: { has: true, L: sleeve, hw: 10, shoulder: { x: 110, y: 40 }, cuff: { x: 110 - sleeve, y: 40 }, a: { x: -1, y: 0 }, n: { x: 0, y: 1 } },
        R: { has: true, L: sleeve, hw: 10, shoulder: { x: 90, y: 40 }, cuff: { x: 90 + sleeve, y: 40 }, a: { x: 1, y: 0 }, n: { x: 0, y: 1 } },
      },
    },
  };
}

test('size calibration anchors chest, body length and sleeves to the selected chart size', () => {
  const seg = mockGarment();
  const cal = makeCalibration(seg, { kind: 'longSleeve', size: 'M' });
  const m = measureGarment(seg, cal);
  assert.equal(m.chest, chartValue('longSleeve', 'M', 'chest'));
  assert.equal(m.length, chartValue('longSleeve', 'M', 'length'));
  assert.equal(m.sleeve, chartValue('longSleeve', 'M', 'sleeve'));
});

test('size grading recalibrates dimensions for each selected size', () => {
  const seg = mockGarment();
  for (const size of ['S', 'M', 'L', 'XL']) {
    const cal = makeCalibration(seg, { kind: 'tee', size });
    const m = measureGarment(seg, cal);
    assert.equal(m.chest, chartValue('tee', size, 'chest'));
    assert.equal(m.length, chartValue('tee', size, 'length'));
    assert.equal(m.sleeve, chartValue('tee', size, 'sleeve'));
  }
});

test('manual body-length calibration does not change chest or sleeve calibration', () => {
  const seg = mockGarment();
  const normal = makeCalibration(seg, { kind: 'longSleeve', size: 'M' });
  const manual = makeCalibration(seg, { kind: 'longSleeve', size: 'M', manual: { key: 'length', cm: 74 } });
  const a = measureGarment(seg, normal), b = measureGarment(seg, manual);
  assert.equal(b.length, 74);
  assert.equal(b.chest, a.chest);
  assert.equal(b.sleeve, a.sleeve);
});

test('manual chest calibration does not change body length or sleeve calibration', () => {
  const seg = mockGarment();
  const normal = makeCalibration(seg, { kind: 'longSleeve', size: 'M' });
  const manual = makeCalibration(seg, { kind: 'longSleeve', size: 'M', manual: { key: 'chest', cm: 58 } });
  const a = measureGarment(seg, normal), b = measureGarment(seg, manual);
  assert.equal(b.chest, 58);
  assert.equal(b.length, a.length);
  assert.equal(b.sleeve, a.sleeve);
});

test('measurement settings always use centimetres, including older saved inch settings', () => {
  assert.equal(normalizeMeasureState({ size: 'M', unit: 'in' }).unit, 'cm');
  assert.equal(normalizeMeasureState({ size: 'L', unit: 'cm' }).unit, 'cm');
});

test('manufacturer spec is labelled in cm and warns that image-derived values need sample approval', () => {
  const csv = manufacturerSpecCSV({
    kind: 'tee', size: 'M', basis: 'typical T-shirt size M',
    rows: [{ key: 'chest', label: 'Chest width (pit to pit)', cm: 53 }],
  }, { design: 'Test Tee', view: 'front' });
  assert.match(csv, /Target \(cm\)/);
  assert.match(csv, /53/);
  assert.match(csv, /ESTIMATE - verify against a physical sample/);
  assert.match(csv, /Factory actual \(cm\)/);
});


test('front and back calibrate independently to the same shared size chart', () => {
  const front = mockGarment({ chest: 100, length: 150, sleeve: 90, shoulder: 72, hem: 96, neck: 16, neckDrop: 7 });
  const back = mockGarment({ chest: 180, length: 210, sleeve: 130, shoulder: 105, hem: 145, neck: 25, neckDrop: 13 });
  const state = {
    activeView: 'front',
    measure: { size: 'M', kind: 'tee', manual: null },
    views: {
      front: { baseSeg: front, sample: null },
      back: { baseSeg: back, sample: null },
      side: { baseSeg: null, sample: null },
      detail: { baseSeg: null, sample: null },
    },
  };
  const frontCal = designCalibration(state, 'front');
  const backCal = designCalibration(state, 'back');
  const fm = measureGarment(front, frontCal);
  const bm = measureGarment(back, backCal);
  assert.equal(fm.chest, chartValue('tee', 'M', 'chest'));
  assert.equal(bm.chest, chartValue('tee', 'M', 'chest'));
  assert.equal(fm.length, chartValue('tee', 'M', 'length'));
  assert.equal(bm.length, chartValue('tee', 'M', 'length'));
  assert.equal(fm.sleeve, chartValue('tee', 'M', 'sleeve'));
  assert.equal(bm.sleeve, chartValue('tee', 'M', 'sleeve'));
  for (const key of ['shoulder', 'hem', 'neck', 'neckDrop']) {
    const target = chartValue('tee', 'M', key);
    assert.ok(Math.abs(fm[key] - target) < 1e-8, `front ${key} should match the shared size chart`);
    assert.ok(Math.abs(bm[key] - target) < 1e-8, `back ${key} should match the shared size chart`);
  }
});


test('standard POM geometry uses HPS, neck seam and shoulder-to-cuff landmarks', () => {
  const seg = mockGarment({ length: 150, sleeve: 90, neckDrop: 8 });
  const cal = makeCalibration(seg, { kind: 'tee', size: 'M' });
  const m = measureGarment(seg, cal);
  assert.equal(m.length, chartValue('tee', 'M', 'length'));
  assert.equal(m.sleeve, chartValue('tee', 'M', 'sleeve'));
  assert.equal(m.neckDrop, chartValue('tee', 'M', 'neckDrop'));
});

test('front and back edits produce matching centimetre changes from one shared base size', () => {
  const frontBase = mockGarment({ chest: 100, length: 150, sleeve: 90 });
  const backBase = mockGarment({ chest: 180, length: 210, sleeve: 130 });
  const frontEdited = mockGarment({ chest: 110, length: 160, sleeve: 100 });
  const backEdited = mockGarment({ chest: 198, length: 231, sleeve: 143 });
  const frontCal = makeCalibration(frontBase, { kind: 'tee', size: 'M' });
  const backCal = makeCalibration(backBase, { kind: 'tee', size: 'M' });
  const frontBefore = measureGarment(frontBase, frontCal), frontAfter = measureGarment(frontEdited, frontCal);
  const backBefore = measureGarment(backBase, backCal), backAfter = measureGarment(backEdited, backCal);
  for (const key of ['chest', 'length', 'sleeve']) {
    const frontDelta = frontAfter[key] - frontBefore[key];
    const backDelta = backAfter[key] - backBefore[key];
    assert.ok(Math.abs(frontDelta - backDelta) < 1e-8, `front/back ${key} change should stay aligned`);
  }
});


test('side and detail crops do not masquerade as flat garment measurements', () => {
  const front = mockGarment();
  const state = {
    activeView: 'side',
    measure: { size: 'M', kind: 'tee', manual: null },
    views: {
      front: { baseSeg: front, seg: front, sample: null },
      back: { baseSeg: null, seg: null, sample: null },
      side: { baseSeg: front, seg: front, sample: null },
      detail: { baseSeg: front, seg: front, sample: null },
    },
  };
  assert.equal(designMeasure(state, 'side'), null);
  assert.equal(designMeasure(state, 'detail'), null);
});
