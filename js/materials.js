const validHex = value => /^#[0-9a-f]{6}$/i.test(value || '');

/** Normalise one saved fabric record while preserving fields added by future versions. */
export function normalizeMaterial(input, index = 0) {
  const item = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    ...item,
    id: item.id || ('mat-legacy-' + index),
    name: String(item.name || 'Untitled material'),
    type: item.type || 'Other',
    color: validHex(item.color) ? item.color : '#d6d3d1',
    notes: item.notes || '',
    composition: item.composition || '',
    weightGsm: item.weightGsm ?? '',
    widthCm: item.widthCm ?? '',
    supplier: item.supplier || '',
    sku: item.sku || '',
    pricePerMetre: item.pricePerMetre ?? '',
    care: item.care || '',
  };
}

/** Normalise a material library payload; malformed storage becomes an empty library. */
export function normalizeMaterials(value) {
  return Array.isArray(value) ? value.map(normalizeMaterial) : [];
}
