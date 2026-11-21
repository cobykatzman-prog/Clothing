# Threadform: major upgrade plan (read this first)

Upgrade the EXISTING app. Do not rebuild it and do not remove working features. Vanilla ES modules, no build step, no npm
dependencies (browser or server). Node server in `server.mjs` (login gate, shared library, security headers/CSP).
Read README.md, CONTRACT.md and SHARED-API.md for how things work today. Keep every existing test green.

## Decisions (made by the owner/lead, do not relitigate)
- **OpenAI is back, but strictly optional and server-side.** The key lives ONLY in the server environment (`OPENAI_API_KEY`), never
  in the browser, repo, logs or any response. Without a key the app keeps working with the local engine and says so honestly.
  The old backend is in git history: `git show 6227f55^:api/_lib.js` (also api/edit.js, api/generate.js, js/ai.js); adapt, do not copy blindly.
- **Provider and models are configurable in the backend via env**: `AI_PROVIDER` (`openai` default, or `openai-compatible`), `AI_BASE_URL`
  (default https://api.openai.com/v1), `AI_IMAGE_MODEL` (default `gpt-image-1`), `AI_VISION_MODEL` (default `gpt-4.1-mini`),
  `AI_IMAGE_QUALITY` (low|medium|high, default medium), `OPENAI_API_KEY` (alias `AI_API_KEY`), plus `AI_RATE_LIMIT`, `AI_RATE_WINDOW_MIN`, `AI_DAILY_LIMIT`.
- **Preservation is guaranteed by compositing, not by trusting the model.** Whatever the model returns, the client composites it
  back into the ORIGINAL image through the selection mask (feathered by a small configurable edge), so unselected pixels stay byte-identical.
- **No real OpenAI calls are possible in this sandbox.** Test against `test/mock-openai.mjs` (a faithful local mock of the OpenAI image
  edit/generation and chat endpoints). Be honest in reports: real-model quality is unverified.
- Everything is behind the existing login gate and same-origin checks. CSP stays `connect-src 'self'`; no third-party origins ever.
- Reuse existing modules: `segment.js` (segmentation, regions), `warp.js` (shape), `fabric.js`, `variations.js`, `prompt.js`, `elements.js`
  (vector layers), `manual.js`, `export*.js`, `state.js` (undo, versions, serialize/hydrate), `canvas.js`, `ui-*.js`, `remote.js`/`storage.js` (shared library).
- New per-design/per-view state MUST be added to `state.js` snapshot/apply and to `serializeDesign`/`hydrateDesign` so undo and reload restore it.
- Text is inserted as text (never innerHTML with user data). CSP: no inline scripts. Accessibility: focus rings, aria-labels.
- Test with Playwright (`require('playwright')`, `chromium.launch()` with no options; never `playwright install`), serve with
  `python3 -m http.server 8123` (plain) or the real `node server.mjs` for anything server related. Put scripts/screenshots in
  /tmp/claude-0/-home-user-Clothing/89298eb2-7696-52de-9189-1aa44322c92a/scratchpad and LOOK at screenshots. Never commit or push (the lead does).
- "Do not create buttons that only look functional": every control must work and be covered by a test.

## Phases (the lead starts the next phase automatically when the previous one passes)
**Run order chosen by the owner: 1, 2, 3, then 5 (linked geometry), then back to 4 (extraction + layers), then 6, 7.** Phase 4's layers panel must therefore respect the linked-geometry state added in Phase 5 (front and back views share shape params when LINK is on).
1. **Secure AI backend + client plumbing + the Club Élite test garment** (workers: server, client, fixture)
2. **Professional selection system** (workers: mask engine, tools/overlay/UI) incl. flexible/any-area selection, zoom precision, saved selections
3. **Localised AI editing that preserves everything outside the selection** + instruction understanding (worker: edit pipeline) and
   **compare / accept / reject / regenerate / edit-history** (worker: compare+history UI)
4. **Text/logo/graphic extraction into editable layers** (worker: extraction engine) and **layers panel + element operations** (worker: layers UI)
5. **Linked front/back garment geometry** (worker: link)
6. **Export improvements** (layered export, artwork export, SVG traces) and polish of flexible selection
7. **Final acceptance**: the 12-step Club Élite test case end to end, full regression, security re-check, docs

## API contract for the AI backend (Phase 1; server worker implements, client worker consumes)
All routes need a valid login session; POST routes pass the existing same-origin check. JSON in/out unless stated. Image fields are PNG/JPEG
data URLs, max 1024 px on the long side client-side, <= 3.2 MB each, <= 3 refs. Mask convention (ours): opaque = selected/editable; the server converts
to OpenAI's convention (transparent = edit here) and back. Never return the key, upstream error bodies, or the base URL.
| Route | Body | Result |
|---|---|---|
| `GET /api/ai/status` | | `{enabled, provider, imageModel, visionModel, quality}` (`enabled:false` when no key) |
| `POST /api/ai/edit` | `{image, mask|null, prompt, constraints:{keep:[], avoid:[]}, refs:[], view, level:'subtle'|'medium'|'bold'}` | `{image:dataURL, level, model, ms}` one image per call, so the client runs 1-3 calls in parallel and shows each result as it arrives |
| `POST /api/ai/generate` | `{prompt, refs:[], view}` | `{image:dataURL, model}` |
| `POST /api/ai/understand` | `{prompt, image|null, view, hasSelection:boolean}` | `{ops}` where ops is the SAME shape `js/prompt.js parsePrompt` returns (summary, paramDeltas, sleevePreset, fitPreset, regions, keep, keepAllExcept, fabric, color, addElements, removeCuffs, garmentKind ...) plus `avoid:[strings]`, `extract:{logo,text,graphics}|null`, `matchBackToFront:boolean`, `confidence` |
| `POST /api/ai/analyze` | `{image, view}` | `{elements:[{type:'text'|'logo'|'graphic'|'stripe'|'piping', bbox:{x,y,w,h} /*0-1 of the image*/, text?, fontStyle?, color?, rotationDeg?, description}]}` |
Errors: `{error:{code,message}}` with friendly `message`; 400 bad input, 401/303 not logged in, 413 too large, 429 rate limit (with `Retry-After`), 502/503 upstream. 60 s upstream timeout, max 4 concurrent upstream calls.
Rate limiting: per-IP + daily (reuse the pattern from `git show 6227f55^:api/_lib.js` rateLimit), keyed so a spoofed x-forwarded-for does not help.

## Mask engine API (Phase 2; `js/mask.js`, pure functions on 1024x1024 canvases or Uint8Array alpha, no DOM state)
`emptyMask()`, `combine(a, b, mode:'add'|'subtract'|'intersect'|'replace')`, `invert(m, garmentMask?)`, `feather(m, px)`, `expand(m, px)`, `contract(m, px)`,
`smooth(m, px)`, `refineEdge(m, image, {radius, strength})` (edge-aware snap using image gradients), `fromBrushStroke(points, size, hardness)`,
`fromLasso(points)`, `fromPolygon(points)`, `fromRect(a, b)`, `fromRegions(seg, names)`, `magicWand(image, x, y, tolerance, contiguous)`, `selectByColor(image, rgb, tolerance)`,
`selectByTexture(image, x, y, tolerance)`, `selectComponent(seg, x, y)`, `smartSelect(image, seg, x, y)`, `outline(m)` (for the marching-ants overlay), `bounds(m)`, `isEmpty(m)`.

## Requirement checklist (from the owner's brief; Phase 7 verifies every line)
1. AI: secure backend; uploads as inputs; masked/region edits; understands construction + instructions; preserves unrequested parts; loading/progress/errors/results; multiple variations; provider+model configurable. Understands: "slightly flared but don't add cuffs", "body more boxy without changing the length", "wider vintage collar but keep the colour and stripes", "remove the logo and put it on a separate editable layer", "make the back match the front proportions".
2. Selection tools: freehand brush, adjustable size, eraser, click-to-select region, smart object selection, lasso, polygon, rectangle, select whole component, select by colour, select by material/texture; add/subtract/invert/clear/feather/refine edges/expand/contract/undo selection changes/save selections; clear overlay that does not obstruct; zoom for small details (logos, stitching, piping, cuffs, collar edges); works on generated and uploaded images.
3. Extraction: analyse an uploaded shirt and split artwork into independent layers: text (rebuilt as REAL editable text when possible), logos/emblems, graphics, stripes/piping; background removal; transparent extraction; each on its own transparent layer; move/resize/rotate/recolour/edit text/replace logo/delete/duplicate/move between front and back/export artwork separately; un-vectorisable logos stay as transparent image layers with a trace/vectorise action. Layers panel: Garment body, Sleeves, Collar, Stripes, Logos, Text, Graphics, Fabric details, Background; rename/hide/lock/reorder/duplicate/delete.
4. Linked front/back geometry: shared shape parameters (body width/length, shoulder width, sleeve length/width/flare/shape, collar size, neck opening, overall fit); `LINK FRONT & BACK SHAPE: ON/OFF`, ON by default; OFF = independent; front and back are the same physical garment.
5. Any-area selection at any zoom, combine selections from multiple parts (e.g. both sleeves), bottom 20% of a sleeve, a stripe, around a logo, an irregular patch.
6. AI edits ONLY the selection (mask-constrained), preserves identity/colours/fabric/logos/text/stitching/unselected areas/camera/lighting/composition, smallest necessary transition.
7. Before/after slider, side by side, undo/redo edit, accept, reject, regenerate, edit prompt further, full edit history with revert to any stage.
8. Workflow: upload/generate -> select any area -> refine -> describe -> AI edits only that area -> compare -> accept/reject -> continue -> export.
9. Acceptance test (cream long-sleeve Club Élite shirt, brown shoulder stripes, chest crest, back typography + tennis graphic): highlight both sleeves; subtle flare; open ends/no cuffs; keep brown stripes; keep boxy body; collar unchanged; chest logo unchanged; back text/graphics unchanged; front/back proportions stay matched; extract back text + tennis graphic to separate editable layers; move the text independently; export.
10. Priorities: AI integration, selection/masking, localised preserving edits, text/logo extraction, linked geometry, flexible selection, history/compare, export.

---
# ROADMAP v2 (owner's PDF brief "Threadform Product Design & Development Brief") — supersedes the phase numbering above
Earlier work (AI backend, selection, AI edit pipeline, compare/history, lift) is the base and maps mostly to v2 Phase 6.
Run in order; push to `main` after each phase passes its tests; next phase starts automatically. Exit criteria are in the brief.
1. Audit & reliability: audit every control; fix broken buttons/sleeve+shape controls; front/back/side/detail sync; layer select/edit/transform/undo/redo on existing logos/text/graphics; saving/opening/shared links/loading/white-screen/JS errors; documented repeatable functional test checklist (TESTING.md + automated). Also finish & stabilise the unfinished compare/accept/reject/history UI (js/review.js, js/ui-review.js) and the option cards "Use this" regression.
2. Editor redesign: compact consistent layout, contextual properties inspector, layer mgmt (hide/lock/duplicate/reorder/group), numeric position/size/rotation, alignment/snapping/guides, desktop/tablet/small screens.
3. Shared workspace & cloud sync: brand kit (assets, palettes, type, materials, collections) in shared storage; user identities + permissions; sync status/offline/retry/conflicts; last-edited-by + version history/restore; images in asset storage not base64 in metadata.
4. Measurements & size grading: consistent measurement points; calibration to real scale; manual entry per size + grading increments; geometry follows shape changes; label calibrated/manual/estimated; tolerances, validation, exportable tables.
5. Tech pack builder: technical front/back/side/detail drawings, callouts, graded size chart, materials/colours/trims/stitching/notes, artwork placement dims, revision info, PDF + spreadsheet export.
6. AI generation & editing: garment-aware prompts, consistent views, selective regeneration, preserve artwork, editable results, clear errors/retries/fallbacks.
7. Colourways, variations & materials: colourways from one base, branching with shared structure, per-section colour/fabric, supplier notes, compare + export.
8. Testing, security, performance: e2e + regression, two-session shared tests, API error handling, auth review, perf, responsive, verify live Render deploy.
Known limits to keep honest: no real Supabase/OpenAI/Render access from sandbox (mocks only); estimated measurements must stay labelled estimates.


OWNER SCOPE RULE: only ROADMAP v2 (the PDF brief) is in scope. The earlier brief and its phase list above are cancelled; do not build features from them.
