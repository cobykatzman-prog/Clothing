
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
