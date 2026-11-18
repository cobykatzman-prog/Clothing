
## AI backend

Optional. Without keys the app runs fully offline on the local engine ("Local engine (offline)"); with a key the UI shows "AI (gpt-image-1)".

| Env var | Purpose |
|---|---|
| `OPENAI_API_KEY` | Enables `/api/edit` (3 parallel `gpt-image-1` `images/edits` calls: Subtle / Medium / Bold) and `/api/generate`. |
| `OPENAI_IMAGE_QUALITY` | Optional: `low`, `medium` (default) or `high`. `high` can exceed Vercel Hobby's 60s limit. |
| `REPLICATE_API_TOKEN` | Reserved. TODO: Replicate provider is not implemented; status reports unavailable. |

- `GET /api/edit?status=1` returns `{available, provider}`. With no key every POST returns HTTP 200 `{fallback:true, reason}` and the client uses the local engine.
- Edits: our mask is opaque = selected; `api/_lib.js` converts it to OpenAI's convention (alpha 0 = edit here), and the browser composites the result back so pixels outside the mask are unchanged. References are sent as extra input images and described in the prompt.
- Limits: bodies under 4.5MB (Vercel), images are downscaled to at most 1024px client-side, max 3 refs, prompt up to 1200 chars. Same-origin only (no CORS headers). Secrets are never logged or returned.
- `api/*.js` are CommonJS; do not add `"type": "module"` to a root `package.json`. `vercel.json` sets `maxDuration` to 60s.
- Tests: `node js/prompt.test.mjs` and `node api/_lib.test.mjs`.

## Security

Threadform is built so it is safe to share a public link. Everything you design stays in your own browser.

**What runs where**
- The studio is static files. By default all image editing runs in the visitor's browser; nothing is uploaded and there are no third-party scripts, fonts, analytics or CDNs.
- Designs are saved in the visitor's own browser storage (IndexedDB / localStorage) and never sent anywhere. Clearing site data deletes them.
- The only server code is the optional `/api` AI endpoints (Vercel functions). They are not served by a Render *static* site, in which case the app uses its built-in local engine.

**Built-in protections**
- Strict Content-Security-Policy and related headers (`vercel.json` for Vercel, `render.yaml` for Render): scripts only from the site itself, no inline scripts, no outside connections, no framing (clickjacking), no MIME sniffing, no referrer leakage, camera/mic/location blocked.
- No `eval`, `innerHTML` with user data, or `document.write`. User text is inserted as text, never as HTML.
- SVG export validates colours and numbers and strips scripts, event handlers and external references from the output.
- Uploads are checked: images only, at most 25 MB and about 10,000 x 10,000 pixels. Uploaded images are only ever decoded as images.
- The `/api` functions accept same-origin JSON only, cap request and image sizes, validate every field, never log or echo secrets, and rate-limit requests per IP and per day (`AI_RATE_LIMIT`, `AI_RATE_WINDOW_MIN`, `AI_DAILY_LIMIT`). The limiter is in memory per serverless instance, so also set a **spending limit on the OpenAI project**.

**Before you share it**
1. Put `OPENAI_API_KEY` only in the host's environment settings (never in the repo; `.gitignore` blocks `.env` files). Rotate it if it was ever pasted anywhere public.
2. Set a monthly spend cap in the OpenAI dashboard.
3. Keep the repo free of secrets, and turn on GitHub secret scanning / push protection.
4. Use HTTPS (both Vercel and Render provide it automatically).

**Known limits**
- Rate limiting is best-effort per instance, not a hard global cap.
- The AI path sends the image, mask, prompt and references to OpenAI. Tell users before enabling it for private designs.
- Anyone with your link can use the local studio; there are no accounts. If you need private designs or sharing, add authentication and server-side storage first.
