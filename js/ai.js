// Threadform - AI backend client. Talks to /api/edit and /api/generate (same origin).
// Every failure path degrades to {source:'local-needed'} / {canvas:null} so the caller can
// use the offline engine (variations.localVariations).

const LABELS = ['Subtle', 'Medium', 'Bold'];
const MAX_SIDE = 1024;            // never send more than 1024px
const BODY_BUDGET = 4.0e6;        // chars of JSON; Vercel's hard limit is 4.5MB
const TIMEOUT_MS = 75000;         // functions are capped at 60s; leave room for transfer

let statusCache = null;

export async function aiStatus() {
  if (statusCache && Date.now() - statusCache.at < 60000) return statusCache.value;
  let value = { available: false, provider: 'local' };
  try {
    const r = await fetchJSON('/api/edit?status=1', { method: 'GET' }, 8000);
    if (r && typeof r === 'object') value = { available: !!r.available, provider: r.available ? (r.provider || 'gpt-image-1') : 'local', reason: r.reason };
  } catch (_) { /* static hosting / offline / dev server without /api */ }
  statusCache = { at: Date.now(), value };
  return value;
}

export function resetAiStatusCache() { statusCache = null; }

/**
 * @returns {Promise<Array<{label:string, canvas:HTMLCanvasElement|null, source:'ai'|'local-needed'}>>}
 */
export async function requestVariations({ imageCanvas, maskCanvas = null, prompt, refs = [], view = 'front', ops = null }) {
  const fallback = LABELS.map((label) => ({ label, canvas: null, source: 'local-needed' }));
  try {
    if (!imageCanvas || !String(prompt || '').trim()) return fallback;
    const payload = buildPayload({ imageCanvas, maskCanvas, refs, prompt, view, ops });
    const res = await fetchJSON('/api/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, TIMEOUT_MS);
    if (!res || res.fallback || !Array.isArray(res.variations)) return fallback;
    const out = [];
    for (let i = 0; i < LABELS.length; i++) {
      const v = res.variations.find((x) => x && x.label === LABELS[i]) || res.variations[i];
      if (!v || !v.image) { out.push({ label: LABELS[i], canvas: null, source: 'local-needed' }); continue; }
      try {
        let c = await dataURLToCanvas(v.image);
        if (maskCanvas) c = compositeWithinMask(imageCanvas, c, maskCanvas); // guarantee: nothing outside the mask changes
        out.push({ label: LABELS[i], canvas: c, source: 'ai' });
      } catch (_) { out.push({ label: LABELS[i], canvas: null, source: 'local-needed' }); }
    }
    return out.some((v) => v.canvas) ? out : fallback;
  } catch (_) {
    return fallback;
  }
}

/** @returns {Promise<{canvas:HTMLCanvasElement|null, source:'ai'|'local-needed'}>} */
export async function generateGarment({ prompt, refs = [], view = 'front' }) {
  try {
    if (!String(prompt || '').trim()) return { canvas: null, source: 'local-needed' };
    const payload = { prompt: String(prompt).slice(0, 1200), view, refs: encodeRefs(refs, 0) };
    const res = await fetchJSON('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, TIMEOUT_MS);
    if (!res || res.fallback || !res.image) return { canvas: null, source: 'local-needed' };
    return { canvas: await dataURLToCanvas(res.image), source: 'ai' };
  } catch (_) {
    return { canvas: null, source: 'local-needed' };
  }
}

/* ------------------------------------------------------------------ payload building */

function buildPayload({ imageCanvas, maskCanvas, refs, prompt, view, ops }) {
  const opsLite = ops ? {
    summary: ops.summary, regions: ops.regions, keep: ops.keep, keepAllExcept: ops.keepAllExcept, keepNotes: ops.keepNotes
  } : undefined;
  // Try progressively smaller encodings until the whole body fits Vercel's limit.
  const plans = [
    { side: MAX_SIDE, refSide: 512 }, { side: 896, refSide: 384 }, { side: 768, refSide: 320 }, { side: 640, refSide: 256 }, { side: 512, refSide: 192 }
  ];
  let payload;
  for (const p of plans) {
    const scale = Math.min(1, p.side / Math.max(imageCanvas.width, imageCanvas.height));
    const w = Math.max(1, Math.round(imageCanvas.width * scale)), h = Math.max(1, Math.round(imageCanvas.height * scale));
    payload = {
      prompt: String(prompt).slice(0, 1200), view, ops: opsLite,
      image: encodeImage(imageCanvas, w, h),               // PNG keeps transparency; falls back to JPEG if huge
      mask: maskCanvas ? canvasToDataURL(maskCanvas, w, h, 'image/png') : null, // same size as the image (API requirement)
      refs: encodeRefs(refs, p.refSide)
    };
    if (JSON.stringify(payload).length < BODY_BUDGET) break;
  }
  return payload;
}

function encodeImage(canvas, w, h) {
  const png = canvasToDataURL(canvas, w, h, 'image/png');
  if (png.length < 2.6e6) return png;
  return canvasToDataURL(canvas, w, h, 'image/jpeg', 0.9, '#ffffff'); // flatten on white when PNG is too heavy
}

function encodeRefs(refs, side) {
  return (Array.isArray(refs) ? refs : []).filter(Boolean).slice(0, 3).map((c) => {
    const s = side || 512;
    const scale = Math.min(1, s / Math.max(c.width, c.height));
    return canvasToDataURL(c, Math.round(c.width * scale), Math.round(c.height * scale), 'image/jpeg', 0.82, '#ffffff');
  });
}

function canvasToDataURL(src, w, h, type, quality, flatten) {
  let c = src;
  if (src.width !== w || src.height !== h || flatten) {
    c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (flatten) { g.fillStyle = flatten; g.fillRect(0, 0, w, h); }
    g.drawImage(src, 0, 0, w, h);
  }
  return c.toDataURL(type, quality);
}

/* ------------------------------------------------------------------ results */

function dataURLToCanvas(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 1024;                      // contract: SIZE x SIZE
      const g = c.getContext('2d');
      const s = Math.min(1024 / img.width, 1024 / img.height);
      g.drawImage(img, (1024 - img.width * s) / 2, (1024 - img.height * s) / 2, img.width * s, img.height * s);
      resolve(c);
    };
    img.onerror = () => reject(new Error('bad image'));
    img.src = url;
  });
}

// result inside the mask, original everywhere else (mask alpha = selection weight)
function compositeWithinMask(original, edited, mask) {
  const W = original.width, H = original.height;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const g = out.getContext('2d');
  g.drawImage(original, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(mask, 0, 0, W, H);                             // punch the selected area out of the original
  const e = document.createElement('canvas'); e.width = W; e.height = H;
  const eg = e.getContext('2d');
  eg.drawImage(edited, 0, 0, W, H);
  eg.globalCompositeOperation = 'destination-in';
  eg.drawImage(mask, 0, 0, W, H);                            // keep only the selected area of the AI result
  g.globalCompositeOperation = 'source-over';
  g.drawImage(e, 0, 0);
  return out;
}

async function fetchJSON(url, init, timeoutMs) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { ...init, signal: ctl ? ctl.signal : undefined, credentials: 'same-origin' });
    if (!r.ok) return null;
    return await r.json();
  } finally { if (timer) clearTimeout(timer); }
}
