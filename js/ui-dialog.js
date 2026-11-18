// Accessible modal dialogs for the studio (owner: shell): native <dialog> so Escape closes it and focus
// stays inside; focus goes back to whatever was focused before it opened. All text is inserted as text.
import { h, icon } from './util.js';

let seq = 0;
/**
 * Opens a modal dialog. `body` = nodes; returns { dlg, close }. `onClose(returnValue)` runs once.
 * `cls` adds a class (e.g. 'wide').
 */
export function openDialog({ title, body = [], actions = [], cls = '', onClose = null, labelClose = 'Close' }) {
  const prev = document.activeElement;
  const id = 'dlg-t-' + (++seq);
  const dlg = h('dialog', { class: 'tf-dlg ' + cls, 'aria-labelledby': id },
    h('div', { class: 'tf-dlg-head' },
      h('h2', { id }, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': labelClose, onclick: () => dlg.close('') }, icon('x', 18))),
    h('div', { class: 'tf-dlg-body' }, body),
    actions.length ? h('div', { class: 'tf-dlg-actions' }, actions) : null);
  dlg.addEventListener('close', () => {
    try { onClose?.(dlg.returnValue); } finally {
      dlg.remove();
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
    }
  }, { once: true });
  // a click on the dimmed backdrop closes it too
  dlg.addEventListener('click', e => { if (e.target === dlg) { const r = dlg.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close(''); } });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close: v => dlg.close(v ?? '') };
}

/** Asks before a destructive action. Resolves true when confirmed; Escape / Cancel resolve false. */
export function confirmAction({ title, text, ok = 'OK', danger = false }) {
  return new Promise(resolve => {
    const okBtn = h('button', { type: 'button', class: danger ? 'btn danger' : 'btn primary', onclick: () => d.close('ok') }, ok);
    const d = openDialog({
      title, cls: 'confirm',
      body: [h('p', { class: 'muted' }, text)],
      actions: [h('button', { type: 'button', class: 'btn ghost', onclick: () => d.close('') }, 'Cancel'), okBtn],
      onClose: v => resolve(v === 'ok'),
    });
    okBtn.focus();
  });
}
