# Threadform

A garment design studio that runs entirely in your browser: upload or generate a garment, describe a change, compare three options, refine shape, colour and graphics, check measurements and export. Vanilla ES modules, no build step, no dependencies. `server.mjs` is a tiny Node server that serves the files, can require a password and can keep a shared design library in a free Supabase database.

Run it locally:

```bash
npm start                                   # open, no login (development only)
SITE_PASSWORD='a-long-password' npm start   # with the login screen, http://localhost:8080/
```

Tests: `npm test` (login gate, shared library routes and prompt parser). Any static server (`python3 -m http.server 8123`) also works for development, without a login.

## Password login

Set the environment variable **`SITE_PASSWORD`** and `server.mjs` will not serve a single studio file until the visitor has logged in. This is enforced on the server, so it cannot be bypassed by reading the page source (a password check done only in browser JavaScript could be).

| Variable | Purpose |
|---|---|
| `SITE_PASSWORD` | Required in production. 8+ characters, 12+ recommended. Share it only with the people who should have access. |
| `SITE_USERNAME` | Optional. If set, visitors must enter this username as well. |
| `SESSION_SECRET` | Optional. Signs login cookies. Render generates one for you; without it a random one is made at start-up and everyone is logged out on restart. |
| `SESSION_DAYS` | Optional. How long a login lasts (default 7). |
| `NODE_ENV=production` | Makes the server refuse to start if `SITE_PASSWORD` is missing, so a forgotten variable can never leave the site open. |

How it works: a successful login sets a signed, `HttpOnly`, `SameSite=Strict` (and `Secure` over HTTPS) cookie that lasts `SESSION_DAYS`. Changing the password or `SESSION_SECRET` logs everyone out. After 5 wrong attempts an IP is locked out for 15 minutes (50 across everyone). Login and logout are protected against cross-site requests. Only the studio's own `index.html`, `css/` and `js/` files are ever served, never source, config, tests or dotfiles. The password is compared in constant time, is never logged, and is never stored in the repo.

### Deploy on Render

1. In Render choose **New > Blueprint** and select this repo (or **New > Web Service**, runtime **Node**, start command `node server.mjs`, health check path `/healthz`). It must be a *Web Service*: a Static Site has no server, so it cannot read a password or check a login.
2. When asked, enter a value for `SITE_PASSWORD` (the blueprint leaves it blank on purpose so it never lives in git).
3. Open the `.onrender.com` URL, log in, and share the URL and password with your friend.

The free plan sleeps after a period of inactivity, so the first visit after a while can take about a minute to wake up.


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
- There are no per-person accounts: everyone with the site password can edit and delete every shared design, and if two people save at once the second is asked what to do rather than overwriting.

## AI editing (optional, OpenAI)

Threadform always works without AI: the local garment-shape engine does the shape edits in your browser. If you add an OpenAI key, the server also offers AI image editing (masked edits that change only a selected area, text-to-garment generation, instruction understanding and artwork detection). It is off until you set a key.

1. In the Render dashboard open your service, then *Environment*, and add `OPENAI_API_KEY` (create the key at platform.openai.com). Type it only there: never in chat, an issue, the repo or a `.env` file you commit. Redeploy.
2. Optional variables: `AI_IMAGE_MODEL` (default `gpt-image-1`), `AI_VISION_MODEL` (default `gpt-4.1-mini`), `AI_IMAGE_QUALITY` (`low`, `medium`, `high`; default `medium`), `AI_PROVIDER` (`openai`, or `openai-compatible` together with `AI_BASE_URL`, which must be `https://`), `AI_RATE_LIMIT` (requests per person per window, default 30), `AI_RATE_WINDOW_MIN` (default 10) and `AI_DAILY_LIMIT` (requests per day for the whole site, default 400).
3. The studio's AI badge shows *AI on* (and the model names) when the server has a key, and says the local engine is in use when it does not. The browser never sees the key: it only talks to this server, which calls OpenAI (the CSP stays `connect-src 'self'`). Prompts and images are not logged.

Spend limits: AI image calls cost real money. In the OpenAI dashboard set a monthly budget cap (and an email alert) for the project that owns the key. The built-in per-person and daily request limits are an extra brake (they are kept in memory and reset when the server restarts), not a substitute for the cap.

Honest note: this backend was verified end to end against a local mock of the OpenAI API (`test/mock-openai.mjs`, run by `npm test`), not against the real service. The request format follows OpenAI's image edit/generation and chat completion APIs, but real-model image quality, and whether a newer model still accepts every parameter, are unverified until you try it with your own key.

## Using Threadform

1. **Start a garment.** On the home page press *New design*, then pick a sample, upload a photo (the background is removed for you) or describe one, e.g. "navy hoodie with white stripes".
2. **Describe a change** in the *Look* tab, e.g. "make the sleeves flared", and press *Create 3 options*. Press *Use this* on the light, medium or strong version you like; *Compare before / after* shows the difference.
3. **Refine.** Click a part of the garment to recolour it, add text and graphics from the left panel (they open in the *Items* tab), and check sizes in the *Measure* tab.
4. **Export** a PNG, an editable SVG, the measurements (CSV) or a full design sheet.

The blue *Next* line under the view tabs always says what to do next. **Basic** mode (the default) shows only these essentials; switch to **Advanced** in the header for shape sliders, fit and sleeve presets, fabric, layers, references, the full set of selection tools and copy look. The choice is remembered in this browser, and nothing is lost when you switch.

Press **?** (or the *?* button in the header) for the guided tour, the keyboard shortcuts and a one-page *How it works*. Useful shortcuts: Ctrl+Z / Ctrl+Shift+Z undo and redo, Delete removes the selected item, Ctrl+D duplicates it, arrow keys nudge it, + / - / 0 zoom, hold Space to pan, Esc deselects or closes a dialog. Anything you reset or delete can be undone from the message that appears.

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

**Known limits**
- One shared password, not per-person accounts. Anyone who has it can use the studio, and you cannot revoke one person without changing it for everyone (changing it logs everyone out).
- Without the shared library, designs are stored per browser, so you and a friend do not see each other's designs (turn on the shared library above, or export a PNG, SVG or design sheet).
- Login attempt limits are kept in memory, so they reset when the server restarts.
