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
