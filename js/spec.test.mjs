import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZES, chartValue } from './measure.js';
import { POMS, buildSpec, defaultSpecState, normalizeSpecState, chartSteps, effectiveSteps, specCSV, scaleBar, scaleInfo, hasManual } from './spec.js';

const base = (kind = 'tee', size = 'M') => Object.fromEntries(POMS.map(p => [p.key, { cm: chartValue(kind, size, p.measureKey, p.key === 'backNeckDrop' ? 'back' : 'front'), view: 'front' }]));
const build = (o = {}) => buildSpec({ kind: 'tee', baseSize: 'M', base: base(), spec: defaultSpecState(), ...o });

test('POM catalogue: unique codes/keys, every POM has a view and plausible default tolerance', () => {
  assert.equal(new Set(POMS.map(p => p.code)).size, POMS.length);
  assert.equal(new Set(POMS.map(p => p.key)).size, POMS.length);
  for (const p of POMS) { assert.ok(p.views.length && p.tol > 0 && p.how && p.name, p.key); assert.match(p.code, /^POM-\d\d$/); }
  assert.deepEqual(POMS.find(p => p.key === 'neckDrop').views, ['front']);
  assert.deepEqual(POMS.find(p => p.key === 'backNeckDrop').views, ['back']);
});

test('default grading reproduces the size chart for every garment and size (graded from the M base)', () => {
  for (const kind of ['tee', 'longSleeve', 'polo', 'hoodie']) {
    const t = buildSpec({ kind, baseSize: 'M', base: base(kind), spec: defaultSpecState() });
    for (const r of t.rows) for (const sz of SIZES) {
      const want = chartValue(kind, sz, POMS.find(p => p.key === r.key).measureKey, r.key === 'backNeckDrop' ? 'back' : 'front');
      assert.ok(Math.abs(r.cells[sz].cm - want) < 0.011, `${kind} ${r.key} ${sz}`);
    }
  }
});

test('grading follows the base: another base size, or a changed drawing, moves every size', () => {
  const a = build();
  const b = build({ base: { ...base(), chest: { cm: 60, view: 'front' } } });
  const d = b.rows[0].cells.M.cm - a.rows[0].cells.M.cm;
  assert.equal(d, 60 - 53);
  assert.ok(Math.abs(b.rows[0].cells.XL.cm - a.rows[0].cells.XL.cm - d) < 0.011);
  const c = buildSpec({ kind: 'tee', baseSize: 'L', base: base('tee', 'L'), spec: defaultSpecState() });
  assert.equal(c.rows[0].cells.M.cm, 53);
  assert.equal(c.rows[0].cells.L.source, 'estimated');
});

test('configurable grading increment replaces the chart steps for one POM only', () => {
  const spec = normalizeSpecState({ inc: { chest: 4 } });
  const t = build({ spec });
  const chest = t.rows.find(r => r.key === 'chest').cells, length = t.rows.find(r => r.key === 'length').cells;
  assert.deepEqual(SIZES.map(s => chest[s].cm), [45, 49, 53, 57, 61, 65]);
  assert.equal(length.XL.cm, 74);
  assert.deepEqual(effectiveSteps('tee', 'chest', spec), [4, 4, 4, 4, 4]);
  assert.deepEqual(chartSteps('tee', 'chest'), [3, 3, 3, 3, 3]);
});

test('sources: calibrated only on the calibrated POM at base size, manual replaces one cell, rest estimated', () => {
  const spec = normalizeSpecState({ manual: { length: { L: { cm: 75.5, at: '2026-01-02T00:00:00Z' } } } });
  const t = build({ spec, calibratedKey: 'chest' });
  const by = k => t.rows.find(r => r.key === k).cells;
  assert.equal(by('chest').M.source, 'calibrated');
  assert.equal(by('chest').L.source, 'estimated');          // graded from a calibrated base is still an estimate
  assert.equal(by('length').L.source, 'manual');
  assert.equal(by('length').L.cm, 75.5);
  assert.equal(by('length').M.source, 'estimated');
  assert.equal(by('length').XL.cm, 74);                      // other sizes still follow the base, not the typed cell
  assert.match(by('length').L.note, /Typed in on 2026-01-02/);
  assert.equal(t.rows.find(r => r.key === 'backNeckDrop').base.source, 'estimated');
  assert.ok(t.counts.estimated > 0 && t.counts.manual === 1 && t.baseCounts.calibrated === 1);
});

test('manual base-size entry anchors the grading and is flagged when the drawing disagrees', () => {
  const spec = normalizeSpecState({ manual: { chest: { M: { cm: 58, at: '' } } } });
  const t = build({ spec });
  const c = t.rows[0].cells;
  assert.equal(c.M.source, 'manual'); assert.equal(c.L.cm, 61);
  assert.ok(t.warnings.some(w => w.key === 'chest' && /drawing now measures 53/.test(w.msg)), 'manual vs drawing');
  const ok = build({ spec: normalizeSpecState({ manual: { chest: { M: { cm: 53.5, at: '' } } } }) });
  assert.ok(!ok.warnings.some(w => /drawing now measures/.test(w.msg)));
});

test('tolerances: defaults, overrides, min/max, and tolerance sanity warnings', () => {
  const t = build({ spec: normalizeSpecState({ tol: { chest: 2, hem: 0 } }) });
  const chest = t.rows[0];
  assert.equal(chest.tol, 2); assert.equal(chest.cells.M.min, 51); assert.equal(chest.cells.M.max, 55);
  assert.equal(t.rows.find(r => r.key === 'neck').tol, 0.5);
  assert.ok(t.warnings.some(w => w.key === 'hem' && /tolerance is 0/.test(w.msg)));
  assert.ok(build({ spec: normalizeSpecState({ tol: { neck: 9 } }) }).warnings.some(w => w.key === 'neck' && /20% of the value/.test(w.msg)));
});

test('validation: shrinking sizes, implausible values, neck wider than shoulders, uneven front/back', () => {
  const dec = build({ spec: normalizeSpecState({ inc: { chest: -3 } }) });
  assert.ok(dec.warnings.some(w => w.level === 'error' && w.key === 'chest' && /smaller than/.test(w.msg)));
  const range = build({ spec: normalizeSpecState({ manual: { chest: { XL: { cm: 150, at: '' } } } }) });
  assert.ok(range.warnings.some(w => w.key === 'chest' && /outside the usual/.test(w.msg)));
  const neck = build({ spec: normalizeSpecState({ manual: { neck: { S: { cm: 44, at: '' } } } }) });
  assert.ok(neck.warnings.some(w => w.level === 'error' && w.key === 'neck'));
  const fb = build({ views: { front: { chest: 53 }, back: { chest: 58 } } });
  assert.ok(fb.warnings.some(w => w.key === 'chest' && /front view reads 53 cm and back view 58 cm/.test(w.msg)));
  assert.ok(!build({ views: { front: { chest: 53 }, back: { chest: 53.5 } } }).warnings.some(w => /back view/.test(w.msg)));
});

test('a clean spec still carries the estimate note; missing POMs yield no value and a note', () => {
  const b = base(); delete b.sleeve; delete b.sleeveOpening;
  const t = buildSpec({ kind: 'tee', baseSize: 'M', base: b, spec: defaultSpecState(), views: { front: {} } });
  assert.equal(t.rows.find(r => r.key === 'sleeve').base.source, 'missing');
  assert.ok(t.warnings.some(w => w.key === 'sleeve' && w.level === 'note'));
  assert.ok(t.warnings.some(w => /not production-verified/.test(w.msg)));
  assert.equal(t.counts.total, POMS.length * SIZES.length);
});

test('normalizeSpecState drops junk, clamps values, keeps valid entries; round-trips through JSON', () => {
  const n = normalizeSpecState({ inc: { chest: 3, nope: 4, hem: 99, neck: 'x' }, tol: { chest: -1, hem: 2 }, manual: { chest: { M: { cm: 54, at: '2026-02-03' }, Q: { cm: 5 }, S: { cm: -3 } }, bogus: { M: { cm: 3 } } } });
  assert.deepEqual(n.inc, { chest: 3 }); assert.deepEqual(n.tol, { hem: 2 });
  assert.deepEqual(Object.keys(n.manual), ['chest']); assert.deepEqual(Object.keys(n.manual.chest), ['M']);
  assert.deepEqual(normalizeSpecState(JSON.parse(JSON.stringify(n))), n);
  assert.deepEqual(normalizeSpecState(null), defaultSpecState());
  assert.ok(hasManual(n) && !hasManual(defaultSpecState()));
});

test('spec CSV: header, labelled status per size, tolerances, checks and the not-verified disclaimer', () => {
  const t = build({ spec: normalizeSpecState({ manual: { chest: { L: { cm: 57, at: '' } } } }), calibratedKey: 'length' });
  t.cal = { s: 0.2, kind: 'tee', size: 'M', manual: { key: 'length', cm: 70 } };
  const csv = specCSV(t, { design: 'Test, "style"' });
  const lines = csv.trim().split('\r\n');
  assert.match(lines[1], /^Style,"Test, ""style"""$/);
  assert.ok(csv.includes('Scale,Scale calibrated'));
  const head = lines.find(l => l.startsWith('POM code'));
  for (const h of ['Tolerance +/- (cm)', 'XS (cm)', 'XXL min', 'L max', 'M status', 'Trace']) assert.ok(head.includes(h), h);
  const chestRow = lines.find(l => l.startsWith('POM-01'));
  assert.ok(chestRow.includes('Manual') && chestRow.includes('Estimated'));
  assert.ok(lines.find(l => l.startsWith('POM-02')).includes('Calibrated'));
  assert.equal(lines.filter(l => /^POM-\d\d,/.test(l)).length, 9);
  assert.ok(csv.includes('not verified any value for production'));
  assert.throws(() => specCSV(null), TypeError);
});

test('scale info and scale bar are consistent with the calibration', () => {
  const cal = { s: 0.05, kind: 'tee', size: 'M', manual: null };
  const si = scaleInfo(cal); assert.equal(si.pxPerCm, 20); assert.equal(si.calibrated, false);
  const bar = scaleBar(cal); assert.equal(bar.cm, 10); assert.equal(bar.w, 200); assert.match(bar.label, /estimated/);
  const cb = scaleBar({ ...cal, manual: { key: 'chest', cm: 54 } }); assert.match(cb.label, /calibrated/);
  assert.equal(scaleInfo({ s: 0 }), null);
});
