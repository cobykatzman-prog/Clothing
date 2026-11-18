// Stage: the big editing canvas (zoom / rotate / pan, brush, region pick, element handles, compare slider).
import { state, activeView, snapshot, notify, subscribe, touchMask, markFlow } from './state.js';
import { SIZE, makeCanvas, clamp } from './util.js';
import { regionAt } from './segment.js';
import { drawElements, hitTest } from './elements.js';
import { toggleRegion } from './ui-actions.js';

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
  let W = 0, H = 0, dpr = 1, raf = 0;
  let hover = null, hoverRegion = null, drag = null, spaceDown = false, lastPt = null;

  function resize() {
    const r = wrap.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(50, r.width); H = Math.max(50, r.height);
    el.width = Math.round(W * dpr); el.height = Math.round(H * dpr);
    el.style.width = W + 'px'; el.style.height = H + 'px';
    request();
  }
  new ResizeObserver(resize).observe(wrap);

  const request = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };

  // ---- coordinate transforms ----
  function toImage(sx, sy) {
    const dx = sx - (W / 2 + T.px), dy = sy - (H / 2 + T.py);
    const a = -T.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: (dx * c - dy * s) / T.zoom + SIZE / 2, y: (dx * s + dy * c) / T.zoom + SIZE / 2 };
  }
  function pt(e) { const r = el.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
  function applyT(c) {
    c.translate(W / 2 + T.px, H / 2 + T.py); c.rotate(T.rot * Math.PI / 180); c.scale(T.zoom, T.zoom); c.translate(-SIZE / 2, -SIZE / 2);
  }

  // ---- drawing ----
  function draw() {
    const V = activeView();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save(); applyT(ctx);
    ctx.shadowColor = 'rgba(30,30,40,.14)'; ctx.shadowBlur = 24 / T.zoom; ctx.shadowOffsetY = 6 / T.zoom;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = checkerPattern(ctx); ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.imageSmoothingQuality = 'high';
    if (V.current) {
      ctx.drawImage(V.current, 0, 0);
      if (state.ui.showMask && V.mask) { ctx.globalAlpha = 0.5; ctx.drawImage(V.mask, 0, 0); ctx.globalAlpha = 1; }
      if (state.ui.tool === 'region' && hoverRegion && V.seg?.regions?.[hoverRegion]) ctx.drawImage(tinted(V.seg.regions[hoverRegion], 0.35), 0, 0);
      drawElements(ctx, state.elements, state.activeView, { selectedId: state.selectedId, handles: state.ui.tool === 'move' });
    }
    // viewport border
    ctx.lineWidth = 1 / T.zoom; ctx.strokeStyle = 'rgba(0,0,0,.08)'; ctx.strokeRect(0, 0, SIZE, SIZE);
    ctx.restore();

    // before/after compare
    if (state.ui.compare && V.current) {
      const sx = state.ui.comparePos * W;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, sx, H); ctx.clip();
      applyT(ctx);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE); ctx.fillStyle = checkerPattern(ctx); ctx.fillRect(0, 0, SIZE, SIZE);
      const before = V.original || V.base;
      if (before) ctx.drawImage(before, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
      ctx.beginPath(); ctx.arc(sx, H / 2, 16, 0, 7); ctx.fill(); ctx.shadowColor = 'transparent';
      ctx.strokeStyle = `rgb(${ACCENT})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx - 5, H / 2 - 5); ctx.lineTo(sx - 9, H / 2); ctx.lineTo(sx - 5, H / 2 + 5);
      ctx.moveTo(sx + 5, H / 2 - 5); ctx.lineTo(sx + 9, H / 2); ctx.lineTo(sx + 5, H / 2 + 5); ctx.stroke();
      const pill = (txt, x) => { ctx.font = '600 12px system-ui,sans-serif'; const w = ctx.measureText(txt).width + 16; ctx.fillStyle = 'rgba(20,20,30,.72)'; ctx.beginPath(); ctx.roundRect(x - (x < sx ? 0 : w), 12, w, 24, 12); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(txt, x - (x < sx ? 0 : w) + 8, 28); };
      pill('Before', 12); pill('After', W - 12);
      ctx.restore();
    }
    // brush cursor
    if ((state.ui.tool === 'brush') && hover && !drag) {
      const r = state.ui.brushSize / 2 * T.zoom;
      ctx.save(); ctx.lineWidth = 1.5;
      ctx.strokeStyle = state.ui.brushMode === 'erase' ? '#e11d48' : `rgb(${ACCENT})`;
      ctx.fillStyle = 'rgba(255,255,255,.2)';
      ctx.beginPath(); ctx.arc(hover.sx, hover.sy, r, 0, 7); ctx.fill(); ctx.stroke(); ctx.restore();
    }
  }

  // ---- brush ----
  function stroke(a, b) {
    const V = activeView(), x = V.mask.getContext('2d');
    x.save();
    x.lineCap = x.lineJoin = 'round'; x.lineWidth = state.ui.brushSize;
    if (state.ui.brushMode === 'erase') { x.globalCompositeOperation = 'destination-out'; x.strokeStyle = '#000'; x.fillStyle = '#000'; }
    else { x.strokeStyle = `rgb(${ACCENT})`; x.fillStyle = `rgb(${ACCENT})`; }
    x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x + 0.01, b.y); x.stroke();
    x.beginPath(); x.arc(b.x, b.y, state.ui.brushSize / 2, 0, 7); x.fill();
    x.restore();
    touchMask(V);
  }

  // ---- pointer handling ----
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    const { sx, sy } = pt(e), p = toImage(sx, sy), V = activeView();
    if (state.ui.compare) {
      const split = state.ui.comparePos * W;
      if (Math.abs(sx - split) < 20) { drag = { type: 'compare' }; return; }
    }
    if (e.button === 1 || spaceDown || e.button === 2) { drag = { type: 'pan', sx, sy, px: T.px, py: T.py }; return; }
    if (!V.current) { drag = { type: 'pan', sx, sy, px: T.px, py: T.py }; return; }
    const tool = state.ui.tool;
    if (tool === 'brush') {
      snapshot();
      drag = { type: 'brush', last: p };
      stroke(p, p); request(); return;
    }
    if (tool === 'region') {
      const name = regionAt(V.seg, p.x, p.y);
      if (name) toggleRegion(name);
      else drag = { type: 'pan', sx, sy, px: T.px, py: T.py };
      return;
    }
    // move tool: elements first, then pan
    const hit = hitTest(state.elements, state.activeView, p.x, p.y);
    if (hit && hit.element) {
      const el0 = hit.element;
      state.selectedId = el0.id;
      snapshot();
      drag = { type: hit.handle || 'move', el: el0, p0: p, s: { x: el0.x, y: el0.y, w: el0.w, h: el0.h, rot: el0.rotation || 0 } };
      notify('selection'); request(); return;
    }
    if (state.selectedId) { state.selectedId = null; notify('selection'); }
    drag = { type: 'pan', sx, sy, px: T.px, py: T.py };
  });

  el.addEventListener('pointermove', e => {
    const { sx, sy } = pt(e), p = toImage(sx, sy);
    hover = { sx, sy }; lastPt = p;
    if (!drag) {
      if (state.ui.tool === 'region') {
        const V = activeView(); const n = V.seg ? regionAt(V.seg, p.x, p.y) : null;
        if (n !== hoverRegion) { hoverRegion = n; el.style.cursor = n ? 'pointer' : 'default'; }
      } else if (state.ui.tool === 'move' && activeView().current) {
        const hit = hitTest(state.elements, state.activeView, p.x, p.y);
        el.style.cursor = !hit ? (spaceDown ? 'grab' : 'default') : hit.handle === 'rotate' ? 'alias' : hit.handle?.startsWith('scale') ? 'nwse-resize' : 'move';
      }
      if (state.ui.compare) el.style.cursor = Math.abs(sx - state.ui.comparePos * W) < 20 ? 'ew-resize' : el.style.cursor;
      request(); return;
    }
    if (drag.type === 'pan') { T.px = drag.px + sx - drag.sx; T.py = drag.py + sy - drag.sy; }
    else if (drag.type === 'compare') { state.ui.comparePos = clamp(sx / W, 0.03, 0.97); }
    else if (drag.type === 'brush') { stroke(drag.last, p); drag.last = p; }
    else if (drag.el) {
      const el0 = drag.el, s = drag.s;
      if (drag.type === 'move') { el0.x = s.x + p.x - drag.p0.x; el0.y = s.y + p.y - drag.p0.y; }
      else if (drag.type === 'rotate') {
        const a0 = Math.atan2(drag.p0.y - s.y, drag.p0.x - s.x), a1 = Math.atan2(p.y - s.y, p.x - s.x);
        el0.rotation = s.rot + (a1 - a0) * ROT_UNIT;
      } else if (drag.type.startsWith('scale')) {
        const d0 = Math.hypot(drag.p0.x - s.x, drag.p0.y - s.y) || 1, d1 = Math.hypot(p.x - s.x, p.y - s.y);
        const f = clamp(d1 / d0, 0.1, 12);
        el0.w = s.w * f; el0.h = s.h * f;
      }
    }
    request();
  });
  const end = e => {
    if (!drag) return;
    if (drag.type === 'brush') { markFlow('described'); state.flow.skippedSelect = false; notify('mask'); }
    else if (drag.el) notify('elements');
    drag = null; request();
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => { hover = null; hoverRegion = null; request(); });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const { sx, sy } = pt(e);
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(sx, sy, f);
  }, { passive: false });

  function zoomAt(sx, sy, f) {
    const nz = clamp(T.zoom * f, 0.15, 6), k = nz / T.zoom;
    const cx = W / 2 + T.px, cy = H / 2 + T.py;
    T.px = sx - (sx - cx) * k - W / 2; T.py = sy - (sy - cy) * k - H / 2;
    T.zoom = nz; request(); notify('zoom');
  }
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement?.tagName || '')) { spaceDown = true; el.style.cursor = 'grab'; e.preventDefault(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) {
      snapshot(); state.elements = state.elements.filter(x => x.id !== state.selectedId); state.selectedId = null; notify('elements'); e.preventDefault();
    }
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; el.style.cursor = ''; } });

  const api = {
    draw: request, resize,
    get zoom() { return T.zoom; },
    fit() { T.zoom = clamp(Math.min(W, H) * 0.92 / SIZE, 0.15, 3); T.px = T.py = 0; request(); notify('zoom'); },
    zoomBy(f) { zoomAt(W / 2 + T.px, H / 2 + T.py, f); },
    rotateBy(d) { T.rot = (T.rot + d) % 360; request(); },
    resetRotation() { T.rot = 0; request(); },
    get rotation() { return T.rot; },
    toImage,
    lastPoint: () => lastPt,
  };
  subscribe(() => request());
  resize(); api.fit();
  return api;
}
// rotation unit used by elements.js (set to 1 for degrees, 180/PI-less radians => 1 for radians). Adjusted by main if needed.
export let ROT_UNIT = 180 / Math.PI;
export function setRotationUnit(u) { ROT_UNIT = u; }
