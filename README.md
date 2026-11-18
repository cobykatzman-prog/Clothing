# Threadform

A garment design studio that runs entirely in your browser: upload or generate a garment, describe a change, compare three options, refine shape, colour and graphics, check measurements and export. Static files only (vanilla ES modules, no build step, no server, no API keys).

Run it locally with any static server, e.g. `python3 -m http.server 8123`, then open http://localhost:8123/. Unit tests: `node js/prompt.test.mjs`.


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
- The studio is static files. All image editing, generating and measuring runs in the visitor's browser with a local garment-shape engine; nothing is uploaded, there are no API keys, no server code and no third-party scripts, fonts, analytics or CDNs.
- Designs are saved in the visitor's own browser storage (IndexedDB / localStorage) and never sent anywhere. Clearing site data deletes them.

**Built-in protections**
- Strict Content-Security-Policy and related headers (`vercel.json` for Vercel, `render.yaml` for Render): scripts only from the site itself, no inline scripts, no network connections at all (`connect-src 'none'`), no framing (clickjacking), no MIME sniffing, no referrer leakage, camera/mic/location blocked.
- No `eval`, `innerHTML` with user data, or `document.write`. User text is inserted as text, never as HTML.
- SVG export validates colours and numbers and strips scripts, event handlers and external references from the output.
- Uploads are checked: images only, at most 25 MB and about 10,000 x 10,000 pixels. Uploaded images are only ever decoded as images.

**Before you share it**
1. Keep the repo free of secrets, and turn on GitHub secret scanning / push protection.
2. Use HTTPS (both Vercel and Render provide it automatically).

**Known limits**
- Anyone with your link can use the local studio; there are no accounts. If you need private designs or sharing, add authentication and server-side storage first.
