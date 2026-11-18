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
