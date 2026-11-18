# Threadform

A garment design studio that runs entirely in your browser: upload or generate a garment, describe a change, compare three options, refine shape, colour and graphics, check measurements and export. Vanilla ES modules, no build step, no API keys, no dependencies. `server.mjs` is a tiny Node server that serves the files and can require a password.

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

By default every browser keeps its own designs. If you and a friend want to see and edit the **same** designs, you can add a free Supabase database. It is optional: without it nothing changes.

1. Go to [supabase.com](https://supabase.com), sign up (free) and create a **New project**. Pick any name and region and save the database password somewhere (you will not need it again here). Wait a minute for it to finish setting up.
2. In the project, open **SQL Editor > New query**, paste the whole contents of `supabase/schema.sql` from this repo, and press **Run**. You should see "Success". (Running it twice is harmless.)
3. Open **Project Settings > API**. Copy the **Project URL** (looks like `https://abcdxyz.supabase.co`) and the **service_role** key (click Reveal; it is the long secret one, not the `anon` / publishable one).
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
- **Tested against a mock, not a live project.** The server code and `supabase/schema.sql` were verified against an in-memory imitation of the Supabase API (`npm test`), not a real Supabase project. The **Check connection** button is the real test of your own setup.
- There are no per-person accounts: everyone with the site password can edit and delete every shared design, and if two people save at once the second is asked what to do rather than overwriting.

## Using Threadform

1. **Start a garment.** On the home page press *New design*, then pick a sample, upload a photo (the background is removed for you) or describe one, e.g. "navy hoodie with white stripes".
2. **Describe a change** in the *Look* tab, e.g. "make the sleeves flared", and press *Create 3 options*. Press *Use this* on the light, medium or strong version you like; *Compare before / after* shows the difference.
3. **Refine.** Click a part of the garment to recolour it, add text and graphics from the left panel (they open in the *Items* tab), and check sizes in the *Measure* tab.
4. **Export** a PNG, an editable SVG, the measurements (CSV) or a full design sheet.

The blue *Next* line under the view tabs always says what to do next. **Basic** mode (the default) shows only these essentials; switch to **Advanced** in the header for shape sliders, fit and sleeve presets, fabric, layers, references, the selection brush and copy look. The choice is remembered in this browser, and nothing is lost when you switch.

Press **?** (or the *?* button in the header) for the guided tour, the keyboard shortcuts and a one-page *How it works*. Useful shortcuts: Ctrl+Z / Ctrl+Shift+Z undo and redo, Delete removes the selected item, Ctrl+D duplicates it, arrow keys nudge it, + / - / 0 zoom, hold Space to pan, Esc deselects or closes a dialog. Anything you reset or delete can be undone from the message that appears.

## Security

Threadform is built so it is safe to share a public link. Everything you design stays in your own browser.

**What runs where**
- The studio is plain files served by `server.mjs`. All image editing, generating and measuring runs in the visitor's browser with a local garment-shape engine; nothing is uploaded, there are no API keys and no third-party scripts, fonts, analytics or CDNs.
- By default designs are saved in the visitor's own browser storage (IndexedDB / localStorage) and never sent anywhere. Clearing site data deletes them. If you turn on the optional shared library (below), designs are instead stored in your own Supabase database, reached only through this server.

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
- Without the shared library, designs are stored per browser, so you and a friend do not see each other's designs (turn on the shared library below, or export a PNG, SVG or design sheet).
- Login attempt limits are kept in memory, so they reset when the server restarts.
