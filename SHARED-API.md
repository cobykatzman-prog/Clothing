# Shared design library: contract

Goal: everyone who can log in sees and edits the SAME designs (a shared library), stored in a free Supabase
Postgres database. The browser only ever talks to our own server (same origin); only the server holds the
Supabase key. All routes below require a valid login session (same gate as the rest of the site) and, for
POST/PUT/DELETE, pass the same-origin check already in server.mjs (`sameOriginPost`).

## Server environment
- `SUPABASE_URL`          e.g. https://abcdxyz.supabase.co  (no trailing slash)
- `SUPABASE_SERVICE_KEY`  the project's service_role / secret key. SERVER ONLY. Never sent to the browser, never logged.
- If either is missing, shared mode is OFF: `/api/shared/status` says `{enabled:false}`, the other /api/designs* routes return 404, and the studio keeps using per-browser storage exactly as today.
- When enabled, server.mjs injects `<meta name="threadform-shared" content="1">` into index.html (next to threadform-auth).
- CSP must allow the browser to call its own server: `connect-src 'self'` (was 'none'). Nothing else changes; no third-party origins ever appear in CSP.

## Database (supabase/schema.sql, run once in the Supabase SQL editor)
Both tables have row level security ENABLED with NO policies, so the public anon key can read nothing; only the service key (server) can.
- `designs(id text primary key, name text not null, rev integer not null default 1, meta jsonb not null default '{}', doc jsonb not null, created_at timestamptz default now(), updated_at timestamptz default now())`
- `assets(design_id text not null references designs(id) on delete cascade, hash text not null, mime text not null, data text not null /* base64 */, bytes integer not null, created_at timestamptz default now(), primary key (design_id, hash))`
Server talks to PostgREST at `${SUPABASE_URL}/rest/v1/...` with headers `apikey` and `Authorization: Bearer <key>` using the global `fetch` (Node 18+, no dependencies).
Optimistic concurrency: update with `PATCH /rest/v1/designs?id=eq.<id>&rev=eq.<baseRev>` + `Prefer: return=representation`; an empty array means the rev moved (409).

## HTTP API (JSON unless noted). `:id` matches /^[A-Za-z0-9_-]{8,64}$/, `:hash` is a lowercase hex sha-256 (64 chars).
| Route | Body / result |
|---|---|
| `GET /api/shared/status` | `{enabled:boolean, ok?:boolean, error?:string, designs?:number}`. When enabled it performs a real read (and caches 30s) so the home page can show "Connected" or the exact reason (bad key, tables missing, project paused...). `error` is a short human sentence, never the key. |
| `GET /api/designs` | `{designs:[{id,name,rev,meta,createdAt,updatedAt}]}` newest first. `meta` is small JSON (thumb data URL <= 40 KB, views count, kind, tags, order). |
| `GET /api/designs/:id` | `{id,name,rev,meta,doc,createdAt,updatedAt,assets:[hash...]}` (404 if missing). `doc` is the client's serialized design JSON; images in it are referenced by hash, never inline. |
| `GET /api/designs/:id/rev` | `{id,rev,updatedAt}` tiny, used for polling. |
| `POST /api/designs` | `{id,name,meta,doc}` creates at rev 1 -> `{rev:1}`; 409 if id exists. |
| `PUT /api/designs/:id` | `{baseRev,name,meta,doc,keepAssets:[hash...]}` -> `{rev:baseRev+1,updatedAt}`; 409 `{error:'conflict',currentRev}` when baseRev != current; 404 if missing. After a successful update the server deletes this design's assets whose hash is NOT in keepAssets (garbage collection, keeps the free 500 MB DB from filling). |
| `DELETE /api/designs/:id` | `{ok:true}` (assets cascade). |
| `POST /api/designs/:id/duplicate` | `{newId,name}` -> server copies the design row (rev 1) and its assets -> `{id:newId,rev:1}`. |
| `POST /api/designs/:id/missing` | `{hashes:[...]}` -> `{missing:[hashes the server does not yet have]}` so the client uploads only new images. |
| `PUT /api/designs/:id/assets/:hash` | RAW bytes, `Content-Type: image/png|image/jpeg|image/webp`. Server verifies sha256(bytes) === :hash, size <= 8 MB, and magic bytes match the type; idempotent. -> `{ok:true}` |
| `GET /api/designs/:id/assets/:hash` | raw bytes with the stored mime, `Cache-Control: private, max-age=31536000, immutable`. |
Limits: doc JSON <= 1.5 MB, name <= 120 chars, meta <= 80 KB, asset <= 8 MB, <= 200 assets per design. Anything bigger -> 413. Bad ids/hashes/JSON -> 400. Unknown route -> 404. Never echo upstream error bodies that could contain secrets; return short generic messages (`{error:'shared library unavailable'}` with 502/503).

## Browser behaviour (js/remote.js + storage.js + home.js + state.js)
- If `<meta name="threadform-shared" content="1">` is present the shared library is the source of truth; otherwise nothing changes.
- Images (canvases) are encoded PNG, hashed with SubtleCrypto sha-256, uploaded once, and referenced by hash in the doc.
- Autosave (existing debounce) does: upload missing assets -> `PUT` with `baseRev`. On success remember the new rev. A failed save keeps retrying and a local backup copy is written to the old per-browser store so nothing is lost; the header indicator says "Saving..." / "Saved to shared library" / "Not saved (offline): will retry".
- Live sync: while a design is open poll `GET /api/designs/:id/rev` about every 8 s (pause while the tab is hidden). If the remote rev is newer: with no unsaved local changes, reload it quietly and show a toast ("Updated with changes from your friend"); with unsaved local changes show a banner offering "Load their version" or "Keep mine (save as a copy)". A 409 on save shows the same banner. The home grid refreshes about every 20 s.
- Home shows a "Shared library" badge with live status from /api/shared/status (green Connected / red with the reason) and a "Check connection" button.
- If shared mode is on and the browser still holds old per-browser designs, home offers "Move my local designs to the shared library" (uploads them, then offers to remove the local copies).
