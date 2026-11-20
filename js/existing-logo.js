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
function sampledInkColour(canvas, alpha) {
  const data = canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
  let rr = 0, gg = 0, bb = 0, total = 0;
  for (let i = 0, p = 0; i < alpha.length; i++, p += 4) {
    const a = alpha[i]; if (a < 96 || data[p + 3] < 32) continue;
    rr += data[p] * a; gg += data[p + 1] * a; bb += data[p + 2] * a; total += a;
  }
  if (!total) return '#202020';
  return '#' + [rr, gg, bb].map(v => Math.round(v / total).toString(16).padStart(2, '0')).join('');
}

async function separateExistingArtwork(replacementText = null) {
  const V = activeView();
  if (!V.current || !V.mask) { toast('Load a garment and select its logo first.', 'info'); return; }
  if (!useAi()) { toast('Switch on AI in the AI settings first. AI is needed to clean the fabric behind the logo.', 'info', 5000); return; }
  const alpha = SEL.readAlpha(V.mask);
  const bounds = SEL.eng.bounds(alpha);
  if (!bounds || !bounds.w || !bounds.h) { toast('Select the logo first using Smart select, Lasso or Brush.', 'info'); return; }

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

    const artworkEl = replacementText
      ? createElement('print', {
          text: replacementText, color: sampledInkColour(V.current, alpha),
          size: Math.max(16, Math.min(120, bounds.h * 0.72)),
          view: state.activeView, x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2,
          w: bounds.w, h: bounds.h,
        })
      : createElement('logo', {
          image: logo.canvas.toDataURL('image/png'), view: state.activeView,
          x: logo.x + logo.w / 2, y: logo.y + logo.h / 2, w: logo.w, h: logo.h,
        });
    artworkEl.name = replacementText ? 'Editable replacement text' : 'Extracted logo';
    snapshot();
    state.elements.push(patchEl, artworkEl);
    state.selectedId = artworkEl.id;
    state.ui.tool = 'move';
    markFlow('refined');
    notify('elements');
    toast(replacementText ? 'Text replaced with an editable text layer. Select it to change wording, font, size and colour.' : 'Logo separated. Drag, resize or rotate it; the original spot has been patched.', 'ok', 6500);
  } catch (e) {
    toast(friendly(e, 'Could not separate that logo. Try a tighter selection and try again.'), 'error', 6000);
  } finally {
    state.ui.busy = Math.max(0, state.ui.busy - 1);
    notify('busy');
  }
}


export async function extractExistingLogo() { return separateExistingArtwork(null); }
export async function replaceExistingText(text) {
  const value = String(text || '').trim();
  if (!value) { toast('Enter the replacement wording first.', 'info'); return; }
  return separateExistingArtwork(value);
}
