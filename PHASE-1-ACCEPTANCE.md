# Phase 1 — Application audit and reliability

Target: `main`  
Audit branch: `audit/phase-1-reliability-20261122`  
Scope: the Phase 1 requirements in the Threadform Product Design & Development Brief.

## Audit baseline

- The latest `main` commit at audit start is `bffa5f3a613937ec7bb9dc36346ddc99d3820acb`.
- GitHub Actions' `Test` workflow completed successfully for that commit.
- The repository test command runs server, shared-library, storage, Brand Kit, materials, gallery, AI, prompt, mask, measurement, generation and editable-element tests.
- Existing regression coverage includes element JSON round-trips, nested property isolation, transforms, hit testing, autosave metadata preservation, shared-library routes and measurement calculations.
- The current CI workflow runs `npm test` on Node.js 20. It does not launch a browser or exercise the full UI end to end.
- The latest commit has a failing Vercel status because deployment was rate-limited. This is not evidence of a code-test failure and does not establish the state of the Render deployment.

## Functional acceptance checklist

Run each scenario against a clean test design and record the result, evidence and any defect before Phase 1 can be marked complete.

| ID | Workflow | Acceptance test | Status |
|---|---|---|---|
| P1-01 | App launch | Load the home page and studio; verify no white screen, uncaught startup exception or missing core panel. | Not browser-verified |
| P1-02 | Create | Create a design from a sample and from an uploaded image; confirm the correct view and garment state initialise. | Not browser-verified |
| P1-03 | Views | Switch Front, Back, Side and Detail repeatedly; confirm the active view, artwork, overlays and controls stay in sync. | Not browser-verified |
| P1-04 | Garment controls | Change body shape, sleeve length/width/flare/shape, fit and collar settings; confirm controls change the intended garment geometry and can be reset. | Not browser-verified |
| P1-05 | Existing artwork | Select existing logos, text and graphics; edit their properties and confirm the original element remains editable. | Not browser-verified |
| P1-06 | Element transforms | Move, resize and rotate artwork; verify hit targets, selection handles, view ownership, visibility and locking. | Unit coverage exists; browser not verified |
| P1-07 | Layers | Verify layer selection and operations do not affect hidden, locked or other-view elements. | Partial unit coverage; browser not verified |
| P1-08 | Undo/redo | Make multiple garment and artwork edits; undo and redo each operation and verify the correct prior state returns. | Partial unit coverage; full browser sequence not verified |
| P1-09 | Measurements | Change garment proportions and compare Front/Back measurement labels and geometry; confirm values remain aligned and estimates are clearly identified. | Calculation tests exist; browser not verified |
| P1-10 | Save | Create and edit a design; wait for the save indicator; reload the app and confirm all views, measurements, artwork and metadata persist. | Storage/server tests exist; browser not verified |
| P1-11 | Reopen | Open a saved design from the gallery and confirm all editable state is restored without missing assets or stale view state. | Hydration code reviewed; browser not verified |
| P1-12 | Duplicate/delete | Duplicate a design, edit the copy, and verify the source remains unchanged; delete only a disposable test design. | Not browser-verified |
| P1-13 | Share | With shared storage configured, open a design from a second authorised browser session and verify saved changes appear. | Shared API tests exist; two-session browser test not verified |
| P1-14 | Conflict/recovery | Simulate concurrent edits and a temporary network interruption; verify neither user's work is silently overwritten and retry/recovery is visible. | Server/storage tests exist; browser not verified |
| P1-15 | Shared link | Copy a shared design link and open it in a second authorised session; verify it opens the intended editable design. | Not browser-verified |
| P1-16 | Error handling | Exercise missing/deleted design, unavailable shared service and storage failure paths; confirm actionable messages and no silent data loss. | Partial server coverage; browser not verified |

## Phase 1 exit criteria

Phase 1 is complete only when:

1. Every applicable checklist row has a recorded pass or a documented, resolved defect.
2. Critical create, edit, save, reopen and share journeys pass in a real browser.
3. Any code fixes have focused regression tests.
4. The full `npm test` workflow passes on the proposed phase branch.
5. The completed phase is merged into `main`, and the resulting main commit is verified.

## Current limitations

This initial audit records the repository and CI baseline. GitHub Actions passing is not treated as proof that browser controls or a live shared-storage deployment work. Browser acceptance and live-host verification remain outstanding; do not mark those rows passed based only on unit tests.
