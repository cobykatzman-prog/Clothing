// Threadform - offline "Generate garment": prompt text -> one garment spec -> four matching procedural views.
// Pure helpers (no state, no DOM beyond what sampleGarment draws). The pipeline that installs the views
// into the editor lives in ui-actions.js (generateFromPrompt).
import { parsePrompt } from './prompt.js';
import { sampleGarment, SAMPLE_KIND_LABELS, SAMPLE_DEFAULTS } from './samples.js';
import { FIT_PRESETS, SLEEVE_PRESETS } from './warp.js';
import { FABRICS } from './fabric.js';

export const GEN_VIEWS = ['front', 'back', 'side', 'detail'];

// Colour names -> hex. Keys are normalised (lower case, single spaces) before lookup, so "off-white" and "off white" both work.
const COLOURS = {
  black: '#1d1d21', white: '#f5f5f2', 'off white': '#efebe0', cream: '#efe6d2', ivory: '#f5f0dc',
  beige: '#d8c8a8', sand: '#d9c7a1', tan: '#c8a67a', camel: '#c19a6b', khaki: '#b5a77a',
  brown: '#6b4226', chocolate: '#4a2c1a', coffee: '#5a3a26',
  grey: '#8a8d91', gray: '#8a8d91', 'light grey': '#c4c6ca', 'light gray': '#c4c6ca', 'dark grey': '#4a4d53', 'dark gray': '#4a4d53',
  charcoal: '#3a3d42', silver: '#b9bcc0',
  navy: '#1c2a4d', 'royal blue': '#2f5fb0', blue: '#2f5fb0', 'sky blue': '#7db7e8',
  teal: '#1f7a7a', turquoise: '#26b5b0', mint: '#a9dcc3',
  'forest green': '#1f4d33', green: '#3c8a4f', olive: '#6b6b2e', sage: '#9aae8c',
  yellow: '#f0cf3a', mustard: '#d1a21d', gold: '#c9a227', orange: '#e8802a', rust: '#b5502a', terracotta: '#c4694a',
  red: '#c1272d', burgundy: '#6e1423', maroon: '#6e1423', pink: '#eaa0b8', rose: '#d98ba0',
  purple: '#6b3fa0', lavender: '#b9a4dc', lilac: '#c8b4e0',
};
const norm = s => String(s).toLowerCase().replace(/[-\s]+/g, ' ').trim();
const COLOUR_MAP = Object.fromEntries(Object.entries(COLOURS).map(([k, v]) => [norm(k), v]));
const COLOUR_RE = new RegExp('\\b(' + Object.keys(COLOUR_MAP).sort((a, b) => b.length - a.length).map(k => k.replace(/ /g, '[- ]')).join('|') + ')\\b', 'g');

// Garment kinds, checked in order (hoodie before shirt, polo before tee, long sleeve before tee).
const KIND_RULES = [
  ['hoodie', /\b(hoodies?|hoody|hooded)\b/],
  ['polo', /\b(polos?|collared)\b/],
  ['longSleeve', /\b(long[- ]?sleeves?|sweatshirts?|sweaters?|jumpers?)\b/],
  ['tee', /\b(t-?shirts?|tees?|tshirts?|shirts?)\b/],
];
const KIND_NAMES = { tee: 't-shirt', longSleeve: 'long-sleeve tee', polo: 'polo shirt', hoodie: 'hoodie' };

const lum = hex => {
  const n = parseInt(String(hex).slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
// stripe colour that contrasts with the body colour
const contrastOf = body => (lum(body) > 0.5 ? '#2b2f3a' : '#f3f1ea');
const cap = s => s.replace(/^./, c => c.toUpperCase());

/**
 * Turns a sentence into a garment spec. Never throws; unknown words are ignored and noted.
 * @returns {{kind, kindLabel, color, colourName, stripe:string|false, stripeName, trim?:string, cuffs?:'rib'|'hem', fit:string|null,
 *            sleeve:string|null, fabric:{name,amount}|null, sample:object, title:string, summary:string, notes:string[], prompt:string}}
 */
export function parseGarmentText(text, { defaultKind = 'tee', defaultColor = null, addStripes = false } = {}) {
  const raw = String(text || '').trim().slice(0, 1200);
  const lower = raw.toLowerCase();
  const notes = [];
  const p = parsePrompt(raw);

  // garment kind
  const hit = KIND_RULES.find(([, re]) => re.test(lower));
  let kind = hit ? hit[0] : null;
  if (!kind && p.garmentKind === 'longSleeve') kind = 'longSleeve';
  if (!kind) { kind = KIND_RULES.some(([k]) => k === defaultKind) ? defaultKind : 'tee'; notes.push(`no garment type named, so ${KIND_NAMES[kind]} it is`); }

  // colours by name, each classified as stripe / trim / body by the words around it
  const cols = [...lower.matchAll(COLOUR_RE)].map(m => ({
    name: norm(m[1]), hex: COLOUR_MAP[norm(m[1])], start: m.index, end: m.index + m[0].length, role: null,
  }));
  for (const c of cols) {
    const after = lower.slice(c.end, c.end + 40);
    const before = lower.slice(Math.max(0, c.start - 30), c.start);
    if (/^\s+(?:(?:and|&)\s+)?(?:\w+\s+)?(?:stripe[sd]?|pinstripes?)\b/.test(after) || /(?:stripe[sd]?|pinstripes?)\s+(?:in\s+|of\s+|with\s+)?$/.test(before)) c.role = 'stripe';
    else if (/^\s+(?:trim|collar|cuffs?|ribbing|rib|piping|binding|neckband)\b/.test(after) || /\b(?:trim|collar|cuffs?|piping|binding)\s+(?:in\s+)?$/.test(before)) c.role = 'trim';
  }
  const bodyCol = cols.find(c => !c.role);
  const stripeCol = cols.find(c => c.role === 'stripe');
  const trimCol = cols.find(c => c.role === 'trim');
  const pickedColor = /^#[0-9a-f]{6}$/i.test(String(defaultColor || '')) ? String(defaultColor).toLowerCase() : null;
  const color = bodyCol ? bodyCol.hex : (pickedColor || SAMPLE_DEFAULTS.color);
  const colourName = bodyCol ? bodyCol.name : (pickedColor ? 'selected colour' : 'cream');

  // stripes (parsePrompt knows about "no stripes" / "add stripes")
  const removedStripes = (p.removeParts || []).includes('stripes');
  const wantsStripes = !removedStripes && (!!stripeCol || addStripes || /\bstripe[sd]?\b|pinstripe/.test(lower) || (p.addElements || []).some(e => e.type === 'stripe'));
  const stripe = wantsStripes ? (stripeCol ? stripeCol.hex : contrastOf(color)) : false;
  const stripeName = stripe ? (stripeCol ? stripeCol.name : (lum(color) > 0.5 ? 'dark' : 'white')) : null;
  const trim = trimCol ? trimCol.hex : undefined;

  // cuffs, fit, sleeves, fabric
  const cuffs = p.removeCuffs ? 'hem' : (/\bcuffs?\b|\bribbed\b/.test(lower) ? 'rib' : undefined);
  const fit = p.fitPreset && FIT_PRESETS[p.fitPreset] ? p.fitPreset : null;
  const sleeve = p.sleevePreset && SLEEVE_PRESETS[p.sleevePreset] ? p.sleevePreset : null;
  const fabric = p.fabric && FABRICS.includes(p.fabric) ? { name: p.fabric, amount: p.fabricAmount ?? 0.6 } : null;

  const sample = { kind, color, stripe, trim, cuffs };
  const parts = [`${colourName} ${KIND_NAMES[kind]}`];
  if (stripe) parts.push(`${stripeName} stripes`);
  if (cuffs === 'rib') parts.push('ribbed cuffs');
  if (cuffs === 'hem') parts.push('no cuffs');
  if (fit) parts.push(`${fit} fit`);
  if (fabric) parts.push(fabric.name.replace(/([A-Z])/g, ' $1').toLowerCase());
  const summary = parts.join(', ');

  return {
    kind, kindLabel: SAMPLE_KIND_LABELS[kind] || kind, color, colourName,
    stripe, stripeName, trim, cuffs, fit, sleeve, fabric,
    sample, title: cap(parts[0]), summary, notes, prompt: raw,
  };
}

/** Four views of the same garment (one spec, so front and back always match). */
export function makeGarmentViews(spec) {
  const opts = { color: spec.color, stripe: spec.stripe, trim: spec.trim, cuffs: spec.cuffs };
  const out = {};
  for (const v of GEN_VIEWS) out[v] = sampleGarment(spec.kind, v, opts);
  return out;
}
