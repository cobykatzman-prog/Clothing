// Threadform - whole-library backup: every design (document, metadata and images) in ONE JSON file, and a safe restore.
// Pure data functions (no DOM) so they are unit-tested in Node; the Home page wires them to buttons (home.js).
//
// File format (version 1):
//   { format: 'threadform-backup', version: 1, exportedAt: ISO string, count, designs: [ { id, meta, doc, assets: { key: 'data:image/..;base64,..' } } ] }
//
// Restore never overwrites anything: a design whose id already exists in the library is restored as a NEW design named "... (restored)".
// A restore that fails half way leaves the designs that were already restored and reports exactly which ones were not.

export const BACKUP_FORMAT = 'threadform-backup', BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 400 * 1024 * 1024, MAX_BACKUP_DESIGNS = 500;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/, IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]*$/;
// meta fields that belong to the server / the person who saved, not to the design itself
const META_DROP = ['rev', 'role', 'members', 'updatedBy', 'owner', 'backupBaseRev', 'sharedCopy'];

export class BackupError extends Error { constructor(message) { super(message); this.name = 'BackupError'; this.user = true; } }

const blobToDataURL = async b => {
  if (typeof b === 'string') return b;
  const u = new Uint8Array(await b.arrayBuffer()); let bin = '';
  for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode(...u.subarray(i, i + 8192));
  return `data:${b.type || 'image/png'};base64,${btoa(bin)}`;
};

/** One design record ({id, meta, doc, assets: {key: Blob|dataURL}}) -> the JSON-safe entry of a backup. */
export async function entryFromRecord(rec) {
  const assets = {};
  for (const [k, v] of Object.entries(rec.assets || {})) if (v != null) assets[k] = await blobToDataURL(v);
  const meta = { ...(rec.meta || {}) }; for (const k of META_DROP) delete meta[k];
  return { id: rec.id, meta, doc: rec.doc || {}, assets };
}

/** Builds the backup file text for the given records, in order. */
export async function buildBackup(records, now = new Date()) {
  const parts = [];
  for (const rec of records) parts.push(JSON.stringify(await entryFromRecord(rec)));
  return `{"format":"${BACKUP_FORMAT}","version":${BACKUP_VERSION},"exportedAt":${JSON.stringify(now.toISOString())},"count":${parts.length},"designs":[\n${parts.join(',\n')}\n]}`;
}

/** Backup file text -> { designs: [entry], skipped: [{ id, reason }] }. Throws BackupError (friendly text) when the file is not a usable backup. */
export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) throw new BackupError('That file is empty.');
  if (text.length > MAX_BACKUP_BYTES) throw new BackupError('That backup is larger than 400 MB, which is more than Threadform can restore in one go.');
  let data;
  try { data = JSON.parse(text); } catch { throw new BackupError('That file is not a Threadform backup (it is not valid JSON).'); }
  if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) throw new BackupError('That file is not a Threadform backup.');
  if (!Number.isInteger(data.version) || data.version < 1) throw new BackupError('That backup has no version number, so it cannot be restored safely.');
  if (data.version > BACKUP_VERSION) throw new BackupError('That backup was made by a newer version of Threadform. Update the site, then try again.');
  if (!Array.isArray(data.designs)) throw new BackupError('That backup has no designs in it.');
  if (data.designs.length > MAX_BACKUP_DESIGNS) throw new BackupError(`That backup holds ${data.designs.length} designs; the limit is ${MAX_BACKUP_DESIGNS} per file.`);
  const designs = [], skipped = [], seen = new Set();
  data.designs.forEach((d, i) => {
    const label = d && typeof d.id === 'string' ? d.id : '#' + (i + 1);
    if (!d || typeof d !== 'object') return skipped.push({ id: label, reason: 'not a design' });
    if (typeof d.id !== 'string' || !ID_RE.test(d.id)) return skipped.push({ id: label, reason: 'it has no valid id' });
    if (seen.has(d.id)) return skipped.push({ id: label, reason: 'it appears twice in the file' });
    if (!d.doc || typeof d.doc !== 'object' || Array.isArray(d.doc)) return skipped.push({ id: label, reason: 'it has no design document' });
    const assets = {};
    for (const [k, v] of Object.entries(d.assets && typeof d.assets === 'object' ? d.assets : {})) {
      if (typeof v !== 'string' || !IMG_RE.test(v)) return skipped.push({ id: label, reason: 'one of its images is not a PNG, JPEG, WebP or GIF picture' });
      assets[k] = v;
    }
    seen.add(d.id);
    const meta = d.meta && typeof d.meta === 'object' && !Array.isArray(d.meta) ? { ...d.meta } : {};
    for (const k of META_DROP) delete meta[k];
    designs.push({ id: d.id, meta, doc: d.doc, assets });
  });
  return { designs, skipped };
}

/** Decides ids/names so nothing existing is overwritten. Returns records ready for putDesign. */
export function planRestore(entries, existingIds, newId, now = Date.now()) {
  const taken = new Set(existingIds);
  return entries.map(e => {
    const clash = taken.has(e.id);
    const id = clash ? newId() : e.id;
    taken.add(id);
    const base = String(e.meta.name || e.doc.name || 'Untitled design').slice(0, 100);
    const name = clash ? base + ' (restored)' : base;
    return {
      renamed: clash, rec: {
        id, assets: e.assets,
        meta: { ...e.meta, id, name, createdAt: clash ? now : (e.meta.createdAt || now), updatedAt: e.meta.updatedAt || now },
        doc: { ...e.doc, name, ...(clash ? { createdAt: now } : {}) }
      }
    };
  });
}

/**
 * Restores entries through `store` ({ listDesigns, putDesign, newId }). Sequential on purpose (gentle on the shared library).
 * Returns { restored: n, renamed: n, failed: [{ name, message }] }. onProgress(done, total).
 */
export async function restoreEntries(store, entries, onProgress = () => { }) {
  const existing = (await store.listDesigns()).map(m => m.id);
  const plan = planRestore(entries, existing, store.newId);
  const out = { restored: 0, renamed: 0, failed: [] };
  for (let i = 0; i < plan.length; i++) {
    const { rec, renamed } = plan[i];
    try { await store.putDesign(rec); out.restored++; if (renamed) out.renamed++; }
    catch (e) { out.failed.push({ name: rec.meta.name, message: (e && e.message) || 'could not be saved' }); }
    onProgress(i + 1, plan.length);
  }
  return out;
}

/** Reads every design through `store` ({ listDesigns, getDesign }) -> { text, count, missing: [name] }. A design that cannot be read is listed, not silently dropped. */
export async function exportAll(store, onProgress = () => { }) {
  const metas = await store.listDesigns(), recs = [], missing = [];
  for (let i = 0; i < metas.length; i++) {
    try { const r = await store.getDesign(metas[i].id); if (r) recs.push(r); else missing.push(metas[i].name || metas[i].id); }
    catch { missing.push(metas[i].name || metas[i].id); }
    onProgress(i + 1, metas.length);
  }
  return { text: await buildBackup(recs), count: recs.length, missing };
}

export const backupFileName = (now = new Date()) => `threadform-backup-${now.toISOString().slice(0, 10)}.json`;
