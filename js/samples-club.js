// Threadform - the "Club Élite" test garment: a believable photo-like FLAT bitmap of a cream long-sleeve shirt with brown
// lengthwise shoulder stripes, a chest crest and (on the back) typography plus a tennis racket graphic.
// All artwork is BAKED INTO THE PIXELS (like an uploaded photo), never kept as vector layers, so later phases can detect and extract it.
import { sampleGarment } from './samples.js';

const S = 1024;
const CREAM = '#efe6d2', BROWN = '#5a3a22', GOLD = '#c9a24a';

/** Exactly what was drawn. bbox values are fractions (0-1) of the 1024x1024 canvas. Tests assert extraction against this. */
export const CLUB_ELITE_ARTWORK = {
  garment: { kind: 'longSleeve', body: CREAM, trim: BROWN, cuffs: 'none (plain turned hem)', size: S },
  colors: { body: CREAM, brown: BROWN, gold: GOLD },
  front: [
    { type: 'logo', name: 'chest crest', text: 'CÉ', bbox: { x: 0.5352, y: 0.2910, w: 0.0723, h: 0.0928 }, colors: [BROWN, GOLD], rotationDeg: 0, description: 'shield crest with CÉ monogram and a gold stripe band' },
    { type: 'stripe', name: 'left sleeve stripes', bbox: { x: 0.085, y: 0.31, w: 0.29, h: 0.45 }, colors: [BROWN], rotationDeg: 25, description: 'two parallel brown bands down the sleeve (approximate bbox, sleeve diagonal)' },
    { type: 'stripe', name: 'right sleeve stripes', bbox: { x: 0.625, y: 0.31, w: 0.29, h: 0.45 }, colors: [BROWN], rotationDeg: -25, description: 'two parallel brown bands down the sleeve (approximate bbox, sleeve diagonal)' },
  ],
  back: [
    { type: 'text', name: 'title', text: 'CLUB ÉLITE', fontStyle: 'bold serif', bbox: { x: 0.3770, y: 0.3200, w: 0.2461, h: 0.0508 }, colors: [BROWN], rotationDeg: 0, description: 'bold serif wordmark' },
    { type: 'text', name: 'tagline', text: 'TENNIS CLUB 1987', fontStyle: 'serif caps, letter-spaced', bbox: { x: 0.4023, y: 0.3930, w: 0.1953, h: 0.0215 }, colors: [BROWN], rotationDeg: 0, description: 'straight tagline below the title' },
    { type: 'graphic', name: 'tennis racket', bbox: { x: 0.4150, y: 0.4450, w: 0.1500, h: 0.2500 }, colors: [BROWN, GOLD], rotationDeg: -22, description: 'tennis racket with strings, tilted' },
    { type: 'graphic', name: 'tennis ball', bbox: { x: 0.5420, y: 0.6350, w: 0.0620, h: 0.0620 }, colors: [GOLD, CREAM], rotationDeg: 0, description: 'tennis ball resting by the racket' },
    { type: 'stripe', name: 'left sleeve stripes', bbox: { x: 0.085, y: 0.31, w: 0.29, h: 0.45 }, colors: [BROWN], rotationDeg: 25, description: 'two parallel brown bands (approximate bbox)' },
    { type: 'stripe', name: 'right sleeve stripes', bbox: { x: 0.625, y: 0.31, w: 0.29, h: 0.45 }, colors: [BROWN], rotationDeg: -25, description: 'two parallel brown bands (approximate bbox)' },
  ],
};

function mk() { const c = document.createElement('canvas'); c.width = c.height = S; return c; }
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const px = b => ({ x: b.x * S, y: b.y * S, w: b.w * S, h: b.h * S });
const SERIF = '"Playfair Display", "Bodoni MT", Georgia, "Times New Roman", "Liberation Serif", "DejaVu Serif", serif';

// draws `text` so its INK box lands exactly on bbox (px): the artwork matches the metadata whatever font the machine has
function fitText(ctx, text, bb, { weight = 900, spacing = 0, color = BROWN } = {}) {
  ctx.save();
  ctx.font = `${weight} 100px ${SERIF}`; ctx.letterSpacing = spacing * 100 + 'px'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const m = ctx.measureText(text), l = m.actualBoundingBoxLeft, r = m.actualBoundingBoxRight, a = m.actualBoundingBoxAscent, d = m.actualBoundingBoxDescent;
  const sx = bb.w / (l + r - spacing * 100 * 0.0), sy = bb.h / (a + d);
  ctx.translate(bb.x + l * sx, bb.y + a * sy); ctx.scale(sx, sy);
  ctx.fillStyle = color; ctx.fillText(text, 0, 0);
  ctx.restore();
}

function shieldPath(c, cx, cy, w, h) {
  c.beginPath(); c.moveTo(cx - w / 2, cy - h / 2); c.lineTo(cx + w / 2, cy - h / 2); c.lineTo(cx + w / 2, cy + h * 0.08);
  c.quadraticCurveTo(cx + w / 2, cy + h * 0.38, cx, cy + h / 2); c.quadraticCurveTo(cx - w / 2, cy + h * 0.38, cx - w / 2, cy + h * 0.08); c.closePath();
}

function drawCrest(ctx, bb) {
  const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2, w = bb.w, h = bb.h;
  ctx.save();
  // gold underprint, slightly misregistered like a real screen print
  ctx.fillStyle = GOLD; shieldPath(ctx, cx + 1.1, cy + 0.8, w, h); ctx.fill();
  ctx.fillStyle = BROWN; shieldPath(ctx, cx, cy, w - 4, h - 4); ctx.fill();
  ctx.strokeStyle = GOLD; ctx.lineWidth = 1.8; shieldPath(ctx, cx, cy, w - 13, h - 13); ctx.stroke();
  ctx.save(); shieldPath(ctx, cx, cy, w - 13, h - 13); ctx.clip();
  // stripe band
  ctx.fillStyle = GOLD; ctx.fillRect(cx - w, cy + h * 0.10, w * 2, h * 0.13);
  ctx.fillStyle = BROWN; ctx.fillRect(cx - w, cy + h * 0.158, w * 2, h * 0.025);
  ctx.restore();
  fitText(ctx, 'CÉ', { x: cx - w * 0.30, y: cy - h * 0.34, w: w * 0.60, h: h * 0.40 }, { color: GOLD, weight: 900, spacing: 0.02 });
  ctx.restore();
}

function drawRacket(ctx, bb, rot) {
  const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot * Math.PI / 180);
  const L = bb.h * 1.02;                    // racket length before rotation (bbox of the rotated shape is slightly smaller)
  const hy = -L / 2 + 66, rx = 42, ry = 56;  // head centre
  // strings
  ctx.save(); ctx.beginPath(); ctx.ellipse(0, hy, rx - 3, ry - 3, 0, 0, Math.PI * 2); ctx.clip();
  ctx.strokeStyle = GOLD; ctx.lineWidth = 1.1;
  for (let x = -rx; x <= rx; x += 7.5) { ctx.beginPath(); ctx.moveTo(x, hy - ry); ctx.lineTo(x, hy + ry); ctx.stroke(); }
  for (let y = -ry; y <= ry; y += 7.5) { ctx.beginPath(); ctx.moveTo(-rx, hy + y); ctx.lineTo(rx, hy + y); ctx.stroke(); }
  ctx.restore();
  // frame (outer + inner edge gives a moulded look)
  ctx.strokeStyle = BROWN; ctx.lineWidth = 8; ctx.beginPath(); ctx.ellipse(0, hy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = GOLD; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.ellipse(0, hy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  // throat: a "V" from the head to the handle
  const ty = hy + ry - 3, gy = ty + 36;
  ctx.strokeStyle = BROWN; ctx.lineWidth = 6.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-17, ty - 5); ctx.lineTo(-4.5, gy); ctx.moveTo(17, ty - 5); ctx.lineTo(4.5, gy); ctx.stroke();
  ctx.lineWidth = 1.6; ctx.strokeStyle = GOLD; ctx.beginPath(); ctx.moveTo(0, ty - 14); ctx.lineTo(0, gy); ctx.stroke();
  // grip
  const ge = L / 2;
  ctx.fillStyle = BROWN; ctx.beginPath(); ctx.roundRect(-6.5, gy - 2, 13, ge - gy + 2, 4); ctx.fill();
  ctx.strokeStyle = GOLD; ctx.lineWidth = 1.4;
  for (let y = gy + 8; y < ge - 4; y += 6) { ctx.beginPath(); ctx.moveTo(-6, y); ctx.lineTo(6, y + 3); ctx.stroke(); }
  ctx.beginPath(); ctx.roundRect(-8, ge - 7, 16, 7, 3); ctx.fillStyle = GOLD; ctx.fill();
  ctx.restore();
}

function drawBall(ctx, bb) {
  const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2, r = bb.w / 2;
  ctx.save();
  ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = BROWN; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, Math.PI * 2); ctx.clip();
  ctx.strokeStyle = CREAM; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx - r * 1.15, cy, r * 0.95, -0.9, 0.9); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx + r * 1.15, cy, r * 0.95, Math.PI - 0.9, Math.PI + 0.9); ctx.stroke();
  ctx.restore(); ctx.restore();
}

// ink look: soft anti-aliasing, a little ink dropout, then the garment's own folds show through (multiply) and fabric grain sits over it
function bakeArtwork(base, drawFn, seed) {
  const art = mk(), a = art.getContext('2d');
  a.filter = 'blur(0.55px)'; drawFn(a); a.filter = 'none';
  // ink dropout: tiny random specks where the print did not fully cover the weave
  const r = rng(seed); a.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 9000; i++) { a.fillStyle = `rgba(0,0,0,${0.12 + r() * 0.38})`; a.fillRect(r() * S, r() * S, 1 + r() * 1.5, 1 + r() * 1.2); }
  // keep the print on the cloth only
  a.globalCompositeOperation = 'destination-in'; a.drawImage(base, 0, 0);
  const ctx = base.getContext('2d');
  ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.96; ctx.drawImage(art, 0, 0); ctx.restore();
  // weave texture over the ink (light + dark noise, clipped to the cloth)
  const g = mk(), gc = g.getContext('2d'), id = gc.createImageData(S, S), rr = rng(seed + 7);
  for (let i = 0; i < S * S; i++) { const v = rr() < 0.5 ? 0 : 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = rr() * 22; }
  gc.putImageData(id, 0, 0); gc.globalCompositeOperation = 'destination-in'; gc.drawImage(art, 0, 0);
  ctx.drawImage(g, 0, 0);
}

/** -> {front, back}: two 1024x1024 canvases, transparent background, same silhouette (same physical shirt). */
export function clubEliteViews() {
  const opts = { color: CREAM, stripe: false, cuffs: 'hem', trim: '#e0d6bf', collar: '#e3d9c2', along: { color: BROWN, count: 2, w: 12, gap: 7 } };
  const front = sampleGarment('longSleeve', 'front', opts), back = sampleGarment('longSleeve', 'back', opts);
  bakeArtwork(front, c => drawCrest(c, px(CLUB_ELITE_ARTWORK.front[0].bbox)), 101);
  const B = CLUB_ELITE_ARTWORK.back;
  bakeArtwork(back, c => {
    fitText(c, B[0].text, px(B[0].bbox), { weight: 900, spacing: 0.03 });
    fitText(c, B[1].text, px(B[1].bbox), { weight: 600, spacing: 0.18 });
    drawRacket(c, px(B[2].bbox), B[2].rotationDeg);
    drawBall(c, px(B[3].bbox));
  }, 202);
  return { front, back };
}
