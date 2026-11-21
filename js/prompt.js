// Threadform - natural-language prompt -> structured garment ops (rule based, offline, no deps).
// Pure ES module: runs in the browser and in Node (see js/prompt.test.mjs).

const REGION_NAMES = ['body', 'leftSleeve', 'rightSleeve', 'collar', 'neckline', 'cuffs', 'hem', 'shoulders', 'sidePanels', 'stripes', 'logos', 'text', 'fabric'];
const SLEEVES = ['leftSleeve', 'rightSleeve'];

export function intensityScale(label) {
  const k = String(label || '').toLowerCase();
  if (k.startsWith('sub')) return 0.4;
  if (k.startsWith('bol')) return 1;
  return 0.75;
}

/* ------------------------------------------------------------------ lexicons */

const COLORS = {
  cream: '#f1e6cf', ivory: '#f6f0dc', white: '#f7f7f5', offwhite: '#f2efe6', black: '#1a1a1a', charcoal: '#3a3d42',
  grey: '#8a8d91', gray: '#8a8d91', silver: '#b9bcc0', navy: '#1c2a4d', blue: '#2f5fb0', skyblue: '#7db7e8', teal: '#1f7a7a',
  turquoise: '#26b5b0', green: '#3c8a4f', olive: '#6b6b2e', sage: '#9aae8c', forest: '#1f4d33', mint: '#a9dcc3',
  yellow: '#f0cf3a', mustard: '#d1a21d', gold: '#c9a227', orange: '#e8802a', rust: '#b5502a', terracotta: '#c4694a',
  red: '#c1272d', burgundy: '#6e1423', maroon: '#6e1423', pink: '#eaa0b8', rose: '#d98ba0', purple: '#6b3fa0',
  lavender: '#b9a4dc', lilac: '#c8b4e0', brown: '#6b4226', chocolate: '#4a2c1a', tan: '#c8a67a', beige: '#d8c8a8',
  khaki: '#b5a77a', camel: '#c19a6b', coffee: '#5a3a26', sand: '#d9c7a1', denim: '#3d5a80'
};
const COLOR_WORDS = Object.keys(COLORS).filter((c) => c !== 'denim'); // denim handled as fabric

const FABRIC_RULES = [
  [/\b(heavy[- ]?weight|heavy|thick|chunky)\s+(cotton|jersey|tee|fabric)|heavyweight/, 'heavyweightCotton'],
  [/\b(linen|flax)\b/, 'linen'],
  [/\b(denim|jean|jeans)\b/, 'denim'],
  [/\b(silk|silky)\b/, 'silk'],
  [/\b(satin|glossy|shiny)\b/, 'satin'],
  [/\b(wool|woolen|woollen|merino|tweed)\b/, 'wool'],
  [/\b(knit|knitted|knitwear|fleece|sweater|waffle)\b/, 'knit'],
  [/\b(corduroy|cord)\b/, 'corduroy'],
  [/\b(leather|faux leather|pleather)\b/, 'leather'],
  [/\b(cotton|jersey|poplin|oxford|canvas|twill)\b/, 'cotton']
];

const STYLES = {
  greekIsland: {
    re: /\b(greek|greece|santorini|mykonos|aegean|mediterranean|island)\b|\bsummer\s+(aesthetic|vibe|look|feel|style)/,
    label: 'Greek island summer',
    fabric: 'linen', fitPreset: 'relaxed', fabricAmount: 0.55,
    color: { tint: '#f2ede0', tintAmount: 0.35, light: 8, sat: -10 },
    palette: ['#f6f2e8', '#1e5aa8', '#c9b78e'],
    params: { bodyWidth: 25, sleeveWidth: 15, neckOpening: 20 }
  },
  vintage: {
    re: /\b(vintage|retro|old[- ]school|throwback|worn[- ]in|nostalgic|seventies|sixties|70'?s|60'?s)\b/,
    label: 'Vintage',
    fabric: 'cotton', fitPreset: 'relaxed', fabricAmount: 0.5,
    color: { tint: '#c9a66b', tintAmount: 0.25, light: 3, sat: -25 },
    palette: ['#e9dcc0', '#8a5a34', '#b0402f'],
    params: { bodyWidth: 15, collarSize: 15 }
  },
  streetwear: {
    re: /\b(street\s?wear|urban|hypebeast|skater|skate)\b/,
    label: 'Streetwear',
    fabric: 'heavyweightCotton', fitPreset: 'oversized', fabricAmount: 0.7,
    color: { sat: -10, light: -8 },
    palette: ['#151515', '#6b6e72', '#e8e4da'],
    params: { bodyWidth: 70, shoulderWidth: 45, sleeveWidth: 30, bodyLength: 20 }
  },
  minimalist: {
    re: /\b(minimal|minimalist|minimalism|understated|simple|clean[- ]?(look|aesthetic|lines))\b/,
    label: 'Minimalist',
    fabric: 'cotton', fitPreset: 'regular', fabricAmount: 0.45,
    color: { sat: -45, light: 5 },
    palette: ['#f2f0ec', '#2b2b2b', '#a8a49c'],
    params: {}
  },
  preppy: {
    re: /\b(preppy|prepy|ivy|collegiate|country club|clubhouse)\b/,
    label: 'Preppy',
    fabric: 'cotton', fitPreset: 'regular', fabricAmount: 0.5, collarStyle: 'polo',
    color: { sat: 5, light: 2 },
    palette: ['#f4efe2', '#1c2a4d', '#a82833'],
    params: { collarSize: 20 }
  },
  nineties: {
    re: /\b(90'?s|nineties|1990s)\b/,
    label: '90s',
    fabric: 'cotton', fitPreset: 'oversized', fabricAmount: 0.5,
    color: { sat: 25 },
    palette: ['#2d7dd2', '#f2c14e', '#d7263d'],
    params: { bodyWidth: 55, shoulderWidth: 30, sleeveWidth: 25, bodyLength: 15 }
  }
};

const FIT_DEFS = {
  boxy: { bodyWidth: 80, shoulderWidth: 30, bodyLength: -8 },
  oversized: { bodyWidth: 90, shoulderWidth: 60, sleeveWidth: 40, sleeveLength: 25, bodyLength: 30 },
  slim: { bodyWidth: -70, sleeveWidth: -50, shoulderWidth: -10 },
  relaxed: { bodyWidth: 40, sleeveWidth: 25, bodyLength: 10 },
  regular: {},
  cropped: { cropLength: 70, bodyLength: -15 }
};

const COLLAR_STYLES = [
  [/tennis/, 'tennis', 30], [/polo/, 'polo', 20], [/mandarin|band\b|nehru/, 'mandarin', 0], [/camp|cuban|revere/, 'camp', 25],
  [/spread|cutaway/, 'spread', 25], [/button[- ]?down/, 'buttonDown', 10], [/peter pan/, 'peterPan', 10],
  [/crew/, 'crew', 0], [/v[- ]?neck/, 'vneck', 0], [/henley/, 'henley', 0], [/turtle|funnel|roll/, 'funnel', 20],
  [/ribbed/, 'ribbed', 10], [/shawl/, 'shawl', 20], [/notch/, 'notch', 15]
];

const REGION_LEX = [
  [/\b(sleeves?|arms?|elbows?|wrists?)\b/, SLEEVES],
  [/\bleft sleeve\b/, ['leftSleeve']],
  [/\bright sleeve\b/, ['rightSleeve']],
  [/\b(cuffs?)\b/, ['cuffs']],
  [/\b(collar|collars)\b/, ['collar']],
  [/\b(neckline|neck(?: ?hole| opening)?)\b/, ['neckline']],
  [/\b(hem|hemline|bottom edge|waistband)\b/, ['hem']],
  [/\b(shoulders?)\b/, ['shoulders']],
  [/\b(side ?panels?|sides)\b/, ['sidePanels']],
  [/\b(stripes?|piping|pipe|trim)\b/, ['stripes']],
  [/\b(logos?|crest|badge|emblem)\b/, ['logos']],
  [/\b(text|lettering|print|graphics?|slogan)\b/, ['text']],
  [/\b(body|torso|shirt|tee|t-shirt|top|garment|jumper|sweater|hoodie|polo)\b/, ['body']]
];

/* ------------------------------------------------------------------ helpers */

function clamp(v, lo = -100, hi = 100) { return Math.max(lo, Math.min(hi, v)); }
const uniq = (a) => [...new Set(a)];

function degree(s, def = 0.6) {
  if (/\b(slightly|slight|subtle|subtly|a (little|bit|touch|tad|hint)|little|gentle|gently|hint of|mild|mildly|barely|small|lightly)\b/.test(s)) return 0.35;
  if (/\b(extremely|very|super|really|totally|dramatically|heavily|fully|much|wide|massive|huge|exaggerated|extra|way)\b/.test(s)) return 1;
  if (/\b(more|noticeabl\w*|further|increase\w*|moderately)\b/.test(s)) return 0.7;
  return def;
}

function regionsIn(s, { colorAsFabric = false } = {}) {
  const out = [];
  if (/\bleft sleeve\b/.test(s)) out.push('leftSleeve');
  if (/\bright sleeve\b/.test(s)) out.push('rightSleeve');
  for (const [re, regs] of REGION_LEX) {
    if (re === REGION_LEX[1][0] || re === REGION_LEX[2][0]) continue;
    if (re.test(s)) {
      if (regs === SLEEVES && (out.includes('leftSleeve') || out.includes('rightSleeve'))) continue;
      out.push(...regs);
    }
  }
  if (colorAsFabric && /\b(colou?rs?|fabric|material|texture)\b/.test(s)) out.push('fabric');
  return uniq(out);
}

function colourIn(s) {
  // returns {name, hex, mods:{dark,light,bright,muted}} for the first colour word
  const m = s.match(new RegExp('\\b(?:(dark|deep|light|pale|pastel|bright|muted|dusty|sky|forest|off)[- ]?)?(' + COLOR_WORDS.join('|') + ')\\b'));
  if (!m) return null;
  let name = m[2];
  if (m[1] === 'sky' && name === 'blue') name = 'skyblue';
  if (m[1] === 'off' && name === 'white') name = 'offwhite';
  if (m[1] === 'forest' && name === 'green') name = 'forest';
  let hex = COLORS[name];
  const mod = m[1];
  if (mod === 'dark' || mod === 'deep') hex = shade(hex, -0.28);
  else if (mod === 'light' || mod === 'pale' || mod === 'pastel') hex = shade(hex, 0.35);
  else if (mod === 'dusty' || mod === 'muted') hex = shade(hex, 0.12);
  return { name: (mod && !['sky', 'forest', 'off'].includes(mod) ? mod + ' ' : '') + name.replace('skyblue', 'sky blue').replace('offwhite', 'off-white'), hex, index: m.index, length: m[0].length };
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt)));
  return '#' + c.map((v) => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ main */

export function parsePrompt(text) {
  const original = String(text == null ? '' : text).slice(0, 2000);
  const lower = original.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  const o = {
    params: {}, regions: [], keep: [], keepAllExcept: null, keepRest: false, keepColor: false, keepNotes: [],
    sleevePreset: undefined, fitPreset: undefined, fabric: undefined, fabricAmount: undefined, color: undefined,
    style: undefined, styleDegree: 0.8, collarStyle: undefined, garmentKind: undefined, sleeveFrom: undefined,
    removeParts: [], addElements: [], notes: [], unparsed: [], removeCuffs: false, flare: false,
    avoid: [], lock: [], extract: null, matchBackToFront: false, openHem: false
  };
  const setP = (k, v) => { o.params[k] = clamp(Math.round((o.params[k] || 0) + v)); };
  const reg = (...r) => o.regions.push(...r.flat());
  const note = (s) => o.notes.push(s);

  o.extract = detectExtract(lower);
  const clauses = splitClauses(lower, original);
  let understood = 0;

  for (const cl of clauses) {
    const ok = parseClause(cl.low, cl.raw, o, { setP, reg, note });
    if (ok) understood++; else o.unparsed.push(cl.raw.trim());
  }

  // ---- style preset resolution (explicit clause settings win)
  if (o.style) {
    const st = STYLES[o.style];
    const d = o.styleDegree;
    for (const [k, v] of Object.entries(st.params)) if (o.params[k] === undefined) setP(k, v * d);
    if (!o.fabric && st.fabric) { o.fabric = st.fabric; o.fabricAmount = clamp(st.fabricAmount * (0.5 + d * 0.5), 0, 1); }
    if (!o.fitPreset && st.fitPreset) o.fitPreset = st.fitPreset;
    if (!o.collarStyle && st.collarStyle) o.collarStyle = st.collarStyle;
    if (!o.color) {
      const c = {};
      for (const [k, v] of Object.entries(st.color)) c[k] = k === 'tint' ? v : (k === 'tintAmount' ? +(v * d / 0.8).toFixed(2) : Math.round(v * d / 0.8));
      o.color = c;
    }
    reg('body', 'leftSleeve', 'rightSleeve', 'fabric');
    if (st.collarStyle) reg('collar');
    o.palette = st.palette;
    note(`${st.label} style`);
  }

  // ---- keep / except resolution
  let keepAllExcept;
  if (o.keepAllExcept) keepAllExcept = uniq(o.keepAllExcept);
  else if (o.keepRest) keepAllExcept = uniq(o.regions);
  if (keepAllExcept) {
    o.regions = uniq([...o.regions, ...keepAllExcept]);
    const editable = new Set(o.regions);
    o.keep = uniq([...o.keep, ...REGION_NAMES.filter((r) => !editable.has(r))]);
    keepAllExcept = [...editable];
  }
  o.regions = uniq(o.regions).filter((r) => !o.keep.includes(r) || (keepAllExcept && keepAllExcept.includes(r)));
  o.keep = uniq(o.keep).filter((r) => !o.regions.includes(r));

  const paramDeltas = {};
  for (const [k, v] of Object.entries(o.params)) if (v && !o.lock.includes(k)) paramDeltas[k] = v;
  o.avoid = uniq(o.avoid);
  o.lock = uniq(o.lock);
  if (o.avoid.includes('cuffs') && o.sleevePreset === 'ribbedCuff') o.sleevePreset = 'openHem';

  const total = clauses.length;
  const confidence = total === 0 || understood === 0 ? 0 : +(0.35 + 0.65 * (understood / total)).toFixed(2);

  const result = {
    summary: o.notes.length ? capitalise(uniq(o.notes).join('; ')) + '.' : (original.trim() ? 'No recognised edit.' : ''),
    paramDeltas,
    regions: o.regions,
    keep: o.keep,
    addElements: o.addElements,
    confidence
  };
  if (o.sleevePreset) result.sleevePreset = o.sleevePreset;
  if (o.fitPreset) result.fitPreset = o.fitPreset;
  if (o.fabric) { result.fabric = o.fabric; result.fabricAmount = o.fabricAmount ?? 0.6; }
  if (o.color) result.color = o.color;
  if (keepAllExcept) result.keepAllExcept = keepAllExcept;
  if (o.style) result.style = o.style;
  if (o.palette) result.palette = o.palette;
  if (o.collarStyle) result.collarStyle = o.collarStyle;
  if (o.garmentKind) result.garmentKind = o.garmentKind;
  if (o.sleeveFrom) result.sleeveFrom = o.sleeveFrom;
  if (o.removeCuffs) result.removeCuffs = true;
  if (o.removeParts.length) result.removeParts = uniq(o.removeParts);
  if (o.keepColor) result.keepColor = true;
  if (o.keepNotes.length) result.keepNotes = o.keepNotes;
  if (o.unparsed.length) result.unparsed = o.unparsed;
  result.avoid = o.avoid;
  result.lock = o.lock;
  result.extract = o.extract;
  result.matchBackToFront = o.matchBackToFront;
  if (o.openHem) result.openHem = true;
  result.text = original;
  return result;
}

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function splitClauses(lower, original) {
  const out = [];
  const sentences = lower.split(/[.;!?\n]+/);
  // keep original casing aligned only for quoted text, so raw == lower slice by index
  let pos = 0;
  for (const sent of sentences) {
    const start = lower.indexOf(sent, pos);
    pos = start + sent.length;
    const parts = sent.split(/,|\bbut\b|\bthen\b|\balso\b|\band\b(?=\s+(?:please\s+)?(?:make|remove|give|add|change|keep|turn|let|set|use|get|swap|lose|drop|put|have)\b)/);
    let p = start;
    for (const part of parts) {
      const idx = lower.indexOf(part, p);
      p = idx + part.length;
      const cleaned = part.replace(/^\s*(and|plus|please|also|so)\s+/, '').trim();
      if (cleaned) out.push({ low: ' ' + cleaned + ' ', raw: original.slice(idx, idx + part.length) });
    }
  }
  return out;
}

// Lock words -> the shape params that must stay exactly as they are ("without changing the length").
const LOCK_WORDS = [
  [/^sleeve length$/, ['sleeveLength']], [/^sleeve width$/, ['sleeveWidth']],
  [/^(length|height)$/, ['bodyLength', 'cropLength']], [/^hem(line)?$/, ['bodyLength', 'cropLength', 'hemShape']],
  [/^width$/, ['bodyWidth']], [/^shoulders?$/, ['shoulderWidth']], [/^collar$/, ['collarSize']], [/^neck/, ['neckOpening']]
];
// Things a clause may ask us not to add: word -> canonical name (cuffs are the ribbed band the presets add).
const AVOID_WORDS = [
  [/^(cuffs?|ribs?|ribbing|ribbed)$/, 'cuffs'], [/^(logos?|crests?|badges?|emblems?)$/, 'logos'], [/^(text|lettering)$/, 'text'],
  [/^(stripes?|piping)$/, 'stripes'], [/^collars?$/, 'collar'], [/^hems?$/, 'hem']
];
const EXTRACT_TARGET = /\b(logos?|crests?|badges?|emblems?|text|lettering|wordmarks?|graphics?|artwork|racket|tennis|balls?|illustrations?|motifs?|prints?)\b/;
const EXTRACT_VERB = /\b(layers?|separate(?:ly)?|editable|extract\w*|lift\w*|isolate\w*)\b/;

// Extraction ("remove the logo ... and put it on a separate editable layer") is decided once for the whole prompt.
export function detectExtract(lower) {
  if (!EXTRACT_VERB.test(lower)) return null;
  const logo = /\b(logos?|crests?|badges?|emblems?)\b/.test(lower);
  const text = /\b(text|lettering|wordmarks?|typography)\b/.test(lower);
  const graphics = /\b(graphics?|artwork|racket|tennis|balls?|illustrations?|motifs?|prints?)\b/.test(lower);
  if (!logo && !text && !graphics) return null;
  return { logo, text, graphics, separateLayer: /\b(layers?|separate(?:ly)?|editable)\b/.test(lower) };
}

// Clause-level negotiation: lock / avoid / keep-unchanged / extraction / match-back-to-front.
// Returns {hit, consumed} where consumed means the whole clause was an extraction and must not be parsed as a removal.
function negotiate(s, o, { setP, reg, note, eat }) {
  let hit = false, consumed = false;
  // match the back to the front
  if (/\bback\b/.test(s) && (/\b(match\w*|same as|like)\s+the\s+front\b/.test(s) || /\bfront\b.*\bproportions?\b/.test(s))) {
    o.matchBackToFront = true; note('back matches front proportions'); hit = true;
  }
  // extraction of artwork into its own layer
  if (o.extract && (EXTRACT_TARGET.test(s) || EXTRACT_VERB.test(s))) {
    const what = [o.extract.logo && 'logo', o.extract.text && 'text', o.extract.graphics && 'graphics'].filter(Boolean);
    note(`lift ${what.join(' and ') || 'artwork'} onto ${o.extract.separateLayer ? 'a separate editable layer' : 'its own layer'}`);
    hit = true; consumed = true;
    return { hit, consumed };
  }
  // lock shape parameters ("without changing the length")
  const lockM = s.match(/\b(?:without|don'?t|do not|never)\s+(?:(?:changing|change|altering|alter|touching|touch|modifying|modify|affecting|affect|shortening|lengthening|making|moving)\s+)?(?:the\s+)?(sleeve length|sleeve width|length|height|hemline|hem|width|shoulders?|collar|neckline|neck opening|neck)\b/)
    || s.match(/\bkeep(?:ing)?\s+(?:the\s+)?(sleeve length|sleeve width|length|height|hemline|hem|width|shoulders?|collar|neckline)\s+(?:the\s+)?(?:same|unchanged|as is)\b/);
  if (lockM) {
    const word = lockM[1];
    const entry = LOCK_WORDS.find(([re]) => re.test(word));
    if (entry) {
      o.lock.push(...entry[1]); note(`keep the ${word} unchanged`); hit = true;
      if (!/^\s*(please\s+)?keep/.test(s)) eat(lockM[0]);   // "keep ..." clauses are also parsed by the keep branch
    }
  }
  // avoid adding things ("don't add cuffs", "no logo", "without ribbed cuffs")
  const avoidRe = /\b(?:don'?t|do not|never|avoid|without|no)\s+(?:(?:add|adding|put|putting|give|giving|include|including|use|using|have|having|any|a|an|the|extra|new)\s+)*(cuffs?|ribs?|ribbing|ribbed|logos?|crests?|badges?|emblems?|text|lettering|stripes?|piping|collars?|hems?)\b/;
  const avoidM = s.match(avoidRe);
  if (avoidM && !/\b(remove|take off|get rid of|delete|lose|drop)\b/.test(s)) {
    const entry = AVOID_WORDS.find(([re]) => re.test(avoidM[1]));
    if (entry) {
      o.avoid.push(entry[1]); note(`no ${entry[1]} added`); hit = true; eat(avoidM[0]);
      if (entry[1] === 'cuffs') { o.openHem = true; o.removeCuffs = true; o.sleevePreset = o.sleevePreset === 'ribbedCuff' ? 'openHem' : o.sleevePreset; }
    }
  }
  // "... unchanged / alone / as is" after a list of parts: those parts are kept
  const unch = s.match(/\b(unchanged|untouched|alone|as is|as they are)\b/);
  if (unch && !/^\s*(please\s+)?(keep|preserve|retain|leave|maintain)\b/.test(s)) {
    const regs = regionsIn(s.slice(0, unch.index), { colorAsFabric: false });
    if (regs.length) { regs.forEach((r) => o.keep.push(r)); note(`keep the ${regs.join(', ')} unchanged`); hit = true; eat(unch[0]); }
  }
  return { hit, consumed };
}

function parseClause(s, raw, o, { setP, reg, note }) {
  let hit = false;
  const eat = (re) => { s = s.replace(re, ' '); };
  const neg = negotiate(s, o, { setP, reg, note, eat });
  if (neg.hit) hit = true;
  if (neg.consumed) return true;

  /* ---- keep / preserve clauses ---- */
  const keepM = s.match(/^\s*(?:please\s+)?(keep|preserve|retain|leave|maintain|don'?t (?:change|touch|alter|modify)|do not (?:change|touch|alter|modify))\b(.*)$/);
  if (keepM) {
    const rest = keepM[2];
    const ex = rest.match(/\bexcept(?: for)?\b(.*)$/);
    if (/\b(everything|the rest|all else|anything else|the whole|it all|all of it|the overall)\b/.test(rest) || ex) {
      if (ex) {
        const regs = regionsIn(ex[1], { colorAsFabric: true });
        o.keepAllExcept = uniq([...(o.keepAllExcept || []), ...regs]);
        regs.forEach((r) => o.regions.push(r));
        note(`keep everything except ${regs.length ? ex[1].trim().replace(/^the\s+/, '') : 'the edited parts'}`);
      } else {
        o.keepRest = true;
        note('keep everything else unchanged');
      }
      return true;
    }
    const regs = regionsIn(rest, { colorAsFabric: false });
    regs.forEach((r) => o.keep.push(r));
    if (/\b(colou?rs?|colou?red|shade|palette)\b/.test(rest) || colourIn(rest)) o.keepColor = true;
    if (/\b(fabric|material)\b/.test(rest)) o.keep.push('fabric');
    const trait = rest.replace(/\b(the|same|as is|as they are)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (trait) o.keepNotes.push(trait);
    if (/\bflare|flared|bell\b/.test(rest) && !regs.length) o.keep.push(...SLEEVES);
    note(`keep ${trait || 'existing details'}`);
    return regs.length > 0 || o.keepColor || !!trait;
  }
  const onlyM = s.match(/^\s*(?:only|just)\s+(?:change|edit|touch|modify|adjust|alter|do|update)?\s*(?:the\s+)?(.*)$/);
  if (onlyM) {
    const regs = regionsIn(onlyM[1], { colorAsFabric: true });
    if (regs.length) {
      o.keepAllExcept = uniq([...(o.keepAllExcept || []), ...regs]);
      regs.forEach((r) => o.regions.push(r));
      note(`only change ${onlyM[1].trim()}`);
      hit = true;
      s = ' ' + onlyM[1] + ' ';
    }
  }

  const d = degree(s);
  const negated = /\b(remove|without|no|get rid of|lose|drop|delete|take off|take away|eliminate|ditch)\b/.test(s);

  /* ---- collar ---- */
  if (/\b(collar|neckline)\b/.test(s) || /\b(v[- ]?neck|crew neck|henley)\b/.test(s)) {
    if (/\b(remove|without|no|get rid of|lose|delete)\s+(?:the\s+)?(?:\w+\s+)?collar\b/.test(s)) {
      o.collarStyle = 'none'; setP('collarSize', -100); reg('collar'); note('remove the collar'); hit = true; eat(/collar/g);
    } else {
      const sty = COLLAR_STYLES.find(([re]) => re.test(s));
      if (!sty && /\b(vintage|retro|old[- ]school)\b/.test(s)) {
        o.collarStyle = 'vintage'; reg('collar'); note('vintage collar'); hit = true;
        eat(/\b(vintage|retro|old[- ]school)\b/g); eat(/\b(collar|neckline|neck)\b/g);
        const grow = /\b(wider|bigger|larger|broader|more|fuller|generous)\b/.test(s);
        setP('collarSize', grow ? Math.round(40 * degree(s, 0.6)) : 20);
        note(grow ? 'bigger collar' : 'collar size');
      } else if (sty) {
        o.collarStyle = sty[1];
        if (sty[2]) setP('collarSize', sty[2]);
        reg('collar'); if (['crew', 'vneck', 'henley'].includes(sty[1])) reg('neckline');
        note(`${sty[1] === 'vneck' ? 'V-neck' : sty[1]} collar`);
        hit = true;
        eat(/\b(vintage|retro|classic|old[- ]school)\b/g);
        eat(/\b(collar|neckline|neck)\b/g);
        eat(new RegExp('\\b(' + COLLAR_STYLES.map(([r]) => r.source).join('|') + ')\\b', 'g'));
      }
    }
  }

  /* ---- cuffs ---- */
  if (/\bcuffs?\b/.test(s)) {
    if (negated || /\b(open|loose|unfinished|raw)\b/.test(s)) {
      o.removeCuffs = true; o.removeParts.push('cuffs'); reg('cuffs');
      o.sleevePreset = o.sleevePreset || 'openHem'; note('remove the cuffs'); hit = true;
      eat(/\b(tight|ribbed|elastic|elasticated|fitted)?\s*cuffs?\b/g);
    } else if (/\b(add|give|with|ribbed|elastic|tight|fitted)\b/.test(s)) {
      o.sleevePreset = o.sleevePreset || 'ribbedCuff'; reg('cuffs'); note('ribbed cuffs'); hit = true; eat(/\bcuffs?\b/g);
    }
  }

  /* ---- sleeve flare / shape ---- */
  const sleeveCtx = /\bsleeves?\b|\bflare/.test(s);
  if (/\b(flare|flared|flaring|flares|bell|bell-shaped|trumpet)\b/.test(s) && sleeveCtx) {
    const fd = degree(s, 0.6);
    const unflare = /\b(remove|no|without|less|reduce|straighten)\b[^]*\bflare/.test(s) || /\bun-?flared?\b/.test(s);
    setP('sleeveFlare', (unflare ? -1 : 1) * Math.round(100 * fd));
    o.sleevePreset = unflare ? 'straight' : (fd <= 0.5 ? 'slightFlare' : (fd >= 0.9 ? 'wideFlare' : 'bell'));
    o.flare = true;
    reg(SLEEVES);
    if (/\b(wrist|toward|towards|cuff|end|bottom)\b/.test(s)) o.sleeveFrom = 'wrist';
    if (/\belbow\b/.test(s)) o.sleeveFrom = 'elbow';
    note(`${unflare ? 'straighten' : (fd <= 0.5 ? 'slightly flared' : fd >= 0.9 ? 'wide flared' : 'flared')} sleeves`);
    hit = true;
    eat(/\b(flare|flared|flaring|flares|bell|bell-shaped|trumpet)\b/g);
  } else if (/\bsleeves?\b/.test(s) && /\b(straight|tapered|taper|slim)\b/.test(s) && !/\b(fit|fitted)\b/.test(s)) {
    const tap = /\b(tapered|taper|slim)\b/.test(s);
    o.sleevePreset = tap ? 'tapered' : 'straight'; reg(SLEEVES); setP('sleeveWidth', tap ? -Math.round(60 * d) : 0);
    note(`${o.sleevePreset} sleeves`); hit = true; eat(/\b(straight|tapered|taper)\b/g);
  }

  /* ---- sleeve length / garment kind ---- */
  if (/\b(long[- ]?sleeves?|full[- ]length sleeves?|long[- ]sleeved)\b/.test(s)) {
    setP('sleeveLength', 85); o.garmentKind = 'longSleeve'; reg(SLEEVES, 'cuffs'); note('long sleeves'); hit = true;
    eat(/\blong[- ]?sleeve(d|s)?\b/g);
  } else if (/\b(short[- ]?sleeves?|short[- ]sleeved|t-?shirt sleeves?)\b/.test(s) || /\bsleeves?\b.*\bshort(er)?\b|\bshort(er)?\b.*\bsleeves?\b/.test(s)) {
    setP('sleeveLength', -Math.round(100 * degree(s, 0.65))); o.garmentKind = 'shortSleeve'; reg(SLEEVES); note('shorter sleeves'); hit = true;
    eat(/\bshort(er)?[- ]?(sleeves?|sleeved)?\b/g);
  } else if (/\b(sleeveless|tank|no sleeves|cut(?: off)? the sleeves)\b/.test(s)) {
    setP('sleeveLength', -100); o.garmentKind = 'sleeveless'; reg(SLEEVES); note('sleeveless'); hit = true;
  } else if (/\b(three[- ]quarter|3\/4|elbow[- ]length)\b/.test(s)) {
    setP('sleeveLength', 40); reg(SLEEVES); note('three-quarter sleeves'); hit = true;
  }

  /* ---- elements: piping, stripes, text, patches, logos ---- */
  const elRe = /\b(piping|pipe|binding|trim|stripes?|border|text|lettering|patch|badge|logo|crest|emblem)\b/;
  if (elRe.test(s) && !keepM) {
    const regs = regionsIn(s.replace(/\b(piping|pipe|trim|stripes?)\b/g, ' ')).filter((r) => r !== 'body' || /\b(body|chest|torso|front)\b/.test(s));
    if (negated) {
      const what = /logo|badge|crest|emblem/.test(s) ? 'logos' : (/text|lettering/.test(s) ? 'text' : 'stripes');
      o.removeParts.push(what); reg(what); note(`remove ${what}`); hit = true;
    } else if (/\b(add|put|give|with|include|place|sew|apply|stitch|embroider|print|down|along|across)\b/.test(s)) {
      const type = /logo|badge|crest|emblem/.test(s) ? 'logo' : /patch/.test(s) ? 'patch' : /text|lettering/.test(s) ? 'text'
        : /piping|pipe|binding|trim/.test(s) ? 'piping' : 'stripe';
      const col = colourIn(s);
      const quoted = raw.match(/["“']([^"”']{1,60})["”']/);
      let targets = regs.length ? regs : [type === 'text' || type === 'logo' || type === 'patch' ? 'body' : 'body'];
      if (/\bsleeves?\b/.test(s) && !targets.some((t) => SLEEVES.includes(t))) targets = [...targets, ...SLEEVES];
      const finalTargets = uniq(targets.filter((t) => t !== 'stripes'));
      for (const t of (finalTargets.length ? finalTargets : ['body'])) {
        const el = { type, region: t };
        if (col) el.color = col.hex;
        if (type === 'text' && quoted) el.text = quoted[1];
        o.addElements.push(el);
      }
      reg(finalTargets.length ? finalTargets : ['body']);
      reg('stripes');
      note(`add ${col ? col.name + ' ' : ''}${type === 'piping' ? 'piping' : type === 'stripe' ? 'stripes' : type}${finalTargets.length ? ' on ' + finalTargets.join('/') : ''}`);
      hit = true;
      if (col) s = s.slice(0, col.index) + ' ' + s.slice(col.index + col.length);
      eat(elRe);
    }
  }

  /* ---- hem / crop ---- */
  if (/\b(hem|hemline|bottom|waist|cropped|crop)\b/.test(s) && !/\bcrop(ped)?\s+(top)?\s*sleeves?\b/.test(s)) {
    const hasHem = /\b(hem|hemline|bottom)\b/.test(s);
    const up = /\b(cropped|crop|shorter|shorten|raise|higher|cut|shortened)\b/.test(s);
    const down = /\b(longer|lengthen|lower|drop|dropped|extend)\b/.test(s);
    const curve = s.match(/\b(curved|rounded|shirt-?tail|split|straight|boxy)\b/);
    if (hasHem || /\bcropped|crop\b/.test(s)) {
      if (up && !down) { setP('cropLength', Math.round(70 * d)); reg('hem', 'body'); note('cropped hem'); hit = true; eat(/\b(cropped|crop)\b/g); }
      else if (down) { setP('cropLength', -Math.round(70 * d)); reg('hem', 'body'); note('longer hem'); hit = true; }
      if (hasHem && curve && !/boxy/.test(curve[1])) { setP('hemShape', curve[1] === 'straight' ? -60 : 60); reg('hem'); note(`${curve[1]} hem`); hit = true; eat(/\b(curved|rounded|shirt-?tail|split|straight)\b/g); }
    }
  }

  /* ---- fit presets ---- */
  const fitHit = (() => {
    const fm = s.match(/\b(boxy|boxier|square|oversized|oversize|over-sized|baggy|baggier|slouchy|slim|slimmer|fitted|tailored|skinny|relaxed|loose|looser|regular fit|standard fit|cropped)\b/);
    return fm ? fm[1] : null;
  })();
  if (fitHit && !/\bsleeves?\b[^]*\b(loose|looser|slim|slimmer|fitted)\b/.test(s)) {
    let preset;
    if (/boxy|boxier|square/.test(fitHit)) preset = 'boxy';
    else if (/oversize|over-sized|baggy|baggier|slouchy/.test(fitHit)) preset = 'oversized';
    else if (/slim|fitted|tailored|skinny/.test(fitHit)) preset = 'slim';
    else if (/relaxed|loose|looser/.test(fitHit)) preset = 'relaxed';
    else if (/regular|standard/.test(fitHit)) preset = 'regular';
    else preset = 'cropped';
    const fd = degree(s, preset === 'oversized' ? 0.85 : 0.65);
    if (preset !== 'cropped' || o.params.cropLength === undefined) {
      // a body-only change ("boxy without changing the length") leaves the shoulders alone
      const bodyOnly = preset === 'boxy' && o.lock.includes('bodyLength');
      for (const [k, v] of Object.entries(FIT_DEFS[preset])) if (!(bodyOnly && k === 'shoulderWidth')) setP(k, v * fd);
      o.fitPreset = o.fitPreset || preset;
      reg('body');
      if (preset === 'oversized') reg('shoulders', SLEEVES);
      if (preset === 'relaxed') reg(SLEEVES);
      if (preset === 'slim') reg(SLEEVES);
      note(`${preset} fit`);
      hit = true;
      eat(new RegExp('\\b' + fitHit + '\\b', 'g'));
    }
  }

  /* ---- generic dimension changes (longer/wider/bigger...) ---- */
  const up = /\b(longer|wider|bigger|larger|looser|baggier|fuller|broader|extend\w*|increase\w*|more room)\b/.test(s);
  const down = /\b(shorter|narrower|smaller|tighter|slimmer|skinnier|trimmer|thinner|reduce\w*|narrow)\b/.test(s);
  if ((up || down) && !hit) {
    const sign = up ? 1 : -1;
    const amt = Math.round(70 * degree(s, 0.7)) * sign;
    const regs = regionsIn(s);
    const wide = /\b(wider|narrower|looser|baggier|tighter|slimmer|skinnier|trimmer|broader|thinner|fuller|narrow)\b/.test(s);
    const len = /\b(longer|shorter|extend\w*)\b/.test(s);
    let applied = false;
    const sl = regs.includes('leftSleeve') || regs.includes('rightSleeve');
    if (sl) {
      if (len) setP('sleeveLength', amt); else setP('sleeveWidth', amt);
      if (/\belbow\b/.test(s)) { o.sleeveFrom = 'elbow'; setP('sleeveShape', Math.round(50 * sign)); }
      else if (/\b(wrist|toward|towards|cuff)\b/.test(s)) { o.sleeveFrom = 'wrist'; setP('sleeveShape', Math.round(50 * sign)); }
      reg(SLEEVES); applied = true; note(`${up ? 'wider' : 'narrower'}${len ? ' (length)' : ''} sleeves${o.sleeveFrom ? ' from the ' + o.sleeveFrom : ''}`);
    }
    if (regs.includes('collar')) { setP('collarSize', amt); reg('collar'); applied = true; note(`${up ? 'bigger' : 'smaller'} collar`); }
    if (regs.includes('neckline')) { setP('neckOpening', amt); reg('neckline'); applied = true; note(`${up ? 'wider' : 'narrower'} neckline`); }
    if (regs.includes('shoulders')) { setP('shoulderWidth', amt); reg('shoulders'); applied = true; note(`${up ? 'broader' : 'narrower'} shoulders`); }
    if (regs.includes('hem')) { setP('cropLength', -amt); reg('hem'); applied = true; note(`${up ? 'longer' : 'shorter'} hem`); }
    if (regs.includes('body') || (!applied && /\b(it|this|that)\b/.test(s))) {
      if (len) setP('bodyLength', amt); else setP('bodyWidth', amt);
      reg('body'); applied = true; note(`${up ? (len ? 'longer' : 'wider') : (len ? 'shorter' : 'slimmer')} body`);
    }
    if (applied) hit = true;
  }

  /* ---- fabric ---- */
  const fabHit = FABRIC_RULES.find(([re]) => re.test(s));
  if (fabHit && !keepM) {
    const [fre, name] = fabHit;
    // do not treat "denim blue" etc. as fabric unless a fabric-ish cue or plain mention
    o.fabric = name; o.fabricAmount = name === 'heavyweightCotton' ? 0.75 : clamp(0.4 + 0.5 * d, 0, 1);
    reg('fabric'); note(`${name === 'heavyweightCotton' ? 'heavyweight cotton' : name} fabric`); hit = true;
    eat(fre);
  }

  /* ---- style presets ---- */
  if (!keepM) {
    for (const [key, st] of Object.entries(STYLES)) {
      if (st.re.test(s)) {
        o.style = key;
        o.styleDegree = degree(s, 0.8);
        hit = true;
        eat(st.re);
        break;
      }
    }
  }

  /* ---- colour / tone ---- */
  const col = colourIn(s);
  const colourCue = /\b(make|turn|change|colou?r|dye|recolou?r|repaint|paint|shade|tone|in|into|to|switch|swap|give|use|go)\b/.test(s);
  if (col && colourCue && !keepM) {
    o.color = { ...(o.color || {}), tint: col.hex, tintAmount: clamp(0.55 + d * 0.4, 0, 1) };
    reg('body', SLEEVES, 'fabric');
    note(`recolour to ${col.name}`); hit = true;
  }
  const tone = {};
  if (/\b(darker|dark|deeper)\b/.test(s) && !col) tone.light = -Math.round(40 * d);
  if (/\b(lighter|brighter|paler)\b/.test(s) && !col) tone.light = Math.round(35 * d);
  if (/\b(vibrant|saturated|vivid|punchier|richer|bolder colou?rs?)\b/.test(s)) tone.sat = Math.round(45 * d);
  if (/\b(muted|faded|washed|desaturat\w*|dull|softer colou?rs?|dusty)\b/.test(s) && !col) { tone.sat = -Math.round(45 * d); tone.light = (tone.light || 0) + Math.round(8 * d); }
  if (/\b(warmer|warm tone)\b/.test(s)) { tone.hue = -Math.round(15 * d); }
  if (/\b(cooler|cool tone)\b/.test(s)) { tone.hue = Math.round(15 * d); }
  if (Object.keys(tone).length) {
    o.color = { ...(o.color || {}), ...tone };
    reg('body', SLEEVES, 'fabric'); note('adjust colour tone'); hit = true;
  }

  return hit;
}
