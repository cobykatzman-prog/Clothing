// Selection overlay (owner: selection): marching ants + optional tint, drawn over the garment without hiding it.
// Pure drawing code: the contour tracer works on an alpha array (marching squares at 50 %, so feathered and refined edges
// show their true edge), results are cached per mask revision and re-computed at most every ~90 ms while a gesture is running.
import { SIZE } from './util.js';
import { state } from './state.js';
import { displayMask, displayRev, readAlpha, eng } from './selection.js';
import { makeCanvas } from './util.js';

/* ------------------------------------------------------------------ contours (mask.js outline: marching squares at 50 %) */
function toPath2D(contours) {
  const p = new Path2D();
  for (const c of contours) {
    const P = c.points; if (P.length < 2) continue;
    p.moveTo(P[0].x, P[0].y); for (let i = 1; i < P.length; i++) p.lineTo(P[i].x, P[i].y); p.closePath();
  }
  return p;
}

/* ------------------------------------------------------------------ ants */
const reduceMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
/** Double stroke: a solid light line under a dashed dark line, so the outline reads on any fabric colour. `z` = stage zoom. */
export function strokeAnts(ctx, path, z, now = 0, { width = 1.6, animate = true } = {}) {
  const u = 1 / z;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
  ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.lineWidth = (width + 1.6) * u; ctx.stroke(path);
  ctx.strokeStyle = 'rgba(12,12,24,.92)'; ctx.lineWidth = width * u;
  ctx.setLineDash([5 * u, 5 * u]); ctx.lineDashOffset = animate && !reduceMotion() ? -((now / 45) % 10) * u : 0;
  ctx.stroke(path);
  ctx.restore();
}

/* ------------------------------------------------------------------ overlay */
const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : [79, 70, 229]; };
export function createOverlay(requestRedraw) {
  const C = { key: null, contours: null, path: null, at: 0, timer: 0, tintKey: null, tint: null, dimKey: null, dim: null, bwKey: null, bw: null, count: 0 };
  function contoursFor(V, key, dragging) {
    if (C.key === key) return C.path;
    const t = performance.now();
    if (dragging && C.path && t - C.at < 90) {   // while a stroke runs: refresh the ants at most ~11x per second
      if (!C.timer) C.timer = setTimeout(() => { C.timer = 0; requestRedraw(); }, 95 - (t - C.at));
      return C.path;
    }
    const m = displayMask(V);
    C.contours = eng.outline(readAlpha(m));
    C.path = toPath2D(C.contours); C.key = key; C.at = performance.now(); C.count = C.contours.length;
    return C.path;
  }
  function tintFor(V, key, rgb) {
    const k = key + rgb.join();
    if (C.tintKey !== k) {
      const t = C.tint || makeCanvas(), x = t.getContext('2d');
      x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, SIZE, SIZE); x.drawImage(displayMask(V), 0, 0);
      x.globalCompositeOperation = 'source-in'; x.fillStyle = `rgb(${rgb})`; x.fillRect(0, 0, SIZE, SIZE);
      C.tint = t; C.tintKey = k;
    }
    return C.tint;
  }
  function dimFor(V, key) {
    if (C.dimKey !== key) {
      const t = C.dim || makeCanvas(), x = t.getContext('2d');
      x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, SIZE, SIZE);
      x.fillStyle = 'rgba(18,18,30,.6)'; x.fillRect(0, 0, SIZE, SIZE);
      x.globalCompositeOperation = 'destination-out'; x.drawImage(displayMask(V), 0, 0);
      C.dim = t; C.dimKey = key;
    }
    return C.dim;
  }
  function bwFor(V, key) {
    if (C.bwKey !== key) {
      const t = C.bw || makeCanvas(), x = t.getContext('2d');
      x.globalCompositeOperation = 'source-over'; x.fillStyle = '#000'; x.fillRect(0, 0, SIZE, SIZE);
      x.drawImage(tintFor(V, key, [255, 255, 255]), 0, 0);
      C.bw = t; C.bwKey = key;
    }
    return C.bw;
  }
  return {
    /** ctx already has the image transform applied. dragging: a gesture is changing the mask right now. */
    draw(ctx, V, z, now, dragging = false) {
      const o = state.ui.ovl;
      const m = displayMask(V);
      if (!o.show || !m) return;
      const key = displayRev(V);
      ctx.save();
      ctx.imageSmoothingEnabled = z < 2.5;
      if (o.view === 'mask') { ctx.drawImage(bwFor(V, key), 0, 0); ctx.restore(); return; }
      if (o.view === 'only') ctx.drawImage(dimFor(V, key), 0, 0);
      if (o.style !== 'ants' && o.opacity > 0) { ctx.globalAlpha = Math.min(0.6, o.opacity / 100); ctx.drawImage(tintFor(V, key, hex(o.color)), 0, 0); ctx.globalAlpha = 1; }
      if (o.style !== 'tint' || o.view === 'only') strokeAnts(ctx, contoursFor(V, key, dragging), z, now, { animate: o.animate });
      ctx.restore();
    },
    /** true while the ants should animate (a selection is visible with an outline) */
    animating(V) {
      const o = state.ui.ovl;
      return !!(o.show && o.animate && o.view !== 'mask' && (o.style !== 'tint' || o.view === 'only') && C.count && V.mask && displayMask(V) && !reduceMotion());
    },
    contours: () => C.contours,
    invalidate() { C.key = null; C.tintKey = null; C.dimKey = null; C.bwKey = null; },
  };
}
