# Threadform

A garment design studio that runs entirely in your browser: upload or generate a garment, describe a change, compare three options, refine shape, colour and graphics, check measurements and export. Vanilla ES modules, no build step, no dependencies. `server.mjs` is a tiny Node server that serves the files, can require a password and can keep a shared design library in a free Supabase database.

Run it locally:

```bash
npm start                                   # open, no login (development only)
SITE_PASSWORD='a-long-password' npm start   # with the login screen, http://localhost:8080/
```

Tests: `npm test` (fast) and `npm run test:e2e` (browser journeys); see TESTING.md. Any static server (`python3 -m http.server 8123`) also works for development, without a login.

## Password login

Set the environment variable **`SITE_PASSWORD`** and `server.mjs` will not serve a single studio file until the visitor has logged in. This is enforced on the server, so it cannot be bypassed by reading the page source (a password check done only in browser JavaScript could be).

| Variable | Purpose |
|---|---|
| `SITE_PASSWORD` | Required in production. 8+ characters, 12+ recommended. Share it only with the people who should have access. |
| `SITE_USERNAME` | Optional. If set, visitors must enter this username as well. |
| `SITE_USERS` | Optional. Individual logins: `alice:her-password,bob:his-password` (comma separated; passwords 8+ characters, no commas). Works with or without `SITE_PASSWORD`; when both are set, leaving the username empty at login uses the shared password. Needed for real names in "last edited by" and for per-person permissions. |
| `SITE_ROLES` | Optional. Workspace roles: `alice:owner,bob:editor,carol:viewer`. Owner = everything (delete, share); editor = create and change; viewer = look only. Users not listed are editors; with no `SITE_ROLES` the first user in `SITE_USERS` is the owner. `SITE_SHARED_ROLE` sets the role of the shared password (default `owner`, so single-password sites behave exactly as before). |
| `SESSION_SECRET` | Optional. Signs login cookies. Render generates one for you; without it a random one is made at start-up and everyone is logged out on restart. |
| `SESSION_DAYS` | Optional. How long a login lasts (default 7). |
| `NODE_ENV=production` | Makes the server refuse to start if `SITE_PASSWORD` is missing, so a forgotten variable can never leave the site open. |

How it works: a successful login sets a signed, `HttpOnly`, `SameSite=Strict` (and `Secure` over HTTPS) cookie that lasts `SESSION_DAYS`. Changing the password or `SESSION_SECRET` logs everyone out. After 5 wrong attempts an IP is locked out for 15 minutes (50 across everyone). Login and logout are protected against cross-site requests. Only the studio's own `index.html`, `css/` and `js/` files are ever served, never source, config, tests or dotfiles. The password is compared in constant time, is never logged, and is never stored in the repo.

### Deploy on Render

1. In Render choose **New > Blueprint** and select this repo (or **New > Web Service**, runtime **Node**, start command `node server.mjs`, health check path `/healthz`). It must be a *Web Service*: a Static Site has no server, so it cannot read a password or check a login.
2. When asked, enter a value for `SITE_PASSWORD` (the blueprint leaves it blank on purpose so it never lives in git).
3. Open the `.onrender.com` URL, log in, and share the URL and password with your friend.

The free plan sleeps after a period of inactivity, so the first visit after a while can take about a minute to wake up.

#### Verify a deploy (`npm run verify:deploy`)

`/healthz` is public and answers JSON: `{"status":"ok","app":"threadform","version":"1.0.0","commit":"<sha>"}`. The commit comes from Render's built-in `RENDER_GIT_COMMIT` (also read: `GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`, `SOURCE_VERSION`); only a hex sha is ever reported, never free text, and nothing else about the configuration. After a deploy, from any machine with Node 18+ (zero installs):

```bash
DEPLOY_URL=https://your-service.onrender.com EXPECT_COMMIT=<sha of the commit you pushed> npm run verify:deploy
# optional, enables the logged-in checks (never printed):  DEPLOY_PASSWORD=... [DEPLOY_USERNAME=...]
```

It retries `/healthz` for up to `WAIT_SEC` (default 120; Render needs a minute to wake or finish a deploy, and while `EXPECT_COMMIT` is set it keeps waiting until the new commit is live), then checks: health + version, that the running commit equals `EXPECT_COMMIT`, the login page and the full security-header set (CSP, nosniff, frame, referrer, permissions, COOP/CORP, cache, HSTS on https), that nothing (`/`, `/js/main.js`, `/api/designs`, `/server.mjs`, `/.env`...) is served without a login, and, with `DEPLOY_PASSWORD`, that login works, `index.html` and every JavaScript/CSS module it pulls in loads with the right type, and the API status routes answer (a configured-but-unhealthy Supabase is reported as a warning). Exit code 0 = OK, 1 = a check failed, 2 = bad usage. Honest limit: it was developed and tested against a local `server.mjs` (`test/verify-deploy.test.mjs`); the sandbox it was written in cannot reach Render, so it has not yet been run against your live service.

If Supabase is down, paused or missing tables the studio keeps working: `/healthz` stays 200 (Render does not restart a healthy app for a database problem), the Home badge says what is wrong in plain words, edits are kept in this browser and retried automatically (the header says "Not saved (offline): will retry"), and the saved designs themselves are untouched. See **Backup and restore** below.

### Backup and restore of all designs

Home > **Backup** downloads every design (document, settings and pictures) as one `threadform-backup-YYYY-MM-DD.json` file; **Restore from a backup file** puts them back. Restore never overwrites: a design whose id already exists comes back as a new design named "... (restored)", unusable entries are skipped and listed, and a damaged or newer-format file is refused with a plain message before anything changes. It works in both modes (per-browser storage and the shared library; viewers can export but not restore). Keep a backup before changing the database or clearing browser data; the file contains your designs only (no passwords or keys). Format and logic: `js/backup.js`, tests `js/backup.test.mjs` and `test/phase8.browser.test.cjs`.


## Shared designs (Supabase)

By default every browser keeps its own designs. If you and a friend want to see and edit the **same** designs, you can add a free Supabase database. It is optional: without it nothing changes. Designs are stored in the database **only when both `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set** on the server.

Already have a project with the tables created (for example a project named `threadform` whose Project URL is `https://tstvirabqkbeoqermirs.supabase.co`)? Skip to step 3.

1. Go to [supabase.com](https://supabase.com), sign up (free) and create a **New project**. Pick any name and region and save the database password somewhere (you will not need it again here). Wait a minute for it to finish setting up.
2. In the project, open **SQL Editor > New query**, paste the whole contents of `supabase/schema.sql` from this repo, and press **Run**. You should see "Success". (Running it twice is harmless.)
3. Open **Project Settings > API**. Copy the **Project URL** (looks like `https://abcdxyz.supabase.co`) and the **service_role** key (click Reveal; it is the long secret one, not the `anon` / publishable one; on newer dashboards it is under **API Keys**, *Legacy API keys* tab).
4. In Render, open your Threadform web service > **Environment** and add two variables: `SUPABASE_URL` (the Project URL) and `SUPABASE_SERVICE_KEY` (the service_role key). Save, then **redeploy** if Render does not do it by itself.
5. Open the site and log in. On the home page the **Shared library** badge should say *Connected*. If it shows a red message, it says what is wrong (wrong key, tables not created, project paused...). Press **Check connection** after fixing it.

Then everyone who can log in sees the same designs, and changes appear for the other person within a few seconds. Old designs saved in a single browser can be moved over from the home page.

How it behaves in the studio:
- The header save indicator says *Saving...*, *Saved to shared library* or *Not saved (offline): will retry*. While offline a backup of your latest work is kept in this browser and sent as soon as the connection is back (or the next time you open the site). Each design keeps its newest 20 saved versions.
- An open design checks for changes every few seconds. If your friend saved and you have nothing unsaved, their version is loaded quietly. If you both changed it, a banner offers *Load their version* or *Keep mine (save as a copy)*; nothing of yours is overwritten or lost.
- The home page refreshes about every 20 seconds and shows the connection status next to a *Check connection* button.

Things to know, honestly:
- **The service_role key is powerful**: it can read and change everything in your Supabase project. Keep it only in Render's environment variables. Never put it in the repo, a chat or the browser. Only this server uses it; the browser never sees it, and the tables are locked so the public Supabase key can read nothing.
- **Free Supabase projects pause after about a week of inactivity.** If the badge says the project is paused or unreachable, open the Supabase dashboard and press **Restore project**; your data is kept.
- **The free database is 500 MB.** Designs are small, but each image takes space. Images a design no longer uses are cleaned up automatically on save.
- **Tested against a mock, not a live project.** The server and the browser side were verified end to end against an in-memory imitation of the Supabase API (`test/mock-supabase.mjs`, also used by `npm test`), not a real Supabase project, and the tests do not run `supabase/schema.sql`. The **Check connection** button is the real test of your own setup.
- Without `SITE_USERS` there are no per-person accounts: everyone with the site password can edit and delete every shared design (all shown as "shared"), and if two people save at once the second is asked what to do rather than overwriting.

### Shared workspace (v2 phase 3)

Everything below needs the shared library on, and **you must run the latest `supabase/schema.sql` again** (safe to repeat; it adds the version, permission and Brand Kit tables). Until you do, the connection badge says so.

- **People and permissions.** Set `SITE_USERS` (and optionally `SITE_ROLES`). Each person logs in with their own name. Workspace roles are owner / editor / viewer. A design's owner (its creator) and workspace owners can open **Share** in the header to give individual people a different role on that one design (for example make Carol an editor of one design, or Bob a viewer). Viewers get a read-only design with a one-click *Save a copy and edit it*.
- **Last edited by.** The header shows *Last edited by Alice 5 min ago*; conflict banners and "updated by someone else" notices name the person.
- **Version history.** The **History** button lists the saved versions (who, when). *Restore* makes an old version the current one as a new version, so nothing is lost. The server keeps the newest 20 per design (`WORKSPACE_REV_KEEP`, 2 to 100); autosaves by the same person within 5 minutes share one version (`WORKSPACE_REV_INTERVAL_SEC`, `0` = one per save). Images a kept version uses are kept too, so restore always finds them.
- **Brand Kit in the cloud.** Brand assets, colour palettes, typography, materials and collections are stored on the server (`js/kit.js`, `/api/workspace`), so everyone sees the same kit; with the shared library off they stay in this browser as before. Edits are saved locally first and queued, so they survive going offline or reloading, and are sent with retries. If two people change the same item, the other version stays and yours is saved as "... (my version)". The kit storage module is in place; the Brand Kit screens call it (see SHARED-API.md).
- **Sync status.** The header always says Saved, Saving, Offline: will retry (with a count of waiting designs), Not saved, or shows the conflict banner; the Brand Kit shows its own chip when it is not saved. It retries on its own and immediately when the browser comes back online.
- **Images are never base64 in design data.** Pictures go to asset storage by hash; layer images are replaced by `asset:<hash>` in the design JSON and the server refuses inline images over 16 KB (thumbnails up to 64 KB are allowed).
- **Honest limits.** All of this was tested against `test/mock-supabase.mjs`, not a real Supabase project. Permissions are enforced by this server, not by the database (the service key bypasses row-level security by design). Passwords for named users live in environment variables; there is no password reset or self-signup, and renaming or removing a user in `SITE_USERS` does not rewrite the names already recorded on old designs.


## AI editing (optional, OpenAI)

Threadform always works without AI: the local garment-shape engine does the shape edits in your browser. If you add an OpenAI key, the server also offers AI image editing (masked edits that change only a selected area, text-to-garment generation, instruction understanding and artwork detection). It is off until you set a key.

1. In the Render dashboard open your service, then *Environment*, and add `OPENAI_API_KEY` (create the key at platform.openai.com). Type it only there: never in chat, an issue, the repo or a `.env` file you commit. Redeploy.
2. Optional variables: `AI_IMAGE_MODEL` (default `gpt-image-1`), `AI_VISION_MODEL` (default `gpt-4.1-mini`), `AI_IMAGE_QUALITY` (`low`, `medium`, `high`; default `medium`), `AI_PROVIDER` (`openai`, or `openai-compatible` together with `AI_BASE_URL`, which must be `https://`), `AI_RATE_LIMIT` (requests per person per window, default 30), `AI_RATE_WINDOW_MIN` (default 10) and `AI_DAILY_LIMIT` (requests per day for the whole site, default 400).
3. The studio's AI badge shows *AI on* (and the model names) when the server has a key, and says the local engine is in use when it does not. The browser never sees the key: it only talks to this server, which calls OpenAI (the CSP stays `connect-src 'self'`). Prompts and images are not logged.

Spend limits: AI image calls cost real money. In the OpenAI dashboard set a monthly budget cap (and an email alert) for the project that owns the key. The built-in per-person and daily request limits are an extra brake (they are kept in memory and reset when the server restarts), not a substitute for the cap.

What the AI workflows do (Phase 6): generation sends the garment's type, cut, panels, sleeves, collar, fabric, stripes and construction notes, plus the current shape sliders and the names of your artwork layers; "Redraw one view" draws the back, side or detail from the front as the reference so it stays the same garment; "Redo one garment section" re-makes just the sleeves, collar, body, hem or stripes through the selection mask. Results always arrive as a preview (Accept / Reject / Undo) and never replace your work silently; artwork layers (text, logos, graphics) are separate objects and are never sent for editing, and logos or lettering baked into a photo are kept out of the edit unless your wording names them. When the AI fails, a card says what failed (not configured, rate limit, timeout, upstream error, declined) and offers Retry and Use built-in engine.

Honest note: this backend was verified end to end against a local mock of the OpenAI API (`test/mock-openai.mjs`, run by `npm test`), not against the real service. The request format follows OpenAI's image edit/generation and chat completion APIs, but real-model image quality, and whether a newer model still accepts every parameter, are unverified until you try it with your own key.

## Using Threadform

1. **Start a garment.** On the home page press *New design*, then pick a sample, upload a photo (the background is removed for you) or describe one, e.g. "navy hoodie with white stripes".
2. **Describe a change** in the *Look* tab, e.g. "make the sleeves flared", and press *Create 3 options*. Press *Use this* (or *Preview*, then Accept) on the light, medium or strong version you like; *Compare before / after* shows the difference.
3. **Refine.** Click a part of the garment to recolour it, add text and graphics from the left panel (they open in the *Items* tab), and check sizes in the *Measure* tab.
4. **Export** a PNG, an editable SVG, the measurements (CSV) or a full design sheet.

The blue *Next* line under the view tabs always says what to do next. **Basic** mode (the default) shows only these essentials; switch to **Advanced** in the header for shape sliders, fit and sleeve presets, fabric, layers, references, the full set of selection tools and copy look. The choice is remembered in this browser, and nothing is lost when you switch.

Press **?** (or the *?* button in the header) for the guided tour, the keyboard shortcuts and a one-page *How it works*. Useful shortcuts: Ctrl+Z / Ctrl+Shift+Z undo and redo, Delete removes the selected item, Ctrl+D duplicates it, arrow keys nudge it, + / - / 0 zoom, hold Space to pan, Esc deselects or closes a dialog. Anything you reset or delete can be undone from the message that appears.

### Arranging items

Select a text, graphic or logo (click it, or its row in the *Items* tab) and the inspector shows only the controls that item has: for example text and font for lettering, a tint for a logo, stripe count for stripes. *Position & size* holds exact X, Y, Width, Height, Rotation and Size % fields (type a number and press Enter) next to the handles on the canvas, plus *Align* buttons that line it up with the garment. **Shift + click** more items (on the canvas or in Layers) to align them to each other, space three or more evenly, or **Group** them (Ctrl+G; Ctrl+Shift+G ungroups): a group moves, hides, locks and duplicates as one. In Layers, double-click a name to rename it, use the eye and lock icons, and the up / down arrows (or Alt + arrow keys, Ctrl+[ and Ctrl+]) to reorder. While you drag, items snap to the garment edges and centre, the canvas centre and other items, with pink guides; hold **Alt** to move freely or turn *Snap* off in the toolbar. On tablets and phones the Tools and Edit panels open from the bottom bar so the canvas keeps the screen.

### Colourways, variations and materials (v2 phase 7)

The **Colourways** tab keeps several colour and fabric versions of one garment. **New colourway** starts from what you see now (the first time it also keeps the current look as *Colourway 1*). Every colourway shares the garment's structure: the shape sliders, fit and sleeve presets, the artwork layout and the pictures are the design's own, so changing the fit changes all of them. A colourway only stores what may differ: whole-garment colour and fabric, per-section colours and fabrics, the colours of stripes, text and graphics, and notes. **Branch** copies a colourway (the list shows "branched from ...") and the two then differ only in those fields. Click a colourway to show it (one Undo step). In *Section colours, fabrics and materials* choose a section (body, sleeves, collar, cuffs, hem, stripes, ...), or click it on the canvas, and give it a colour, a procedural fabric appearance with a strength, and a material from your library (Materials on the home page, plus brand-kit materials in a shared workspace). The material's specification (supplier, SKU, composition, weight) is saved as a snapshot with the colourway, next to section notes, colourway notes and supplier notes. **Compare & export** shows colourways side by side with a table of what differs, and downloads one comparison sheet PNG, one PNG per colourway and view, or a materials CSV. Colourways are stored as small JSON inside the design (no pictures, about 1 KB each), so they sync through the shared library like the rest of the design.

### Selecting parts of a garment

Mark the area you want to change before you describe it; only the selected pixels are edited, everything else stays exactly as it was. The tools sit in the bar above the canvas (and, in Advanced, in the left *Select garment areas* section):

- **Basic** shows the five everyday tools: *Brush*, *Eraser*, *Lasso*, *Click a part* and *Smart select*, plus *Both sleeves* and *Clear*. To change both sleeves: choose *Click a part*, click each sleeve (or press *Both sleeves*), then describe the change.
- **Advanced** adds *Polygon* (click corners, double-click or Enter to finish, Backspace removes a point, Esc cancels), *Rectangle*, *Whole part*, *Magic wand* (tolerance, contiguous or not), *Select by colour* (click, eyedropper or colour picker, with tolerance), *Select by material* (weave / print), *Select garment*, *Invert*, and the modes *Add / Subtract / Intersect / Replace*. Hold **Shift** to add, **Alt (Option)** to subtract, **Shift + Alt** to intersect, with any tool.
- **Modify**: *Feather*, *Expand* / *Contract* (type a number or use the + / - steppers), *Smooth*, and *Refine edges* (a live preview snaps the edge to the picture before you press Apply). Readouts show the selection as a percentage of the garment and its pixel bounds.
- **Undo selection**: while a selection tool is active Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z step through the last 100 selection changes; the normal undo covers them as well, so nothing is lost.
- **Save selection** keeps a named selection per view (with a thumbnail); load it later as a replacement, or add / subtract / intersect it with the current one. Saved selections are stored with the design (also in the shared library).
- **Outline and tint**: the selection is drawn as animated marching ants (dark and light, readable on any fabric) with an optional tint (0-60 %, any colour). You can show outline only, dim everything that is not selected, view the selection as a black-and-white mask, or hide it.
- **Precision**: the mouse wheel zooms towards the pointer up to 1000 %, space-drag / middle-drag / two fingers pan, the pointer maps to image pixels exactly at any zoom, and *Zoom to selection* (Z) frames what you selected, so logos, stitching and collar edges can be selected pixel by pixel. Touch and pen work through pointer events. Tools that need the garment outline (*Click a part*, *Whole part*, *Smart select*, *Select garment*) say so politely when an image has none; the Brush, Lasso, Wand and the rest always work.

Shortcuts: B brush, E eraser, L lasso, P polygon, M rectangle, R click a part, C whole part, S smart select, W wand, K by colour, T by material, V move, [ and ] brush size, Ctrl+A select garment, Ctrl+I invert, Ctrl+Shift+A clear, Z zoom to selection.

## Security

Threadform is built so it is safe to share a public link. Without the shared library, everything you design stays in your own browser; with it, designs go only to your own Supabase database, through this server.

**What runs where**
- The studio is plain files served by `server.mjs`. Image editing, generating and measuring runs in the visitor's browser with a local garment-shape engine (optional AI editing is called by this server, never by the browser); there are no third-party scripts, fonts, analytics or CDNs, and the browser never talks to any site but this one.
- By default designs are saved in the visitor's own browser storage (IndexedDB / localStorage) and never sent anywhere. Clearing site data deletes them. If you turn on the optional shared library (above), designs and their images are instead saved to your own Supabase database, reached only through this server; the Supabase key stays on the server and is never sent to the browser.

**Built-in protections**
- Strict Content-Security-Policy and related headers (set by `server.mjs` on every response, from the list in `vercel.json`, which Vercel also applies): scripts only from the site itself, no inline scripts, no network connections except back to the site itself (`connect-src 'self'`), no framing (clickjacking), no MIME sniffing, no referrer sent to other sites, camera/mic/location blocked.
- No `eval`, `innerHTML` with user data, or `document.write`. User text is inserted as text, never as HTML.
- SVG export validates colours and numbers and strips scripts, event handlers and external references from the output.
- Uploads are checked: images only, at most 25 MB and about 10,000 x 10,000 pixels. Uploaded images are only ever decoded as images.

- With `SITE_PASSWORD` set, nothing is served before login (see Password login above).

**Before you share it**
1. Set a strong `SITE_PASSWORD` (12+ characters) in the host's dashboard. Never put it in the repo (`.gitignore` blocks `.env` files).
2. Keep the repo free of secrets, and turn on GitHub secret scanning / push protection.
3. Use HTTPS (Render provides it automatically).
4. After deploying, run `curl -I https://your-site/login` and check that `Content-Security-Policy` and `X-Frame-Options` are present.

**Security review (v2 phase 8)**: what was checked, found and fixed
- *Secrets*: nothing key-shaped is committed (`server.security.test.mjs` scans every tracked file for OpenAI/JWT/private-key/GitHub/AWS patterns and secrets assigned to real values; `.env` is ignored by the repo; `render.yaml` marks every secret `sync: false`). A real `server.mjs` process is started with sentinel secrets and hit with good and bad requests while Supabase is up, down, paused and rejecting the key: no sentinel appears in any response, header or log line, and no stack trace or upstream text reaches a client. The server logs only the error name/code, never messages.
- *Authentication*: signed, expiring, `HttpOnly`, `SameSite=Strict` cookie; constant-time password checks (also for unknown users); per-IP lockout after 5 failures (15 min) keyed on the last `X-Forwarded-For` hop so a spoofed header does not help, plus a global ceiling; changing a password or `SESSION_SECRET` invalidates every session; login/logout need a same-origin POST (`Sec-Fetch-Site`, then `Origin`, then `Referer`; `Origin: null` with a matching Referer is accepted, which fixed a past login outage).
- *Authorisation*: viewer / editor / owner roles are enforced by the server on every write route (design create/update/delete/duplicate/restore/ACL/asset upload, Brand Kit writes); `server.security.test.mjs` runs the matrix with separate accounts and checks the database is unchanged after each refused write.
- *Limits*: login body 4 KB, design JSON 1.5 MB, metadata 80 KB, image 3.2 MB, AI request caps, 240 API requests per 5 minutes per IP, 30 s request timeout, bounded upstream time to Supabase/OpenAI.
- *Fixed in phase 8*: (medium) a static file removed or unreadable while being streamed raised an unhandled stream error that could stop the whole server for everybody; (low) unexpected errors were swallowed silently, now logged by name only, and process-level handlers keep the service up; (low) `/healthz` could not say which build was live (now version + commit); JavaScript/CSS are now gzip-compressed (about 1.1 MB of modules is about 390 KB on the wire).
- *Accepted / known*: sessions are stateless, so *Log out* clears the cookie but cannot revoke a stolen one before it expires (keep `SESSION_DAYS` short; changing `SESSION_SECRET` revokes all); the global failure ceiling (50 per 15 minutes) lets a determined attacker with many IPs temporarily block everybody's login (the service stays up); `style-src` needs `'unsafe-inline'` for the editor's inline styles (scripts stay `'self'` only); rate-limit counters are per process.

**Known limits**
- One shared password, not per-person accounts. Anyone who has it can use the studio, and you cannot revoke one person without changing it for everyone (changing it logs everyone out).
- Without the shared library, designs are stored per browser, so you and a friend do not see each other's designs (turn on the shared library above, or export a PNG, SVG or design sheet).
- Login attempt limits and the shared API's 240-requests-per-5-minutes-per-IP limit are kept in memory, so they reset when the server restarts. They are a useful baseline, not a substitute for hosting-level rate limiting or monitoring.

## Measurement spec and size grading (v2 phase 4)

The Measure tab has a **Size spec** section (`js/spec.js`, `js/ui-spec.js`): nine points of measure (POM-01..09, same codes and names on Front/Back; side is reference only), per-size values XS-XXL, manual entry per cell, configurable grading step and tolerance per POM, validation checks, labelled CSV (Export menu or panel) and a printable table (use Save as PDF in the print dialog). Every value is labelled **Calibrated** (the one measurement you used to set the scale), **Manual** (typed by you) or **Estimated** (from the picture and the typical size chart, or graded from the base size). Estimates are never production-verified. Base-size values follow the live garment geometry; typed values do not, and are flagged when the drawing disagrees. Saved with the design (`state.spec`). Tests: `js/spec.test.mjs`, `test/spec.browser.test.cjs`.

## Tech pack builder (v2 phase 5)

**Export > Tech pack...** (`js/techpack.js` model and exports, `js/techdraw.js` drawings, `js/ui-techpack.js` editor + preview, `css/techpack.css`) builds an 8-page A4 pack from what the design already holds: flat technical front, back, side and detail drawings (silhouette follows every shape change, with measurement callouts, schematic seam lines and numbered artwork boxes), the graded size chart from `state.spec` (Calibrated / Manual / Estimated labels, tolerance ranges), materials, colours and trims (read from the design, plus rows you type), stitching and construction notes (a "Suggest for this garment type" button adds typical lines flagged *suggested*), logo and graphic placement (width and height in cm, top edge from HPS, bottom edge above the hem, offset from centre front/back, plus zoomed detail drawings), production notes, and revision details (number, date and author, a revision log and the design's saved versions; in the shared library the revisions and editors come from its history). **Print / Save as PDF** uses the browser print dialog (A4 landscape, page breaks, repeating table headers, identifier + revision + page number footer on every page); **Spreadsheet** downloads one multi-sheet workbook (Excel 2003 XML, `.xml`, opens in Excel, LibreOffice and Numbers); **CSV files** downloads one CSV per section. Fields are saved with the design (`state.techpack`: styleNo, season, supplier, status, revision, revisions, materials, trims, stitching, construction, production, notes), are undoable, and survive reload.

Honesty: every pack says it is *not production-verified*. Artwork dimensions inherit the scale's label (Estimated until you calibrate the scale in the Measure tab, then Calibrated), side and detail views have no flat scale so no dimensions are invented for artwork there, and suggested stitching lines stay flagged until you edit them. Limits: drawings are schematic (seam lines are not a pattern; the silhouette comes from the segmented picture), colour names are nearest-name guesses and not Pantone references, and PDF output relies on the browser's print dialog (no PDF library). Tests: `js/techpack.test.mjs`, `test/techpack.browser.test.cjs`.
