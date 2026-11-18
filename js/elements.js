// Threadform - vector element model (text, logo, crest, graphic, stripe, piping, embroidery, print, patch).
// Elements are plain objects (ElementLayer) kept in state; rendering is cached per element.
// Coordinates: x,y = CENTRE of the element in the 1024x1024 working space; w,h = unrotated size; rotation in DEGREES.

const SIZE = 1024;
const PAD = 14; // internal raster padding (px at res 1) for shadows

let _id = 1;
export const ELEMENT_TYPES = ['text', 'logo', 'crest', 'graphic', 'stripe', 'piping', 'embroidery', 'print', 'patch'];
export const FONTS = [
  { label: 'Serif (Georgia)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Sans (Helvetica)', value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: 'Condensed (Impact)', value: 'Impact, "Arial Narrow", sans-serif' },
  { label: 'Script (Brush)', value: '"Brush Script MT", "Segoe Script", cursive' },
  { label: 'Mono (Courier)', value: '"Courier New", Courier, monospace' },
  { label: 'Slab (Rockwell)', value: 'Rockwell, "Courier New", Georgia, serif' },
  { label: 'Rounded (Trebuchet)', value: '"Trebuchet MS", Verdana, sans-serif' },
];

export class ElementLayer {
  constructor(type, props = {}) {
    this.id = 'el' + (_id++) + '_' + Math.random().toString(36).slice(2, 6);
    this.type = type;
    this.x = SIZE / 2; this.y = SIZE / 2; this.w = 200; this.h = 100; this.rotation = 0;
    this.props = props;
    this.view = 'front'; // 'front'|'back'|'side'|'detail'|'all'
    this.visible = true;
    this.locked = false;
    this.opacity = 1;   // 0..1, applied when drawn
    this.base = null;   // size when added ({w,h,size}); Scale % is relative to it
    this.name = type;
  }
  clone() {
    const e = new ElementLayer(this.type, { ...this.props });
    Object.assign(e, { x: this.x, y: this.y, w: this.w, h: this.h, rotation: this.rotation, view: this.view, visible: this.visible, locked: this.locked, name: this.name, opacity: this.opacity, base: this.base ? { ...this.base } : null });
    return e;
  }
  toJSON() {
    const p = { ...this.props }; if (p.image) { p.image = imageToDataURL(p.image); }
    return { id: this.id, type: this.type, x: this.x, y: this.y, w: this.w, h: this.h, rotation: this.rotation, props: p, view: this.view, visible: this.visible, locked: this.locked, name: this.name, opacity: this.opacity, base: this.base };
  }
  static fromJSON(o) {
    const e = new ElementLayer(o.type, { ...o.props });
    Object.assign(e, { id: o.id || e.id, x: o.x, y: o.y, w: o.w, h: o.h, rotation: o.rotation || 0, view: o.view || 'front', visible: o.visible !== false, locked: !!o.locked, name: o.name || o.type, opacity: o.opacity ?? 1, base: o.base || null });
    return e;
  }
}

/* ------------------------------------------------------------------ helpers */
function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
function hexToRgb(h) { h = String(h || '#000').replace('#', ''); if (h.length === 3) h = h.split('').map(x => x + x).join(''); const n = parseInt(h, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function toHex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function shade(hex, t) { const [r, g, b] = hexToRgb(hex); const tg = t >= 0 ? 255 : 0, a = Math.abs(t); return toHex(r + (tg - r) * a, g + (tg - g) * a, b + (tg - b) * a); }
function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function imageToDataURL(img) {
  if (!img) return null; if (typeof img === 'string') return img;
  try {
    if (img instanceof HTMLCanvasElement) return img.toDataURL('image/png');
    const c = mk(img.naturalWidth || img.width, img.naturalHeight || img.height); c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png');
  } catch (e) { return null; }
}
const _imgIds = new WeakMap(); let _imgN = 1;
function imgKey(img) { if (!img) return '0'; if (typeof img === 'string') return 's' + img.length + img.slice(-24); if (!_imgIds.has(img)) _imgIds.set(img, _imgN++); return 'i' + _imgIds.get(img); }

let _mctx = null;
function mctx() { if (!_mctx) _mctx = mk(8, 8).getContext('2d'); return _mctx; }

/* ------------------------------------------------------------------ graphic library */
// SVGs on a 100x100 viewBox. Colour placeholders {{c1}} {{c2}} {{c3}} are substituted from props.color/color2/color3.
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;
function star(cx, cy, R, r, n = 5, rot = -90) {
  const pts = []; for (let i = 0; i < n * 2; i++) { const a = (rot + i * 180 / n) * Math.PI / 180; const rr = i % 2 ? r : R; pts.push((cx + rr * Math.cos(a)).toFixed(2) + ',' + (cy + rr * Math.sin(a)).toFixed(2)); }
  return pts.join(' ');
}
function rays(cx, cy, r1, r2, n) {
  let d = ''; for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n, b = a + Math.PI / n * 0.5, c = a - Math.PI / n * 0.5; d += `M${(cx + r1 * Math.cos(c)).toFixed(1)} ${(cy + r1 * Math.sin(c)).toFixed(1)}L${(cx + r2 * Math.cos(a)).toFixed(1)} ${(cy + r2 * Math.sin(a)).toFixed(1)}L${(cx + r1 * Math.cos(b)).toFixed(1)} ${(cy + r1 * Math.sin(b)).toFixed(1)}Z`; }
  return d;
}
function laurel(side) {
  let out = '';
  for (let i = 0; i < 9; i++) {
    const phi = (i / 8) * 150 * Math.PI / 180;
    for (const k of [-1, 1]) {
      const rad = 34 + k * 4.5;
      const x = 50 + side * rad * Math.sin(phi), y = 50 + rad * Math.cos(phi);
      const al = Math.atan2(-side * Math.cos(phi), -Math.sin(phi)) * 180 / Math.PI + k * 28 * side * -1;
      out += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="3" ry="7" transform="rotate(${al.toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="{{c1}}"/>`;
    }
  }
  return out;
}
function wavePath(y, amp, n, w = 100) { let d = `M0 ${y}`; const step = w / n; for (let i = 0; i < n; i++) d += `q${step / 4} ${-amp} ${step / 2} 0 t${step / 2} 0`; return d; }
function greekKey(y) {
  // meander band
  let d = ''; for (let i = 0; i < 5; i++) { const x = 6 + i * 18; d += `M${x} ${y + 12}V${y}H${x + 12}V${y + 8}H${x + 4}V${y + 4}`; }
  return d;
}

export const GRAPHIC_LIBRARY = [
  { id: 'crest-shield', name: 'Classic shield', category: 'crest', colors: { c1: '#1f3a5f', c2: '#e8d9a8', c3: '#ffffff' },
    svg: svg(`<path d="M50 6 L88 16 V46 C88 68 70 84 50 94 C30 84 12 68 12 46 V16 Z" fill="{{c1}}" stroke="{{c2}}" stroke-width="3.5" stroke-linejoin="round"/><path d="M50 14 L80 22 V46 C80 63 66 76 50 85 C34 76 20 63 20 46 V22 Z" fill="none" stroke="{{c2}}" stroke-width="1.4"/><path d="M20 50 L50 36 L80 50 V60 L50 46 L20 60Z" fill="{{c2}}"/><polygon points="${star(50, 66, 9, 3.8)}" fill="{{c3}}"/>`) },
  { id: 'crest-laurel', name: 'Laurel wreath', category: 'crest', colors: { c1: '#3f6b3a', c2: '#c9a54b', c3: '#ffffff' },
    svg: svg(`${laurel(1)}${laurel(-1)}<circle cx="50" cy="50" r="22" fill="{{c2}}"/><polygon points="${star(50, 50, 15, 6.2)}" fill="{{c3}}"/>`) },
  { id: 'crest-crown', name: 'Crown crest', category: 'crest', colors: { c1: '#7b1e2b', c2: '#e2c36a', c3: '#ffffff' },
    svg: svg(`<path d="M20 38 L30 18 L42 34 L50 12 L58 34 L70 18 L80 38 Z" fill="{{c2}}" stroke="{{c1}}" stroke-width="2" stroke-linejoin="round"/><rect x="20" y="38" width="60" height="8" fill="{{c2}}" stroke="{{c1}}" stroke-width="2"/><circle cx="30" cy="16" r="3" fill="{{c1}}"/><circle cx="50" cy="10" r="3" fill="{{c1}}"/><circle cx="70" cy="16" r="3" fill="{{c1}}"/><path d="M26 52 H74 V68 C74 80 62 88 50 94 C38 88 26 80 26 68 Z" fill="{{c1}}" stroke="{{c2}}" stroke-width="3"/><path d="M38 62 H62 M38 72 H62" stroke="{{c3}}" stroke-width="3" stroke-linecap="round"/>`) },
  { id: 'crest-anchor', name: 'Anchor roundel', category: 'crest', colors: { c1: '#1d3557', c2: '#f1ede0', c3: '#c8a24b' },
    svg: svg(`<circle cx="50" cy="50" r="46" fill="{{c1}}"/><circle cx="50" cy="50" r="40" fill="none" stroke="{{c2}}" stroke-width="2"/><g fill="none" stroke="{{c2}}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><circle cx="50" cy="26" r="5"/><path d="M50 31 V72 M38 40 H62 M24 56 C26 72 38 78 50 78 C62 78 74 72 76 56 M24 56 L20 62 M24 56 L30 60 M76 56 L80 62 M76 56 L70 60"/></g>`) },
  { id: 'graphic-sun', name: 'Sunburst', category: 'graphic', colors: { c1: '#e8a317', c2: '#c4571a', c3: '#ffffff' },
    svg: svg(`<path d="${rays(50, 50, 28, 48, 16)}" fill="{{c1}}"/><circle cx="50" cy="50" r="24" fill="{{c1}}"/><circle cx="50" cy="50" r="17" fill="{{c2}}"/>`) },
  { id: 'graphic-wave', name: 'Aegean waves', category: 'graphic', colors: { c1: '#1c5d99', c2: '#7fb3d5', c3: '#ffffff' },
    svg: svg(`<g fill="none" stroke-linecap="round" stroke-width="5"><path d="${wavePath(30, 10, 4)}" stroke="{{c2}}" transform="translate(0,0)"/><path d="${wavePath(50, 10, 4)}" stroke="{{c1}}"/><path d="${wavePath(70, 10, 4)}" stroke="{{c2}}"/></g>`) },
  { id: 'graphic-star', name: 'Star badge', category: 'graphic', colors: { c1: '#b22222', c2: '#ffffff', c3: '#14213d' },
    svg: svg(`<circle cx="50" cy="50" r="46" fill="{{c1}}"/><circle cx="50" cy="50" r="38" fill="none" stroke="{{c2}}" stroke-width="2"/><polygon points="${star(50, 52, 30, 12)}" fill="{{c2}}"/>`) },
  { id: 'graphic-mountain', name: 'Mountains', category: 'graphic', colors: { c1: '#2f4858', c2: '#86a8b5', c3: '#f2cf66' },
    svg: svg(`<circle cx="68" cy="30" r="11" fill="{{c3}}"/><path d="M4 80 L36 30 L54 58 L66 42 L96 80 Z" fill="{{c1}}"/><path d="M36 30 L46 46 L40 44 L36 50 L30 42 Z" fill="{{c2}}"/><path d="M4 80 H96" stroke="{{c2}}" stroke-width="3"/>`) },
  { id: 'graphic-olive', name: 'Olive branch', category: 'graphic', colors: { c1: '#5b7d3a', c2: '#2d3b1f', c3: '#ffffff' },
    svg: svg(`<path d="M14 82 C34 60 56 40 86 18" fill="none" stroke="{{c2}}" stroke-width="3" stroke-linecap="round"/>${[0, 1, 2, 3, 4, 5].map(i => { const t = i / 5; const x = 22 + t * 56, y = 74 - t * 52; return `<ellipse cx="${(x - 5).toFixed(1)}" cy="${(y - 7).toFixed(1)}" rx="3.6" ry="9" transform="rotate(35 ${(x - 5).toFixed(1)} ${(y - 7).toFixed(1)})" fill="{{c1}}"/><ellipse cx="${(x + 6).toFixed(1)}" cy="${(y + 6).toFixed(1)}" rx="3.6" ry="9" transform="rotate(35 ${(x + 6).toFixed(1)} ${(y + 6).toFixed(1)})" fill="{{c1}}"/>`; }).join('')}<ellipse cx="86" cy="18" rx="3.6" ry="8" transform="rotate(48 86 18)" fill="{{c1}}"/>`) },
  { id: 'graphic-bolt', name: 'Lightning bolt', category: 'graphic', colors: { c1: '#f2c200', c2: '#1b1b1b', c3: '#ffffff' },
    svg: svg(`<path d="M58 4 L22 54 H44 L36 96 L78 40 H54 Z" fill="{{c1}}" stroke="{{c2}}" stroke-width="4" stroke-linejoin="round"/>`) },
  { id: 'graphic-heart', name: 'Heart', category: 'graphic', colors: { c1: '#d6336c', c2: '#ffffff', c3: '#000000' },
    svg: svg(`<path d="M50 88 C14 60 6 40 18 24 C30 10 46 16 50 30 C54 16 70 10 82 24 C94 40 86 60 50 88 Z" fill="{{c1}}"/><path d="M26 30 C30 24 38 24 40 30" fill="none" stroke="{{c2}}" stroke-width="3" stroke-linecap="round" opacity=".7"/>`) },
  { id: 'graphic-flower', name: 'Daisy', category: 'graphic', colors: { c1: '#f6f1e7', c2: '#e9b42d', c3: '#4f7a32' },
    svg: svg(`${Array.from({ length: 10 }, (_, i) => `<ellipse cx="50" cy="26" rx="7.5" ry="17" fill="{{c1}}" stroke="{{c3}}" stroke-width="1" transform="rotate(${i * 36} 50 50)"/>`).join('')}<circle cx="50" cy="50" r="11" fill="{{c2}}"/>`) },
  { id: 'graphic-greekkey', name: 'Greek key border', category: 'graphic', colors: { c1: '#1c3d6e', c2: '#1c3d6e', c3: '#ffffff' },
    svg: svg(`<g fill="none" stroke="{{c1}}" stroke-width="3" stroke-linejoin="miter" stroke-linecap="butt"><path d="${greekKey(26)}"/><path d="${greekKey(58)}"/></g><path d="M4 18 H96 M4 80 H96" stroke="{{c1}}" stroke-width="3"/>`) },
  { id: 'patch-varsity', name: 'Varsity letter patch', category: 'patch', colors: { c1: '#7d1f2b', c2: '#f3e9c6', c3: '#f3e9c6' },
    svg: svg(`<circle cx="50" cy="50" r="46" fill="{{c1}}" stroke="{{c2}}" stroke-width="4"/><circle cx="50" cy="50" r="39" fill="none" stroke="{{c2}}" stroke-width="1.6" stroke-dasharray="3 2"/><text x="50" y="68" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="54" fill="{{c3}}">T</text>`) },
  { id: 'patch-oval', name: 'Oval label EST.', category: 'patch', colors: { c1: '#264653', c2: '#e9c46a', c3: '#e9c46a' },
    svg: svg(`<ellipse cx="50" cy="50" rx="47" ry="32" fill="{{c1}}" stroke="{{c2}}" stroke-width="3.5"/><ellipse cx="50" cy="50" rx="41" ry="26" fill="none" stroke="{{c2}}" stroke-width="1.2" stroke-dasharray="2.5 2"/><text x="50" y="45" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="11.5" letter-spacing="0.6" fill="{{c3}}">THREADFORM</text><text x="50" y="62" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="11" fill="{{c3}}">est. 2026</text>`) },
  { id: 'stripes-varsity', name: 'Varsity stripes (3)', category: 'stripes', colors: { c1: '#7d1f2b', c2: '#f3e9c6', c3: '#7d1f2b' },
    svg: svg(`<rect x="0" y="12" width="100" height="18" fill="{{c1}}"/><rect x="0" y="41" width="100" height="18" fill="{{c2}}"/><rect x="0" y="70" width="100" height="18" fill="{{c3}}"/>`) },
  { id: 'stripes-sailor', name: 'Breton stripes', category: 'stripes', colors: { c1: '#1d3557', c2: '#f4f1e8', c3: '#1d3557' },
    svg: svg(`${Array.from({ length: 6 }, (_, i) => `<rect x="0" y="${6 + i * 15}" width="100" height="7.5" fill="{{c1}}"/>`).join('')}`) },
  { id: 'stripes-thinthick', name: 'Thick-thin stripes', category: 'stripes', colors: { c1: '#14213d', c2: '#fca311', c3: '#14213d' },
    svg: svg(`<rect x="0" y="18" width="100" height="26" fill="{{c1}}"/><rect x="0" y="52" width="100" height="8" fill="{{c2}}"/><rect x="0" y="68" width="100" height="14" fill="{{c3}}"/>`) },
];
export function getGraphic(id) { return GRAPHIC_LIBRARY.find(g => g.id === id) || null; }

function resolveSVG(el) {
  const p = el.props;
  let src = p.svg;
  const lib = getGraphic(p.graphicId);
  if (!src && lib) src = lib.svg;
  if (!src) return null;
  const cols = Object.assign({}, lib ? lib.colors : {}, p.colors || {});
  if (p.color) cols.c1 = p.color; if (p.color2) cols.c2 = p.color2; if (p.color3) cols.c3 = p.color3;
  return src.replace(/\{\{c([123])\}\}/g, (_, n) => cols['c' + n] || '#888');
}

/* ------------------------------------------------------------------ asset loading (SVG & image) */
const _svgImgs = new Map(); // svg string -> {img, ready, promise}
const _listeners = new Set();
export function onElementAssetsLoaded(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function svgImage(svgStr) {
  let r = _svgImgs.get(svgStr);
  if (!r) {
    const img = new Image(); r = { img, ready: false, failed: false };
    r.promise = new Promise(res => { img.onload = () => { r.ready = true; res(); _listeners.forEach(f => { try { f(); } catch (e) { } }); }; img.onerror = () => { r.failed = true; res(); }; });
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
    _svgImgs.set(svgStr, r);
  }
  return r;
}
function logoSource(el) {
  const im = el.props.image;
  if (!im) return null;
  if (typeof im === 'string') { // data URL / url
    let r = _svgImgs.get(im);
    if (!r) { const img = new Image(); r = { img, ready: false }; r.promise = new Promise(res => { img.onload = () => { r.ready = true; res(); _listeners.forEach(f => f()); }; img.onerror = res; }); img.src = im; _svgImgs.set(im, r); }
    return r.ready ? r.img : null;
  }
  return im;
}
/** Resolves when every SVG/image used by these elements has loaded (call before rasterising / exporting). */
export async function elementsReady(elements) {
  const ps = [];
  for (const el of elements || []) {
    const s = (['crest', 'graphic', 'patch', 'embroidery', 'print'].includes(el.type) ? resolveSVG(el) : null);
    if (s) ps.push(svgImage(s).promise);
    if (typeof el.props.image === 'string') { logoSource(el); const r = _svgImgs.get(el.props.image); if (r) ps.push(r.promise); }
    if (el.type === 'patch' && el.props.graphicId == null && el.props.svg) ps.push(svgImage(el.props.svg).promise);
  }
  await Promise.all(ps);
}

/* ------------------------------------------------------------------ create */
function textMetrics(p) {
  const c = mctx();
  c.font = `${p.italic ? 'italic ' : ''}${p.weight || 700} ${p.size}px ${p.font}`;
  try { c.letterSpacing = (p.letterSpacing || 0) + 'px'; } catch (e) { }
  const lines = String(p.text ?? '').split('\n');
  let w = 0; for (const l of lines) w = Math.max(w, c.measureText(l).width);
  try { c.letterSpacing = '0px'; } catch (e) { }
  return { w, lines, lh: p.size * 1.18 };
}
export function fitElement(el) {
  const p = el.props;
  if (['text', 'embroidery', 'print'].includes(el.type) && p.text != null && !p.graphicId && !p.svg) {
    const m = textMetrics(p);
    let w = m.w + 4, h = m.lh * m.lines.length;
    if (p.curve) {
      const th = Math.min(Math.abs(p.curve) / 100 * Math.PI * 1.3, Math.PI * 1.6);
      const r = m.w / th; const sag = r * (1 - Math.cos(th / 2));
      h = sag + p.size * 1.3; w = Math.max(m.w, 2 * r * Math.sin(Math.min(th, Math.PI) / 2)) + p.size * 0.4;
    }
    el.w = Math.max(10, w); el.h = Math.max(10, h);
  }
  return el;
}

const DEFAULTS = {
  text: { text: 'THREADFORM', font: FONTS[0].value, size: 72, color: '#1f2937', weight: 700, italic: false, letterSpacing: 2, curve: 0, outline: 0, outlineColor: '#ffffff' },
  logo: { image: null, opacity: 1 },
  crest: { graphicId: 'crest-shield' },
  graphic: { graphicId: 'graphic-sun' },
  stripe: { color: '#6b4423', color2: '#f3e9c6', count: 2, gapRatio: 0.7, ribbed: true },
  piping: { color: '#6b4423', thickness: 8, curve: 0, stitch: true },
  embroidery: { text: 'EST. 1989', font: FONTS[0].value, size: 56, color: '#c9a54b', weight: 700, italic: false, letterSpacing: 3, curve: 0, outline: 0 },
  print: { text: 'SUMMER', font: FONTS[2].value, size: 90, color: '#c4392b', weight: 400, italic: false, letterSpacing: 4, curve: 0, opacity: 0.95 },
  patch: { shape: 'round', bg: '#7d1f2b', border: '#f3e9c6', graphicId: null, text: 'T', textColor: '#f3e9c6', font: FONTS[0].value },
};
export function createElement(type, props = {}) {
  if (!ELEMENT_TYPES.includes(type)) throw new Error('Unknown element type: ' + type);
  const el = new ElementLayer(type, Object.assign({}, DEFAULTS[type], props));
  const p = el.props;
  if (props.x != null) el.x = props.x; if (props.y != null) el.y = props.y; if (props.view) el.view = props.view; if (props.rotation != null) el.rotation = props.rotation;
  delete p.x; delete p.y; delete p.view; delete p.rotation;
  el.name = ({ text: 'Text', logo: 'Logo', crest: 'Crest', graphic: 'Graphic', stripe: 'Stripes', piping: 'Piping', embroidery: 'Embroidery', print: 'Print', patch: 'Patch' })[type];
  switch (type) {
    case 'text': case 'embroidery': case 'print':
      if (p.graphicId || p.svg) { el.w = el.h = 200; } else fitElement(el);
      break;
    case 'logo': {
      const im = p.image; const iw = im ? (im.naturalWidth || im.width || 200) : 200, ih = im ? (im.naturalHeight || im.height || 200) : 200;
      const k = 220 / Math.max(iw, ih, 1); el.w = iw * k; el.h = ih * k; break;
    }
    case 'crest': case 'graphic': el.w = el.h = 200; break;
    case 'stripe': el.w = 360; el.h = 56; break;
    case 'piping': el.w = 360; el.h = 24; break;
    case 'patch': el.w = el.h = 170; if (p.shape === 'oval') { el.w = 220; el.h = 140; } break;
  }
  if (props.w) el.w = props.w; if (props.h) el.h = props.h;
  delete p.w; delete p.h;
  el.base = { w: el.w, h: el.h, size: p.size };
  return el;
}
/** Change props of an element (re-fits text boxes). */
export function updateElement(el, patch = {}) {
  Object.assign(el.props, patch); el._cache = null; fitElement(el); return el;
}

/* ------------------------------------------------------------------ rendering of one element to a canvas (local space) */
function setFont(ctx, p, size) { ctx.font = `${p.italic ? 'italic ' : ''}${p.weight || 700} ${size}px ${p.font}`; }

// draws (fill colour / pattern) text, honouring curve + multiline, centred at (cx,cy) in ctx space; mode: 'fill' | 'stroke'
function drawTextPath(ctx, p, cx, cy, mode, res) {
  const size = p.size * res;
  setFont(ctx, p, size);
  const ls = (p.letterSpacing || 0) * res;
  try { ctx.letterSpacing = ls + 'px'; } catch (e) { }
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  const lines = String(p.text ?? '').split('\n');
  const lh = size * 1.18;
  const doit = (t, x, y) => { if (mode === 'stroke') ctx.strokeText(t, x, y); else ctx.fillText(t, x, y); };
  if (!p.curve) {
    const y0 = cy - (lines.length - 1) * lh / 2 + size * 0.34;
    lines.forEach((l, i) => doit(l, cx, y0 + i * lh));
  } else {
    const t = lines.join(' ');
    // measure
    ctx.letterSpacing = '0px';
    const widths = [...t].map(ch => ctx.measureText(ch).width + ls);
    const W = widths.reduce((a, b) => a + b, 0);
    const th = Math.min(Math.abs(p.curve) / 100 * Math.PI * 1.3, Math.PI * 1.6);
    const r = W / th; const up = p.curve > 0;
    // circle centre: for up (arch), centre is below the text; text baseline on the circle
    const sag = r * (1 - Math.cos(th / 2));
    const hh = sag + size * 1.3;
    const ccy = up ? (cy - hh / 2 + size * 1.0 + r) : (cy + hh / 2 - size * 0.25 - r);
    let a = -th / 2;
    [...t].forEach((ch, i) => {
      const aw = widths[i] / r; const am = a + aw / 2; a += aw;
      ctx.save();
      if (up) { ctx.translate(cx + r * Math.sin(am), ccy - r * Math.cos(am)); ctx.rotate(am); }
      else { ctx.translate(cx - r * Math.sin(am), ccy + r * Math.cos(am)); ctx.rotate(-am); }
      ctx.textAlign = 'center'; doit(ch, 0, 0);
      ctx.restore();
    });
  }
  try { ctx.letterSpacing = '0px'; } catch (e) { }
}

function drawGraphicInto(ctx, el, x, y, w, h) {
  const s = resolveSVG(el); if (!s) return false;
  const r = svgImage(s);
  if (!r.ready) return false;
  ctx.drawImage(r.img, x, y, w, h);
  return true;
}

// thread texture over opaque pixels only
function stitchTexture(ctx, w, h, res, baseColor, angle = -35) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.translate(w / 2, h / 2); ctx.rotate(angle * Math.PI / 180);
  const L = Math.hypot(w, h);
  const step = 2.6 * res;
  for (let y = -L / 2; y < L / 2; y += step) {
    ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(-L / 2, y, L, 0.9 * res);
    ctx.fillStyle = 'rgba(255,255,255,0.20)'; ctx.fillRect(-L / 2, y + 1.2 * res, L, 0.8 * res);
  }
  // fibre noise (dashes)
  let s = 12345; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let i = 0; i < (w * h) / (60 * res * res); i++) ctx.fillRect(-L / 2 + rnd() * L, -L / 2 + rnd() * L, (3 + rnd() * 5) * res, 0.8 * res);
  ctx.restore();
}

let _speck = null;
function speckle(res) {
  if (_speck) return _speck;
  const c = mk(128, 128); const g = c.getContext('2d'); const id = g.createImageData(128, 128); let s = 777; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 128 * 128; i++) { const v = rnd(); id.data[i * 4 + 3] = v > 0.86 ? 255 * (v - 0.86) * 5 : 0; }
  g.putImageData(id, 0, 0); _speck = c; return c;
}

function renderElement(el, res) {
  const p = el.props; const pad = PAD * res;
  const W = Math.ceil(el.w * res + pad * 2), H = Math.ceil(el.h * res + pad * 2);
  const c = mk(W, H); const ctx = c.getContext('2d');
  const bx = pad, by = pad, bw = el.w * res, bh = el.h * res; const cx = bx + bw / 2, cy = by + bh / 2;
  c._pad = pad; c._complete = true;
  const isText = p.text != null && !p.graphicId && !p.svg;
  switch (el.type) {
    case 'text': {
      if (isText) {
        if (p.outline) { ctx.save(); ctx.lineJoin = 'round'; ctx.strokeStyle = p.outlineColor || '#fff'; ctx.lineWidth = p.outline * 2 * res; ctx.fillStyle = 'transparent'; drawTextPath(ctx, p, cx, cy, 'stroke', res); ctx.restore(); }
        ctx.fillStyle = p.color; drawTextPath(ctx, p, cx, cy, 'fill', res);
      } else if (!drawGraphicInto(ctx, el, bx, by, bw, bh)) c._complete = false;
      break;
    }
    case 'logo': {
      const im = logoSource(el);
      if (im) { ctx.globalAlpha = p.opacity ?? 1; ctx.drawImage(im, bx, by, bw, bh); } else if (p.image) c._complete = false;
      else { ctx.strokeStyle = '#888'; ctx.setLineDash([6 * res, 4 * res]); ctx.strokeRect(bx, by, bw, bh); ctx.fillStyle = '#888'; ctx.font = `${14 * res}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('logo', cx, cy); }
      break;
    }
    case 'crest': case 'graphic':
      if (!drawGraphicInto(ctx, el, bx, by, bw, bh)) c._complete = false;
      break;
    case 'stripe': renderStripe(ctx, el, bx, by, bw, bh, res); break;
    case 'piping': renderPiping(ctx, el, bx, by, bw, bh, res); break;
    case 'print': {
      const L = mk(W, H); const lc = L.getContext('2d');
      if (isText) { lc.fillStyle = p.color; drawTextPath(lc, p, cx, cy, 'fill', res); }
      else if (!drawGraphicInto(lc, el, bx, by, bw, bh)) c._complete = false;
      // ink: slight breakup + soft edge
      lc.globalCompositeOperation = 'destination-out'; lc.globalAlpha = 0.5;
      const sp = speckle(res); const pat = lc.createPattern(sp, 'repeat'); lc.fillStyle = pat; lc.save(); lc.scale(res, res); lc.fillRect(0, 0, W / res, H / res); lc.restore();
      ctx.globalAlpha = p.opacity ?? 0.95; ctx.filter = res >= 1 ? 'blur(0.3px)' : 'none'; ctx.drawImage(L, 0, 0); ctx.filter = 'none';
      break;
    }
    case 'embroidery': {
      const L = mk(W, H); const lc = L.getContext('2d');
      if (isText) {
        lc.fillStyle = p.color; drawTextPath(lc, p, cx, cy, 'fill', res);
        if (p.outline) { lc.lineJoin = 'round'; lc.strokeStyle = p.outlineColor || shade(p.color, -0.5); lc.lineWidth = p.outline * 2 * res; lc.globalCompositeOperation = 'destination-over'; drawTextPath(lc, p, cx, cy, 'stroke', res); lc.globalCompositeOperation = 'source-over'; }
      } else if (!drawGraphicInto(lc, el, bx, by, bw, bh)) c._complete = false;
      stitchTexture(lc, W, H, res, p.color);
      // satin border (dashed stitches along text edge)
      if (isText) { lc.save(); lc.globalCompositeOperation = 'source-atop'; lc.strokeStyle = shade(p.color, -0.35); lc.globalAlpha = 0.5; lc.lineWidth = 1.2 * res; lc.setLineDash([3 * res, 2 * res]); drawTextPath(lc, p, cx, cy, 'stroke', res); lc.restore(); }
      // raised look: shadow + highlight
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 3 * res; ctx.shadowOffsetX = 0.8 * res; ctx.shadowOffsetY = 1.6 * res; ctx.drawImage(L, 0, 0); ctx.restore();
      ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.18; ctx.drawImage(L, -0.7 * res, -0.9 * res); ctx.globalCompositeOperation = 'destination-in'; ctx.globalAlpha = 1; ctx.restore();
      break;
    }
    case 'patch': renderPatch(ctx, c, el, bx, by, bw, bh, res); break;
  }
  return c;
}

function renderStripe(ctx, el, bx, by, bw, bh, res) {
  const p = el.props; const n = Math.max(1, p.count | 0); const gr = p.gapRatio ?? 0.7;
  const unit = bh / (n + (n - 1) * gr); const gap = unit * gr;
  for (let i = 0; i < n; i++) {
    const y = by + i * (unit + gap);
    const col = i % 2 && p.color2 && p.alternate ? p.color2 : p.color;
    ctx.fillStyle = col; ctx.fillRect(bx, y, bw, unit);
    const g = ctx.createLinearGradient(0, y, 0, y + unit); g.addColorStop(0, 'rgba(255,255,255,0.16)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g; ctx.fillRect(bx, y, bw, unit);
    if (p.ribbed !== false) { ctx.fillStyle = 'rgba(0,0,0,0.10)'; for (let xx = bx; xx < bx + bw; xx += 3 * res) ctx.fillRect(xx, y, 1 * res, unit); }
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(bx, y + unit - 0.8 * res, bw, 0.8 * res);
  }
}
function pipingPath(el, ctx, bx, by, bw, bh, res) {
  const cv = (el.props.curve || 0) / 100 * (bh * 0 + bw * 0.25); const cy = by + bh / 2;
  ctx.beginPath(); ctx.moveTo(bx + 2 * res, cy + cv * 0.0); ctx.quadraticCurveTo(bx + bw / 2, cy - cv * 2, bx + bw - 2 * res, cy);
}
function renderPiping(ctx, el, bx, by, bw, bh, res) {
  const p = el.props; const t = p.thickness * res;
  ctx.lineCap = 'round';
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 3 * res; ctx.shadowOffsetY = 1.5 * res;
  ctx.strokeStyle = shade(p.color, -0.25); ctx.lineWidth = t; pipingPath(el, ctx, bx, by, bw, bh, res); ctx.stroke(); ctx.restore();
  ctx.strokeStyle = p.color; ctx.lineWidth = t * 0.82; pipingPath(el, ctx, bx, by, bw, bh, res); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = t * 0.22; ctx.save(); ctx.translate(0, -t * 0.2); pipingPath(el, ctx, bx, by, bw, bh, res); ctx.stroke(); ctx.restore();
  ctx.setLineDash([1.2 * res, 2.2 * res]); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = t * 0.8; ctx.lineCap = 'butt'; pipingPath(el, ctx, bx, by, bw, bh, res); ctx.stroke(); ctx.setLineDash([]);
  if (p.stitch !== false) { ctx.save(); ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.9 * res; ctx.setLineDash([3 * res, 2.2 * res]); for (const s of [-1, 1]) { ctx.save(); ctx.translate(0, s * (t * 0.5 + 3 * res)); pipingPath(el, ctx, bx, by, bw, bh, res); ctx.stroke(); ctx.restore(); } ctx.restore(); }
}
function patchShapePath(ctx, shape, x, y, w, h, inset = 0) {
  x += inset; y += inset; w -= inset * 2; h -= inset * 2;
  ctx.beginPath();
  if (shape === 'round') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (shape === 'oval') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (shape === 'shield') { ctx.moveTo(x, y + h * 0.05); ctx.lineTo(x + w, y + h * 0.05); ctx.lineTo(x + w, y + h * 0.5); ctx.quadraticCurveTo(x + w, y + h * 0.88, x + w / 2, y + h); ctx.quadraticCurveTo(x, y + h * 0.88, x, y + h * 0.5); ctx.closePath(); }
  else { const r = Math.min(w, h) * 0.14; ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
}
function renderPatch(ctx, canvas, el, bx, by, bw, bh, res) {
  const p = el.props; const e = 6 * res;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 5 * res; ctx.shadowOffsetY = 2.5 * res;
  patchShapePath(ctx, p.shape, bx, by, bw, bh); ctx.fillStyle = p.border; ctx.fill(); ctx.restore();
  // merrow border (dense stitch)
  patchShapePath(ctx, p.shape, bx, by, bw, bh, 0); ctx.save(); ctx.clip();
  ctx.lineWidth = e * 2; ctx.strokeStyle = p.border; patchShapePath(ctx, p.shape, bx, by, bw, bh, 0); ctx.stroke();
  ctx.setLineDash([1.1 * res, 1.1 * res]); ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();
  // face
  ctx.save(); patchShapePath(ctx, p.shape, bx, by, bw, bh, e); ctx.fillStyle = p.bg; ctx.fill(); ctx.clip();
  // twill texture
  ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.save(); ctx.translate(bx + bw / 2, by + bh / 2); ctx.rotate(Math.PI / 4); const L = Math.hypot(bw, bh); for (let y = -L / 2; y < L / 2; y += 2.4 * res) ctx.fillRect(-L / 2, y, L, 0.9 * res); ctx.restore();
  const g = ctx.createLinearGradient(0, by, 0, by + bh); g.addColorStop(0, 'rgba(255,255,255,0.14)'); g.addColorStop(1, 'rgba(0,0,0,0.18)'); ctx.fillStyle = g; ctx.fillRect(bx, by, bw, bh);
  ctx.restore();
  // inner stitch line
  ctx.save(); patchShapePath(ctx, p.shape, bx, by, bw, bh, e + 4 * res); ctx.setLineDash([3 * res, 2 * res]); ctx.strokeStyle = p.border; ctx.globalAlpha = 0.7; ctx.lineWidth = 1.1 * res; ctx.stroke(); ctx.restore();
  // content
  if (p.graphicId || p.svg) {
    const fake = { props: { graphicId: p.graphicId, svg: p.svg, colors: p.colors, color: p.color1 } };
    const s = resolveSVG(fake); if (s) { const r = svgImage(s); if (r.ready) ctx.drawImage(r.img, bx + bw * 0.2, by + bh * 0.2, bw * 0.6, bh * 0.6); else canvas._complete = false; }
  } else if (p.text) {
    ctx.save(); ctx.fillStyle = p.textColor; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = Math.min(bh * 0.5, (bw * 0.7) / Math.max(1, p.text.length * 0.6)); ctx.font = `700 ${fs}px ${p.font}`;
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 1.5 * res; ctx.shadowOffsetY = res;
    ctx.fillText(p.text, bx + bw / 2, by + bh / 2 + fs * 0.05); ctx.restore();
  }
}

function cacheKey(el, res) {
  const p = el.props; const parts = [];
  for (const k of Object.keys(p).sort()) { const v = p[k]; parts.push(k + '=' + (k === 'image' ? imgKey(v) : (typeof v === 'object' ? JSON.stringify(v) : v))); }
  return `${el.type}|${Math.round(el.w * 10)}|${Math.round(el.h * 10)}|${res}|${parts.join('&')}`;
}
function getRaster(el, res) {
  const key = cacheKey(el, res);
  if (el._cache && el._cache.key === key && el._cache.canvas._complete) return el._cache.canvas;
  const canvas = renderElement(el, res);
  el._cache = { key, canvas };
  return canvas;
}
/** Rasterise one element to a canvas of (w*scale + 2*pad) square-ish size; canvas._pad tells the padding in px. */
export function rasteriseElement(el, scale = 1) { return getRaster(el, scale); }
export const rasterizeElement = rasteriseElement;

/* ------------------------------------------------------------------ drawing */
const inView = (el, view) => el.visible !== false && (!el.view || el.view === 'all' || el.view === view);
export function handlesFor(el, hs = 1) {
  const hw = el.w / 2, hh = el.h / 2; const cos = Math.cos(el.rotation * Math.PI / 180), sin = Math.sin(el.rotation * Math.PI / 180);
  const T = (lx, ly) => ({ x: el.x + lx * cos - ly * sin, y: el.y + lx * sin + ly * cos });
  return { 'scale-nw': T(-hw, -hh), 'scale-ne': T(hw, -hh), 'scale-sw': T(-hw, hh), 'scale-se': T(hw, hh), rotate: T(0, -hh - 30 * hs), top: T(0, -hh) };
}
export function drawElements(ctx, elements, view, opts = {}) {
  const { selectedId = null, handles = false, res = 1 } = opts;
  for (const el of elements || []) {
    if (!inView(el, view)) continue;
    const r = getRaster(el, res); const pad = r._pad / res;
    ctx.save();
    ctx.translate(el.x, el.y); ctx.rotate(el.rotation * Math.PI / 180);
    ctx.globalAlpha = el.opacity ?? 1;
    ctx.drawImage(r, -el.w / 2 - pad, -el.h / 2 - pad, el.w + pad * 2, el.h + pad * 2);
    ctx.restore();
  }
  if (handles && selectedId) {
    const el = elements.find(e => e.id === selectedId);
    if (el && inView(el, view)) drawSelection(ctx, el, opts.handleScale || 1);
  }
}
export function drawSelection(ctx, el, k = 1) {
  const h = handlesFor(el, k); const hs = 7 * k;
  ctx.save();
  ctx.lineWidth = 1.5 * k; ctx.strokeStyle = '#2d7ff9'; ctx.setLineDash([6 * k, 4 * k]);
  ctx.beginPath(); ['scale-nw', 'scale-ne', 'scale-se', 'scale-sw'].forEach((n, i) => i ? ctx.lineTo(h[n].x, h[n].y) : ctx.moveTo(h[n].x, h[n].y)); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(h.top.x, h.top.y); ctx.lineTo(h.rotate.x, h.rotate.y); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2d7ff9'; ctx.lineWidth = 2 * k;
  for (const n of ['scale-nw', 'scale-ne', 'scale-se', 'scale-sw']) { ctx.beginPath(); ctx.rect(h[n].x - hs, h[n].y - hs, hs * 2, hs * 2); ctx.fill(); ctx.stroke(); }
  ctx.beginPath(); ctx.arc(h.rotate.x, h.rotate.y, hs, 0, Math.PI * 2); ctx.fillStyle = '#2d7ff9'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ hit testing & manipulation */
function toLocal(el, x, y) {
  const a = -el.rotation * Math.PI / 180; const dx = x - el.x, dy = y - el.y;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}
/**
 * hitTest(elements, view, x, y, {selectedId, handleSize=14}) -> {element, handle}|null
 * handle: 'rotate' | 'scale-nw|ne|sw|se' (only for the selected element) | 'move'
 */
export function hitTest(elements, view, x, y, opts = {}) {
  const hsz = opts.handleSize ?? 14;
  if (opts.selectedId) {
    const el = elements.find(e => e.id === opts.selectedId);
    if (el && inView(el, view) && !el.locked) {
      const h = handlesFor(el, opts.handleScale || 1);
      for (const n of ['rotate', 'scale-nw', 'scale-ne', 'scale-sw', 'scale-se']) if (Math.hypot(h[n].x - x, h[n].y - y) <= hsz) return { element: el, handle: n };
    }
  }
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]; if (!inView(el, view)) continue;
    const l = toLocal(el, x, y); const m = Math.min(4, Math.min(el.w, el.h) * 0.1);
    if (Math.abs(l.x) <= el.w / 2 + m && Math.abs(l.y) <= el.h / 2 + m) return { element: el, handle: 'move' };
  }
  return null;
}
export function moveElement(el, dx, dy) { el.x += dx; el.y += dy; return el; }
/** scale by factor (sx, sy defaults to sx = uniform). Text sizes follow. */
export function scaleElement(el, sx, sy = sx) {
  el.w *= sx; el.h *= sy;
  if (el.props.size && (el.type === 'text' || el.type === 'embroidery' || el.type === 'print') && !el.props.graphicId) { el.props.size = Math.max(4, el.props.size * (sx + sy) / 2); fitElement(el); }
  el.w = Math.max(6, el.w); el.h = Math.max(4, el.h);
  return el;
}
/** rotate by delta degrees; rotateElementTo sets from pointer position (for the rotate handle). */
export function rotateElement(el, deltaDeg) { el.rotation = ((el.rotation + deltaDeg) % 360 + 360) % 360; return el; }
export function rotateElementTo(el, px, py, snap = 0) {
  let a = Math.atan2(py - el.y, px - el.x) * 180 / Math.PI + 90; a = ((a % 360) + 360) % 360;
  if (snap) { const s = Math.round(a / snap) * snap; if (Math.abs(s - a) < 4) a = s % 360; }
  el.rotation = a; return el;
}
/** Convenience drag: const d = beginDrag(el, handle, x, y); dragTo(d, x, y). */
export function beginDrag(el, handle, x, y) { return { el, handle, sx: x, sy: y, ox: el.x, oy: el.y, w: el.w, h: el.h, size: el.props.size, rot: el.rotation, d0: Math.hypot(x - el.x, y - el.y) || 1 }; }
export function dragTo(d, x, y) {
  const el = d.el;
  if (d.handle === 'move') { el.x = d.ox + x - d.sx; el.y = d.oy + y - d.sy; }
  else if (d.handle === 'rotate') rotateElementTo(el, x, y, 15);
  else if (d.handle && d.handle.startsWith('scale')) {
    const k = Math.max(0.05, Math.hypot(x - d.ox, y - d.oy) / d.d0);
    el.w = d.w; el.h = d.h; if (d.size != null) el.props.size = d.size; scaleElement(el, k);
  }
  return el;
}

/* ------------------------------------------------------------------ SVG export */
function svgTextAttrs(p) {
  return `font-family="${xmlEsc(p.font)}" font-size="${p.size}" font-weight="${p.weight || 700}"${p.italic ? ' font-style="italic"' : ''}${p.letterSpacing ? ` letter-spacing="${p.letterSpacing}"` : ''}`;
}
function svgTextBlock(el, fill, extra = '') {
  const p = el.props; const lines = String(p.text ?? '').split('\n'); const lh = p.size * 1.18;
  const stroke = p.outline ? ` stroke="${p.outlineColor || '#fff'}" stroke-width="${p.outline * 2}" paint-order="stroke" stroke-linejoin="round"` : '';
  if (p.curve) {
    const m = textMetrics(p); const th = Math.min(Math.abs(p.curve) / 100 * Math.PI * 1.3, Math.PI * 1.6); const r = m.w / th; const id = 'tp_' + el.id;
    const up = p.curve > 0; const sag = r * (1 - Math.cos(th / 2)); const hh = sag + p.size * 1.3;
    const cy = up ? (-hh / 2 + p.size * 1.0 + r) : (hh / 2 - p.size * 0.25 - r);
    const x0 = -r * Math.sin(th / 2), x1 = r * Math.sin(th / 2); const yy = up ? cy - r * Math.cos(th / 2) : cy + r * Math.cos(th / 2);
    const d = `M${x0.toFixed(2)} ${yy.toFixed(2)} A${r.toFixed(2)} ${r.toFixed(2)} 0 ${th > Math.PI ? 1 : 0} ${up ? 1 : 0} ${x1.toFixed(2)} ${yy.toFixed(2)}`;
    return `<defs><path id="${id}" d="${d}"/></defs><text ${svgTextAttrs(p)} fill="${fill}"${stroke}${extra} text-anchor="middle"><textPath href="#${id}" startOffset="50%">${xmlEsc(String(p.text).replace(/\n/g, ' '))}</textPath></text>`;
  }
  const y0 = -(lines.length - 1) * lh / 2 + p.size * 0.34;
  return `<text ${svgTextAttrs(p)} fill="${fill}"${stroke}${extra} text-anchor="middle">${lines.map((l, i) => `<tspan x="0" y="${(y0 + i * lh).toFixed(2)}">${xmlEsc(l)}</tspan>`).join('')}</text>`;
}
function innerSVG(el) {
  const p = el.props; const hw = el.w / 2, hh = el.h / 2; const isText = p.text != null && !p.graphicId && !p.svg;
  const gfx = () => { const s = resolveSVG(el); if (!s) return ''; return s.replace(/<svg[^>]*>/, `<svg x="${-hw}" y="${-hh}" width="${el.w}" height="${el.h}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">`); };
  switch (el.type) {
    case 'text': return isText ? svgTextBlock(el, p.color) : gfx();
    case 'logo': { const u = imageToDataURL(p.image); return u ? `<image x="${-hw}" y="${-hh}" width="${el.w}" height="${el.h}" href="${u}" opacity="${p.opacity ?? 1}"/>` : ''; }
    case 'crest': case 'graphic': return gfx();
    case 'print': return `<g opacity="${p.opacity ?? 0.95}">${isText ? svgTextBlock(el, p.color) : gfx()}</g>`;
    case 'embroidery': {
      const pid = 'stitch_' + el.id;
      const defs = `<defs><pattern id="${pid}" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="3" height="3" fill="${p.color}"/><rect width="3" height="1" fill="#000" opacity=".28"/><rect y="1.3" width="3" height="0.8" fill="#fff" opacity=".2"/></pattern><filter id="sh_${el.id}" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0.6" dy="1.4" stdDeviation="1.4" flood-opacity=".45"/></filter></defs>`;
      return defs + `<g filter="url(#sh_${el.id})">` + (isText ? svgTextBlock(el, `url(#${pid})`, ` stroke="${shade(p.color, -0.35)}" stroke-width="0.6" stroke-dasharray="3 2"`) : gfx()) + '</g>';
    }
    case 'stripe': {
      const n = Math.max(1, p.count | 0), gr = p.gapRatio ?? 0.7, unit = el.h / (n + (n - 1) * gr), gap = unit * gr; let s = '';
      for (let i = 0; i < n; i++) s += `<rect x="${-hw}" y="${(-hh + i * (unit + gap)).toFixed(2)}" width="${el.w}" height="${unit.toFixed(2)}" fill="${i % 2 && p.color2 && p.alternate ? p.color2 : p.color}"/>`;
      return s;
    }
    case 'piping': { const cv = (p.curve || 0) / 100 * el.w * 0.25; return `<path d="M${-hw + 2} 0 Q0 ${(-cv * 2).toFixed(2)} ${hw - 2} 0" fill="none" stroke="${p.color}" stroke-width="${p.thickness}" stroke-linecap="round"/>`; }
    case 'patch': {
      const shape = p.shape; let outer, inner; const e = 6;
      const mk2 = (x, y, w, h) => shape === 'round' || shape === 'oval' ? `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"` : shape === 'shield' ? `<path d="M${x} ${y + h * .05}H${x + w}V${y + h * .5}Q${x + w} ${y + h * .88} ${x + w / 2} ${y + h}Q${x} ${y + h * .88} ${x} ${y + h * .5}Z"` : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w, h) * .14}"`;
      let s = mk2(-hw, -hh, el.w, el.h) + ` fill="${p.border}"/>` + mk2(-hw + e, -hh + e, el.w - e * 2, el.h - e * 2) + ` fill="${p.bg}"/>` + mk2(-hw + e + 4, -hh + e + 4, el.w - 2 * e - 8, el.h - 2 * e - 8) + ` fill="none" stroke="${p.border}" stroke-width="1.1" stroke-dasharray="3 2" opacity=".7"/>`;
      if (p.graphicId || p.svg) { const fake = { props: { graphicId: p.graphicId, svg: p.svg, colors: p.colors, color: p.color1 } }; const g = resolveSVG(fake); if (g) s += g.replace(/<svg[^>]*>/, `<svg x="${-hw * 0.6}" y="${-hh * 0.6}" width="${el.w * 0.6}" height="${el.h * 0.6}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">`); }
      else if (p.text) s += `<text x="0" y="0" dy=".35em" text-anchor="middle" font-family="${xmlEsc(p.font)}" font-weight="700" font-size="${Math.min(el.h * .5, el.w * .7 / Math.max(1, p.text.length * .6)).toFixed(1)}" fill="${p.textColor}">${xmlEsc(p.text)}</text>`;
      return s;
    }
  }
  return '';
}
/** Editable SVG fragment: one <g> per element, positioned with translate/rotate. */
export function elementsToSVG(elements, view, size = SIZE, opts = {}) {
  const body = (elements || []).filter(e => inView(e, view)).map(el =>
    `<g id="${el.id}" data-type="${el.type}" data-name="${xmlEsc(el.name || el.type)}" transform="translate(${el.x.toFixed(2)} ${el.y.toFixed(2)}) rotate(${el.rotation.toFixed(2)})"${el.opacity != null && el.opacity < 1 ? ` opacity="${el.opacity}"` : ''}>${innerSVG(el)}</g>`).join('\n');
  if (opts.fragment) return body;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${SIZE} ${SIZE}">\n${body}\n</svg>`;
}
