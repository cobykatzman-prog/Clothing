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
