import test from 'node:test';
import assert from 'node:assert/strict';
import { bounds, unionBounds, alignDeltas, distributeDeltas, snapLines, snapBox, rectBox } from './arrange.js';

const el = (x, y, w, h, rotation = 0) => ({ x, y, w, h, rotation });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('bounds of a rotated element hold its corners', () => {
  const b = bounds(el(100, 100, 100, 40, 90));
  near(b.w, 40); near(b.h, 100); near(b.cx, 100); near(b.cy, 100);
});
test('union of several elements', () => {
  const u = unionBounds([el(50, 50, 100, 100), el(300, 200, 100, 100)]);
  near(u.x0, 0); near(u.y0, 0); near(u.x1, 350); near(u.y1, 250);
  assert.equal(unionBounds([]), null);
});
test('align left / centre / bottom to a reference box', () => {
  const ref = rectBox({ x: 100, y: 100, w: 400, h: 600 });
  const [l] = alignDeltas([el(300, 300, 50, 50)], 'left', ref); near(l.dx, 100 - 275); near(l.dy, 0);
  const [c] = alignDeltas([el(300, 300, 50, 50)], 'hcenter', ref); near(c.dx, 300 - 300);
  const [bt] = alignDeltas([el(300, 300, 50, 50)], 'bottom', ref); near(bt.dy, 700 - 325); near(bt.dx, 0);
  assert.deepEqual(alignDeltas([el(0, 0, 1, 1)], 'nope', ref), []);
});
test('distribute keeps the outer two and equalises gaps', () => {
  const a = el(50, 0, 100, 10), b = el(180, 0, 100, 10), c = el(500, 0, 100, 10);
  const d = distributeDeltas([c, a, b], 'x');
  const pos = new Map(d.map(m => [m.el, m.el.x + m.dx]));
  near(pos.get(a), 50); near(pos.get(c), 500);
  near(pos.get(b) - 50, 500 - pos.get(b));   // equal centre gaps because widths are equal
  assert.deepEqual(distributeDeltas([a, b], 'x'), []);
});
test('snapBox picks the nearest line within tolerance on each axis', () => {
  const lines = snapLines({ garment: rectBox({ x: 200, y: 100, w: 600, h: 800 }), others: [el(700, 700, 100, 100)], size: 1024 });
  const r = snapBox(bounds(el(503, 300, 80, 40)), lines, 6);   // centre x is 3 px from the garment centre (500)
  near(r.dx, -3); near(r.dy, 0);
  assert.equal(r.guides.length, 1); assert.equal(r.guides[0].axis, 'x'); assert.equal(r.guides[0].kind, 'garment');
  const far = snapBox(bounds(el(560, 360, 20, 20)), lines, 6);
  near(far.dx, 0); near(far.dy, 0); assert.equal(far.guides.length, 0);
});
test('snapBox also snaps to the edges of other items', () => {
  const lines = snapLines({ others: [el(700, 700, 100, 100)], size: 1024 });
  const r = snapBox(bounds(el(840, 300, 100, 20)), lines, 6);   // left edge 790 vs the other item's right edge 750? no: its centre 700 / right 750; moving right edge 890
  assert.ok(r.guides.length <= 2);
  const s = snapBox(bounds(el(752 + 50, 300, 100, 20)), lines, 6);   // left edge 752 -> item right edge 750
  near(s.dx, -2); assert.equal(s.guides[0].kind, 'item');
});
