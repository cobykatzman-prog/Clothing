// Threadform - colourway exports (roadmap v2 phase 7): one PNG per colourway and view, a side-by-side comparison sheet,
// and the materials / colour specification as CSV. Pictures are rendered from the shared garment on demand, never stored.
import { state, syncActiveColourway } from './state.js';
import { renderColourwayComposite } from './colourway-render.js';
import { SECTION_LABELS, SECTION_IDS, specCsv, safeFileName } from './colourway-model.js';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const toBlob = (c, type = 'image/png') => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed')), type)));
const byIds = ids => ids.map(id => state.colourways.list.find(c => c.id === id)).filter(Boolean);
const isLive = cw => state.colourways.activeId === cw.id;
const viewsWithGarment = want => want.filter(v => state.views[v]?.base);

/** [{name, blob}] one PNG per colourway and view (garment + artwork, chosen background). */
export async function exportColourwayImages(ids, { views = ['front', 'back'], scale = 1, background = '#ffffff' } = {}) {
  syncActiveColourway();
  const out = [], vs = viewsWithGarment(views);
  for (const cw of byIds(ids)) {
    for (const v of vs) {
      const c = await renderColourwayComposite(v, cw, { live: isLive(cw), scale, background });
      if (c) out.push({ view: v, colourway: cw.id, name: `${safeFileName(state.name)}-${safeFileName(cw.name)}-${v}.png`, blob: await toBlob(c) });
    }
  }
  return out;
}

function swatchList(cw, view) {
  const a = cw.views?.[view] || cw.views?.front, out = [];
  for (const id of SECTION_IDS) { const p = a?.parts?.[id]; if (p?.color) out.push({ id, label: SECTION_LABELS[id], color: p.color, fabric: p.fabric?.name || '', material: cw.sections?.[id]?.material?.name || '' }); }
  return out;
}

/** One PNG with the chosen colourways side by side (a column each, one row per view), named and with their section colours. */
export async function exportComparisonSheet(ids, { views = ['front'], cell = 360, columns = 4 } = {}) {
  syncActiveColourway();
  const cws = byIds(ids), vs = viewsWithGarment(views);
  if (!cws.length || !vs.length) return null;
  const pad = 24, head = 70, labelH = 28, gap = 16;
  const foot = 16 + 21 * Math.min(6, Math.max(1, ...cws.map(cw => swatchList(cw, vs[0]).length)));
  const cols = Math.min(columns, cws.length), groups = Math.ceil(cws.length / cols);
  const groupH = vs.length * (cell + gap) + labelH + foot;
  const W = pad * 2 + cols * cell + (cols - 1) * gap, H = head + groups * groupH + pad;
  const out = mk(W, H), x = out.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#1f1f24'; x.font = '700 24px Arial, Helvetica, sans-serif'; x.textBaseline = 'alphabetic';
  x.fillText(`${state.name || 'Design'} - colourways`, pad, 38);
  x.fillStyle = '#6b6b74'; x.font = '13px Arial, Helvetica, sans-serif';
  x.fillText(`${cws.length} colourway${cws.length === 1 ? '' : 's'}, same garment structure (shape and artwork layout shared)`, pad, 58);
  for (let i = 0; i < cws.length; i++) {
    const cw = cws[i], g = Math.floor(i / cols), col = i % cols;
    const ox = pad + col * (cell + gap), oy = head + g * groupH;
    x.fillStyle = '#1f1f24'; x.font = '700 15px Arial, Helvetica, sans-serif';
    x.fillText(cw.name.length > 34 ? cw.name.slice(0, 33) + '...' : cw.name, ox, oy + 18);
    let y = oy + labelH;
    for (const v of vs) {
      const c = await renderColourwayComposite(v, cw, { live: isLive(cw), scale: cell / 1024, background: '#f3f2ef' });
      if (c) x.drawImage(c, ox, y, cell, cell);
      x.strokeStyle = '#d9d6ce'; x.strokeRect(ox + .5, y + .5, cell - 1, cell - 1);
      if (vs.length > 1) { x.fillStyle = '#6b6b74'; x.font = '11px Arial, Helvetica, sans-serif'; x.fillText(v.toUpperCase(), ox + 8, y + 16); }
      y += cell + gap;
    }
    const sw = swatchList(cw, vs[0]);
    x.font = '12px Arial, Helvetica, sans-serif';
    sw.slice(0, 6).forEach((s, k) => {
      const yy = y - gap + 8 + k * 21;
      x.fillStyle = s.color; x.fillRect(ox, yy, 16, 16); x.strokeStyle = '#00000033'; x.strokeRect(ox + .5, yy + .5, 15, 15);
      x.fillStyle = '#1f1f24';
      const t = `${s.label} ${s.color}${s.material ? ' - ' + s.material : s.fabric ? ' - ' + s.fabric : ''}`;
      x.fillText(t.length > 44 ? t.slice(0, 43) + '...' : t, ox + 24, yy + 12);
    });
    if (!sw.length) { x.fillStyle = '#6b6b74'; x.fillText('Original colours', ox, y - gap + 20); }
  }
  return toBlob(out);
}

/** Materials / colour specification of the chosen colourways (CSV text). */
export function exportColourwaySpec(ids, { view = 'front' } = {}) {
  syncActiveColourway();
  return specCsv(byIds(ids), state.name, view);
}
