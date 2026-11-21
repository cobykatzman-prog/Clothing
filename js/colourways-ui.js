// Threadform - colourways panel (right panel tab "Colourways") and the compare / export dialog.
// Every control is a real button / input / select with a text label, so it works with the keyboard and screen readers.
import { state, subscribe, activeView, syncActiveColourway } from './state.js';
import { h, icon, toast } from './util.js';
import { section } from './ui-left.js';
import { openDialog, confirmAction } from './ui-dialog.js';
import { download, downloadAll } from './export.js';
import * as C from './colourways.js';
import { SECTION_LABELS, FABRIC_CHOICES, MAX_COLOURWAYS, specRows, VIEW_IDS } from './colourway-model.js';
import { renderColourwayComposite } from './colourway-render.js';
import { exportColourwayImages, exportComparisonSheet, exportColourwaySpec } from './colourway-export.js';

const HEX = /^#[0-9a-f]{6}$/i;
const dots = cw => {
  const cols = Object.values(cw.views?.front?.parts || cw.views?.[Object.keys(cw.views || {})[0]]?.parts || {}).map(p => p.color).filter(Boolean).slice(0, 6);
  return h('span', { class: 'cw-dots', 'aria-hidden': 'true' }, cols.length ? cols.map(c => h('i', { style: `background:${c}` })) : h('i', { class: 'plain' }));
};

export function colourwaySections() {
  const msg = h('p', { class: 'muted small cw-empty' });
  const list = h('div', { class: 'cw-list', role: 'list', 'aria-label': 'Colourways of this design' });
  const nameIn = h('input', { type: 'text', maxlength: 60, 'aria-label': 'Colourway name', id: 'cw-name', onchange: e => { const a = C.activeColourway(); if (a && !C.renameColourway(a.id, e.target.value)) e.target.value = a.name; } });
  const notes = h('textarea', { rows: 2, maxlength: 1500, id: 'cw-notes', 'aria-label': 'Colourway notes', placeholder: 'Colourway notes, e.g. season, drop, buyer comments', oninput: e => { const a = C.activeColourway(); if (a) C.setColourwayText(a.id, { notes: e.target.value }); } });
  const supplier = h('textarea', { rows: 2, maxlength: 1500, id: 'cw-supplier-notes', 'aria-label': 'Material and supplier notes', placeholder: 'Material and supplier notes for this colourway: mill, lead time, minimums, dye lot', oninput: e => { const a = C.activeColourway(); if (a) C.setColourwayText(a.id, { supplierNotes: e.target.value }); } });
  const addBtn = h('button', { type: 'button', class: 'btn primary sm', id: 'cw-add', onclick: () => { const cw = C.addColourway(); if (cw) { toast('Added "' + cw.name + '". Change its colours and fabrics; the shape stays shared.', 'ok'); setTimeout(() => document.getElementById('cw-name')?.focus(), 30); } else toast('Load a garment first, or remove a colourway (the limit is ' + MAX_COLOURWAYS + ').', 'error'); } }, icon('plus', 15), 'New colourway');
  const cmpBtn = h('button', { type: 'button', class: 'btn ghost sm', id: 'cw-compare', onclick: () => openCompare() }, icon('both', 15), 'Compare & export');
  const detail = h('div', { class: 'cw-detail' }, h('label', { class: 'cw-field' }, h('span', { class: 'lbl' }, 'Name'), nameIn), notes, supplier);
  const secList = section('•', 'Colourways', 'One garment, several colour and fabric versions. The shape sliders and the artwork layout are shared by every colourway; only colours, fabrics and material notes differ.', [
    h('p', { class: 'muted small' }, 'Same garment structure in every colourway. A branch starts as a copy of a colourway and then diverges only in colour, fabric and material notes.'),
    list, msg, h('div', { class: 'row gap wrap' }, addBtn, cmpBtn), detail,
  ], true, 'sec-colourways');

  /* ---- sections editor: colour, fabric and material of one garment section ---- */
  const select = h('select', { id: 'cws-section', 'aria-label': 'Garment section', onchange: e => { state.ui.part = e.target.value; drawSections(); } });   // same part as the Colour panel, without jumping tabs
  const picker = h('input', { type: 'color', id: 'cws-color', 'aria-label': 'Section colour', oninput: e => { if (cur()) C.setSectionColour(cur(), e.target.value); } });
  const hex = h('input', { type: 'text', maxlength: 7, class: 'hex', id: 'cws-hex', 'aria-label': 'Section colour as hex', placeholder: '#rrggbb', oninput: e => { const v = e.target.value.trim(); if (HEX.test(v) && cur()) C.setSectionColour(cur(), v); } });
  const fabric = h('select', { id: 'cws-fabric', 'aria-label': 'Section fabric appearance', onchange: e => { if (cur()) C.setSectionFabric(cur(), e.target.value || null, strength.value / 100); } },
    h('option', { value: '' }, 'Garment fabric (none)'), FABRIC_CHOICES.map(([id, label]) => h('option', { value: id }, label)));
  const strength = h('input', { type: 'range', min: 0, max: 100, step: 5, value: 60, id: 'cws-strength', 'aria-label': 'Section fabric strength', oninput: e => { if (cur() && fabric.value) C.setSectionFabric(cur(), fabric.value, e.target.value / 100); } });
  const strengthOut = h('output', { class: 'val', for: 'cws-strength' }, '60');
  strength.addEventListener('input', () => { strengthOut.textContent = strength.value; });
  const material = h('select', { id: 'cws-material', 'aria-label': 'Material from your library', onchange: e => onMaterial(e.target.value) });
  const useCol = h('input', { type: 'checkbox', id: 'cws-usecol', checked: true });
  const mdetail = h('div', { class: 'cw-mat muted small', id: 'cws-mat-detail' });
  const secSupplier = h('input', { type: 'text', maxlength: 120, id: 'cws-supplier', 'aria-label': 'Supplier for this section', placeholder: 'Supplier or mill', onchange: e => cur() && C.setSectionInfo(cur(), { supplier: e.target.value }) });
  const secNote = h('input', { type: 'text', maxlength: 400, id: 'cws-note', 'aria-label': 'Note for this section', placeholder: 'Note, e.g. rib collar, 1x1 knit, match to Pantone 19-4052', onchange: e => cur() && C.setSectionInfo(cur(), { note: e.target.value }) });
  const clearBtn = h('button', { type: 'button', class: 'btn ghost sm', id: 'cws-clear', onclick: () => cur() && C.clearSection(cur()) }, 'Reset this section');
  const cur = () => (C.sectionAvailable(select.value) ? select.value : null);
  const mats = () => C.libraryMaterials();
  function onMaterial(id) {
    const name = cur(); if (!name) return;
    const m = id ? mats().find(x => x.id === id) : null;
    C.assignMaterial(name, m, { useColour: useCol.checked, amount: strength.value / 100 });
  }
  const secEdit = h('div', { class: 'cw-sec' },
    h('label', { class: 'cw-field' }, h('span', { class: 'lbl' }, 'Garment section'), select),
    h('div', { class: 'row gap center' }, h('span', { class: 'lbl' }, 'Colour'), picker, hex),
    h('div', { class: 'cw-field' }, h('label', { class: 'lbl', for: 'cws-fabric' }, 'Fabric appearance'), fabric,
      h('div', { class: 'row between' }, h('label', { class: 'lbl', for: 'cws-strength' }, 'Weave strength'), strengthOut), strength),
    h('div', { class: 'cw-field' }, h('label', { class: 'lbl', for: 'cws-material' }, 'Material from library'), material,
      h('label', { class: 'cw-check' }, useCol, h('span', {}, 'Use the material colour too')), mdetail),
    h('div', { class: 'cw-field' }, secSupplier, secNote),
    clearBtn,
    h('p', { class: 'muted small' }, 'Sections come from the garment picture. Fabric is a procedural look, not a simulation. Material details are saved with this colourway.'));
  const secSections = section('•', 'Section colours, fabrics and materials', 'Pick a garment section (or click it on the canvas), then give it a colour, a fabric appearance and a material from your library. Applies to the active colourway in every view.', [secEdit], false, 'sec-cw-sections');

  /* ---- drawing ---- */
  function drawList() {
    const L = C.colourwayList(), act = state.colourways.activeId;
    list.replaceChildren(...L.map(cw => {
      const parent = cw.parent && L.find(c => c.id === cw.parent);
      const on = cw.id === act;
      return h('div', { class: 'cw-row' + (on ? ' on' : ''), role: 'listitem', 'data-id': cw.id },
        h('button', { type: 'button', class: 'cw-pick', 'aria-pressed': String(on), 'aria-label': 'Show colourway ' + cw.name + (on ? ' (showing now)' : ''), onclick: () => C.switchTo(cw.id) },
          dots(cw), h('span', { class: 'cw-title' }, h('b', {}, cw.name), parent ? h('small', { class: 'muted' }, 'branched from ' + parent.name) : null), on ? h('span', { class: 'cw-on' }, icon('check', 13), 'Showing') : null),
        h('button', { type: 'button', class: 'icon-btn cw-mini', tip: 'Branch: copy this colourway and change only its colours', 'aria-label': 'Branch ' + cw.name, onclick: () => C.branchFrom(cw.id) }, icon('copy', 15)),
        h('button', { type: 'button', class: 'icon-btn cw-mini', tip: 'Delete this colourway', 'aria-label': 'Delete ' + cw.name, onclick: async () => { if (await confirmAction({ title: 'Delete colourway?', text: '"' + cw.name + '" is removed. The garment shape and artwork are not affected.', ok: 'Delete', danger: true })) C.removeColourway(cw.id); } }, icon('trash', 15)));
    }));
    msg.textContent = L.length ? '' : 'No colourways yet. What you see now becomes the first one when you add a new colourway.';
    msg.hidden = !!L.length;
    const a = C.activeColourway();
    detail.hidden = !a; cmpBtn.disabled = L.length < 1; addBtn.disabled = !Object.values(state.views).some(v => v.base) || L.length >= MAX_COLOURWAYS;
    if (a) {
      if (document.activeElement !== nameIn) nameIn.value = a.name;
      if (document.activeElement !== notes) notes.value = a.notes || '';
      if (document.activeElement !== supplier) supplier.value = a.supplierNotes || '';
    }
  }
  function drawSections() {
    const names = C.availableSections();
    const sig = names.join();
    if (select.dataset.sig !== sig) { select.replaceChildren(...names.map(n => h('option', { value: n }, SECTION_LABELS[n]))); select.dataset.sig = sig; }
    if (document.activeElement !== select) select.value = names.includes(state.ui.part) ? state.ui.part : (names.includes(select.value) ? select.value : (names[0] || ''));
    const none = !names.length;
    for (const el of secEdit.querySelectorAll('input,select,button')) el.disabled = none;
    if (none) return;
    const s = C.sectionState(select.value);
    const val = s.colour || s.current || '#808080';
    if (document.activeElement !== picker) picker.value = val;
    if (document.activeElement !== hex) hex.value = s.colour || '';
    if (document.activeElement !== fabric) fabric.value = s.fabric?.name || '';
    if (document.activeElement !== strength) { strength.value = Math.round((s.fabric?.amount ?? 0.6) * 100); strengthOut.textContent = strength.value; }
    const lib = mats(), have = s.info.material;
    if (document.activeElement !== material) {
      material.replaceChildren(h('option', { value: '' }, lib.length ? 'No material assigned' : 'No materials in your library yet'),
        ...lib.map(m => h('option', { value: m.id }, m.name + (m.supplier ? ' - ' + m.supplier : ''))),
        have && !lib.some(m => m.id === have.id) ? h('option', { value: have.id }, have.name + ' (saved with design)') : null);
      material.value = have ? have.id : '';
    }
    mdetail.replaceChildren(...(have ? [h('i', { class: 'sw', style: `background:${have.color}` }), h('span', {}, [have.name, have.type, have.composition, have.weightGsm ? have.weightGsm + ' gsm' : '', have.supplier, have.sku ? 'SKU ' + have.sku : ''].filter(Boolean).join(' - '))] : [h('span', {}, 'Add fabrics to your library on the home page (Materials).')]));
    if (document.activeElement !== secSupplier) secSupplier.value = s.info.supplier || '';
    if (document.activeElement !== secNote) secNote.value = s.info.note || '';
    clearBtn.disabled = !(s.colour || s.fabric || s.info.material || s.info.note || s.info.supplier);
  }
  const sync = () => { drawList(); drawSections(); };
  subscribe(r => { if (r === 'elements' && state.colourways.list.length) syncActiveColourway(); });   // layer colours belong to the colourway showing
  subscribe(r => { if (['colourways', 'loaded', 'restore', 'view', 'part', 'render', 'color'].includes(r)) sync(); });
  sync();
  C.refreshKitMaterials().then(() => drawSections());
  return { secs: [secList, secSections], sync };
}

/* ------------------------------------------------------------------ compare + export */
export function openCompare() {
  C.ensureBaseline();
  const L = C.colourwayList();
  if (!L.length) { toast('Load a garment first.', 'error'); return null; }
  const chosen = new Set(L.slice(0, 4).map(c => c.id));   // the first four to start with
  let view = activeView().base ? state.activeView : 'front', token = 0;
  const grid = h('div', { class: 'cw-grid', role: 'group', 'aria-label': 'Colourways side by side' });
  const table = h('div', { class: 'cw-spec', role: 'region', 'aria-label': 'Section differences' });
  const status = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
  const checks = h('div', { class: 'cw-checks', role: 'group', 'aria-label': 'Colourways to compare' }, L.map(cw => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(cw.id), 'data-id': cw.id, onchange: e => { if (e.target.checked) chosen.add(cw.id); else chosen.delete(cw.id); draw(); } });
    return h('label', { class: 'cw-check' }, box, h('span', {}, cw.name));
  }));
  const viewSel = h('select', { 'aria-label': 'View to compare', id: 'cwc-view', onchange: e => { view = e.target.value; draw(); } },
    VIEW_IDS.filter(v => state.views[v].base).map(v => h('option', { value: v, selected: v === view }, v[0].toUpperCase() + v.slice(1))));
  const ids = () => L.map(c => c.id).filter(id => chosen.has(id));
  const viewsFor = () => (['front', 'back'].filter(v => state.views[v].base).length ? ['front', 'back'].filter(v => state.views[v].base) : [view]);
  async function draw() {
    const t = ++token, sel = L.filter(c => chosen.has(c.id));
    grid.replaceChildren(...sel.map(cw => h('figure', { class: 'cw-fig', 'data-id': cw.id }, h('div', { class: 'cw-canvas muted small' }, 'Rendering...'), h('figcaption', {}, cw.name))));
    status.textContent = sel.length ? '' : 'Tick at least one colourway.';
    for (const cw of sel) {
      const c = await renderColourwayComposite(view, cw, { live: state.colourways.activeId === cw.id, scale: 0.4, background: '#f3f2ef' });
      if (t !== token) return;
      const slot = grid.querySelector(`[data-id="${cw.id}"] .cw-canvas`);
      if (slot && c) { c.setAttribute('role', 'img'); c.setAttribute('aria-label', cw.name + ', ' + view + ' view'); slot.replaceChildren(c); slot.classList.remove('muted', 'small'); }
    }
    const rows = specRows(sel, view);
    table.replaceChildren(rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Section'), sel.map(c => h('th', { scope: 'col' }, c.name)))),
      h('tbody', {}, rows.map(r => h('tr', {}, h('th', { scope: 'row' }, r.label), r.cells.map(c => h('td', {},
        c.colour ? h('i', { class: 'sw', style: `background:${c.colour}` }) : null,
        h('span', {}, [c.colour, c.material || (c.fabric ? (FABRIC_CHOICES.find(f => f[0] === c.fabric) || [0, c.fabric])[1] : ''), c.supplier].filter(Boolean).join(' - ') || '-')))))))
      : h('p', { class: 'muted small' }, 'No section colours, fabrics or materials set yet. Use "Section colours, fabrics and materials" in the Colourways tab.'));
  }
  const busyWrap = async (fn, okMsg) => { status.textContent = 'Preparing...'; try { await fn(); status.textContent = okMsg; } catch (e) { console.error(e); status.textContent = ''; toast('That export could not be made. Try again with fewer colourways.', 'error', 5000); } };
  const needSel = () => { if (!ids().length) { status.textContent = 'Tick at least one colourway.'; return false; } return true; };
  const actions = [
    h('button', { type: 'button', class: 'btn primary', id: 'cwc-sheet', onclick: () => needSel() && busyWrap(async () => { const b = await exportComparisonSheet(ids(), { views: viewsFor() }); if (b) download(b, 'colourways-sheet.png'); }, 'Comparison sheet downloaded.') }, icon('download', 15), 'Download sheet (PNG)'),
    h('button', { type: 'button', class: 'btn ghost', id: 'cwc-each', onclick: () => needSel() && busyWrap(async () => { await downloadAll(await exportColourwayImages(ids(), { views: viewsFor() })); }, 'One PNG per colourway and view downloaded.') }, 'Each colourway (PNGs)'),
    h('button', { type: 'button', class: 'btn ghost', id: 'cwc-csv', onclick: () => needSel() && busyWrap(async () => { download(new Blob([exportColourwaySpec(ids(), { view })], { type: 'text/csv' }), 'colourways-materials.csv'); }, 'Materials and colour list downloaded.') }, 'Materials list (CSV)'),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => d.close('') }, 'Close'),
  ];
  const d = openDialog({ title: 'Compare colourways', cls: 'cw-wide', body: [
    h('p', { class: 'muted small' }, 'Tick the colourways to compare. All share this design\'s garment shape and artwork layout; only colours, fabrics and materials differ.'),
    h('div', { class: 'row gap wrap center' }, checks, h('label', { class: 'cw-check' }, h('span', {}, 'View'), viewSel)),
    grid, table, status], actions });
  draw();
  return d;
}
