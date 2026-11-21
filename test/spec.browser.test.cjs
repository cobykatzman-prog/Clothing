// Garment measurements and size grading (roadmap v2 phase 4): POM spec table, calibration, manual entry, grading,
// tolerances, validation, persistence, CSV + printable export. Run: node test/spec.browser.test.cjs
// Served with the production CSP headers (test/e2e/lib.cjs); JS errors, failed requests or CSP violations fail it.
const { chromium } = require('playwright');
const fs = require('fs');
const L = require('./e2e/lib.cjs');
const R = L.runner('spec');
const { ok } = R;

(async () => {
  const { srv, url } = await L.staticServer();
  const browser = await chromium.launch();
  const errs = [];
  const { ctx, page } = await L.newPage(browser, { width: 1440, height: 900, mode: 'advanced' }); L.watch(page, errs);
  const settle = () => L.T(page).settle();
  const shot = n => page.screenshot({ path: `${L.OUT}/spec-${n}.png` });
  await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])');
  await page.click('#home >> text=Try a sample shirt');
  await page.waitForFunction(() => window.__threadform.state.views.front.current);
  await settle(); await page.waitForTimeout(400);

  const cellSel = (k, s) => `.spec-in[data-key="${k}"][data-size="${s}"]`;
  const val = async (k, s) => parseFloat(await page.inputValue(cellSel(k, s)));
  const src = (k, s) => page.getAttribute(cellSel(k, s), 'data-src');
  const typeCell = async (k, s, v) => { await page.fill(cellSel(k, s), String(v)); await page.press(cellSel(k, s), 'Enter'); await page.waitForTimeout(150); };

  /* ---- table, POM naming, labels ---- */
  R.section('spec table');
  await page.click('#rtab-measure');
  await page.evaluate(() => { document.getElementById('sec-spec').open = true; document.getElementById('sec-measure').open = true; });
  await page.waitForSelector('#spec-summary');
  const codes = await page.$$eval('.spec-grid .spec-row[data-key] .spec-name b', e => e.map(x => x.textContent));
  ok(codes.length === 9 && codes[0] === 'POM-01' && codes[8] === 'POM-09', `nine POMs with stable codes ${codes}`);
  const names = await page.$$eval('.spec-grid .spec-name', e => e.map(x => x.textContent));
  ok(names.some(n => /Front neck drop/.test(n)) && names.some(n => /Back neck drop/.test(n)), 'front and back neck drops are separate, clearly named POMs');
  const allSrc = await page.$$eval('.spec-grid .spec-in', e => e.map(x => x.dataset.src));
  ok(allSrc.length === 54 && allSrc.every(s => ['estimated', 'calibrated', 'manual'].includes(s)), 'every cell is labelled calibrated / manual / estimated');
  ok(allSrc.filter(s => s === 'estimated').length >= 40, 'untouched design: values are estimates');
  ok(!allSrc.includes('manual') && !allSrc.includes('calibrated'), 'nothing is called manual/calibrated before the user does it');
  ok(/not production-verified/.test(await page.textContent('#sec-spec')) , 'panel states estimates are not production-verified');
  ok(await page.isVisible('#spec-scale') && /Estimated scale|Scale estimated/.test(await page.textContent('#spec-scale')), 'scale is described as estimated');
  const chartChest = [47, 50, 53, 56, 59, 62];
  const kindTee = (await page.textContent('#spec-summary')).includes('base size M');
  ok(kindTee, 'summary names the base size');
  const chestRow = [];
  for (const s of ['XS', 'S', 'M', 'L', 'XL', 'XXL']) chestRow.push(await val('chest', s));
  ok(chestRow.every((v, i) => i === 0 || v > chestRow[i - 1]), `chest grades upward ${chestRow}`);
  ok(Math.abs((chestRow[5] - chestRow[0]) - 15) < 0.6 || Math.abs((chestRow[5] - chestRow[0]) - (chartChest[5] - chartChest[0])) < 6, 'chest grading span is a plausible size run');
  // the panel table (Now column, base size) and the spec table agree for the base size
  const nowChest = await page.evaluate(() => parseFloat(document.querySelector('#measure-table .mrow[data-key=chest] .mnow').textContent));
  ok(Math.abs(nowChest - await val('chest', 'M')) <= 0.26, `Measurements table and spec agree on chest (${nowChest} vs ${await val('chest', 'M')})`);
  await shot('1-table');

  /* ---- manual entry, undo ---- */
  R.section('manual entry');
  await typeCell('length', 'L', 80);
  ok(await val('length', 'L') === 80 && await src('length', 'L') === 'manual', 'typed value is kept and labelled manual');
  ok(await src('length', 'M') === 'estimated', 'other sizes stay estimates');
  ok(await page.isVisible('#spec-reset'), 'Clear typed values appears');
  await page.click('#btn-undo'); await page.waitForTimeout(200);
  ok(await src('length', 'L') === 'estimated', 'Undo removes the typed value');
  await page.click('#btn-redo'); await page.waitForTimeout(200);
  ok(await src('length', 'L') === 'manual', 'Redo brings it back');
  await page.fill(cellSel('length', 'L'), ''); await page.press(cellSel('length', 'L'), 'Enter'); await page.waitForTimeout(150);
  ok(await src('length', 'L') === 'estimated', 'clearing the box returns to the drawing / grading');
  await typeCell('chest', 'XL', 'abc');
  ok(await src('chest', 'XL') === 'estimated', 'invalid text is rejected');

  /* ---- grading increment ---- */
  R.section('grading');
  const m = await val('chest', 'M');
  await page.fill('.spec-in[data-inc="chest"]', '4'); await page.press('.spec-in[data-inc="chest"]', 'Enter'); await page.waitForTimeout(200);
  ok(Math.abs(await val('chest', 'XL') - (m + 8)) < 0.011 && Math.abs(await val('chest', 'XS') - (m - 8)) < 0.011, 'uniform 4 cm increment grades chest XS..XXL around the base');
  ok(await val('length', 'XL') !== await val('length', 'M') + 8, 'other POMs keep their own steps');
  await page.fill('.spec-in[data-inc="chest"]', ''); await page.press('.spec-in[data-inc="chest"]', 'Enter'); await page.waitForTimeout(150);
  ok(Math.abs(await val('chest', 'XL') - (m + 6)) < 0.5, 'blank increment returns to the size-chart steps');
  await page.fill('.spec-in[data-inc="chest"]', '-3'); await page.press('.spec-in[data-inc="chest"]', 'Enter'); await page.waitForTimeout(200);
  ok((await page.textContent('#spec-warns')).includes('smaller than'), 'a negative grading step is flagged: sizes would shrink');
  ok(await page.isVisible('.spec-w.lvl-error'), 'shown as an error');
  await page.evaluate(() => document.getElementById('spec-warns').scrollIntoView({ block: 'center' })); await shot('2-warnings');
  await page.fill('.spec-in[data-inc="chest"]', ''); await page.press('.spec-in[data-inc="chest"]', 'Enter'); await page.waitForTimeout(150);

  /* ---- tolerance ---- */
  R.section('tolerance');
  await page.fill('.spec-in[data-tol="hem"]', '0'); await page.press('.spec-in[data-tol="hem"]', 'Enter'); await page.waitForTimeout(150);
  ok((await page.textContent('#spec-warns')).includes('tolerance is 0'), 'tolerance 0 is flagged');
  await page.fill('.spec-in[data-tol="hem"]', '2'); await page.press('.spec-in[data-tol="hem"]', 'Enter'); await page.waitForTimeout(150);
  ok(!(await page.textContent('#spec-warns')).includes('tolerance is 0'), 'valid tolerance clears the warning');
  ok((await page.getAttribute(cellSel('hem', 'M'), 'data-tip')).includes('Range'), 'cell tooltip shows min / max from the tolerance');

  /* ---- calibration ---- */
  R.section('calibration');
  await page.selectOption('#measure-cal-key', 'chest'); await page.fill('#measure-cal-input', '54'); await page.click('#measure-cal-apply'); await page.waitForTimeout(250);
  ok(await src('chest', 'M') === 'calibrated' && await val('chest', 'M') === 54, 'calibrating on the chest makes the chest base value calibrated = 54');
  ok(await src('chest', 'L') === 'estimated', 'sizes graded from a calibrated base stay estimates');
  ok(await src('length', 'M') === 'estimated', 'other measurements are not claimed as calibrated');
  ok(/calibrated/.test(await page.textContent('#spec-scale')) && /Calibrated scale/.test(await page.textContent('#measure-basis')), 'both panels say the scale is calibrated');
  const calNow = await page.evaluate(() => parseFloat(document.querySelector('#measure-table .mrow[data-key=chest] .mnow').textContent));
  ok(calNow === 54, 'Measurements table shows the calibrated chest');
  // canvas dimensions + scale bar
  await page.check('#measure-show'); await page.waitForTimeout(300); await shot('3-calibrated-dims');
  await page.uncheck('#measure-show');

  /* ---- geometry follows shape changes ---- */
  R.section('shape changes');
  await page.click('#measure-cal-reset'); await page.waitForTimeout(200);
  const before = { chest: await val('chest', 'M'), length: await val('length', 'M') };
  await page.click('#rtab-shape');
  const setSlider = async (label, v) => { await page.evaluate(([l, v]) => { const r = document.querySelector(`input[type=range][aria-label="${l}"]`); r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }, [label, v]); await page.waitForTimeout(300); await settle(); };
  await setSlider('Body width', 60); await setSlider('Body length', 40);
  await page.click('#rtab-measure');
  const after = { chest: await val('chest', 'M'), length: await val('length', 'M') };
  ok(after.chest > before.chest + 1, `chest follows a wider body (${before.chest} -> ${after.chest})`);
  ok(after.length > before.length + 1, `length follows a longer body (${before.length} -> ${after.length})`);
  ok(await val('chest', 'XL') > after.chest, 'graded sizes follow the new base');
  const nowChest2 = await page.evaluate(() => parseFloat(document.querySelector('#measure-table .mrow[data-key=chest] .mnow').textContent));
  ok(Math.abs(nowChest2 - after.chest) <= 0.26, 'dimension table and spec still agree after the shape change');
  // a typed base value that no longer matches the drawing is flagged, not silently kept in sync
  await typeCell('chest', 'M', before.chest);
  ok(/drawing now measures/.test(await page.textContent('#spec-warns')), 'typed base value that disagrees with the new shape is flagged');
  await page.evaluate(() => document.getElementById('spec-warns').scrollIntoView({ block: 'center' })); await shot('4-shape-warning');
  await page.click('#spec-reset'); await page.waitForTimeout(200);
  await page.click('#btn-undo'); await page.click('#btn-undo'); await page.waitForTimeout(300); await settle();

  /* ---- persistence ---- */
  R.section('persistence');
  await typeCell('sleeve', 'S', 17.5);
  await page.fill('.spec-in[data-inc="hem"]', '2.5'); await page.press('.spec-in[data-inc="hem"]', 'Enter'); await page.waitForTimeout(200);
  const rt = await page.evaluate(async () => {
    const m = await import('/js/state.js'); const { doc, assets } = await m.serializeDesign();
    const saved = JSON.parse(JSON.stringify(doc.spec));
    m.state.spec = { inc: {}, tol: {}, manual: {} };
    await m.hydrateDesign(JSON.parse(JSON.stringify(doc)), assets);
    return { saved, after: JSON.parse(JSON.stringify(m.state.spec)) };
  });
  ok(rt.saved.manual.sleeve.S.cm === 17.5 && rt.saved.inc.hem === 2.5, 'spec is part of the saved design document');
  ok(JSON.stringify(rt.saved) === JSON.stringify(rt.after), 'hydrate restores manual values, increments and tolerances');
  await page.waitForTimeout(300);
  ok(await val('sleeve', 'S') === 17.5 && await src('sleeve', 'S') === 'manual', 'restored value shows as manual');
  // version snapshots carry the spec as well
  const ver = await page.evaluate(async () => { const m = await import('/js/state.js'); const s = m.capture(); return s.spec.manual.sleeve.S.cm; });
  ok(ver === 17.5, 'undo / version snapshots include the spec');

  /* ---- exports ---- */
  R.section('exports');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#spec-csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(/measurement-spec\.csv$/.test(dl.suggestedFilename()), 'CSV has a clear name ' + dl.suggestedFilename());
  ok(csv.includes('POM-09') && csv.includes('Tolerance +/- (cm)') && csv.includes('M status'), 'CSV carries POM codes, tolerance and per-size status');
  ok(/POM-04,Sleeve length[^\r\n]*Manual/.test(csv) && /17\.5/.test(csv), 'CSV marks the typed value as Manual');
  ok(csv.includes('not verified any value for production') && csv.includes('Estimated'), 'CSV labels estimates and carries the not-verified note');
  await page.click('#btn-export');
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#export-menu .menu-item:has(b:text-is("Measurement spec (CSV, labelled)"))')]);
  ok(fs.statSync(await dl2.path()).size > 500, 'Export menu also offers the labelled spec CSV');
  // printable table: stub window.print so the print-only DOM can be looked at in print media
  await page.evaluate(() => { window.__printed = null; window.print = () => { const e = document.getElementById('print-spec'); window.__printed = { rows: e.querySelectorAll('tbody tr').length, text: e.textContent }; }; });
  await page.click('#spec-print');
  const pr = await page.evaluate(() => window.__printed);
  ok(pr && pr.rows === 9, 'printable table has all nine POM rows');
  ok(pr && /Key: C = calibrated, M = manual/.test(pr.text) && /not verified any value for production/.test(pr.text), 'printable table has the status key and the not-verified note');
  await page.emulateMedia({ media: 'print' });
  const printVis = await page.evaluate(() => ({ spec: getComputedStyle(document.getElementById('print-spec')).display, app: document.getElementById('header').offsetParent === null ? 'none' : 'shown' }));
  ok(printVis.spec === 'block' && printVis.app === 'none', 'in print media only the spec table shows');
  await page.screenshot({ path: `${L.OUT}/spec-5-print.png`, fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { document.body.classList.remove('printing-spec'); const e = document.getElementById('print-spec'); if (e) e.remove(); });

  /* ---- keyboard / a11y ---- */
  R.section('accessibility');
  const unlabeled = await page.$$eval('#sec-spec input', e => e.filter(i => !i.getAttribute('aria-label')).length);
  ok(unlabeled === 0, 'every spec input has an accessible name');
  await page.focus(cellSel('chest', 'S')); await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.activeElement.classList.contains('spec-in')), 'Tab moves between cells and keeps focus in the table');
  const status = await page.getAttribute(cellSel('chest', 'S'), 'aria-label');
  ok(/Estimated|Calibrated|Manual/.test(status), 'cell label announces its status: ' + status);
  ok(await page.evaluate(() => document.querySelector('.spec-grid-wrap').getAttribute('tabindex') === '0'), 'the sideways-scrolling table can be reached by keyboard');
  noErrorsCheck();

  /* ---- other sizes: phone width ---- */
  R.section('phone');
  const p2 = await L.newPage(browser, { width: 390, height: 844, mode: 'advanced' }); L.watch(p2.page, errs);
  await p2.page.goto(url + '#/'); await p2.page.waitForSelector('#home:not([hidden])');
  await p2.page.click('#home >> text=Try a sample shirt');
  await p2.page.waitForFunction(() => window.__threadform.state.views.front.current);
  await p2.page.waitForFunction(() => { const u = window.__threadform.state.ui; return !u.busy && !u.processing; }); await p2.page.waitForTimeout(400);
  await p2.page.click('#dock-right'); await p2.page.click('#rtab-measure');
  await p2.page.evaluate(() => { document.getElementById('sec-spec').open = true; document.getElementById('sec-spec').scrollIntoView(); });
  await p2.page.waitForTimeout(300);
  const ov = await p2.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok(ov.sw <= ov.iw, `no horizontal page scroll at 390 px (${ov.sw} <= ${ov.iw})`);
  await p2.page.screenshot({ path: `${L.OUT}/spec-6-phone.png` });
  noErrorsCheck();

  function noErrorsCheck() { ok(errs.length === 0, `no JS errors / failed requests / CSP violations ${JSON.stringify(errs.slice(0, 3))}`); errs.length = 0; }
  await browser.close(); srv.close();
  process.exit(R.done() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
