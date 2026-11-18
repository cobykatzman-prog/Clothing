// Shared helpers (owner: shell). No dependencies.
export const SIZE = 1024;

export function makeCanvas(w = SIZE, h = SIZE) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
export function cloneCanvas(c) {
  const n = makeCanvas(c.width, c.height);
  n.getContext('2d').drawImage(c, 0, 0);
  return n;
}
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;   // refuse huge files before decoding them
const MAX_UPLOAD_PIXELS = 100e6;             // ~10000x10000: bigger images can exhaust browser memory
export async function loadImageToCanvas(src, margin = 0.94) {
  let url = src, revoke = false;
  if (typeof src !== 'string') {
    if (src.type && !/^image\/(png|jpe?g|webp|gif|bmp|avif|svg\+xml)$/i.test(src.type)) throw userError('Please choose an image file (PNG, JPG, WebP or GIF).');
    if (src.size > MAX_UPLOAD_BYTES) throw userError('That image is larger than 25 MB. Please choose a smaller one.');
    url = URL.createObjectURL(src); revoke = true;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(userError('That file could not be read as an image. Try saving it as a PNG or JPG and upload it again.'));
    img.src = url;
  });
  if (revoke) URL.revokeObjectURL(url);
  const w = img.naturalWidth || img.width || SIZE, h = img.naturalHeight || img.height || SIZE;
  if (w * h > MAX_UPLOAD_PIXELS) throw userError('That image has too many pixels. Please choose one under about 10,000 x 10,000.');
  const s = Math.min(SIZE / w, SIZE / h) * margin;
  const dw = w * s, dh = h * s;
  const c = makeCanvas();
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);
  return c;
}
export function canvasToBlob(c, type = 'image/png', quality) {
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Could not encode image')), type, quality));
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function debounce(fn, ms = 120) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ---- extras used by the shell ----
export function thumbOf(canvas, size = 96, bg = null) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size); }
  ctx.imageSmoothingQuality = 'high';
  if (canvas) ctx.drawImage(canvas, 0, 0, size, size);
  return c;
}
/** true when a canvas has (almost) no visible pixels – cheap, samples a 128px copy */
export function maskIsEmpty(c) {
  if (!c) return true;
  const t = makeCanvas(128, 128);
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(c, 0, 0, 128, 128);
  const d = ctx.getImageData(0, 0, 128, 128).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 24) return false;
  return true;
}
/** re-centres the visible pixels and scales them to fill `margin` of the working area */
export function cropToContent(c, margin = 0.9) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return c;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, s = Math.min(SIZE * margin / bw, SIZE * margin / bh);
  const out = makeCanvas(), o = out.getContext('2d');
  o.imageSmoothingQuality = 'high';
  o.drawImage(c, x0, y0, bw, bh, (SIZE - bw * s) / 2, (SIZE - bh * s) / 2, bw * s, bh * s);
  return out;
}
/** false when the content's rectangle edge is mostly opaque, i.e. a photo with a background */
export function hasTransparentBorder(c) {
  const N = 256, t = makeCanvas(N, N), ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(c, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data, A = (x, y) => d[(y * N + x) * 4 + 3];
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (A(x, y) > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return true;
  let n = 0, op = 0;
  const i = 2; // inset: the resampled edge is semi-transparent
  if (x1 - x0 < 8 || y1 - y0 < 8) return true;
  for (let x = x0 + i; x <= x1 - i; x++) { n += 2; if (A(x, y0 + i) > 200) op++; if (A(x, y1 - i) > 200) op++; }
  for (let y = y0 + i; y <= y1 - i; y++) { n += 2; if (A(x0 + i, y) > 200) op++; if (A(x1 - i, y) > 200) op++; }
  return op / n < 0.6;
}
export function intersectMask(mask, garmentMask) {
  const out = cloneCanvas(mask);
  if (garmentMask) { const x = out.getContext('2d'); x.globalCompositeOperation = 'destination-in'; x.drawImage(garmentMask, 0, 0); }
  return out;
}

// ---- tiny DOM helper ----
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'tip') el.setAttribute('data-tip', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = k => {
    if (k == null || k === false) return;
    if (Array.isArray(k)) k.forEach(add);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
}

const ICONS = {
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  zoomIn: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.3-4.3M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.3-4.3M8 11h6',
  rotate: 'M21 12a9 9 0 11-3-6.7M21 3v6h-6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  brush: 'M18 3l3 3-9.5 9.5-4-1 .5-3.5zM7.5 15C5 15 4 16.5 4 19c2.5 0 4-1 4-3',
  eraser: 'M20 20H9l-5-5a2 2 0 010-2.8l9-9a2 2 0 012.8 0l5 5a2 2 0 010 2.8L13 20M8 8l8 8',
  pointer: 'M5 3l14 7-6 2-2 6z',
  pick: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 2v4M12 18v4M2 12h4M18 12h4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2',
  compare: 'M12 3v18M4 6h5v12H4zM15 6h5v12h-5z',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeoff: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM3 3l18 18',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-11',
  image: 'M4 5h16v14H4zM8.5 9.5a1.5 1.5 0 100 .01M4 17l5-5 4 4 3-3 4 4',
  hand: 'M7 11V5.5a1.5 1.5 0 013 0V10M10 10V4.5a1.5 1.5 0 013 0V10M13 10V5.5a1.5 1.5 0 013 0V12M16 9.5a1.5 1.5 0 013 0V14a7 7 0 01-7 7h-1a7 7 0 01-5.5-2.6L3 15a1.5 1.5 0 012.3-1.9L7 15',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7M8 20v-6h8v6',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  type: 'M5 6V4h14v2M12 4v16M9 20h6',
  chevron: 'M6 9l6 6 6-6',
  help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 115 0c0 1.7-2.5 2-2.5 4M12 17v.01',
  scissors: 'M6 3a3 3 0 100 6 3 3 0 000-6zM6 15a3 3 0 100 6 3 3 0 000-6zM8.5 8L20 19M8.5 16L20 5',
};
export function icon(name, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true'); s.classList.add('ico');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.help);
  s.append(p);
  return s;
}

/**
 * Short message at the bottom of the screen. `action` = { label, fn } adds a button (e.g. Undo);
 * toasts with an action stay a little longer so there is time to press it.
 */
export function toast(msg, kind = 'info', ms = 3200, action = null) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + kind }, h('span', {}, msg));
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); };
  if (action) {
    t.append(h('button', { type: 'button', class: 'toast-act', onclick: () => { close(); action.fn(); } }, action.label));
    ms = Math.max(ms, 7000);
  }
  box.append(t);
  setTimeout(close, ms);
  return close;
}

/** Errors we raise for the user carry a plain-language message; anything else gets the friendly fallback. */
export function userError(msg) { const e = new Error(msg); e.user = true; return e; }
export const friendly = (e, fallback) => (e && e.user && e.message ? e.message : fallback);

/** localStorage that never throws (private windows, blocked storage). */
export const prefs = {
  get(k, def = null) { try { const v = localStorage.getItem('threadform.' + k); return v == null ? def : v; } catch { return def; } },
  set(k, v) { try { localStorage.setItem('threadform.' + k, String(v)); } catch { /* not remembered: fine */ } },
};

/** Disables a control and explains why in its tooltip; restores the normal tooltip when enabled again. */
export function setDisabled(el, off, why) {
  if (!el) return;
  if (el.dataset.tipNormal === undefined) el.dataset.tipNormal = el.getAttribute('data-tip') || '';
  el.disabled = !!off;
  const tip = off && why ? why : el.dataset.tipNormal;
  if (tip) el.setAttribute('data-tip', tip); else el.removeAttribute('data-tip');
}

/** One floating tooltip for every [data-tip] element */
export function initTooltips() {
  const tip = h('div', { id: 'tooltip', role: 'tooltip' });
  document.body.append(tip);
  let cur = null;
  const show = el => {
    cur = el; tip.textContent = el.getAttribute('data-tip'); tip.classList.add('on');
    const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = clamp(r.left + r.width / 2 - tw / 2, 8, innerWidth - tw - 8);
    let y = r.bottom + 8; if (y + th > innerHeight - 8) y = r.top - th - 8;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  document.addEventListener('mouseover', e => { const el = e.target.closest?.('[data-tip]'); if (el && el !== cur) show(el); else if (!el) { cur = null; tip.classList.remove('on'); } });
  document.addEventListener('pointerdown', () => { cur = null; tip.classList.remove('on'); });
  // keyboard users get the same explanation when a control receives focus
  document.addEventListener('focusin', e => { const el = e.target.closest?.('[data-tip]'); if (el && el.matches(':focus-visible')) show(el); });
  document.addEventListener('focusout', () => { cur = null; tip.classList.remove('on'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { cur = null; tip.classList.remove('on'); } });
}
