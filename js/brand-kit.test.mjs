import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrandKit } from './brand-kit.js';

test('legacy single-logo brand kit migrates without losing its name or colours', () => {
  const kit = normalizeBrandKit({ name: 'Clubwear', logo: 'data:image/png;base64,abc', primary: '#112233', secondary: '#223344', accent: '#334455' });
  assert.equal(kit.name, 'Clubwear');
  assert.equal(kit.logos.primary, 'data:image/png;base64,abc');
  assert.equal(kit.logos.alternate, '');
  assert.deepEqual(kit.palette.map(x => x.color), ['#112233', '#223344', '#334455']);
  assert.deepEqual(kit.typography, { heading: 'Georgia', body: 'Arial' });
});

test('modern brand kit keeps logo variants, named palette and typography', () => {
  const input = { logos: { primary: 'p', alternate: 'a', mark: 'm' }, palette: [{ name: 'Club navy', color: '#010203' }], typography: { heading: 'Verdana', body: 'Arial' } };
  const kit = normalizeBrandKit(input);
  assert.deepEqual(kit.logos, input.logos);
  assert.deepEqual(kit.palette, input.palette);
  assert.deepEqual(kit.typography, input.typography);
  assert.deepEqual(input.logos, { primary: 'p', alternate: 'a', mark: 'm' });
});

test('invalid brand kit payloads return safe defaults', () => {
  const kit = normalizeBrandKit(null);
  assert.deepEqual(kit.logos, { primary: '', alternate: '', mark: '' });
  assert.equal(kit.palette.length, 3);
  assert.deepEqual(kit.typography, { heading: 'Georgia', body: 'Arial' });
});
