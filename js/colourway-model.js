// Threadform - colourways (roadmap v2 phase 7): pure data model, no DOM, runs in the browser and in Node tests.
// A design has ONE garment structure (shape sliders, artwork positions, views) and any number of colourways.
// A colourway only holds what may differ between versions of the same garment: colours, fabrics, material notes.
// It never stores pictures: the pictures are re-rendered from the shared base, so the saved document stays tiny
// (the shared-workspace server caps a document at 1.5 MB; see MAX_COLOURWAYS / limits below).

export const MAX_COLOURWAYS = 12;
const MAX_NOTE = 1500, MAX_NAME = 60, MAX_FIELD = 120;
export const VIEW_IDS = ['front', 'back', 'side', 'detail'];

/** Garment sections that can carry their own colour, fabric and material (same ids as the segmentation regions). */
export const SECTION_LABELS = {
  body: 'Body', leftSleeve: 'Left sleeve', rightSleeve: 'Right sleeve', shoulders: 'Shoulders', collar: 'Collar', neckline: 'Neckline',
  cuffs: 'Cuffs', hem: 'Hem', sidePanels: 'Side panels', stripes: 'Stripes', logos: 'Logos', text: 'Lettering',
};
export const SECTION_IDS = Object.keys(SECTION_LABELS);

/** Fabric appearances the procedural renderer knows (fabric.js FABRICS), with the labels people see. */
export const FABRIC_CHOICES = [
  ['cotton', 'Cotton'], ['heavyweightCotton', 'Heavy cotton'], ['linen', 'Linen'], ['denim', 'Denim'], ['silk', 'Silk'], ['satin', 'Satin / polyester sheen'],
  ['wool', 'Wool'], ['knit', 'Knit / rib'], ['corduroy', 'Corduroy'], ['leather', 'Leather'],
];
const FABRIC_IDS = new Set(FABRIC_CHOICES.map(f => f[0]));

/** Which procedural weave best matches a library material type (the weave is an appearance only, not a simulation). */
export function fabricForMaterial(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('denim')) return 'denim';
  if (t.includes('linen')) return 'linen';
  if (t.includes('wool')) return 'wool';
  if (t.includes('silk')) return 'silk';
  if (t.includes('leather')) return 'leather';
  if (t.includes('corduroy')) return 'corduroy';
  if (/(rib|jersey|terry|knit)/.test(t)) return 'knit';
  if (/(polyester|nylon|mesh)/.test(t)) return 'satin';
  if (/(fleece)/.test(t)) return 'heavyweightCotton';
  if (t.includes('cotton')) return 'cotton';
  return 'cotton';
}

const HEX = /^#[0-9a-f]{6}$/i;
const str = (v, max) => String(v ?? '').slice(0, max);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const newColourwayId = () => 'cw' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** The few library fields a design keeps about a material (a snapshot: later library edits do not change old designs). */
export function materialSnapshot(m) {
  if (!m || typeof m !== 'object') return null;
  const o = { id: str(m.id, 80), name: str(m.name || 'Material', MAX_FIELD), type: str(m.type || 'Other', 40), color: HEX.test(m.color || '') ? m.color : '#d6d3d1' };
  for (const k of ['composition', 'supplier', 'sku', 'care', 'notes']) if (m[k]) o[k] = str(m[k], k === 'notes' ? 400 : MAX_FIELD);
  for (const k of ['weightGsm', 'widthCm', 'pricePerMetre']) if (m[k] !== '' && m[k] != null && Number.isFinite(Number(m[k]))) o[k] = Number(m[k]);
  return o;
}

const COLOUR_KEYS = ['color', 'color2', 'color3', 'bg', 'border', 'textColor'];
/** Colour props of one layer element (stripes, piping, text, graphics, patches). Logos have none. */
export function elementColours(el) {
  const out = {};
  for (const k of COLOUR_KEYS) if (el?.props && HEX.test(el.props[k] || '')) out[k] = el.props[k].toLowerCase();
  return out;
}
/** Colour overrides of every element: { [elementId]: {color,...} }. */
export function captureElementColours(elements) {
  const out = {};
  for (const el of elements || []) { const c = elementColours(el); if (Object.keys(c).length) out[el.id] = c; }
  return out;
}

const cleanFabric = f => (f && typeof f === 'object' ? { name: FABRIC_IDS.has(f.name) ? f.name : null, amount: num(f.amount, 0, 1, 0.6),
  tint: HEX.test(f.tint || '') ? f.tint : null, tintAmount: num(f.tintAmount, 0, 1, 0.5) } : { name: null, amount: 0.6, tint: null, tintAmount: 0.5 });
const cleanColor = c => ({ hue: num(c?.hue, -180, 180, 0), sat: num(c?.sat, -100, 100, 0), light: num(c?.light, -100, 100, 0), tint: HEX.test(c?.tint || '') ? c.tint : null, tintAmount: num(c?.tintAmount, 0, 1, 0.5) });
function cleanParts(parts) {
  const out = {};
  for (const id of SECTION_IDS) {
    const p = parts?.[id]; if (!p || typeof p !== 'object') continue;
    const e = { hue: num(p.hue, -180, 180, 0), sat: num(p.sat, -100, 100, 0), light: num(p.light, -100, 100, 0) };
    if (HEX.test(p.color || '')) e.color = p.color.toLowerCase();
    if (p.fabric && FABRIC_IDS.has(p.fabric.name)) e.fabric = { name: p.fabric.name, amount: num(p.fabric.amount, 0, 1, 0.6) };
    if (e.color || e.fabric) out[id] = e;
  }
  return out;
}
/** What one view looks like in a colourway (never the shape: that is shared by every colourway). */
export function cleanAppearance(a) { return { color: cleanColor(a?.color), fabric: cleanFabric(a?.fabric), parts: cleanParts(a?.parts) }; }
/** Appearance of a live studio view ({color, fabric, parts}). */
export const appearanceOfView = v => cleanAppearance(clone({ color: v?.color, fabric: v?.fabric, parts: v?.parts }));

function cleanSections(s) {
  const out = {};
  for (const id of SECTION_IDS) {
    const x = s?.[id]; if (!x || typeof x !== 'object') continue;
    const e = {};
    const m = materialSnapshot(x.material); if (m) e.material = m;
    if (x.note) e.note = str(x.note, 400);
    if (x.supplier) e.supplier = str(x.supplier, MAX_FIELD);
    if (Object.keys(e).length) out[id] = e;
  }
  return out;
}
function cleanElements(e) {
  const out = {};
  for (const [id, c] of Object.entries(e && typeof e === 'object' ? e : {})) {
    const k = {}; for (const key of COLOUR_KEYS) if (HEX.test(c?.[key] || '')) k[key] = c[key].toLowerCase();
    if (Object.keys(k).length) out[str(id, 80)] = k;
  }
  return out;
}

/** One colourway record from untrusted data (a saved document, a shared copy). Unknown fields are dropped. */
export function normalizeColourway(input, index = 0) {
  const c = input && typeof input === 'object' ? input : {};
  const views = {};
  for (const v of VIEW_IDS) if (c.views?.[v]) views[v] = cleanAppearance(c.views[v]);
  return {
    id: str(c.id || ('cw-legacy-' + index), 60), name: str(c.name || 'Colourway ' + (index + 1), MAX_NAME).trim() || 'Colourway ' + (index + 1),
    parent: c.parent ? str(c.parent, 60) : null, notes: str(c.notes, MAX_NOTE), supplierNotes: str(c.supplierNotes, MAX_NOTE),
    created: Number(c.created) || 0, views, elements: cleanElements(c.elements), sections: cleanSections(c.sections),
  };
}
/** { list, activeId } from a saved document (missing / malformed becomes the empty set). */
export function normalizeColourways(doc) {
  const list = (Array.isArray(doc?.list) ? doc.list : []).slice(0, MAX_COLOURWAYS).map(normalizeColourway);
  const seen = new Set();
  for (const c of list) { while (seen.has(c.id)) c.id += 'x'; seen.add(c.id); }
  return { list, activeId: list.some(c => c.id === doc?.activeId) ? doc.activeId : (list[0]?.id ?? null) };
}
export const emptyColourways = () => ({ list: [], activeId: null });
export const colourwaysDoc = cw => ({ list: (cw?.list || []).map(c => clone(c)), activeId: cw?.activeId ?? null });

/** New colourway from a captured look: { views: {front: appearance}, elements, sections }. */
export function makeColourway({ name, views = {}, elements = {}, sections = {}, notes = '', supplierNotes = '', parent = null, id } = {}, index = 0) {
  return normalizeColourway({ id: id || newColourwayId(), name, views, elements, sections, notes, supplierNotes, parent, created: Date.now() }, index);
}
/** A branch: same look and notes under a new name and id; remembers where it came from. */
export function branchColourway(src, name) {
  const c = normalizeColourway(clone(src));
  return { ...c, id: newColourwayId(), name: str(name || (src.name + ' (branch)'), MAX_NAME), parent: src.id, created: Date.now() };
}
export function uniqueName(list, base) {
  const names = new Set(list.map(c => c.name)); if (!names.has(base)) return base;
  for (let i = 2; i < 200; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  return base + ' ' + Date.now();
}

/** Display colour of a section in one colourway (its own colour, else the whole-garment tint, else null). */
export function sectionColour(cw, view, id) {
  const a = cw?.views?.[view] || cw?.views?.front;
  return a?.parts?.[id]?.color || null;
}
/** Rows for the compare table and the spec CSV: one per section that differs from plain in at least one colourway. */
export function specRows(colourways, view = 'front') {
  const rows = [];
  for (const id of SECTION_IDS) {
    const cells = colourways.map(cw => {
      const a = cw.views?.[view] || cw.views?.front, p = a?.parts?.[id], s = cw.sections?.[id];
      return { colour: p?.color || '', fabric: p?.fabric?.name || '', amount: p?.fabric?.amount ?? null, material: s?.material?.name || '', supplier: s?.supplier || s?.material?.supplier || '', sku: s?.material?.sku || '', note: s?.note || '' };
    });
    if (cells.some(c => c.colour || c.fabric || c.material || c.note || c.supplier)) rows.push({ id, label: SECTION_LABELS[id], cells });
  }
  return rows;
}
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
/** Materials and colour specification of the chosen colourways as CSV text (one row per colourway and section). */
export function specCsv(colourways, designName = '', view = 'front') {
  const out = [['Design', 'Colourway', 'Section', 'Colour', 'Fabric appearance', 'Fabric strength %', 'Material', 'Composition', 'Weight gsm', 'Supplier', 'SKU', 'Section note'].map(csvCell).join(',')];
  for (const cw of colourways) {
    const a = cw.views?.[view] || cw.views?.front;
    for (const id of SECTION_IDS) {
      const p = a?.parts?.[id], s = cw.sections?.[id];
      if (!p && !s) continue;
      const m = s?.material || {};
      out.push([designName, cw.name, SECTION_LABELS[id], p?.color || '', p?.fabric?.name || '', p?.fabric ? Math.round(p.fabric.amount * 100) : '', m.name || '', m.composition || '', m.weightGsm ?? '', s?.supplier || m.supplier || '', m.sku || '', s?.note || ''].map(csvCell).join(','));
    }
    if (cw.notes) out.push([designName, cw.name, '(colourway notes)', '', '', '', '', '', '', '', '', cw.notes].map(csvCell).join(','));
    if (cw.supplierNotes) out.push([designName, cw.name, '(supplier notes)', '', '', '', '', '', '', '', '', cw.supplierNotes].map(csvCell).join(','));
  }
  return out.join('\n') + '\n';
}
export const safeFileName = s => String(s || 'colourway').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'colourway';
