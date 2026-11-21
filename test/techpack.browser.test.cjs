// Professional tech pack builder (roadmap v2 phase 5): drawings, callouts, graded size chart, materials / trims / stitching /
// construction, artwork placement with dimensions, revision details, A4 print layout, multi-sheet spreadsheet + CSV bundle,
// persistence. Run: node test/techpack.browser.test.cjs   (served with the production CSP; any JS error / CSP violation fails)
const { chromium } = require('playwright');
const fs = require('fs');
const L = require('./e2e/lib.cjs');
const R = L.runner('techpack');
const { ok } = R;

(async () => {
  const { srv, url } = await L.staticServer();
  const browser = await chromium.launch();
  const errs = [];
  const { ctx, page } = await L.newPage(browser, { width: 1440, height: 900, mode: 'advanced' }); L.watch(page, errs);
  const shot = n => page.screenshot({ path: `${L.OUT}/techpack-${n}.png` });
  const noErr = m => { ok(errs.length === 0, `${m}: no JS errors / failed requests / CSP violations ${JSON.stringify(errs.slice(0, 3))}`); errs.length = 0; };

  await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])');
  await page.click('#home >> text=Try a sample shirt');
  await page.waitForFunction(() => window.__threadform.state.views.front.current);
  await L.T(page).settle();

  /* ---- no garment: friendly message; with one: menu item opens the dialog ---- */
  R.section('open');
  // give the design artwork, a back view and a side view so every drawing and placement exists
  await page.evaluate(async () => {
    const E = await import('/js/elements.js'), M = await import('/js/state.js'), S = M.state;
    const t = E.createElement('text', { text: 'ATHENS', x: 512, y: 330, view: 'front' });
    const c = E.createElement('crest', { x: 600, y: 420, view: 'front' }); c.w = 90; c.h = 100;
    const st = E.createElement('stripe', { x: 512, y: 560, view: 'front' });
    const bt = E.createElement('text', { text: 'CLUB 1989', x: 512, y: 380, view: 'back' });
    const pp = E.createElement('piping', { x: 512, y: 700, view: 'all' });
    S.elements.push(t, c, st, bt, pp); M.notify('elements');
  });
  for (const v of ['Back', 'Side', 'Detail']) { await page.click(`[role=tab]:has-text("${v}")`).catch(() => { }); await page.waitForTimeout(500); await L.T(page).settle(); }
  await page.click('[role=tab]:has-text("Front")').catch(() => { }); await L.T(page).settle();
  await page.click('#btn-export'); await page.click('#btn-techpack');
  await page.waitForSelector('.tp-dlg #tp-doc .tp-page');
  await page.waitForFunction(() => document.querySelectorAll('#tp-doc img').length >= 4, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const pages = await page.$$eval('#tp-doc .tp-page', e => e.map(x => x.getAttribute('aria-label')));
  ok(pages.length === 8, `eight A4 pages ${pages.length}`);
  await shot('1-dialog');

  /* ---- drawings ---- */
  R.section('drawings');
  const imgs = await page.$$eval('#tp-doc .tp-draw img, #tp-doc .tp-hero-fig img', e => e.map(i => ({ w: i.naturalWidth, h: i.naturalHeight, alt: i.alt })));
  ok(imgs.length >= 5 && imgs.every(i => i.w > 200 && i.h > 200), `front, back, side and detail drawings rendered ${JSON.stringify(imgs.map(i => i.w + 'x' + i.h))}`);
  ok(await page.$$eval('#tp-doc .tp-draw figcaption', e => e.map(x => x.textContent).join('|')).then(t => /Front/.test(t) && /Back/.test(t) && /Side/.test(t) && /Detail/.test(t)), 'figure captions name front, back, side, detail');
  const pix = await page.evaluate(() => new Promise(res => {   // the front drawing really contains black outline pixels and callout colour, on white
    const im = document.querySelector('#tp-doc .tp-draw img'); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; let dark = 0, white = 0, ink = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 200) { if (d[i] < 60 && d[i + 1] < 60) dark++; if (d[i] > 245 && d[i + 1] > 245) white++; if (d[i] > 150 && d[i + 2] < 90) ink++; } } res({ dark, white, ink, n: d.length / 4 });
  }));
  ok(pix.dark > 800 && pix.white > pix.n * 0.3, `drawing is black line art on white (${JSON.stringify(pix)})`);
  ok(pix.ink > 100, 'artwork placement boxes are drawn on the front drawing');
  await page.evaluate(() => { document.querySelector('#tp-doc .tp-page:nth-child(2)').scrollIntoView(); });
  await page.waitForTimeout(200); await shot('2-drawings');

  /* ---- content that comes from the design (nothing typed yet) ---- */
  R.section('automatic content');
  const txt = p => page.evaluate(i => document.querySelectorAll('#tp-doc .tp-page')[i].innerText, p);
  const cover = await txt(0);
  ok(/Not production-verified/.test(cover) && /Estimated/.test(cover), 'cover states estimates are not production-verified');
  ok(/Design name/.test(cover) && /Design ID/.test(cover) && /Garment type/.test(cover) && /Revision/.test(cover) && /Scale/.test(cover), 'cover has design identifiers, garment type, revision and scale');
  const chart = await txt(3);
  ok(/POM-01/.test(chart) && /POM-09/.test(chart) && /XXL/.test(chart) && /Tol/.test(chart), 'size chart page lists POM-01..09 with sizes and tolerance');
  const cells = await page.$$eval('#tp-doc .tp-chart td.tp-v', e => e.map(x => x.className));
  ok(cells.length === 54 && cells.every(c => /tp-(estimated|calibrated|manual)/.test(c)), 'every size chart value carries a status class');
  ok(/to /.test(await page.$eval('#tp-doc .tp-chart td.tp-v .tp-rng', e => e.textContent)), 'tolerance range (min to max) shown under each value');
  const mats = await txt(4);
  ok(/Main body/.test(mats) && /Stripes/.test(mats) && /Piping/.test(mats), 'materials come from the design (body, stripes, piping)');
  ok(await page.$$eval('#tp-doc .tp-sw', e => e.length) >= 3, 'colour swatches read from the design');
  ok(/Piping/.test(mats) && /Origin/.test(mats) && /From design/.test(mats), 'auto rows are labelled From design');
  const art = await txt(6);
  ok(/ATHENS/.test(art) && /CLUB 1989/.test(art) && /Crest/.test(art), 'artwork table lists front and back artwork');
  ok(/HPS/.test(art) && /hem/.test(art) && /centre/i.test(art), 'artwork rows give positioning references (HPS, hem, centre line)');
  const artRows = await page.$$eval('#tp-doc .tp-art tbody tr', e => e.map(r => [...r.children].map(c => c.textContent)));
  ok(artRows.length === 6, `five layers, one on both views -> 6 placements (${artRows.length})`);
  ok(artRows.every(r => /Estimated|Calibrated/.test(r.join('|'))), 'every artwork dimension is labelled Estimated or Calibrated');
  ok(await page.$$eval('#tp-doc .tp-detail', e => e.length) >= 4, 'artwork detail drawings exist');
  await page.evaluate(() => { document.querySelectorAll('#tp-doc .tp-page')[6].scrollIntoView(); }); await page.waitForTimeout(200); await shot('3-artwork');

  /* ---- editor: fill fields, suggest, add rows ---- */
  R.section('editor');
  await page.fill('#tpf-styleNo', 'CE-LS-001'); await page.press('#tpf-styleNo', 'Tab');
  await page.fill('#tpf-season', 'SS27'); await page.press('#tpf-season', 'Tab');
  await page.fill('#tpf-supplier', 'Porto Knit Co'); await page.press('#tpf-supplier', 'Tab');
  await page.fill('#tpf-revNo', '3'); await page.press('#tpf-revNo', 'Tab');
  await page.fill('#tpf-revDate', '2026-11-20'); await page.press('#tpf-revDate', 'Tab');
  await page.fill('#tpf-revAuthor', 'Ana Silva'); await page.press('#tpf-revAuthor', 'Tab');
  await page.waitForTimeout(300);
  const cover2 = await txt(0);
  ok(/CE-LS-001/.test(cover2) && /SS27/.test(cover2) && /Porto Knit Co/.test(cover2) && /3 · 2026-11-20 · Ana Silva/.test(cover2), 'identity and revision fields appear on the cover');
  ok(/Rev 3/.test(await page.$eval('#tp-doc .tp-foot', e => e.textContent)), 'footer repeats the revision');
  await page.click('[data-add=materials]'); const mrow = '[data-list=materials] .tp-row:last-child';
  await page.fill(`${mrow} [data-c=part]`, 'Body'); await page.fill(`${mrow} [data-c=composition]`, '100% organic cotton'); await page.fill(`${mrow} [data-c=weight]`, '220'); await page.press(`${mrow} [data-c=weight]`, 'Tab');
  await page.click('[data-add=trims]'); const trow = '[data-list=trims] .tp-row:last-child';
  await page.fill(`${trow} [data-c=item]`, 'Woven main label'); await page.fill(`${trow} [data-c=placement]`, 'Centre back neck'); await page.press(`${trow} [data-c=placement]`, 'Tab');
  await page.click('#tp-suggest'); await page.waitForTimeout(300);
  ok(await page.$$eval('[data-list=stitching] .tp-row', e => e.length) >= 5 && await page.$$eval('[data-list=stitching] .tp-sug', e => e.length) >= 5, 'suggest fills stitching rows, flagged suggested');
  await page.fill('[data-list=stitching] .tp-row:first-child [data-c=notes]', 'Taped for stability'); await page.press('[data-list=stitching] .tp-row:first-child [data-c=notes]', 'Tab');
  await page.fill('#tpf-p-washCare', 'Machine wash cold, inside out'); await page.press('#tpf-p-washCare', 'Tab');
  await page.fill('#tpf-p-notes', 'Pre-production sample before bulk.'); await page.press('#tpf-p-notes', 'Tab');
  await page.click('[data-add=revisions]'); const rrow = '[data-list=revisions] .tp-row:last-child';
  await page.fill(`${rrow} input:nth-child(1)`, '2'); await page.fill(`${rrow} input:nth-child(2)`, '2026-11-10'); await page.fill(`${rrow} input:nth-child(3)`, 'Ben Ode'); await page.fill(`${rrow} input:nth-child(4)`, 'Sleeve flare reduced'); await page.press(`${rrow} input:nth-child(4)`, 'Tab');
  await page.waitForTimeout(300);
  ok(/100% organic cotton/.test(await txt(4)) && /Woven main label/.test(await txt(4)), 'materials and trims typed in show on page 5');
  const st = await txt(5);
  ok(/Taped for stability/.test(st) && /Suggested, confirm/.test(st) && /Entered/.test(st) && /Construction notes/.test(st), 'stitching shows suggested vs entered lines');
  const last = await txt(7);
  ok(/Machine wash cold/.test(last) && /Pre-production sample/.test(last) && /Sleeve flare reduced/.test(last) && /Ben Ode/.test(last) && /Sign-off/.test(last), 'production notes, revision log and sign-off on the last page');
  ok(/Saved version/.test(last), 'revision details include the design version history');
  await page.evaluate(() => { document.querySelectorAll('#tp-doc .tp-page')[7].scrollIntoView(); }); await page.waitForTimeout(150); await shot('4-last-page');
  await page.evaluate(() => { document.querySelectorAll('#tp-doc .tp-page')[4].scrollIntoView(); }); await page.waitForTimeout(150); await shot('5-materials');
  noErr('editor');

  /* ---- exports ---- */
  R.section('exports');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tp-xml')]);
  const xml = fs.readFileSync(await dl.path(), 'utf8');
  ok(/\.xml$/.test(dl.suggestedFilename()) && /<Workbook/.test(xml), `spreadsheet downloaded ${dl.suggestedFilename()}`);
  const names = [...xml.matchAll(/<Worksheet ss:Name="([^"]+)"/g)].map(m => m[1]);
  ok(['Overview', 'Size chart', 'Materials', 'Colours', 'Trims', 'Stitching', 'Construction', 'Artwork placement', 'Revisions', 'Production notes'].every(n => names.includes(n)), `one sheet per section ${names}`);
  const parsed = await page.evaluate(x => { const d = new DOMParser().parseFromString(x, 'application/xml'); return { err: !!d.querySelector('parsererror'), sheets: d.getElementsByTagName('Worksheet').length }; }, xml);
  ok(!parsed.err && parsed.sheets === names.length, 'spreadsheet is well-formed XML');
  ok(/CE-LS-001/.test(xml) && /NOT production-verified/.test(xml) && /Estimated/.test(xml) && /Ana Silva/.test(xml), 'spreadsheet carries identifiers, revision and honest labels');
  ok(/ss:Type="Number">5\d(\.\d+)?</.test(xml), 'numbers are real numeric cells');
  // CSV bundle: one file per section
  const files = [];
  page.on('download', d => files.push(d));
  await page.click('#tp-csv'); await page.waitForFunction(() => document.querySelector('#toasts, .toast') && /CSV files downloaded/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => { });
  await page.waitForTimeout(800);
  const csv = {}; for (const f of files) csv[f.suggestedFilename()] = fs.readFileSync(await f.path(), 'utf8');
  ok(Object.keys(csv).length >= 9 && Object.keys(csv).every(n => /-techpack-[a-z]+\.csv$/.test(n)), `CSV bundle ${Object.keys(csv)}`);
  const sc = Object.entries(csv).find(([n]) => /sizechart/.test(n))[1];
  ok(/POM-01/.test(sc) && /Estimated/.test(sc) && /XXL \(cm\)/.test(sc) && /XS min/.test(sc), 'size chart CSV has sizes, tolerance range and status');
  ok(/Entered/.test(Object.entries(csv).find(([n]) => /stitching/.test(n))[1]) && /Suggested, confirm/.test(Object.entries(csv).find(([n]) => /stitching/.test(n))[1]), 'stitching CSV labels suggested vs entered');
  ok(/HPS/.test(Object.entries(csv).find(([n]) => /artwork/.test(n))[1]), 'artwork CSV has HPS positioning');

  /* ---- print layout: multi-page A4 ---- */
  R.section('print');
  await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await page.click('#tp-print'); await page.waitForFunction(() => window.__printed, null, { timeout: 15000 });
  ok(await page.evaluate(() => document.body.classList.contains('printing-tp') && !!document.getElementById('print-techpack')), 'print layout is attached and the page is in print mode');
  const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(`${L.OUT}/techpack.pdf`, pdf);
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  ok(pageCount >= 8 && pageCount <= 14, `PDF is multi-page A4 (${pageCount} pages)`);
  ok(/\/MediaBox\s*\[\s*0\s+0\s+841\.\d+\s+59[45]\.\d+/.test(pdf.toString('latin1')), 'PDF pages are A4 landscape');
  await page.evaluate(() => { document.body.classList.remove('printing-tp'); document.getElementById('print-techpack')?.remove(); });
  noErr('exports');

  /* ---- persistence: the fields survive save and reload; undo works ---- */
  R.section('persistence');
  const saved = await page.evaluate(() => JSON.stringify(window.__threadform.state.techpack));
  ok(/CE-LS-001/.test(saved) && /Ana Silva/.test(saved) && /100% organic cotton/.test(saved) && /"s":true/.test(saved), 'state.techpack holds the fields (suggested flag kept)');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.waitForFunction(() => /Saved/.test(document.querySelector('.save-status')?.textContent || ''), null, { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.reload(); await page.waitForFunction(() => window.__threadform && window.__threadform.state.views.front.current, null, { timeout: 30000 });
  await L.T(page).settle();
  const after = await page.evaluate(() => JSON.stringify(window.__threadform.state.techpack));
  ok(after === saved, 'tech pack fields identical after reload');
  await page.click('#btn-export'); await page.click('#btn-techpack'); await page.waitForSelector('#tp-doc .tp-page');
  ok(await page.inputValue('#tpf-styleNo') === 'CE-LS-001' && /Ana Silva/.test(await txt(0)), 'reopened editor shows the saved fields');
  // undo reverts the last tech pack edit
  await page.fill('#tpf-season', 'AW99'); await page.press('#tpf-season', 'Tab'); await page.waitForTimeout(200);
  ok(/AW99/.test(await txt(0)), 'edit shows');
  await page.evaluate(async () => { (await import('/js/state.js')).undo(); }); await page.waitForTimeout(500);
  ok(await page.inputValue('#tpf-season') === 'SS27', 'undo restores the previous season');
  ok(/removes all|Remove/.test(await page.textContent('[data-list=materials]')), 'rows have a Remove button');
  await page.click('[data-list=materials] .tp-row:last-child button'); await page.waitForTimeout(300);
  ok(!/100% organic cotton/.test(await txt(4)), 'removing a materials row removes it from the pack');
  // keyboard: Escape closes the dialog and focus returns
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok(await page.$('.tp-dlg') === null, 'Escape closes the tech pack dialog');
  noErr('persistence');

  /* ---- calibrated scale changes labels ---- */
  R.section('calibration label');
  await page.evaluate(async () => { const M = await import('/js/state.js'); M.state.measure = { ...M.state.measure, manual: { key: 'chest', cm: 54 } }; M.notify('measure'); });
  await page.waitForTimeout(500);
  await page.click('#btn-export'); await page.click('#btn-techpack'); await page.waitForSelector('#tp-doc .tp-page');
  await page.waitForTimeout(800);
  const calArt = await page.$$eval('#tp-doc .tp-art tbody tr', e => e.map(r => r.lastElementChild.textContent));
  ok(calArt.every(t => /Calibrated scale/.test(t)), `artwork dimension labels switch to calibrated scale ${calArt}`);
  ok(/Calibrated/.test(await txt(3)) || await page.$$eval('#tp-doc .tp-chart td.tp-calibrated', e => e.length) > 0, 'size chart marks the calibrated value');
  await page.keyboard.press('Escape');

  /* ---- phone width ---- */
  R.section('responsive');
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  await page.click('#btn-export').catch(async () => { await page.click('#dock-edit').catch(() => { }); });
  await page.evaluate(() => document.getElementById('btn-techpack') && document.getElementById('btn-techpack').click());
  await page.waitForSelector('.tp-dlg'); await page.waitForTimeout(800);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, dw: document.querySelector('.tp-dlg').getBoundingClientRect().width }));
  ok(ov.sw <= ov.iw && ov.dw <= ov.iw, `no horizontal page overflow at 390 px ${JSON.stringify(ov)}`);
  await shot('6-phone');
  noErr('responsive');

  await browser.close(); srv.close();
  process.exit(R.done() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
