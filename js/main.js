// Threadform bootstrap (owner: shell)
import { initTooltips } from './util.js';
import { initHeader } from './ui-header.js';
import { initLeft } from './ui-left.js';
import { initStage } from './ui-stage.js';
import { initRight } from './ui-right.js';
import { initBottom } from './ui-bottom.js';
import { refreshEngine } from './ui-actions.js';
import { state } from './state.js';

initTooltips();
const $ = id => document.getElementById(id);
initHeader($('header'));
initLeft($('left'));
initStage($('centre'));
initRight($('right'));
initBottom($('bottom'));
refreshEngine();
window.__threadform = { state };   // handy for debugging / tests
