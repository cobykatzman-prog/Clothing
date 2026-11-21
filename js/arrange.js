// Pure geometry for arranging design elements: bounds, alignment, distribution and snapping.
// No DOM and no state, so it is unit tested in node (js/arrange.test.mjs). Elements are plain objects
// {x, y, w, h, rotation}: (x, y) is the centre, w / h the unrotated size, rotation in degrees.

/** The four corners of an element, rotation included. */
export function corners(el) {
  const hw = el.w / 2, hh = el.h / 2, a = (el.rotation || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({ x: el.x + lx * c - ly * s, y: el.y + lx * s + ly * c }));
}
const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 });
/** Axis-aligned box that holds the (rotated) element. */
export function bounds(el) {
  const p = corners(el);
  return box(Math.min(...p.map(q => q.x)), Math.min(...p.map(q => q.y)), Math.max(...p.map(q => q.x)), Math.max(...p.map(q => q.y)));
}
/** Box that holds several elements (null for none). */
export function unionBounds(els) {
  if (!els.length) return null;
  const b = els.map(bounds);
  return box(Math.min(...b.map(q => q.x0)), Math.min(...b.map(q => q.y0)), Math.max(...b.map(q => q.x1)), Math.max(...b.map(q => q.y1)));
}
/** Rectangle {x, y, w, h} (a garment bbox) as a box. */
export const rectBox = r => (r ? box(r.x, r.y, r.x + r.w, r.y + r.h) : null);

export const ALIGN_MODES = ['left', 'hcenter', 'right', 'top', 'vmiddle', 'bottom'];
/**
 * How far each element has to move to line up with `ref` (a box). Returns [{el, dx, dy}].
 * With a single element `ref` is the garment (or the canvas); with several it is their combined box.
 */
export function alignDeltas(els, mode, ref) {
  if (!ALIGN_MODES.includes(mode) || !ref) return [];
  return els.map(el => {
    const b = bounds(el);
    const dx = mode === 'left' ? ref.x0 - b.x0 : mode === 'right' ? ref.x1 - b.x1 : mode === 'hcenter' ? ref.cx - b.cx : 0;
    const dy = mode === 'top' ? ref.y0 - b.y0 : mode === 'bottom' ? ref.y1 - b.y1 : mode === 'vmiddle' ? ref.cy - b.cy : 0;
    return { el, dx, dy };
  });
}
/** Equal gaps between three or more elements along 'x' or 'y'. The two outermost stay put. */
export function distributeDeltas(els, axis) {
  if (els.length < 3) return [];
  const k = axis === 'y' ? ['y0', 'y1', 'h', 'cy'] : ['x0', 'x1', 'w', 'cx'];
  const items = els.map(el => ({ el, b: bounds(el) })).sort((p, q) => p.b[k[3]] - q.b[k[3]]);
  const first = items[0].b, last = items[items.length - 1].b;
  const total = items.reduce((s, i) => s + i.b[k[2]], 0);
  const gap = (last[k[1]] - first[k[0]] - total) / (items.length - 1);
  let pos = first[k[0]];
  return items.map(({ el, b }) => { const d = pos - b[k[0]]; pos += b[k[2]] + gap; return axis === 'y' ? { el, dx: 0, dy: d } : { el, dx: d, dy: 0 }; });
}

/**
 * Snap lines for the things an element can be lined up with: the garment (edges and centre), the canvas
 * centre and the other elements (edges and centres). Returns {x: [{pos, kind}], y: [...]}.
 */
export function snapLines({ garment, others = [], size = 1024 } = {}) {
  const x = [{ pos: size / 2, kind: 'canvas' }], y = [{ pos: size / 2, kind: 'canvas' }];
  if (garment) {
    x.push({ pos: garment.cx, kind: 'garment' }, { pos: garment.x0, kind: 'garment' }, { pos: garment.x1, kind: 'garment' });
    y.push({ pos: garment.cy, kind: 'garment' }, { pos: garment.y0, kind: 'garment' }, { pos: garment.y1, kind: 'garment' });
  }
  for (const o of others) { const b = bounds(o); x.push({ pos: b.x0, kind: 'item' }, { pos: b.cx, kind: 'item' }, { pos: b.x1, kind: 'item' }); y.push({ pos: b.y0, kind: 'item' }, { pos: b.cy, kind: 'item' }, { pos: b.y1, kind: 'item' }); }
  return { x, y };
}
/**
 * Snap a moving box to the lines. Looks at its left / centre / right and top / middle / bottom and takes the
 * closest line within `tol` (image px) on each axis. Returns {dx, dy, guides:[{axis, pos, kind}]}.
 */
export function snapBox(b, lines, tol = 6) {
  const best = (edges, cands) => {
    let r = null;
    for (const e of edges) for (const c of cands) { const d = c.pos - e; if (Math.abs(d) <= tol && (!r || Math.abs(d) < Math.abs(r.d) - 1e-9)) r = { d, pos: c.pos, kind: c.kind }; }
    return r;
  };
  const sx = best([b.x0, b.cx, b.x1], lines.x), sy = best([b.y0, b.cy, b.y1], lines.y);
  const guides = [];
  if (sx) guides.push({ axis: 'x', pos: sx.pos, kind: sx.kind });
  if (sy) guides.push({ axis: 'y', pos: sy.pos, kind: sy.kind });
  return { dx: sx ? sx.d : 0, dy: sy ? sy.d : 0, guides };
}
