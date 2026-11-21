const DEFAULT_PALETTE = [
  { name: 'Primary', color: '#292820' },
  { name: 'Secondary', color: '#e9e5dc' },
  { name: 'Accent', color: '#a18a68' },
];

/** Pure migration/normalisation for the browser-saved brand kit. */
export function normalizeBrandKit(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const logos = value.logos && typeof value.logos === 'object' && !Array.isArray(value.logos)
    ? { primary: '', alternate: '', mark: '', ...value.logos }
    : { primary: value.logo || '', alternate: '', mark: '' };
  const palette = Array.isArray(value.palette) ? value.palette : DEFAULT_PALETTE.map(x => ({ ...x,
    color: x.name === 'Primary' ? (value.primary || x.color) : x.name === 'Secondary' ? (value.secondary || x.color) : (value.accent || x.color),
  }));
  const typography = value.typography && typeof value.typography === 'object' && !Array.isArray(value.typography)
    ? { heading: 'Georgia', body: 'Arial', ...value.typography }
    : { heading: 'Georgia', body: 'Arial' };
  return { ...value, logos, palette, typography };
}

const BRAND_COLOUR_TYPES = new Set(['text', 'crest', 'graphic', 'stripe', 'piping', 'embroidery', 'print']);
const BRAND_FONT_TYPES = new Set(['text', 'embroidery', 'print']);

/** Build a safe style patch for one selected editable layer. Raster logos are intentionally not recoloured. */
export function brandStylePatch(element, { color = '', font = '' } = {}) {
  if (!element || !element.type) return null;
  const patch = {};
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    if (element.type === 'patch') patch.bg = color;
    else if (BRAND_COLOUR_TYPES.has(element.type)) patch.color = color;
  }
  if (font && BRAND_FONT_TYPES.has(element.type)) patch.font = String(font);
  return Object.keys(patch).length ? patch : null;
}

export const BRAND_FONT_OPTIONS = Object.freeze([
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Verdana', 'Trebuchet MS', 'Courier New',
]);

/** Validate a portable JSON brand kit before replacing the editor's current unsaved values. */
export function sanitizeBrandKitImport(input) {
  const value = normalizeBrandKit(input);
  const logos = {};
  for (const key of ['primary', 'alternate', 'mark']) {
    const data = value.logos?.[key] || '';
    if (data && (typeof data !== 'string'
      || data.length > 1_500_000
      || !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(data))) {
      throw new TypeError('Each imported logo must be a valid PNG, JPG, WebP or SVG data image under 1 MB.');
    }
    logos[key] = data;
  }
  const palette = (Array.isArray(value.palette) ? value.palette : []).slice(0, 12).map((item, index) => ({
    name: String(item?.name || ('Colour ' + (index + 1))).trim().slice(0, 24) || ('Colour ' + (index + 1)),
    color: /^#[0-9a-f]{6}$/i.test(item?.color || '') ? item.color : '#292820',
  }));
  const typography = {
    heading: BRAND_FONT_OPTIONS.includes(value.typography?.heading) ? value.typography.heading : 'Georgia',
    body: BRAND_FONT_OPTIONS.includes(value.typography?.body) ? value.typography.body : 'Arial',
  };
  const name = String(value.name || '').trim().slice(0, 60);
  return { ...value, name, logos, logo: logos.primary, palette, typography };
}
