// Threadform - technical drawings for the tech pack (roadmap v2 phase 5): a flat black-line drawing of the garment from the
// live silhouette (so it follows every shape change), schematic seam lines, measurement callouts (measure.js), numbered
// artwork placement boxes, and zoomed detail drawings of each artwork layer with its dimensions.
// Canvas only; every drawing is built from state, nothing is stored.
import { designMeasure, drawDimensionLines } from './measure.js';
import { drawElements, elementsReady } from './elements.js';
import { compose } from './export.js';

const SIZE = 1024;
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const INK = '#16181d';

function tint(mask, color) { const c = mk(mask.width, mask.height), x = c.getContext('2d'); x.drawImage(mask, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height); return c; }
/** Black outline of a mask, drawn just outside its edge. */
function outline(mask, r = 2.2) {
  const c = mk(mask.width, mask.height), x = c.getContext('2d');
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; x.drawImage(mask, Math.cos(a) * r, Math.sin(a) * r); }
  x.globalCompositeOperation = 'destination-out'; x.drawImage(mask, 0, 0);
  x.globalCompositeOperation = 'source-in'; x.fillStyle = INK; x.fillRect(0, 0, c.width, c.height);
  return c;
}
function seamLines(ctx, seg, view) {
  const L = seg.landmarks, M = seg.metrics || {}; if (!L) return;
  const hpsY = (L.shoulderL.y + L.shoulderR.y) / 2, hemY = (L.hemL.y + L.hemR.y) / 2, cx = L.centerX;
  ctx.save(); ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1.6; ctx.setLineDash([7, 5]);
  const ln = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  ln(L.shoulderL, L.armpitL); ln(L.shoulderR, L.armpitR);   // armhole seams
  const rx = (M.neckRx || 40), nb = L.neckBottom && Number.isFinite(L.neckBottom.y) ? L.neckBottom.y : hpsY + (M.neckRy || 30);
  const drop = view === 'back' ? Math.min(nb - hpsY, (M.neckRy || 30) * 0.5) : nb - hpsY;
  ctx.beginPath(); ctx.moveTo(cx - rx, hpsY); ctx.quadraticCurveTo(cx, hpsY + drop * 2, cx + rx, hpsY); ctx.stroke();   // neck seam
  const hs = 16; ln({ x: L.hemL.x, y: hemY - hs }, { x: L.hemR.x, y: hemY - hs });                                       // hem stitch line
  ctx.restore();
}
function drawBalloon(ctx, x, y, n, r = 15) {
  ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = INK; ctx.font = `700 ${r * 1.15}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), x, y + 1); ctx.restore();
}
function placementBoxes(ctx, elements, view, placements) {
  ctx.save(); ctx.strokeStyle = '#b45309'; ctx.lineWidth = 2; ctx.setLineDash([9, 5]);
  placements.forEach((p, i) => {
    if (p.view !== view) return;
    const el = elements.find(e => e.id === p.id); if (!el) return;
    const rot = ((el.rotation || 0) * Math.PI) / 180;
    ctx.save(); ctx.translate(el.x, el.y); ctx.rotate(rot); ctx.strokeRect(-el.w / 2, -el.h / 2, el.w, el.h); ctx.restore();
    const hw = el.w / 2, hh = el.h / 2, cos = Math.cos(rot), sin = Math.sin(rot);
    drawBalloon(ctx, el.x + hw * cos + hh * sin + 4, el.y + hw * sin - hh * cos - 4, i + 1, 13);
  });
  ctx.restore();
}

/**
 * Flat technical drawing of one view -> canvas, or null when the view has no garment.
 * opts: {scale (output px per canvas px), dims (measurement callouts, front/back only), placements, art (faint artwork)}
 */
export async function renderDrawing(state, view, { scale = 1.2, dims = true, placements = [], art = true } = {}) {
  const V = state.views[view]; if (!V || !V.current) return null;
  const elements = state.elements.filter(e => e.visible !== false && (e.view === view || e.view === 'all'));
  await elementsReady(elements);
  const seg = V.seg && V.seg.mask && !(V.seg.metrics && V.seg.metrics.empty) ? V.seg : null;
  const full = mk(SIZE, SIZE), x = full.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, SIZE, SIZE);
  let box = { x: 0, y: 0, w: SIZE, h: SIZE }, kind = 'line';
  if (seg) {
    x.drawImage(tint(seg.mask, '#f4f3ef'), 0, 0);
    if (art) { x.save(); try { x.filter = 'grayscale(1) contrast(0.85)'; } catch (e) { } x.globalAlpha = 0.55; drawElements(x, elements, view, { handles: false, res: 1 }); x.restore(); }
    x.drawImage(outline(seg.mask), 0, 0);
    seamLines(x, seg, view);
    const d = dims && (view === 'front' || view === 'back') ? designMeasure(state, view) : null;
    if (d && d.rows.length) drawDimensionLines(x, seg, d.rows, { unit: 'cm', canvasSize: SIZE, fontPx: 19 });
    placementBoxes(x, elements, view, placements);
    const b = seg.bbox && seg.bbox.w ? seg.bbox : box, m = 130;
    const x0 = Math.max(0, b.x - m), y0 = Math.max(0, b.y - m * 1.5), x1 = Math.min(SIZE, b.x + b.w + m), y1 = Math.min(SIZE, b.y + b.h + m * 0.8);
    box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  } else {
    // no silhouette (for example a detail photo): show the picture itself in greys so it still reads as a drawing
    kind = 'picture';
    x.save(); try { x.filter = 'grayscale(1)'; } catch (e) { } x.drawImage(compose(V.current, elements, view, 1, '#ffffff'), 0, 0); x.restore();
  }
  const out = mk(box.w * scale, box.h * scale), o = out.getContext('2d');
  o.imageSmoothingQuality = 'high'; o.drawImage(full, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);
  out.dataset.kind = kind;
  return out;
}

/** Zoomed drawing of one artwork layer with its width and height. p = placement (techpack.js), cmPerPx may be null. */
export async function renderArtworkDetail(state, el, p, number, { size = 560 } = {}) {
  const V = state.views[p.view]; if (!V || !V.current) return null;
  await elementsReady([el]);
  const q = p.px, bw = q.maxX - q.minX, bh = q.maxY - q.minY, side = Math.min(SIZE, Math.max(bw, bh) * 1.7, Math.max(bw, bh) + 360), side2 = Math.max(side, 180);
  const x0 = Math.min(Math.max(0, el.x - side2 / 2), SIZE - side2), y0 = Math.min(Math.max(0, el.y - side2 / 2), SIZE - side2);
  const full = compose(V.current, state.elements.filter(e => e.visible !== false && (e.view === p.view || e.view === 'all')), p.view, 1, '#ffffff');
  const k = size / side2, out = mk(size, size), o = out.getContext('2d');
  o.fillStyle = '#fff'; o.fillRect(0, 0, size, size); o.imageSmoothingQuality = 'high';
  o.drawImage(full, x0, y0, side2, side2, 0, 0, size, size);
  const X = v => (v - x0) * k, Y = v => (v - y0) * k;
  o.save(); o.strokeStyle = '#b45309'; o.fillStyle = '#b45309'; o.lineWidth = 2; o.font = `700 15px ${SANS}`;
  o.setLineDash([8, 5]); o.strokeRect(X(q.minX), Y(q.minY), (q.maxX - q.minX) * k, (q.maxY - q.minY) * k);
  o.setLineDash([]);
  const arrow = (ax, ay, bx, by) => { o.beginPath(); o.moveTo(ax, ay); o.lineTo(bx, by); o.stroke(); for (const [px, py, dx, dy] of [[ax, ay, bx - ax, by - ay], [bx, by, ax - bx, ay - by]]) { const a = Math.atan2(dy, dx), s = 7; o.beginPath(); o.moveTo(px, py); o.lineTo(px + s * Math.cos(a + 0.4), py + s * Math.sin(a + 0.4)); o.moveTo(px, py); o.lineTo(px + s * Math.cos(a - 0.4), py + s * Math.sin(a - 0.4)); o.stroke(); } };
  const label = (t, cx, cy) => { const w = o.measureText(t).width + 8; o.fillStyle = 'rgba(255,255,255,.92)'; o.fillRect(cx - w / 2, cy - 11, w, 20); o.fillStyle = '#7c2d12'; o.textAlign = 'center'; o.textBaseline = 'middle'; o.fillText(t, cx, cy); };
  const tilde = p.source === 'calibrated' ? '' : '~';
  if (p.measured) {
    const ay = Y(q.maxY) + 22, bx = X(q.maxX) + 22;
    arrow(X(q.minX), ay, X(q.maxX), ay); label(`${tilde}${p.wCm} cm`, (X(q.minX) + X(q.maxX)) / 2, ay + (ay > size - 26 ? -16 : 14));
    arrow(bx, Y(q.minY), bx, Y(q.maxY)); label(`${tilde}${p.hCm} cm`, bx + (bx > size - 40 ? -26 : 0), (Y(q.minY) + Y(q.maxY)) / 2);
  }
  const lm = V.seg && V.seg.landmarks;
  if (lm && X(lm.centerX) > 4 && X(lm.centerX) < size - 4) { o.strokeStyle = '#475569'; o.setLineDash([3, 6]); o.lineWidth = 1.4; o.beginPath(); o.moveTo(X(lm.centerX), 0); o.lineTo(X(lm.centerX), size); o.stroke(); o.setLineDash([]); o.fillStyle = '#475569'; o.font = `600 13px ${SANS}`; o.textAlign = 'left'; o.textBaseline = 'top'; o.fillText(p.view === 'back' ? 'centre back' : 'centre front', X(lm.centerX) + 4, 4); }
  o.restore();
  drawBalloon(o, 22, 22, number, 15);
  return out;
}
