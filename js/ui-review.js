// Review UI (owner: phase 3c): the review bar over the stage (Accept, Reject, Regenerate, Edit prompt further, Compare),
// the compare bar (slider, side by side, flip, hold to peek), the before / after slider handle, the edit history panel
// and the Undo edit / Redo edit buttons. Logic lives in review.js; the engine is ui-actions.js.
import { state, activeView, subscribe, captureEdit } from './state.js';
import { h, icon, toast, setDisabled } from './util.js';
import * as A from './ui-actions.js';
import * as REV from './review.js';
import { getMode } from './ui-guide.js';

const TYPING = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || !!document.activeElement?.isContentEditable;
const overlayOpen = () => !!document.querySelector('dialog[open], .tour, .drawer.open, .menu:not([hidden])');
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : Math.floor(s / 3600) + ' h ago'; };

/* ------------------------------------------------------------------ actions (shared by buttons and keys) */

/** Accept: commits the previewed option through the existing engine path, then records it in Edit history. */
export async function acceptPreview() {
  const r = state.review; if (!r) return false;
  if (REV.previewIsStale()) { REV.endReview(); REV.setStartingPoint(null); toast('The preview is out of date, so it was closed. Pick the option again.', 'info', 4000); return false; }
  const view = r.view, V = state.views[view], beforeCurrent = V.current;
  const before = captureEdit();
  const meta = { prompt: r.prompt, summary: r.summary || r.label, level: r.level, source: r.source };
  REV.endReview(); REV.setStartingPoint(null);
  await A.acceptVariation(r.index);
  if (state.views[view].current === beforeCurrent) return false;   // the engine did not change the garment
  REV.recordEdit({ before, after: captureEdit(), view, ...meta });
  return true;
}

/** Reject: back to the garment as it was. The selection and the prompt are kept. */
export function rejectPreview() {
  if (!state.review) return false;
  REV.endReview(); REV.setStartingPoint(null);
  toast('Preview discarded. The garment is back as it was. Your selection and prompt are kept.', 'info', 3500);
  return true;
}

/** Regenerate: same prompt, same selection and settings, new options. */
export async function regenerate() {
  const r = state.review; if (!r) return;
  const prompt = r.prompt || state.ui.prompt;
  REV.endReview();   // the starting point (if any) is kept for this run
  if (!prompt.trim()) { toast('Describe the change first, then press Create 3 options.', 'info'); return; }
  REV.noteRun(prompt);
  await A.generateVariations(prompt);
}

/** Edit prompt further: the prompt goes back into Describe, and the previewed option is the starting point of the next run. */
export function editFurther() {
  const r = state.review; if (!r) return;
  const text = REV.editFurther() || '';
  const box = document.getElementById('prompt');
  if (box) { box.value = text; state.ui.prompt = text; box.focus(); try { box.setSelectionRange(text.length, text.length); } catch { /* not supported */ } }
  toast('Change the wording, then press Create 3 options. The next options start from the preview. Nothing is accepted yet.', 'info', 5000);
}

/** Combine: adds an option on top of the applied one. Recorded in Edit history like an accepted edit. */
export async function combine(i) {
  const view = state.activeView, V = activeView();
  if (!V.current) return;
  const o = state.variations?.[i];
  const beforeCurrent = V.current, before = captureEdit();
  REV.endReview();
  await A.combineVariation(i);
  if (state.views[view].current === beforeCurrent) return;
  REV.recordEdit({ before, after: captureEdit(), view, prompt: o?.prompt || '', summary: `Combined + ${o?.label || 'option'}`, level: o?.level || o?.label || '', source: o?.source === 'ai' ? 'ai' : 'local' });
}

/** Opens a preview from the option cards (click or focus). Called by ui-right.js. */
export function previewOption(i) { return REV.previewOption(i); }

/* ------------------------------------------------------------------ edit undo / redo buttons (bottom bar) */
export function editControls() {
  const undoE = h('button', { class: 'btn ghost', id: 'btn-undo-edit', tip: 'Undo edit: puts back the garment, shape, colour and elements from before the last accepted edit. Undo (Ctrl+Z) undoes the last change of any kind instead.', 'aria-keyshortcuts': 'Control+Alt+Z', onclick: () => REV.undoEdit() }, icon('undo'), 'Undo edit');
  const redoE = h('button', { class: 'btn ghost', id: 'btn-redo-edit', tip: 'Redo edit: brings back the last edit you undid (Ctrl+Alt+Shift+Z)', 'aria-keyshortcuts': 'Control+Alt+Shift+Z', onclick: () => REV.redoEdit() }, icon('redo'), 'Redo edit');
  const sync = () => {
    setDisabled(undoE, !REV.canUndoEdit(), 'No accepted edit to undo yet');
    setDisabled(redoE, !REV.canRedoEdit(), 'Nothing to redo: redo edit brings back an edit you undid');
  };
  subscribe(r => { if (!['render', 'zoom', 'processing', 'busy', 'elements-live', 'tab', 'review', 'compare'].includes(r)) sync(); });
  sync();
  return [undoE, redoE];
}

/* ------------------------------------------------------------------ edit history panel (inside the Version history drawer) */
export function editHistoryPanel() {
  const list = h('div', { class: 'elist', role: 'list', 'aria-label': 'Accepted edits, newest first' });
  const note = h('div', { class: 'muted small', id: 'edit-history-note' });
  const detail = h('div', { class: 'edetail', hidden: true, 'aria-live': 'polite' });
  let open = null;   // id of the entry shown in detail
  const el = h('div', { class: 'epanel', id: 'edit-history' }, note, list, detail);

  const pic = (src, label) => h('figure', { class: 'efig' }, src ? h('img', { src, alt: label }) : h('span', { class: 'ph' }), h('figcaption', { class: 'muted small' }, label));
  function showDetail(id) {
    open = id;
    const i = state.edits.findIndex(x => x.id === id), e = state.edits[i];
    if (!e) { detail.hidden = true; open = null; return; }
    const isHead = state.editHead === id;
    const revert = h('button', {
      class: 'btn primary sm', id: 'btn-revert-stage', disabled: isHead,
      tip: isHead ? 'This is the stage on the garment now' : `Go back to the garment as it was after edit #${e.n}. This is added as a new step, so nothing is lost.`,
      onclick: () => REV.revertToEdit(id),
    }, icon('history', 14), isHead ? 'Current stage' : 'Revert to this stage');
    detail.replaceChildren(
      h('div', { class: 'row between' }, h('b', {}, `Edit #${e.n}: ${e.summary}`), h('button', { class: 'btn ghost sm', onclick: () => { open = null; detail.hidden = true; } }, 'Close')),
      h('div', { class: 'epics' }, pic(e.beforeThumb, 'Before'), pic(e.afterThumb, 'After'), pic(e.selThumb, 'Selection')),
      h('div', { class: 'small', 'data-level': 'advanced' }, h('div', {}, h('b', {}, 'Prompt: '), e.prompt || '(none)')),
      h('div', { class: 'small' }, h('span', { 'data-level': 'advanced' }, h('b', {}, 'Level: '), (e.level || '—') + ' · ', h('b', {}, 'Source: '), e.source === 'ai' ? 'AI' : e.source === 'revert' ? 'Revert' : 'Built-in engine', ' · ', h('b', {}, 'View: '), e.view + ' · ')),
      h('div', { class: 'small muted' }, new Date(e.time).toLocaleString()),
      h('div', { class: 'row gap' }, revert));
    detail.hidden = false;
  }
  function render() {
    const head = state.editHead ? state.edits.findIndex(x => x.id === state.editHead) : -1;
    note.textContent = state.edits.length
      ? 'Every accepted edit, newest first. Click one to see its before and after, then revert to that stage if you want the garment back that way.'
      : 'No accepted edits yet. When you accept an option, it is recorded here with its before and after pictures.';
    const rows = [...state.edits].map((e, i) => ({ e, i })).reverse().map(({ e, i }) => {
      const undone = i > head;
      const tags = [i === head ? 'Current' : null, undone ? 'Undone' : null].filter(Boolean);
      return h('button', { class: 'eitem' + (undone ? ' undone' : ''), role: 'listitem', 'data-id': e.id, 'aria-label': `Edit ${e.n}: ${e.summary}${tags.length ? ', ' + tags.join(', ') : ''}`, 'aria-pressed': String(open === e.id), onclick: () => showDetail(e.id) },
        e.afterThumb ? h('img', { src: e.afterThumb, alt: '' }) : h('span', { class: 'ph' }),
        h('span', { class: 'vt' }, h('b', {}, `#${e.n} ${e.summary}`), h('span', { class: 'muted small' }, `${e.view} · ${ago(e.time)}`, h('span', { 'data-level': 'advanced' }, e.level ? ` · ${e.level}` : ''), tags.length ? ' · ' + tags.join(' · ') : '')));
    });
    list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'muted small' }, 'Nothing here yet.')]));
    if (open) { if (state.edits.some(x => x.id === open)) showDetail(open); else { open = null; detail.hidden = true; } }
  }
  subscribe(r => { if (['edits', 'loaded', 'restore', 'history'].includes(r)) render(); });
  render();
  return { el, render };
}

/* ------------------------------------------------------------------ stage: review bar, compare bar, slider handle, keys */
export function initReview(wrap) {
  const handle = h('div', {
    class: 'cmp-handle', id: 'cmp-handle', role: 'slider', tabindex: '0', hidden: true,
    'aria-label': 'Before and after divider. Left and right arrows move it; Home and End go to the edges.',
    'aria-valuemin': '3', 'aria-valuemax': '97', 'aria-valuenow': '50', 'aria-valuetext': 'Before on the left, after on the right',
    tip: 'Drag, or use the arrow keys, to show more of the before or the after',
  }, h('span', { class: 'cmp-grip', 'aria-hidden': 'true' }));

  const reviewText = h('p', { class: 'review-text', id: 'review-text', role: 'status', 'aria-live': 'polite' });
  const acceptB = h('button', { class: 'btn primary sm', id: 'btn-accept', 'aria-keyshortcuts': 'Enter', tip: 'Accept: keep this option. It becomes a step in Edit history (Enter)', onclick: () => acceptPreview() }, icon('check', 14), 'Accept');
  const rejectB = h('button', { class: 'btn ghost sm', id: 'btn-reject', 'aria-keyshortcuts': 'Escape', tip: 'Reject: put the garment back as it was before this option. Your selection and prompt are kept (Esc)', onclick: () => rejectPreview() }, icon('x', 14), 'Reject');
  const regenB = h('button', { class: 'btn ghost sm', id: 'btn-regenerate', tip: 'Regenerate: run the same prompt on the same selection again for new options', onclick: () => regenerate() }, icon('sparkles', 14), 'Regenerate');
  const furtherB = h('button', { class: 'btn ghost sm', id: 'btn-edit-further', tip: 'Edit prompt further: put the prompt back in Describe and start the next options from this preview. Nothing is accepted.', onclick: () => editFurther() }, icon('pencil', 14), 'Edit prompt further');
  const cmpToggle = h('button', { class: 'btn ghost sm', id: 'btn-review-compare', 'aria-pressed': 'false', tip: 'Show the garment before and after this option', onclick: () => REV.setCompare(!state.ui.compare) }, icon('compare', 14), 'Compare');
  const reviewBar = h('div', { class: 'review-bar', id: 'review-bar', role: 'toolbar', 'aria-label': 'Review the previewed option', hidden: true },
    reviewText, h('div', { class: 'review-btns' }, acceptB, rejectB, regenB, furtherB, cmpToggle));

  const modeBtn = (id, label, tip, mode, level) => h('button', { class: 'btn ghost sm', id, 'data-mode': mode, 'data-level': level || null, 'aria-pressed': 'false', tip, onclick: () => { REV.setCompare(true); REV.setCompareMode(mode); } }, label);
  const sliderB = modeBtn('cmp-slider', 'Slider', 'Drag a divider between the before (left) and after (right)', 'slider');
  const sideB = modeBtn('cmp-side', 'Side by side', 'Before and after next to each other, with the same zoom and pan', 'side', 'advanced');
  const flipB = h('button', { class: 'btn ghost sm', id: 'cmp-flip', 'data-mode': 'flip', 'aria-pressed': 'false', tip: 'Flip between the before and the after (full picture)', onclick: () => { REV.setCompare(true); if (state.ui.compareMode !== 'flip') REV.setCompareMode('flip'); else REV.toggleFlip(); } }, 'Before ⇄ After');
  const peekB = h('button', { class: 'btn ghost sm', id: 'cmp-peek', 'aria-pressed': 'false', 'aria-keyshortcuts': 'H', tip: 'Hold to see the garment before the edit. Hold H on the keyboard, or press and hold this button.',
    onpointerdown: e => { e.preventDefault(); REV.setPeek(true); }, onpointerup: () => REV.setPeek(false), onpointerleave: () => REV.setPeek(false), onpointercancel: () => REV.setPeek(false),
    onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); REV.setPeek(true); } }, onkeyup: e => { if (e.key === 'Enter' || e.key === ' ') REV.setPeek(false); } }, icon('eye', 14), 'Hold: before');
  const closeB = h('button', { class: 'icon-btn', id: 'cmp-close', 'aria-label': 'Close compare', tip: 'Close the before and after view', onclick: () => REV.setCompare(false) }, icon('x', 14));
  const cmpBar = h('div', { class: 'cmp-bar', id: 'cmp-bar', role: 'toolbar', 'aria-label': 'Compare before and after', hidden: true },
    h('span', { class: 'cmp-lbl muted small' }, 'Compare'), sliderB, sideB, flipB, peekB, closeB);
  const bottom = h('div', { class: 'stage-bottom', id: 'stage-bottom' }, reviewBar, cmpBar);
  wrap.append(handle, bottom);

  // ---- before / after divider: pointer drag and keyboard ----
  let dragging = false;
  const posFrom = e => { const r = wrap.getBoundingClientRect(); return (e.clientX - r.left) / Math.max(1, r.width); };
  handle.addEventListener('pointerdown', e => { e.preventDefault(); dragging = true; try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ } REV.setComparePos(posFrom(e)); });
  handle.addEventListener('pointermove', e => { if (dragging) REV.setComparePos(posFrom(e)); });
  const stopDrag = () => { dragging = false; };
  handle.addEventListener('pointerup', stopDrag); handle.addEventListener('pointercancel', stopDrag);
  handle.addEventListener('keydown', e => {
    const step = e.shiftKey ? 0.1 : 0.02, p = state.ui.comparePos;
    const n = { ArrowLeft: p - step, ArrowRight: p + step, ArrowDown: p - step, ArrowUp: p + step, Home: 0, End: 1 }[e.key];
    if (n === undefined) return;
    e.preventDefault(); e.stopPropagation(); REV.setComparePos(n);
  });

  // ---- keyboard: Enter accepts, Escape rejects, hold H peeks, Ctrl+Alt+Z / Ctrl+Alt+Shift+Z edit undo / redo ----
  window.addEventListener('keydown', e => {
    if (document.querySelector('.app')?.hidden || document.querySelector('dialog[open], .tour')) return;
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? REV.redoEdit() : REV.undoEdit(); return; }
    if (TYPING() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && state.review && !overlayOpen()) { e.preventDefault(); rejectPreview(); }
    else if (e.key === 'Enter' && state.review && !document.activeElement?.closest?.('button, a, [role=menu], [role=slider]')) { e.preventDefault(); acceptPreview(); }
    else if ((e.key === 'h' || e.key === 'H') && !e.repeat && (state.ui.compare || state.review)) { e.preventDefault(); REV.setPeek(true); }
  });
  window.addEventListener('keyup', e => { if (e.key === 'h' || e.key === 'H') REV.setPeek(false); });

  // ---- sync ----
  function sync() {
    const V = activeView(), r = state.review, cmp = state.ui.compare, mode = state.ui.compareMode;
    reviewBar.hidden = !r;
    cmpBar.hidden = !cmp;
    const hintEl = document.getElementById('stage-hint');
    if (hintEl && (r || cmp)) hintEl.hidden = true;
    handle.hidden = !(cmp && mode === 'slider' && !state.ui.peek && V.current);
    const pos = state.ui.comparePos;
    handle.style.left = (pos * 100).toFixed(2) + '%';
    handle.setAttribute('aria-valuenow', String(Math.round(pos * 100)));
    handle.setAttribute('aria-valuetext', `${Math.round(pos * 100)}% of the picture shows the before on the left`);
    if (r) {
      reviewText.textContent = r.startShown
        ? `Starting point: “${r.label}”. The next options start from this picture. Change the wording in Describe and press Create 3 options. Nothing is accepted yet.`
        : `Previewing “${r.label}”${r.summary ? ': ' + r.summary : ''}. Nothing is changed yet. Accept (Enter) keeps it as a step in Edit history. Reject (Esc) puts the garment back.`;
    }
    setDisabled(acceptB, !r, 'Pick an option first: its preview appears on the garment');
    setDisabled(rejectB, !r, 'Nothing to reject: pick an option first');
    setDisabled(regenB, !r, 'Pick an option first, then regenerate it');
    setDisabled(furtherB, !r, 'Pick an option first, then edit its prompt further');
    setDisabled(cmpToggle, !V.current, 'Load a garment first');
    cmpToggle.setAttribute('aria-pressed', String(cmp));
    cmpToggle.classList.toggle('on', cmp);
    for (const [b, m] of [[sliderB, 'slider'], [sideB, 'side'], [flipB, 'flip']]) {
      b.setAttribute('aria-pressed', String(cmp && mode === m)); b.classList.toggle('on', cmp && mode === m);
    }
    flipB.textContent = cmp && mode === 'flip' ? (state.ui.flipShow === 'before' ? 'Showing before' : 'Showing after') : 'Before ⇄ After';
    flipB.setAttribute('aria-label', 'Before and after, flip: ' + (state.ui.flipShow === 'before' ? 'showing before, press to show after' : 'showing after, press to show before'));
    peekB.setAttribute('aria-pressed', String(!!state.ui.peek));
    peekB.classList.toggle('on', !!state.ui.peek);
    setDisabled(peekB, !V.current, 'Load a garment first');
  }
  subscribe(reason => {
    if (!['render', 'zoom', 'processing', 'busy', 'elements-live', 'tab'].includes(reason)) checkPreview(reason);
    sync();
  });
  sync();
}

/** closes a preview that no longer matches the garment on screen; the design itself is never changed here */
function checkPreview(reason) {
  if (!state.review) return;
  if (reason === 'loaded') { REV.endReview(); REV.setStartingPoint(null); return; }
  const r = state.review;
  if (r.view !== state.activeView) { REV.endReview(); REV.setStartingPoint(null); return; }
  if (state.views[r.view].current !== r.before) {   // the garment itself changed under the preview
    REV.endReview(); REV.setStartingPoint(null);
    toast('The garment changed, so the preview was closed. Describe the change again.', 'info', 4500);
    return;
  }
  if (state.variations?.[r.index] !== r.option) { REV.endReview(); REV.setStartingPoint(null); }   // new options replaced the old ones (silent)
}

// Notes the prompt behind each new set of options (the Describe box at the time), so Edit prompt further can restore it.
let seenVariations = null;
subscribe(reason => {
  if (reason !== 'variations' || state.variations === seenVariations) return;
  seenVariations = state.variations;
  if (state.variations?.length) REV.noteRun(state.ui.prompt || '');
});

if (typeof window !== 'undefined') window.__review = { REV, acceptPreview, rejectPreview, regenerate, editFurther, combine, undoEdit: REV.undoEdit, redoEdit: REV.redoEdit, revertToEdit: REV.revertToEdit };
