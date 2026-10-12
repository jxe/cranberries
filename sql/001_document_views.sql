-- Run once in Supabase SQL editor / migrations. No application server required.
create table public.dv_documents (
  id text primary key,
  config jsonb not null,
  data jsonb not null,
  revision bigint not null default 0,
  owner_id uuid references auth.users(id),
  public_read boolean not null default false,
  public_write boolean not null default false,
  check (not public_write or public_read)
);
create table public.dv_receipts (
  document_id text references public.dv_documents(id) on delete cascade,
  request_id uuid not null,
  primary key (document_id, request_id)
);
alter table public.dv_documents enable row level security;
alter table public.dv_receipts enable row level security;
create policy document_read on public.dv_documents for select to anon, authenticated
  using (public_read or owner_id = auth.uid());
revoke all on public.dv_documents, public.dv_receipts from anon, authenticated;
grant select on public.dv_documents to anon, authenticated;
grant all on public.dv_documents, public.dv_receipts to service_role;

create function public.dv_validate(config jsonb, body jsonb) returns void language plpgsql set search_path = '' as $$
declare typ text; fields jsonb; rec jsonb; f text; d jsonb; v jsonb; target text; item jsonb;
begin
  if jsonb_typeof(body) <> 'object' or jsonb_typeof(config->'schema') <> 'object' then raise exception 'Invalid document'; end if;
  for typ, fields in select * from jsonb_each(config->'schema') loop
    if jsonb_typeof(body->typ) is distinct from 'array' then raise exception 'Missing collection %',typ; end if;
    if (select count(*) <> count(distinct x->>'id') from jsonb_array_elements(body->typ) x) then raise exception 'Duplicate IDs'; end if;
    for rec in select * from jsonb_array_elements(body->typ) loop
      if jsonb_typeof(rec->'id') is distinct from 'string' or length(rec->>'id') = 0 then raise exception 'Invalid ID'; end if;
      if exists(select 1 from jsonb_object_keys(rec) k where k <> 'id' and not fields ? k) then raise exception 'Unknown field'; end if;
      for f,d in select * from jsonb_each(fields) loop
        v := rec->f;
        if d = '"text"'::jsonb then
          if jsonb_typeof(v) is distinct from 'string' or length(rec->>f)>10000 then raise exception 'Invalid text'; end if;
        elsif d ? 'choices' then
          if jsonb_typeof(v) is distinct from 'string' or not (d->'choices' @> jsonb_build_array(v)) then raise exception 'Invalid choice'; end if;
        elsif d ? 'many' then
          target := d->>'many';
          if jsonb_typeof(v) is distinct from 'array' then raise exception 'Invalid relationship'; end if;
          if (select count(*) <> count(distinct x) from jsonb_array_elements(v) x) then raise exception 'Duplicate relationship'; end if;
          for item in select * from jsonb_array_elements(v) loop
            if not exists(select 1 from jsonb_array_elements(body->target) r where r->'id'=item) then raise exception 'Missing related entity'; end if;
          end loop;
        else raise exception 'Invalid field definition'; end if;
      end loop;
    end loop;
  end loop;
end $$;

create function public.dv_apply(document_id text, request_id uuid, operations jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare doc public.dv_documents; body jsonb; op jsonb; rec jsonb; idx int; typ text; entity_id text; fld text;
  other_type text; fields jsonb; descriptor jsonb; field_name text; revised jsonb; new_rows jsonb; member jsonb;
begin
  select * into doc from public.dv_documents where id=document_id for update;
  if not found then raise exception 'Document unavailable'; end if;
  -- Explicit null-safe permission check for anonymous users.
  if coalesce(doc.public_write or doc.owner_id = auth.uid() or auth.role()='service_role',false) = false then
    raise exception 'Not allowed' using errcode='42501';
  end if;
  if exists(select 1 from public.dv_receipts r where r.document_id=dv_apply.document_id and r.request_id=dv_apply.request_id) then
    return jsonb_build_object('snapshot',jsonb_build_object('data',doc.data,'revision',doc.revision));
  end if;
  if request_id is null or jsonb_typeof(operations) is distinct from 'array' or jsonb_array_length(operations) not between 1 and 1000 then raise exception 'Invalid operations'; end if;
  body := doc.data;
  for op in select * from jsonb_array_elements(operations) loop
    typ := op->>'type'; entity_id := op->>'id'; fld := op->>'field';
    if not (doc.config->'schema' ? typ) then raise exception 'Unknown collection'; end if;
    select value, (ordinality-1)::int into rec,idx from jsonb_array_elements(body->typ) with ordinality where value->>'id'=entity_id;
    if op->>'kind'='create' then
      if rec is not null then return jsonb_build_object('conflict','An entity with this ID already exists.','snapshot',jsonb_build_object('data',doc.data,'revision',doc.revision)); end if;
      if op->'value'->>'id' is distinct from entity_id then raise exception 'ID mismatch'; end if;
      body := jsonb_set(body,array[typ],(body->typ)||jsonb_build_array(op->'value'));
    elsif op->>'kind'='set' then
      if not (doc.config->'schema'->typ ? fld) then raise exception 'Unknown field'; end if;
      if rec is null or rec->fld is distinct from op->'before' then
        return jsonb_build_object('conflict','Someone else changed this field. Your draft is retained; copy it before using the shared version.','snapshot',jsonb_build_object('data',doc.data,'revision',doc.revision));
      end if;
      body := jsonb_set(body,array[typ,idx::text,fld],op->'value',false);
    elsif op->>'kind'='delete' then
      if rec is null or rec is distinct from op->'before' then
        return jsonb_build_object('conflict','The entity changed before deletion.','snapshot',jsonb_build_object('data',doc.data,'revision',doc.revision));
      end if;
      body := jsonb_set(body,array[typ],(body->typ)-idx);
      for other_type,fields in select * from jsonb_each(doc.config->'schema') loop
        new_rows := '[]'::jsonb;
        for revised in select * from jsonb_array_elements(body->other_type) loop
          for field_name,descriptor in select * from jsonb_each(fields) loop
            if descriptor->>'many'=typ then
              select coalesce(jsonb_agg(m),'[]'::jsonb) into member from jsonb_array_elements(revised->field_name) m where m <> to_jsonb(entity_id);
              revised := jsonb_set(revised,array[field_name],member);
            end if;
          end loop;
          new_rows := new_rows || jsonb_build_array(revised);
        end loop;
        body := jsonb_set(body,array[other_type],new_rows);
      end loop;
    else raise exception 'Unknown operation'; end if;
  end loop;
  perform public.dv_validate(doc.config,body);
  update public.dv_documents set data=body,revision=revision+1 where id=document_id returning * into doc;
  insert into public.dv_receipts values(document_id,request_id);
  return jsonb_build_object('snapshot',jsonb_build_object('data',doc.data,'revision',doc.revision));
end $$;
revoke all on function public.dv_apply(text,uuid,jsonb) from public;
grant execute on function public.dv_apply(text,uuid,jsonb) to anon,authenticated,service_role;
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='dv_documents') then
    alter publication supabase_realtime add table public.dv_documents;
  end if;
end $$;
