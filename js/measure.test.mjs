import test from 'node:test';
import assert from 'node:assert/strict';
import { chartValue, makeCalibration, measureGarment } from './measure.js';

function mockGarment({ chest = 100, length = 150, sleeve = 90 } = {}) {
  return {
    landmarks: {
      armpitL: { x: 100 + chest / 2, y: 80 },
      armpitR: { x: 100 - chest / 2, y: 80 },
      hemL: { x: 150, y: 180 },
      hemR: { x: 50, y: 180 },
      shoulderL: { x: 140, y: 40 },
      shoulderR: { x: 60, y: 40 },
      neckTop: { x: 100, y: 30 },
      centerX: 100,
      cuffL: { x: 20, y: 120 },
      cuffR: { x: 180, y: 120 },
    },
    metrics: {
      fitScale: 1,
      neckRx: 10,
      neckRy: 8,
      sleeves: {
        L: { has: true, L: sleeve, hw: 10, a: { x: -1, y: 0 }, n: { x: 0, y: 1 } },
        R: { has: true, L: sleeve, hw: 10, a: { x: 1, y: 0 }, n: { x: 0, y: 1 } },
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
