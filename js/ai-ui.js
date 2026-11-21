// Threadform - shared AI progress / error UI and the engine switch (badge + "Use AI" toggle).
// Everything is built with text nodes (h() never uses innerHTML), so it is CSP-safe and cannot inject user text.
import { h } from './util.js';
import { aiEnabled, aiInfo, toggleOn, setUseAi, useAi, onAiChange, isAiError } from './ai.js';

export { useAi };

// ---------------------------------------------------------------- engine badge + toggle
const NO_AI_TIP = 'The built-in engine edits garments right here in your browser. An administrator can enable AI editing by setting a key on the server.';
const AI_ON_TIP = 'AI editing is on. Your image, selection and description are sent to this site\'s server, which asks the AI model to make the edit.';
const AI_OFF_TIP = 'AI editing is available but switched off for you, so the built-in engine is used. Switch "Use AI" on to use it.';

function engineText() {
  const i = aiInfo();
  if (!aiEnabled()) return { text: 'Built-in engine', tip: NO_AI_TIP, kind: 'local' };
  const model = i.imageModel ? ` (${i.imageModel})` : '';
  return toggleOn() ? { text: `AI editing: on${model}`, tip: AI_ON_TIP, kind: 'ai' } : { text: 'AI editing: off', tip: AI_OFF_TIP, kind: 'local' };
}

/** Header badge. Keeps itself up to date. */
export function engineBadge() {
  const el = h('span', { class: 'badge engine-badge', id: 'engine-badge', tabindex: '0' });
  const sync = () => {
    const e = engineText();
    el.className = 'badge engine-badge ' + (e.kind === 'ai' ? 'ai' : 'local');
    el.replaceChildren(h('i', { class: 'dot' }), e.text);
    el.setAttribute('data-tip', e.tip); el.setAttribute('aria-label', `${e.text}. ${e.tip}`);
    el.dataset.engine = e.kind === 'ai' ? 'ai' : aiEnabled() ? 'paused' : 'builtin';
  };
  onAiChange(sync); sync();
  return el;
}

/** The engine switch in the Describe section: status line, "Use AI" toggle (only when AI is available) and an honest privacy note. */
export function engineRow() {
  const status = h('div', { class: 'engine-status', id: 'engine-status' });
  const box = h('input', { type: 'checkbox', role: 'switch', id: 'use-ai', 'aria-label': 'Use AI', onchange: e => setUseAi(e.target.checked) });
  const toggle = h('label', { class: 'check engine-toggle', tip: 'Use the AI model for edits and generated garments. Turn off to keep everything in this browser.' }, box, 'Use AI');
  const note = h('div', { class: 'muted small', id: 'engine-note' });
  const root = h('div', { class: 'engine-row' }, status, toggle, note);
  const shared = !!document.querySelector('meta[name="threadform-shared"][content="1"]');
  const sync = () => {
    const e = engineText();
    status.className = 'badge engine-badge ' + (e.kind === 'ai' ? 'ai' : 'local');
    status.replaceChildren(h('i', { class: 'dot' }), e.text);
    status.setAttribute('data-tip', e.tip); status.setAttribute('tabindex', '0');
    toggle.hidden = !aiEnabled(); box.checked = toggleOn();
    note.textContent = !aiEnabled()
      ? (shared ? 'The options are made right here in your browser; the design you keep is saved to the shared library.' : 'Runs entirely in your browser - nothing is uploaded.')
      : toggleOn() ? 'With AI on, your image, selection and description are sent to this site\'s server to make the edit. Switch it off to keep everything in your browser.'
        : 'AI is off: everything runs in your browser.';
  };
  onAiChange(sync); sync();
  return root;
}

/**
 * The recovery buttons for a failed AI action: Retry (only when retrying can help) and the built-in engine.
 * Pass the result to startTask().fail(err, { actions }).
 */
export function recoveryActions(err, { retry = null, local = null, localLabel = 'Use built-in engine' } = {}) {
  const a = [];
  if (retry && (!isAiError(err) || err.retryable)) a.push({ label: 'Retry', retry: true, primary: true, fn: retry });
  if (local) a.push({ label: localLabel, primary: !a.length, fn: local });
  return a;
}

// ---------------------------------------------------------------- task card
let host = null;
function getHost() {
  if (!host || !host.isConnected) { host = h('div', { id: 'ai-tasks', class: 'ai-tasks' }); document.body.append(host); }
  return host;
}

const STATE_LABEL = { pending: 'Waiting', working: 'Working', done: 'Done', failed: 'Did not finish' };

/**
 * A non-modal card that reports one AI action: spinner, elapsed seconds, Cancel, optional per-variation rows, friendly errors.
 * @param {{title:string, rows?:string[], hint?:string, onCancel?:()=>void, onRetryRow?:(i:number)=>void}} o
 * @returns controller {signal, row(i,state,detail?), setStatus(text), fail(err, {actions, note}), succeed(text, {autoClose}), close(), closed}
 */
export function startTask({ title, rows = null, hint = '', onCancel = null, onRetryRow = null } = {}) {
  const ctl = new AbortController();
  const t0 = Date.now();
  let ended = false, timer = 0, cdTimer = 0, closeTimer = 0, closed = false;

  const spinner = h('span', { class: 'ai-spin', 'aria-hidden': 'true' });
  const heading = h('b', { class: 'ai-title' }, title);
  const elapsed = h('span', { class: 'ai-elapsed muted small', 'aria-hidden': 'true' }, '0 s');
  const msg = h('div', { class: 'ai-msg', role: 'status', 'aria-live': 'polite' }, hint || 'Working on it…');
  const rowEls = (rows || []).map((label, i) => {
    const st = h('span', { class: 'ai-row-state' }, STATE_LABEL.pending);
    const retry = h('button', { type: 'button', class: 'btn ghost sm ai-retry', hidden: true, 'aria-label': `Try ${label} again`, onclick: () => { if (onRetryRow) onRetryRow(i); } }, 'Retry');
    const el = h('li', { class: 'ai-row', 'data-state': 'pending', 'data-i': String(i) }, h('span', { class: 'ai-dot', 'aria-hidden': 'true' }), h('span', { class: 'ai-row-label' }, label), st, retry);
    return { el, st, retry };
  });
  const list = rows ? h('ul', { class: 'ai-rows', 'aria-label': 'Options' }, rowEls.map(r => r.el)) : null;
  const actions = h('div', { class: 'ai-actions' });
  const cancelBtn = h('button', { type: 'button', class: 'btn ghost sm ai-cancel', onclick: () => cancel() }, 'Cancel');
  const closeBtn = h('button', { type: 'button', class: 'ai-x', 'aria-label': 'Dismiss', onclick: () => api.close() }, '×');
  closeBtn.hidden = true;
  actions.append(cancelBtn);
  const card = h('section', { class: 'ai-task', 'data-state': 'working', 'aria-label': title, onkeydown: e => { if (e.key === 'Escape' && !ended) { e.stopPropagation(); cancel(); } } },
    h('div', { class: 'ai-head' }, spinner, heading, elapsed, closeBtn), msg, list, actions);
  getHost().append(card);

  const tick = () => { elapsed.textContent = Math.round((Date.now() - t0) / 1000) + ' s'; };
  timer = setInterval(tick, 500);
  function stopTimers() { clearInterval(timer); clearInterval(cdTimer); }
  function cancel() {
    if (ended) return;
    ctl.abort();
    ended = true; stopTimers();
    msg.textContent = 'Cancelled. Nothing was changed.';
    card.dataset.state = 'cancelled';
    rowEls.forEach(r => { if (r.el.dataset.state === 'pending' || r.el.dataset.state === 'working') setRow(r, 'failed', 'Cancelled'); r.retry.hidden = true; });
    actions.replaceChildren(h('button', { type: 'button', class: 'btn ghost sm', onclick: () => api.close() }, 'Dismiss'));
    closeBtn.hidden = false;
    if (onCancel) onCancel();
    closeTimer = setTimeout(() => api.close(), 2500);
  }
  function setRow(r, state, detail) {
    r.el.dataset.state = state;
    r.st.textContent = detail || STATE_LABEL[state] || state;
    r.retry.hidden = state !== 'failed' || !onRetryRow || ctl.signal.aborted;
  }
  function finish(state, text) {
    ended = true; stopTimers(); card.dataset.state = state; msg.textContent = text; closeBtn.hidden = false; tick();
  }

  const api = {
    signal: ctl.signal,
    get closed() { return closed; },
    get ended() { return ended; },
    setStatus(text) { if (!ended) msg.textContent = text; },
    /** state: pending | working | done | failed. A retried row goes back to working and is reflected here. */
    row(i, state, detail) { const r = rowEls[i]; if (r && !closed && card.dataset.state !== 'cancelled') setRow(r, state, detail); },
    /** Show a friendly failure with plain next steps. actions: [{label, fn, primary?}]. Rate limits count down before "Try again" unlocks. */
    fail(err, { actions: acts = [], note = '' } = {}) {
      if (closed || ended) return;
      const text = isAiError(err) ? err.message : 'AI service error: something unexpected went wrong with the AI request. Retry, or use the built-in engine.';
      card.dataset.kind = isAiError(err) ? err.kind : 'upstream';
      heading.textContent = `${title}: ${isAiError(err) ? err.label : 'Upstream error'}`;
      finish('error', note ? `${text} ${note}` : text);
      rowEls.forEach(r => { if (r.el.dataset.state === 'working' || r.el.dataset.state === 'pending') setRow(r, 'failed'); });
      actions.replaceChildren();
      const lock = isAiError(err) && err.kind === 'ratelimit' ? Math.max(1, Math.min(120, err.retryAfter || 30)) : 0;
      const btns = acts.map(a => {
        const retry = a.retry === true;
        const b = h('button', { type: 'button', class: 'btn sm ' + (a.primary ? 'primary' : 'ghost'), onclick: () => { api.close(); a.fn(); } }, a.label);
        if (lock && retry) b.disabled = true;
        return { b, retry };
      });
      actions.append(...btns.map(x => x.b), h('button', { type: 'button', class: 'btn ghost sm', onclick: () => api.close() }, 'Dismiss'));
      if (lock) {
        let left = lock;
        const paint = () => { msg.textContent = `${text}${note ? " " + note : ""} You can try again in ${left} s.`; };
        paint();
        cdTimer = setInterval(() => {
          left--;
          if (left <= 0) { clearInterval(cdTimer); msg.textContent = note ? `${text} ${note}` : text; btns.forEach(x => { x.b.disabled = false; }); return; }
          paint();
        }, 1000);
      }
      (btns.find(x => !x.b.disabled) || btns[0])?.b.focus?.({ preventScroll: true });
    },
    succeed(text, { autoClose = 3500, actions: acts = [] } = {}) {
      if (closed || ended) return;
      finish('done', text);
      actions.replaceChildren(...acts.map(a => h('button', { type: 'button', class: 'btn sm ' + (a.primary ? 'primary' : 'ghost'), onclick: () => { api.close(); a.fn(); } }, a.label)));
      if (acts.length) actions.append(h('button', { type: 'button', class: 'btn ghost sm', onclick: () => api.close() }, 'Dismiss'));
      else if (autoClose) closeTimer = setTimeout(() => api.close(), autoClose);
    },
    close() {
      if (closed) return;
      closed = true; stopTimers(); clearTimeout(closeTimer);
      if (!ended) { ended = true; ctl.abort(); }
      card.classList.add('out'); setTimeout(() => card.remove(), 200);
    },
  };
  return api;
}
