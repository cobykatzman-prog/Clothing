// Threadform bootstrap (owner: shell; routing + autosave wiring: home/gallery).
// Routes: #/ = home gallery, #/design/<id> = studio.
import { initTooltips, h, icon, thumbOf, debounce, toast, friendly } from './util.js';
import { initHeader } from './ui-header.js';
import { initLeft } from './ui-left.js';
import { initStage } from './ui-stage.js';
import { initRight, revealSection } from './ui-right.js';
import { initMode, initGuide, maybeStartTour, getMode } from './ui-guide.js';
import { initBottom } from './ui-bottom.js';
import { busy } from './ui-actions.js';
import { state, subscribe, serializeDesign, hydrateDesign, notify, VIEWS } from './state.js';
import * as store from './storage.js';
import * as R from './remote.js';
import { initHome, refreshHome } from './home.js';
import { aiStatus } from './ai.js';
import * as sel from './selection.js';
import { showBanner, hideBanner, bannerShown, lastEditedLine } from './sync.js';
import { syncState } from './syncstate.js';
import { identity, openHistoryDialog, openSharingDialog, kitStatusChip } from './workspace-ui.js';

const $ = id => document.getElementById(id);
initTooltips();
aiStatus();   // which AI engine (if any) the server offers; plain static hosting makes no request
initMode();   // Basic (default) or Advanced, remembered in this browser
initHeader($('header'));
initLeft($('left'));
initStage($('centre'));
initRight($('right'));
initBottom($('bottom'));
initGuide($('header'));   // Basic / Advanced toggle, "?" help, tour, keyboard shortcuts
/** Shows a section wherever it lives (right-panel tab or left panel). False when hidden by Basic mode. */
function reveal(id) {
  if (revealSection(id)) return true;
  const sec = document.getElementById(id);
  if (!sec || (sec.dataset.level === 'advanced' && getMode() !== 'advanced')) return false;
  if (sec.tagName === 'DETAILS') sec.open = true;
  return true;
}
window.__threadform = { state, reveal, sel };   // handy for debugging / tests

const app = document.querySelector('.app'), home = $('home'), header = $('header');

// ---- header additions: Home link and save indicator ----
const brand = header.querySelector('.brand');
if (brand) { brand.style.cursor = 'pointer'; brand.title = 'Back to all your designs'; brand.addEventListener('click', () => { location.hash = '#/'; }); }
brand?.after(h('a', { class: 'btn ghost sm home-btn', href: '#/', 'aria-label': 'Home: all your designs', tip: 'Back to all your designs' }, icon('layers', 16), h('span', { class: 'home-lbl' }, 'Home')));
const saveStatus = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
header.querySelector('.head-right')?.prepend(saveStatus);
const SHARED = store.shared();   // shared library mode: designs live on the server and are the same for everyone with the password
const lastEdited = lastEditedLine();
const me = identity();
if (SHARED) {
  header.querySelector('input.name')?.after(lastEdited.el);
  const historyBtn = h('button', { type: 'button', class: 'btn ghost sm', tip: 'Earlier saved versions of this design, and restore', onclick: () => openHistory() }, 'History');
  const shareBtn = h('button', { type: 'button', class: 'btn ghost sm', hidden: !me?.multi, tip: 'Choose who can edit or only view this design', onclick: () => openSharing() }, 'Share');
  const roleChip = h('span', { class: 'role-chip', hidden: true });
  lastEdited.el.after(historyBtn, shareBtn, roleChip, kitStatusChip());
  window.__tfWorkspace = { shareBtn, roleChip };
}
header.addEventListener('input', e => { if (e.target.classList?.contains('name')) markDirty(); });   // header rename

// ---- state of the open design ----
let currentId = null, loaded = false, loading = false, dirty = false, createdAt = 0, nav = 0;
let queue = Promise.resolve(), lastStatus = '';
let saving = false, conflict = null, readOnly = false, myRole = 'owner';   // conflict: null | 'changed' | 'deleted' (shared mode: waiting for the user's choice)
const unsynced = new Map();            // id -> record that could not reach the shared library yet (retried with backoff)
let retryTimer = 0, retryN = 0;
const NON_CONTENT = new Set(['render', 'zoom', 'processing', 'busy', 'compare', 'review', 'tool', 'view', 'selection', 'history', 'mode', 'tab', 'part', 'refine']);

function setStatus(kind, t) {
  lastStatus = kind;
  const text = (SHARED ? {
    pending: 'Unsaved changes', saving: 'Saving...', full: 'Not saved: storage full', error: 'Not saved',
    saved: 'Saved to shared library', offline: 'Not saved (offline): will retry' + (unsynced.size > 1 ? ` (${unsynced.size} designs waiting)` : ''), conflict: 'Not saved: someone else changed this design',
    viewonly: 'View only: changes are not saved',
  } : {
    pending: 'Unsaved changes', saving: 'Saving…', full: 'Not saved: storage full', error: 'Not saved',
    saved: 'Saved',
  })[kind] || '';
  saveStatus.textContent = text;
  saveStatus.title = text + (t ? ' (last saved ' + new Date(t).toLocaleString() + ')' : '');   // full text even when the label is cut short
  saveStatus.dataset.kind = kind;
  if (SHARED) {
    const map = { pending: 'saving', saving: 'saving', saved: 'saved', viewonly: 'saved', offline: 'offline', conflict: 'conflict', error: 'error', full: 'error' };
    syncState.set('design', map[kind] || 'saved', { pending: unsynced.size, detail: text });
  }
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

/** Builds the record to store for the open design. */
async function buildRecord(id) {
  const thumb = pickThumb(), views = VIEWS.filter(n => state.views[n].base).length, kind = garmentKindLabel();
  const { doc, assets } = await serializeDesign();
  const now = Date.now(), name = state.name || 'Untitled design';
  doc.name = name; doc.createdAt = createdAt; doc.updatedAt = now;
  return { now, rec: { id, meta: { id, name, createdAt, updatedAt: now, thumb, views, kind }, doc, assets } };
}

async function doSave() {
  if (!dirty || !currentId || loading || readOnly) return;
  if (conflict) return;   // shared mode: waiting for "Load their version" or "Keep mine"
  dirty = false;
  const id = currentId;
  setStatus('saving');
  saving = true;
  let rec = null;
  try {
    const built = await buildRecord(id);
    rec = built.rec;
    unsynced.delete(id);
    const res = await store.putDesign(rec);
    if (SHARED) { store.dropBackup(id); retryN = 0; lastEdited.set(res?.updatedAt || built.now, res?.updatedBy || me?.name); }
    setStatus('saved', built.now);
  } catch (e) {
    dirty = true;   // the next change retries
    (SHARED && e.kind ? console.warn : console.error)('Could not save design', e);
    if (SHARED && e.kind) return sharedSaveFailed(e, id, rec);
    const kind = e.quota ? 'full' : 'error', prev = lastStatus;
    setStatus(kind);
    if (prev !== kind) toast(e.quota
      ? 'Browser storage is full, so this design was not saved. Delete a design or old versions to free space.'
      : 'Could not save this design. Your latest changes may be lost.', 'error', 6000);
  } finally { saving = false; }
}
/** Runs after any queued save; saves are strictly sequential. */
const flushSave = () => (queue = queue.then(doSave, doSave));
const scheduleSave = debounce(() => flushSave(), 900);
function markDirty() {
  if (!currentId || loading || readOnly) return;
  dirty = true;
  if (conflict) return;   // the banner is waiting for a decision; nothing is saved over their version meanwhile
  setStatus('pending'); scheduleSave();
}
subscribe(r => { if (!NON_CONTENT.has(r)) markDirty(); });

// ---- shared library: failures, retry, conflicts, live sync ----
const copyName = n => String(n || 'Untitled design').replace(/ \(my version\)$/, '').slice(0, 100) + ' (my version)';

function sharedSaveFailed(e, id, rec) {
  if (e.kind === 'forbidden') {   // the role changed to view-only while this was open: keep the work as a copy offer
    dirty = false; enterReadOnly('viewer');
    return;
  }
  if (e.kind === 'conflict' || e.kind === 'notfound') {
    if (rec) store.backupLocally(rec, store.revOf(id)).catch(() => { });
    return showConflict(e.kind === 'notfound' ? 'deleted' : 'changed', e.by);
  }
  const prev = lastStatus;
  if (e.transient) {
    if (rec) { unsynced.set(id, rec); store.backupLocally(rec, store.revOf(id)).catch(() => { }); }   // nothing is lost if the tab closes
    setStatus('offline');
    if (prev !== 'offline') toast('Could not reach the shared library. Your changes are kept on this device and will be saved when it is back.', 'error', 6000);
    scheduleRetry();
    return;
  }
  setStatus('error');
  if (prev !== 'error') toast(e.message || 'Could not save this design. Your latest changes may be lost.', 'error', 6000);
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  const wait = Math.min(30000, 2000 * 2 ** retryN++);
  retryTimer = setTimeout(retryUnsynced, wait);
}
async function retryUnsynced() {
  if (currentId && dirty && !conflict && !saving) await flushSave();   // the open design re-reads the editor state
  for (const [id, rec] of [...unsynced]) {
    if (id === currentId && dirty) continue;
    try { await store.putDesign(rec); unsynced.delete(id); store.dropBackup(id); if (id === currentId) { setStatus('saved', rec.meta.updatedAt); lastEdited.set(rec.meta.updatedAt); } }
    catch (e) {
      if (e.kind === 'conflict' || e.kind === 'notfound') { unsynced.delete(id); await saveRecordAsCopy(rec); }   // somebody else saved first: keep this work as its own design
      else if (!e.transient) unsynced.delete(id);
    }
  }
  if (unsynced.size || (dirty && currentId)) scheduleRetry(); else retryN = 0;
}
/** Stores a record as a brand-new design "<name> (my version)" so nothing is lost. Returns the new id. */
async function saveRecordAsCopy(rec) {
  const id = store.newId(), now = Date.now(), name = copyName(rec.meta?.name || rec.doc?.name);
  const copy = { id, meta: { ...rec.meta, id, name, createdAt: now, updatedAt: now, order: undefined }, doc: { ...rec.doc, name, createdAt: now, updatedAt: now }, assets: rec.assets };
  try { await store.putDesign(copy); store.dropBackup(rec.id); }
  catch (e) { await store.backupLocally(copy, null); }   // recovered on the next start-up
  toast('Your changes were kept as a new design named “' + name + '”.', 'ok', 6000);
  return id;
}

/** Shows the design as view-only (your role, or a per-design setting, does not let you change it) with a way to keep a private copy. */
function enterReadOnly(role) {
  readOnly = true; myRole = role || 'viewer';
  clearTimeout(retryTimer);
  setStatus('viewonly');
  const w = window.__tfWorkspace; if (w) { w.roleChip.hidden = false; w.roleChip.textContent = 'View only'; }
  showBanner('You can look at this design but not change it. Your changes will not be saved here. Save a copy to work on your own version.', [{ label: 'Save a copy and edit it', primary: true, onclick: () => copyAndEdit() }, { label: 'Dismiss', onclick: () => hideBanner() }]);
}
async function copyAndEdit() {
  const id = currentId; if (!id) return;
  try {
    const { rec } = await buildRecord(id);
    const name = String(rec.meta.name || 'Untitled design').slice(0, 100) + ' (my copy)', nid = store.newId(), now = Date.now();
    await store.putDesign({ id: nid, meta: { ...rec.meta, id: nid, name, createdAt: now, updatedAt: now, order: undefined }, doc: { ...rec.doc, name, createdAt: now, updatedAt: now }, assets: rec.assets });
    readOnly = false; myRole = 'owner'; hideBanner();
    const w = window.__tfWorkspace; if (w) w.roleChip.hidden = true;
    location.hash = '#/design/' + nid;
    toast('Saved as "' + name + '". You can edit this copy.', 'ok', 5000);
  } catch (e) { toast(friendly(e, 'Could not save a copy right now. Try again in a moment.'), 'error', 5000); }
}
async function openHistory() {
  const id = currentId; if (!id || !loaded) return;
  await flushSave();   // what you see now becomes the newest saved version first
  openHistoryDialog({ id, canRestore: !readOnly && myRole !== 'viewer', onRestore: async rev => { await store.restoreVersion(id, rev); await reloadRemote(false); toast('Restored version ' + rev + '.', 'ok'); } });
}
function openSharing() { if (currentId && loaded) openSharingDialog({ id: currentId }); }

function showConflict(kind, by) {
  conflict = kind;
  clearTimeout(retryTimer);
  setStatus('conflict');
  const keep = { label: 'Keep mine (save as a copy)', onclick: () => keepMine() };
  if (kind === 'deleted') {
    showBanner('This design was deleted from the shared library by someone else. You can keep your version as a new design.', [{ ...keep, primary: true }, { label: 'Go to all designs', onclick: () => { conflict = null; dirty = false; hideBanner(); location.hash = '#/'; } }]);
  } else {
    showBanner((by && by !== me?.name ? by : 'Someone') + ' changed this design while you were editing it. Their version has not been loaded, so nothing of yours was overwritten.', [{ label: 'Load their version', primary: true, onclick: () => loadTheirs() }, keep]);
  }
}
async function loadTheirs() {
  const id = currentId;
  try { await reloadRemote(false); }
  catch (e) { toast(friendly(e, 'Could not load their version. Check your connection and try again.'), 'error', 5000); return; }
  if (id === currentId && !conflict) toast('Loaded their version.', 'ok');
}
async function keepMine() {
  const id = currentId; if (!id) return;
  try {
    const { rec } = await buildRecord(id);
    const newId = await saveRecordAsCopy(rec);
    unsynced.delete(id); store.dropBackup(id);
    // continue editing the copy
    currentId = newId; createdAt = Date.now(); state.name = copyName(rec.meta.name); notify('name');
    conflict = null; dirty = false; hideBanner();
    history.replaceState(null, '', '#/design/' + newId);
    setStatus('saved', Date.now());
  } catch (e) { console.error(e); toast('Could not save a copy right now. Your work is still open here; try again in a moment.', 'error', 6000); }
}
/** Replaces the open design with the shared library's version. quiet: keep the current view and zoom, and only if there is nothing unsaved. */
async function reloadRemote(quiet) {
  const my = nav, id = currentId;
  const rec = await store.getDesign(id);
  if (my !== nav || id !== currentId) return;
  if (!rec) { dirty ? showConflict('deleted') : (toast('This design was deleted from the shared library by someone else.', 'error', 5000), location.hash = '#/'); return; }
  if (quiet && (dirty || saving)) { showConflict('changed'); return; }
  const prevView = state.activeView;
  loading = true;
  try {
    await hydrateDesign(rec.doc || {}, rec.assets || {});
    if (quiet && VIEWS.includes(prevView)) { state.activeView = prevView; notify('view'); }
    createdAt = rec.meta?.createdAt || rec.doc?.createdAt || createdAt;
  } finally { loading = false; dirty = false; }
  conflict = null; unsynced.delete(id); store.dropBackup(id); hideBanner();
  setStatus('saved', rec.meta?.updatedAt); lastEdited.set(rec.meta?.updatedAt, rec.meta?.updatedBy);
}
let polling = false;
async function pollRev() {
  if (!SHARED || polling || document.hidden || !currentId || !loaded || loading || saving || conflict) return;
  const id = currentId, known = store.revOf(id);
  if (known == null) return;   // never saved yet: nothing to compare with
  polling = true;
  try {
    const r = await R.rev(id);
    if (id !== currentId || saving || conflict || loading) return;
    lastEdited.set(R.toMs(r.updatedAt) || undefined, r.updatedBy);
    if (r.rev > (store.revOf(id) ?? known)) {
      if (dirty) showConflict('changed', r.updatedBy);
      else { await reloadRemote(true); if (!conflict && id === currentId) toast('Updated with changes from ' + (r.updatedBy && r.updatedBy !== me?.name ? r.updatedBy : 'someone else'), 'ok', 4000); }
    }
  } catch (e) {
    if (e.kind === 'notfound' && id === currentId) { dirty ? showConflict('deleted') : (toast('This design was deleted from the shared library by someone else.', 'error', 5000), location.hash = '#/'); }
    /* offline or busy: try again next time */
  } finally { polling = false; }
}
if (SHARED) {
  setInterval(pollRev, 8000);
  window.addEventListener('online', () => { retryN = 0; clearTimeout(retryTimer); if (unsynced.size || dirty) retryUnsynced(); pollRev(); });   // back online: send what was queued now
  window.addEventListener('offline', () => { if (currentId && (dirty || unsynced.size)) setStatus('offline'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRev(); });
}
/** Changes that could not be saved earlier (offline, or a crash): put them back, or keep them as a copy if someone else saved first. */
async function recoverBackups() {
  if (!SHARED) return;
  try {
    const all = (await store.local.list()).filter(m => 'backupBaseRev' in m);
    for (const m of all) {
      if (m.id === currentId || unsynced.has(m.id)) continue;
      const rec = await store.local.get(m.id); if (!rec) continue;
      const remote = (await store.listDesigns()).find(d => d.id === m.id);
      if (remote && m.backupBaseRev != null && remote.rev === m.backupBaseRev) { store.setRev(m.id, remote.rev); await store.putDesign(rec); store.dropBackup(m.id); toast('Restored changes that had not been saved.', 'ok', 5000); }
      else if (!remote && m.backupBaseRev == null) { await store.putDesign(rec); store.dropBackup(m.id); }
      else await saveRecordAsCopy(rec);
    }
  } catch (e) { /* offline: the backups stay and are tried again later */ }
}

// ---- views ----
function showStudio() {
  home.hidden = true; app.hidden = false; document.body.classList.remove('view-home');
  maybeStartTour();   // first visit only
}
async function goHome() {
  const my = ++nav;
  if (SHARED && conflict && currentId) await keepMine();   // leaving with an unresolved conflict: keep their work as a copy
  await flushSave();
  if (my !== nav) return;
  currentId = null; loaded = false; dirty = false; conflict = null; readOnly = false; hideBanner(); lastEdited.clear();
  app.hidden = true; home.hidden = false; document.body.classList.add('view-home');
  await refreshHome();
}
async function openDesign(id) {
  const my = ++nav;
  if (currentId === id && loaded) { showStudio(); return; }
  if (SHARED && conflict && currentId) await keepMine();
  await flushSave();
  if (my !== nav) return;
  conflict = null; hideBanner(); readOnly = false; myRole = 'owner';
  { const w = window.__tfWorkspace; if (w) w.roleChip.hidden = true; }
  showStudio();   // visible before hydrating so the canvas gets its size
  let rec = null;
  const done0 = SHARED ? busy('Opening design…') : null;   // downloading from the shared library can take a moment
  try { rec = (SHARED && unsynced.get(id)) || await store.getDesign(id); } catch (e) { toast(friendly(e, 'That design could not be opened. Reload the page to try again.'), 'error', 5000); }
  finally { done0?.(); }
  if (my !== nav) return;
  if (!rec) {
    toast('That design could not be found, so you are back on the home page. Open another design or start a new one.', 'error', 5000);
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
    toast('This design could not be opened. Try again, or start a new design from the home page.', 'error', 5000);
    currentId = null; loaded = false;
    return goHome();
  } finally { loading = false; dirty = !!(SHARED && unsynced.has(id)); done(); }
  if (SHARED && unsynced.has(id)) { setStatus('offline'); scheduleRetry(); }
  else setStatus('saved', rec.meta?.updatedAt);
  if (SHARED) {
    lastEdited.set(rec.meta?.updatedAt, rec.meta?.updatedBy);
    myRole = rec.role || rec.meta?.role || 'owner';
    const w = window.__tfWorkspace;
    if (w) { w.shareBtn.hidden = !(me?.multi && myRole === 'owner'); w.roleChip.hidden = true; }
    if (myRole === 'viewer') enterReadOnly('viewer');
  }
}
/** Creates a blank design, opens it, then runs `action` (e.g. load a sample) on it. */
async function newDesign(action) {
  if (SHARED && me?.role === 'viewer') { toast('Your login is view-only, so you cannot create designs. Ask an owner to change your role.', 'error', 5000); return; }
  const my = ++nav;
  readOnly = false; myRole = 'owner';
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
    catch (e) { console.error(e); toast(friendly(e, 'That did not work. Try again, or pick a sample to start.'), 'error', 5000); }
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
  unsavedCount: () => unsynced.size,
  recover: recoverBackups,
});

// Safety-net autosave: flush any pending edits at least once per minute.
// Normal edits are still saved sooner by the debounced save above.
setInterval(() => {
  if (dirty && !loading && !conflict) flushSave();
}, 60_000);

// Leaving the page: write any pending change now
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', () => { flushSave(); });
window.addEventListener('hashchange', route);

store.initStorage().finally(() => { route(); recoverBackups(); });
