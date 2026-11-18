// Threadform bootstrap (owner: shell; routing + autosave wiring: home/gallery).
// Routes: #/ = home gallery, #/design/<id> = studio.
import { initTooltips, h, icon, thumbOf, debounce, toast } from './util.js';
import { initHeader } from './ui-header.js';
import { initLeft } from './ui-left.js';
import { initStage } from './ui-stage.js';
import { initRight } from './ui-right.js';
import { initBottom } from './ui-bottom.js';
import { busy } from './ui-actions.js';
import { state, subscribe, serializeDesign, hydrateDesign, VIEWS } from './state.js';
import * as store from './storage.js';
import { initHome, refreshHome } from './home.js';

const $ = id => document.getElementById(id);
initTooltips();
initHeader($('header'));
initLeft($('left'));
initStage($('centre'));
initRight($('right'));
initBottom($('bottom'));
window.__threadform = { state };   // handy for debugging / tests

const app = document.querySelector('.app'), home = $('home'), header = $('header');

// ---- header additions: Home link and save indicator ----
const brand = header.querySelector('.brand');
if (brand) { brand.style.cursor = 'pointer'; brand.title = 'Back to all your designs'; brand.addEventListener('click', () => { location.hash = '#/'; }); }
brand?.after(h('a', { class: 'btn ghost sm home-btn', href: '#/', 'aria-label': 'Home: all your designs', tip: 'Back to all your designs' }, icon('layers', 16), h('span', { class: 'home-lbl' }, 'Home')));
const saveStatus = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
header.querySelector('.head-right')?.prepend(saveStatus);
header.addEventListener('input', e => { if (e.target.classList?.contains('name')) markDirty(); });   // header rename

// ---- state of the open design ----
let currentId = null, loaded = false, loading = false, dirty = false, createdAt = 0, nav = 0;
let queue = Promise.resolve(), lastStatus = '';
const NON_CONTENT = new Set(['render', 'zoom', 'processing', 'busy', 'compare', 'tool', 'view', 'selection', 'history']);

function setStatus(kind, t) {
  lastStatus = kind;
  const text = {
    pending: 'Unsaved changes', saving: 'Saving…', full: 'Not saved: storage full', error: 'Not saved',
    saved: 'Saved',
  }[kind] || '';
  saveStatus.textContent = text;
  saveStatus.title = t ? 'Last saved ' + new Date(t).toLocaleString() : '';
  saveStatus.dataset.kind = kind;
}

const pickThumb = () => {
  const n = VIEWS.find(x => state.views[x].current);
  return n ? thumbOf(state.views[n].current, 240, '#f3f2ef').toDataURL('image/jpeg', 0.82) : '';
};

const KIND_NAMES = { tee: 'T-shirt', longSleeve: 'Long-sleeve top', polo: 'Polo', hoodie: 'Hoodie' };
/** short description of the garment for the home card, e.g. "Hoodie" or "Uploaded photo" */
function garmentKindLabel() {
  const sample = VIEWS.map(n => state.views[n].sample).find(Boolean);
  if (sample?.kind && KIND_NAMES[sample.kind]) return KIND_NAMES[sample.kind];
  return VIEWS.some(n => state.views[n].base) ? 'Uploaded photo' : '';
}

async function doSave() {
  if (!dirty || !currentId || loading) return;
  dirty = false;
  const id = currentId;
  setStatus('saving');
  try {
    const thumb = pickThumb(), views = VIEWS.filter(n => state.views[n].base).length, kind = garmentKindLabel();
    const { doc, assets } = await serializeDesign();
    const now = Date.now(), name = state.name || 'Untitled design';
    doc.name = name; doc.createdAt = createdAt; doc.updatedAt = now;
    await store.putDesign({ id, meta: { id, name, createdAt, updatedAt: now, thumb, views, kind }, doc, assets });
    setStatus('saved', now);
  } catch (e) {
    dirty = true;   // the next change retries
    console.error('Could not save design', e);
    const kind = e.quota ? 'full' : 'error', prev = lastStatus;
    setStatus(kind);
    if (prev !== kind) toast(e.quota
      ? 'Browser storage is full, so this design was not saved. Delete a design or old versions to free space.'
      : 'Could not save this design. Your latest changes may be lost.', 'error', 6000);
  }
}
/** Runs after any queued save; saves are strictly sequential. */
const flushSave = () => (queue = queue.then(doSave, doSave));
const scheduleSave = debounce(() => flushSave(), 900);
function markDirty() {
  if (!currentId || loading) return;
  dirty = true; setStatus('pending'); scheduleSave();
}
subscribe(r => { if (!NON_CONTENT.has(r)) markDirty(); });

// ---- views ----
function showStudio() {
  home.hidden = true; app.hidden = false; document.body.classList.remove('view-home');
}
async function goHome() {
  const my = ++nav;
  await flushSave();
  if (my !== nav) return;
  currentId = null; loaded = false; dirty = false;
  app.hidden = true; home.hidden = false; document.body.classList.add('view-home');
  await refreshHome();
}
async function openDesign(id) {
  const my = ++nav;
  if (currentId === id && loaded) { showStudio(); return; }
  await flushSave();
  if (my !== nav) return;
  showStudio();   // visible before hydrating so the canvas gets its size
  let rec = null;
  try { rec = await store.getDesign(id); } catch (e) { toast(e.message, 'error'); }
  if (my !== nav) return;
  if (!rec) {
    toast('That design could not be found.', 'error');
    history.replaceState(null, '', '#/');
    return goHome();
  }
  const done = busy('Opening design…');
  loading = true;
  try {
    await hydrateDesign(rec.doc || {}, rec.assets || {});
    currentId = id; loaded = true;
    createdAt = rec.meta?.createdAt || rec.doc?.createdAt || Date.now();
  } catch (e) {
    console.error(e);
    toast('This design could not be opened.', 'error');
    currentId = null; loaded = false;
    return goHome();
  } finally { loading = false; dirty = false; done(); }
  setStatus('saved', rec.meta?.updatedAt);
}
/** Creates a blank design, opens it, then runs `action` (e.g. load a sample) on it. */
async function newDesign(action) {
  const my = ++nav;
  await flushSave();
  if (my !== nav) return;
  const id = store.newId();
  loading = true;
  try { await hydrateDesign({}, {}); currentId = id; loaded = true; createdAt = Date.now(); }
  finally { loading = false; dirty = false; }
  showStudio();
  location.hash = '#/design/' + id;     // route sees the same id and just shows the studio
  dirty = true; setStatus('pending');   // saved after the first change, or when leaving the studio
  if (action) {
    try { await action(); }
    catch (e) { console.error(e); toast('Something went wrong: ' + e.message, 'error'); }
  }
  markDirty();
}

function route() {
  const m = location.hash.match(/^#\/design\/([\w-]+)$/);
  return m ? openDesign(m[1]) : goHome();
}

initHome(home, {
  open: id => { location.hash = '#/design/' + id; },
  newDesign,
});

// Leaving the page: write any pending change now
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', () => { flushSave(); });
window.addEventListener('hashchange', route);

store.initStorage().finally(route);
