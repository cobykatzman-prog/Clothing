// Left panel: upload, generate, select areas, text, graphics, references.
import { state, activeView, subscribe, notify, snapshot, markFlow } from './state.js';
import { h, icon, thumbOf, toast, setDisabled } from './util.js';
import * as A from './ui-actions.js';
import { selectionSection } from './ui-select.js';
import { createElement, GRAPHIC_LIBRARY, FONTS } from './elements.js';
import { createLayers, addLogo } from './manual.js';
import { SAMPLE_KINDS } from './samples.js';
import { normalizeBrandKit, brandStylePatch } from './brand-kit.js';

const pretty = s => s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const KIND_LABEL = { tee: 'T-shirt', longSleeve: 'Long sleeve', polo: 'Polo', hoodie: 'Hoodie' };

export function section(num, title, tip, body, open = true, id) {
  const d = h('details', { class: 'card', id }, h('summary', {}, h('span', { class: 'num' }, num), h('span', { class: 'ttl' }, title), tip ? h('span', { class: 'hint', tip }, icon('help', 14)) : null, h('span', { class: 'chev' }, icon('chevron', 16))), h('div', { class: 'card-body' }, body));
  if (open) d.open = true;
  return d;
}
export function field(label, input, tip) { return h('label', { class: 'field', tip }, h('span', { class: 'lbl' }, label), input); }

export function initLeft(root) {
  const S = state;
  // ---- 1 Upload ----
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: e => { const f = e.target.files[0]; if (f) A.loadFile(f); e.target.value = ''; } });
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'button', 'aria-label': 'Upload a garment image', onclick: () => fileIn.click(), onkeydown: e => { if (e.key === 'Enter') fileIn.click(); } },
    icon('upload', 26), h('b', {}, 'Drop a photo here'), h('span', {}, 'or click to browse · PNG, JPG, WEBP'));
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) A.loadFile(f); });
  const viewHint = h('div', { class: 'muted small' });
  const sec1 = section(1, 'Upload image', 'Upload a clean photo or flat-lay of a garment. The background is removed automatically.', [
    drop, fileIn, viewHint,
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn ghost sm', tip: 'Try the editor with a built-in sample garment', onclick: () => A.loadSample('tee') }, icon('sparkles', 15), 'Try a sample shirt'),
      h('button', { class: 'btn ghost sm', id: 'btn-club-sample', tip: 'A cream club shirt with a crest, stripes and back artwork baked into the photo (front and back)', onclick: () => A.loadClubSample() }, icon('layers', 15), 'Club Élite test shirt'),
      h('button', { class: 'btn ghost sm', id: 'btn-removebg', tip: 'Cut the garment out of its background again', onclick: () => A.removeBg() }, icon('scissors', 15), 'Remove background')),
  ], true, 'sec-upload');

  // ---- 2 Generate ----
  let kind = 'tee';
  const kinds = (SAMPLE_KINDS || ['tee', 'longSleeve', 'polo', 'hoodie']);
  const kindBtns = kinds.map(k => h('button', { class: 'chip' + (k === kind ? ' on' : ''), 'data-k': k, onclick: () => { kind = k; kindBtns.forEach(b => b.classList.toggle('on', b.dataset.k === k)); } }, KIND_LABEL[k] || pretty(k)));
  const colorIn = h('input', { type: 'color', value: '#6f8fb5', 'aria-label': 'Garment colour' });
  const stripeIn = h('input', { type: 'checkbox' });
  const genPrompt = h('textarea', { rows: 2, placeholder: 'e.g. navy hoodie with white stripes', 'aria-label': 'Describe a garment to generate' });
  const genLabel = h('span', {}, 'Generate garment');
  const genStatus = h('div', { class: 'muted small gen-status', role: 'status', 'aria-live': 'polite' });
  const genBtn = h('button', { class: 'btn primary sm', onclick: () => runGenerate() }, icon('sparkles', 15), genLabel);
  const runGenerate = async () => {
    if (genBtn.disabled) return;
    genBtn.disabled = true; genLabel.textContent = 'Generating…'; genStatus.textContent = '';
    try {
      const r = await A.generateFromPrompt(genPrompt.value, { defaultKind: kind, defaultColor: colorIn.value, addStripes: stripeIn.checked });
      genStatus.textContent = r.message || (r.ok ? 'Garment generated.' : 'Could not generate the garment. Try a simpler description or use a sample.');
      genStatus.dataset.state = r.ok ? 'success' : 'error';
      if (r.spec) { // keep "Use sample" in step with what was just generated
        kind = r.spec.kind; kindBtns.forEach(b => b.classList.toggle('on', b.dataset.k === kind));
        colorIn.value = r.spec.color;
      }
    } catch (e) {
      console.error(e);
      genStatus.textContent = 'Generation failed. Try a simpler description or use a sample garment.';
      toast('The garment could not be generated. Your current design has been left unchanged.', 'error', 5000);
    } finally { genBtn.disabled = false; genLabel.textContent = 'Generate garment'; }
  };
  genPrompt.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runGenerate(); });
  const sec2 = section(2, 'Generate garment', 'Describe a garment and the editor builds front, back, side and detail views of it at once. The built-in generator runs in your browser; if AI editing is on, AI makes the front and Threadform builds matching back, side and detail views.', [
    h('div', { class: 'chips' }, kindBtns),
    h('div', { class: 'row gap center' }, field('Colour', colorIn), h('label', { class: 'check' }, stripeIn, 'Stripes')),
    genPrompt,
    genStatus,
    h('div', { class: 'row gap wrap' },
      genBtn,
      h('button', { class: 'btn ghost sm', tip: 'Draw the chosen sample shape in the chosen colour', onclick: () => A.loadSample(kind, { color: colorIn.value, stripe: stripeIn.checked }, S.views[S.activeView].base ? S.activeView : null) }, 'Use sample')),
  ], true, 'sec-generate');

  // ---- 3 Select (tools, modes, modify, refine, history, overlay, saved selections: ui-select.js) ----
  const sec3 = selectionSection({ section });

  // ---- 4 Text ----
  const txt = h('input', { type: 'text', value: 'ATHENS', maxlength: 40, 'aria-label': 'Text to add' });
  const font = h('select', { 'aria-label': 'Font' }, ...FONTS.map(f => h('option', { value: f.value }, f.label)));
  const tcol = h('input', { type: 'color', value: '#1d1d1f', 'aria-label': 'Text colour' });
  const sec4 = section(4, 'Add text', 'Adds editable text. Drag it on the canvas; use the corner handles to resize and the top handle to rotate.', [
    txt, h('div', { class: 'row gap center' }, font, tcol),
    h('button', { class: 'btn primary sm', onclick: () => addEl('text', { text: txt.value || 'Text', color: tcol.value, font: font.value }) }, icon('type', 15), 'Add text'),
  ], false, 'sec-text');

  // ---- 5 Graphics ----
  const lib = GRAPHIC_LIBRARY;
  const gcol = h('input', { type: 'color', value: '#c0392b', 'aria-label': 'Trim colour' });
  const logoIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', hidden: true, 'aria-label': 'Choose a logo image', onchange: e => {
    const f = e.target.files?.[0]; e.target.value = ''; if (f) addLogo(f);
  } });

  const libGrid = h('div', { class: 'gfx' }, lib.map(g => {
    const b = h('button', { class: 'gfx-item', tip: g.name, 'aria-label': 'Add ' + g.name, onclick: () => {
      const type = g.category === 'crest' ? 'crest' : g.category === 'patch' ? 'patch' : 'graphic';
      addEl(type, g.category === 'stripes' ? { graphicId: g.id, w: 360, h: 170 } : { graphicId: g.id });
    } });
    b.innerHTML = (g.svg || '').replace(/\{\{(c\d)\}\}/g, (_, k) => g.colors?.[k] || '#888');
    return b;
  }));
  const sec5 = section(5, 'Add graphics', 'Add your own logo or choose editable crests, stripes, piping and patches.', [
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn primary sm', tip: 'Upload a transparent PNG, JPG, WebP or SVG logo and place it on the garment', onclick: () => logoIn.click() }, icon('image', 15), 'Upload logo…'),
      logoIn),
    libGrid,
    h('div', { class: 'row gap center' }, field('Colour', gcol)),
    h('div', { class: 'chips' },
      h('button', { class: 'chip', onclick: () => addEl('stripe', { color: gcol.value }) }, 'Stripes'),
      h('button', { class: 'chip', onclick: () => addEl('piping', { color: gcol.value }) }, 'Piping'),
      h('button', { class: 'chip', onclick: () => addEl('patch', { bg: gcol.value }) }, 'Patch')),
  ], false, 'sec-graphics');
  function addEl(type, props) {
    const V = activeView();
    if (!V.current) { toast('Load a garment first.', 'info'); return; }
    snapshot();
    const b = V.seg?.bbox;
    const pos = b ? { x: b.x + b.w / 2, y: b.y + b.h * (type === 'text' ? 0.45 : 0.4) } : {};
    const el = createElement(type, { ...props, ...pos, view: S.activeView });
    S.elements.push(el); S.selectedId = el.id; S.ui.tool = 'move';
    markFlow('refined'); notify('elements');
  }


  // ---- Brand kit: reuse saved logos, colours and type styles on new garment elements ----
  const BRAND_KEY = 'threadform.brand-kit.v1';
  let brandKit;
  try { brandKit = normalizeBrandKit(JSON.parse(localStorage.getItem(BRAND_KEY) || '{}')); }
  catch { brandKit = normalizeBrandKit({ palette: [] }); }
  async function addBrandLogo(dataUrl, slot) {
    if (!dataUrl) return;
    try {
      const comma = dataUrl.indexOf(',');
      if (!dataUrl.startsWith('data:') || comma < 0) throw new Error('Invalid saved logo');
      const header = dataUrl.slice(0, comma), payload = dataUrl.slice(comma + 1);
      const mime = (header.match(/^data:([^;,]+)/) || [])[1] || 'image/png';
      const bytes = header.includes(';base64')
        ? Uint8Array.from(atob(payload), ch => ch.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(payload));
      const ext = mime === 'image/svg+xml' ? 'svg' : mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : 'png';
      await addLogo(new File([new Blob([bytes], { type: mime })], 'brand-' + slot + '.' + ext, { type: mime }));
    } catch (err) { toast('That saved brand logo could not be added. Try uploading it again in Brand Kit.', 'error', 5000); }
  }
  function applyBrandStyle(patch) {
    const selected = S.elements.find(el => el.id === S.selectedId);
    if (!selected) { toast('Select a text or graphic layer first.', 'info'); return; }
    const next = brandStylePatch(selected, patch);
    if (!next) { toast(selected.type === 'logo' ? 'Image logos can be moved and resized, but their pixels cannot be recoloured here.' : 'That style cannot be applied to the selected layer.', 'info'); return; }
    snapshot();
    selected.props = { ...selected.props, ...next };
    notify('elements'); markFlow('refined');
    toast('Brand style applied to ' + (selected.name || selected.type) + '.', 'ok');
  }
  function applyBrandFont(family, toSelected = false) {
    const wanted = String(family || 'Arial').toLowerCase();
    let option = [...font.options].find(o => o.textContent.toLowerCase().includes(wanted) || o.value.toLowerCase().includes(wanted));
    if (!option) {
      option = h('option', { value: family + ', sans-serif' }, family + ' (Brand Kit)');
      font.append(option);
    }
    font.value = option.value;
    if (toSelected) applyBrandStyle({ font: font.value });
  }
  const logoSlots = [
    ['primary', 'Primary logo'], ['alternate', 'Alternate logo'], ['mark', 'Icon / mark'],
  ].filter(([key]) => brandKit.logos?.[key]);
  const brandLogos = logoSlots.length
    ? h('div', { class: 'brand-editor-logos' }, logoSlots.map(([key, label]) => h('button', {
        type: 'button', class: 'brand-editor-logo', onclick: () => addBrandLogo(brandKit.logos[key], key),
        tip: 'Add ' + label.toLowerCase() + ' to the active garment view',
      }, h('img', { src: brandKit.logos[key], alt: label }), h('span', {}, label))))
    : h('p', { class: 'muted small' }, 'No logos saved yet. Add them in Brand Kit on the gallery page.');
  const brandColours = (brandKit.palette || []).slice(0, 12);
  const brandPalette = brandColours.length
    ? h('div', { class: 'brand-editor-palette' }, brandColours.map(item => h('div', { class: 'brand-editor-colour-row' },
        h('button', {
          type: 'button', class: 'brand-editor-colour', onclick: () => {
            tcol.value = item.color; gcol.value = item.color;
            toast(item.name + ' set for new text and graphics.', 'ok', 1800);
          }, tip: 'Use ' + item.name + ' for new text and graphics',
        }, h('i', { style: 'background:' + item.color }), h('span', {}, item.name)),
        h('button', { type: 'button', class: 'btn ghost sm brand-editor-apply', onclick: () => applyBrandStyle({ color: item.color }), tip: 'Apply this colour to the selected editable layer' }, 'Apply to selected'))))
    : h('p', { class: 'muted small' }, 'No saved colours yet.');
  const secBrand = section('•', 'Brand kit assets', 'Use your saved brand logos, colour palette and typography without uploading them again.', [
    brandKit.name ? h('div', { class: 'brand-editor-heading' }, h('b', {}, brandKit.name),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { txt.value = brandKit.name; addEl('text', { text: brandKit.name, color: tcol.value, font: font.value }); } }, 'Add brand name')) : null,
    h('div', { class: 'lbl' }, 'Saved logos'), brandLogos,
    h('div', { class: 'lbl' }, 'Colour palette'), brandPalette,
    h('div', { class: 'lbl' }, 'Typography'),
    h('div', { class: 'row gap wrap' },
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => applyBrandFont(brandKit.typography?.heading) }, 'Use heading font'),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => applyBrandFont(brandKit.typography?.heading, true) }, 'Apply to selected text'),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => applyBrandFont(brandKit.typography?.body) }, 'Use body font'),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => applyBrandFont(brandKit.typography?.body, true) }, 'Apply to selected text')),
    h('p', { class: 'muted small' }, 'Use applies to new elements. Apply to selected updates the selected editable text/graphic layer and can be undone. Raster logo images cannot be recoloured. Brand assets remain stored in this browser and are not synced to other devices.'),
  ], false, 'sec-brand-kit');

  // layers list (top of the stack first; drag to reorder; the inspector for the selected item is in the right panel)
  const layers = createLayers();
  const secEl = section('•', 'Layers on this view', 'Everything you added, top of the stack first. Click to select, drag to reorder.', layers.el, true, 'sec-layers');
  secEl.classList.add('compact');

  // ---- 6 References ----
  const refIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: e => { A.addReferences([...e.target.files]); e.target.value = ''; } });
  const refGrid = h('div', { class: 'refs' });
  const sec6 = section(6, 'References', 'Keep mood-board images (a fabric, a hem, a colour palette) next to your design. ' + (document.querySelector('meta[name="threadform-shared"][content="1"]') ? 'They are saved with the design in the shared library, so everyone who has the password sees them.' : 'They are saved with the design in this browser and never uploaded.'), [
    h('button', { class: 'btn ghost sm', onclick: () => refIn.click() }, icon('plus', 15), 'Add reference images'), refIn, refGrid,
    h('div', { class: 'muted small' }, 'For your own reference while you design; they do not change the garment.'),
  ], false, 'sec-refs');

  sec3.dataset.level = sec6.dataset.level = secEl.dataset.level = 'advanced';   // Basic mode hides them (CSS), Advanced shows them
  root.append(sec1, sec2, sec3, sec4, sec5, secBrand, secEl, sec6);

  function sync(reason) {
    const V = activeView();
    const has = !!V.base;
    if (reason === 'loaded') { document.getElementById('sec-upload').open = false; document.getElementById('sec-select').open = true; }
    viewHint.textContent = has ? `Editing the ${state.activeView} view. Use the tabs above the canvas for other views.` : `Uploading to the ${state.activeView} view.`;
    setDisabled(root.querySelector('#btn-removebg'), !has, 'Load a garment first, then you can cut it out of its background again.');
    refGrid.replaceChildren(...S.references.map((c, i) => h('div', { class: 'ref' }, thumbOf(c, 64, '#f3f2ef'), h('button', { class: 'x', 'aria-label': 'Remove reference', onclick: () => A.removeReference(i) }, icon('x', 12)))));
  }
  subscribe(r => { if (r !== 'render' && r !== 'zoom' && r !== 'processing' && r !== 'busy' && r !== 'elements-live') sync(r); });
  sync();
  return { sync };
}
