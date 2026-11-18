'use strict';
// Shared helpers for the Threadform serverless functions (CommonJS so it works on Vercel's
// default Node runtime without a package.json "type" field). Files starting with "_" in /api
// are not deployed as endpoints. No third-party dependencies.

const zlib = require('zlib');

const MODEL = 'gpt-image-1';
const OPENAI_BASE = 'https://api.openai.com/v1';
const LIMITS = {
  body: 4.4 * 1024 * 1024,        // Vercel rejects > 4.5MB request bodies
  image: 3.2 * 1024 * 1024,
  mask: 1.5 * 1024 * 1024,
  ref: 1.2 * 1024 * 1024,
  refs: 3,
  prompt: 1200,
  upstreamTimeoutMs: 55000
};
const VIEWS = ['front', 'back', 'side', 'detail'];
const REGION_NAMES = ['body', 'leftSleeve', 'rightSleeve', 'collar', 'neckline', 'cuffs', 'hem', 'shoulders', 'sidePanels', 'stripes', 'logos', 'text', 'fabric'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ------------------------------------------------------------------ http helpers */

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(obj));
}

// Same-origin only: we never emit Access-Control-Allow-Origin. A browser Origin header that
// does not match the Host is rejected (non-browser callers without Origin are allowed).
function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try { return new URL(origin).host === host; } catch (_) { return false; }
}

async function readJson(req) {
  const len = Number(req.headers && req.headers['content-length']);
  if (len > LIMITS.body) throw new HttpError(413, 'Request body too large');
  let b = req.body;
  if (b == null || (typeof b === 'object' && Buffer.isBuffer(b))) {
    const chunks = []; let size = 0;
    if (Buffer.isBuffer(b)) { chunks.push(b); size = b.length; }
    else if (typeof req.on === 'function') {
      await new Promise((resolve, reject) => {
        req.on('data', (c) => { size += c.length; if (size > LIMITS.body) { reject(new HttpError(413, 'Request body too large')); req.destroy && req.destroy(); } else chunks.push(c); });
        req.on('end', resolve); req.on('error', reject);
      });
    }
    b = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof b === 'string') {
    if (b.length > LIMITS.body) throw new HttpError(413, 'Request body too large');
    try { b = JSON.parse(b || '{}'); } catch (_) { throw new HttpError(400, 'Body must be valid JSON'); }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Body must be a JSON object');
  return b;
}

/* ------------------------------------------------------------------ data URLs / images */

function decodeDataURL(str, maxBytes, field) {
  if (typeof str !== 'string') throw new HttpError(400, `${field} must be a data URL string`);
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(str);
  if (!m) throw new HttpError(400, `${field} must be a base64 PNG or JPEG data URL`);
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw new HttpError(400, `${field} is empty`);
  if (buffer.length > maxBytes) throw new HttpError(413, `${field} too large (max ${Math.round(maxBytes / 1024)}KB, send a smaller image)`);
  const png = buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47;
  const jpg = buffer[0] === 0xff && buffer[1] === 0xd8;
  if (m[1] === 'image/png' ? !png : !jpg) throw new HttpError(400, `${field} content does not match its type`);
  return { mime: m[1], buffer };
}

function imageSize(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new HttpError(400, 'Cannot read JPEG dimensions');
}

/* ------------------------------------------------------------------ minimal PNG codec */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// Decodes non-interlaced 8/16-bit grey, grey+alpha, RGB, RGBA and 8-bit palette PNGs to RGBA8.
function decodePNG(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new HttpError(400, 'Not a PNG');
  let pos = 8, width, height, depth, ctype, interlace, plte = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height) throw new HttpError(400, 'Corrupt PNG');
  if (width * height > 4096 * 4096) throw new HttpError(413, 'PNG dimensions too large');
  if (interlace) throw new HttpError(400, 'Interlaced PNG not supported');
  if (depth !== 8 && depth !== 16) throw new HttpError(400, 'Unsupported PNG bit depth');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels || (ctype === 3 && depth !== 8)) throw new HttpError(400, 'Unsupported PNG colour type');
  const bpp = channels * depth / 8;
  const stride = width * bpp;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (_) { throw new HttpError(400, 'Corrupt PNG data'); }
  if (raw.length < (stride + 1) * height) throw new HttpError(400, 'Truncated PNG');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const step = depth / 8;
  for (let i = 0; i < width * height; i++) {
    const p = i * bpp, o = i * 4;
    const ch = (k) => px[p + k * step];
    if (ctype === 6) { out[o] = ch(0); out[o + 1] = ch(1); out[o + 2] = ch(2); out[o + 3] = ch(3); }
    else if (ctype === 2) { out[o] = ch(0); out[o + 1] = ch(1); out[o + 2] = ch(2); out[o + 3] = 255; }
    else if (ctype === 0) { out[o] = out[o + 1] = out[o + 2] = ch(0); out[o + 3] = 255; }
    else if (ctype === 4) { out[o] = out[o + 1] = out[o + 2] = ch(0); out[o + 3] = ch(1); }
    else { const idx = px[p]; out[o] = plte ? plte[idx * 3] : 0; out[o + 1] = plte ? plte[idx * 3 + 1] : 0; out[o + 2] = plte ? plte[idx * 3 + 2] : 0; out[o + 3] = trns && idx < trns.length ? trns[idx] : 255; }
  }
  return { width, height, data: out, hasAlpha: ctype === 6 || ctype === 4 || ctype === 3 };
}

/* ------------------------------------------------------------------ mask conversion */

// Our contract: mask alpha > 0 (opaque) = selected / "edit here".
// OpenAI convention: fully transparent (alpha 0) pixels of the mask are edited; opaque pixels are kept.
// So out.alpha = 255 - selected. Mask is resampled (nearest) to the image size when they differ.
// If the supplied mask has no alpha channel, luminance is used (white = selected).
function maskToOpenAI(maskBuf, targetW, targetH) {
  const m = decodePNG(maskBuf);
  const w = targetW || m.width, h = targetH || m.height;
  const out = new Uint8ClampedArray(w * h * 4);
  let selected = 0;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(m.height - 1, Math.floor((y + 0.5) * m.height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(m.width - 1, Math.floor((x + 0.5) * m.width / w));
      const i = (sy * m.width + sx) * 4;
      const sel = m.hasAlpha ? m.data[i + 3] : Math.round((m.data[i] + m.data[i + 1] + m.data[i + 2]) / 3);
      const o = (y * w + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = 0;
      out[o + 3] = 255 - sel;
      if (sel > 127) selected++;
    }
  }
  return { png: encodePNG(w, h, out), selectedFraction: selected / (w * h) };
}

/* ------------------------------------------------------------------ prompt engineering */

const VARIANTS = [
  { label: 'Subtle', wording: 'Make a SUBTLE version of the change: small, conservative and easy to miss at a glance, roughly one third of the full effect. The garment must still read as the same design.' },
  { label: 'Medium', wording: 'Make a MEDIUM version of the change: clearly visible but restrained, roughly two thirds of the full effect.' },
  { label: 'Bold', wording: 'Make a BOLD version of the change: full, pronounced and unmistakable, while keeping the garment realistic and wearable.' }
];

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const REGION_WORDS = {
  body: 'the body', leftSleeve: 'the left sleeve', rightSleeve: 'the right sleeve', collar: 'the collar', neckline: 'the neckline',
  cuffs: 'the cuffs', hem: 'the hem', shoulders: 'the shoulders', sidePanels: 'the side panels', stripes: 'the stripes / piping',
  logos: 'the logos', text: 'the text and graphics', fabric: 'the fabric and colour'
};
function listRegions(a) {
  return (Array.isArray(a) ? a : []).filter((r) => REGION_NAMES.includes(r)).map((r) => REGION_WORDS[r]);
}

// ops is untrusted client JSON: only whitelisted fields are used, as short strings.
function buildEditPrompt({ prompt, ops, hasMask, refCount, view, variant }) {
  const req = cleanText(prompt, LIMITS.prompt) || cleanText(ops && ops.summary, 300);
  const v = VARIANTS.find((x) => x.label === variant) || VARIANTS[1];
  const lines = [];
  lines.push(`You are a precise garment-design retoucher. The first image is a ${VIEWS.includes(view) ? view : 'front'} view of a single clothing item (flat-lay or product shot) used in a fashion design tool.`);
  lines.push(`Requested edit: "${req}".`);
  lines.push(v.wording);
  if (hasMask) {
    lines.push('A mask is supplied: change ONLY the transparent masked area. Preserve everything outside the masked area exactly, pixel for pixel.');
  } else {
    lines.push('Change only the garment parts that the request mentions. Preserve all other parts exactly as they are.');
  }
  lines.push('Preserve the garment identity: keep the same colours, stripes and stripe order, logos, prints, text, stitching, seams, fabric texture, lighting, soft shadows, background and camera angle. Do not recolour, restyle or redraw anything that was not requested.');
  const keep = listRegions(ops && ops.keep);
  if (keep.length) lines.push(`Explicitly keep unchanged: ${keep.join(', ')}.`);
  const except = listRegions(ops && ops.keepAllExcept);
  if (except.length) lines.push(`Keep everything identical except: ${except.join(', ')}.`);
  const notes = cleanText(Array.isArray(ops && ops.keepNotes) ? ops.keepNotes.slice(0, 5).join('; ') : '', 200);
  if (notes) lines.push(`Details to retain: ${notes}.`);
  if (refCount > 0) {
    lines.push(`The other ${refCount} image${refCount > 1 ? 's are' : ' is'} style/material reference${refCount > 1 ? 's' : ''} only. Borrow the requested colour, fabric, trim or detail from ${refCount > 1 ? 'them' : 'it'}; do NOT copy the reference garment's shape, framing or background.`);
  }
  lines.push('Output a single realistic garment with believable seams, folds and fabric drape, same framing and scale, on a transparent or plain background. No people, mannequins, hands, extra text, watermarks or borders.');
  return lines.join('\n');
}

function buildGeneratePrompt({ prompt, view, refCount }) {
  const req = cleanText(prompt, LIMITS.prompt);
  const lines = [
    `Photorealistic flat-lay product image of a single garment, ${VIEWS.includes(view) ? view : 'front'} view, centred and fully in frame, even soft studio lighting, subtle natural shadows, transparent or plain light background. No model, mannequin, hands, text overlays or watermark.`,
    `Garment: ${req}.`
  ];
  if (refCount > 0) lines.push(`The supplied image${refCount > 1 ? 's are' : ' is a'} reference${refCount > 1 ? 's' : ''} for colour, fabric and details; design a new garment inspired by ${refCount > 1 ? 'them' : 'it'} rather than copying exactly.`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ OpenAI request building */

function env(e) { return e || process.env; }
function openaiKey(e) { const k = env(e).OPENAI_API_KEY; return typeof k === 'string' && k.trim() ? k.trim() : null; }
function status(e) {
  const k = openaiKey(e);
  if (k) return { available: true, provider: MODEL, model: MODEL };
  return { available: false, provider: 'none', reason: env(e).REPLICATE_API_TOKEN ? 'Replicate backend is not implemented yet (TODO); set OPENAI_API_KEY' : 'No AI key configured (set OPENAI_API_KEY)' };
}

function quality(e) { const q = env(e).OPENAI_IMAGE_QUALITY; return ['low', 'medium', 'high'].includes(q) ? q : 'medium'; }

function blobOf(buf, mime) { return new Blob([buf], { type: mime }); }

function buildEditForm({ image, mask, refs, prompt, quality: q }) {
  const f = new FormData();
  f.append('model', MODEL);
  f.append('prompt', prompt);
  f.append('n', '1');
  f.append('size', '1024x1024');
  f.append('quality', q || 'medium');
  f.append('background', 'transparent');
  f.append('output_format', 'png');
  f.append('input_fidelity', 'high');
  f.append('image[]', blobOf(image.buffer, image.mime), image.mime === 'image/png' ? 'image.png' : 'image.jpg');
  (refs || []).forEach((r, i) => f.append('image[]', blobOf(r.buffer, r.mime), `ref${i}.${r.mime === 'image/png' ? 'png' : 'jpg'}`));
  if (mask) f.append('mask', blobOf(mask, 'image/png'), 'mask.png');
  return f;
}

function sanitizeUpstreamError(status, text) {
  let msg = '';
  try { msg = JSON.parse(text).error.message; } catch (_) { msg = String(text || '').slice(0, 200); }
  return `OpenAI ${status}: ${cleanText(msg, 200).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')}`;
}

async function callOpenAI(fetchImpl, key, path, init) {
  const headers = { Authorization: `Bearer ${key}`, ...(init.headers || {}) };
  const resp = await fetchImpl(OPENAI_BASE + path, { method: 'POST', ...init, headers, signal: init.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(LIMITS.upstreamTimeoutMs) : undefined) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(sanitizeUpstreamError(resp.status, text));
  let j; try { j = JSON.parse(text); } catch (_) { throw new Error('OpenAI returned invalid JSON'); }
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return 'data:image/png;base64,' + b64;
}

function validateCommon(body) {
  const prompt = cleanText(body.prompt, LIMITS.prompt + 1);
  if (!prompt) throw new HttpError(400, 'prompt is required');
  if (prompt.length > LIMITS.prompt) throw new HttpError(400, `prompt too long (max ${LIMITS.prompt} chars)`);
  const view = body.view == null ? 'front' : body.view;
  if (!VIEWS.includes(view)) throw new HttpError(400, 'view must be front, back, side or detail');
  const rawRefs = body.refs == null ? [] : body.refs;
  if (!Array.isArray(rawRefs)) throw new HttpError(400, 'refs must be an array');
  if (rawRefs.length > LIMITS.refs) throw new HttpError(400, `at most ${LIMITS.refs} reference images`);
  const refs = rawRefs.map((r, i) => decodeDataURL(r, LIMITS.ref, `refs[${i}]`));
  return { prompt, view, refs };
}

// Orchestrators return {status, json}; endpoints just forward them. fetchImpl is injectable for tests.
async function runEdit({ body, env: e, fetchImpl = globalThis.fetch }) {
  const key = openaiKey(e);
  if (!key) return { status: 200, json: { fallback: true, reason: status(e).reason } };
  try {
    const { prompt, view, refs } = validateCommon(body);
    const image = decodeDataURL(body.image, LIMITS.image, 'image');
    let maskPng = null;
    if (body.mask != null) {
      const m = decodeDataURL(body.mask, LIMITS.mask, 'mask');
      if (m.mime !== 'image/png') throw new HttpError(400, 'mask must be a PNG');
      const { width, height } = imageSize(image.buffer);
      const conv = maskToOpenAI(m.buffer, width, height);
      if (conv.selectedFraction === 0) throw new HttpError(400, 'mask selects nothing');
      maskPng = conv.png;
    }
    const q = quality(e);
    const ops = body.ops && typeof body.ops === 'object' ? body.ops : {};
    const settled = await Promise.allSettled(VARIANTS.map((v) => callOpenAI(fetchImpl, key, '/images/edits', {
      body: buildEditForm({ image, mask: maskPng, refs, quality: q, prompt: buildEditPrompt({ prompt, ops, hasMask: !!maskPng, refCount: refs.length, view, variant: v.label }) })
    })));
    const variations = settled.map((s, i) => s.status === 'fulfilled'
      ? { label: VARIANTS[i].label, image: s.value }
      : { label: VARIANTS[i].label, image: null, error: String(s.reason && s.reason.message || s.reason).slice(0, 240) });
    if (variations.every((v) => !v.image)) return { status: 200, json: { fallback: true, reason: variations[0].error || 'AI request failed' } };
    return { status: 200, json: { fallback: false, provider: MODEL, variations } };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, json: { error: err.message } };
    return { status: 200, json: { fallback: true, reason: 'AI request failed' } };
  }
}

async function runGenerate({ body, env: e, fetchImpl = globalThis.fetch }) {
  const key = openaiKey(e);
  if (!key) return { status: 200, json: { fallback: true, reason: status(e).reason } };
  try {
    const { prompt, view, refs } = validateCommon(body);
    const q = quality(e);
    const text = buildGeneratePrompt({ prompt, view, refCount: refs.length });
    let image;
    if (refs.length) {
      // images/edits accepts several input images and no mask: refs act as visual guidance.
      image = await callOpenAI(fetchImpl, key, '/images/edits', { body: buildEditForm({ image: refs[0], mask: null, refs: refs.slice(1), quality: q, prompt: text }) });
    } else {
      image = await callOpenAI(fetchImpl, key, '/images/generations', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt: text, n: 1, size: '1024x1024', quality: q, background: 'transparent', output_format: 'png' })
      });
    }
    return { status: 200, json: { fallback: false, provider: MODEL, image } };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, json: { error: err.message } };
    return { status: 200, json: { fallback: true, reason: String(err && err.message || 'AI request failed').slice(0, 240) } };
  }
}

/* ------------------------------------------------------------------ abuse / cost protection */
// Each AI request spends real money (an edit makes three image calls). Anyone can call these endpoints
// directly, so cap per-IP and total usage. Counters live in memory: on serverless platforms each warm
// instance keeps its own counts, so this is a best-effort brake, not a hard limit. Also set a spending
// limit on the OpenAI project. Tunable via AI_RATE_LIMIT (requests per IP per window, default 6),
// AI_RATE_WINDOW_MIN (default 10) and AI_DAILY_LIMIT (requests per instance per UTC day, default 300).
const rateBuckets = new Map();
const dayState = { key: '', count: 0 };
function clientIp(req) {
  const h = (req && req.headers) || {};
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || String(h['x-real-ip'] || (req && req.socket && req.socket.remoteAddress) || 'unknown');
}
function rateLimit(req, env = process.env, now = Date.now()) {
  const perIp = Math.max(1, Number(env.AI_RATE_LIMIT) || 6);
  const windowMs = Math.max(1, Number(env.AI_RATE_WINDOW_MIN) || 10) * 60000;
  const daily = Math.max(1, Number(env.AI_DAILY_LIMIT) || 300);
  const day = new Date(now).toISOString().slice(0, 10);
  if (dayState.key !== day) { dayState.key = day; dayState.count = 0; }
  if (dayState.count >= daily) return { ok: false, retryAfter: 3600 };
  const ip = clientIp(req);
  let rec = rateBuckets.get(ip);
  if (!rec || now - rec.start >= windowMs) { rec = { start: now, n: 0 }; rateBuckets.set(ip, rec); }
  if (rec.n >= perIp) return { ok: false, retryAfter: Math.max(1, Math.ceil((rec.start + windowMs - now) / 1000)) };
  rec.n++; dayState.count++;
  if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (now - v.start >= windowMs) rateBuckets.delete(k);
  return { ok: true };
}
function resetRateLimit() { rateBuckets.clear(); dayState.key = ''; dayState.count = 0; }

// Shared request wrapper for both endpoints.
async function handle(req, res, { run, allowStatus }) {
  try {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-origin requests are not allowed' });
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method === 'GET') {
      if (allowStatus) return send(res, 200, status(process.env));
      return send(res, 405, { error: 'Use POST' });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return send(res, 405, { error: 'Method not allowed' }); }
    const ct = String((req.headers && req.headers['content-type']) || '');
    if (!/application\/json/i.test(ct)) return send(res, 415, { error: 'Content-Type must be application/json' });
    const rl = rateLimit(req);
    if (!rl.ok) { res.setHeader('Retry-After', String(rl.retryAfter)); return send(res, 429, { error: 'Too many AI requests. Please try again later.' }); }
    const body = await readJson(req);
    const out = await run({ body, env: process.env });
    return send(res, out.status, out.json);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    return send(res, 500, { error: 'Internal error' }); // never echo internals or secrets
  }
}

module.exports = {
  MODEL, LIMITS, VARIANTS, VIEWS, HttpError,
  send, sameOrigin, readJson, decodeDataURL, imageSize, crc32, encodePNG, decodePNG, maskToOpenAI,
  cleanText, buildEditPrompt, buildGeneratePrompt, buildEditForm, callOpenAI, status,
  runEdit, runGenerate, handle, rateLimit, resetRateLimit
};
