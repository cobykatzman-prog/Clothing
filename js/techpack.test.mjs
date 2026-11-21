import test from 'node:test';
import assert from 'node:assert/strict';
import { chartValue } from './measure.js';
import { POMS, buildSpec, defaultSpecState } from './spec.js';
import {
  defaultTechPack, normalizeTechPack, cloneTechPack, techPackIsEmpty, suggestFor, placementOf, elementLabel, buildTechPack,
  csvBundle, sheetCSV, spreadsheetXML, TP_DISCLAIMER,
} from './techpack.js';

const base = (kind = 'tee') => Object.fromEntries(POMS.map(p => [p.key, { cm: chartValue(kind, 'M', p.measureKey, p.key === 'backNeckDrop' ? 'back' : 'front'), view: 'front' }]));
const spec = (o = {}) => { const t = buildSpec({ kind: 'tee', baseSize: 'M', base: base(), spec: defaultSpecState(), ...o }); return t; };
// a garment 600 px wide, centre line x=512, HPS at y=200, hem at y=800; 0.1 cm per px
const LM = { centerX: 512, shoulderL: { x: 800, y: 200 }, shoulderR: { x: 224, y: 200 }, hemL: { x: 780, y: 800 }, hemR: { x: 244, y: 800 }, neckTop: { x: 512, y: 170 }, neckBottom: { x: 512, y: 260 } };
const el = (o = {}) => ({ id: 'e1', type: 'text', name: 'text', view: 'front', visible: true, x: 512, y: 400, w: 200, h: 100, rotation: 0, props: { text: 'ATHENS', color: '#1f2937' }, ...o });
const model = (o = {}) => buildTechPack({ name: 'Club shirt', designId: 'abc123', kind: 'tee', spec: spec(), cal: { front: { s: 0.1, manual: null, kind: 'tee', size: 'M' }, back: { s: 0.1, manual: null, kind: 'tee', size: 'M' } }, landmarks: { front: LM, back: LM }, elements: [el()], fabrics: [], colours: [{ hex: '#e3dccb', name: 'Cream', share: 0.7 }], now: new Date('2026-11-20T10:00:00Z'), ...o });

test('tech pack state: defaults, normalising, caps and cloning', () => {
  assert.ok(techPackIsEmpty(defaultTechPack()));
  const n = normalizeTechPack({ styleNo: 'S'.repeat(500), rev: { no: '', date: '2026-01-01', author: 'A' }, trims: [{ item: 'Label', evil: 'x' }, { item: '', spec: '' }], stitching: [{ area: 'Hem', s: true }], construction: ['one', { text: 'two', s: true }, ''], production: { notes: 'n' }, junk: 1 });
  assert.equal(n.styleNo.length, 60);
  assert.equal(n.rev.no, '1'); assert.equal(n.rev.author, 'A');
  assert.deepEqual(n.trims, [{ item: 'Label', spec: '', placement: '', qty: '', colour: '', supplier: '' }], 'empty rows dropped, unknown keys ignored');
  assert.equal(n.stitching[0].s, true); assert.equal(n.construction.length, 2); assert.equal(n.construction[1].s, true);
  assert.equal(n.junk, undefined);
  assert.deepEqual(normalizeTechPack(null), defaultTechPack());
  const c = cloneTechPack(n); c.trims[0].item = 'changed'; assert.equal(n.trims[0].item, 'Label');
  assert.equal(normalizeTechPack({ materials: Array.from({ length: 200 }, (_, i) => ({ part: 'p' + i })) }).materials.length, 60);
  assert.deepEqual(normalizeTechPack(JSON.parse(JSON.stringify(n))), n, 'serialising and re-normalising is stable');
});

test('suggested stitching / construction exist for every garment kind and are flagged as suggestions', () => {
  for (const k of ['tee', 'longSleeve', 'polo', 'hoodie', 'unknown']) {
    const s = suggestFor(k);
    assert.ok(s.stitching.length >= 4 && s.construction.length >= 2, k);
    assert.ok(s.stitching.every(r => r.s === true && r.area && r.stitch) && s.construction.every(r => r.s === true && r.text), k);
  }
  assert.ok(suggestFor('polo').stitching.some(r => /Placket/.test(r.area)));
});

test('placement: size, rotation and positioning references come from layer geometry and scale', () => {
  const p = placementOf(el(), LM, 0.1, 'front');
  assert.equal(p.measured, true);
  assert.equal(p.wCm, 20); assert.equal(p.hCm, 10);
  assert.equal(p.fromHps, 15); // top edge y=350, HPS y=200 -> 150 px = 15 cm
  assert.equal(p.fromHem, 35); // bottom edge y=450, hem y=800 -> 35 cm
  assert.equal(p.centreSide, 'centred'); assert.equal(p.fromCentre, 0);
  assert.match(p.text, /15 cm below HPS/); assert.match(p.text, /35 cm above hem/); assert.match(p.text, /centred on centre front/);
  // off centre: image right of centre on the front is the wearer's left; on the back it is the wearer's right
  const f = placementOf(el({ x: 612 }), LM, 0.1, 'front'), b = placementOf(el({ x: 612 }), LM, 0.1, 'back');
  assert.equal(f.fromCentre, 10); assert.equal(f.centreSide, 'left'); assert.equal(b.centreSide, 'right');
  assert.match(b.text, /centre back/);
  // rotation grows the bounding box used for edge distances but keeps the unrotated size
  const r = placementOf(el({ rotation: 90 }), LM, 0.1, 'front');
  assert.equal(r.wCm, 20); assert.equal(r.rotation, 90);
  assert.equal(r.fromHps, 10); // rotated 90 deg: half-height becomes 100 -> top edge y=300 -> 10 cm
  assert.equal(placementOf(el(), LM, null, 'front').measured, false, 'no scale = no dimensions');
  assert.equal(placementOf(el(), null, 0.1, 'front').measured, false);
});

test('element labels never inject markup and read well', () => {
  assert.equal(elementLabel(el({ props: { text: 'A\n  B' } })), 'Text: "A B"');
  assert.match(elementLabel(el({ type: 'crest', props: { graphicId: 'crest-shield' }, name: 'crest' })), /Crest: shield/);
  assert.equal(elementLabel(el({ type: 'stripe', name: 'stripe', props: {} })), 'Stripes');
});

test('model: identifiers, honesty labels and scale source', () => {
  const m = model();
  assert.equal(m.ident.designId, 'abc123'); assert.equal(m.ident.revNo, '1'); assert.equal(m.ident.revDate, '2026-11-20'); assert.equal(m.ident.status, 'Draft');
  assert.equal(m.ident.scaleSource, 'estimated');
  assert.match(m.sheets[0].rows.find(r => r[0] === 'Verification')[1], /NOT production-verified/);
  assert.match(m.disclaimer, /NOT production-verified/);
  assert.equal(m.disclaimer, TP_DISCLAIMER);
  const cal = model({ cal: { front: { s: 0.1, manual: { key: 'chest', cm: 54 }, kind: 'tee', size: 'M' } } });
  assert.equal(cal.ident.scaleSource, 'calibrated');
  assert.equal(cal.placements[0].source, 'calibrated');
  assert.equal(model().placements[0].source, 'estimated');
});

test('model: revision number, date and author come from the pack fields, falling back to identity and history', () => {
  const m = model({ techpack: { rev: { no: '4', date: '2026-10-01', author: 'Ana' }, revisions: [{ no: '3', date: '2026-09-01', author: 'Ben', note: 'Collar' }] }, history: [{ rev: 7, date: '2026-11-01', author: 'Cy', note: 'x', source: 'Shared library revision' }, { rev: '', date: '2026-11-02', note: 'Saved version', source: 'Saved version' }] });
  assert.deepEqual(m.revisions.map(r => r.no), ['4', '3']);
  const rows = m.sheets.find(s => s.key === 'revisions').rows;
  assert.equal(rows.length, 4); assert.equal(rows[0][4], 'This pack'); assert.equal(rows[2][2], 'Cy'); assert.equal(rows[2][0], '7');
  assert.equal(model({ identity: 'Pat' }).ident.revAuthor, 'Pat');
  assert.equal(model({ techpack: { rev: { no: '2', author: 'X' } } }).ident.revAuthor, 'X');
});

test('model: size chart sheet has every POM, size, tolerance range and status label', () => {
  const m = model(), sh = m.sheets.find(s => s.key === 'sizechart');
  assert.equal(sh.rows.length, POMS.length);
  assert.ok(sh.columns.includes('XXL (cm)') && sh.columns.includes('XS min') && sh.columns.includes('M status'));
  assert.ok(sh.rows.every(r => r.slice(-6).every(c => c === 'Estimated')), 'untouched design: all Estimated');
  const man = model({ spec: spec({ spec: { inc: {}, tol: {}, manual: { chest: { L: { cm: 60, at: '2026-11-01' } } } } }) }).sheets.find(s => s.key === 'sizechart');
  assert.equal(man.rows[0][6 + 3], 60); assert.equal(man.rows[0][6 + 18 + 3], 'Manual');
  assert.equal(model({ spec: null }).sheets.some(s => s.key === 'sizechart'), false);
  assert.ok(model({ spec: null }).warnings.some(w => /No measurement spec/.test(w.msg)));
});

test('model: materials, colours and trims are derived from the design, then the user\'s rows, with their origin', () => {
  const els = [el(), el({ id: 'p1', type: 'piping', props: { color: '#6b4423', thickness: 8 } }), el({ id: 's1', type: 'stripe', props: { color: '#6b4423', color2: '#f3e9c6', count: 2 } }), el({ id: 'x', visible: false })];
  const m = model({ elements: els, fabrics: [{ view: 'front', name: 'Cotton jersey' }], techpack: { materials: [{ part: 'Body', composition: '100% cotton', weight: '220' }], trims: [{ item: 'Main label' }] } });
  assert.ok(m.materials[0].material.includes('Cotton jersey') && m.materials[0].auto);
  assert.ok(m.materials.some(x => x.part === 'Piping' && x.auto) && m.materials.some(x => x.part === 'Stripes'));
  assert.equal(m.materials.filter(x => !x.auto).length, 1);
  assert.equal(m.placements.length, 3, 'hidden layers are not listed');
  assert.ok(m.colours.some(c => c.hex === '#6b4423' && c.source === 'Design setting') && m.colours[0].source === 'Read from the picture');
  const tr = m.sheets.find(s => s.key === 'trims').rows;
  assert.ok(tr.some(r => /Piping/.test(r[0]) && r[6] === 'From design') && tr.some(r => r[0] === 'Main label' && r[6] === 'Entered'));
  assert.match(tr.find(r => /Piping/.test(r[0]))[1], /about \d+(\.\d+)? mm/);
});

test('model: artwork on All views lists front and back; side/detail artwork has no invented dimensions', () => {
  const m = model({ elements: [el({ view: 'all' }), el({ id: 'sd', view: 'side' })] });
  assert.deepEqual(m.placements.map(p => p.view), ['front', 'back', 'side']);
  assert.equal(m.placements[2].measured, false);
  const a = m.sheets.find(s => s.key === 'artwork').rows;
  assert.equal(a[2][4], '') ; assert.match(a[2][11], /No flat scale/); assert.equal(a[2][14], 'No value');
  assert.ok(m.warnings.some(w => /side or detail view/.test(w.msg)));
});

test('stitching and construction keep the suggested flag in the sheet', () => {
  const m = model({ techpack: { stitching: [{ area: 'Hem', stitch: 'Coverstitch', s: true }, { area: 'Neck', stitch: 'Flat' }], construction: [{ text: 'Do x', s: true }, { text: 'Do y' }] } });
  assert.deepEqual(m.sheets.find(s => s.key === 'stitching').rows.map(r => r[4]), ['Suggested, confirm', 'Entered']);
  assert.deepEqual(m.sheets.find(s => s.key === 'construction').rows.map(r => r[2]), ['Suggested, confirm', 'Entered']);
});

test('CSV bundle: one file per non-empty section, escaped, with the identifier block and honesty status', () => {
  const m = model({ name: 'A "quoted", name', techpack: { notes: 'line1\nline2', styleNo: 'S-1' } });
  const files = csvBundle(m, 'club');
  const names = files.map(f => f.name);
  assert.ok(names.includes('club-techpack-overview.csv') && names.includes('club-techpack-sizechart.csv') && names.includes('club-techpack-artwork.csv'));
  assert.ok(!names.includes('club-techpack-stitching.csv'), 'empty sections are skipped');
  const ov = files.find(f => /overview/.test(f.name)).text;
  assert.match(ov, /"A ""quoted"", name"/); assert.match(ov, /NOT production-verified/); assert.ok(ov.startsWith('﻿'));
  assert.match(files.find(f => /production/.test(f.name)).text, /"line1\nline2"/);
  assert.ok(sheetCSV(m, m.sheets[0]).includes('\r\n'));
});

test('spreadsheet XML: well-formed multi-sheet workbook, numbers typed, text escaped, unique short sheet names', () => {
  const m = model({ name: 'R&D <shirt>', techpack: { materials: [{ part: 'A', notes: '5 < 6 & "7"' }] } });
  const x = spreadsheetXML(m);
  assert.match(x, /^<\?xml/); assert.match(x, /<Workbook /);
  const names = [...x.matchAll(/<Worksheet ss:Name="([^"]+)"/g)].map(r => r[1]);
  assert.equal(names.length, m.sheets.length); assert.equal(new Set(names.map(n => n.toLowerCase())).size, names.length);
  assert.ok(names.every(n => n.length <= 31));
  assert.ok(x.includes('R&amp;D &lt;shirt&gt;') && x.includes('5 &lt; 6 &amp; &quot;7&quot;'));
  assert.match(x, /<Data ss:Type="Number">5\d(\.\d+)?<\/Data>/);
  assert.ok(!/[\u0000-\u0008]/.test(x));
  // tag balance (cheap well-formedness check without a parser)
  const open = (x.match(/<(Worksheet|Table|Row|Cell|Data|Style|Styles|Workbook)[ >]/g) || []).length, close = (x.match(/<\/(Worksheet|Table|Row|Cell|Data|Style|Styles|Workbook)>/g) || []).length;
  assert.equal(open, close + (x.match(/<Style [^>]*\/>/g) || []).length);
});
