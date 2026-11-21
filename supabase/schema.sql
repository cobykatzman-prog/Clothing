-- Threadform shared design library: run this ONCE in Supabase (SQL Editor > New query > paste > Run).
-- It is safe to run again: nothing is overwritten or deleted if the tables already exist.

-- One row per design. "doc" is the design itself (JSON); images are stored separately in "assets".
-- "rev" goes up by one on every save, so two people saving at once never silently overwrite each other.
create table if not exists designs (
  id          text primary key,
  name        text not null,
  rev         integer not null default 1,
  meta        jsonb not null default '{}',
  doc         jsonb not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- One row per image used by a design (base64 text). Deleted automatically with the design.
create table if not exists assets (
  design_id   text not null references designs(id) on delete cascade,
  hash        text not null,
  mime        text not null,
  data        text not null,
  bytes       integer not null,
  created_at  timestamptz default now(),
  primary key (design_id, hash)
);

-- Who owns / last edited a design, and per-design permissions: acl = {"alice":"editor","bob":"viewer"} (owner | editor | viewer).
-- (Safe on databases created by an earlier version of this file: the columns are added when missing.)
alter table designs add column if not exists owner      text;
alter table designs add column if not exists updated_by text;
alter table designs add column if not exists acl        jsonb not null default '{}';

-- Version history: one row per saved version (autosaves close together by the same person share a row). The server
-- keeps the newest 20 per design (WORKSPACE_REV_KEEP) and restores one by saving it as a new revision. "assets" lists the
-- image hashes that version used so the images are kept while the version is.
create table if not exists design_revs (
  design_id   text not null references designs(id) on delete cascade,
  rev         integer not null,
  name        text not null,
  meta        jsonb not null default '{}',
  doc         jsonb not null,
  assets      jsonb not null default '[]',
  edited_by   text,
  note        text,
  saved_at    timestamptz default now(),
  primary key (design_id, rev)
);

-- Shared Brand Kit: brand assets, colour palettes, typography sets, materials and collections, one row each.
-- kind = asset | palette | typography | material | collection. "ref" is the image hash for kind = asset.
create table if not exists workspace_items (
  kind        text not null,
  id          text not null,
  name        text not null,
  rev         integer not null default 1,
  data        jsonb not null default '{}',
  ref         text,
  updated_by  text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  primary key (kind, id)
);
create index if not exists workspace_items_ref_idx on workspace_items (ref);

-- Brand images (base64 text), stored once per image hash and never inside the JSON above.
create table if not exists workspace_blobs (
  hash        text primary key,
  mime        text not null,
  data        text not null,
  bytes       integer not null,
  created_at  timestamptz default now()
);

-- Makes "newest first" listing fast.
create index if not exists designs_updated_at_idx on designs (updated_at desc);

-- Security: row level security ON with NO policies means the public "anon" key can read and write nothing.
-- Only the server (which holds the secret service_role key, set in Render) can reach these tables.
alter table designs enable row level security;
alter table assets  enable row level security;
alter table design_revs      enable row level security;
alter table workspace_items  enable row level security;
alter table workspace_blobs  enable row level security;

-- Defence in depth: the public roles get no access at all (only the server's service key can use these tables).
revoke all on designs from anon, authenticated;
revoke all on assets  from anon, authenticated;
revoke all on design_revs      from anon, authenticated;
revoke all on workspace_items  from anon, authenticated;
revoke all on workspace_blobs  from anon, authenticated;
