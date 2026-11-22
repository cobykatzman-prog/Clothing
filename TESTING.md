# Testing Threadform

Two layers: fast unit/server tests (`npm test`) and browser journeys (`npm run test:e2e`, Playwright, no extra installs).

```bash
npm test            # (now also spec.test: POM grading/sources/validation/CSV) server 15, shared 18, ai 16, prompt 26, mask 187, aiedit 14, measure, generate (seconds)
npm test            # server 15, shared 18, ai 19, prompt 26, mask 187, aiedit 14, aigen 8, measure, generate (seconds)
npm run verify:deploy   # post-deploy smoke test of a live URL (DEPLOY_URL=..., see README 'Verify a deploy'); not part of npm test
npm run test:e2e    # browser journeys below (about 4 minutes); screenshots go to $OUT (default <tmpdir>/threadform-e2e)
node test/e2e.browser.test.cjs          # one file at a time
```

The e2e scripts serve the app themselves with the production CSP headers from `vercel.json` (so a CSP violation, a failed request,
an external request or any `pageerror` / `console.error` fails the journey) and need `require('playwright')` to resolve.
`test/e2e.shared.browser.test.cjs` starts the real `server.mjs` (login gate + shared library) against `test/mock-supabase.mjs`.
Real Supabase / OpenAI / Render are never contacted; the AI engine is exercised only by `test/ai.browser.test.cjs`, which runs the real `server.mjs` against `test/mock-openai.mjs` (never the real OpenAI).

## Critical journeys (automated: file / journey) and the manual checklist

Tick every line by hand after a release too; each has an automated twin.

| # | Journey | Steps and expected result | Automated |
|---|---|---|---|
| 1 | Create | Home empty state; New design opens chooser, Esc closes; Try a sample shirt opens `#/design/<id>` with front + back loaded; no console errors | e2e J1 |
| 2 | Shape controls | All 11 sliders change the picture, set exactly one parameter, return to the original pixels at 0; typed value, Reset, double-click reset, Reset shape; undo/redo; all fit/sleeve presets apply, show active, Clear works | e2e J2 |
| 3 | Views in sync | Shape set on front reaches back, side (built later) and survives switching tabs; a change made on the side view reaches front and back; widths of front and back match | e2e J3 |
| 4 | Layers | Add text, graphic, uploaded logo, stripes, piping, patch; select from the layers list and by clicking the canvas; edit text, size %, rotation, X/Y in the inspector; drag, corner-resize and rotate on the canvas; arrow-key nudge; lock, hide, reorder, duplicate, copy to Back, delete (button and Delete key); every step undoes and redoes | e2e J4 |
| 5 | Save / reopen | Rename in header, edit, header says Saved; reload keeps the link, name, shape, layers and identical pixels; home lists the card; open from home; undo works after reopening; Rename / Duplicate / Delete (with confirm) on home; unknown `#/design/x` returns home with a message | e2e J5 |
| 6 | Options + review | Describe + Create 3 options shows 3 cards each with **Use this**, Preview, Combine; Preview leaves the design unchanged; Compare (slider, side by side, flip, close, keyboard divider); Reject / Esc; Regenerate; Edit prompt further; Accept records Edit history with before/after; Undo edit / Redo edit; **Use this** applies in one click and Ctrl+Z undoes it | e2e J6 |
| 7 | Export | Every Export menu item downloads a non-empty file (PNG, 2x, 4x, transparent, SVG, front+back, measurement CSVs, design sheet); Custom export dialog opens | e2e J7 |
| 8 | Responsive / Basic mode | 390 px wide: no horizontal scroll on home or studio, Export and Undo reachable | e2e J8 |
| 9 | Shared library | Login gate; save shows "Saved to shared library"; a second login opens the shared link, edits, and the first session receives the change; unknown shared link falls back home | e2e-shared |
| 10 | Selection + AI-free edit logic | Mask engine, region/smart/wand selection, instruction semantics (avoid/lock/keep), lift to layer, back-to-front match | `mask.browser`, `phase3b.browser` |
| 11 | Editor layout + arrange tools | At 1440x900, 1024x768, 768x1024 and 390x844 (Basic and Advanced): no page scroll, canvas never covered by the bottom bar, header on one line, current step label does not wrap; small screens use the Tools / Edit dock (sheets close with Esc); header panel toggles collapse a side. Inspector shows only the selected item's controls with numeric X / Y / Width / Height / Rotation; Align, Shift-click multi-select, Distribute, Group / Ungroup (Ctrl+G), group move / hide / lock / duplicate, layer rename, drag snapping with guides (Alt = free, Snap toggle) | `editor.browser`, `js/arrange.test.mjs` |
| 12 | Colourways | Colourways tab: New colourway keeps the current look as Colourway 1 and adds a branch; rename; section colour / fabric strength / library material with supplier and note; shape slider change reaches every colourway; stripe colour differs per colourway; branch keeps lineage and does not touch its parent; Undo reverts a switch; reload restores colourways, material notes and the showing colourway; Compare dialog shows previews + differences table; sheet PNG, per-colourway PNGs and materials CSV download; delete with confirm; 390 px dialog fits | `colourways.browser`, `js/colourway-model.test.mjs` |
| 12 | AI generation + intelligent editing (mock OpenAI) | Generate garment with AI sends garment type, cut, sleeves, stripes, no-cuffs and fabric; Redraw one view (Back / Side / Detail) uses the front as the reference and previews before replacing, Accept / Reject / Undo edit; Redo one garment section (sleeves, collar, body, hem, stripes) makes three mask-composited options; artwork layers stay byte-identical through every AI action; baked-in logos and lettering stay out of the edit mask unless the request names them; rate limit / upstream / timeout / not configured each show a card that names what failed with Retry (when it can help) and Use built-in engine; with AI failing, options fall back to the built-in engine with the reason | `ai.browser`, `js/aigen.test.mjs`, `server.ai.test.mjs` |
| 13 | Tech pack | Export > Tech pack opens an editor and an 8-page A4 preview: front, back, side and detail drawings with measurement callouts and numbered artwork boxes; graded size chart (C / M / E labels, tolerance ranges); materials, colours and trims (from the design plus typed rows); stitching and construction (suggested vs entered); artwork placement in cm from HPS, hem and centre line; revision details and version history; production notes. Print / Save as PDF (A4 landscape, multi-page), multi-sheet spreadsheet (.xml) and CSV bundle download; fields persist after reload and undo; artwork labels switch to Calibrated once the scale is calibrated | `techpack.browser`, `js/techpack.test.mjs` |

Also run before a release (kept outside the repo-wide scripts, they use fixed ports 8123/8124): the accessibility/contrast QA
(`qa.js`), the long studio walkthrough (`e2e.js`) and the Club Élite sample check (`club-test.js`).

| 14 | Phase 8: security, roles, outage, backup, performance | Real `server.mjs` + mock Supabase with three accounts (alice owner, bob editor, carol viewer). Home loads with zero console errors, all ~70 modules answer 200 gzip-compressed, under 600 KB; login with a wrong password, with `Referrer-Policy: no-referrer` (Origin null), session cookie HttpOnly/Strict, logout stops serving code. Viewer: View only banner, edits make no write request, hand-made PUT/DELETE are 403, no Restore buttons in History. Editor edit reaches owner and viewer live. Owner restores an earlier version from History (saved as a new revision, editor receives it). Owner offline + editor saves first = conflict banner, Keep mine saves a "(my version)" copy, editor's version untouched. Supabase down / paused / missing tables: friendly Home badge, header "will retry", edit backed up in IndexedDB, queued edit sent and backup removed on recovery, server data unchanged during the outage. Backup all, delete a design, restore it (existing ids become "(restored)", damaged file refused), in shared and per-browser mode. 1440x900, 1024x768, 768x1024, 390x844: login, home, backup dialog and studio have no horizontal scroll. Printed timings: login to home, opening a design, sample shirt, a shape change | `phase8.browser` |
| 15 | Syntax / module regression | Every `js/*.js`, server, script and test file passes `node --check`; every relative import resolves and every named import is exported by its target; index.html has no inline script; the module graph from `js/main.js` is closed. A syntax error in any module fails `npm test` | `test/syntax.test.mjs` |
| 16 | Server security + resilience | Secret scan of the repo; sentinel secrets never in responses or logs (also on errors and outages); full header set on every response class; oversize bodies, wrong content type, rate limit, lockout (spoof-proof); cookie flags and tampering; gzip + ETag; `/healthz` version/commit; viewer/editor/owner write matrix with DB unchanged; stale save gives 409 and loses nothing; restore is a new revision; Supabase down/paused/missing tables give generic 502/503, `/healthz` and static files keep working, data intact, auto-recovery | `server.security.test.mjs`, `server.shared.test.mjs`, `server.workspace.test.mjs`, `server.test.mjs` |
| 17 | Deploy verification script | `scripts/verify-deploy.mjs` passes on a healthy local server (with and without login), matches `EXPECT_COMMIT` by prefix, fails on another commit / no commit / wrong password / unreachable service / missing security headers, never prints the password | `test/verify-deploy.test.mjs` |
| 18 | Backup / restore logic | Round trip of documents + pictures, server-owned meta dropped, malformed entries skipped with reasons, no overwrite on id clash, partial failures reported, unreadable designs listed on export | `js/backup.test.mjs` |

Timing budgets: `js/mask.test.mjs` multiplies every budget by `TF_PERF_SCALE` (default 2, so a busy machine does not flake; use `TF_PERF_SCALE=1` for the strict numbers) and takes the best of up to 5 runs. Browser tests print their own timings; budgets there are deliberately generous (they catch 10x regressions, not noise).

Already covered by earlier journeys and kept as the regression tests for past failures: JS syntax error blanking the app (`syntax.test` + home load with zero console errors), `Origin: null` login (`server.test.mjs` and `phase8.browser`), the **Use this** button (e2e J6), shared save and reopen (`e2e.shared.browser`).

## Manual-only checks (cannot be automated here)
- A real Supabase project and real OpenAI key (the mocks follow the documented APIs; real behaviour is unverified).
- Visual quality of AI results and of garment warps at extreme slider values (+-100).
- Safari / Firefox / touch devices (tests run in Chromium only).
- The live Render service: `npm run verify:deploy` is tested only against a local server (the sandbox cannot reach Render). Run it yourself after each deploy with `EXPECT_COMMIT` set.
- Real Supabase outages: simulated by the mock (connection dropped, 503 paused page, missing-table 404, wrong key), not by a real project.

## Known gaps
Undo history is not saved with a design (a reopened design starts with an empty undo list, by design).
