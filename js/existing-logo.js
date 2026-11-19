// Extract an existing printed logo from the garment photo into its own movable layer.
// A second, feathered AI-cleaned patch stays behind to cover the logo's original position.
import { state, activeView, snapshot, notify, markFlow } from './state.js';
import { SIZE, makeCanvas, toast, friendly } from './util.js';
import { createElement } from './elements.js';
import { aiEdit, useAi } from './ai.js';
import * as SEL from './selection.js';

function cropWithAlpha(source, alpha, bounds) {
  const x = Math.max(0, Math.floor(bounds.x)), y = Math.max(0, Math.floor(bounds.y));
  const w = Math.min(SIZE - x, Math.ceil(bounds.w)), h = Math.min(SIZE - y, Math.ceil(bounds.h));
  if (w < 2 || h < 2) throw new Error('Select a larger area around the logo.');
  const out = makeCanvas(w, h), mask = makeCanvas(SIZE, SIZE);
  const mx = mask.getContext('2d'), id = mx.createImageData(SIZE, SIZE);
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    id.data[j] = id.data[j + 1] = id.data[j + 2] = 255;
    id.data[j + 3] = alpha[i];
  }
  mx.putImageData(id, 0, 0);
  const ctx = out.getContext('2d');
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, -x, -y);
  return { canvas: out, x, y, w, h };
}

/** Turn the active pixel selection into a movable logo, and cover its old position. */
export async function extractExistingLogo() {
  const V = activeView();
  if (!V.current || !V.mask) { toast('Load a garment and select its logo first.', 'info'); return; }
  if (!useAi()) { toast('Switch on AI in the AI settings first. AI is needed to clean the fabric behind the logo.', 'info', 5000); return; }
  const alpha = SEL.readAlpha(V.mask);
  const bounds = SEL.eng.bounds(alpha);
  if (!bounds || !bounds.w || !bounds.h) { toast('Select the logo first using Smart select, Lasso or Brush.', 'info'); return; }

  let stop;
  try {
    state.ui.busy++; state.ui.busyMsg = 'Separating logo and restoring fabric…'; notify('busy');
    // Keep a little fabric around the selection so the removal patch can blend naturally.
    const pad = Math.max(10, Math.min(30, Math.round(Math.max(bounds.w, bounds.h) * 0.12)));
    const expanded = SEL.eng.expand(alpha, pad);
    const soft = SEL.eng.feather(expanded, Math.max(4, Math.round(pad * 0.45)));
    const cleaned = await aiEdit({
      image: V.current,
      mask: V.mask,
      prompt: 'Remove only the selected logo, lettering or printed graphic from this garment. Reconstruct the fabric underneath so it looks like the same original material, preserving its weave, folds, lighting, shadows, seams, texture and garment shape. Do not add any new text, symbols, logos or decorations. Keep everything outside the selected area unchanged.',
      constraints: { keep: ['the garment shape, fabric texture, folds, lighting, seams and all unselected details'], avoid: ['new logos', 'new text', 'new graphics', 'changing garment colour or shape'] },
      view: state.activeView, level: 'medium',
    });
    const logo = cropWithAlpha(V.current, alpha, bounds);
    const patchBounds = SEL.eng.bounds(soft);
    if (!patchBounds) throw new Error('Could not prepare the logo removal area.');
    const patch = cropWithAlpha(cleaned.canvas, soft, patchBounds);

    const patchEl = createElement('logo', {
      image: patch.canvas.toDataURL('image/png'), view: state.activeView,
      x: patch.x + patch.w / 2, y: patch.y + patch.h / 2, w: patch.w, h: patch.h,
    });
    patchEl.name = 'Original logo cleanup';
    patchEl.locked = true;

    const logoEl = createElement('logo', {
      image: logo.canvas.toDataURL('image/png'), view: state.activeView,
      x: logo.x + logo.w / 2, y: logo.y + logo.h / 2, w: logo.w, h: logo.h,
    });
    logoEl.name = 'Extracted logo';
    snapshot();
    state.elements.push(patchEl, logoEl);
    state.selectedId = logoEl.id;
    state.ui.tool = 'move';
    markFlow('refined');
    notify('elements');
    toast('Logo separated. Drag, resize or rotate it; the original spot has been patched.', 'ok', 6000);
  } catch (e) {
    toast(friendly(e, 'Could not separate that logo. Try a tighter selection and try again.'), 'error', 6000);
  } finally {
    state.ui.busy = Math.max(0, state.ui.busy - 1);
    notify('busy');
  }
}
