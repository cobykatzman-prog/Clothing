# Threadform

A garment design studio that runs entirely in your browser: upload or generate a garment, describe a change, compare three options, refine shape, colour and graphics, check measurements and export. Vanilla ES modules, no build step, no API keys, no dependencies. `server.mjs` is a tiny Node server that serves the files and can require a password.

Run it locally:

```bash
npm start                                   # open, no login (development only)
SITE_PASSWORD='a-long-password' npm start   # with the login screen, http://localhost:8080/
```

Tests: `npm test` (login gate and prompt parser). Any static server (`python3 -m http.server 8123`) also works for development, without a login.

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
- Designs are saved in the visitor's own browser storage (IndexedDB / localStorage) and never sent anywhere. Clearing site data deletes them.

**Built-in protections**
- Strict Content-Security-Policy and related headers (set by `server.mjs` on every response, from the list in `vercel.json`, which Vercel also applies): scripts only from the site itself, no inline scripts, no network connections at all (`connect-src 'none'`), no framing (clickjacking), no MIME sniffing, no referrer sent to other sites, camera/mic/location blocked.
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
- Designs are still stored per browser, so you and a friend do not see each other's designs; export a PNG, SVG or design sheet to share work.
- Login attempt limits are kept in memory, so they reset when the server restarts.
