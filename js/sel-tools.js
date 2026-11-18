// Selection tool gestures (owner: selection): brush / eraser, lasso, polygon, rectangle and the click tools.
// canvas.js owns the pointer plumbing (pan, zoom, touch) and hands selection gestures to createSelTools().
// A gesture never records history until it ends; while it runs, V.mask is repainted live from the mask the gesture started with.
import { state, activeView, subscribe, touchMask } from './state.js';
import { SIZE, makeCanvas, cloneCanvas } from './util.js';
import * as S from './selection.js';
import { strokeAnts } from './sel-overlay.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
let ref = null;   // the one stage's tools (retunePick needs it)

function tipCanvas(size, hardness) {   // soft brush stamp: solid core up to `hardness`, then a fall-off to the rim
  const D = Math.max(2, Math.ceil(size) + 2), c = makeCanvas(D, D), x = c.getContext('2d'), r = size / 2;
  const g = x.createRadialGradient(D / 2, D / 2, 0, D / 2, D / 2, Math.max(0.5, r));
  const k = Math.min(0.99, Math.max(0, hardness));
  g.addColorStop(0, 'rgba(79,70,229,1)'); g.addColorStop(k, 'rgba(79,70,229,1)'); g.addColorStop(1, 'rgba(79,70,229,0)');
  x.fillStyle = g; x.fillRect(0, 0, D, D);
  return c;
}

export function createSelTools({ request, zoom, onPickPart }) {
  let g = null;                                   // gesture in progress
  const poly = { pts: [], mode: 'add', t: 0 };    // polygon in progress (lives across clicks)
  let hoverP = null, lastPick = null;

  const view = () => activeView();
  const isTool = t => S.isSelTool(t);

  /* ---------- brush / eraser ---------- */
  function paintStroke(a, b) {
    const x = g.strokeC.getContext('2d'), size = g.size;
    if (g.hardness >= 0.98 || size < 3) {
      x.save(); x.lineCap = x.lineJoin = 'round'; x.lineWidth = size; x.strokeStyle = x.fillStyle = 'rgb(79,70,229)';
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x + 0.001, b.y); x.stroke();
      x.beginPath(); x.arc(b.x, b.y, size / 2, 0, 7); x.fill(); x.restore();
    } else {
      const step = Math.max(0.5, size * 0.1), d = dist(a, b), n = Math.max(1, Math.ceil(d / step)), D = g.tip.width;
      for (let i = 1; i <= n; i++) { const t = i / n; x.drawImage(g.tip, a.x + (b.x - a.x) * t - D / 2, a.y + (b.y - a.y) * t - D / 2); }
    }
  }
  function compose() {
    const V = g.V, x = V.mask.getContext('2d');
    x.save(); x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, SIZE, SIZE);
    if (g.mode === 'replace') x.drawImage(g.strokeC, 0, 0);
    else {
      x.drawImage(g.baseC, 0, 0);
      x.globalCompositeOperation = g.mode === 'subtract' ? 'destination-out' : g.mode === 'intersect' ? 'destination-in' : 'source-over';
      x.drawImage(g.strokeC, 0, 0);
    }
    x.restore(); touchMask(V);
  }
  function restoreBase() { if (g?.base) { S.writeAlpha(g.V.mask, g.base); touchMask(g.V); } }

  function downBrush(e, p, tool) {
    const V = view(), mode = S.effectiveMode(e, tool);
    g = { type: 'brush', tool, V, mode, size: state.ui.brushSize, hardness: state.ui.brushHardness, pts: [p], base: S.readAlpha(V.mask), baseC: cloneCanvas(V.mask), strokeC: makeCanvas() };
    g.tip = g.hardness < 0.98 && g.size >= 3 ? tipCanvas(g.size, g.hardness) : null;
    if (mode === 'replace') { /* the stroke replaces the old selection: base is only kept for cancel */ }
    paintStroke(p, p); compose(); request();
  }
  function moveBrush(p) {
    const last = g.pts[g.pts.length - 1];
    if (dist(last, p) < 0.01) return;
    g.pts.push(p); paintStroke(last, p); compose(); request();
  }
  function upBrush() {
    const V = g.V, { pts, mode, size, hardness } = g;
    restoreBase();
    const shape = S.eng.brush(pts.length === 1 ? [pts[0], { x: pts[0].x + 0.001, y: pts[0].y }] : pts, size, hardness);
    S.commitShape(shape, mode, g.tool === 'eraser' ? 'Erase' : mode === 'subtract' ? 'Brush (remove)' : 'Brush', { V });
  }

  /* ---------- lasso / rectangle ---------- */
  function downLasso(e, p) { g = { type: 'lasso', V: view(), mode: S.effectiveMode(e, 'lasso'), pts: [p] }; request(); }
  function moveLasso(p) { const l = g.pts[g.pts.length - 1]; if (dist(l, p) * zoom() >= 1.5) { g.pts.push(p); request(); } }
  function upLasso(p) {
    g.pts.push(p);
    if (g.pts.length < 3 || polyArea(g.pts) * zoom() * zoom() < 4) { S.hint('Draw a loop around the area, then let go.'); return; }
    S.commitShape(S.eng.lasso(g.pts), g.mode, 'Lasso', { V: g.V });
  }
  const polyArea = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const q = pts[(i + 1) % pts.length]; a += pts[i].x * q.y - q.x * pts[i].y; } return Math.abs(a) / 2; };
  function downRect(e, p) { g = { type: 'rect', V: view(), mode: S.effectiveMode(e, 'rect'), a: p, b: p }; request(); }
  function upRect(p) {
    g.b = p;
    if (Math.abs(g.a.x - g.b.x) * zoom() < 2 && Math.abs(g.a.y - g.b.y) * zoom() < 2) return;
    S.commitShape(S.eng.rect(g.a, g.b), g.mode, 'Rectangle', { V: g.V });
  }

  /* ---------- polygon ---------- */
  function polyReset() { poly.pts = []; request(); }
  function polyFinish() {
    const V = view();
    if (poly.pts.length < 3) { S.hint('A polygon needs at least 3 points. Keep clicking, or press Esc to cancel.'); return false; }
    const pts = poly.pts.slice(), mode = poly.mode;
    poly.pts = [];
    S.commitShape(S.eng.polygon(pts), mode, 'Polygon', { V });
    request(); return true;
  }
  function downPoly(e, p) {
    const z = zoom(), now = performance.now();
    if (!poly.pts.length) poly.mode = S.effectiveMode(e, 'polygon');
    if (poly.pts.length >= 3 && dist(p, poly.pts[0]) * z < 9) { polyFinish(); return; }
    const last = poly.pts[poly.pts.length - 1];
    if (last && dist(p, last) * z < 4 && now - poly.t < 450) { polyFinish(); return; }   // double click
    poly.pts.push(p); poly.t = now; request();
  }

  /* ---------- click tools ---------- */
  function pickAction(tool, p, e) {
    const V = view(), mode = S.effectiveMode(e, tool);
    lastPick = null;
    let ok = false;
    const before = S.selTopId();
    if (tool === 'region') {
      if (!S.needSeg(V)) return;
      const name = S.regionAt(V.seg, p.x, p.y);
      if (!name || !V.seg.regions[name]) { S.hint('No garment part under the pointer. Click on the garment.'); return; }
      onPickPart?.(name);
      const m = mode === 'add' && !e?.shiftKey && V.regionSel.includes(name) ? 'subtract' : mode;
      ok = S.regionOp([name], m, V);
    } else {
      let shape;
      try { shape = S.pickShape(tool, V, p); } catch (err) { console.error(err); S.hint('That could not be selected here. Try the Brush or Lasso.'); return; }
      if (!shape) { if (tool !== 'component' && tool !== 'smart') S.hint('Nothing could be picked there. Click on the garment.'); return; }
      if (S.alphaIsEmpty(shape, 8)) { S.hint('Nothing matched there. Try a higher tolerance, or another tool.'); return; }
      ok = S.commitShape(shape, mode, { wand: 'Magic wand', color: 'Select by colour', texture: 'Select by material', component: 'Whole part', smart: 'Smart select' }[tool], { V });
    }
    if (ok && ['wand', 'color', 'texture'].includes(tool)) lastPick = { tool, p, e: { shiftKey: !!e?.shiftKey, altKey: !!e?.altKey }, id: S.selTopId(), view: V };
    else if (!ok && before === S.selTopId()) { /* identical selection: nothing recorded */ }
  }

  const api = {
    get busy() { return !!g || poly.pts.length > 0; },
    get dragging() { return !!g && g.type === 'brush'; },
    down(e, p, scr) {
      const tool = state.ui.tool;
      if (!isTool(tool)) return false;
      if (tool === 'brush' || tool === 'eraser') { downBrush(e, p, tool); return true; }
      if (tool === 'lasso') { downLasso(e, p); return true; }
      if (tool === 'rect') { downRect(e, p); return true; }
      if (tool === 'polygon') { downPoly(e, p); g = { type: 'poly-click', V: view() }; return true; }
      g = { type: 'pick', tool, e, sx: scr.sx, sy: scr.sy, moved: false, p };
      return true;
    },
    /** returns 'pan' when a click tool turned into a pan (the pointer moved a lot) */
    move(e, p, scr) {
      hoverP = p;
      if (!g) return null;
      if (g.type === 'brush') moveBrush(p);
      else if (g.type === 'lasso') moveLasso(p);
      else if (g.type === 'rect') { g.b = p; request(); }
      else if (g.type === 'pick') { if (Math.hypot(scr.sx - g.sx, scr.sy - g.sy) > 6) { g.moved = true; return 'pan'; } }
      return null;
    },
    up(e, p) {
      if (!g) return;
      const k = g;
      try {
        if (k.type === 'brush') upBrush();
        else if (k.type === 'lasso') upLasso(p);
        else if (k.type === 'rect') upRect(p);
        else if (k.type === 'pick' && !k.moved) pickAction(k.tool, k.p, k.e);
      } catch (err) { console.error(err); S.hint('That selection could not be made. Try again, or use another tool.', 'error'); }
      g = null; request();
    },
    cancel() { if (g) { if (g.type === 'brush') restoreBase(); g = null; request(); } },
    hover(p) { hoverP = p; if (poly.pts.length) request(); },
    /** Enter / Backspace / Esc while a polygon or a gesture is in progress. Returns true when consumed. */
    key(e) {
      if (g && g.type !== 'poly-click' && e.key === 'Escape') { api.cancel(); return true; }
      if (poly.pts.length) {
        if (e.key === 'Enter') { polyFinish(); return true; }
        if (e.key === 'Backspace' || e.key === 'Delete') { poly.pts.pop(); request(); return true; }
        if (e.key === 'Escape') { polyReset(); return true; }
      }
      return false;
    },
    /** image-space preview of the gesture in progress (the stage has applied its transform) */
    drawPreview(ctx, z, now) {
      const u = 1 / z;
      if (g && (g.type === 'lasso') && g.pts.length > 1) {
        const path = new Path2D(); path.moveTo(g.pts[0].x, g.pts[0].y); for (const q of g.pts) path.lineTo(q.x, q.y); path.closePath();
        ctx.save(); ctx.fillStyle = 'rgba(79,70,229,.14)'; ctx.fill(path); ctx.restore(); strokeAnts(ctx, path, z, now);
      } else if (g && g.type === 'rect') {
        const path = new Path2D(); path.rect(Math.min(g.a.x, g.b.x), Math.min(g.a.y, g.b.y), Math.abs(g.a.x - g.b.x), Math.abs(g.a.y - g.b.y));
        ctx.save(); ctx.fillStyle = 'rgba(79,70,229,.14)'; ctx.fill(path); ctx.restore(); strokeAnts(ctx, path, z, now);
      }
      if (poly.pts.length && state.ui.tool === 'polygon') {
        const path = new Path2D(); path.moveTo(poly.pts[0].x, poly.pts[0].y); for (const q of poly.pts) path.lineTo(q.x, q.y);
        if (hoverP) path.lineTo(hoverP.x, hoverP.y);
        if (poly.pts.length >= 3) { ctx.save(); const f = new Path2D(path); f.closePath(); ctx.fillStyle = 'rgba(79,70,229,.12)'; ctx.fill(f); ctx.restore(); }
        strokeAnts(ctx, path, z, now, { animate: false });
        ctx.save();
        poly.pts.forEach((q, i) => {
          ctx.beginPath(); ctx.arc(q.x, q.y, (i === 0 ? 5 : 3.2) * u, 0, 7);
          ctx.fillStyle = i === 0 ? '#fff' : '#4f46e5'; ctx.fill(); ctx.lineWidth = 1.5 * u; ctx.strokeStyle = i === 0 ? '#4f46e5' : '#fff'; ctx.stroke();
        });
        ctx.restore();
      }
    },
    polygonPoints: () => poly.pts.map(q => ({ ...q })),
    brushRadius: () => state.ui.brushSize / 2,
  };
  const unsub = (r) => {
    if (r === 'view' || r === 'loaded') { poly.pts = []; g = null; }
    else if (r === 'tool' && state.ui.tool !== 'polygon' && poly.pts.length) poly.pts = [];
  };
  subscribe(unsub);
  function retune() {
    const lp = lastPick;
    if (!lp || S.selTopId() !== lp.id || activeView() !== lp.view) return false;
    S.selUndo(); pickAction(lp.tool, lp.p, lp.e);
    return true;
  }
  ref = { api, retune };
  return api;
}

/** After a wand / colour / texture click, changing the tolerance re-runs that click (replacing the step, not adding one). */
export function retunePick() { return ref ? ref.retune() : false; }
