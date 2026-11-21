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


test('brand palette applies to editable layers using their correct colour property', async () => {
  const { brandStylePatch } = await import('./brand-kit.js');
  assert.deepEqual(brandStylePatch({ type: 'text' }, { color: '#123456' }), { color: '#123456' });
  assert.deepEqual(brandStylePatch({ type: 'patch' }, { color: '#123456' }), { bg: '#123456' });
  assert.deepEqual(brandStylePatch({ type: 'stripe' }, { color: '#123456' }), { color: '#123456' });
});

test('brand typography applies to text-like layers but not logos or graphics', async () => {
  const { brandStylePatch } = await import('./brand-kit.js');
  assert.deepEqual(brandStylePatch({ type: 'text' }, { font: 'Georgia, serif' }), { font: 'Georgia, serif' });
  assert.deepEqual(brandStylePatch({ type: 'embroidery' }, { font: 'Arial, sans-serif' }), { font: 'Arial, sans-serif' });
  assert.equal(brandStylePatch({ type: 'logo' }, { color: '#123456', font: 'Georgia' }), null);
  assert.equal(brandStylePatch({ type: 'graphic' }, { font: 'Georgia' }), null);
});


test('portable brand kit import validates logos and limits palette size', async () => {
  const { sanitizeBrandKitImport } = await import('./brand-kit.js');
  const input = {
    name: 'Club identity',
    logos: { primary: 'data:image/png;base64,aGVsbG8=', alternate: '', mark: '' },
    palette: Array.from({ length: 14 }, (_, i) => ({ name: 'Colour ' + i, color: '#123456' })),
    typography: { heading: 'Verdana', body: 'Arial' },
  };
  const kit = sanitizeBrandKitImport(input);
  assert.equal(kit.name, 'Club identity');
  assert.equal(kit.logos.primary, input.logos.primary);
  assert.equal(kit.palette.length, 12);
  assert.deepEqual(kit.typography, input.typography);
});

test('portable brand kit import rejects unsafe or unsupported logo data', async () => {
  const { sanitizeBrandKitImport } = await import('./brand-kit.js');
  assert.throws(() => sanitizeBrandKitImport({ logos: { primary: 'https://example.com/logo.png' } }), /valid PNG, JPG, WebP or SVG/);
  assert.throws(() => sanitizeBrandKitImport({ logos: { mark: 'data:image/gif;base64,R0lGODlh' } }), /valid PNG, JPG, WebP or SVG/);
});

test('portable brand kit import defaults unsupported fonts safely', async () => {
  const { sanitizeBrandKitImport } = await import('./brand-kit.js');
  const kit = sanitizeBrandKitImport({ typography: { heading: 'url(javascript:alert(1))', body: 'Arial' } });
  assert.deepEqual(kit.typography, { heading: 'Georgia', body: 'Arial' });
});
