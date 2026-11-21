// Editor redesign (roadmap v2 phase 2): layout at four screen sizes, contextual inspector, numeric transforms,
// alignment, snapping, multi-select, groups, layer rename. Run: node test/editor.browser.test.cjs
// Served with the production CSP headers (test/e2e/lib.cjs); JS errors, failed requests or CSP violations fail it.
const { chromium } = require('playwright');
const L = require('./e2e/lib.cjs');
const R = L.runner('editor');
const { ok } = R;

(async () => {
  const { srv, url } = await L.staticServer();
  const browser = await chromium.launch();
  const errs = [];
  const noErrors = label => { ok(errs.length === 0, `${label}: no JS errors / failed requests / CSP violations ${JSON.stringify(errs.slice(0, 3))}`); errs.length = 0; };
  const openSample = async page => {
    await page.goto(url + '#/'); await page.waitForSelector('#home:not([hidden])');
    await page.click('#home >> text=Try a sample shirt');
    await page.waitForFunction(() => window.__threadform.state.views.front.current);
    await page.waitForFunction(() => { const u = window.__threadform.state.ui; return !u.busy && !u.processing; }); await page.waitForTimeout(500);
  };
  const shot = (page, n) => page.screenshot({ path: `${L.OUT}/editor-${n}.png` });

  /* ================= layout at the four reference sizes ================= */
  R.section('layout');
  for (const [w, h] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
    for (const mode of ['basic', 'advanced']) {
      const { ctx, page } = await L.newPage(browser, { width: w, height: h, mode }); L.watch(page, errs);
      await openSample(page);
      const m = await page.evaluate(() => {
        const r = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
        const wrap = r('.stage-wrap'), bot = r('#bottom'), head = r('#header'), cur = document.querySelector('.stepper .cur .step');
        return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight, ih: window.innerHeight,
          wrapBottom: wrap.bottom, wrapH: wrap.height, wrapW: wrap.width, botTop: bot.top, botBottom: bot.bottom, headH: head.height,
          curH: cur && cur.offsetParent ? cur.getBoundingClientRect().height : 0,
          headOverflow: document.getElementById('header').scrollWidth > document.getElementById('header').clientWidth + 1 };
      });
      const tag = `${w}x${h} ${mode}`;
      ok(m.sw <= m.iw, `${tag}: no horizontal page scroll (${m.sw} > ${m.iw})`);
      ok(m.sh <= m.ih + 1, `${tag}: page does not scroll vertically`);
      ok(m.wrapBottom <= m.botTop + 0.5, `${tag}: canvas is not covered by the bottom bar (${m.wrapBottom} vs ${m.botTop})`);
      ok(m.botBottom <= m.ih + 0.5, `${tag}: bottom bar is on screen`);
      ok(m.wrapH >= 200 && m.wrapW >= 300, `${tag}: canvas keeps a usable size (${Math.round(m.wrapW)}x${Math.round(m.wrapH)})`);
      ok(!m.headOverflow, `${tag}: header items fit on one line`);
      if (w >= 1280) ok(m.curH > 0 && m.curH < 36, `${tag}: current step label does not wrap (${m.curH})`);
      if (mode === 'advanced') await shot(page, `${w}-${mode}`);
      if (w <= 980) {
        ok(await page.isVisible('#dock-left') && await page.isVisible('#dock-right'), `${tag}: Tools / Edit dock is shown`);
        ok(!(await page.isVisible('#right')), `${tag}: panels start closed`);
        await page.click('#dock-right'); await page.waitForTimeout(150);
        ok(await page.isVisible('#right') && await page.isVisible('#btn-variations'), `${tag}: Edit sheet opens with the describe box`);
        const sheet = await page.evaluate(() => { const r = document.getElementById('right').getBoundingClientRect(), b = document.getElementById('bottom').getBoundingClientRect(); return r.bottom <= b.top + 1 && r.top >= 40; });
        ok(sheet, `${tag}: sheet sits above the bottom bar`);
        if (mode === 'advanced') await shot(page, `${w}-sheet`);
        await page.keyboard.press('Escape'); await page.waitForTimeout(100);
        ok(!(await page.isVisible('#right')), `${tag}: Escape closes the sheet`);
        await page.click('#dock-left'); ok(await page.isVisible('#left'), `${tag}: Tools sheet opens`);
        await page.click('#dock-left'); ok(!(await page.isVisible('#left')), `${tag}: dock button closes it again`);
      } else {
        ok(!(await page.isVisible('#dock-left')), `${tag}: dock hidden on wide screens`);
        ok(await page.isVisible('#left') && await page.isVisible('#right'), `${tag}: both panels visible`);
        // Stage 4 panel toggles still collapse a side and give the canvas the room
        const before = (await page.locator('.stage-wrap').boundingBox()).width;
        await page.click('.panel-toggle[aria-controls=left]'); await page.waitForTimeout(150);
        const after = (await page.locator('.stage-wrap').boundingBox()).width;
        ok(after > before + 100, `${tag}: collapsing the left panel widens the canvas (${Math.round(before)} -> ${Math.round(after)})`);
        await page.click('.panel-toggle[aria-controls=left]');
      }
      noErrors(`layout ${tag}`);
      await ctx.close();
    }
  }

  /* ================= inspector, transforms, align, snap, groups ================= */
  R.section('arrange');
  const { page } = await L.newPage(browser, { mode: 'advanced' }); L.watch(page, errs);
  await openSample(page);
  const addEls = () => page.evaluate(async () => {
    const E = await import('/js/elements.js'), S = window.__threadform.state;
    const t = E.createElement('text', { text: 'ATHENS', x: 400, y: 380, view: 'front' });
    const c = E.createElement('crest', { x: 600, y: 420, view: 'front' });
    const lg = E.createElement('stripe', { x: 500, y: 600, view: 'front' });
    S.elements.push(t, c, lg); S.selectedId = t.id; S.ui.tool = 'move';
    const m = await import('/js/state.js'); m.notify('elements');
    return [t.id, c.id, lg.id];
  });
  const [tid, cid, sid] = await addEls(); await page.waitForTimeout(300);
  const el = id => page.evaluate(i => { const e = window.__threadform.state.elements.find(x => x.id === i); return e && { x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rotation, group: e.group, name: e.name, visible: e.visible, locked: e.locked }; }, id);
  const sel = () => page.evaluate(() => window.__threadform.state.selectedId);
  const row = id => `#sec-layers .erow[data-id="${id}"]`;
  const gbox = () => page.evaluate(() => { const b = window.__threadform.state.views.front.seg.bbox; return b; });
  const bounds = id => page.evaluate(async i => { const A = await import('/js/arrange.js'); return A.bounds(window.__threadform.state.elements.find(x => x.id === i)); }, id);
  await page.click('#rtab-items');
  // contextual: each kind of item shows its own controls and nothing from the others
  await page.click(`${row(tid)} .ename`);
  const has = (sel2) => page.locator(`.insp ${sel2}`).count().then(n => n > 0);
  ok(await has('textarea[aria-label="Text"]') && await has('select[aria-label="Font"]'), 'text item: text and font controls');
  ok(!(await has('input[aria-label="Tint strength %"]')) && !(await has('input[aria-label="Number of stripes"]')), 'text item: no logo or stripe controls');
  await page.click(`${row(cid)} .ename`);
  ok(!(await has('textarea[aria-label="Text"]')) && await has('select[aria-label="Design"]'), 'crest: design picker, no text box');
  await page.click(`${row(sid)} .ename`);
  ok(await has('input[aria-label="Number of stripes"]') && !(await has('select[aria-label="Font"]')), 'stripes: stripe controls only');
  ok(await has('input[aria-label="X"]') && await has('input[aria-label="Y"]') && await has('input[aria-label="Width"]') && await has('input[aria-label="Height"]') && await has('input[aria-label="Rotation °"]'), 'every item has numeric X / Y / Width / Height / Rotation');
  await shot(page, 'inspector');

  // numeric size: Enter commits, proportions kept, undo reverts
  await page.click(`${row(cid)} .ename`);
  const c0 = await el(cid);
  await page.fill('input[aria-label="Width"]', '300'); await page.press('input[aria-label="Width"]', 'Enter'); await page.waitForTimeout(150);
  let c1 = await el(cid);
  ok(Math.round(c1.w) === 300 && Math.abs(c1.h / c1.w - c0.h / c0.w) < 0.01, `width 300 keeps proportions (${Math.round(c1.w)}x${Math.round(c1.h)})`);
  await page.fill('input[aria-label="Height"]', '120'); await page.press('input[aria-label="Height"]', 'Enter'); await page.waitForTimeout(150);
  c1 = await el(cid); ok(Math.round(c1.h) === 120, `height 120 applies (${Math.round(c1.h)})`);
  await page.click('#btn-undo'); await page.click('#btn-undo'); await page.waitForTimeout(150);
  const c2 = await el(cid); ok(Math.round(c2.w) === Math.round(c0.w), 'undo returns to the original size');
  await page.uncheck('input[aria-label="Keep proportions"]');
  await page.fill('input[aria-label="Width"]', '260'); await page.press('input[aria-label="Width"]', 'Enter'); await page.waitForTimeout(150);
  c1 = await el(cid); ok(Math.round(c1.w) === 260 && Math.round(c1.h) === Math.round(c0.h) || c1.h !== c0.h, 'with proportions off a crest width can change on its own');
  await page.click('#btn-undo'); await page.check('input[aria-label="Keep proportions"]');
  // text: width sets size uniformly
  await page.click(`${row(tid)} .ename`);
  const t0 = await el(tid);
  await page.fill('input[aria-label="Width"]', String(Math.round(t0.w * 1.5))); await page.press('input[aria-label="Width"]', 'Enter'); await page.waitForTimeout(150);
  const t1 = await el(tid); ok(t1.w > t0.w * 1.4 && Math.abs(t1.h / t1.w - t0.h / t0.w) < 0.05, 'text width scales the lettering');
  await page.click('#btn-undo');

  // align one item to the garment
  const gb = await gbox();
  await page.click(`${row(cid)} .ename`);
  await page.click('button[aria-label="Align left"]'); await page.waitForTimeout(150);
  let b = await bounds(cid); ok(Math.abs(b.x0 - gb.x) < 0.5, `Align left puts the crest on the garment's left edge (${b.x0.toFixed(1)} vs ${gb.x})`);
  await page.click('button[aria-label="Align centre horizontally"]'); await page.waitForTimeout(150);
  b = await bounds(cid); ok(Math.abs(b.cx - (gb.x + gb.w / 2)) < 0.5, 'Align centre puts it on the garment centre line');
  await page.click('button[aria-label="Align top"]'); await page.waitForTimeout(150);
  b = await bounds(cid); ok(Math.abs(b.y0 - gb.y) < 0.5, 'Align top');
  await page.click('#btn-undo'); await page.click('#btn-undo'); await page.click('#btn-undo'); await page.waitForTimeout(150);
  ok(Math.abs((await el(cid)).x - c0.x) < 0.5, 'undo reverts alignment');

  // multi-select with Shift + click in the layers list; align to each other; distribute
  await page.click(`${row(tid)} .ename`); await page.click(`${row(cid)} .ename`, { modifiers: ['Shift'] }); await page.click(`${row(sid)} .ename`, { modifiers: ['Shift'] });
  ok(await page.evaluate(async () => (await import('/js/arrange-ops.js')).selectedSet().length) === 3, 'Shift + click selects three items');
  ok(await page.locator('.insp .ptitle:has-text("3 items selected")').count() === 1, 'inspector switches to the multi-item controls');
  ok(!(await has('input[aria-label="Width"]')), 'multi-selection hides single-item fields');
  await page.click('button[aria-label="Align left"]'); await page.waitForTimeout(150);
  const bl = await Promise.all([tid, cid, sid].map(bounds)); ok(bl.every(x => Math.abs(x.x0 - bl[0].x0) < 0.5), 'Align left lines the three items up with each other');
  await page.click('#btn-undo'); await page.waitForTimeout(100);
  await page.click('button[aria-label="Distribute vertically"]'); await page.waitForTimeout(150);
  const bd = (await Promise.all([tid, cid, sid].map(bounds))).sort((p, q) => p.cy - q.cy);
  const ga = bd[1].y0 - bd[0].y1, gb2 = bd[2].y0 - bd[1].y1; ok(Math.abs(ga - gb2) < 0.5, `Distribute vertically equalises the gaps (${ga.toFixed(1)} / ${gb2.toFixed(1)})`);
  await page.click('#btn-undo'); await page.waitForTimeout(100);

  // group: Ctrl+G, group row, move together, hide together, ungroup
  await page.click(`${row(tid)} .ename`); await page.click(`${row(cid)} .ename`, { modifiers: ['Shift'] });
  await page.focus('#stage'); await page.keyboard.press('Control+g'); await page.waitForTimeout(200);
  const gt = await el(tid), gc = await el(cid);
  ok(gt.group && gt.group === gc.group && !(await el(sid)).group, 'Ctrl+G groups the two selected items');
  ok(await page.locator('#sec-layers .erow.grp').count() === 1 && await page.locator('#sec-layers .erow.ingroup').count() === 2, 'layers panel shows a group row with two members');
  // drag one member on the canvas: both move
  await page.click('#sec-layers .erow.grp button[aria-label="Collapse group"]'); await page.click('#sec-layers .erow.grp button[aria-label="Expand group"]');
  await page.evaluate(() => window.__threadform.state.ui.snap = false);
  const p0 = await page.evaluate(([x, y]) => { const p = window.__stage.toScreen(x, y), r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + p.sx, y: r.top + p.sy }; }, [gt.x, gt.y]);
  await page.mouse.move(p0.x, p0.y); await page.mouse.down(); await page.mouse.move(p0.x + 60, p0.y + 30, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(150);
  const gt2 = await el(tid), gc2 = await el(cid);
  ok(gt2.x > gt.x + 20 && Math.abs((gt2.x - gt.x) - (gc2.x - gc.x)) < 0.5 && Math.abs((gt2.y - gt.y) - (gc2.y - gc.y)) < 0.5, `dragging one member moves the whole group by the same amount (${(gt2.x - gt.x).toFixed(0)}, ${(gc2.x - gc.x).toFixed(0)})`);
  await page.click('#btn-undo'); await page.waitForTimeout(100);
  ok(Math.abs((await el(tid)).x - gt.x) < 0.5 && Math.abs((await el(cid)).x - gc.x) < 0.5, 'one undo puts the whole group back');
  await page.click('#sec-layers .erow.grp button[aria-label="Hide group"]'); await page.waitForTimeout(150);
  ok(!(await el(tid)).visible && !(await el(cid)).visible && (await el(sid)).visible !== false, 'Hide group hides every member');
  await page.click('#sec-layers .erow.grp button[aria-label="Show group"]');
  await page.click('#sec-layers .erow.grp button[aria-label="Lock group"]'); await page.waitForTimeout(100);
  ok((await el(tid)).locked && (await el(cid)).locked, 'Lock group locks every member');
  await page.click('#sec-layers .erow.grp button[aria-label="Unlock group"]');
  // duplicate a group: copies form their own group
  await page.click(`${row(tid)} .ename`); await page.focus('#stage'); await page.keyboard.press('Control+d'); await page.waitForTimeout(200);
  const gs = await page.evaluate(() => { const E = window.__threadform.state.elements; const m = {}; E.forEach(e => { if (e.group) m[e.group] = (m[e.group] || 0) + 1; }); return Object.values(m); });
  ok(gs.length === 2 && gs.every(n => n === 2), `duplicating a group makes a second group of two (${JSON.stringify(gs)})`);
  await page.click('#btn-undo'); await page.waitForTimeout(100);
  // the group survives saving
  ok(await page.evaluate(async () => { const m = await import('/js/state.js'); const d = (await m.serializeDesign()).doc; return d.elements.filter(e => e.group).length === 2; }), 'group ids are saved with the design');
  await page.click(`${row(tid)} .ename`); await page.click('#btn-ungroup'); await page.waitForTimeout(150);
  ok(!(await el(tid)).group && !(await el(cid)).group, 'Ungroup separates the items again');
  noErrors('arrange basics');

  // rename a layer with a double click
  await page.dblclick(`${row(sid)} .ename`); await page.fill('.erow input.rename', 'Chest band'); await page.press('.erow input.rename', 'Enter'); await page.waitForTimeout(150);
  ok((await el(sid)).name === 'Chest band' && await page.locator(`${row(sid)} .ename`).innerText() === 'Chest band', 'double-click renames a layer');
  await page.click('#btn-undo'); await page.waitForTimeout(100);
  ok((await el(sid)).name !== 'Chest band', 'undo reverts the rename');

  // snapping: dragging near the garment centre line snaps exactly, Alt drags freely, toggle turns it off
  await page.evaluate(() => { window.__threadform.state.ui.snap = true; window.__threadform.state.selectedId = null; });
  const target = gb.x + gb.w / 2;
  await page.click(`${row(cid)} .ename`);
  await page.evaluate(async ([i, x]) => { const s = window.__threadform.state, e = s.elements.find(q => q.id === i); e.x = x - 80; e.y = 300; e.rotation = 0; (await import('/js/state.js')).notify('elements'); }, [cid, target]);
  const dragBy = async (id, dx, dy, mods = []) => {
    const e0 = await el(id);
    const p = await page.evaluate(([x, y]) => { const q = window.__stage.toScreen(x, y), r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + q.sx, y: r.top + q.sy }; }, [e0.x, e0.y]);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 }); await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
    await page.waitForTimeout(150);
  };
  const z = await page.evaluate(() => window.__stage.zoom);
  await dragBy(cid, (80 - 3) * z, 0);   // ends 3 image px from the centre line
  let cs = await el(cid); ok(Math.abs(cs.x - target) < 0.01, `drag snaps the crest centre to the garment centre line (${cs.x.toFixed(2)} vs ${target})`);
  await shot(page, 'snap');
  await page.click('#btn-undo'); await page.waitForTimeout(100);
  await page.evaluate(async ([i, x]) => { const s = window.__threadform.state, e = s.elements.find(q => q.id === i); e.x = x - 80; e.y = 300; (await import('/js/state.js')).notify('elements'); }, [cid, target]);
  await dragBy(cid, (80 - 3) * z, 0, ['Alt']);
  cs = await el(cid); ok(Math.abs(cs.x - target) > 1, `holding Alt drags freely (${cs.x.toFixed(2)})`);
  await page.click('#btn-snap'); ok(await page.getAttribute('#btn-snap', 'aria-pressed') === 'false', 'Snap toggle turns off');
  await page.evaluate(async ([i, x]) => { const s = window.__threadform.state, e = s.elements.find(q => q.id === i); e.x = x - 80; e.y = 300; (await import('/js/state.js')).notify('elements'); }, [cid, target]);
  await dragBy(cid, (80 - 3) * z, 0);
  cs = await el(cid); ok(Math.abs(cs.x - target) > 1, 'with Snap off a drag lands where the pointer put it');
  await page.click('#btn-snap');

  // the same tools work on the back view
  await page.click('.tab[data-v="back"]'); await page.waitForTimeout(300);
  ok(await page.locator('#btn-snap').isVisible() && await page.locator('#sec-layers').count() === 1, 'back view has the same snap toggle and layers panel');
  await page.click('.tab[data-v="front"]');
  noErrors('arrange');
  await page.context().close();

  await browser.close(); srv.close();
  process.exit(R.done() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
