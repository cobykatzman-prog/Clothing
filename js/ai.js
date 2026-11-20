// Threadform - AI backend client (same origin only). Talks to /api/ai/* (see PLAN.md for the contract).
// The key never reaches the browser. Failures are typed AiError objects with plain-language messages, never raw server text.
import { SIZE, prefs } from './util.js';

const MAX_SIDE = 1024;
const IMAGE_BUDGET = 3.0e6;          // bytes of base64 per image before we fall back to a flattened JPEG
const TIMEOUT_MS = 70000;
const STATUS_TTL = 60000;
const MAX_REFS = 3;

// ---------------------------------------------------------------- errors
const MESSAGES = {
  disabled: 'AI editing is not switched on for this site, so the built-in engine is used.',
  auth: 'Your login has expired. Reload the page and log in again.',
  ratelimit: 'The AI service is busy right now. Wait a moment and try again.',
  localLimit: 'Threadform has reached its AI request limit. Please wait for the cooldown to finish.',
  providerLimit: 'OpenAI is temporarily limiting requests for this API account. Check its usage and billing if this keeps happening.',
  queueBusy: 'Several AI jobs are already running. Wait for one to finish, then try again.',
  toolarge: 'That image is too large to send. Try a smaller image or a simpler selection.',
  upstream: 'The AI service did not answer properly. Try again in a moment.',
  offline: 'Could not reach the server. Check your internet connection and try again.',
  aborted: 'Cancelled.',
  bad: 'The AI service could not use that request. Try different wording or a smaller selection.',
};
export class AiError extends Error {
  /** kind: disabled | auth | ratelimit | toolarge | upstream | offline | aborted | bad */
  constructor(kind, { status = 0, retryAfter = 0, message = null } = {}) {
    super(message || MESSAGES[kind] || MESSAGES.bad);
    this.name = 'AiError'; this.kind = kind; this.status = status; this.retryAfter = retryAfter; this.user = true;
  }
  /** worth offering "Try again" (the same request may work shortly) */
  get retryable() { return this.kind === 'ratelimit' || this.kind === 'upstream' || this.kind === 'offline'; }
}
export const isAiError = e => e instanceof AiError;

// ---------------------------------------------------------------- status
let status = null;                    // last answer from /api/ai/status (or null = not asked yet)
let statusAt = 0, inflight = null;
const listeners = new Set();
const metaOn = () => typeof document !== 'undefined' && !!document.querySelector('meta[name="threadform-ai"][content="1"]');
const hasServer = () => typeof document !== 'undefined' && !!document.querySelector('meta[name="threadform-ai"], meta[name="threadform-auth"], meta[name="threadform-shared"]');
const DISABLED = { enabled: false, provider: 'local', imageModel: '', visionModel: '', quality: '' };

/** Subscribe to engine changes (status arrives, toggle flips). Returns an unsubscribe function. */
export function onAiChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });

/** Synchronous: does the server offer AI? Uses the last status, else the page's meta tag. */
export function aiEnabled() { return status ? !!status.enabled : metaOn(); }
/** Synchronous: the last known status (never null). */
export function aiInfo() { return status || { ...DISABLED, enabled: metaOn(), provider: metaOn() ? 'openai' : 'local' }; }

/** Is the person's "Use AI" switch on? Default ON, remembered in this browser. */
export function toggleOn() { return prefs.get('ai.use', '1') !== '0'; }
export function setUseAi(on) { prefs.set('ai.use', on ? '1' : '0'); emit(); }
/** True when AI is enabled on the server AND the person has it switched on. Later phases gate on this. */
export function useAi() { return aiEnabled() && toggleOn(); }

/**
 * Asks the server what AI it offers. Cached for 60 s. Plain static hosting (no server meta) never makes a request.
 * @returns {Promise<{enabled:boolean, provider:string, imageModel:string, visionModel:string, quality:string}>}
 */
export async function aiStatus({ fresh = false } = {}) {
  if (!fresh && status && Date.now() - statusAt < STATUS_TTL) return status;
  if (!hasServer()) { status = { ...DISABLED }; statusAt = Date.now(); emit(); return status; }
  if (inflight) return inflight;
  inflight = (async () => {
    let next;
    try {
      const r = await rawFetch('/api/ai/status', { method: 'GET' }, 8000);
      const j = r.ok ? await readJson(r) : null;
      if (j && typeof j === 'object' && 'enabled' in j) {
        next = { enabled: !!j.enabled, provider: str(j.provider) || (j.enabled ? 'openai' : 'local'), imageModel: str(j.imageModel), visionModel: str(j.visionModel), quality: str(j.quality) };
      } else next = { ...DISABLED, enabled: metaOn(), provider: metaOn() ? 'openai' : 'local' };   // answer unreadable: trust the meta tag
    } catch (_) { next = { ...DISABLED, enabled: metaOn(), provider: metaOn() ? 'openai' : 'local' }; }
    const changed = !status || JSON.stringify(status) !== JSON.stringify(next);
    status = next; statusAt = Date.now(); inflight = null;
    if (changed) emit();
    return status;
  })();
  return inflight;
}
const str = v => (typeof v === 'string' ? v.slice(0, 60) : '');
export function resetAiStatus() { status = null; statusAt = 0; }

// ---------------------------------------------------------------- transport
function rawFetch(url, init, timeoutMs, outer) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  return fetch(url, { ...init, signal: ctl.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'follow' })
    .catch(e => {
      if (outer && outer.aborted) throw new AiError('aborted');
      if (timedOut) throw new AiError('upstream', { message: 'The AI service took too long to answer. Try again in a moment.' });
      throw new AiError('offline', { message: null, status: 0, cause: e });
    })
    .finally(() => { clearTimeout(timer); if (outer) outer.removeEventListener('abort', onAbort); });
}
async function readJson(res) {
  const ct = res.headers.get('content-type') || '';
  if (!/json/i.test(ct)) throw new AiError('auth');   // a login page instead of JSON: the session ended
  return res.json();
}

async function post(path, body, { signal, timeout = TIMEOUT_MS } = {}) {
  if (signal && signal.aborted) throw new AiError('aborted');
  const res = await rawFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeout, signal);
  if (res.ok) {
    try { return await readJson(res); }
    catch (e) { if (e instanceof AiError) throw e; if (signal && signal.aborted) throw new AiError('aborted'); throw new AiError('upstream'); }
  }
  let code = '';
  try { const j = await res.clone().json(); code = String(j?.error?.code || '').toLowerCase(); } catch (_) { /* body is never shown */ }
  const s = res.status;
  if (code === 'disabled' || code === 'ai_disabled' || code === 'not_configured') throw new AiError('disabled', { status: s });
  if (s === 401 || s === 403 || s === 303) throw new AiError('auth', { status: s });
  if (s === 413) throw new AiError('toolarge', { status: s });
  if (s === 429) {
    const ra = Number(res.headers.get('retry-after'));
    const retryAfter = ra > 0 && ra < 86400 ? Math.ceil(ra) : 30;
    const message = code === 'rate_limited' ? MESSAGES.localLimit
      : code === 'ai_provider_busy' ? MESSAGES.providerLimit
      : code === 'busy' ? MESSAGES.queueBusy
      : MESSAGES.ratelimit;
    throw new AiError('ratelimit', { status: s, retryAfter, message });
  }
  if (s === 404) throw new AiError('disabled', { status: s });
  if (s === 400 || s === 422) throw new AiError('bad', { status: s });
  throw new AiError('upstream', { status: s });
}

// ---------------------------------------------------------------- encoding
function scaled(src, w, h, flatten) {
  if (src.width === w && src.height === h && !flatten) return src;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  if (flatten) { g.fillStyle = flatten; g.fillRect(0, 0, w, h); }
  g.drawImage(src, 0, 0, w, h);
  return c;
}
function fitSize(c, side = MAX_SIDE) {
  const s = Math.min(1, side / Math.max(c.width, c.height));
  return [Math.max(1, Math.round(c.width * s)), Math.max(1, Math.round(c.height * s))];
}
const bytesOf = url => Math.floor((url.length - url.indexOf(',') - 1) * 0.75);

/** Image canvas -> data URL, at most 1024 px. PNG (keeps transparency); a flattened JPEG when the PNG would be too heavy. */
export function encodeImage(canvas) {
  const [w, h] = fitSize(canvas);
  const c = scaled(canvas, w, h);
  const png = c.toDataURL('image/png');
  if (bytesOf(png) <= IMAGE_BUDGET) return png;
  for (const q of [0.9, 0.8, 0.7]) {
    const jpg = scaled(canvas, w, h, '#ffffff').toDataURL('image/jpeg', q);
    if (bytesOf(jpg) <= IMAGE_BUDGET) return jpg;
  }
  const [w2, h2] = fitSize(canvas, 768);
  return scaled(canvas, w2, h2, '#ffffff').toDataURL('image/jpeg', 0.8);
}
/** Mask canvas -> PNG data URL the SAME size as the encoded image (opaque = editable). */
export function encodeMask(mask, image) {
  const [w, h] = fitSize(image);
  return scaled(mask, w, h).toDataURL('image/png');
}
/** Reference images: JPEG on white, at most 3, at most 768 px. */
export function encodeRefs(refs) {
  return (Array.isArray(refs) ? refs : []).filter(Boolean).slice(0, MAX_REFS).map(c => {
    const [w, h] = fitSize(c, 768);
    return scaled(c, w, h, '#ffffff').toDataURL('image/jpeg', 0.85);
  });
}

/** data URL -> canvas. With `size` it is drawn stretched to exactly that size; with `fit` it is centred inside a SIZE x SIZE canvas. */
export function dataUrlToCanvas(url, { size = null, fit = false } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof url !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/i.test(url)) { reject(new AiError('upstream')); return; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const g = () => { const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; return x; };
      if (fit) {
        c.width = c.height = SIZE;
        const s = Math.min(SIZE / img.width, SIZE / img.height);
        g().drawImage(img, (SIZE - img.width * s) / 2, (SIZE - img.height * s) / 2, img.width * s, img.height * s);
      } else if (size) { c.width = size.w; c.height = size.h; g().drawImage(img, 0, 0, size.w, size.h); }
      else { c.width = img.width; c.height = img.height; g().drawImage(img, 0, 0); }
      resolve(c);
    };
    img.onerror = () => reject(new AiError('upstream'));
    img.src = url;
  });
}

const clip = (t, n = 1200) => String(t || '').trim().slice(0, n);
const VIEWS = ['front', 'back', 'side', 'detail'];
const viewOf = v => (VIEWS.includes(v) ? v : 'front');

// ---------------------------------------------------------------- the five routes
/**
 * One edited image (call 1-3 times in parallel for Subtle / Medium / Bold).
 * @returns {Promise<{canvas:HTMLCanvasElement, level:string, model:string, ms:number}>}
 */
export async function aiEdit({ image, mask = null, prompt, constraints = null, refs = [], view = 'front', level = 'medium', signal } = {}) {
  if (!image) throw new AiError('bad');
  const body = {
    image: encodeImage(image), mask: mask ? encodeMask(mask, image) : null, prompt: clip(prompt),
    constraints: { keep: strs(constraints?.keep), avoid: strs(constraints?.avoid) },
    refs: encodeRefs(refs), view: viewOf(view), level: ['subtle', 'medium', 'bold'].includes(level) ? level : 'medium',
  };
  const r = await post('/api/ai/edit', body, { signal });
  return { canvas: await dataUrlToCanvas(r.image, { size: { w: image.width, h: image.height } }), level: r.level || body.level, model: str(r.model), ms: Number(r.ms) || 0 };
}

/** A new garment from a description (and up to 3 reference images). @returns {Promise<{canvas:HTMLCanvasElement, model:string}>} */
export async function aiGenerate({ prompt, refs = [], view = 'front', signal } = {}) {
  if (!clip(prompt)) throw new AiError('bad');
  const r = await post('/api/ai/generate', { prompt: clip(prompt), refs: encodeRefs(refs), view: viewOf(view) }, { signal });
  return { canvas: await dataUrlToCanvas(r.image, { fit: true }), model: str(r.model) };
}

/** Turns a sentence into structured operations (same shape as prompt.js parsePrompt plus avoid/extract/matchBackToFront/confidence). */
export async function aiUnderstand({ prompt, image = null, view = 'front', hasSelection = false, signal } = {}) {
  const r = await post('/api/ai/understand', { prompt: clip(prompt), image: image ? encodeImage(image) : null, view: viewOf(view), hasSelection: !!hasSelection }, { signal });
  if (!r || typeof r.ops !== 'object' || !r.ops) throw new AiError('upstream');
  return r.ops;
}

/** Finds text, logos, graphics and stripes in a garment image. bbox values are 0-1 of the image. */
export async function aiAnalyze({ image, view = 'front', signal } = {}) {
  if (!image) throw new AiError('bad');
  const r = await post('/api/ai/analyze', { image: encodeImage(image), view: viewOf(view) }, { signal });
  return Array.isArray(r?.elements) ? r.elements.slice(0, 60) : [];
}
const strs = a => (Array.isArray(a) ? a.map(s => String(s).slice(0, 120)).slice(0, 20) : []);
