// Threadform - exports: PNG (hi-res), editable SVG, design sheet, per-view images, download helper.
import { drawElements, elementsToSVG, elementsReady } from './elements.js';

const SIZE = 1024;
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; };
const toBlob = (c, type = 'image/png', q) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), type, q));
const asCanvas = v => (v && (v.current || v.canvas)) || v || null;

function compose(base, elements, view, scale, transparent) {
  const out = mk(SIZE * scale, SIZE * scale); const ctx = out.getContext('2d');
  if (!transparent) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height); }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  if (base) ctx.drawImage(base, 0, 0, out.width, out.height);
  ctx.save(); ctx.scale(scale, scale);
  drawElements(ctx, elements || [], view, { handles: false, res: scale });
  ctx.restore();
  return out;
}

/** PNG of garment + elements. scale 1|2|4 (1024/2048/4096px). */
export async function exportPNG({ baseCanvas, elements = [], view = 'front', scale = 1, transparent = true } = {}) {
  await elementsReady(elements);
  return toBlob(compose(asCanvas(baseCanvas), elements, view, scale, transparent));
}

/** Editable SVG: <g id="design-elements"> (vector) over <g id="garment-bitmap"> (embedded PNG, optional baseCanvas). */
export function exportSVG({ elements = [], view = 'front', baseCanvas = null, size = SIZE, title = 'Threadform design' } = {}) {
  const base = asCanvas(baseCanvas);
  let img = '';
  if (base) { try { img = `<g id="garment-bitmap"><image x="0" y="0" width="${SIZE}" height="${SIZE}" xlink:href="${base.toDataURL('image/png')}"/></g>\n`; } catch (e) { } }
  const frag = elementsToSVG(elements, view, size, { fragment: true });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${SIZE} ${SIZE}">\n<title>${title.replace(/[<&]/g, '')}</title>\n${img}<g id="design-elements">\n${frag}\n</g>\n</svg>\n`;
}

/** One blob per view -> [{view, name, blob}] (no zip). views: {front:canvas|{current}, back:...}. */
export async function exportViewImages({ views, elements = [], scale = 1, transparent = true, only = ['front', 'back'], name = 'threadform' } = {}) {
  const out = [];
  for (const v of only) {
    const c = asCanvas(views && views[v]); if (!c) continue;
    out.push({ view: v, name: `${name}-${v}${scale > 1 ? '@' + scale + 'x' : ''}.png`, blob: await exportPNG({ baseCanvas: c, elements, view: v, scale, transparent }) });
  }
  return out;
}
export const exportFrontBack = exportViewImages;

/* ------------------------------------------------------------------ colour extraction */
const NAMES = [['White', 255, 255, 255], ['Cream', 239, 230, 210], ['Ivory', 250, 246, 232], ['Beige', 214, 196, 165], ['Sand', 194, 170, 130], ['Light grey', 190, 190, 190], ['Grey', 128, 128, 128], ['Charcoal', 60, 62, 66], ['Black', 20, 20, 22], ['Navy', 28, 44, 84], ['Blue', 44, 96, 190], ['Sky blue', 130, 180, 225], ['Teal', 30, 130, 130], ['Green', 50, 130, 70], ['Olive', 110, 120, 60], ['Forest', 34, 70, 44], ['Yellow', 235, 200, 50], ['Mustard', 200, 150, 30], ['Orange', 230, 120, 40], ['Rust', 170, 80, 40], ['Mocha', 131, 101, 75], ['Taupe', 152, 148, 136], ['Brown', 107, 68, 35], ['Chocolate', 70, 42, 24], ['Red', 200, 45, 45], ['Burgundy', 110, 30, 44], ['Pink', 235, 140, 170], ['Purple', 110, 60, 150], ['Lavender', 180, 160, 215]];
function colourName(r, g, b) { let best = null, bd = 1e9; for (const [n, R, G, B] of NAMES) { const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2; if (d < bd) { bd = d; best = n; } } return best; }
const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Dominant colours of the opaque garment pixels -> [{hex,name,share}] */
export function extractSwatches(canvas, max = 6) {
  const s = mk(128, 128); const sc = s.getContext('2d'); sc.drawImage(canvas, 0, 0, 128, 128);
  const d = sc.getImageData(0, 0, 128, 128).data; const bins = new Map(); let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue; total++;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; bins.set(k, b);
  }
  const list = [...bins.values()].map(b => ({ n: b.n, r: b.r / b.n, g: b.g / b.n, b: b.b / b.n })).sort((a, b) => b.n - a.n);
  const picked = [];
  for (const c of list) {
    const near = picked.find(p => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) < 46);
    if (near) { near.n += c.n; continue; }
    picked.push({ ...c });
  }
  picked.sort((a, b) => b.n - a.n);
  return picked.filter(p => p.n / Math.max(1, total) > 0.012).slice(0, max).map(p => ({ hex: hex(p.r, p.g, p.b), name: colourName(p.r, p.g, p.b), share: p.n / Math.max(1, total) }));
}

/* ------------------------------------------------------------------ design sheet */
const PARAM_LABELS = { bodyWidth: 'Body width', bodyLength: 'Body length', shoulderWidth: 'Shoulder width', sleeveLength: 'Sleeve length', sleeveWidth: 'Sleeve width', sleeveFlare: 'Sleeve flare', sleeveShape: 'Sleeve shape', collarSize: 'Collar size', neckOpening: 'Neck opening', hemShape: 'Hem shape', cropLength: 'Crop length' };
const ELEMENT_LABELS = { text: 'Text', logo: 'Logo', crest: 'Crest', graphic: 'Graphic', stripe: 'Stripes', piping: 'Piping', embroidery: 'Embroidery', print: 'Print', patch: 'Patch' };

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
    out.push(line);
  }
  return out;
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

/**
 * Design sheet PNG (2400x1700). views: {front, back, side?, detail?} (canvas or {current}).
 * params: per-view params object OR a single params object; notes: string; name: string.
 * Optional: specs:[[label,value],...], date:Date|string, fabric, brand.
 */
export async function exportDesignSheet({ views = {}, elements = [], params = {}, notes = '', name = 'Untitled design', specs = [], date = new Date(), fabric = null, brand = 'Threadform' } = {}) {
  await elementsReady(elements);
  const W = 2400, H = 1700; const c = mk(W, H); const ctx = c.getContext('2d');
  const INK = '#1f2328', MUTE = '#6b7280', LINE = '#d9d4c7', PAPER = '#faf8f3', ACC = '#8a5a2b';
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  const M = 90;
  const sans = '"Helvetica Neue", Helvetica, Arial, sans-serif', serif = 'Georgia, "Times New Roman", serif';

  // header
  ctx.fillStyle = INK; ctx.font = `700 74px ${serif}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillText(name || 'Untitled design', M, M + 62);
  ctx.fillStyle = MUTE; ctx.font = `400 26px ${sans}`;
  const ds = date instanceof Date ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : String(date);
  ctx.fillText('DESIGN SHEET  ·  ' + ds, M, M + 108);
  ctx.textAlign = 'right'; ctx.fillStyle = ACC; ctx.font = `700 30px ${sans}`; ctx.fillText(brand.toUpperCase(), W - M, M + 50);
  ctx.textAlign = 'left';
  ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(M, M + 132); ctx.lineTo(W - M, M + 132); ctx.stroke();

  // view panels
  const top = M + 170;
  const drawView = (key, label, x, y, w, h) => {
    ctx.fillStyle = '#fff'; rr(ctx, x, y, w, h, 14); ctx.fill(); ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
    const cv = asCanvas(views[key]);
    const pad = 24; const lh = 44;
    if (cv) {
      const comp = compose(cv, elements, key, 1, true);
      // crop to garment bbox for nicer framing
      const bb = bounds(comp);
      const aw = w - pad * 2, ah = h - pad * 2 - lh; const k = Math.min(aw / bb.w, ah / bb.h);
      const dw = bb.w * k, dh = bb.h * k;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(comp, bb.x, bb.y, bb.w, bb.h, x + (w - dw) / 2, y + pad + (ah - dh) / 2, dw, dh);
    } else { ctx.fillStyle = '#bbb'; ctx.font = `400 24px ${sans}`; ctx.textAlign = 'center'; ctx.fillText('not available', x + w / 2, y + h / 2); ctx.textAlign = 'left'; }
    ctx.fillStyle = MUTE; ctx.font = `700 22px ${sans}`; ctx.textAlign = 'center'; ctx.fillText(label, x + w / 2, y + h - 20); ctx.textAlign = 'left';
  };
  const bigW = 640, bigH = 880;
  drawView('front', 'FRONT', M, top, bigW, bigH);
  drawView('back', 'BACK', M + bigW + 30, top, bigW, bigH);
  const sw = 420, sh = 425;
  const rx = M + (bigW + 30) * 2;
  drawView('side', 'SIDE', rx, top, sw, sh);
  drawView('detail', 'DETAIL', rx, top + sh + 30, sw, sh);
  // right column: specs
  const colX = rx + sw + 40, colW = W - M - colX;
  let y = top;
  ctx.fillStyle = INK; ctx.font = `700 28px ${sans}`; ctx.fillText('SPECIFICATION', colX, y + 24);
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(colX, y + 40); ctx.lineTo(colX + colW, y + 40); ctx.stroke();
  y += 80;
  const rows = [];
  const P = pickParams(params);
  const nz = Object.keys(PARAM_LABELS).filter(k => Math.abs(P[k] || 0) > 0.5);
  nz.forEach(k => rows.push([PARAM_LABELS[k], (P[k] > 0 ? '+' : '') + Math.round(P[k])]));
  if (!nz.length) rows.push(['Shape edits', 'Original proportions']);
  if (fabric) rows.push(['Fabric', fabric]);
  for (const s of specs || []) rows.push([s[0], String(s[1])]);
  const counts = {}; (elements || []).forEach(e => { if (e.visible !== false) counts[e.type] = (counts[e.type] || 0) + 1; });
  Object.keys(counts).forEach(t => rows.push([ELEMENT_LABELS[t] || t, counts[t] + (counts[t] > 1 ? ' elements' : ' element')]));
  (elements || []).filter(e => e.type === 'text' || e.type === 'embroidery' || e.type === 'print').slice(0, 4).forEach(e => { if (e.props.text) rows.push([(ELEMENT_LABELS[e.type]) + ' text', '"' + String(e.props.text).replace(/\n/g, ' ').slice(0, 24) + '"']); });
  ctx.font = `400 25px ${sans}`;
  rows.slice(0, 16).forEach(([a, b], i) => {
    ctx.fillStyle = MUTE; ctx.textAlign = 'left'; ctx.fillText(a, colX, y);
    ctx.fillStyle = INK; ctx.textAlign = 'right'; ctx.fillText(b, colX + colW, y); ctx.textAlign = 'left';
    ctx.strokeStyle = '#ece8dc'; ctx.beginPath(); ctx.moveTo(colX, y + 14); ctx.lineTo(colX + colW, y + 14); ctx.stroke();
    y += 46;
  });

  // swatches (bottom band)
  const by = top + bigH + 40;
  const base = asCanvas(views.front) || asCanvas(Object.values(views).find(Boolean));
  ctx.fillStyle = INK; ctx.font = `700 28px ${sans}`; ctx.fillText('COLOUR PALETTE', M, by + 24);
  ctx.strokeStyle = LINE; ctx.beginPath(); ctx.moveTo(M, by + 40); ctx.lineTo(M + bigW * 2 + 30, by + 40); ctx.stroke();
  const sws = base ? extractSwatches(compose(base, elements, 'front', 1, true), 6) : [];
  const swW = 195;
  sws.forEach((s, i) => {
    const x = M + i * (swW + 12);
    ctx.fillStyle = s.hex; rr(ctx, x, by + 58, swW, 70, 10); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.stroke();
    ctx.fillStyle = INK; ctx.font = `700 21px ${sans}`; ctx.fillText(s.name, x, by + 156);
    ctx.fillStyle = MUTE; ctx.font = `400 20px ${sans}`; ctx.fillText(s.hex.toUpperCase(), x, by + 182);
  });
  // notes
  const nx = M + bigW * 2 + 30 + 60;
  ctx.fillStyle = INK; ctx.font = `700 28px ${sans}`; ctx.fillText('NOTES', nx, by + 24);
  ctx.strokeStyle = LINE; ctx.beginPath(); ctx.moveTo(nx, by + 40); ctx.lineTo(W - M, by + 40); ctx.stroke();
  ctx.fillStyle = INK; ctx.font = `400 24px ${sans}`;
  const nl = wrap(ctx, notes || 'No notes.', W - M - nx);
  nl.slice(0, 6).forEach((l, i) => ctx.fillText(l, nx, by + 80 + i * 34));
  // footer
  ctx.fillStyle = MUTE; ctx.font = `400 20px ${sans}`; ctx.textAlign = 'left'; ctx.fillText(`${brand} · generated design sheet · ${ds}`, M, H - 40);
  ctx.textAlign = 'right'; ctx.fillText('Flat-lay preview, not to scale', W - M, H - 40); ctx.textAlign = 'left';
  return toBlob(c);
}
function pickParams(params) {
  if (!params) return {};
  if (params.front || params.back) return params.front || params.back; // per-view params
  return params;
}
function bounds(c) {
  const s = 128; const t = mk(s, s); const x = t.getContext('2d'); x.drawImage(c, 0, 0, s, s);
  const d = x.getImageData(0, 0, s, s).data; let x0 = s, y0 = s, x1 = 0, y1 = 0;
  for (let y = 0; y < s; y++) for (let xx = 0; xx < s; xx++) if (d[(y * s + xx) * 4 + 3] > 20) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0) return { x: 0, y: 0, w: c.width, h: c.height };
  const k = c.width / s, m = 2;
  let bx = Math.max(0, (x0 - m) * k), by = Math.max(0, (y0 - m) * k), bw = Math.min(c.width - bx, (x1 - x0 + 1 + 2 * m) * k), bh = Math.min(c.height - by, (y1 - y0 + 1 + 2 * m) * k);
  return { x: bx, y: by, w: bw, h: bh };
}

/** Trigger a browser download of a Blob or string. */
export function download(blobOrString, filename = 'threadform.png') {
  let blob = blobOrString;
  if (typeof blobOrString === 'string') {
    const ext = filename.split('.').pop().toLowerCase();
    blob = new Blob([blobOrString], { type: ext === 'svg' ? 'image/svg+xml' : ext === 'json' ? 'application/json' : 'text/plain' });
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
/** Download several {name, blob} items one after another (browsers allow this after a single user click). */
export async function downloadAll(items, gap = 350) { for (const it of items) { download(it.blob, it.name); await new Promise(r => setTimeout(r, gap)); } }
