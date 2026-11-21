// Roadmap v2 phase 7: colourways, branching with shared structure, per-section colour / fabric / material, notes,
// persistence, compare side by side and export. Run: node test/colourways.browser.test.cjs
// Served with the production CSP headers (test/e2e/lib.cjs); JS errors, failed requests or CSP violations fail it.
const { chromium } = require('playwright');
const fs = require('fs');
const L = require('./e2e/lib.cjs');
const R = L.runner('colourways');
const { ok } = R;

const MATERIALS = [
  { id: 'm-rib', name: 'Rib 1x1 cotton', type: 'Rib knit', color: '#1e3a8a', composition: '95% cotton 5% elastane', weightGsm: 260, supplier: 'Mill North', sku: 'RIB-260' },
  { id: 'm-denim', name: 'Raw denim 12oz', type: 'Denim', color: '#27384f', supplier: 'Denim Co' },
];

(async () => {
  const { srv, url } = await L.staticServer();
  const browser = await chromium.launch();
  const errs = [];
  const noErrors = label => { ok(errs.length === 0, `${label}: no JS errors / failed requests / CSP violations ${JSON.stringify(errs.slice(0, 3))}`); errs.length = 0; };
  const { ctx, page } = await L.newPage(browser, { width: 1440, height: 900 });
  await ctx.addInitScript(m => { try { if (!localStorage.getItem('threadform.materials.v1')) localStorage.setItem('threadform.materials.v1', JSON.stringify(m)); } catch {} }, MATERIALS);
  L.watch(page, errs);
  const settle = () => L.T(page).settle();
  const shot = n => page.screenshot({ path: `${L.OUT}/colourways-${n}.png` });
  const S = fn => page.evaluate(fn);
  // a cheap fingerprint of the front garment picture
  const hash = view => page.evaluate(v => { const c = window.__threadform.state.views[v].current, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let a = 0, b = 0; for (let i = 0; i < d.length; i += 4) { a = (a + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 1000003; b = (b + (i % 977) * d[i + 3] + d[i]) % 999983; } return a + ':' + b; }, view);

  await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])');
  await page.click('#home >> text=Try a sample shirt');
  await page.waitForFunction(() => window.__threadform.state.views.front.current);
  await settle(); await page.waitForTimeout(400);
  const designUrl = page.url();

  /* ---------------------------------------------------------------- panel and first colourways */
  R.section('colourways panel');
  await page.click('#rtab-colourways');
  ok(await page.isVisible('#sec-colourways'), 'Colourways tab shows the Colourways card');
  ok(await page.locator('#cw-add').isEnabled(), 'New colourway is enabled once a garment is loaded');
  ok((await page.locator('.cw-row').count()) === 0, 'no colourways exist before the first one is added (documents without colourways stay unchanged)');
  const baseDoc = await S(async () => (await import('/js/state.js')).state.colourways.list.length);
  ok(baseDoc === 0, 'state has no colourways yet');
  const h0 = await hash('front');
  await page.click('#cw-add');
  ok((await page.locator('.cw-row').count()) === 2, 'adding the first colourway keeps the current look as Colourway 1 and adds Colourway 2');
  const names = await page.locator('.cw-row .cw-title b').allTextContents();
  ok(names[0] === 'Colourway 1' && names[1] === 'Colourway 2', 'names ' + names);
  ok(await page.locator('.cw-row.on .cw-title b').textContent() === 'Colourway 2', 'new colourway is the one showing');
  ok(await page.locator('.cw-row.on').getAttribute('data-id') === await S(() => window.__threadform.state.colourways.activeId), 'active row matches state');
  ok(await page.locator('.cw-row.on .cw-title small').textContent() === 'branched from Colourway 1', 'branch lineage is shown');
  await page.fill('#cw-name', 'Navy collar'); await page.press('#cw-name', 'Tab');
  ok((await S(() => window.__threadform.state.colourways.list[1].name)) === 'Navy collar', 'rename works');
  ok(await hash('front') === h0, 'a fresh branch looks identical to its parent');

  /* ---------------------------------------------------------------- section colour, shared shape */
  R.section('section colour, fabric, material');
  await page.click('#sec-cw-sections > summary');
  const opts = await page.locator('#cws-section option').allTextContents();
  ok(opts.length >= 3, 'garment sections come from the picture: ' + opts.join('/'));
  const secIds = await page.locator('#cws-section option').evaluateAll(o => o.map(x => x.value));
  const pick = secIds.includes('collar') ? 'collar' : secIds.find(x => x !== 'body');
  const pick2 = secIds.find(x => x !== pick && x !== 'body') || 'body';
  await page.selectOption('#cws-section', pick);
  await page.fill('#cws-hex', '#1e3a8a'); await settle();
  ok(await S(() => window.__threadform.state.views.front.parts) && (await S(() => Object.values(window.__threadform.state.views.front.parts).some(p => p.color === '#1e3a8a'))), 'section colour set on the front view');
  ok(await hash('front') !== h0, 'the section colour changes the picture');
  const backHas = await S(() => { const v = window.__threadform.state.views.back; return v.base ? Object.values(v.parts || {}).some(p => p.color === '#1e3a8a') : null; });
  ok(backHas !== false, 'the section colour also reaches the back view when it has that section');
  const hNavy = await hash('front');
  await S(async () => { const A = await import('/js/ui-actions.js'); A.setParam('bodyWidth', 30); });
  await settle(); await page.waitForTimeout(300);
  const hNavyWide = await hash('front');
  // switch back to colourway 1 (original look): shape stays, colour goes
  await page.click('.cw-row[data-id] >> nth=0 >> .cw-pick'); await settle();
  const p1 = await S(() => { const s = window.__threadform.state; return { params: s.views.front.params.bodyWidth, active: s.colourways.list.find(c => c.id === s.colourways.activeId).name, parts: Object.keys(s.views.front.parts).length }; });
  ok(p1.active === 'Colourway 1' && p1.parts === 0, 'switching shows Colourway 1 without the section colour');
  ok(p1.params === 30, 'the shape change made in colourway 2 is shared: Colourway 1 has it too');
  const hC1 = await hash('front');
  ok(hC1 !== hNavyWide, 'colourways differ in colour');
  await page.click('.cw-row >> nth=1 >> .cw-pick'); await settle(); await page.waitForTimeout(200);
  ok(await hash('front') === hNavyWide, 'switching back reproduces the navy colourway exactly');
  ok(hNavy !== hNavyWide, 'shape change changed the picture (sanity)');

  // fabric appearance for a section
  await page.selectOption('#cws-section', pick2);
  const hBeforeFab = await hash('front');
  await page.selectOption('#cws-fabric', 'denim'); await settle(); await page.waitForTimeout(200);
  ok(await hash('front') !== hBeforeFab, 'section fabric appearance changes the picture');
  ok((await S(() => Object.values(window.__threadform.state.views.front.parts).some(p => p.fabric && p.fabric.name === 'denim'))), 'fabric is stored on the section');
  await page.locator('#cws-strength').fill('100'); await settle();
  ok((await S(() => Object.values(window.__threadform.state.views.front.parts).some(p => p.fabric && p.fabric.amount === 1))), 'weave strength editable');

  // material from the library on the collar
  await page.selectOption('#cws-section', pick);
  ok((await page.locator('#cws-material option').count()) === 3, 'library materials are offered (' + (await page.locator('#cws-material option').allTextContents()).join(' | ') + ')');
  await page.selectOption('#cws-material', 'm-rib'); await settle(); await page.waitForTimeout(200);
  const sec = await S(() => { const s = window.__threadform.state, c = s.colourways.list.find(x => x.id === s.colourways.activeId); return { cw: c.sections, parts: s.views.front.parts }; });
  const secKey = pick;
  ok(sec.cw[secKey]?.material?.name === 'Rib 1x1 cotton' && sec.cw[secKey].material.supplier === 'Mill North', 'material details are saved with the colourway section');
  ok(sec.parts[secKey]?.fabric?.name === 'knit' && sec.parts[secKey].color === '#1e3a8a', 'material gives the section its weave and colour');
  await page.fill('#cws-note', 'Match rib to body dye lot'); await page.press('#cws-note', 'Tab');
  await page.fill('#cw-supplier-notes', 'Mill North: 4 week lead time, MOQ 300 m'); await page.fill('#cw-notes', 'Autumn drop');
  ok(await page.locator('#cws-mat-detail').textContent().then(t => /Rib 1x1 cotton/.test(t) && /RIB-260/.test(t)), 'material specification shown');
  await shot('panel');
  await page.evaluate(() => document.getElementById('sec-colourways').scrollIntoView());
  await shot('panel-top');

  /* ---------------------------------------------------------------- branch */
  R.section('branch');
  await page.click('.cw-row.on .cw-mini >> nth=0'); await settle();
  ok((await page.locator('.cw-row').count()) === 3, 'branch adds a third colourway');
  const br = await S(() => { const s = window.__threadform.state, c = s.colourways.list, a = c.find(x => x.id === s.colourways.activeId), p = c.find(x => x.id === a.parent); return { a: a.name, p: p && p.name, sec: JSON.stringify(a.sections) === JSON.stringify(p.sections), same: JSON.stringify(a.views.front.parts) === JSON.stringify(p.views.front.parts) }; });
  ok(br.p === 'Navy collar' && br.sec, 'branch keeps lineage and material notes of its parent');
  await S(() => document.getElementById('cws-section')); await page.selectOption('#cws-section', pick); await page.fill('#cws-hex', '#b91c1c'); await settle();
  const par = await S(() => { const s = window.__threadform.state, c = s.colourways.list; return { parent: c[1].views.front.parts, branch: c[2].views.front.parts }; });
  ok(par.parent[pick]?.color === '#1e3a8a', 'changing the branch does not touch its parent (stored copy)');
  await page.click('.cw-row >> nth=1 >> .cw-pick'); await settle(); await page.waitForTimeout(200);
  ok(await page.evaluate(k => window.__threadform.state.views.front.parts[k]?.color, pick) === '#1e3a8a', 'parent still navy after the branch changed');

  /* ---------------------------------------------------------------- layer colours per colourway + undo */
  R.section('layer colours and undo');
  const stripeId = await S(async () => { const E = await import('/js/elements.js'), St = await import('/js/state.js'); const el = E.createElement('stripe', { view: 'front' }); St.snapshot(); St.state.elements.push(el); St.notify('elements'); return el.id; });
  await settle();
  await page.click('.cw-row >> nth=2 >> .cw-pick'); await settle();
  await S(async () => { const E = await import('/js/elements.js'), St = await import('/js/state.js'); const el = St.state.elements.find(e => e.type === 'stripe'); St.snapshot(); E.updateElement(el, { color: '#16a34a' }); St.notify('elements'); });
  await page.click('.cw-row >> nth=1 >> .cw-pick'); await settle();
  const sc1 = await S(() => window.__threadform.state.elements.find(e => e.type === 'stripe').props.color);
  await page.click('.cw-row >> nth=2 >> .cw-pick'); await settle();
  const sc2 = await S(() => window.__threadform.state.elements.find(e => e.type === 'stripe').props.color);
  ok(sc2 === '#16a34a' && sc1 !== sc2, `stripe colour belongs to the colourway (${sc1} vs ${sc2})`);
  const before = await S(() => window.__threadform.state.colourways.activeId);
  await page.click('.cw-row >> nth=0 >> .cw-pick'); await settle();
  await page.keyboard.press('Control+z'); await settle(); await page.waitForTimeout(200);
  ok(await S(() => window.__threadform.state.colourways.activeId) === before, 'Undo reverts a colourway switch, including which colourway is showing');
  ok(await page.evaluate(k => window.__threadform.state.views.front.parts[k]?.color, pick) === '#b91c1c', 'undo restores the previous colourway look');
  void stripeId;

  /* ---------------------------------------------------------------- persistence */
  R.section('save and reload');
  await page.waitForTimeout(1500);   // autosave debounce is 900 ms
  await page.waitForFunction(() => /Saved/.test(document.querySelector('.save-status')?.textContent || ''), null, { timeout: 20000 });
  const doc = await S(async () => { const St = await import('/js/state.js'); const { doc } = await St.serializeDesign(); return { cw: doc.colourways, size: JSON.stringify(doc.colourways).length }; });
  ok(doc.cw.list.length === 3 && doc.size < 20000 && !JSON.stringify(doc.cw).includes('data:image'), `serialised colourways are small JSON, no images (${doc.size} bytes)`);
  const saved = await S(() => { const s = window.__threadform.state; return JSON.stringify({ a: s.colourways.activeId, n: s.colourways.list.map(c => c.name) }); });
  await page.reload(); await page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 20000 }); await settle(); await page.waitForTimeout(300);
  ok(page.url() === designUrl, 'reload keeps the link');
  const after = await S(() => { const s = window.__threadform.state; return { j: JSON.stringify({ a: s.colourways.activeId, n: s.colourways.list.map(c => c.name) }), mat: s.colourways.list[1].sections, notes: s.colourways.list[1].notes, sup: s.colourways.list[1].supplierNotes, parent: s.colourways.list[2].parent === s.colourways.list[1].id }; });
  ok(after.j === saved, 'colourways, names and the showing colourway survive reload');
  ok(Object.values(after.mat).some(x => x.material?.name === 'Rib 1x1 cotton' && x.note === 'Match rib to body dye lot'), 'material and section notes survive reload');
  ok(after.notes === 'Autumn drop' && /MOQ 300/.test(after.sup) && after.parent, 'colourway notes, supplier notes and lineage survive reload');
  await page.click('#rtab-colourways'); ok((await page.locator('.cw-row').count()) === 3, 'panel lists the reloaded colourways');
  noErrors('panel journey');

  /* ---------------------------------------------------------------- compare + export */
  R.section('compare and export');
  await page.click('#cw-compare');
  await page.waitForSelector('dialog.cw-wide[open]');
  await page.waitForFunction(() => document.querySelectorAll('.cw-grid canvas').length === 3, null, { timeout: 30000 });
  ok(await page.locator('.cw-fig').count() === 3, 'three colourways side by side');
  const distinct = await page.evaluate(() => { const hs = [...document.querySelectorAll('.cw-grid canvas')].map(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let a = 0; for (let i = 0; i < d.length; i += 4) a = (a + d[i] * 3 + d[i + 1] * 5 + d[i + 2]) % 1000003; return a; }); return new Set(hs).size; });
  ok(distinct === 3, 'the three previews are all different pictures');
  ok(await page.locator('.cw-spec table tbody tr').count() >= 1 && /Rib 1x1 cotton/.test(await page.locator('.cw-spec').textContent()), 'section table lists the material per colourway');
  ok(await page.locator('.cw-spec th[scope=col]').count() === 4, 'table has a header per colourway (accessible scope=col)');
  await shot('compare');
  await page.uncheck('.cw-checks input >> nth=2'); await page.waitForFunction(() => document.querySelectorAll('.cw-fig').length === 2);
  await page.check('.cw-checks input >> nth=2'); await page.waitForFunction(() => document.querySelectorAll('.cw-grid canvas').length === 3, null, { timeout: 30000 });
  const dl = async sel => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 40000 }), page.click(sel)]); const p = await d.path(); return { name: d.suggestedFilename(), buf: fs.readFileSync(p) }; };
  const sheet = await dl('#cwc-sheet');
  ok(sheet.name === 'colourways-sheet.png' && sheet.buf.length > 5000 && sheet.buf.slice(1, 4).toString() === 'PNG', `comparison sheet PNG downloads (${sheet.buf.length} bytes)`);
  fs.writeFileSync(`${L.OUT}/colourways-sheet.png`, sheet.buf);
  const csv = await dl('#cwc-csv');
  const text = csv.buf.toString();
  ok(csv.name === 'colourways-materials.csv' && /Rib 1x1 cotton/.test(text) && /Mill North/.test(text) && /RIB-260/.test(text) && /Autumn drop/.test(text) && /MOQ 300/.test(text), 'materials CSV has materials, supplier, SKU and notes');
  const names2 = [];
  const onDl = d => names2.push(d.suggestedFilename()); page.on('download', onDl);
  await page.click('#cwc-each'); await page.waitForFunction(() => /downloaded/.test(document.querySelector('.cw-wide [role=status]')?.textContent || ''), null, { timeout: 60000 });
  page.off('download', onDl);
  const hasBack = await S(() => !!window.__threadform.state.views.back.base);
  ok(names2.length === 3 * (hasBack ? 2 : 1) && new Set(names2).size === names2.length && names2.every(n => /\.png$/.test(n)), `one PNG per colourway and view: ${names2.join(', ')}`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok(await page.locator('dialog.cw-wide').count() === 0, 'Escape closes the compare dialog');
  noErrors('compare');

  /* ---------------------------------------------------------------- delete + small screen */
  R.section('delete and small screen');
  await page.click('.cw-row >> nth=2 >> button[aria-label^="Delete"]');
  await page.click('dialog.confirm .btn.danger'); await settle(); await page.waitForTimeout(300);
  ok(await page.locator('.cw-row').count() === 2, 'delete removes a colourway after confirming');
  ok(await S(() => { const s = window.__threadform.state; return !!s.colourways.list.find(c => c.id === s.colourways.activeId); }), 'an active colourway remains');
  const m = await L.newPage(browser, { width: 390, height: 844 }); L.watch(m.page, errs);
  await m.ctx.addInitScript(x => localStorage.setItem('threadform.materials.v1', JSON.stringify(x)), MATERIALS);
  await m.page.goto(url + '#/'); await m.page.waitForSelector('#home:not([hidden])'); await m.page.click('#home >> text=Try a sample shirt');
  await m.page.waitForFunction(() => window.__threadform.state.views.front.current); await L.T(m.page).settle();
  await m.page.evaluate(() => window.__threadform.reveal('sec-colourways'));
  const dock = m.page.locator('#dock button, .dock button').filter({ hasText: /Edit/ }).first();
  if (await dock.count()) { await dock.click().catch(() => { }); await m.page.waitForTimeout(300); }
  await m.page.evaluate(async () => { const C = await import('/js/colourways.js'); C.addColourway(); });
  await m.page.waitForTimeout(300);
  await m.page.evaluate(async () => { const U = await import('/js/colourways-ui.js'); U.openCompare(); });
  await m.page.waitForFunction(() => document.querySelectorAll('.cw-grid canvas').length === 2, null, { timeout: 30000 });
  const mm = await m.page.evaluate(() => { const d = document.querySelector('dialog.cw-wide').getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, dl: d.left, dr: d.right }; });
  ok(mm.sw <= mm.iw && mm.dl >= 0 && mm.dr <= mm.iw + 1, 'compare dialog fits a 390 px screen without horizontal scroll ' + JSON.stringify(mm));
  await m.page.screenshot({ path: `${L.OUT}/colourways-mobile-compare.png` });
  await m.ctx.close();
  noErrors('delete / mobile');

  await browser.close(); srv.close();
  process.exit(R.done() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
