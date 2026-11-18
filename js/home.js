// Home gallery (owner: home/gallery): design grid, search + sort, new-design chooser,
// open / rename / duplicate / delete. Storage lives in storage.js; the studio is driven by main.js.
import { h, icon, toast } from './util.js';
import * as store from './storage.js';
import * as A from './ui-actions.js';

let root, api, qEl, sortEl, countEl, listEl, emptyEl, noteEl;
let metas = [];

export function initHome(el, actions) {
  root = el; api = actions;
  qEl = h('input', { type: 'search', class: 'home-search', placeholder: 'Search designs', 'aria-label': 'Search designs', oninput: () => render() });
  sortEl = h('select', { class: 'home-sort', 'aria-label': 'Sort designs', onchange: () => render() },
    h('option', { value: 'edited' }, 'Recently edited'),
    h('option', { value: 'oldest' }, 'Least recently edited'),
    h('option', { value: 'created' }, 'Recently created'),
    h('option', { value: 'name' }, 'Name A–Z'));
  countEl = h('span', { class: 'muted small' });
  listEl = h('div', { class: 'home-grid', role: 'list' });
  noteEl = h('p', { class: 'home-note small muted' });
  emptyEl = h('div', { class: 'home-empty', hidden: true },
    h('div', { class: 'empty-ico' }, icon('layers', 34)),
    h('h2', {}, 'Design your first garment'),
    h('p', {}, 'Upload a photo, describe one in words, or start from a sample shirt. Every change is saved here automatically.'),
    h('div', { class: 'home-choices' }, choiceButtons()));
  root.replaceChildren(
    h('div', { class: 'home-top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('layers', 18)), h('b', {}, 'Threadform')),
      h('button', { class: 'btn primary', id: 'home-new', onclick: () => chooser() }, icon('plus', 16), 'New design')),
    h('div', { class: 'home-body' },
      h('div', { class: 'home-tools' },
        h('div', {}, h('h1', {}, 'Your designs'), countEl),
        h('div', { class: 'home-filters' }, qEl, sortEl)),
      listEl, emptyEl, noteEl));
}

/** Reloads the list from storage and shows it. */
export async function refreshHome() {
  const mode = await store.initStorage();
  noteEl.textContent = mode === 'memory' ? 'Browser storage is unavailable, so designs will be lost when you close this page.'
    : mode === 'localstorage' ? 'Designs are saved in this browser. Space is limited, so delete old designs if saving fails.'
    : 'Designs are saved in this browser.';
  try { metas = await store.listDesigns(); }
  catch (e) { toast(e.message, 'error'); metas = []; }
  render();
}

const ago = t => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function render() {
  const q = qEl.value.trim().toLowerCase();
  const sorters = {
    edited: (a, b) => b.updatedAt - a.updatedAt,
    oldest: (a, b) => a.updatedAt - b.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    name: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
  };
  const list = metas.filter(m => !q || (m.name || '').toLowerCase().includes(q)).sort(sorters[sortEl.value] || sorters.edited);
  countEl.textContent = metas.length ? `${metas.length} design${metas.length === 1 ? '' : 's'}` : '';
  emptyEl.hidden = metas.length > 0;
  listEl.hidden = metas.length === 0;
  if (!metas.length) { listEl.replaceChildren(); return; }
  listEl.replaceChildren(...(list.length ? list.map(card) : [h('p', { class: 'home-nomatch' }, 'No designs match “' + qEl.value.trim() + '”.')]));
}

function card(m) {
  const thumb = m.thumb
    ? h('img', { src: m.thumb, alt: '', loading: 'lazy', decoding: 'async' })
    : h('div', { class: 'dthumb-empty' }, icon('layers', 30), h('span', {}, 'No artwork yet'));
  const views = m.views || 0;
  return h('article', { class: 'dcard', role: 'listitem' },
    h('button', { class: 'dcard-open', onclick: () => api.open(m.id), 'aria-label': `Open ${m.name}` },
      h('div', { class: 'dthumb' }, thumb),
      h('div', { class: 'dinfo' },
        h('div', { class: 'dname' }, m.name || 'Untitled design'),
        h('div', { class: 'dmeta' }, `Edited ${ago(m.updatedAt)} · ${views} ${views === 1 ? 'view' : 'views'} · ${m.engine || 'Local engine (offline)'}`))),
    h('div', { class: 'dactions' },
      h('button', { class: 'btn ghost sm', onclick: () => rename(m) }, 'Rename'),
      h('button', { class: 'btn ghost sm', onclick: () => duplicate(m) }, 'Duplicate'),
      h('button', { class: 'btn ghost sm danger-txt', onclick: () => remove(m) }, icon('trash', 14), 'Delete')));
}

async function guarded(fn) {
  try { await fn(); }
  catch (e) { console.error(e); toast(e.message || 'Something went wrong.', 'error'); }
  await refreshHome();
}

function rename(m) {
  return guarded(async () => {
    const name = await ask({ title: 'Rename design', label: 'Design name', value: m.name, ok: 'Rename' });
    if (!name) return;
    const rec = await store.getDesign(m.id);
    if (!rec) throw new Error('That design no longer exists.');
    rec.meta.name = name; rec.doc.name = name;
    await store.putDesign(rec);
    toast('Renamed.', 'ok');
  });
}

function duplicate(m) {
  return guarded(async () => {
    const rec = await store.getDesign(m.id);
    if (!rec) throw new Error('That design no longer exists.');
    const now = Date.now(), id = store.newId(), name = (m.name || 'Untitled design') + ' copy';
    await store.putDesign({
      id,
      meta: { ...rec.meta, id, name, createdAt: now, updatedAt: now },
      doc: { ...rec.doc, name, createdAt: now, updatedAt: now },
      assets: rec.assets,
    });
    toast('Duplicated “' + m.name + '”.', 'ok');
  });
}

function remove(m) {
  return guarded(async () => {
    const yes = await ask({
      title: `Delete “${m.name}”?`,
      text: 'This permanently removes the design, its views and its saved versions. This cannot be undone.',
      ok: 'Delete design', danger: true,
    });
    if (!yes) return;
    await store.deleteDesign(m.id);
    toast('Design deleted.', 'ok');
  });
}

// ---- dialogs ----
function makeDialog(cls) {
  const dlg = h('dialog', { class: 'home-dlg ' + cls });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** Text prompt (value = string) or confirmation (value = true). Resolves null on cancel. */
function ask({ title, text = '', label = '', value = null, ok = 'OK', danger = false }) {
  return new Promise(resolve => {
    const dlg = makeDialog('ask');
    const input = value == null ? null : h('input', { type: 'text', value, maxlength: 80, 'aria-label': label, required: true });
    const form = h('form', { method: 'dialog', class: 'dlg-body' },
      h('h2', {}, title),
      text ? h('p', { class: 'muted' }, text) : null,
      input ? h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, label), input) : null,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close('') }, 'Cancel'),
        h('button', { type: 'submit', class: danger ? 'btn danger' : 'btn primary', value: 'ok' }, ok)));
    form.addEventListener('submit', e => { if (input && !input.value.trim()) { e.preventDefault(); input.focus(); } });
    dlg.append(form);
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      resolve(ok ? (input ? input.value.trim() : true) : null);
    }, { once: true });
    (input || form.querySelector('button[value=ok]')).focus();
    input?.select();
  });
}

const choiceButtons = dlg => [
  h('button', { class: 'btn primary lg', onclick: () => choose('upload', dlg) }, icon('upload', 17), 'Upload photo'),
  h('button', { class: 'btn ghost lg', onclick: () => choose('generate', dlg) }, icon('sparkles', 17), 'Generate from text'),
  h('button', { class: 'btn ghost lg', onclick: () => choose('sample', dlg) }, icon('layers', 17), 'Try a sample shirt'),
];

/** The three ways to start a design. Upload opens the file picker synchronously (needed for user activation). */
function choose(kind, dlg) {
  if (kind === 'sample') { dlg?.close(); return api.newDesign(() => A.loadSample('tee')); }
  if (kind === 'upload') {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return;
      dlg?.close();
      api.newDesign(() => A.loadFile(f));
    });
    input.click();
    return;
  }
  if (kind === 'generate') { dlg ? openGenerate(dlg) : chooser('generate'); }
}

function openGenerate(dlg) {
  const form = dlg.querySelector('.gen-form');
  form.hidden = false;
  form.querySelector('textarea').focus();
}

function chooser(preset) {
  const dlg = makeDialog('chooser');
  const ta = h('textarea', { rows: 3, 'aria-label': 'Describe the garment', placeholder: 'e.g. navy crew-neck tee with a small white crest' });
  const genForm = h('form', {
    class: 'gen-form', hidden: true,
    onsubmit: e => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      dlg.close();
      api.newDesign(() => A.generateFromPrompt(text));
    },
  },
    h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Describe the garment'), ta),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Create and generate')));
  dlg.append(
    h('div', { class: 'dlg-head' }, h('h2', {}, 'New design'),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))),
    h('div', { class: 'choice-grid' },
      h('button', { class: 'choice', onclick: () => choose('upload', dlg) }, icon('upload', 20), h('b', {}, 'Upload photo'), h('span', {}, 'Start from a photo of a garment')),
      h('button', { class: 'choice', onclick: () => choose('generate', dlg) }, icon('sparkles', 20), h('b', {}, 'Generate from text'), h('span', {}, 'Describe a garment in words')),
      h('button', { class: 'choice', onclick: () => choose('sample', dlg) }, icon('layers', 20), h('b', {}, 'Try a sample shirt'), h('span', {}, 'Start with a ready-made t-shirt'))),
    genForm);
  if (preset === 'generate') openGenerate(dlg);
  dlg.querySelector('.choice').focus();
}
