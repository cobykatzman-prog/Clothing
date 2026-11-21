// Review of AI / local edits (owner: phase 3c). Pure state logic, no DOM:
//  - a preview of one option on the stage (never committed until accepted),
//  - the starting point for "edit the prompt further",
//  - the edit history (accepted edits, newest first in the panel) with edit-level undo / redo and revert,
//  - the before / after compare painting used by canvas.js (slider, side by side, flip, hold to peek).
// ui-review.js does the DOM and calls the engine (ui-actions.js). This file must not import ui-actions.js.
import { state, activeView, snapshot, notify, markFlow, captureEdit, applySnapshot, decodeEdit } from './state.js';
import { thumbOf, makeCanvas, toast, clamp } from './util.js';

export const MAX_EDITS = 50;
const ACCENT = [79, 70, 229];

// ---------- preview ----------
let lastRunPrompt = '';
let startPoint = null;   // {canvas, seg, label}: the previewed option, used as the source of the next "Create 3 options"

/** the prompt that produced the current options (ui-review.js notes it when new options arrive) */
export function noteRun(prompt) { lastRunPrompt = String(prompt || ''); }

/** canvas the stage draws for the active view: the previewed option while a preview is open, else the garment */
export function stageCanvas(V) {
  const r = state.review;
  return r && r.view === state.activeView && r.canvas ? r.canvas : V.current;
}

/** Shows option i on the stage without changing the design. False when that option has no picture (still working). */
export function previewOption(i) {
  const o = state.variations?.[i], V = activeView();
  if (!o || !o.canvas || !V.current) return false;
  const r = state.review;
  if (r && r.index === i && r.option === o && !r.startShown) return true;
  state.review = {
    index: i, option: o, canvas: o.canvas, before: V.current, view: state.activeView,
    label: o.label || 'Option', summary: (o.ops && o.ops.summary) || state.lastOps?.summary || '',
    level: o.level || o.label || '', source: o.source === 'ai' ? 'ai' : 'local',
    prompt: o.prompt || lastRunPrompt, startShown: false,
  };
  if (startPoint) startPoint = null;   // starting point belonged to the previous preview
  notify('review');
  return true;
}
export function endReview() {
  if (!state.review) return false;
  state.review = null; notify('review'); return true;
}
/** the preview is closed when the garment or view changes under it, or when the options are replaced */
export function previewIsStale() {
  const r = state.review; if (!r) return false;
  return r.view !== state.activeView || state.views[r.view].current !== r.before
    || state.variations?.[r.index] !== r.option;
}

// ---------- edit further ----------
export function setStartingPoint(sp) { startPoint = sp ? { ...sp } : null; }
export function peekStartingPoint() { return startPoint; }
/** consumed by generateVariations (ui-actions.js): the next options start from this picture */
export function takeStartingPoint() { const s = startPoint; startPoint = null; if (state.review) state.review.startShown = false; return s; }
/** Makes the previewed option the starting point of the next run (nothing is committed). Returns the prompt to put back. */
export function editFurther() {
  const r = state.review; if (!r) return null;
  startPoint = { canvas: r.canvas, seg: r.option?.seg || null, label: r.label };
  r.startShown = true; notify('review');
  return r.prompt;
}

// ---------- edit history ----------
const newId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const headIndex = () => (state.editHead ? state.edits.findIndex(e => e.id === state.editHead) : -1);
export const canUndoEdit = () => headIndex() >= 0;
export const canRedoEdit = () => headIndex() < state.edits.length - 1;

function maskThumb(mask) {
  if (!mask) return '';
  const size = 64, c = makeCanvas(size, size), x = c.getContext('2d');
  x.fillStyle = '#f3f2ef'; x.fillRect(0, 0, size, size);
  x.drawImage(mask, 0, 0, size, size);
  x.globalCompositeOperation = 'source-in'; x.fillStyle = `rgb(${ACCENT})`; x.fillRect(0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.7);
}
const picThumb = c => (c ? thumbOf(c, 110, '#f3f2ef').toDataURL('image/jpeg', 0.7) : '');

/** Records an accepted edit. Undone edits after the current stage are dropped first (like any undo). */
export function recordEdit({ before, after, view, prompt = '', summary = 'Edit', level = '', source = 'local' }) {
  const i = headIndex();
  state.edits = state.edits.slice(0, i + 1);
  state.editSeq = (state.editSeq || 0) + 1;
  const e = {
    id: newId(), n: state.editSeq, time: Date.now(), prompt: String(prompt || ''), summary: String(summary || 'Edit'),
    level: String(level || ''), source, view,
    selThumb: maskThumb(before.views[view]?.mask), beforeThumb: picThumb(before.views[view]?.current), afterThumb: picThumb(after.views[view]?.current),
    before, after, _raw: null,
  };
  state.edits.push(e);
  while (state.edits.length > MAX_EDITS) state.edits.shift();
  state.editHead = e.id;
  markFlow('compared');
  notify('edits');
  return e;
}

/** Undo edit: puts the garment, shape, colour and elements back as they were before the last kept edit. */
export async function undoEdit() {
  const i = headIndex(); if (i < 0) return false;
  const e = state.edits[i];
  const s = await decodeEdit(e, 'before');
  if (!s) { toast('That edit cannot be undone because its earlier picture is missing.', 'error', 4000); return false; }
  endReview();
  snapshot(); applySnapshot(s);
  state.editHead = i > 0 ? state.edits[i - 1].id : null;
  notify('edits');
  toast(`Undid the edit “${e.summary}”. Redo edit brings it back.`, 'ok', 3500);
  return true;
}
/** Redo edit: re-applies the next undone edit. */
export async function redoEdit() {
  const j = headIndex() + 1; if (j >= state.edits.length) return false;
  const e = state.edits[j];
  const s = await decodeEdit(e, 'after');
  if (!s) { toast('That edit cannot be redone because its picture is missing.', 'error', 4000); return false; }
  endReview();
  snapshot(); applySnapshot(s);
  state.editHead = e.id;
  notify('edits');
  toast(`Redid the edit “${e.summary}”.`, 'ok', 3000);
  return true;
}
/** Revert to this stage: puts back the result of that edit and records it as a new step, so nothing is lost. */
export async function revertToEdit(id) {
  const k = state.edits.findIndex(e => e.id === id);
  if (k < 0 || state.editHead === id) return false;
  const target = state.edits[k];
  const s = await decodeEdit(target, 'after');
  if (!s) { toast('That stage cannot be opened because its picture is missing.', 'error', 4000); return false; }
  endReview();
  const before = captureEdit();
  snapshot(); applySnapshot(s);
  const after = captureEdit();
  recordEdit({ before, after, view: state.activeView, prompt: target.prompt, summary: `Reverted to #${target.n}`, level: target.level, source: 'revert' });
  toast(`Reverted to #${target.n}. This is a new step in Edit history; nothing was removed.`, 'ok', 4500);
  return true;
}

// ---------- compare ----------
/** what the compare shows: before = the garment before the open preview, else the original upload; after = what is shown now */
export function compareSources() {
  const r = state.review, V = activeView();
  if (r && r.view === state.activeView) return { before: r.before, after: r.canvas, previewing: true };
  return { before: V.original || V.base, after: V.current, previewing: false };
}

/**
 * Paints the before / after comparison over the stage (canvas.js calls this after the garment is drawn).
 * o: {W, H, SIZE, pattern, applyT(ctx, dx), extras(ctx)}; applyT places the image at the current zoom and pan,
 * shifted right by dx stage pixels, so all modes share one zoom and pan.
 */
export function paintCompare(ctx, o) {
  const { before, after } = compareSources();
  if (!before || !after) return;
  const { W, H, SIZE, pattern, applyT, extras } = o;
  const peek = state.ui.peek;
  const mode = peek || !state.ui.compare ? 'peek' : state.ui.compareMode;
  const drawSide = (img, dx, label, labelX) => {
    ctx.save();
    applyT(ctx, dx);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = pattern; ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0);
    if (extras) extras(ctx);
    ctx.restore();
    if (label) pill(ctx, label, labelX.x, labelX.right);
  };
  const pill = (ctx2, txt, x, right) => {
    ctx2.save();
    ctx2.font = '600 12px system-ui,sans-serif';
    const w = ctx2.measureText(txt).width + 16, px = right ? x - w : x;
    ctx2.fillStyle = 'rgba(20,20,30,.72)'; ctx2.beginPath(); ctx2.roundRect(px, 12, w, 24, 12); ctx2.fill();
    ctx2.fillStyle = '#fff'; ctx2.fillText(txt, px + 8, 28);
    ctx2.restore();
  };
  const beforeLabel = src => (src.previewing ? 'Before the edit' : 'Original');
  const afterLabel = src => (src.previewing ? 'Preview' : 'Now');
  const src = compareSources();
  const bl = beforeLabel(src), al = afterLabel(src);

  if (mode === 'peek' || (mode === 'flip' && state.ui.flipShow === 'before')) {
    // full frame: the before picture (held with H, or flipped)
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    drawSide(before, 0, bl, { x: 12, right: false });
    ctx.restore();
    return;
  }
  if (mode === 'flip') {   // full frame: the after picture
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    drawSide(after, 0, al, { x: W - 12, right: true });
    ctx.restore();
    return;
  }
  if (mode === 'side') {
    const half = W / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, half, H); ctx.clip();
    drawSide(before, half / 2 - W / 2, bl, { x: 12, right: false });
    ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(half, 0, half, H); ctx.clip();
    drawSide(after, half / 2 - W / 2 + half, al, { x: W - 12, right: true });
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(half, 0); ctx.lineTo(half, H); ctx.stroke();
    ctx.restore();
    return;
  }
  // slider: before on the left of the divider, after on the right
  const sx = state.ui.comparePos * W;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, H); ctx.clip();
  drawSide(before, 0, null);
  ctx.restore();
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 6;
  ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
  ctx.beginPath(); ctx.arc(sx, H / 2, 16, 0, 7); ctx.fill(); ctx.shadowColor = 'transparent';
  ctx.strokeStyle = `rgb(${ACCENT})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(sx - 5, H / 2 - 5); ctx.lineTo(sx - 9, H / 2); ctx.lineTo(sx - 5, H / 2 + 5);
  ctx.moveTo(sx + 5, H / 2 - 5); ctx.lineTo(sx + 9, H / 2); ctx.lineTo(sx + 5, H / 2 + 5); ctx.stroke();
  ctx.restore();
  pill(ctx, bl, 12, false); pill(ctx, al, W - 12, true);
}

// ---------- compare controls (state only) ----------
export function setCompare(on) { state.ui.compare = !!on; if (on) markFlow('compared'); notify('compare'); }
export function setCompareMode(m) { state.ui.compareMode = ['slider', 'side', 'flip'].includes(m) ? m : 'slider'; notify('compare'); }
export function setComparePos(p) { const v = clamp(p, 0.03, 0.97); if (v !== state.ui.comparePos) { state.ui.comparePos = v; notify('compare'); } }
export function toggleFlip() { state.ui.flipShow = state.ui.flipShow === 'before' ? 'after' : 'before'; notify('compare'); }
export function setPeek(on) { on = !!on; if (state.ui.peek !== on) { state.ui.peek = on; notify('compare'); } }

if (typeof window !== 'undefined') window.addEventListener('blur', () => setPeek(false));
