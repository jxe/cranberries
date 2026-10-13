-- The whole database side of cranberries: its tables and who may read them.
-- Run it on an empty Supabase project to set one up, or again at any time.
-- There are no functions. Reads and writes go through the server function
-- (src/server.ts), which connects with the database secret; browsers may only
-- read the change log, which is their live feed.
--
-- To use a schema other than `public`: `npm run sql -- myschema schema`.

-- One row per document. `adaptor` names where its records live.
create table if not exists public.dv_documents (
  id text primary key,
  config jsonb not null,
  revision bigint not null default 0,
  owner_id uuid references auth.users(id),
  public_read boolean not null default false,
  public_write boolean not null default false,
  adaptor text not null default 'triples' check (adaptor ~ '^[a-z][a-z0-9_]*$'),
  title text,
  check (not public_write or public_read)
);
alter table public.dv_documents enable row level security;
-- Browsers read this only so the change log's rule below can consult it.
drop policy if exists document_read on public.dv_documents;
create policy document_read on public.dv_documents for select to anon, authenticated
  using (public_read or owner_id = auth.uid());
revoke all on public.dv_documents from anon, authenticated;
grant select on public.dv_documents to anon, authenticated;
grant all on public.dv_documents to service_role;

-- One row per committed write: the history and the live feed.
-- `at` is the stamp written to the records, kept as the same text.
create table if not exists public.dv_changes (
  document_id text not null references public.dv_documents(id) on delete cascade,
  revision bigint not null,
  request_id uuid not null,
  at text not null,
  by text,
  operations jsonb not null,
  primary key (document_id, revision),
  unique (document_id, request_id)
);
alter table public.dv_changes enable row level security;
drop policy if exists change_read on public.dv_changes;
create policy change_read on public.dv_changes for select to anon, authenticated
  using (exists(select 1 from public.dv_documents d where d.id = document_id and (d.public_read or d.owner_id = auth.uid())));
revoke all on public.dv_changes from anon, authenticated;
grant select on public.dv_changes to anon, authenticated;
grant all on public.dv_changes to service_role;

-- The triples adaptor's records, one fact per row. A record exists while it has
-- an `id` fact, whose seq orders the collection. A relationship is one fact per
-- member, in position order.
create table if not exists public.dv_facts (
  document_id text not null references public.dv_documents(id) on delete cascade,
  collection text not null,
  record text not null,
  field text not null,
  position int not null default 0,
  value text not null,
  seq bigint generated always as identity,
  primary key (document_id, collection, record, field, position)
);
alter table public.dv_facts enable row level security;
revoke all on public.dv_facts from anon, authenticated;
grant all on public.dv_facts to service_role;

-- Signing in. An admin hands a person a link; its token is kept only as a
-- hash. A link works until it is revoked, which also ends every session and
-- passcode that came from it. Only the server function touches these tables.
create table if not exists public.dv_links (
  id uuid primary key,
  document_id text not null references public.dv_documents(id) on delete cascade,
  person text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  created_by text,
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table public.dv_links enable row level security;
revoke all on public.dv_links from anon, authenticated;
grant all on public.dv_links to service_role;

-- One row per signed-in browser, found by the hash of the token it holds.
create table if not exists public.dv_sessions (
  token_hash text primary key,
  document_id text not null references public.dv_documents(id) on delete cascade,
  person text not null,
  link_id uuid not null references public.dv_links(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.dv_sessions enable row level security;
revoke all on public.dv_sessions from anon, authenticated;
grant all on public.dv_sessions to service_role;

-- A passcode signs one device in again: the device holds a random secret, and
-- this holds that secret's hash beside the salted, stretched passcode. Wrong
-- tries are counted, and enough of them lock the device out for a while.
create table if not exists public.dv_passcodes (
  document_id text not null references public.dv_documents(id) on delete cascade,
  device_hash text not null,
  person text not null,
  link_id uuid not null references public.dv_links(id) on delete cascade,
  salt text not null,
  passcode_hash text not null,
  failures int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  primary key (document_id, device_hash)
);
alter table public.dv_passcodes enable row level security;
revoke all on public.dv_passcodes from anon, authenticated;
grant all on public.dv_passcodes to service_role;

-- Earlier versions read and wrote through database functions that any browser
-- could call. The server function replaced them, and they must not outlive it:
-- they would let a visitor write without signing in.
do $$ declare f text; begin
  for f in
    select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in (
      'dv_apply','dv_read','dv_snapshot','dv_provision','dv_configure','dv_move','dv_check',
      'dv_validate','dv_upgrade_config','dv_blob_read','dv_blob_init','dv_blob_apply',
      'dv_triples_read','dv_triples_init','dv_triples_apply','dv_triples_record')
  loop
    execute 'drop function if exists ' || f || ' cascade';
  end loop;
end $$;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='dv_changes') then
    alter publication supabase_realtime add table public.dv_changes;
  end if;
end $$;
