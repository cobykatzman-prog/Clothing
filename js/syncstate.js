// Sync status (owner: sync). One small store that every saver reports into, so the UI can always say what is going on:
// saved | saving | offline | conflict | error. No DOM here: it is shared by the editor save indicator and the Brand Kit,
// and it is unit tested in Node. Precedence when several sources report: conflict > error > offline > saving > saved.
const ORDER = ['conflict', 'error', 'offline', 'saving', 'saved'];

export const SYNC_LABELS = {
  saved: 'Saved', saving: 'Saving...', offline: 'Offline: will retry', conflict: 'Conflict: needs your choice', error: 'Not saved',
};

export function createSyncState() {
  const sources = new Map();   // source -> { kind, pending, detail, at }
  const subs = new Set();
  const view = () => {
    let kind = 'saved', pending = 0, detail = '', at = 0;
    for (const s of sources.values()) {
      pending += s.pending || 0;
      if (ORDER.indexOf(s.kind) < ORDER.indexOf(kind)) { kind = s.kind; detail = s.detail || ''; }
      if (s.at > at) at = s.at;
    }
    return { kind, pending, detail, at, label: label(kind, pending) };
  };
  const label = (kind, pending) => SYNC_LABELS[kind] + (pending > 0 && kind !== 'saved' ? ` (${pending} waiting)` : '');
  const emit = () => { const v = view(); subs.forEach(fn => { try { fn(v); } catch (e) { console.error(e); } }); };
  return {
    /** kind: saved | saving | offline | conflict | error. pending = number of edits still queued by this source. */
    set(source, kind, { pending = 0, detail = '' } = {}) {
      if (!SYNC_LABELS[kind]) throw new Error('unknown sync state ' + kind);
      const prev = sources.get(source);
      sources.set(source, { kind, pending, detail, at: kind === 'saved' ? Date.now() : (prev ? prev.at : 0) });
      emit();
    },
    clear(source) { if (sources.delete(source)) emit(); },
    get: view,
    /** the raw state one source reported, or null */
    source(name) { const s = sources.get(name); return s ? { kind: s.kind, pending: s.pending, detail: s.detail } : null; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
export const syncState = createSyncState();

/** retry delay in ms for attempt n (0-based): 2 s, 4 s, ... capped at 30 s, with a little jitter so tabs do not retry in lockstep */
export const backoff = (n, rnd = Math.random) => Math.round(Math.min(30000, 2000 * 2 ** n) * (0.85 + rnd() * 0.3));
