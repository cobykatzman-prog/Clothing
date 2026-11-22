// Threadform end-to-end journeys (functional checklist in TESTING.md). Run: node test/e2e.browser.test.cjs
// Serves the app with the production CSP headers (test/e2e/lib.cjs); every journey must finish with no JS errors,
// no failed requests and no CSP violations. Screenshots go to $OUT (default: <tmpdir>/threadform-e2e).
const { chromium } = require('playwright');
const L = require('./e2e/lib.cjs');
const fs = require('fs');
const R = L.runner('e2e');
const { ok } = R;

(async () => {
  const { srv, url } = await L.staticServer();
  const browser = await chromium.launch();
  const errs = [];
  const shot = (page, n) => page.screenshot({ path: `${L.OUT}/${n}.png` });
  const noErrors = (label) => { ok(errs.length === 0, `${label}: no JS errors / failed requests / CSP violations ${JSON.stringify(errs.slice(0, 4))}`); errs.length = 0; };
  const S = page => page.evaluate(() => { const s = window.__threadform.state, V = s.views[s.activeView]; return { view: s.activeView, name: s.name, els: s.elements.map(e => ({ id: e.id, type: e.type, view: e.view, x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.w), rot: Math.round(e.rotation), text: e.props && e.props.text, locked: !!e.locked, visible: e.visible !== false })), sel: s.selectedId, params: { ...V.params }, undo: s.undoStack.length, redo: s.redoStack.length, hasCur: !!V.current }; });
  const settle = page => page.waitForFunction(() => { const u = window.__threadform.state.ui; return !u.busy && !u.processing; }, null, { timeout: 30000 }).then(() => page.waitForTimeout(250));
  const hash = (page, v) => page.evaluate(vv => { const s = window.__threadform.state, c = s.views[vv || s.activeView].current; if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, 1024, 1024).data; let h = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 7) { h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 3] * 7) >>> 0; if (d[i + 3] > 20) n++; } return h + ':' + n; }, v);
  const bbox = (page, v) => page.evaluate(vv => { const s = window.__threadform.state, c = s.views[vv || s.activeView].current; const d = c.getContext('2d').getImageData(0, 0, 1024, 1024).data; let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) if (d[(y * 1024 + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { w: x1 - x0, h: y1 - y0, x0, x1, y0, y1 }; }, v);
  const openSample = async (page) => { await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])'); if (await page.locator('#home >> text=Try a sample shirt').first().isVisible()) await page.click('#home >> text=Try a sample shirt'); else { await page.click('#home >> text=New design'); await page.click('dialog.chooser button.choice:has-text("Try a sample shirt")'); } await page.waitForFunction(() => window.__threadform.state.views.front.current); await settle(page); };
  const canvasPt = (page, ix, iy) => page.evaluate(([x, y]) => { const p = window.__stage.toScreen(x, y), r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + p.sx, y: r.top + p.sy }; }, [ix, iy]);
  const tab = (page, k) => page.click(`#rtab-${k}`);

  /* ================= J1: boot, home, create from sample ================= */
  R.section('J1 boot + create');
  const { page } = await L.newPage(browser); L.watch(page, errs);
  await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])');
  ok(await page.isVisible('#home >> text=Design your first garment'), 'home shows the empty state');
  ok(await page.isVisible('#home >> text=New design'), 'home has New design');
  await page.click('#home >> text=New design'); await page.waitForTimeout(300);
  ok(await page.isVisible('dialog.chooser[open]'), 'New design opens the chooser');
  await shot(page, 'j1-home');
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok(!(await page.isVisible('dialog.chooser[open]')), 'Escape closes the chooser');
  noErrors('J1 home');
  await openSample(page);
  ok(page.url().includes('#/design/'), 'sample opens the studio at #/design/<id>');
  const s0 = await S(page); ok(s0.hasCur && s0.view === 'front', 'front view loaded');
  await shot(page, 'j1-studio');
  noErrors('J1 sample');

  /* ================= J2: shape sliders, presets, linked views ================= */
  R.section('J2 shape controls');
  await tab(page, 'shape');
  const setSlider = async (label, v) => { await page.evaluate(([l, v]) => { const r = document.querySelector(`input[type=range][aria-label="${l}"]`); r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }, [label, v]); await page.waitForTimeout(250); await settle(page); };
  const baseBox = await bbox(page, 'front'), baseBack = await bbox(page, 'back'), h0 = await hash(page, 'front');
  const SHAPES = [['Body width', 'w'], ['Body length', 'h'], ['Shoulder width', null], ['Sleeve length', null], ['Sleeve width', null], ['Sleeve flare', null], ['Sleeve curve', null], ['Collar size', null], ['Neck opening', null], ['Hem curve', null], ['Crop length', 'h']];
  for (const [label, dim] of SHAPES) {
    await setSlider(label, 60);
    const hp = await hash(page, 'front'), hb = await hash(page, 'back'), st = await S(page);
    const key = await page.evaluate(l => { const r = document.querySelector(`input[type=range][aria-label="${l}"]`); return r.closest('.slider').querySelector('.lk-reset').getAttribute('aria-label'); }, label);
    ok(hp !== h0, `${label} +60 changes the front garment`);
    const nonZero = Object.entries(st.params).filter(([, v]) => v === 60).length;
    ok(nonZero === 1, `${label} sets exactly one parameter ${JSON.stringify(st.params)}`);
    const back = await page.evaluate(() => window.__threadform.state.views.back.params);
    ok(Object.values(back).filter(v => v === 60).length === 1, `${label}: back view params follow (linked)`);
    const bb = await bbox(page, 'front');
    if (dim === 'w') ok(bb.w > baseBox.w, `${label} widens the garment`);
    if (label === 'Body length') ok(bb.h > baseBox.h, `Body length makes it longer`);
    if (label === 'Crop length') ok(bb.h < baseBox.h, `Crop length makes it shorter`);
    await setSlider(label, 0);
    ok(await hash(page, 'front') === h0, `${label} back to 0 restores the original pixels`);
  }
  // typed value + reset button + double-click reset
  await page.fill('input[aria-label="Sleeve length value"]', '-40'); await page.waitForTimeout(300); await settle(page);
  ok((await S(page)).params.sleeveLength === -40, 'typed value -40 sets sleeve length');
  const sbb = await bbox(page, 'front'); ok(sbb.w < baseBox.w, 'shorter sleeves narrow the garment');
  await page.click('button[aria-label="Reset Sleeve length"]'); await settle(page);
  ok((await S(page)).params.sleeveLength === 0 && await hash(page, 'front') === h0, 'Reset button restores sleeve length');
  await setSlider('Sleeve flare', 50); await page.dblclick('input[type=range][aria-label="Sleeve flare"]'); await settle(page);
  ok((await S(page)).params.sleeveFlare === 0, 'double-click resets a slider');
  // undo / redo of a slider gesture
  await setSlider('Body width', 40); const u1 = await S(page);
  await page.click('#btn-undo'); await settle(page);
  ok((await S(page)).params.bodyWidth === 0 && await hash(page, 'front') === h0, 'Undo reverts the slider and the picture');
  await page.click('#btn-redo'); await settle(page);
  ok((await S(page)).params.bodyWidth === 40, 'Redo re-applies the slider');
  await page.click('text=Reset shape'); await settle(page);
  ok(Object.values((await S(page)).params).every(v => !v), 'Reset shape zeroes every slider');
  // presets
  const presets = await page.$$eval('[data-preset]', b => b.map(x => x.dataset.preset));
  ok(presets.length >= 14, `fit and sleeve presets present (${presets.length})`);
  for (const pr of presets) {
    await page.click(`[data-preset="${pr}"]`); await settle(page);
    const st = await S(page), hp = await hash(page, 'front');
    const nz = Object.values(st.params).some(v => v);
    ok(nz ? hp !== h0 : true, `preset ${pr} applies`);
    const on = await page.$eval(`[data-preset="${pr}"]`, b => b.classList.contains('on'));
    ok(on, `preset ${pr} shows as active`);
  }
  await page.click('text=Clear sleeve preset'); await page.click('text=Clear fit preset'); await settle(page);
  ok(Object.values((await S(page)).params).every(v => !v), 'clearing both presets returns to the original');
  await shot(page, 'j2-shape');
  noErrors('J2 shape');

  /* ================= J3: front / back / side / detail stay in sync ================= */
  R.section('J3 views in sync');
  await tab(page, 'shape');
  await setSlider('Sleeve flare', 70); await setSlider('Body width', 30);
  for (const v of ['back', 'side', 'detail', 'front']) {
    await page.click(`.tab[data-v="${v}"]`); await settle(page);
    const st = await S(page);
    ok(st.view === v && st.hasCur, `${v} tab shows a garment`);
    ok(st.params.sleeveFlare === 70 && st.params.bodyWidth === 30 || v === 'detail', `${v} view carries the same shape settings ${JSON.stringify(st.params)}`);
    await shot(page, 'j3-' + v);
  }
  const wf = (await bbox(page, 'front')), wb = (await bbox(page, 'back')), ws = await bbox(page, 'side');
  ok(Math.abs(wf.w - wb.w) < 25, `front and back widths match after shape edit (${wf.w} vs ${wb.w})`);
  // an edit on the side tab flows to the front
  await page.click('.tab[data-v="side"]'); await settle(page);
  await setSlider('Body length', 40);
  await page.click('.tab[data-v="front"]'); await settle(page);
  ok((await S(page)).params.bodyLength === 40, 'shape edit made on the side view reaches the front');
  await page.click('.tab[data-v="back"]'); await settle(page);
  ok((await S(page)).params.bodyLength === 40, '... and the back');
  await page.click('.tab[data-v="front"]'); await tab(page, 'shape'); await page.click('text=Reset shape'); await settle(page);
  noErrors('J3 views');

  /* ================= J4: layers: add, select, edit, transform, undo / redo ================= */
  R.section('J4 layers');
  const els = async () => (await S(page)).els;
  const addText = async () => { await page.click('#sec-text > summary').catch(() => {}); await page.fill('input[aria-label="Text to add"]', 'ATHENS'); await page.click('#sec-text >> text=Add text'); await page.waitForTimeout(250); };
  await page.evaluate(() => { document.getElementById('sec-text').open = true; document.getElementById('sec-graphics').open = true; });
  await page.fill('input[aria-label="Text to add"]', 'ATHENS'); await page.click('#sec-text button:has-text("Add text")'); await page.waitForTimeout(300);
  let E = await els(); ok(E.length === 1 && E[0].type === 'text' && E[0].text === 'ATHENS', 'Add text creates a text layer');
  ok((await S(page)).sel === E[0].id, 'new layer is selected');
  await page.click('button[aria-label="Add Classic shield"]'); await page.waitForTimeout(300);
  await page.setInputFiles('#sec-graphics input[type=file]', { name: 'logo.png', mimeType: 'image/png', buffer: L.pngBuf(160, 80) }); await page.waitForTimeout(600);
  await page.click('#sec-graphics .chips button:has-text("Stripes")'); await page.waitForTimeout(200);
  await page.click('#sec-graphics .chips button:has-text("Piping")'); await page.waitForTimeout(200);
  await page.click('#sec-graphics .chips button:has-text("Patch")'); await page.waitForTimeout(200);
  E = await els(); ok(E.map(e => e.type).join() === 'text,crest,logo,stripe,piping,patch', `all element kinds added: ${E.map(e => e.type)}`);
  await shot(page, 'j4-layers');
  ok(await page.locator('#sec-layers .erow').count() === 6, 'layers list shows 6 rows');
  // layers list select
  const textId = E[0].id;
  await page.click(`#sec-layers .erow[data-id="${textId}"] .ename`);
  ok((await S(page)).sel === textId, 'clicking a layer row selects it');
  // inspector edit text content
  await tab(page, 'items');
  await page.fill('textarea[aria-label="Text"]', 'SPARTA'); await page.waitForTimeout(200);
  ok((await els())[0].text === 'SPARTA', 'inspector edits the text');
  await page.fill('input[aria-label="Size %"]', '150'); await page.waitForTimeout(200);
  const w150 = (await els())[0].w;
  await page.fill('input[aria-label="Rotation °"]', '30'); await page.waitForTimeout(200);
  ok((await els())[0].rot === 30, 'inspector rotation');
  await page.fill('input[aria-label="Size %"]', '100'); await page.waitForTimeout(200);
  ok((await els())[0].w < w150, 'inspector size % scales the item');
  await page.fill('input[aria-label="Rotation °"]', '0');
  await page.evaluate(() => document.querySelectorAll('.insp details').forEach(d => { d.open = true; }));
  await page.fill('input[aria-label="X"]', '400'); await page.fill('input[aria-label="Y"]', '420'); await page.waitForTimeout(200);
  let t0 = (await els())[0]; ok(t0.x === 400 && t0.y === 420, 'inspector X / Y position');
  // canvas: click selects, drag moves, then undo
  await page.click(`#sec-layers .erow[data-id="${E[2].id}"] .ename`); // select logo, then deselect by clicking elsewhere
  let pt = await canvasPt(page, 400, 420);
  await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(150);
  ok((await S(page)).sel === textId, 'clicking the text on the canvas selects it');
  const before = (await els())[0];
  await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.move(pt.x + 40, pt.y + 25, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  let after = (await els())[0]; ok(after.x > before.x + 20 && after.y > before.y + 10, `dragging on the canvas moves the layer (${before.x},${before.y} -> ${after.x},${after.y})`);
  await page.click('#btn-undo'); await page.waitForTimeout(200);
  after = (await els())[0]; ok(after.x === before.x && after.y === before.y, 'undo puts the dragged layer back');
  await page.click('#btn-redo'); await page.waitForTimeout(200);
  ok((await els())[0].x > before.x + 20, 'redo moves it again');
  // handles: resize via corner, rotate via the round handle
  const handlePt = async (id, name) => { const h0 = await page.evaluate(async ([id, name]) => { const E = await import('/js/elements.js'); const e = window.__threadform.state.elements.find(x => x.id === id); return E.handlesFor(e, 1 / window.__stage.zoom)[name]; }, [id, name]); if (!h0) throw new Error('no handle ' + name + ' for ' + id + ' els=' + JSON.stringify((await els()).map(e => e.id))); return canvasPt(page, h0.x, h0.y); };
  const geo = (await els())[0];
  const se = await handlePt(textId, 'scale-se');
  await page.mouse.move(se.x, se.y); await page.mouse.down(); await page.mouse.move(se.x + 40, se.y + 30, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(200);
  const g2 = (await els())[0]; ok(g2.w > geo.w, `corner handle resizes (${geo.w} -> ${g2.w})`);
  await page.click('#btn-undo'); await page.waitForTimeout(150);
  ok((await els())[0].w === geo.w, 'undo reverts the resize');
  const rh = await handlePt(textId, 'rotate'); const cen = await canvasPt(page, (await els())[0].x, (await els())[0].y);
  await page.mouse.move(rh.x, rh.y); await page.mouse.down(); await page.mouse.move(cen.x + 120, cen.y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  ok((await els())[0].rot !== 0, `rotate handle rotates (${(await els())[0].rot} deg)`);
  await page.click('#btn-undo'); await page.waitForTimeout(150);
  ok((await els())[0].rot === 0, 'undo reverts the rotation');
  // keyboard: nudge + delete + lock
  await page.click(`#sec-layers .erow[data-id="${textId}"] .ename`); await page.focus('#stage');
  const nx = (await els())[0].x; await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(150);
  ok((await els())[0].x === nx + 11, 'arrow keys nudge (1 px, Shift 10 px)');
  // lock / hide / reorder / duplicate / delete via the layers list
  await page.click(`#sec-layers .erow[data-id="${textId}"] button[aria-label^="Lock"]`); await page.waitForTimeout(150);
  ok((await els())[0].locked, 'Lock locks the layer');
  const lx = (await els())[0].x; await page.focus('#stage'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100);
  ok((await els())[0].x === lx, 'a locked layer does not move');
  await page.click(`#sec-layers .erow[data-id="${textId}"] button[aria-label^="Unlock"]`); await page.waitForTimeout(150);
  await page.click(`#sec-layers .erow[data-id="${textId}"] button[aria-label="Hide layer"]`); await page.waitForTimeout(150);
  ok(!(await els())[0].visible, 'Hide hides the layer');
  await page.click(`#sec-layers .erow[data-id="${textId}"] button[aria-label="Show layer"]`); await page.waitForTimeout(150);
  const order0 = (await els()).map(e => e.id);
  await page.click(`#sec-layers .erow[data-id="${textId}"] button[aria-label^="Bring forward"]`); await page.waitForTimeout(150);
  const order1 = (await els()).map(e => e.id); ok(order1.join() !== order0.join() && order1.indexOf(textId) > order0.indexOf(textId), 'Bring forward moves the layer up the stack');
  await page.click('#btn-undo'); await page.waitForTimeout(150);
  ok((await els()).map(e => e.id).join() === order0.join(), 'undo reorders back');
  await page.click(`#sec-layers .erow[data-id="${textId}"] .ename`); await tab(page, 'items');
  await page.click('.insp >> text=Duplicate >> nth=0'); await page.waitForTimeout(250);
  ok((await els()).length === 7, 'Duplicate adds a layer');
  await page.click('#btn-undo'); await page.waitForTimeout(150);
  ok((await els()).length === 6, 'undo removes the duplicate');
  await page.click(`#sec-layers .erow[data-id="${textId}"] .ename`); await tab(page, 'items');
  await page.evaluate(() => document.querySelectorAll('.insp details').forEach(d => { d.open = true; }));
  await page.click('.insp button:has-text("To Back")'); await page.waitForTimeout(250);
  ok((await els()).filter(e => e.view === 'back').length === 1, 'Duplicate to the back view puts a copy there');
  await page.click('#btn-undo'); await page.waitForTimeout(150);
  await page.click(`#sec-layers .erow[data-id="${textId}"] button[aria-label="Delete layer"]`); await page.waitForTimeout(200);
  ok((await els()).length === 5 && !(await els()).some(e => e.id === textId), 'Delete layer removes it');
  await page.click('#btn-undo'); await page.waitForTimeout(150);
  ok((await els()).length === 6, 'undo restores the deleted layer');
  // Delete key
  await page.click(`#sec-layers .erow[data-id="${textId}"] .ename`); await page.focus('#stage'); await page.keyboard.press('Delete'); await page.waitForTimeout(200);
  ok((await els()).length === 5, 'Delete key removes the selected layer');
  await page.click('#btn-undo'); await page.waitForTimeout(150);
  // logo inspector tint
  await page.click(`#sec-layers .erow[data-id="${E[2].id}"] .ename`); await tab(page, 'items');
  await page.fill('input[aria-label="Tint strength %"]', '80').catch(() => {});
  await shot(page, 'j4-logo-inspector');
  noErrors('J4 layers');

  /* ================= J5: save, reopen, deep link, rename, duplicate, delete ================= */
  R.section('J5 save / reopen');
  await page.click('.tab[data-v="front"]'); await settle(page);
  await page.fill('input.name', 'Audit tee'); await tab(page, 'shape'); await setSlider('Body width', 35); await setSlider('Sleeve flare', 45);
  await page.waitForFunction(() => /Saved/.test(document.querySelector('.save-status')?.textContent || ''), null, { timeout: 15000 });
  ok(true, 'header shows Saved after edits');
  const designUrl = page.url(), before5 = await S(page), hBefore = await hash(page, 'front');
  await page.reload(); await page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 20000 }); await settle(page);
  let a5 = await S(page);
  ok(page.url() === designUrl, 'reload keeps the design link');
  ok(a5.name === 'Audit tee' && a5.params.bodyWidth === 35 && a5.params.sleeveFlare === 45, `deep link reload restores name + shape ${JSON.stringify(a5.params)}`);
  ok(a5.els.length === before5.els.length, 'reload restores all layers');
  ok(await hash(page, 'front') === hBefore, 'reload restores identical front pixels');
  ok(await page.evaluate(() => !!window.__threadform.state.views.back.current), 'back view restored');
  // text layer content survives
  ok(a5.els.some(e => e.type === 'text' && e.text === 'SPARTA'), 'edited text layer survives reload');
  // undo after reload does not crash and works
  await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])'); await page.waitForSelector('.dcard');
  ok(await page.locator('.dcard').count() === 1, 'home lists the saved design');
  ok((await page.textContent('.dcard .dname')) === 'Audit tee', 'home card shows the name');
  await shot(page, 'j5-home');
  await page.click('.dcard .dcard-open'); await page.waitForFunction(() => window.__threadform.state.views.front.current); await settle(page);
  ok((await S(page)).params.bodyWidth === 35, 'opening from home restores the design');
  ok(await page.isDisabled('#btn-undo'), 'a reopened design starts with an empty undo history');
  await tab(page, 'shape'); await setSlider('Body width', 10); await page.click('#btn-undo'); await settle(page);
  ok((await S(page)).params.bodyWidth === 35, 'undo works on a reopened design');
  // brand link goes home; rename + duplicate + delete on the home page
  await page.click('a.home-btn'); await page.waitForSelector('#home:not([hidden])'); await page.waitForSelector('.dcard');
  await page.click('.dcard >> text=Rename'); await page.fill('dialog.ask input', 'Renamed tee'); await page.click('dialog.ask button[type=submit]'); await page.waitForTimeout(600);
  ok((await page.textContent('.dcard .dname')) === 'Renamed tee', 'Rename from home works');
  await page.click('.dcard >> text=Duplicate'); await page.waitForTimeout(900);
  ok(await page.locator('.dcard').count() === 2, 'Duplicate adds a second design');
  await page.locator('.dcard').first().locator('text=Delete').click(); await page.waitForSelector('dialog.ask[open]');
  await page.click('dialog.ask button[type=submit]'); await page.waitForTimeout(700);
  ok(await page.locator('.dcard').count() === 1, 'Delete removes a design (after confirming)');
  // a link to a design that does not exist is handled, not a white screen
  await page.goto(url + '#/design/doesnotexist'); await page.waitForTimeout(1200);
  ok(await page.isVisible('#home:not([hidden])') && (await page.locator('.toast, [role=status]').count()) > 0, 'unknown design link returns home with a message');
  noErrors('J5 save');

  /* ================= J6: describe, option cards, compare / accept / reject / regenerate / history ================= */
  R.section('J6 options + review');
  await openSample(page); await tab(page, 'look');
  const h6 = await hash(page, 'front');
  await page.click('#rpanel-look >> text=make the sleeves flared'); await page.click('#btn-variations');
  await page.waitForFunction(() => document.querySelectorAll('#variation-cards .vcard:not(.pending)').length === 3, null, { timeout: 30000 }); await settle(page);
  ok(await page.locator('#variation-cards .vcard').count() === 3, 'three option cards appear');
  ok(await page.locator('#variation-cards button[data-act=use]').count() === 3 && (await page.textContent('#variation-cards button[data-act=use]')).trim() === 'Use this', 'every card has a "Use this" button');
  await shot(page, 'j6-cards');
  // preview + reject
  await page.click('#variation-cards .vcard:nth-child(2) button[data-act=preview]'); await page.waitForSelector('#review-bar:not([hidden])');
  ok(await hash(page, 'front') === h6, 'previewing does not change the design');
  ok(await page.isEnabled('#btn-accept') && await page.isEnabled('#btn-reject') && await page.isEnabled('#btn-regenerate') && await page.isEnabled('#btn-edit-further'), 'review bar buttons are enabled');
  await shot(page, 'j6-preview');
  await page.click('#btn-review-compare'); ok(await page.isVisible('#cmp-bar'), 'Compare opens the compare bar');
  for (const id of ['cmp-slider', 'cmp-side', 'cmp-flip']) { await page.click('#' + id); ok((await page.getAttribute('#' + id, 'aria-pressed')) === 'true', `compare mode ${id} activates`); }
  await page.click('#cmp-slider'); ok(await page.isVisible('#cmp-handle'), 'slider handle visible'); await page.focus('#cmp-handle'); await page.keyboard.press('ArrowRight');
  ok(+(await page.getAttribute('#cmp-handle', 'aria-valuenow')) > 50, 'slider handle moves with the arrow keys');
  await shot(page, 'j6-compare');
  await page.click('#cmp-close'); ok(!(await page.isVisible('#cmp-bar')), 'Close compare closes the bar');
  await page.click('#btn-reject'); await page.waitForTimeout(200);
  ok(!(await page.isVisible('#review-bar')) && await hash(page, 'front') === h6, 'Reject closes the preview and leaves the garment untouched');
  // preview + Escape rejects
  await page.click('#variation-cards .vcard:nth-child(1) button[data-act=preview]'); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok(!(await page.isVisible('#review-bar')), 'Esc rejects a preview');
  // regenerate
  await page.click('#variation-cards .vcard:nth-child(3) button[data-act=preview]'); await page.click('#btn-regenerate');
  await page.waitForFunction(() => document.querySelectorAll('#variation-cards .vcard:not(.pending)').length === 3, null, { timeout: 30000 }); await settle(page);
  ok(!(await page.isVisible('#review-bar')) && await page.locator('#variation-cards .vcard').count() === 3, 'Regenerate produces a fresh set of three options');
  // edit prompt further
  await page.click('#variation-cards .vcard:nth-child(2) button[data-act=preview]'); await page.click('#btn-edit-further');
  ok((await page.inputValue('#prompt')).length > 0, 'Edit prompt further puts the prompt back in Describe');
  await page.click('#btn-reject');
  // accept via the review bar
  await page.click('#variation-cards .vcard:nth-child(2) button[data-act=preview]'); await page.click('#btn-accept'); await settle(page);
  ok(await hash(page, 'front') !== h6, 'Accept changes the garment');
  ok(await page.locator('#variation-cards .vcard.applied').count() === 1, 'accepted card shows Applied');
  const h6b = await hash(page, 'front');
  // history drawer
  await page.click('button:has-text("Version history")'); await page.click('#dtab-edits'); await page.waitForTimeout(200);
  ok(await page.locator('#edit-history .eitem').count() === 1, 'accepted edit appears in Edit history');
  await page.click('#edit-history .eitem'); ok(await page.isVisible('#edit-history .edetail'), 'edit detail opens with before / after');
  await shot(page, 'j6-history');
  await page.click('#dtab-versions'); ok(await page.locator('.vitem').count() >= 2, 'Versions tab lists versions');
  await page.keyboard.press('Escape');
  // undo edit / redo edit
  await page.click('#btn-undo-edit'); await settle(page);
  ok(await hash(page, 'front') === h6, 'Undo edit puts the garment back');
  await page.click('#btn-redo-edit'); await settle(page);
  ok(await hash(page, 'front') === h6b, 'Redo edit re-applies it');
  // "Use this": one click puts an option on the garment, recorded in history, undoable
  await page.click('#btn-undo-edit'); await settle(page);
  await page.click('#btn-variations'); await page.waitForFunction(() => document.querySelectorAll('#variation-cards .vcard:not(.pending)').length === 3, null, { timeout: 30000 }); await settle(page);
  await page.click('#variation-cards .vcard:nth-child(3) button[data-act=use]'); await settle(page);
  ok(await hash(page, 'front') !== h6, '"Use this" applies the option');
  ok(await page.locator('#variation-cards .vcard.applied').count() === 1, '"Use this" marks the card Applied');
  await page.click('#btn-undo'); await settle(page);
  ok(await hash(page, 'front') === h6, 'Undo after "Use this" restores the garment');
  // compare from the bottom bar
  await page.click('#btn-compare'); ok(await page.isVisible('#cmp-bar'), 'bottom Compare button opens compare'); await page.click('#cmp-close');
  noErrors('J6 review');

  /* ================= J7: export ================= */
  R.section('J7 export');
  await page.click('#btn-export'); ok(await page.isVisible('#export-menu'), 'Export opens a menu');
  const items = await page.$$eval('#export-menu .menu-item', b => b.map(x => x.querySelector('b').textContent));
  for (const it of items.filter(i => !/Custom|\(print\)|Tech pack/.test(i))) {
    if (!(await page.isVisible('#export-menu'))) await page.click('#btn-export');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(`#export-menu .menu-item:has(b:text-is("${it}"))`)]);
    const f = await dl.path(); const size = fs.statSync(f).size;
    ok(size > 200, `export "${it}" downloads a non-empty file (${dl.suggestedFilename()}, ${size} B)`);
  }
  await page.click('#btn-export'); await page.click('#btn-custom-export'); ok(await page.isVisible('dialog[open]'), 'Custom export dialog opens');
  await shot(page, 'j7-export-dialog'); await page.keyboard.press('Escape');
  noErrors('J7 export');

  /* ================= J8: Basic mode + phone layout ================= */
  R.section('J8 basic mode / phone');
  const ph = await L.newPage(browser, { mode: 'basic', width: 390, height: 800 }); L.watch(ph.page, errs);
  await ph.page.goto(url + '#/'); await ph.page.waitForSelector('#home:not([hidden])');
  const noH = p => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  ok(await noH(ph.page), 'phone home has no horizontal scroll');
  await ph.page.click('#home >> text=Try a sample shirt'); await ph.page.waitForFunction(() => window.__threadform.state.views.front.current); await settle(ph.page);
  ok(await noH(ph.page), 'phone studio has no horizontal scroll');
  await shot(ph.page, 'j8-phone');
  ok(await ph.page.isVisible('#btn-export') && await ph.page.isVisible('#btn-undo'), 'phone studio shows export and undo');
  noErrors('J8 phone');
  await ph.ctx.close();

  await browser.close(); srv.close();
  const good = R.done(); process.exit(good ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
