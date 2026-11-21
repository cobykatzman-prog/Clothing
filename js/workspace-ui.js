// Shared-workspace UI pieces (owner: sync): who am I, version history with restore, sharing (owner / editor / viewer),
// and the Brand Kit sync chip. Text only ever goes in as text nodes. Used by main.js; nothing here runs without shared mode.
import { h, toast, friendly } from './util.js';
import { openDialog, confirmAction } from './ui-dialog.js';
import * as store from './storage.js';
import { timeAgo } from './remote.js';
import { syncState } from './syncstate.js';

/** { name, role, multi } from the page (the server writes it into <meta name="threadform-user">); null when there is no login */
export function identity() {
  const m = document.querySelector('meta[name="threadform-user"]');
  if (!m) return null;
  return { name: m.getAttribute('content') || '', role: m.dataset.role || 'owner', multi: m.dataset.multi === '1' };
}
export const ROLE_TEXT = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

/** Version history of one design. onRestore(rev) must restore and reload; resolves when done. */
export function openHistoryDialog({ id, canRestore, currentRev, onRestore }) {
  const list = h('ul', { class: 'ws-list', 'aria-live': 'polite' }, h('li', { class: 'muted' }, 'Loading...'));
  const d = openDialog({ title: 'Version history', cls: 'ws-dlg', body: [h('p', { class: 'muted' }, 'Earlier saved versions of this design. Restoring one makes it the current version; nothing is deleted, so you can go back again.'), list] });
  store.listVersions(id).then(vs => {
    if (!vs.length) { list.replaceChildren(h('li', { class: 'muted' }, 'No earlier versions are stored yet.')); return; }
    list.replaceChildren(...vs.map((v, i) => {
      const cur = currentRev != null ? v.rev === currentRev : i === 0;
      const when = v.savedAt ? timeAgo(v.savedAt) : '';
      return h('li', { class: 'ws-row' },
        h('div', { class: 'ws-main' },
          h('b', {}, cur ? 'Current version' : 'Version ' + v.rev),
          h('span', { class: 'muted' }, [v.editedBy ? 'by ' + v.editedBy : '', when, v.note || ''].filter(Boolean).join(' · '))),
        canRestore && !cur ? h('button', { type: 'button', class: 'btn sm ghost', onclick: async e => {
          const ok = await confirmAction({ title: 'Restore this version?', text: 'The design goes back to how it was ' + (when || 'then') + '. Your current version stays in the history.', ok: 'Restore' });
          if (!ok) return;
          e.target.disabled = true;
          try { await onRestore(v.rev); d.close('restored'); }
          catch (err) { e.target.disabled = false; toast(friendly(err, 'Could not restore that version. Try again in a moment.'), 'error', 5000); }
        } }, 'Restore') : null);
    }));
  }).catch(err => list.replaceChildren(h('li', { class: 'muted' }, friendly(err, 'Could not load the history. Check your connection and try again.'))));
  return d;
}

/** Who may see / edit one design (owners only). Users are the names in the server's SITE_USERS. */
export function openSharingDialog({ id }) {
  const rows = h('div', { class: 'ws-members' });
  const members = {};
  const roleSel = (value, onchange) => h('select', { class: 'ws-role', 'aria-label': 'Role', onchange: e => onchange(e.target.value) }, ['viewer', 'editor', 'owner'].map(r => h('option', { value: r, selected: r === value }, ROLE_TEXT[r])));
  const paint = () => rows.replaceChildren(...Object.entries(members).map(([n, r]) => h('div', { class: 'ws-row' },
    h('span', { class: 'ws-main' }, h('b', {}, n)), roleSel(r, v => { members[n] = v; }),
    h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { delete members[n]; paint(); } }, 'Remove'))));
  const nameIn = h('input', { type: 'text', class: 'ws-name', placeholder: 'username', 'aria-label': 'Username', maxlength: 32, autocomplete: 'off' });
  let addRole = 'editor';
  const info = h('p', { class: 'muted' }, 'Loading...');
  const save = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    save.disabled = true;
    try { await store.setMembers(id, members); toast('Sharing saved.', 'ok'); d.close('saved'); }
    catch (err) { save.disabled = false; toast(friendly(err, 'Could not save sharing. Try again in a moment.'), 'error', 5000); }
  } }, 'Save');
  const d = openDialog({
    title: 'Who can work on this design', cls: 'ws-dlg',
    body: [info, rows, h('div', { class: 'ws-add' }, nameIn, roleSel(addRole, v => { addRole = v; }), h('button', { type: 'button', class: 'btn sm', onclick: () => {
      const n = nameIn.value.trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,32}$/.test(n)) { toast('Type a username (letters, digits, . _ -).', 'error', 3500); return; }
      members[n] = addRole; nameIn.value = ''; paint();
    } }, 'Add')),
    h('p', { class: 'muted small' }, 'Owner: everything, including delete and sharing. Editor: change the design. Viewer: look only. People not listed keep their workspace role.')],
    actions: [h('button', { type: 'button', class: 'btn ghost', onclick: () => d.close('') }, 'Cancel'), save],
  });
  store.getMembers(id).then(r => { Object.assign(members, r.members || {}); info.textContent = 'Owner: ' + (r.owner || 'unknown') + '. Your role here: ' + (ROLE_TEXT[r.role] || r.role) + '.'; paint(); })
    .catch(err => { info.textContent = friendly(err, 'Could not load sharing.'); save.disabled = true; });
  return d;
}

/** Small chip for the Brand Kit's own sync state; hidden while everything is saved. */
export function kitStatusChip() {
  const el = h('span', { class: 'kit-status', role: 'status', 'aria-live': 'polite', hidden: true });
  const paint = () => {
    const s = syncState.source('brandkit');
    el.hidden = !s || s.kind === 'saved';
    if (s) { el.dataset.kind = s.kind; el.textContent = 'Brand Kit: ' + (s.kind === 'saving' ? 'Saving...' : s.kind === 'offline' ? 'offline, will retry' + (s.pending ? ` (${s.pending} waiting)` : '') : s.kind === 'conflict' ? 'conflict' : 'not saved'); el.title = s.detail || ''; }
  };
  syncState.subscribe(paint); paint();
  return el;
}
