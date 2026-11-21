// Stage: the big editing canvas (zoom / rotate / pan, brush, region pick, element handles, compare slider).
import { state, activeView, snapshot, notify, subscribe } from './state.js';
import { SIZE, makeCanvas, clamp } from './util.js';
import { regionAt } from './segment.js';
import { drawElements, hitTest, beginDrag, dragTo, handlesFor } from './elements.js';
import { selectedSet, toggleInSelection, snapContext, snapBox, unionBounds } from './arrange-ops.js';
import { closeGate, setActivePart, handleElementKey } from './manual.js';
import { designMeasure, drawDimensionLines } from './measure.js';
import { isSelTool, selectionBounds, hint } from './selection.js';
import { createOverlay } from './sel-overlay.js';
import { createSelTools } from './sel-tools.js';
import { stageCanvas, paintCompare } from './review.js';

export const MAX_ZOOM = 10, MIN_ZOOM = 0.15;   // 1000 % ... 15 %

const ACCENT = [79, 70, 229];
const tintCache = new WeakMap();
let checker = null;
function checkerPattern(ctx) {
  if (!checker) {
    const c = makeCanvas(32, 32), x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 32, 32);
    x.fillStyle = '#efeeea'; x.fillRect(0, 0, 16, 16); x.fillRect(16, 16, 16, 16);
    checker = c;
  }
  return ctx.createPattern(checker, 'repeat');
}
function tinted(src, alpha) {
  let t = tintCache.get(src);
  if (!t) {
    t = makeCanvas(src.width, src.height);
    const x = t.getContext('2d');
    x.drawImage(src, 0, 0); x.globalCompositeOperation = 'source-in';
    x.fillStyle = `rgba(${ACCENT},${alpha})`; x.fillRect(0, 0, t.width, t.height);
    tintCache.set(src, t);
  }
  return t;
}

export function createStage(el, wrap) {
  const ctx = el.getContext('2d');
  const T = { zoom: 0.7, rot: 0, px: 0, py: 0 };   // px,py = pan offset of image centre from stage centre (css px)
  let W = 0, H = 0, dpr = 1, raf = 0, animT = 0;
  let guides = [], hover = null, hoverRegion = null, drag = null, spaceDown = false, lastPt = null, moveCursor = '', pinch = null;
  const ptrs = new Map();   // active touch pointers (two fingers = pan + pinch zoom)

  let lastBox = null;
  function resize() {
    const r = wrap.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    // when the stage moves because something above it grew (the selection options row), keep the picture where it is on screen
    if (lastBox && W) {
      const dy = r.top - lastBox.top, dx = r.left - lastBox.left;
      if (Math.abs(dy) > 0.5 && Math.abs(dy) < 400) T.py += -dy + (lastBox.h - r.height) / 2;
      if (Math.abs(dx) > 0.5 && Math.abs(dx) < 400) T.px += -dx + (lastBox.w - r.width) / 2;
    }
    lastBox = { top: r.top, left: r.left, h: r.height, w: r.width };
    W = Math.max(50, r.width); H = Math.max(50, r.height);
    el.width = Math.round(W * dpr); el.height = Math.round(H * dpr);
    el.style.width = W + 'px'; el.style.height = H + 'px';
    request();
  }
  new ResizeObserver(resize).observe(wrap);

  const request = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  const overlay = createOverlay(request);
  const tools = createSelTools({ request, zoom: () => T.zoom, onPickPart: setActivePart });

  // ---- coordinate transforms (exact at any zoom; sub-pixel) ----
  function toImage(sx, sy) {
    const dx = sx - (W / 2 + T.px), dy = sy - (H / 2 + T.py);
    const a = -T.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: (dx * c - dy * s) / T.zoom + SIZE / 2, y: (dx * s + dy * c) / T.zoom + SIZE / 2 };
  }
  /** image point -> stage css px (the inverse of toImage) */
  function toScreen(ix, iy) {
    const a = T.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = (ix - SIZE / 2) * T.zoom, dy = (iy - SIZE / 2) * T.zoom;
    return { sx: W / 2 + T.px + dx * c - dy * s, sy: H / 2 + T.py + dx * s + dy * c };
  }
  /** pans so that image point `ip` sits under stage point (sx, sy) */
  function anchor(ip, sx, sy) {
    const a = T.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = (ip.x - SIZE / 2) * T.zoom, dy = (ip.y - SIZE / 2) * T.zoom;
    T.px = sx - W / 2 - (dx * c - dy * s); T.py = sy - H / 2 - (dx * s + dy * c);
  }
  function pt(e) { const r = el.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
  function applyT(c) {
    c.translate(W / 2 + T.px, H / 2 + T.py); c.rotate(T.rot * Math.PI / 180); c.scale(T.zoom, T.zoom); c.translate(-SIZE / 2, -SIZE / 2);
  }

  // ---- drawing ----
  function draw() {
    const V = activeView(), now = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save(); applyT(ctx);
    ctx.shadowColor = 'rgba(30,30,40,.14)'; ctx.shadowBlur = 24 / T.zoom; ctx.shadowOffsetY = 6 / T.zoom;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = checkerPattern(ctx); ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.imageSmoothingQuality = 'high';
    ctx.imageSmoothingEnabled = T.zoom < 2.5;     // zoomed right in, show true pixels so small details can be selected exactly
    if (V.current) {
      ctx.drawImage(stageCanvas(V), 0, 0);   // the previewed option while a review is open (review.js)
      ctx.imageSmoothingEnabled = true;
      if (state.ui.tool === 'region' && hoverRegion && V.seg?.regions?.[hoverRegion]) ctx.drawImage(tinted(V.seg.regions[hoverRegion], 0.35), 0, 0);
      const sset = state.ui.tool === 'move' ? selectedSet() : [];
      drawElements(ctx, state.elements, state.activeView, { selectedId: state.selectedId, handles: state.ui.tool === 'move' && sset.length < 2, handleScale: 1 / T.zoom });
      if (sset.length > 1) drawMultiSelection(ctx, sset, 1 / T.zoom);
      if (guides.length) drawGuides(ctx, guides, 1 / T.zoom);
      if (state.measure && state.measure.show) {   // dimension lines: overlay only, never part of the garment bitmap
        const dm = designMeasure(state, state.activeView);
        if (dm) drawDimensionLines(ctx, dm.seg, dm.rows, { unit: dm.unit, fontPx: clamp(13 / T.zoom, 15, 30), lineW: clamp(1.4 / T.zoom, 1.4, 3) });
      }
      overlay.draw(ctx, V, T.zoom, now, tools.dragging);   // selection: marching ants + optional tint, never hides the garment
      tools.drawPreview(ctx, T.zoom, now);
    }
    // viewport border
    ctx.lineWidth = 1 / T.zoom; ctx.strokeStyle = 'rgba(0,0,0,.08)'; ctx.strokeRect(0, 0, SIZE, SIZE);
    ctx.restore();

    // before / after compare: slider, side by side, flip, hold to peek (review.js)
    if ((state.ui.compare || state.ui.peek) && V.current) {
      paintCompare(ctx, {
        W, H, SIZE, pattern: checkerPattern(ctx),
        applyT: (c, dx = 0) => { c.translate(dx, 0); applyT(c); },
        extras: c => drawElements(c, state.elements, state.activeView, { selectedId: null, handles: false, handleScale: 1 / T.zoom }),
      });
    }
    // brush / eraser cursor: a circle in real image size, so it grows with the zoom
    const tool = state.ui.tool;
    if ((tool === 'brush' || tool === 'eraser') && hover && hover.type !== 'touch' && !pinch) {
      const r = state.ui.brushSize / 2 * T.zoom, er = tool === 'eraser';
      ctx.save();
      ctx.beginPath(); ctx.arc(hover.sx, hover.sy, Math.max(r, 2), 0, 7);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.stroke();
      ctx.lineWidth = 1.4; ctx.strokeStyle = er ? '#e11d48' : '#1c1c1f'; ctx.stroke();
      if (state.ui.brushHardness < 0.98 && r > 8) { ctx.beginPath(); ctx.arc(hover.sx, hover.sy, r * state.ui.brushHardness, 0, 7); ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.stroke(); }
      ctx.setLineDash([]); ctx.beginPath(); ctx.arc(hover.sx, hover.sy, 1.4, 0, 7); ctx.fillStyle = er ? '#e11d48' : '#1c1c1f'; ctx.fill();
      ctx.restore();
    } else if (isSelTool(tool) && hover && hover.type !== 'touch' && !drag) {   // a small crosshair marks the exact pixel for the other tools
      ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.moveTo(hover.sx - 7, hover.sy); ctx.lineTo(hover.sx + 7, hover.sy); ctx.moveTo(hover.sx, hover.sy - 7); ctx.lineTo(hover.sx, hover.sy + 7); ctx.stroke();
      ctx.lineWidth = 1.3; ctx.strokeStyle = '#1c1c1f'; ctx.stroke(); ctx.restore();
    }
    updateCursor();
    // keep the ants walking (about 15 frames a second is plenty and cheap)
    if (!animT && !document.hidden && overlay.animating(V)) animT = setTimeout(() => { animT = 0; request(); }, 66);
  }

  function updateCursor() {
    let c = '';
    if (pinch) c = 'grabbing';
    else if (drag && (drag.type === 'pan' || drag.type === 'selpan')) c = 'grabbing';
    else if (spaceDown) c = 'grab';
    else if (state.ui.compare && state.ui.compareMode === 'slider' && hover && Math.abs(hover.sx - state.ui.comparePos * W) < 20) c = 'ew-resize';
    else if (state.ui.tool === 'brush' || state.ui.tool === 'eraser') c = 'none';
    else if (isSelTool(state.ui.tool)) c = state.ui.tool === 'region' && hoverRegion ? 'pointer' : 'crosshair';
    else c = moveCursor;
    if (el.style.cursor !== c) el.style.cursor = c;
  }

  const hitOpts = () => ({ selectedId: selectedSet().length > 1 ? null : state.selectedId, handleScale: 1 / T.zoom, handleSize: 14 / T.zoom });
  const panFrom = (d, sx, sy) => { T.px = d.px + sx - d.sx; T.py = d.py + sy - d.sy; };


  /** Moves the dragged item's mates along, then snaps the whole moving set to garment / canvas / item lines (hold Alt to skip). */
  function moveWithSnap(e) {
    const el0 = drag.el, set = [el0, ...drag.mates.map(m => m.el)];
    const dx = el0.x - drag.d.ox, dy = el0.y - drag.d.oy;
    for (const m of drag.mates) { m.el.x = m.ox + dx; m.el.y = m.oy + dy; }
    guides = [];
    if (!state.ui.snap || e.altKey) return;
    const r = snapBox(unionBounds(set), snapContext(set), 6 / T.zoom);
    if (r.dx || r.dy) for (const m of set) { m.x += r.dx; m.y += r.dy; }
    guides = r.guides;
  }
  function drawMultiSelection(c, set, k) {
    c.save(); c.lineWidth = 1.5 * k; c.strokeStyle = '#2d7ff9'; c.setLineDash([6 * k, 4 * k]);
    for (const m of set) { const hs = handlesFor(m, k); c.beginPath(); ['scale-nw', 'scale-ne', 'scale-se', 'scale-sw'].forEach((n, i) => (i ? c.lineTo(hs[n].x, hs[n].y) : c.moveTo(hs[n].x, hs[n].y))); c.closePath(); c.stroke(); }
    const b = unionBounds(set); c.strokeStyle = 'rgba(45,127,249,.55)'; c.strokeRect(b.x0, b.y0, b.w, b.h);
    c.restore();
  }
  function drawGuides(c, gs, k) {
    c.save(); c.lineWidth = 1.2 * k; c.strokeStyle = '#e11d89'; c.setLineDash([5 * k, 3 * k]);
    for (const g of gs) { c.beginPath(); if (g.axis === 'x') { c.moveTo(g.pos, 0); c.lineTo(g.pos, SIZE); } else { c.moveTo(0, g.pos); c.lineTo(SIZE, g.pos); } c.stroke(); }
    c.restore();
  }

  // ---- pointer handling ----
  el.addEventListener('pointerdown', e => {
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointers cannot be captured */ }
    closeGate();
    const { sx, sy } = pt(e), p = toImage(sx, sy), V = activeView();
    hover = { sx, sy, type: e.pointerType };
    if (e.pointerType === 'touch') {
      ptrs.set(e.pointerId, { sx, sy });
      if (ptrs.size === 2) {   // second finger: stop whatever the first one was doing, then pan + pinch
        tools.cancel(); drag = { type: 'none' };
        const [a, b] = [...ptrs.values()], cx = (a.sx + b.sx) / 2, cy = (a.sy + b.sy) / 2;
        pinch = { d0: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, z0: T.zoom, ip: toImage(cx, cy) };
        return;
      }
      if (ptrs.size > 2) return;
    }
    if (state.ui.compare && state.ui.compareMode === 'slider') {
      const split = state.ui.comparePos * W;
      if (Math.abs(sx - split) < 20) { drag = { type: 'compare' }; return; }
    }
    if (e.button === 1 || spaceDown || e.button === 2) { drag = { type: 'pan', sx, sy, px: T.px, py: T.py }; e.preventDefault(); return; }
    if (!V.current) { drag = { type: 'pan', sx, sy, px: T.px, py: T.py }; return; }
    const tool = state.ui.tool;
    if (isSelTool(tool)) {
      drag = { type: 'sel', sx, sy, px: T.px, py: T.py };
      if (!tools.down(e, p, { sx, sy })) drag = { type: 'pan', sx, sy, px: T.px, py: T.py };
      return;
    }
    // move tool: elements first, then pan
    const hit = hitTest(state.elements, state.activeView, p.x, p.y, hitOpts());
    if (hit && hit.element) {
      const el0 = hit.element;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleInSelection(el0.id); request(); drag = { type: 'none' }; return; }   // add to / remove from the selection
      if (!selectedSet().includes(el0)) { state.selectedId = el0.id; state.ui.multi = []; state.ui.multiFor = el0.id; }   // a click inside the current selection keeps it (and drags all of it)
      notify('selection'); request();
      // locked elements can be selected but not moved; otherwise the undo snapshot is taken on the first real move
      if (el0.locked) { drag = { type: 'none' }; return; }
      const kind = hit.handle || 'move', mates = kind === 'move' ? selectedSet().filter(m => m !== el0 && !m.locked).map(m => ({ el: m, ox: m.x, oy: m.y })) : [];
      drag = { type: kind, el: el0, mates, snapped: false, d: beginDrag(el0, kind, p.x, p.y) };
      return;
    }
    // no element here: a click on the garment picks that part for the colour panel (dragging still pans)
    const partName = V.seg ? regionAt(V.seg, p.x, p.y) : null;
    if (partName) setActivePart(partName);
    if (state.selectedId) { state.selectedId = null; notify('selection'); }
    drag = { type: 'pan', sx, sy, px: T.px, py: T.py };
  });

  el.addEventListener('pointermove', e => {
    const { sx, sy } = pt(e), p = toImage(sx, sy);
    hover = { sx, sy, type: e.pointerType }; lastPt = p;
    if (e.pointerType === 'touch' && ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { sx, sy });
    if (pinch) {
      if (ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1;
        T.zoom = clamp(pinch.z0 * d / pinch.d0, MIN_ZOOM, MAX_ZOOM); anchor(pinch.ip, (a.sx + b.sx) / 2, (a.sy + b.sy) / 2);
        request(); notify('zoom');
      }
      return;
    }
    if (!drag) {
      const V = activeView();
      if (state.ui.tool === 'region') {
        const n = V.seg ? regionAt(V.seg, p.x, p.y) : null;
        if (n !== hoverRegion) hoverRegion = n;
      } else if (state.ui.tool === 'move' && V.current) {
        const hit = hitTest(state.elements, state.activeView, p.x, p.y, hitOpts());
        moveCursor = !hit ? '' : hit.handle === 'rotate' ? 'alias' : hit.handle?.startsWith('scale') ? 'nwse-resize' : 'move';
      }
      tools.hover(p);
      request(); return;
    }
    if (drag.type === 'pan') panFrom(drag, sx, sy);
    else if (drag.type === 'selpan') panFrom(drag, sx, sy);
    else if (drag.type === 'compare') { state.ui.comparePos = clamp(sx / W, 0.03, 0.97); }
    else if (drag.type === 'sel') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ce of (evs.length ? evs : [e])) {
        const q = pt(ce), r = tools.move(ce, toImage(q.sx, q.sy), q);
        if (r === 'pan') { drag.type = 'selpan'; panFrom(drag, sx, sy); break; }
      }
    } else if (drag.el) {
      if (!drag.snapped) { snapshot(); drag.snapped = true; }   // one undo step per drag, taken before the first move
      dragTo(drag.d, p.x, p.y);
      if (drag.type === 'move') moveWithSnap(e);
      notify('elements-live');
    }
    request();
  });
  const end = e => {
    if (e.pointerType === 'touch') {
      ptrs.delete(e.pointerId);
      if (pinch) { if (ptrs.size < 2) pinch = null; if (!ptrs.size) drag = null; request(); return; }
    }
    if (!drag) return;
    if (drag.type === 'sel' || drag.type === 'selpan') {
      const { sx, sy } = pt(e);
      if (e.type === 'pointercancel') tools.cancel(); else tools.up(e, toImage(sx, sy));
    } else if (drag.el) notify('elements');
    guides = [];
    drag = null; request();
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; hover = null; hoverRegion = null; request(); });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const { sx, sy } = pt(e);
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    zoomAt(sx, sy, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });

  /** zooms by factor f keeping the image point under (sx, sy) exactly where it is */
  function zoomAt(sx, sy, f) {
    const nz = clamp(T.zoom * f, MIN_ZOOM, MAX_ZOOM); if (nz === T.zoom) return;
    const ip = toImage(sx, sy);
    T.zoom = nz; anchor(ip, sx, sy);
    request(); notify('zoom');
  }
  function zoomRect(r, { pad = 0.12, max = 8 } = {}) {
    const z = clamp(Math.min(W / (r.w * (1 + pad * 2)), H / (r.h * (1 + pad * 2))), MIN_ZOOM, max);
    T.zoom = z; anchor({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, W / 2, H / 2); request(); notify('zoom');
  }
  window.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (!typing && tools.key(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement?.tagName || '')) { spaceDown = true; e.preventDefault(); request(); }
    handleElementKey(e);   // Delete / arrow nudges / Ctrl+D / Esc on the selected element (manual.js)
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; request(); } });
  window.addEventListener('blur', () => { spaceDown = false; });

  const api = {
    draw: request, resize,
    get zoom() { return T.zoom; },
    get view() { return { zoom: T.zoom, px: T.px, py: T.py, rot: T.rot, w: W, h: H }; },
    fit() { T.zoom = clamp(Math.min(W, H) * 0.92 / SIZE, MIN_ZOOM, 3); T.px = T.py = 0; request(); notify('zoom'); },
    zoomBy(f) { zoomAt(W / 2 + T.px, H / 2 + T.py, f); },
    /** absolute zoom (1 = 100 %), around the stage centre unless a stage point is given */
    zoomTo(z, sx = W / 2, sy = H / 2) { zoomAt(sx, sy, clamp(z, MIN_ZOOM, MAX_ZOOM) / T.zoom); },
    zoomAt,
    zoomRect,
    /** pans so image point (x, y) is in the middle of the stage */
    centerOn(x, y) { anchor({ x, y }, W / 2, H / 2); request(); notify('zoom'); },
    zoomToSelection() {
      const b = selectionBounds(activeView());
      if (!b) { hint('Nothing is selected yet. Select an area first, then zoom to it.'); return false; }
      zoomRect(b); return true;
    },
    rotateBy(d) { T.rot = (T.rot + d) % 360; request(); },
    resetRotation() { T.rot = 0; request(); },
    get rotation() { return T.rot; },
    toImage, toScreen,
    lastPoint: () => lastPt,
    tools,
    overlay,
  };
  subscribe(() => request());
  resize(); api.fit();
  return api;
}
