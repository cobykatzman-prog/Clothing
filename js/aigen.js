// Threadform - AI generation helpers (Phase 6). Pure functions, no DOM and no state, so node can test them.
//  - garmentForAi: the garment's type, cut, panels, sleeves, fabric and construction as plain words for the model
//  - shapeForAi: the shape sliders the studio applies (sent so every view agrees with them)
//  - describeArtwork: the artwork layers the studio draws itself (the model must not redraw or damage them)
//  - artworkProtection: which baked-in artwork (logos / text) an edit must leave alone because the request did not name it
//  - SECTIONS: garment sections that can be regenerated on their own

const PARAM_KEYS = ['bodyLength', 'bodyWidth', 'collarSize', 'cropLength', 'hemShape', 'neckOpening', 'shoulderWidth', 'sleeveFlare', 'sleeveLength', 'sleeveShape', 'sleeveWidth'];
const words = s => String(s || '').replace(/([A-Z])/g, ' $1').toLowerCase().trim();

const KIND_CONSTRUCTION = {
  tee: { cut: 'classic t-shirt', sleeves: 'short set-in sleeves with plain hemmed ends', collar: 'ribbed crew neck', panels: ['front and back body panels', 'set-in sleeves', 'side seams'], details: ['single-needle hems', 'neck rib binding'] },
  longSleeve: { cut: 'long-sleeve top', sleeves: 'long set-in sleeves to the wrist', collar: 'ribbed crew neck', panels: ['front and back body panels', 'two long sleeve panels', 'side seams'], details: ['neck rib binding', 'hemmed sleeve ends unless cuffs are named'] },
  polo: { cut: 'polo shirt', sleeves: 'short set-in sleeves', collar: 'knitted polo collar with a short button placket', panels: ['front and back body panels', 'placket', 'side vents'], details: ['two- or three-button placket', 'collar band'] },
  hoodie: { cut: 'pullover hoodie', sleeves: 'long set-in sleeves with rib cuffs', collar: 'hood with drawstring, lined', panels: ['front and back body panels', 'hood panels', 'kangaroo pocket', 'sleeve panels'], details: ['ribbed hem and cuffs', 'flat drawstring with eyelets'] },
};

/** garment spec (generate.js parseGarmentText) + optional text overrides -> the plain object /api/ai accepts as `garment`. */
export function garmentForAi(spec, extra = {}) {
  if (!spec) return null;
  const k = KIND_CONSTRUCTION[spec.kind] || {};
  const g = {
    kind: spec.kindLabel || words(spec.kind), cut: k.cut, sleeves: k.sleeves, collar: k.collar,
    panels: k.panels ? [...k.panels] : [], details: k.details ? [...k.details] : [],
    color: spec.colourName ? `${spec.colourName}${spec.color ? ' (' + spec.color + ')' : ''}` : spec.color,
  };
  if (spec.stripe) g.stripes = `${spec.stripeName || 'contrasting'} stripes (${spec.stripe})`;
  if (spec.trim) g.trim = `trim in ${spec.trim}`;
  if (spec.cuffs === 'rib') { g.cuffs = 'ribbed cuffs'; }
  else if (spec.cuffs === 'hem') { g.cuffs = 'none: open, plainly hemmed sleeve ends'; g.sleeves = (g.sleeves || 'sleeves').replace(/with rib cuffs/, 'with plain open ends'); }
  if (spec.fit) g.fit = spec.fit;
  if (spec.sleeve) g.sleeves = `${g.sleeves ? g.sleeves + '; ' : ''}${words(spec.sleeve)} sleeve shape`;
  if (spec.fabric && spec.fabric.name) g.fabric = words(spec.fabric.name);
  Object.assign(g, extra);
  for (const key of Object.keys(g)) if (g[key] == null || g[key] === '' || (Array.isArray(g[key]) && !g[key].length)) delete g[key];
  return Object.keys(g).length ? g : null;
}

/** shape params -> {key: value} with only the non-zero sliders (null when the garment has its original shape). */
export function shapeForAi(params) {
  if (!params) return null;
  const o = {};
  for (const k of PARAM_KEYS) { const v = Number(params[k]); if (Number.isFinite(v) && Math.abs(v) >= 1) o[k] = Math.round(v); }
  return Object.keys(o).length ? o : null;
}

/** Visible artwork layers of a view as short strings: `text "CLUB ELITE" (layer "Back text")`. */
export function describeArtwork(elements, view) {
  const out = [];
  for (const e of Array.isArray(elements) ? elements : []) {
    if (!e || e.visible === false) continue;
    if (e.view && e.view !== 'all' && view && e.view !== view) continue;
    const p = e.props || {};
    const t = typeof p.text === 'string' && p.text.trim() ? ` "${p.text.trim().slice(0, 40)}"` : '';
    const nm = e.name && e.name !== e.type ? ` (layer "${String(e.name).slice(0, 30)}")` : '';
    out.push(`${e.type}${t}${nm}`);
    if (out.length >= 8) break;
  }
  return out;
}

const LOGO_WORDS = /\b(logos?|crests?|emblems?|badges?|patch(?:es)?|labels?|monogram|artwork|artworks)\b/i;
const TEXT_WORDS = /\b(text|lettering|typography|wording|slogans?|prints?|graphics?|artwork|artworks|tennis|words?)\b/i;
const KEEP_CLAUSE = /\b(?:keep|preserve|retain|leave|maintain|don'?t change|do not change|don'?t touch|do not touch|without (?:changing|touching))\b[^.;!?,]*?(?=\b(?:but|while|then|so|except)\b|[.;!?,]|$)/gi;
/**
 * The baked-in artwork regions ('logos', 'text') that an edit must NOT touch, because the person did not name them.
 * Naming logos (or text) lifts the protection for that kind only. Layers are never at risk: they are separate objects.
 */
export function artworkProtection(text, ops = {}) {
  const o = ops && typeof ops === 'object' ? ops : {};
  const names = new Set([...(o.regions || []), ...(o.removeParts || [])]);
  const asked = String(text || '').replace(KEEP_CLAUSE, ' ');   // "keep the logo" does not name artwork for change
  const ex = o.extract && typeof o.extract === 'object' ? o.extract : {};
  const adds = Array.isArray(o.addElements) ? o.addElements : [];
  const logoNamed = LOGO_WORDS.test(asked) || names.has('logos') || !!ex.logo || adds.some(e => e && (e.type === 'logo' || e.type === 'patch'));
  const textNamed = TEXT_WORDS.test(asked) || names.has('text') || !!ex.text || !!ex.graphics || adds.some(e => e && e.type === 'text');
  return [logoNamed ? null : 'logos', textNamed ? null : 'text'].filter(Boolean);
}

export const SECTIONS = [
  { id: 'sleeves', label: 'Sleeves', regions: ['leftSleeve', 'rightSleeve'] },
  { id: 'collar', label: 'Collar', regions: ['collar', 'neckline'] },
  { id: 'body', label: 'Body', regions: ['body'] },
  { id: 'hem', label: 'Hem', regions: ['hem'] },
  { id: 'stripes', label: 'Stripes', regions: ['stripes'] },
];
export const sectionById = id => SECTIONS.find(s => s.id === id) || null;

/** Prompt for "regenerate this section": a fresh take that stays consistent with the rest and never touches artwork. */
export function sectionPrompt(section, { spec = null, extra = '' } = {}) {
  const s = typeof section === 'string' ? sectionById(section) : section;
  const label = s ? s.label.toLowerCase() : 'section';
  const base = spec && spec.summary ? ` The garment is: ${spec.summary}.` : '';
  const more = String(extra || '').trim();
  return `Regenerate the ${label} with a fresh take that matches the rest of the garment.${base}${more ? ' ' + more : ''} Keep every other part, and the colours, fabric and stripes, exactly as they are.`;
}
