// Small screens: the Tools (left) and Edit (right) panels become sheets that slide up from a dock in the bottom bar,
// so the garment canvas keeps the screen. On wide screens the dock is hidden and the header panel toggles are used.
import { state, subscribe } from './state.js';
import { h, icon } from './util.js';

export function initDock(bottom) {
  const btns = {};
  const set = pane => {
    if (pane) document.body.dataset.pane = pane; else delete document.body.dataset.pane;
    for (const [k, b] of Object.entries(btns)) b.setAttribute('aria-expanded', String(k === pane));
  };
  const mk = (pane, label, ic, tip) => {
    const dot = h('i', { class: 'dot', hidden: true, 'aria-hidden': 'true' });
    const b = h('button', { type: 'button', class: 'dock-btn', id: 'dock-' + pane, 'aria-controls': pane === 'left' ? 'left' : 'right', 'aria-expanded': 'false', tip, onclick: () => set(document.body.dataset.pane === pane ? null : pane) }, icon(ic, 16), label, dot);
    b._dot = dot; btns[pane] = b; return b;
  };
  const dock = h('div', { class: 'dock', role: 'group', 'aria-label': 'Panels' }, mk('left', 'Tools', 'tools', 'Add text and graphics, upload or generate a garment'), mk('right', 'Edit', 'panel', 'Describe changes, colour, shape and the selected item'));
  bottom.prepend(dock);
  const syncH = () => document.documentElement.style.setProperty('--bottom-h', bottom.getBoundingClientRect().height + 'px');
  new ResizeObserver(syncH).observe(bottom); syncH();
  subscribe(r => { if (r === 'selection' || r === 'elements' || r === 'restore') btns.right._dot.hidden = !state.selectedId; });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.dataset.pane && !document.querySelector('dialog[open]')) set(null); });
  window.addEventListener('hashchange', () => set(null));
  return { set };
}
