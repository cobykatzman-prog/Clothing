// An in-process imitation of the OpenAI endpoints that ai.mjs calls. Used only by tests: it is NOT OpenAI.
//   POST /v1/images/edits        multipart (image[], mask, prompt, model, ...) -> {data:[{b64_json}]}
//   POST /v1/images/generations  JSON -> {data:[{b64_json}]}
//   POST /v1/chat/completions    JSON -> {choices:[{message:{content}}]}
// The edit endpoint deliberately IGNORES the mask and tints EVERYTHING it receives (50% towards magenta, alpha kept),
// imitating a model that does not respect masks: later phases prove outside-mask preservation by compositing.
// A wrong Authorization key gets a 401. Every request is recorded in mock.requests (files included).
import http from 'node:http';
import { decodePNG, encodePNG } from '../ai.mjs';

const MARK = 'UPSTREAM-BODY-MARKER';   // present in every error body: tests assert it never reaches a browser

export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return { fields: {}, files: [] };
  const delim = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}, files = [];
  let pos = buf.indexOf(delim);
  while (pos >= 0) {
    const next = buf.indexOf(delim, pos + delim.length);
    if (next < 0) break;
    const part = buf.subarray(pos + delim.length + 2, next - 2);   // strip CRLF after the boundary and before the next
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8'), body = part.subarray(split + 4);
    const name = /name="([^"]*)"/.exec(head), filename = /filename="([^"]*)"/.exec(head), type = /content-type:\s*([^\r\n]+)/i.exec(head);
    if (filename) files.push({ name: name && name[1], filename: filename[1], mime: type && type[1].trim(), data: Buffer.from(body) });
    else if (name) { const v = body.toString('utf8'); (fields[name[1]] = fields[name[1]] || []).push(v); }
    pos = next;
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].length === 1 ? fields[k][0] : fields[k];
  return { fields, files };
}

// What a "model that ignores the mask" returns: every pixel pulled 50% towards magenta, alpha unchanged.
export function tintPng(buf) {
  let d; try { d = decodePNG(buf); } catch (_) { d = null; }
  if (!d) { const px = new Uint8ClampedArray(256 * 256 * 4); for (let i = 0; i < px.length; i += 4) { px[i] = 255; px[i + 2] = 255; px[i + 3] = 255; } return encodePNG(256, 256, px); }
  const out = new Uint8ClampedArray(d.data);
  for (let i = 0; i < out.length; i += 4) { out[i] = (out[i] + 255) >> 1; out[i + 1] = out[i + 1] >> 1; out[i + 2] = (out[i + 2] + 255) >> 1; }
  return encodePNG(d.width, d.height, out);
}

// A transparent-background t-shirt silhouette in one colour: what the mock "generates" (so the studio can cut it out and segment it).
export function shirtPng(rgb = [200, 180, 140], size = 256) {
  const px = new Uint8ClampedArray(size * size * 4), s = size / 256;
  const inRect = (x, y, x0, y0, x1, y1) => x >= x0 * s && x < x1 * s && y >= y0 * s && y < y1 * s;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const body = inRect(x, y, 76, 60, 180, 230), sleeve = inRect(x, y, 30, 60, 226, 118);
    const neck = Math.hypot(x - 128 * s, y - 60 * s) < 24 * s;
    if ((body || sleeve) && !neck) { const i = (y * size + x) * 4; px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255; }
  }
  return encodePNG(size, size, px);
}
const COLOUR_WORDS = { navy: [28, 42, 77], cream: [239, 230, 210], red: [193, 39, 45], black: [29, 29, 33], white: [245, 245, 242], green: [60, 138, 79], blue: [47, 95, 176] };
const colourFromPrompt = t => { const m = Object.keys(COLOUR_WORDS).find(k => new RegExp('\\b' + k + '\\b', 'i').test(t || '')); return COLOUR_WORDS[m] || [200, 180, 140]; };

const CANNED = [
  [/flare/i, { summary: 'Slightly flare both sleeves, no cuffs', paramDeltas: { sleeveFlare: 35 }, sleevePreset: 'slightFlare', regions: ['leftSleeve', 'rightSleeve'], keep: ['body', 'collar'], removeCuffs: true, sleeveFrom: 'wrist', avoid: ['adding cuffs'], extract: null, matchBackToFront: false, confidence: 0.9 }],
  [/boxy/i, { summary: 'Boxier body, same length', paramDeltas: { bodyWidth: 60 }, fitPreset: 'boxy', regions: ['body'], keep: ['hem', 'collar'], keepNotes: ['garment length'], avoid: ['changing the garment length'], extract: null, matchBackToFront: false, confidence: 0.9 }],
  [/collar/i, { summary: 'Wider vintage collar', paramDeltas: { collarSize: 40 }, regions: ['collar'], keep: ['stripes'], keepColor: true, keepNotes: ['colour', 'stripes'], avoid: ['changing colours'], extract: null, matchBackToFront: false, confidence: 0.85 }],
  [/logo/i, { summary: 'Lift the logo onto its own layer', paramDeltas: {}, regions: ['logos'], keep: ['body'], removeParts: ['logos'], avoid: [], extract: { logo: true, text: false, graphics: false }, matchBackToFront: false, confidence: 0.9 }],
  [/back match|match the front/i, { summary: 'Back matches front proportions', paramDeltas: {}, regions: [], keep: ['logos', 'text'], avoid: [], extract: null, matchBackToFront: true, confidence: 0.85 }]
];
const ELEMENTS = { elements: [
  { type: 'text', bbox: { x: 0.2, y: 0.3, w: 0.6, h: 0.1 }, text: 'CLUB ELITE', fontStyle: 'bold serif capitals', color: '#6b4226', rotationDeg: 0, description: 'Back lettering' },
  { type: 'graphic', bbox: { x: 0.3, y: 0.45, w: 0.4, h: 0.3 }, color: '#6b4226', rotationDeg: 0, description: 'Tennis racket and ball' },
  { type: 'logo', bbox: { x: 0.6, y: 0.2, w: 0.1, h: 0.1 }, color: '#6b4226', rotationDeg: 0, description: 'Chest crest' }
] };

export async function startMock({ key = 'sk-test-mock-key' } = {}) {
  const state = { key, failure: null, failTimes: -1, requests: [], chatReply: null, delayMs: 0, active: 0, maxActive: 0 };   // failure: null | '429' | '500' | 'timeout' | 'badjson' | 'noimage' | '400'
  const sockets = new Set();

  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const err = (res, status, code, headers) => send(res, status, { error: { message: `${MARK} ${code} secret-detail sk-leaked-from-upstream`, type: code, code } }, headers);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      state.active++; state.maxActive = Math.max(state.maxActive, state.active);
      res.on('close', () => { state.active--; });
      if (state.delayMs > 0) setTimeout(() => handle(req, res, chunks), state.delayMs); else handle(req, res, chunks);
    });
  });
  function handle(req, res, chunks) {
    {
      const body = Buffer.concat(chunks), ct = String(req.headers['content-type'] || '');
      const rec = { method: req.method, path: req.url, auth: req.headers.authorization || '', contentType: ct, fields: {}, files: [], json: null };
      state.requests.push(rec);
      if (req.headers.authorization !== `Bearer ${state.key}`) return err(res, 401, 'invalid_api_key');
      if (/multipart/i.test(ct)) { const p = parseMultipart(body, ct); rec.fields = p.fields; rec.files = p.files; }
      else if (/json/i.test(ct)) { try { rec.json = JSON.parse(body.toString('utf8')); } catch (_) { /* leave null */ } }
      let f = state.failure;
      if (f && state.failTimes > 0) { state.failTimes--; if (state.failTimes === 0) state.failure = null; }
      if (f === 'timeout') return;                                   // never answers
      if (f === '429') return err(res, 429, 'rate_limit_exceeded', { 'Retry-After': '7' });
      if (f === '500') return err(res, 500, 'server_error');
      if (f === '400') return err(res, 400, 'content_policy_violation');
      if (f === 'badjson') return send(res, 200, '<html>not json ' + MARK + '</html>');

      if (req.method === 'POST' && req.url === '/v1/images/edits') {
        if (f === 'noimage') return send(res, 200, { data: [{}] });
        const img = rec.files.find(x => x.name === 'image[]' || x.name === 'image');
        if (!img) return err(res, 400, 'missing_image');
        const prompt = String(Array.isArray(rec.fields.prompt) ? rec.fields.prompt[0] : rec.fields.prompt || '');
        if (/approved FRONT view/.test(prompt)) {   // another view of the same garment: same colour as the supplied front
          let rgb = [200, 180, 140]; try { const d = decodePNG(img.data); const i = (Math.floor(d.height / 2) * d.width + Math.floor(d.width / 2)) * 4; rgb = [d.data[i], d.data[i + 1], d.data[i + 2]]; } catch (_) { /* default */ }
          return send(res, 200, { created: 1, data: [{ b64_json: shirtPng(rgb).toString('base64') }] });
        }
        return send(res, 200, { created: 1, data: [{ b64_json: tintPng(img.data).toString('base64') }] });
      }
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        if (f === 'noimage') return send(res, 200, { data: [{}] });
        return send(res, 200, { created: 1, data: [{ b64_json: shirtPng(colourFromPrompt(rec.json && rec.json.prompt)).toString('base64') }] });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const msgs = (rec.json && rec.json.messages) || [], sys = String((msgs[0] && msgs[0].content) || '');
        const userContent = msgs[1] && msgs[1].content, userText = Array.isArray(userContent) ? String((userContent.find(p => p.type === 'text') || {}).text || '') : String(userContent || '');
        let content;
        if (typeof state.chatReply === 'function') content = state.chatReply({ system: sys, user: userText, body: rec.json });
        else if (state.chatReply != null) content = state.chatReply;
        else if (sys.startsWith('MODE: ANALYZE')) content = JSON.stringify(ELEMENTS);
        else { let instr = ''; try { instr = JSON.parse(userText).instruction || ''; } catch (_) { /* none */ } const hit = CANNED.find(([re]) => re.test(instr)); content = JSON.stringify(hit ? hit[1] : { summary: '', paramDeltas: {}, regions: [], keep: [], avoid: [], confidence: 0.1 }); }
        return send(res, 200, { id: 'chatcmpl-mock', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      }
      return err(res, 404, 'not_found');
    }
  }
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1`, port, requests: state.requests, MARK,
    setKey: k => { state.key = k; },
    setFailure: (f, times = -1) => { state.failure = f; state.failTimes = times; },   // times: fail the next N requests then recover (-1 = until reset)
    setDelay: ms => { state.delayMs = ms; }, maxActive: () => state.maxActive,
    setChatReply: v => { state.chatReply = v; },     // string | function({system,user,body}) -> string | null (default behaviour)
    reset: () => { state.requests.length = 0; state.failure = null; state.failTimes = -1; state.chatReply = null; state.delayMs = 0; state.maxActive = 0; },
    close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); })
  };
}
