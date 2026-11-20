import test from 'node:test';
import assert from 'node:assert/strict';
import { ElementLayer, hitTest } from './elements.js';

const layer = (id, props = {}) => Object.assign(new ElementLayer('logo'), {
  id, x: 100, y: 100, w: 80, h: 60, view: 'front', ...props,
});

test('hit testing ignores hidden layers so artwork below remains selectable', () => {
  const hidden = layer('hidden', { visible: false });
  const visible = layer('visible');
  assert.equal(hitTest([visible, hidden], 'front', 100, 100)?.element, visible);
});

test('hit testing ignores fully transparent layers', () => {
  const transparent = layer('transparent', { opacity: 0 });
  const visible = layer('visible');
  assert.equal(hitTest([visible, transparent], 'front', 100, 100)?.element, visible);
});

test('hit testing ignores layers belonging to another garment view', () => {
  const back = layer('back', { view: 'back' });
  const front = layer('front');
  assert.equal(hitTest([front, back], 'front', 100, 100)?.element, front);
});

test('topmost visible layer is selected first', () => {
  const bottom = layer('bottom');
  const top = layer('top');
  assert.equal(hitTest([bottom, top], 'front', 100, 100)?.element, top);
});

test('locked layers remain selectable but do not expose transform handles', () => {
  const locked = layer('locked', { locked: true });
  assert.equal(hitTest([locked], 'front', 100, 100)?.element, locked);
  assert.equal(hitTest([locked], 'front', 100, 100, { selectedId: 'locked' })?.handle, 'move');
});


test('element clones isolate nested editable properties but retain image object references', () => {
  class ImageAsset {}
  const image = new ImageAsset();
  const source = Object.assign(new ElementLayer('logo', {
    image,
    shadow: { on: true, color: '#123456', offset: { x: 3, y: 4 } },
    colors: { primary: '#112233', accents: ['#445566', '#778899'] },
  }), { id: 'source', base: { w: 80, h: 60, size: undefined } });
  const copy = source.clone();

  assert.notEqual(copy.props.shadow, source.props.shadow);
  assert.notEqual(copy.props.shadow.offset, source.props.shadow.offset);
  assert.notEqual(copy.props.colors, source.props.colors);
  assert.notEqual(copy.props.colors.accents, source.props.colors.accents);
  assert.equal(copy.props.image, image);

  copy.props.shadow.offset.x = 99;
  copy.props.colors.accents[0] = '#ffffff';
  assert.equal(source.props.shadow.offset.x, 3);
  assert.equal(source.props.colors.accents[0], '#445566');
});

test('element JSON round-trip preserves geometry, view flags and nested styling', () => {
  const source = Object.assign(new ElementLayer('text', {
    text: 'CLUB',
    shadow: { on: true, color: '#000000', offset: { x: 2, y: 5 } },
    colors: { primary: '#123456' },
  }), {
    id: 'saved-layer', x: 210, y: 330, w: 180, h: 72, rotation: 27,
    view: 'back', visible: false, locked: true, opacity: 0.65,
    name: 'Back title', base: { w: 160, h: 64, size: 54 }, flipX: true, flipY: false,
  });

  const restored = ElementLayer.fromJSON(source.toJSON());
  assert.equal(restored.id, source.id);
  assert.equal(restored.x, source.x);
  assert.equal(restored.y, source.y);
  assert.equal(restored.w, source.w);
  assert.equal(restored.h, source.h);
  assert.equal(restored.rotation, source.rotation);
  assert.equal(restored.view, 'back');
  assert.equal(restored.visible, false);
  assert.equal(restored.locked, true);
  assert.equal(restored.opacity, 0.65);
  assert.deepEqual(restored.base, source.base);
  assert.equal(restored.flipX, true);
  assert.deepEqual(restored.props, source.props);
});

test('move drag changes position without changing scale or rotation', async () => {
  const { beginDrag, dragTo } = await import('./elements.js');
  const el = layer('move', { x: 120, y: 160, w: 90, h: 40, rotation: 12 });
  const d = beginDrag(el, 'move', 130, 170);
  dragTo(d, 155, 145);
  assert.deepEqual([el.x, el.y, el.w, el.h, el.rotation], [145, 135, 90, 40, 12]);
});

test('corner drag scales an element proportionally around its centre', async () => {
  const { beginDrag, dragTo } = await import('./elements.js');
  const el = layer('scale', { x: 100, y: 100, w: 80, h: 60 });
  const d = beginDrag(el, 'scale-se', 140, 130);
  dragTo(d, 160, 145);
  const factor = Math.hypot(60, 45) / 50;
  assert.ok(Math.abs(el.w - 80 * factor) < 1e-8);
  assert.ok(Math.abs(el.h - 60 * factor) < 1e-8);
  assert.equal(el.x, 100);
  assert.equal(el.y, 100);
});

test('rotation handle and rotated-corner hit testing use the transformed geometry', async () => {
  const { handlesFor, rotateElementTo } = await import('./elements.js');
  const el = layer('rotated', { x: 100, y: 100, w: 80, h: 60, rotation: 90 });
  const corner = handlesFor(el)['scale-se'];
  assert.deepEqual(corner, { x: 70, y: 140 });
  assert.equal(hitTest([el], 'front', corner.x, corner.y, { selectedId: el.id, handleSize: 2 })?.handle, 'scale-se');
  rotateElementTo(el, 200, 100, 15);
  assert.equal(el.rotation, 90);
});

test('copying an editable layer to another view preserves style without sharing nested objects', async () => {
  const { copyToView } = await import('./elements.js');
  const source = layer('front-logo', {
    props: { shadow: { on: true, color: '#abcdef' }, colors: { primary: '#123456' } },
    locked: true, name: 'Club logo',
  });
  const copy = copyToView(source, 'back');
  assert.equal(copy.view, 'back');
  assert.equal(copy.locked, false);
  assert.equal(copy.name, 'Club logo');
  assert.notEqual(copy.id, source.id);
  assert.deepEqual(copy.props, source.props);
  copy.props.shadow.color = '#000000';
  assert.equal(source.props.shadow.color, '#abcdef');
});
