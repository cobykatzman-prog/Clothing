// Shared-library sync helpers (owner: sync): a non-modal banner for "someone else changed this design"
// and the small "Last edited ..." line next to the design name. Text only ever goes in as text nodes.
import { h } from './util.js';
import { timeAgo } from './remote.js';

let bar = null;
/** Shows the banner. buttons: [{label, primary, onclick}]. Not modal and does not take focus. */
export function showBanner(text, buttons = []) {
  if (!bar) {
    bar = h('div', { class: 'sync-banner', role: 'status', 'aria-live': 'polite', hidden: true });
    document.body.append(bar);
  }
  bar.replaceChildren(
    h('span', { class: 'sync-text' }, text),
    h('span', { class: 'sync-btns' }, buttons.map(b => h('button', { type: 'button', class: 'btn sm ' + (b.primary ? 'primary' : 'ghost'), onclick: b.onclick }, b.label))));
  bar.hidden = false;
  document.body.classList.add('has-sync-banner');
}
export function hideBanner() {
  if (bar) bar.hidden = true;
  document.body.classList.remove('has-sync-banner');
}
export const bannerShown = () => !!bar && !bar.hidden;

/** "Last edited by Alice 5 min ago" line; call .set(ms, by) when it changes. Refreshes its own text every 30 s. */
export function lastEditedLine() {
  const el = h('span', { class: 'last-edited', hidden: true });
  let at = 0, by = '';
  const paint = () => { el.hidden = !at; el.textContent = at ? 'Last edited ' + (by ? 'by ' + by + ' ' : '') + timeAgo(at) : ''; };
  setInterval(paint, 30000);
  return { el, set(ms, who) { at = ms || 0; by = who && who !== 'local' ? String(who) : ''; paint(); }, clear() { at = 0; by = ''; paint(); } };
}
