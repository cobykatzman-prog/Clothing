// Home gallery (owner: home/gallery): design grid, search, tag filters, custom order (drag or up/down),
// new-design chooser, open / rename / tags / duplicate / delete. Storage lives in storage.js; the studio is driven by main.js.
// Tags and order are stored on the design record (meta.tags, meta.order, and doc.tags for the document).
import { h, icon, toast, friendly, userError, logoutForm } from './util.js';
import { normalizeMaterials } from './materials.js';
import { normalizeBrandKit, sanitizeBrandKitImport, BRAND_FONT_OPTIONS } from './brand-kit.js';
import { REVIEW_STATES, normalizeReview, filterDesigns, canReorderDesigns } from './gallery.js';
import * as store from './storage.js';
import * as R from './remote.js';
import * as A from './ui-actions.js';

const MAX_TAGS = 12, MAX_TAG_LEN = 24;
let root, api, qEl, sortEl, countEl, listEl, emptyEl, noteEl, chipsEl, collectionEl;
let metas = [];
let activeTags = new Set();   // tag filter, lower-case keys (a design must have every selected tag)
let activeCollection = '', activeReview = '';
let reviewEl;
let selectMode = false, selectedIds = new Set(), visibleIds = [], selectBtn, bulkEl;
const SORT_KEY = 'threadform.home.sort';   // remembered in this browser only (a convenience, not design data)
let dragId = null;
let sharedEl, badgeEl, badgeTxt, moveEl, movable = [], refreshing = false, tick = 0;   // shared-library mode only
const SHARED = () => store.shared();

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
  collectionEl = h('div', { class: 'collection-strip', role: 'group', 'aria-label': 'Design collections' });
  reviewEl = h('div', { class: 'review-filters', role: 'group', 'aria-label': 'Filter by review status' });
  listEl = h('div', { class: 'home-grid', role: 'list' });
  noteEl = h('p', { class: 'home-note small muted' });
  selectBtn = h('button', { type: 'button', class: 'btn ghost sm', 'aria-pressed': 'false', onclick: () => toggleSelectMode() }, 'Select designs');
  bulkEl = h('div', { class: 'bulk-toolbar', hidden: true });
  emptyEl = h('div', { class: 'home-empty', hidden: true },
    h('div', { class: 'empty-ico' }, icon('layers', 34)),
    h('h2', {}, 'Design your first garment'),
    h('p', {}, SHARED()
      ? 'Upload a photo, describe one in words, or start from a sample shirt. Every change is saved automatically, and these designs are shared with everyone who has the password.'
      : 'Upload a photo, describe one in words, or start from a sample shirt. Every change is saved here automatically.'),
    h('div', { class: 'home-choices' }, choiceButtons()));
  if (SHARED()) buildSharedStrip();
  root.replaceChildren(
    h('div', { class: 'home-top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('layers', 18)), h('b', {}, 'Threadform')),
      h('div', { class: 'home-actions' }, h('button', { class: 'btn ghost sm', onclick: () => editBrandKit() }, 'Brand kit'), h('button', { class: 'btn ghost sm', onclick: () => editMaterialsLibrary() }, 'Materials'), h('button', { class: 'btn ghost sm', onclick: () => manageCollections() }, 'Manage collections'), h('button', { class: 'btn ghost sm', onclick: () => createCollection() }, 'New collection'), h('button', { class: 'btn primary', id: 'home-new', onclick: () => chooser() }, icon('plus', 16), 'New design'), logoutForm())),
    h('div', { class: 'home-body' },
      h('div', { class: 'home-tools' },
        h('div', {}, h('h1', {}, SHARED() ? 'Shared designs' : 'Your designs'), countEl),
        h('div', { class: 'home-filters' }, qEl, sortEl, selectBtn)),
      sharedEl || null, collectionEl, chipsEl, reviewEl, bulkEl, listEl, emptyEl, noteEl));
  if (SHARED()) startSharedRefresh();
}

/** Reloads the list from storage and shows it. */
export async function refreshHome() {
  const mode = await store.initStorage();
  if (SHARED()) {
    noteEl.textContent = 'Designs are saved in the shared library: everyone who has the password sees and edits the same designs.'
      + (api.unsavedCount?.() ? ' Some changes are still waiting to be sent and will be saved as soon as the connection is back.' : '');
    checkStatus(false); loadMovable();
  } else noteEl.textContent = mode === 'memory' ? 'Browser storage is unavailable, so designs will be lost when you close this page.'
    : mode === 'localstorage' ? 'Designs are saved in this browser. Space is limited, so delete old designs if saving fails.'
    : 'Designs are saved in this browser.';
  try { metas = await store.listDesigns(); }
  catch (e) {
    toast(friendly(e, 'Your saved designs could not be read. Reload the page to try again.'), 'error', 5000);
    if (!SHARED()) metas = [];   // shared mode keeps showing the last list it had
    else { setBadge('bad', 'Cannot reach the shared library right now'); checkStatus(false); }   // then the exact reason
  }
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
const reviewOf = m => normalizeReview(m.review);
const collectionOf = m => String(m.collection || '').trim();
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
  let savedCollections = [];
  try { savedCollections = JSON.parse(localStorage.getItem('threadform.collections.v1') || '[]'); } catch { savedCollections = []; }
  const collections = [...new Set([...savedCollections, ...metas.map(collectionOf).filter(Boolean)])].sort((a,b) => a.localeCompare(b));
  collectionEl.hidden = !collections.length;
  collectionEl.replaceChildren(h('button', { class: 'collection-chip' + (!activeCollection ? ' active' : ''), 'aria-pressed': String(!activeCollection), onclick: () => { activeCollection = ''; render(); } }, 'All designs'));
  for (const name of collections) collectionEl.append(h('button', { class: 'collection-chip' + (activeCollection === name ? ' active' : ''), 'aria-pressed': String(activeCollection === name), onclick: () => { activeCollection = name; render(); } }, name));
}

function renderReviewFilters() {
  const options = [
    ['', 'All statuses', metas.length],
    ...Object.entries(REVIEW_STATES).map(([key, label]) => [key, label, metas.filter(m => reviewOf(m).status === key).length]),
  ];
  reviewEl.hidden = !metas.length;
  reviewEl.replaceChildren(...options.map(([key, label, count]) => h('button', {
    type: 'button', class: 'review-filter' + (activeReview === key ? ' active' : ''),
    'aria-pressed': String(activeReview === key),
    onclick: () => { activeReview = key; render(); },
  }, label, h('span', { class: 'review-filter-count' }, String(count)))));
}

function render() {
  const q = qEl.value.trim().toLowerCase();
  renderChips();
  renderReviewFilters();
  const sortKey = sortEl.value;
  try { localStorage.setItem(SORT_KEY, sortKey); } catch { }
  const base = sortKey === 'custom' ? customSorted(metas) : metas.slice().sort(sorters[sortKey] || sorters.edited);
  const list = filterDesigns(base, { query: q, tags: activeTags, collection: activeCollection, review: activeReview });
  visibleIds = list.map(m => m.id);
  for (const id of [...selectedIds]) if (!metas.some(m => m.id === id)) selectedIds.delete(id);
  const filtered = q || activeTags.size || activeCollection || activeReview;
  countEl.textContent = metas.length ? (filtered ? `${list.length} of ${metas.length} designs` : `${metas.length} design${metas.length === 1 ? '' : 's'}`) : '';
  emptyEl.hidden = metas.length > 0;
  listEl.hidden = metas.length === 0;
  const canDrag = canReorderDesigns({ sortKey, query: q, tags: activeTags, collection: activeCollection, review: activeReview, selectMode });
  listEl.replaceChildren(...(list.length ? list.map(m => card(m, base, canDrag)) : metas.length ? [h('p', { class: 'home-nomatch' }, 'No designs match' + (q ? ' “' + qEl.value.trim() + '”' : '') + (activeTags.size ? ' with those tags' : '') + (activeCollection ? ' in this collection' : '') + (activeReview ? ' with status ' + REVIEW_STATES[activeReview].toLowerCase() : '') + '.')] : []));
  renderBulkToolbar(list);
}

function toggleSelectMode(on = !selectMode) {
  selectMode = !!on;
  if (!selectMode) selectedIds.clear();
  selectBtn.textContent = selectMode ? 'Done selecting' : 'Select designs';
  selectBtn.setAttribute('aria-pressed', String(selectMode));
  selectBtn.classList.toggle('on', selectMode);
  render();
}
function renderBulkToolbar(visible) {
  const count = selectedIds.size;
  bulkEl.hidden = !selectMode && !count;
  if (bulkEl.hidden) { bulkEl.replaceChildren(); return; }
  const actions = count ? [
    h('button', { type: 'button', class: 'btn ghost sm', onclick: bulkMoveToCollection }, 'Move to collection'),
    h('button', { type: 'button', class: 'btn ghost sm', onclick: bulkAddTag }, 'Add tag'),
    h('button', { type: 'button', class: 'btn ghost sm danger-txt', onclick: bulkDelete }, 'Delete selected'),
  ] : [];
  bulkEl.replaceChildren(
    h('b', {}, count + (count === 1 ? ' selected' : ' selected')),
    h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { visible.forEach(m => selectedIds.add(m.id)); render(); }, disabled: !visible.length }, 'Select visible'),
    ...actions,
    h('button', { type: 'button', class: 'btn ghost sm', onclick: () => toggleSelectMode(false) }, 'Clear selection'));
}
function bulkMoveToCollection() {
  return guarded(async () => {
    const name = await ask({ title: 'Move selected designs', text: 'Enter a collection name, or leave it empty to remove the selected designs from their current collections.', label: 'Collection', value: activeCollection, ok: 'Move', allowEmpty: true });
    if (name === null) return;
    const collection = name.trim().slice(0, 40);
    for (const m of metas.filter(x => selectedIds.has(x.id))) await store.patchDesign(m.id, { meta: { collection } });
    activeCollection = collection; toggleSelectMode(false);
    toast(collection ? 'Moved designs to ' + collection + '.' : 'Removed designs from their collections.', 'ok');
  });
}
function bulkAddTag() {
  return guarded(async () => {
    const value = await ask({ title: 'Add a tag to selected designs', label: 'Tag', value: '', ok: 'Add tag', hint: 'A tag is added without removing existing tags.' });
    if (value === null) return;
    const additions = parseTags(value);
    if (!additions.length) return;
    for (const m of metas.filter(x => selectedIds.has(x.id))) {
      const tags = parseTags([...tagsOf(m), ...additions].join(', '));
      await store.patchDesign(m.id, { meta: { tags }, doc: { tags } });
    }
    toggleSelectMode(false);
    toast('Tag added to selected designs.', 'ok');
  });
}
function bulkDelete() {
  return guarded(async () => {
    const chosen = metas.filter(m => selectedIds.has(m.id));
    if (!chosen.length) return;
    const yes = await ask({ title: `Delete ${chosen.length} designs?`, text: SHARED()
      ? 'This removes the selected designs and their saved versions for everyone with access to the shared library.'
      : 'This removes the selected designs and their saved versions from this browser.',
      ok: 'Delete designs', danger: true });
    if (!yes) return;
    const records = [];
    for (const m of chosen) {
      const rec = await store.getDesign(m.id);
      await store.deleteDesign(m.id);
      if (rec) records.push(rec);
    }
    toggleSelectMode(false);
    toast(`Deleted ${records.length} design${records.length === 1 ? '' : 's'}.`, 'ok', 5000, records.length ? {
      label: 'Undo', fn: () => guarded(async () => {
        for (const rec of records) await store.putDesign(rec);
        toast('Deleted designs restored.', 'ok');
      })
    } : null);
  });
}

function card(m, orderList, canDrag) {
  const thumb = m.thumb
    ? h('img', { src: m.thumb, alt: '', loading: 'lazy', decoding: 'async' })
    : h('div', { class: 'dthumb-empty' }, icon('layers', 30), h('span', {}, 'No artwork yet'));
  const views = m.views || 0;
  const tags = tagsOf(m);
  const review = reviewOf(m);
  const pos = orderList.findIndex(x => x.id === m.id);
  const art = h('article', {
    class: 'dcard' + (selectMode ? ' selectable' : '') + (selectedIds.has(m.id) ? ' selected' : ''), role: 'listitem', 'data-id': m.id,
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
    selectMode ? h('label', { class: 'dcard-select', 'aria-label': 'Select ' + (m.name || 'design') },
      h('input', { type: 'checkbox', checked: selectedIds.has(m.id), onchange: e => {
        if (e.target.checked) selectedIds.add(m.id); else selectedIds.delete(m.id);
        art.classList.toggle('selected', e.target.checked);
        renderBulkToolbar(metas.filter(x => visibleIds.includes(x.id)));
      } }), h('span', {}, 'Select')) : null,
    h('button', { class: 'dcard-open', onclick: () => { if (selectMode) { selectedIds.has(m.id) ? selectedIds.delete(m.id) : selectedIds.add(m.id); render(); } else api.open(m.id); }, 'aria-label': `Open ${m.name}` },
      h('div', { class: 'dthumb' }, thumb),
      h('div', { class: 'dinfo' },
        h('div', { class: 'dname' }, m.name || 'Untitled design'),
        h('div', { class: 'dmeta' }, `Edited ${ago(m.updatedAt)} · ${views} ${views === 1 ? 'view' : 'views'}${m.kind ? ' · ' + m.kind : ''}`),
        h('div', { class: 'dreview' }, h('span', { class: 'review-pill review-' + review.status }, REVIEW_STATES[review.status]), review.reviewer ? h('span', { class: 'review-by' }, 'by ' + review.reviewer) : null),
        m.material?.name ? h('div', { class: 'design-material' }, h('i', { style: `background:${m.material.color || '#d6d3d1'}` }), m.material.name) : null,
        tags.length ? h('div', { class: 'dtags' }, tags.map(t => h('span', { class: 'dtag' }, t))) : null)),
    h('div', { class: 'dactions' },
      canDrag ? h('button', { class: 'btn ghost sm mv', 'aria-label': `Move ${m.name} up`, tip: 'Move up', disabled: pos <= 0, onclick: () => move(m, -1) }, '▲') : null,
      canDrag ? h('button', { class: 'btn ghost sm mv', 'aria-label': `Move ${m.name} down`, tip: 'Move down', disabled: pos < 0 || pos >= orderList.length - 1, onclick: () => move(m, 1) }, '▼') : null,
      h('button', { class: 'btn ghost sm', onclick: () => rename(m) }, 'Rename'),
      h('button', { class: 'btn ghost sm', onclick: () => editTags(m) }, 'Tags'),
      h('button', { class: 'btn ghost sm', onclick: () => editReview(m) }, 'Review'),
      SHARED() ? h('button', { class: 'btn ghost sm', onclick: () => copySharedLink(m) }, 'Copy link') : null,
      h('button', { class: 'btn ghost sm', onclick: () => assignCollection(m) }, collectionOf(m) ? 'Collection' : 'Add to collection'),
      h('button', { class: 'btn ghost sm', onclick: () => assignMaterial(m) }, 'Material'),
      h('button', { class: 'btn ghost sm', onclick: () => duplicate(m) }, 'Duplicate'),
      h('button', { class: 'btn ghost sm danger-txt', onclick: () => remove(m) }, icon('trash', 14), 'Delete')));
  return art;
}

async function guarded(fn) {
  try { await fn(); }
  catch (e) { console.error(e); toast(friendly(e, 'That did not work. Reload the page and try again.'), 'error', 5000); }
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




/* ---------------------------------------------------------------- materials library */
const MATERIALS_KEY = 'threadform.materials.v1';
const MATERIAL_TYPES = ['Cotton','Polyester','Fleece','Nylon','Wool','Linen','Mesh','Rib knit','Jersey','French terry','Denim','Other'];
function readMaterials() {
  try { return normalizeMaterials(JSON.parse(localStorage.getItem(MATERIALS_KEY) || '[]')); }
  catch { return []; }
}
function writeMaterials(items) {
  try { localStorage.setItem(MATERIALS_KEY, JSON.stringify(items)); return true; }
  catch { toast('Could not save the materials library on this device.', 'error'); return false; }
}
function materialEditor(existing, onSaved) {
  const item = existing || {};
  const dlg = makeDialog('material-edit-dialog');
  const field = (label, value, attrs = {}) => {
    const input = h('input', { value: value ?? '', ...attrs });
    return { input, node: h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, label), input) };
  };
  const name = field('Material name *', item.name || '', { type: 'text', maxlength: 60, required: true, placeholder: 'e.g. 280 GSM heavyweight cotton' });
  const type = h('select', {}, ...MATERIAL_TYPES.map(v => h('option', { value: v }, v)));
  type.value = MATERIAL_TYPES.includes(item.type) ? item.type : 'Other';
  const colour = h('input', { type: 'color', value: item.color || '#d6d3d1', 'aria-label': 'Material swatch colour' });
  const composition = field('Composition', item.composition, { type: 'text', maxlength: 100, placeholder: 'e.g. 80% cotton / 20% polyester' });
  const weight = field('Fabric weight (GSM)', item.weightGsm, { type: 'number', min: 1, max: 2000, step: 1, placeholder: 'e.g. 280' });
  const width = field('Fabric width (cm)', item.widthCm, { type: 'number', min: 1, max: 500, step: 1, placeholder: 'e.g. 150' });
  const supplier = field('Supplier', item.supplier, { type: 'text', maxlength: 80, placeholder: 'Supplier or mill' });
  const sku = field('Supplier code / SKU', item.sku, { type: 'text', maxlength: 50, placeholder: 'Optional reference' });
  const price = field('Price per metre', item.pricePerMetre, { type: 'number', min: 0, max: 100000, step: '0.01', placeholder: 'Optional' });
  const care = field('Care instructions', item.care, { type: 'text', maxlength: 120, placeholder: 'e.g. Cold wash, do not tumble dry' });
  const notes = field('Notes', item.notes, { type: 'text', maxlength: 160, placeholder: 'Finish, stretch, hand-feel, usage...' });
  const form = h('form', { class: 'material-edit-form', onsubmit: e => {
    e.preventDefault();
    const cleanName = name.input.value.trim();
    if (!cleanName) { name.input.focus(); return; }
    const numeric = value => value === '' ? '' : Number(value);
    const next = {
      id: item.id || ('mat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      name: cleanName, type: type.value, color: colour.value,
      composition: composition.input.value.trim(), weightGsm: numeric(weight.input.value),
      widthCm: numeric(width.input.value), supplier: supplier.input.value.trim(),
      sku: sku.input.value.trim(), pricePerMetre: numeric(price.input.value),
      care: care.input.value.trim(), notes: notes.input.value.trim(),
    };
    const all = readMaterials();
    const index = all.findIndex(x => x.id === next.id);
    if (index >= 0) all[index] = next; else all.push(next);
    if (writeMaterials(all)) { dlg.close(); onSaved?.(next); }
  } },
    name.node,
    h('div', { class: 'materials-fields' },
      h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Fabric type'), type),
      h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Swatch colour'), colour)),
    composition.node,
    h('div', { class: 'materials-fields' }, weight.node, width.node),
    h('div', { class: 'materials-fields' }, supplier.node, sku.node),
    price.node, care.node, notes.node,
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, existing ? 'Save changes' : 'Add material')));
  dlg.append(h('div', { class: 'dlg-head' }, h('h2', {}, existing ? 'Edit material' : 'Add material'),
    h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))), form);
  name.input.focus();
}
function editMaterialsLibrary() {
  const dlg = makeDialog('materials-dialog');
  const search = h('input', { type: 'search', placeholder: 'Search materials, suppliers or fabric types...', 'aria-label': 'Search materials' });
  const list = h('div', { class: 'materials-list' });
  const count = h('span', { class: 'muted small' });
  const draw = () => {
    const all = readMaterials();
    const q = search.value.trim().toLowerCase();
    const items = all.filter(item => [item.name,item.type,item.composition,item.supplier,item.sku,item.notes].join(' ').toLowerCase().includes(q));
    count.textContent = all.length + (all.length === 1 ? ' saved material' : ' saved materials');
    list.replaceChildren(...items.map(item => h('article', { class: 'material-row material-library-card' },
      h('i', { class: 'material-swatch', style: `background:${item.color}` }),
      h('div', { class: 'material-row-copy' },
        h('b', {}, item.name),
        h('span', {}, [item.type, item.weightGsm ? item.weightGsm + ' GSM' : '', item.composition].filter(Boolean).join(' · ')),
        h('span', {}, [item.supplier, item.sku ? 'SKU ' + item.sku : '', item.widthCm ? item.widthCm + ' cm wide' : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'material-row-actions' },
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => materialEditor(item, draw) }, 'Edit'),
        h('button', { type: 'button', class: 'btn ghost sm danger-txt', onclick: async () => {
          const ok = await ask({ title: 'Remove material?', label: 'This removes it from the library. Existing designs keep their saved material details.', value: item.name, ok: 'Remove' });
          if (ok === null) return;
          if (writeMaterials(readMaterials().filter(x => x.id !== item.id))) draw();
        } }, 'Remove')))));
    if (!items.length) list.append(h('p', { class: 'muted small' }, all.length ? 'No materials match that search.' : 'No saved materials yet. Add your first fabric below.'));
  };
  search.addEventListener('input', draw);
  dlg.append(h('div', { class: 'dlg-head' }, h('h2', {}, 'Materials library'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))),
    h('p', { class: 'muted small materials-intro' }, 'Keep fabric specifications, supplier references and care details organised. Designs retain a snapshot of the material assigned to them.'),
    h('div', { class: 'materials-toolbar' }, search, count), list,
    h('div', { class: 'materials-library-footer' }, h('button', { type: 'button', class: 'btn primary', onclick: () => materialEditor(null, draw) }, icon('plus', 15), ' Add material')));
  draw(); search.focus();
}
function assignMaterial(m) {
  const items = readMaterials();
  if (!items.length) { toast('Add a material to your library first.', 'error'); editMaterialsLibrary(); return; }
  const dlg = makeDialog('assign-material-dialog');
  const select = h('select', { class: 'material-select' },
    h('option', { value: '' }, 'No material'),
    ...items.map(item => h('option', { value: item.id }, item.name + ' · ' + item.type + (item.weightGsm ? ' · ' + item.weightGsm + ' GSM' : ''))));
  if (m.material?.id) select.value = m.material.id;
  const detail = h('div', { class: 'material-assignment-preview' });
  const preview = () => {
    const item = items.find(x => x.id === select.value);
    detail.replaceChildren(...(item ? [
      h('i', { class: 'material-swatch', style: `background:${item.color}` }),
      h('div', {}, h('b', {}, item.name), h('span', {}, [item.composition, item.weightGsm ? item.weightGsm + ' GSM' : '', item.widthCm ? item.widthCm + ' cm width' : '', item.supplier].filter(Boolean).join(' · ')))
    ] : [h('span', { class: 'muted small' }, 'No material will be assigned to this design.')]));
  };
  select.addEventListener('change', preview);
  const form = h('form', { class: 'dlg-body', onsubmit: async e => {
    e.preventDefault();
    const item = items.find(x => x.id === select.value);
    const material = item ? { ...item } : null;
    try {
      await store.patchDesign(m.id, { meta: { material } });
      dlg.close(); toast(material ? 'Material attached to design.' : 'Material removed.', 'ok');
      await refreshHome();
    } catch (err) { toast(friendly(err, 'Could not update the design material.'), 'error', 5000); }
  } },
    h('h2', {}, 'Design material'),
    h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Choose a saved material'), select),
    detail,
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
  dlg.append(form); preview(); select.focus();
}

/* ---------------------------------------------------------------- collections + brand kit */
async function createCollection() {
  const name = await ask({ title: 'New collection', label: 'Collection name', value: '', ok: 'Create' });
  if (!name) return;
  const clean = name.trim().slice(0, 40);
  if (!clean) return;
  try {
    const existing = JSON.parse(localStorage.getItem('threadform.collections.v1') || '[]');
    const names = Array.isArray(existing) ? existing : [];
    if (!names.some(x => String(x).toLowerCase() === clean.toLowerCase())) names.push(clean);
    localStorage.setItem('threadform.collections.v1', JSON.stringify(names));
  } catch { toast('Could not save the collection on this device.', 'error'); return; }
  activeCollection = clean;
  toast('Collection created. Add designs using “Add to collection”.', 'ok');
  render();
}
async function manageCollections() {
  const readNames = () => {
    let saved = [];
    try { const parsed = JSON.parse(localStorage.getItem('threadform.collections.v1') || '[]'); saved = Array.isArray(parsed) ? parsed : []; } catch { }
    return [...new Set([...saved, ...metas.map(collectionOf).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  };
  const dlg = makeDialog('collections-dialog');
  const list = h('div', { class: 'materials-list' });
  const draw = () => {
    const names = readNames();
    list.replaceChildren(...(names.length ? names.map(name => h('div', { class: 'material-row' },
      h('div', { class: 'material-row-copy' },
        h('b', {}, name),
        h('span', {}, `${metas.filter(m => collectionOf(m) === name).length} designs`)),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: async () => {
        const next = await ask({ title: 'Rename collection', label: 'New collection name', value: name, ok: 'Rename' });
        if (next === null) return;
        const clean = next.trim().slice(0, 40);
        if (!clean) { toast('Collection name cannot be empty.', 'error'); return; }
        const collision = readNames().some(n => n.toLowerCase() === clean.toLowerCase() && n !== name);
        if (collision) { toast('A collection with that name already exists.', 'error'); return; }
        try {
          for (const m of metas.filter(x => collectionOf(x) === name)) await store.patchDesign(m.id, { meta: { collection: clean } });
          const updated = readNames().filter(n => n !== name);
          if (!updated.some(n => n.toLowerCase() === clean.toLowerCase())) updated.push(clean);
          localStorage.setItem('threadform.collections.v1', JSON.stringify(updated));
          if (activeCollection === name) activeCollection = clean;
          toast('Collection renamed.', 'ok');
          await refreshHome(); draw();
        } catch (e) { toast(friendly(e, 'Could not rename the collection. Some designs may need checking.'), 'error', 5000); await refreshHome(); draw(); }
      } }, 'Rename'),
      h('button', { type: 'button', class: 'btn ghost sm danger-txt', onclick: async () => {
        const yes = await ask({ title: `Delete collection “${name}”?`, text: 'Designs in this collection will be kept, but removed from the collection.', ok: 'Delete collection', danger: true });
        if (!yes) return;
        try {
          for (const m of metas.filter(x => collectionOf(x) === name)) await store.patchDesign(m.id, { meta: { collection: '' } });
          const updated = readNames().filter(n => n !== name);
          localStorage.setItem('threadform.collections.v1', JSON.stringify(updated));
          if (activeCollection === name) activeCollection = '';
          toast('Collection deleted. Designs were kept.', 'ok');
          await refreshHome(); draw();
        } catch (e) { toast(friendly(e, 'Could not delete the collection. Some designs may need checking.'), 'error', 5000); await refreshHome(); draw(); }
      } }, 'Delete')
    )) : [h('p', { class: 'muted small' }, 'No collections yet. Create one to organise your designs.')]));
  };
  dlg.append(
    h('div', { class: 'dlg-head' }, h('h2', {}, 'Manage collections'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))),
    h('p', { class: 'muted small' }, 'Rename or delete a collection. Deleting a collection keeps its designs.'),
    list);
  draw();
}
function assignCollection(m) {
  return guarded(async () => {
    const name = await ask({ title: 'Organise design', text: 'Enter a collection name, or leave it empty to remove this design from its collection.', label: 'Collection', value: collectionOf(m), ok: 'Save', allowEmpty: true, hint: 'Examples: Summer 2027, Teamwear, Client projects' });
    if (name === null) return;
    const collection = name.trim().slice(0, 40);
    await store.patchDesign(m.id, { meta: { collection } });
    activeCollection = collection;
    toast(collection ? 'Added to ' + collection + '.' : 'Removed from its collection.', 'ok');
  });
}

const BRAND_KEY = 'threadform.brand-kit.v1';
function readBrandKit() {
  try { return normalizeBrandKit(JSON.parse(localStorage.getItem(BRAND_KEY) || '{}')); }
  catch { return normalizeBrandKit({ palette: [] }); }
}
function editBrandKit() {
  const saved = readBrandKit();
  const logos = { primary: '', alternate: '', mark: '', ...(saved.logos || {}) };
  if (!logos.primary && saved.logo) logos.primary = saved.logo;
  const palette = (saved.palette || []).slice(0, 12).map((item, i) => ({
    name: String(item.name || ('Colour ' + (i + 1))).slice(0, 24),
    color: /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#292820',
  }));
  const typography = { heading: 'Georgia', body: 'Arial', ...(saved.typography || {}) };
  const dlg = makeDialog('brand-kit-dialog');
  const brandName = h('input', { type: 'text', maxlength: 60, value: saved.name || '', placeholder: 'Your clothing label' });
  const logoList = h('div', { class: 'brand-logo-list' });
  const paletteList = h('div', { class: 'brand-palette-list' });
  const headingFont = h('select', {}, ...BRAND_FONT_OPTIONS.map(font => h('option', { value: font }, font)));
  const bodyFont = h('select', {}, ...BRAND_FONT_OPTIONS.map(font => h('option', { value: font }, font)));
  headingFont.value = BRAND_FONT_OPTIONS.includes(typography.heading) ? typography.heading : 'Georgia';
  bodyFont.value = BRAND_FONT_OPTIONS.includes(typography.body) ? typography.body : 'Arial';

  const drawLogos = () => {
    const labels = { primary: 'Primary logo', alternate: 'Alternate logo', mark: 'Icon / brand mark' };
    logoList.replaceChildren(...Object.keys(labels).map(key => {
      const preview = logos[key]
        ? h('img', { src: logos[key], alt: labels[key] + ' preview' })
        : h('span', { class: 'brand-logo-empty' }, 'No file selected');
      const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', 'aria-label': 'Upload ' + labels[key] });
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > 1024 * 1024) { toast('Each logo must be under 1 MB.', 'error'); input.value = ''; return; }
        if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) { toast('Choose a PNG, JPG, WebP or SVG logo.', 'error'); input.value = ''; return; }
        const reader = new FileReader();
        reader.onload = () => { logos[key] = String(reader.result || ''); drawLogos(); };
        reader.onerror = () => toast('Could not read that logo file.', 'error');
        reader.readAsDataURL(file);
      });
      return h('div', { class: 'brand-logo-row' },
        h('div', { class: 'brand-logo-copy' }, h('b', {}, labels[key]), h('div', { class: 'brand-logo-preview' }, preview)),
        h('div', { class: 'brand-logo-actions' }, input,
          logos[key] ? h('button', { type: 'button', class: 'btn ghost sm danger-txt', onclick: () => { logos[key] = ''; drawLogos(); } }, 'Remove') : null));
    }));
  };
  const drawPalette = () => {
    paletteList.replaceChildren(...palette.map((item, index) => {
      const name = h('input', { type: 'text', maxlength: 24, value: item.name, 'aria-label': 'Colour name' });
      const color = h('input', { type: 'color', value: item.color, 'aria-label': item.name + ' swatch' });
      name.addEventListener('input', () => { item.name = name.value; });
      color.addEventListener('input', () => { item.color = color.value; });
      return h('div', { class: 'brand-palette-row' }, color, name,
        h('button', { type: 'button', class: 'btn ghost sm danger-txt', 'aria-label': 'Remove ' + item.name, onclick: () => { palette.splice(index, 1); drawPalette(); } }, 'Remove'));
    }));
  };
  const addColour = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => {
    if (palette.length >= 12) { toast('The palette can contain up to 12 colours.', 'error'); return; }
    palette.push({ name: 'New colour', color: '#a18a68' }); drawPalette();
  } }, 'Add colour');

  const importIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Import brand kit JSON' });
  importIn.addEventListener('change', async () => {
    const file = importIn.files?.[0]; importIn.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Brand Kit JSON files must be under 5 MB.', 'error'); return; }
    try {
      const imported = sanitizeBrandKitImport(JSON.parse(await file.text()));
      brandName.value = imported.name || '';
      for (const key of ['primary', 'alternate', 'mark']) logos[key] = imported.logos[key] || '';
      palette.splice(0, palette.length, ...imported.palette);
      headingFont.value = imported.typography.heading;
      bodyFont.value = imported.typography.body;
      drawLogos(); drawPalette();
      toast('Brand kit imported. Press Save brand kit to keep it on this browser.', 'ok', 4500);
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file is not valid Brand Kit JSON.' : (err.message || 'Could not import that Brand Kit file.'), 'error', 5000);
    }
  });
  const exportBtn = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => {
    const cleanPalette = palette.map((item, i) => ({
      name: String(item.name || ('Colour ' + (i + 1))).trim().slice(0, 24) || ('Colour ' + (i + 1)),
      color: /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#292820',
    }));
    const data = {
      ...saved, name: brandName.value.trim(), logos, logo: logos.primary || '',
      palette: cleanPalette, primary: cleanPalette[0]?.color || '#292820',
      secondary: cleanPalette[1]?.color || '#e9e5dc', accent: cleanPalette[2]?.color || '#a18a68',
      typography: { heading: headingFont.value, body: bodyFont.value },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = (brandName.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brand-kit') + '-brand-kit.json';
    a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Brand kit exported as JSON.', 'ok');
  } }, 'Export JSON');
  const importBtn = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => importIn.click() }, 'Import JSON');

  const form = h('form', { class: 'brand-kit-form', onsubmit: e => {
    e.preventDefault();
    const cleanPalette = palette.map((item, i) => ({
      name: String(item.name || ('Colour ' + (i + 1))).trim().slice(0, 24) || ('Colour ' + (i + 1)),
      color: /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#292820',
    }));
    const data = {
      ...saved, name: brandName.value.trim(), logos, logo: logos.primary || '',
      palette: cleanPalette,
      primary: cleanPalette[0]?.color || '#292820',
      secondary: cleanPalette[1]?.color || '#e9e5dc',
      accent: cleanPalette[2]?.color || '#a18a68',
      typography: { heading: headingFont.value, body: bodyFont.value },
    };
    try {
      localStorage.setItem(BRAND_KEY, JSON.stringify(data));
      dlg.close(); toast('Brand kit saved on this device.', 'ok');
    } catch { toast('Could not save the brand kit. Try smaller logo files or remove a logo.', 'error', 5000); }
  } },
    h('section', { class: 'brand-kit-section' },
      h('h3', {}, 'Brand identity'),
      h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Brand name'), brandName)),
    h('section', { class: 'brand-kit-section' },
      h('div', { class: 'brand-kit-section-head' }, h('h3', {}, 'Logo library'), h('span', { class: 'muted small' }, 'Up to 3 variations')),
      logoList),
    h('section', { class: 'brand-kit-section' },
      h('div', { class: 'brand-kit-section-head' }, h('h3', {}, 'Colour palette'), addColour),
      paletteList),
    h('section', { class: 'brand-kit-section' },
      h('h3', {}, 'Typography'),
      h('div', { class: 'brand-kit-type-grid' },
        h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Headings'), headingFont),
        h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Body text'), bodyFont))),
    h('p', { class: 'muted small' }, 'This brand kit is saved in this browser. Export a JSON copy to transfer it to another browser, or import a copy here. It is not automatically synced between devices.'),
    h('div', { class: 'dlg-actions' }, importIn, importBtn, exportBtn, h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save brand kit')));
  dlg.append(h('div', { class: 'dlg-head' }, h('h2', {}, 'Brand kit'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))), form);
  drawLogos(); drawPalette(); brandName.focus();
}
/* ------------------------------------------------------------------ actions */
function rename(m) {
  return guarded(async () => {
    const name = await ask({ title: 'Rename design', label: 'Design name', value: m.name, ok: 'Rename' });
    if (!name) return;
    await store.patchDesign(m.id, { meta: { name }, doc: { name } });
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

function editReview(m) {
  const current = reviewOf(m);
  const dlg = makeDialog('review-dialog');
  const status = h('select', {}, ...Object.entries(REVIEW_STATES).map(([value, label]) => h('option', { value }, label)));
  status.value = current.status;
  const reviewer = h('input', { type: 'text', maxlength: 60, value: current.reviewer, placeholder: 'Name of reviewer (optional)' });
  const note = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Feedback, requested changes or approval notes...' }, current.note);
  const form = h('form', { class: 'dlg-body review-form', onsubmit: async e => {
    e.preventDefault();
    const review = { status: status.value, reviewer: reviewer.value.trim(), note: note.value.trim(), updatedAt: Date.now() };
    try {
      await store.patchDesign(m.id, { meta: { review } });
      dlg.close(); toast('Review status saved.', 'ok'); await refreshHome();
    } catch (err) { toast(friendly(err, 'Could not save the review status.'), 'error', 5000); }
  } },
    h('h2', {}, 'Design review'),
    h('p', { class: 'muted small' }, 'Track progress for your team. Approval is a workflow label; it does not lock the design or verify factory measurements.'),
    h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Status'), status),
    h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Reviewer'), reviewer),
    h('label', { class: 'dlg-field' }, h('span', { class: 'lbl' }, 'Review notes'), note),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Save review')));
  dlg.append(h('div', { class: 'dlg-head' }, h('h2', {}, 'Review: ' + (m.name || 'Untitled design')), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))), form);
  status.focus();
}
async function copySharedLink(m) {
  const url = new URL(location.href);
  url.hash = '#/design/' + encodeURIComponent(m.id);
  const link = url.toString();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(link);
    toast('Shared design link copied. Anyone opening it still needs shared-library access.', 'ok');
  } catch {
    window.prompt('Copy this shared design link. Anyone opening it still needs shared-library access:', link);
  }
}

function duplicate(m) {
  return guarded(async () => {
    const name = (m.name || 'Untitled design') + ' copy', now = Date.now();
    const id = await store.duplicateDesign(m.id, name);
    // the copy goes right after the original in the custom order
    const ordered = customSorted(metas).filter(x => x.id !== id);
    const at = ordered.findIndex(x => x.id === m.id);
    const copy = { ...m, id, name, order: undefined, createdAt: now };
    ordered.splice(at + 1, 0, copy);
    await persistOrder(ordered);
    toast('Duplicated “' + m.name + '”.', 'ok');
  });
}

function remove(m) {
  return guarded(async () => {
    const yes = await ask({
      title: `Delete “${m.name}”?`,
      text: SHARED()
        ? 'This removes the design, its views and its saved versions for everyone who has the password. You can undo it straight after.'
        : 'This removes the design, its views and its saved versions from this browser. You can undo it straight after.',
      ok: 'Delete design', danger: true,
    });
    if (!yes) return;
    const rec = await store.getDesign(m.id);   // kept in memory so Undo can put it back
    await store.deleteDesign(m.id);
    toast('Design deleted.', 'ok', 4000, rec ? { label: 'Undo', fn: () => guarded(async () => { await store.putDesign(rec); toast('Design restored.', 'ok'); }) } : null);
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
  h('button', { class: 'btn ghost lg', onclick: () => choose('club', dlg) }, icon('layers', 17), 'Club Élite test shirt'),
];

/** The three ways to start a design. Upload opens the file picker synchronously (needed for user activation). */
function choose(kind, dlg) {
  if (kind === 'club') { dlg?.close(); return api.newDesign(() => A.loadClubSample()); }
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
      h('button', { class: 'choice', onclick: () => choose('sample', dlg) }, icon('layers', 20), h('b', {}, 'Try a sample shirt'), h('span', {}, 'Start with a ready-made t-shirt')),
      h('button', { class: 'choice', onclick: () => choose('club', dlg) }, icon('layers', 20), h('b', {}, 'Club Élite test shirt'), h('span', {}, 'Cream shirt with artwork on both sides'))),
    genForm);
  if (preset === 'generate') openGenerate(dlg);
  dlg.querySelector('.choice').focus();
}


/* ------------------------------------------------------------------ shared library: status, live refresh, moving old local designs */
function setBadge(state, text) {
  if (!badgeEl) return;
  badgeEl.dataset.state = state;
  badgeTxt.textContent = 'Shared library: ' + text;
}
async function checkStatus(announce = true) {
  if (!badgeEl) return;
  if (announce) setBadge('checking', 'checking...');
  try {
    const st = await R.status(announce);
    if (!st.enabled) setBadge('bad', 'switched off on the server');
    else if (st.ok) setBadge('ok', 'Connected');
    else setBadge('bad', st.error || 'not connected');
  } catch (e) { setBadge('bad', e.kind === 'auth' ? 'log in again to connect' : 'cannot reach the server'); }
  if (announce) toast(badgeTxt.textContent.replace('Shared library: ', ''), badgeEl.dataset.state === 'ok' ? 'ok' : 'error', 3000);
}

function buildSharedStrip() {
  badgeTxt = h('span', {}, 'Shared library: checking...');
  badgeEl = h('span', { class: 'badge shared', role: 'status', 'aria-live': 'polite', 'data-state': 'checking' }, h('i', { class: 'dot' }), badgeTxt);
  moveEl = h('div', { class: 'move-note', hidden: true });
  sharedEl = h('div', { class: 'shared-strip' },
    h('div', { class: 'shared-row' }, badgeEl,
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => checkStatus(true) }, 'Check connection'),
      h('span', { class: 'muted small' }, 'Everyone who has the password sees and edits these designs.')),
    moveEl);
}

async function loadMovable() {
  movable = await store.movableLocalDesigns();
  if (!moveEl) return;
  if (!movable.length) { moveEl.hidden = true; moveEl.replaceChildren(); return; }
  const n = movable.length;
  moveEl.replaceChildren(
    h('span', {}, `This browser still has ${n} design${n === 1 ? '' : 's'} saved only here (from before the shared library).`),
    h('button', { type: 'button', class: 'btn primary sm', id: 'move-local', onclick: moveLocal }, 'Move my local designs to the shared library'));
  moveEl.hidden = false;
}

let moving = false;
async function moveLocal() {
  if (moving || !movable.length) return;
  const list = movable.slice(), n = list.length;
  const yes = await ask({
    title: 'Move your local designs?',
    text: `This copies ${n} design${n === 1 ? '' : 's'} saved in this browser to the shared library, where everyone who has the password can see and edit ${n === 1 ? 'it' : 'them'}. Nothing is removed from this browser yet.`,
    ok: 'Move to shared library',
  });
  if (!yes) return;
  moving = true;
  const btn = moveEl.querySelector('button');
  const done = [];
  let failed = 0, completed = 0, next = 0;
  if (btn) { btn.disabled = true; btn.textContent = `Moving 0 of ${n}...`; }
  try {
    // Move up to three designs at once. Each design also uploads its images in small parallel batches.
    const worker = async () => {
      while (next < list.length) {
        const m = list[next++];
        try {
          const r = await store.moveLocalDesign(m.id);
          if (r !== 'missing') {
            done.push(m.id);
            await store.local.patch(m.id, { meta: { sharedCopy: true } }).catch(() => { });
          }
        } catch (e) { console.error(e); failed++; }
        completed++;
        if (btn) btn.textContent = `Moving ${completed} of ${n}...`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
  } finally { moving = false; }
  await refreshHome();
  if (failed) toast(`${failed} design${failed === 1 ? '' : 's'} could not be moved. Check the connection and press the button again.`, 'error', 6000);
  if (!done.length) return;
  toast(`Moved ${done.length} design${done.length === 1 ? '' : 's'} to the shared library.`, 'ok');
  const del = await ask({
    title: 'Remove the copies from this browser?',
    text: 'Your designs are now in the shared library. Removing the old copies frees space in this browser, and you can undo it straight after.',
    ok: 'Remove local copies',
  });
  if (!del) return;
  const kept = [];
  for (const id of done) { try { const rec = await store.local.get(id); if (rec) { kept.push(rec); await store.local.delete(id); } } catch (e) { console.error(e); } }
  await refreshHome();
  toast('Removed the local copies.', 'ok', 5000, kept.length ? { label: 'Undo', fn: async () => { for (const rec of kept) { try { await store.local.put(rec); } catch (e) { console.error(e); } } toast('Local copies restored.', 'ok'); await refreshHome(); } } : null);
}

/** Quiet refresh: no spinner, no toast, and the page is only touched when something changed. */
async function softRefresh() {
  if (!root || root.hidden || document.hidden || refreshing || moving || dragId) return;
  if (document.querySelector('dialog[open]')) return;
  refreshing = true;
  try {
    const next = await store.listDesigns();
    if (JSON.stringify(next) !== JSON.stringify(metas)) {
      const ae = document.activeElement, art = ae && listEl.contains(ae) ? ae.closest('article') : null;
      const at = art ? { id: art.dataset.id, i: [...art.querySelectorAll('button')].indexOf(ae) } : null;
      metas = next; render();
      if (at) { const b = listEl.querySelector(`article[data-id="${CSS.escape(at.id)}"]`)?.querySelectorAll('button')[at.i]; b?.focus(); }
    }
    if (badgeEl?.dataset.state === 'bad') checkStatus(false);
  } catch (e) { setBadge('bad', 'cannot reach the server right now'); checkStatus(false); }
  finally { refreshing = false; }
}
let started = false;
function startSharedRefresh() {
  if (started) return; started = true;
  setInterval(() => { softRefresh(); if (++tick % 3 === 0 && !root.hidden && !document.hidden) checkStatus(false); }, 20000);
  window.addEventListener('focus', softRefresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) softRefresh(); });
}
