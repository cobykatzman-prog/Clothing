// Threadform - technical pack model (roadmap v2 phase 5). Pure logic, no DOM and no state import: the caller passes in
// what the design already holds (spec table, element layers, landmarks, scale, colours, history) and gets back one
// model that the print layout (ui-techpack.js), the CSV bundle and the multi-sheet spreadsheet all render from.
//
// HONESTY: nothing here is production-verified. Sizes carry their calibrated / manual / estimated label (spec.js),
// artwork dimensions inherit the scale's label, and suggested stitching / construction lines are flagged as
// suggestions until the user edits them. The disclaimer is part of every export.
import { SIZES, KIND_LABELS, formatMeasure } from './measure.js';
import { SOURCES, VIEW_LABEL, scaleInfo } from './spec.js';

/* ------------------------------------------------------------------ persisted tech-pack fields (state.techpack) */
const S = (v, n = 200) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
const MAX_ROWS = 60;
export const MATERIAL_COLS = ['part', 'material', 'composition', 'weight', 'supplier', 'notes'];
export const TRIM_COLS = ['item', 'spec', 'placement', 'qty', 'colour', 'supplier'];
export const STITCH_COLS = ['area', 'stitch', 'spi', 'notes'];
export const PRODUCTION_KEYS = ['labels', 'packaging', 'washCare', 'moq', 'leadTime', 'notes'];

export function defaultTechPack() {
  return {
    styleNo: '', season: '', supplier: '', status: 'Draft',
    rev: { no: '1', date: '', author: '' },
    revisions: [],
    materials: [], trims: [], stitching: [], construction: [],
    production: { labels: '', packaging: '', washCare: '', moq: '', leadTime: '', notes: '' },
    notes: '',
  };
}
const rowsOf = (arr, cols, flag) => (Array.isArray(arr) ? arr : []).slice(0, MAX_ROWS).map(r => {
  const o = {}; for (const c of cols) o[c] = S(r && r[c], c === 'notes' ? 600 : 200);
  if (flag && r && r.s) o.s = true;
  return o;
}).filter(o => cols.some(c => o[c]));
export function normalizeTechPack(o) {
  const d = defaultTechPack(); if (!o || typeof o !== 'object') return d;
  d.styleNo = S(o.styleNo, 60); d.season = S(o.season, 60); d.supplier = S(o.supplier, 120); d.status = S(o.status, 40) || 'Draft';
  if (o.rev && typeof o.rev === 'object') d.rev = { no: S(o.rev.no, 20) || '1', date: S(o.rev.date, 20), author: S(o.rev.author, 80) };
  d.revisions = (Array.isArray(o.revisions) ? o.revisions : []).slice(0, MAX_ROWS).map(r => ({ no: S(r && r.no, 20), date: S(r && r.date, 20), author: S(r && r.author, 80), note: S(r && r.note, 400) })).filter(r => r.no || r.date || r.author || r.note);
  d.materials = rowsOf(o.materials, MATERIAL_COLS); d.trims = rowsOf(o.trims, TRIM_COLS);
  d.stitching = rowsOf(o.stitching, STITCH_COLS, true);
  d.construction = (Array.isArray(o.construction) ? o.construction : []).slice(0, MAX_ROWS).map(r => ({ text: S(typeof r === 'string' ? r : r && r.text, 500), ...(r && r.s ? { s: true } : {}) })).filter(r => r.text);
  if (o.production && typeof o.production === 'object') for (const k of PRODUCTION_KEYS) d.production[k] = S(o.production[k], k === 'notes' ? 2000 : 300);
  d.notes = S(o.notes, 3000);
  return d;
}
export const cloneTechPack = t => normalizeTechPack(JSON.parse(JSON.stringify(t || defaultTechPack())));
export const techPackIsEmpty = t => JSON.stringify(normalizeTechPack(t)) === JSON.stringify(defaultTechPack());

/* ------------------------------------------------------------------ suggested starting points (flagged, never verified) */
const COMMON_CONSTRUCTION = [
  'Seams are finished and pressed flat; no twisted or puckered seams. Match stripes and artwork across side seams where they meet.',
  'Main label centred at the back neck, 1 cm below the neck seam; care and size labels at the left side seam.',
  'Thread matched to the body colour unless the stitching is a stated contrast.',
];
export const SUGGESTED = {
  tee: {
    stitching: [['Shoulder seam', '4-thread overlock, taped', '', 'Shoulder tape for stability'], ['Neck binding', '2-needle coverstitch', '', 'Rib or self-fabric binding, topstitched'], ['Armhole', '4-thread overlock', '', 'Sleeve set in flat'], ['Side seam', '4-thread overlock', '', ''], ['Sleeve hem', '2-needle coverstitch', '', ''], ['Bottom hem', '2-needle coverstitch', '', '']],
    construction: ['Crew neck with rib / self-fabric binding, finished with a back-neck tape.', 'Set-in sleeves, twin-needle hems at sleeve opening and bottom.', ...COMMON_CONSTRUCTION],
  },
  longSleeve: {
    stitching: [['Shoulder seam', '4-thread overlock, taped', '', ''], ['Neck binding', '2-needle coverstitch', '', ''], ['Armhole', '4-thread overlock', '', ''], ['Side and underarm seam', '4-thread overlock', '', ''], ['Cuff / sleeve opening', '2-needle coverstitch', '', 'Cuff style as shown on the drawing'], ['Bottom hem', '2-needle coverstitch', '', '']],
    construction: ['Long sleeves set in flat; sleeve opening finished as drawn (open hem or cuff).', ...COMMON_CONSTRUCTION],
  },
  polo: {
    stitching: [['Collar to neck', 'Lockstitch 301, 12 SPI', '12', 'Collar edge-stitched'], ['Placket', 'Lockstitch 301, 12 SPI', '12', 'Box stitch at the placket base'], ['Shoulder seam', '4-thread overlock, taped', '', ''], ['Sleeve hem / cuff', '2-needle coverstitch', '', ''], ['Side vents', 'Lockstitch 301', '', 'Bar tack at the vent top'], ['Bottom hem', '2-needle coverstitch', '', '']],
    construction: ['Knit collar and placket with 2 or 3 buttons (buttons are listed under trims).', 'Placket reinforced with a bar tack; side vents with a reinforced top.', ...COMMON_CONSTRUCTION],
  },
  hoodie: {
    stitching: [['Hood centre seam', '4-thread overlock', '', 'Lined hood unless stated'], ['Hood to neck', '4-thread overlock, taped', '', ''], ['Kangaroo pocket', 'Lockstitch 301', '', 'Bar tack at both pocket openings'], ['Cuff and hem rib', '4-thread overlock', '', 'Rib attached with stretch'], ['Side seam', '4-thread overlock', '', ''], ['Drawcord eyelets', 'Metal eyelet', '', 'Position as drawn']],
    construction: ['Lined hood with drawcord through two eyelets.', 'Kangaroo pocket, rib cuffs and rib bottom band.', ...COMMON_CONSTRUCTION],
  },
};
/** Suggested stitching rows and construction lines for a garment kind (every row is flagged s:true until the user edits it). */
export function suggestFor(kind) {
  const k = SUGGESTED[kind] || SUGGESTED.tee;
  return { stitching: k.stitching.map(r => ({ area: r[0], stitch: r[1], spi: r[2], notes: r[3], s: true })), construction: k.construction.map(text => ({ text, s: true })) };
}

/* ------------------------------------------------------------------ artwork placement from layer geometry + scale */
export const TECHNIQUE = { text: 'Print or embroidery (confirm method)', logo: 'Print or heat transfer (confirm method)', crest: 'Print or woven / embroidered badge (confirm method)', graphic: 'Print (confirm method)', stripe: 'Knitted stripe or applied tape (confirm)', piping: 'Piping sewn into the seam (confirm)', embroidery: 'Embroidery', print: 'Screen print', patch: 'Sewn-on patch' };
export const TYPE_LABEL = { text: 'Text', logo: 'Logo', crest: 'Crest', graphic: 'Graphic', stripe: 'Stripes', piping: 'Piping', embroidery: 'Embroidery', print: 'Print', patch: 'Patch' };
const HEX = /^#[0-9a-fA-F]{3,8}$/;
export function elementColours(el) {
  const p = (el && el.props) || {}, out = [];
  for (const k of ['color', 'color2', 'bg', 'border', 'textColor']) if (typeof p[k] === 'string' && HEX.test(p[k]) && !out.includes(p[k].toLowerCase())) out.push(p[k].toLowerCase());
  return out;
}
export function elementLabel(el) {
  const p = (el && el.props) || {}, t = TYPE_LABEL[el.type] || el.type;
  const own = el.name && el.name !== el.type ? el.name : '';
  if (['text', 'embroidery', 'print'].includes(el.type) && p.text) return `${t}: "${String(p.text).replace(/\s+/g, ' ').slice(0, 40)}"`;
  if (['graphic', 'crest'].includes(el.type) && p.graphicId) return `${t}: ${own || String(p.graphicId).replace(/^(graphic|crest)-/, '').replace(/-/g, ' ')}`;
  return own ? `${t}: ${own}` : t;
}
const r1 = n => Math.round(n * 10) / 10;
/**
 * Placement of one element on a flat view. lm = landmarks (1024 px space), cmPerPx = the view's scale (null = no scale).
 * Returns the size, rotation and three positioning references (from HPS, from the hem, from the centre line) in cm.
 */
export function placementOf(el, lm, cmPerPx, view = 'front') {
  const rot = ((el.rotation || 0) * Math.PI) / 180, cos = Math.cos(rot), sin = Math.sin(rot), hw = el.w / 2, hh = el.h / 2;
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [el.x + x * cos - y * sin, el.y + x * sin + y * cos]);
  const minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0])), minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  const base = { id: el.id, view, type: el.type, label: elementLabel(el), rotation: Math.round(((el.rotation % 360) + 360) % 360), px: { x: el.x, y: el.y, w: el.w, h: el.h, minX, maxX, minY, maxY }, measured: false };
  if (!(cmPerPx > 0) || !lm || !Number.isFinite(lm.centerX)) return base;
  const hpsY = (lm.shoulderL.y + lm.shoulderR.y) / 2, hemY = (lm.hemL.y + lm.hemR.y) / 2, cx = lm.centerX, centre = view === 'back' ? 'centre back' : 'centre front';
  const off = (el.x - cx) * cmPerPx, side = view === 'back' ? (off > 0 ? 'right' : 'left') : (off > 0 ? 'left' : 'right');
  return {
    ...base, measured: true,
    wCm: r1(el.w * cmPerPx), hCm: r1(el.h * cmPerPx),
    fromHps: r1((minY - hpsY) * cmPerPx), fromHem: r1((hemY - maxY) * cmPerPx),
    fromCentre: r1(Math.abs(off)), centreSide: Math.abs(off) < 0.25 ? 'centred' : side, centreName: centre,
    text: `${Math.abs(minY - hpsY) * cmPerPx < 0.05 ? 'top edge at HPS' : `top edge ${r1(Math.abs((minY - hpsY) * cmPerPx))} cm ${minY >= hpsY ? 'below' : 'above'} HPS`}; bottom edge ${r1(Math.abs((hemY - maxY) * cmPerPx))} cm ${hemY >= maxY ? 'above' : 'below'} hem; ` +
      (Math.abs(off) < 0.25 ? `centred on ${centre}` : `centre ${r1(Math.abs(off))} cm to the wearer's ${side} of ${centre}`),
  };
}

/* ------------------------------------------------------------------ the model */
export const TP_DISCLAIMER = 'DRAFT FOR DISCUSSION. This tech pack was generated from a design drawing. Calibrated, Manual and Estimated labels show where each number came from. This pack is NOT production-verified. Measurements, tolerances, grading, artwork sizes and positions, stitching and construction notes must be confirmed by the factory on a physical sample before bulk production. Lines marked "suggested" are starting points, not instructions.';
const today = d => (d instanceof Date ? d : new Date(d || Date.now())).toISOString().slice(0, 10);
const cmText = v => (v == null ? '' : r1(v).toFixed(1));

/**
 * input: {
 *   name, designId, kind, baseSize, techpack, spec (designSpec() result or null), cal ({front,back}: calibration {s, manual} or null),
 *   elements: [{id,type,name,view,visible,x,y,w,h,rotation,props}], landmarks: {front, back}, fabrics: [{view, name}],
 *   colours: [{hex, name, share}], parts: [{view, part, hex}], history: [{rev,date,author,note,source}], identity (name), now
 * }
 */
export function buildTechPack(input = {}) {
  const tp = normalizeTechPack(input.techpack), spec = input.spec || null, kind = input.kind || (spec && spec.kind) || 'tee';
  const now = input.now || new Date(), elements = (input.elements || []).filter(e => e && e.visible !== false);
  const sc = { front: input.cal && input.cal.front ? scaleInfo(input.cal.front) : null, back: input.cal && input.cal.back ? scaleInfo(input.cal.back) : null };
  const scaleAny = sc.front || sc.back, calibrated = !!(scaleAny && scaleAny.calibrated);
  const revNo = tp.rev.no || '1', revDate = tp.rev.date || today(now), revAuthor = tp.rev.author || (input.identity || '') || '';
  const ident = {
    name: input.name || 'Untitled design', designId: input.designId || '', styleNo: tp.styleNo, season: tp.season, supplier: tp.supplier, status: tp.status || 'Draft',
    garment: KIND_LABELS[kind] || kind, kind, baseSize: (spec && spec.baseSize) || input.baseSize || 'M', units: 'cm (flat measurements)',
    revNo, revDate, revAuthor, generated: today(now),
    scale: scaleAny ? scaleAny.text : 'No scale available (no front or back garment image)', scaleSource: scaleAny ? (calibrated ? 'calibrated' : 'estimated') : 'missing',
  };
  const warnings = [];
  const warn = (level, msg) => warnings.push({ level, msg });
  if (!spec) warn('warn', 'No measurement spec: load a front or back garment image to build the graded size chart.');
  else if (!calibrated) warn('note', 'The scale is estimated from a typical size chart. Calibrate it with a real measurement (Measure tab) to label the base size Calibrated.');
  if (spec) for (const w of spec.warnings) if (w.level === 'error') warn('error', w.msg);
  if (!tp.materials.length && !(input.fabrics || []).some(f => f.name)) warn('note', 'No fabric or materials are recorded yet. Add them in the tech pack editor.');
  if (!elements.length) warn('note', 'The design has no artwork layers, so there are no artwork placements.');

  /* ---- artwork placements (front / back; side and detail views have no flat scale) ---- */
  const placements = [];
  for (const el of elements) {
    const views = el.view === 'all' ? ['front', 'back'] : [el.view || 'front'];
    for (const v of views) {
      const flat = v === 'front' || v === 'back', c = flat && input.cal ? input.cal[v] : null;
      const p = placementOf(el, flat && input.landmarks ? input.landmarks[v] : null, c && c.s > 0 ? c.s : null, v);
      p.technique = TECHNIQUE[el.type] || 'Confirm method'; p.colours = elementColours(el); p.source = p.measured ? (c && c.manual ? 'calibrated' : 'estimated') : 'missing';
      placements.push(p);
    }
  }
  const unmeasured = placements.filter(p => !p.measured).length;
  if (unmeasured) warn('note', `${unmeasured} artwork placement${unmeasured === 1 ? ' is' : 's are'} on a side or detail view, which has no flat scale, so no dimensions are given.`);

  /* ---- materials: from the design first, then the user's rows ---- */
  const materials = [];
  const fabricNames = [...new Set((input.fabrics || []).map(f => f.name).filter(Boolean))];
  const swatches = input.colours || [];
  materials.push({ part: 'Main body', material: fabricNames.length ? fabricNames.join(' / ') + ' (fabric look applied in Threadform)' : 'Not specified', composition: '', weight: '', supplier: '', notes: swatches[0] ? `Main colour ${swatches[0].name} ${swatches[0].hex.toUpperCase()} (read from the picture)` : '', auto: true });
  for (const el of elements) {
    if (!['stripe', 'piping', 'embroidery', 'patch', 'print', 'text', 'logo', 'crest', 'graphic'].includes(el.type)) continue;
    const key = el.type;
    if (materials.some(m => m.auto && m.key === key)) continue;
    const same = elements.filter(e => e.type === key).length, cols = [...new Set(elements.filter(e => e.type === key).flatMap(elementColours))].join(', ');
    const part = { stripe: 'Stripes', piping: 'Piping', embroidery: 'Embroidery thread', patch: 'Patch', print: 'Print inks', text: 'Text artwork', logo: 'Logo artwork', crest: 'Crest artwork', graphic: 'Graphic artwork' }[key];
    materials.push({ part, key, material: { stripe: 'Stripe yarn / tape', piping: 'Piping cord or tape', embroidery: 'Embroidery thread', patch: 'Patch material', print: 'Ink / transfer', text: 'Ink / transfer / thread', logo: 'Ink / transfer', crest: 'Ink / transfer / badge', graphic: 'Ink / transfer' }[key], composition: '', weight: '', supplier: '', notes: `${same} layer${same === 1 ? '' : 's'}${cols ? '; colours ' + cols : ''} (from the design)`, auto: true });
  }
  for (const m of tp.materials) materials.push({ ...m, auto: false });

  /* ---- colours ---- */
  const colours = swatches.map(s => ({ name: s.name, hex: s.hex, where: `Garment (${Math.round((s.share || 0) * 100)}% of the visible fabric)`, source: 'Read from the picture' }));
  for (const el of elements) for (const hx of elementColours(el)) if (!colours.some(c => c.hex.toLowerCase() === hx)) colours.push({ name: '', hex: hx, where: elementLabel(el) + ' (' + el.view + ')', source: 'Design setting' });
  for (const p of input.parts || []) if (p.hex && !colours.some(c => c.hex.toLowerCase() === p.hex.toLowerCase())) colours.push({ name: '', hex: p.hex, where: `${p.part} (${p.view})`, source: 'Design setting' });

  /* ---- trims: from the design's layers, then the user's rows ---- */
  const trims = [];
  for (const p of placements) {
    const el = elements.find(e => e.id === p.id); if (!el || !['piping', 'patch', 'embroidery', 'stripe'].includes(el.type)) continue;
    const cm = sc[p.view] && sc[p.view].cmPerPx;
    const spec2 = el.type === 'piping' ? `Piping${cm ? `, about ${Math.round((el.props.thickness || 8) * cm * 100) / 10} mm` : ''}` : el.type === 'patch' ? `Patch, ${el.props.shape || ''} shape` : el.type === 'stripe' ? `${el.props.count || ''} stripe${(el.props.count || 1) === 1 ? '' : 's'}` : 'Embroidery';
    trims.push({ item: elementLabel(el), spec: spec2.trim(), placement: `${VIEW_LABEL[p.view] || p.view}: ${p.measured ? p.text : 'see drawing'}`, qty: '1', colour: elementColours(el).join(', '), supplier: '', auto: true });
  }
  for (const t of tp.trims) trims.push({ ...t, auto: false });

  /* ---- revisions ---- */
  const revisions = [{ no: revNo, date: revDate, author: revAuthor || 'Not set', note: 'This tech pack' }, ...tp.revisions.map(r => ({ no: r.no, date: r.date, author: r.author, note: r.note }))];
  const history = (input.history || []).map(h => ({ rev: String(h.rev == null ? '' : h.rev), date: h.date || '', author: h.author || '', note: h.note || '', source: h.source || '' }));

  /* ---- sheets: one table each, used by the print layout, CSV and spreadsheet ---- */
  const sheets = [];
  const sheet = (key, name, title, columns, rows, note) => sheets.push({ key, name, title, columns, rows, note: note || '' });
  const gen = (ident.styleNo ? ident.styleNo + ' / ' : '') + ident.name;
  sheet('overview', 'Overview', 'Design identifiers', ['Field', 'Value'], [
    ['Design name', ident.name], ['Design ID', ident.designId], ['Style no.', ident.styleNo], ['Season', ident.season], ['Supplier / factory', ident.supplier], ['Status', ident.status],
    ['Garment type', ident.garment], ['Base size', ident.baseSize], ['Units', ident.units],
    ['Revision', ident.revNo], ['Revision date', ident.revDate], ['Revision author', ident.revAuthor || 'Not set'], ['Pack generated', ident.generated],
    ['Scale', ident.scale], ['Scale label', ident.scaleSource === 'calibrated' ? 'Calibrated' : ident.scaleSource === 'estimated' ? 'Estimated' : 'No value'],
    ['Verification', 'NOT production-verified. ' + (spec ? `Size chart values: ${spec.counts.calibrated} calibrated, ${spec.counts.manual} manual, ${spec.counts.estimated} estimated.` : '')],
  ], TP_DISCLAIMER);
  if (spec) {
    const cols = ['POM code', 'Point of measure', 'Views', 'How to measure', 'Tolerance +/- (cm)', 'Grading step (cm)', ...SIZES.map(s => s + ' (cm)'), ...SIZES.map(s => s + ' min'), ...SIZES.map(s => s + ' max'), ...SIZES.map(s => s + ' status')];
    sheet('sizechart', 'Size chart', `Graded size chart, base size ${spec.baseSize}`, cols, spec.rows.map(r => [r.code, r.name, r.views.map(v => VIEW_LABEL[v]).join(' + '), r.how, r.tol, r.incIsDefault ? r.steps.join(' / ') : String(r.steps[0]),
      ...SIZES.map(s => r.cells[s].cm), ...SIZES.map(s => r.cells[s].min), ...SIZES.map(s => r.cells[s].max), ...SIZES.map(s => SOURCES[r.cells[s].source].label)]),
    'Status key: Calibrated = scale set from a real measurement you typed; Manual = typed by you; Estimated = from the picture / size chart or graded from the base size (not production-verified). ' + ident.scale + '.');
  }
  sheet('materials', 'Materials', 'Materials', ['Part', 'Material', 'Composition', 'Weight (gsm)', 'Supplier', 'Notes', 'Origin'], materials.map(m => [m.part, m.material, m.composition, m.weight, m.supplier, m.notes, m.auto ? 'From design' : 'Entered']), 'Composition, weight and supplier are only what you entered; Threadform cannot know them from a picture.');
  sheet('colours', 'Colours', 'Colours', ['Colour name', 'Hex', 'Used for', 'Source'], colours.map(c => [c.name, c.hex.toUpperCase(), c.where, c.source]), 'Colours are read from the picture or taken from design settings. They are screen colours: confirm against a physical colour standard (for example a Pantone reference) before production.');
  sheet('trims', 'Trims', 'Trims', ['Item', 'Specification', 'Placement', 'Qty', 'Colour', 'Supplier', 'Origin'], trims.map(t => [t.item, t.spec, t.placement, t.qty, t.colour, t.supplier, t.auto ? 'From design' : 'Entered']), 'Labels, buttons, zips and drawcords are not in the picture: add them in the tech pack editor.');
  sheet('stitching', 'Stitching', 'Stitching', ['Area', 'Stitch / seam type', 'SPI', 'Notes', 'Status'], tp.stitching.map(r => [r.area, r.stitch, r.spi, r.notes, r.s ? 'Suggested, confirm' : 'Entered']), 'Lines marked Suggested are typical starting points for this garment type, not verified instructions.');
  sheet('construction', 'Construction', 'Construction notes', ['No.', 'Note', 'Status'], tp.construction.map((r, i) => [i + 1, r.text, r.s ? 'Suggested, confirm' : 'Entered']));
  sheet('artwork', 'Artwork placement', 'Logo and graphic placement', ['No.', 'View', 'Artwork', 'Type', 'Width (cm)', 'Height (cm)', 'Rotation (deg)', 'Top edge from HPS (cm)', 'Bottom edge above hem (cm)', 'Offset from centre line (cm)', 'Offset side (wearer)', 'Position note', 'Technique', 'Colours', 'Dimension label'],
    placements.map((p, i) => [i + 1, VIEW_LABEL[p.view] || p.view, p.label, TYPE_LABEL[p.type] || p.type, p.measured ? p.wCm : '', p.measured ? p.hCm : '', p.rotation, p.measured ? p.fromHps : '', p.measured ? p.fromHem : '', p.measured ? p.fromCentre : '', p.measured ? p.centreSide : '',
      p.measured ? p.text : 'No flat scale on this view', p.technique, p.colours.join(' '), p.source === 'calibrated' ? 'Calibrated scale' : p.source === 'estimated' ? 'Estimated' : 'No value']),
    'HPS = high point shoulder. Sizes use the box around each layer at the base size and the label shown: dimensions are ' + (calibrated ? 'on a calibrated scale' : 'estimates, not production-verified') + '. Positions grade with the garment only if the factory re-measures them.');
  sheet('revisions', 'Revisions', 'Revision details', ['Revision', 'Date', 'Author', 'Note', 'Source'], [
    ...revisions.map((r, i) => [r.no, r.date, r.author, r.note, i === 0 ? 'This pack' : 'Entered']),
    ...history.map(h => [h.rev, h.date, h.author, h.note, h.source || 'Version history']),
  ], 'Saved versions come from the design\'s version history (author shown where the shared library records one).');
  const pr = tp.production;
  sheet('production', 'Production notes', 'Production notes', ['Topic', 'Note'], [
    ['Labels', pr.labels], ['Packaging', pr.packaging], ['Wash care', pr.washCare], ['Minimum order quantity', pr.moq], ['Lead time', pr.leadTime], ['Production notes', pr.notes], ['General notes', tp.notes],
  ].filter(r => r[1]), '');
  return { ident, title: gen, spec, sc, placements, materials, colours, trims, revisions, history, warnings, sheets, disclaimer: TP_DISCLAIMER, tp, calibrated };
}

/* ------------------------------------------------------------------ exports */
const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const line = a => a.map(cell).join(',');
/** Rows of a sheet with a title block on top: the same layout in CSV and spreadsheet. */
export function sheetRows(model, sh) {
  const i = model.ident, out = [
    ['THREADFORM TECH PACK: ' + sh.title.toUpperCase()],
    ['Design', i.name, 'Design ID', i.designId, 'Style no.', i.styleNo],
    ['Revision', i.revNo, 'Date', i.revDate, 'Author', i.revAuthor || 'Not set'],
    ['Status', i.status + ' (NOT production-verified)'],
    [],
    sh.columns, ...sh.rows,
  ];
  if (sh.note) out.push([], ['Note', sh.note]);
  return out;
}
export function sheetCSV(model, sh) { return sheetRows(model, sh).map(line).join('\r\n') + '\r\n'; }
export const sheetFileName = (slug, sh) => `${slug}-techpack-${sh.key}.csv`;
/** Every sheet as its own CSV: [{name, text}] (the caller downloads them one after another, no zip). */
export function csvBundle(model, slug = 'design') {
  return model.sheets.filter(s => s.rows.length || s.key === 'overview').map(sh => ({ name: sheetFileName(slug, sh), text: '﻿' + sheetCSV(model, sh) }));
}

const xe = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sheetName = (n, used) => { let b = n.replace(/[\[\]:*?/\\]/g, ' ').slice(0, 28).trim() || 'Sheet', k = b, i = 2; while (used.has(k.toLowerCase())) k = b.slice(0, 26) + ' ' + i++; used.add(k.toLowerCase()); return k; };
/** One multi-sheet workbook in Excel 2003 XML (SpreadsheetML): opens in Excel, LibreOffice and Numbers, zero dependencies. */
export function spreadsheetXML(model) {
  const used = new Set(), parts = [];
  for (const sh of model.sheets) {
    const rows = sheetRows(model, sh), headerIdx = 5, nameX = sheetName(sh.name, used);
    const trs = rows.map((r, ri) => `<Row>${r.map((v, ci) => {
      const isNum = typeof v === 'number' && Number.isFinite(v);
      const st = ri === 0 ? 's:title' : ri === headerIdx ? 's:head' : 's:wrap';
      return `<Cell ss:StyleID="${st}"><Data ss:Type="${isNum ? 'Number' : 'String'}">${xe(v)}</Data></Cell>`;
    }).join('')}</Row>`).join('');
    parts.push(`<Worksheet ss:Name="${xe(nameX)}"><Table ss:DefaultColumnWidth="90">${trs}</Table></Worksheet>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Title>${xe('Threadform tech pack: ' + model.title)}</Title><Author>Threadform</Author></DocumentProperties>\n<Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Top"/></Style><Style ss:ID="s:title"><Font ss:Bold="1" ss:Size="13"/></Style><Style ss:ID="s:head"><Font ss:Bold="1"/><Interior ss:Color="#EEEEEE" ss:Pattern="Solid"/></Style><Style ss:ID="s:wrap"><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style></Styles>\n${parts.join('\n')}\n</Workbook>\n`;
}
export { formatMeasure, cmText };
