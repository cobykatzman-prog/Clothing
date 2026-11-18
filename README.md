# Threadform

A garment design studio that runs entirely in your browser: upload or generate a garment, describe a change, compare three options, refine shape, colour and graphics, check measurements and export. Static files only (vanilla ES modules, no build step, no server, no API keys).

Run it locally with any static server, e.g. `python3 -m http.server 8123`, then open http://localhost:8123/. Unit tests: `node js/prompt.test.mjs`.


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
