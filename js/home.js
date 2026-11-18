// Home gallery (owner: home/gallery): design grid, search, tag filters, custom order (drag or up/down),
// new-design chooser, open / rename / tags / duplicate / delete. Storage lives in storage.js; the studio is driven by main.js.
// Tags and order are stored on the design record (meta.tags, meta.order, and doc.tags for the document).
import { h, icon, toast } from './util.js';
import * as store from './storage.js';
import * as A from './ui-actions.js';

const MAX_TAGS = 12, MAX_TAG_LEN = 24;
let root, api, qEl, sortEl, countEl, listEl, emptyEl, noteEl, chipsEl;
let metas = [];
let activeTags = new Set();   // tag filter, lower-case keys (a design must have every selected tag)
const SORT_KEY = 'threadform.home.sort';   // remembered in this browser only (a convenience, not design data)
let dragId = null;

export function initHome(el, actions) {
  root = el; api = actions;
  qEl = h('input', { type: 'search', class: 'home-search', placeholder: 'Search designs and tags', 'aria-label': 'Search designs', oninput: () => render() });
  sortEl = h('select', { class: 'home-sort', 'aria-label': 'Sort designs', onchange: () => render() },
    h('option', { value: 'edited' }, 'Recently edited'),
    h('option', { value: 'oldest' }, 'Least recently edited'),
    h('option', { value: 'created' }, 'Recently created'),
    h('option', { value: 'name' }, 'Name A–Z'),
    h('option', { value: 'custom' }, 'Custom order'));
  try { const saved = localStorage.getItem(SORT_KEY); if (saved && [...sortEl.options].some(o => o.value === saved)) sortEl.value = saved; } catch { }
  countEl = h('span', { class: 'muted small' });
  chipsEl = h('div', { class: 'tag-filters', role: 'group', 'aria-label': 'Filter by tag' });
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
      chipsEl, listEl, emptyEl, noteEl));
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

const tagsOf = m => (Array.isArray(m.tags) ? m.tags : []);
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
/** Custom order: designs with an order first (lowest first), then the rest, newest first. */
function customSorted(list) {
  return list.slice().sort((a, b) => {
    const ao = a.order ?? -Infinity, bo = b.order ?? -Infinity;
    if (ao !== bo) return ao < bo ? -1 : 1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}
const sorters = {
  edited: (a, b) => b.updatedAt - a.updatedAt,
  oldest: (a, b) => a.updatedAt - b.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
  name: byName,
  custom: null,
};

/** Every tag in use (case-insensitive: the first spelling wins) with how many designs have it, most used first. */
function allTags() {
  const count = new Map();
  for (const m of metas) for (const t of tagsOf(m)) {
    const k = t.toLowerCase(), e = count.get(k) || { name: t, key: k, n: 0 };
    e.n++; count.set(k, e);
  }
  return [...count.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}
const hasTag = (m, key) => tagsOf(m).some(t => t.toLowerCase() === key);

function renderChips() {
  const tags = allTags();
  for (const k of [...activeTags]) if (!tags.some(x => x.key === k)) activeTags.delete(k);
  chipsEl.hidden = tags.length === 0;
  chipsEl.replaceChildren(...tags.map(({ name, key, n }) => h('button', {
    class: 'tchip', 'aria-pressed': String(activeTags.has(key)),
    onclick: () => { activeTags.has(key) ? activeTags.delete(key) : activeTags.add(key); render(); },
  }, name, h('span', { class: 'tcount' }, String(n)))));
  if (activeTags.size) chipsEl.append(h('button', { class: 'tchip clear', onclick: () => { activeTags.clear(); render(); } }, 'Clear tags'));
}

function render() {
  const q = qEl.value.trim().toLowerCase();
  renderChips();
  const sortKey = sortEl.value;
  try { localStorage.setItem(SORT_KEY, sortKey); } catch { }
  const base = sortKey === 'custom' ? customSorted(metas) : metas.slice().sort(sorters[sortKey] || sorters.edited);
  const list = base.filter(m => (!q || (m.name || '').toLowerCase().includes(q) || tagsOf(m).some(t => t.toLowerCase().includes(q)))
    && [...activeTags].every(k => hasTag(m, k)));
  countEl.textContent = metas.length ? `${metas.length} design${metas.length === 1 ? '' : 's'}` : '';
  emptyEl.hidden = metas.length > 0;
  listEl.hidden = metas.length === 0;
  if (!metas.length) { listEl.replaceChildren(); return; }
  const canDrag = !q && activeTags.size === 0;
  listEl.replaceChildren(...(list.length ? list.map(m => card(m, base, canDrag)) : [h('p', { class: 'home-nomatch' }, 'No designs match' + (q ? ' “' + qEl.value.trim() + '”' : '') + (activeTags.size ? ' with those tags' : '') + '.')]));
}

function card(m, orderList, canDrag) {
  const thumb = m.thumb
    ? h('img', { src: m.thumb, alt: '', loading: 'lazy', decoding: 'async' })
    : h('div', { class: 'dthumb-empty' }, icon('layers', 30), h('span', {}, 'No artwork yet'));
  const views = m.views || 0;
  const tags = tagsOf(m);
  const pos = orderList.findIndex(x => x.id === m.id);
  const art = h('article', {
    class: 'dcard', role: 'listitem', 'data-id': m.id,
    draggable: canDrag ? 'true' : null,
    ondragstart: e => { dragId = m.id; e.dataTransfer && (e.dataTransfer.setData('text/plain', m.id), e.dataTransfer.effectAllowed = 'move'); art.classList.add('dragging'); },
    ondragend: () => { dragId = null; document.querySelectorAll('.dcard.dragging,.dcard.drop-before,.dcard.drop-after').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-after')); },
    ondragover: e => {
      if (!dragId || dragId === m.id || !canDrag) return;
      e.preventDefault(); const b = art.getBoundingClientRect(); const before = e.clientX < b.left + b.width / 2;
      art.classList.toggle('drop-before', before); art.classList.toggle('drop-after', !before);
    },
    ondragleave: () => art.classList.remove('drop-before', 'drop-after'),
    ondrop: e => {
      e.preventDefault(); art.classList.remove('drop-before', 'drop-after');
      const b = art.getBoundingClientRect(); const after = e.clientX >= b.left + b.width / 2;
      const from = dragId; dragId = null;
      if (from && from !== m.id) moveTo(from, m.id, after);
    },
  },
    h('button', { class: 'dcard-open', onclick: () => api.open(m.id), 'aria-label': `Open ${m.name}` },
      h('div', { class: 'dthumb' }, thumb),
      h('div', { class: 'dinfo' },
        h('div', { class: 'dname' }, m.name || 'Untitled design'),
        h('div', { class: 'dmeta' }, `Edited ${ago(m.updatedAt)} · ${views} ${views === 1 ? 'view' : 'views'}${m.kind ? ' · ' + m.kind : ''}`),
        tags.length ? h('div', { class: 'dtags' }, tags.map(t => h('span', { class: 'dtag' }, t))) : null)),
    h('div', { class: 'dactions' },
      h('button', { class: 'btn ghost sm mv', 'aria-label': `Move ${m.name} up`, tip: 'Move up', disabled: pos <= 0, onclick: () => move(m, -1) }, '▲'),
      h('button', { class: 'btn ghost sm mv', 'aria-label': `Move ${m.name} down`, tip: 'Move down', disabled: pos < 0 || pos >= orderList.length - 1, onclick: () => move(m, 1) }, '▼'),
      h('button', { class: 'btn ghost sm', onclick: () => rename(m) }, 'Rename'),
      h('button', { class: 'btn ghost sm', onclick: () => editTags(m) }, 'Tags'),
      h('button', { class: 'btn ghost sm', onclick: () => duplicate(m) }, 'Duplicate'),
      h('button', { class: 'btn ghost sm danger-txt', onclick: () => remove(m) }, icon('trash', 14), 'Delete')));
  return art;
}

async function guarded(fn) {
  try { await fn(); }
  catch (e) { console.error(e); toast(e.message || 'Something went wrong.', 'error'); }
  await refreshHome();
}

/* ------------------------------------------------------------------ order */
/** Writes order = position for every design whose order changed. `ordered` is the full list in its new order. */
async function persistOrder(ordered) {
  const changed = ordered.map((m, i) => [m, i]).filter(([m, i]) => m.order !== i);
  for (const [m, i] of changed) { await store.patchDesign(m.id, { meta: { order: i } }); m.order = i; }
  return changed.length;
}
/** Moves one design up (-1) or down (+1) in the custom order. */
function move(m, dir) {
  return guarded(async () => {
    const ordered = customSorted(metas);
    const i = ordered.findIndex(x => x.id === m.id), j = i + dir;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    sortEl.value = 'custom';
    await persistOrder(ordered);
  });
}
/** Drag and drop: puts design `fromId` just before (or after) design `toId`. */
function moveTo(fromId, toId, after) {
  return guarded(async () => {
    const ordered = customSorted(metas);
    const from = ordered.find(x => x.id === fromId); if (!from) return;
    const rest = ordered.filter(x => x.id !== fromId);
    let at = rest.findIndex(x => x.id === toId); if (at < 0) return;
    if (after) at += 1;
    rest.splice(at, 0, from);
    sortEl.value = 'custom';
    await persistOrder(rest);
  });
}

/* ------------------------------------------------------------------ actions */
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

/** Comma-separated text -> clean tag list: trimmed, no empties, no duplicates (any case), limited in count and length. */
export function parseTags(text) {
  const out = [], seen = new Set();
  for (const raw of String(text || '').split(',')) {
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function editTags(m) {
  return guarded(async () => {
    const text = await ask({ title: 'Tags', label: 'Tags, separated by commas', value: tagsOf(m).join(', '), ok: 'Save tags', allowEmpty: true, hint: 'For example: summer, client A, draft' });
    if (text === null) return;
    const tags = parseTags(text);
    await store.patchDesign(m.id, { meta: { tags }, doc: { tags } });
    toast(tags.length ? 'Tags saved.' : 'Tags removed.', 'ok');
  });
}

function duplicate(m) {
  return guarded(async () => {
    const rec = await store.getDesign(m.id);
    if (!rec) throw new Error('That design no longer exists.');
    const now = Date.now(), id = store.newId(), name = (m.name || 'Untitled design') + ' copy';
    await store.putDesign({
      id,
      meta: { ...rec.meta, id, name, createdAt: now, updatedAt: now, order: undefined },
      doc: { ...rec.doc, name, createdAt: now, updatedAt: now },
      assets: rec.assets,
    });
    // the copy goes right after the original in the custom order
    const ordered = customSorted(metas).filter(x => x.id !== id);
    const at = ordered.findIndex(x => x.id === m.id);
    const copy = { ...rec.meta, id, order: undefined, createdAt: now };
    ordered.splice(at + 1, 0, copy);
    await persistOrder(ordered);
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
function ask({ title, text = '', label = '', value = null, ok = 'OK', danger = false, allowEmpty = false, hint = '' }) {
  return new Promise(resolve => {
    const dlg = makeDialog('ask');
    const input = value == null ? null : h('input', { type: 'text', value, maxlength: allowEmpty ? 400 : 80, 'aria-label': label, required: !allowEmpty });
    const form = h('form', { method: 'dialog', class: 'dlg-body' },
      h('h2', {}, title),
      text ? h('p', { class: 'muted' }, text) : null,
      input ? h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, label), input, hint ? h('span', { class: 'muted small' }, hint) : null) : null,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close('') }, 'Cancel'),
        h('button', { type: 'submit', class: danger ? 'btn danger' : 'btn primary', value: 'ok' }, ok)));
    form.addEventListener('submit', e => { if (input && !allowEmpty && !input.value.trim()) { e.preventDefault(); input.focus(); } });
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
