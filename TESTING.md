# Testing Threadform

Two layers: fast unit/server tests (`npm test`) and browser journeys (`npm run test:e2e`, Playwright, no extra installs).

```bash
npm test            # server 15, shared 18, ai 16, prompt 26, mask 187, aiedit 14, measure, generate (seconds)
npm run test:e2e    # browser journeys below (about 4 minutes); screenshots go to $OUT (default <tmpdir>/threadform-e2e)
node test/e2e.browser.test.cjs          # one file at a time
```

The e2e scripts serve the app themselves with the production CSP headers from `vercel.json` (so a CSP violation, a failed request,
an external request or any `pageerror` / `console.error` fails the journey) and need `require('playwright')` to resolve.
`test/e2e.shared.browser.test.cjs` starts the real `server.mjs` (login gate + shared library) against `test/mock-supabase.mjs`.
Real Supabase / OpenAI / Render are never contacted; the AI engine is not exercised by these journeys (see `test/mock-openai.mjs`, `npm test`).

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

Also run before a release (kept outside the repo-wide scripts, they use fixed ports 8123/8124): the accessibility/contrast QA
(`qa.js`), the long studio walkthrough (`e2e.js`) and the Club Élite sample check (`club-test.js`).

## Manual-only checks (cannot be automated here)
- A real Supabase project and real OpenAI key (the mocks follow the documented APIs; real behaviour is unverified).
- Visual quality of AI results and of garment warps at extreme slider values (+-100).
- Safari / Firefox / touch devices (tests run in Chromium only).

## Known gaps
Undo history is not saved with a design (a reopened design starts with an empty undo list, by design).
