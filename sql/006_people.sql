-- Run after 005. People for documents described in USL, whose records are
-- in tables of their own.
create table if not exists public.dv_people (
  document_id text not null references public.dv_documents(id) on delete cascade,
  id text not null,
  name text not null,
  short text not null default '',
  image text not null default '',
  modified text,
  seq bigint generated always as identity,
  primary key (document_id, id)
);
alter table public.dv_people enable row level security;
revoke all on public.dv_people from anon, authenticated;
grant all on public.dv_people to service_role;
