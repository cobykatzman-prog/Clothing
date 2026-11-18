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

-- Makes "newest first" listing fast.
create index if not exists designs_updated_at_idx on designs (updated_at desc);

-- Security: row level security ON with NO policies means the public "anon" key can read and write nothing.
-- Only the server (which holds the secret service_role key, set in Render) can reach these tables.
alter table designs enable row level security;
alter table assets  enable row level security;

-- Defence in depth: the public roles get no access at all (only the server's service key can use these tables).
revoke all on designs from anon, authenticated;
revoke all on assets  from anon, authenticated;
