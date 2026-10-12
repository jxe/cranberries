-- The whole database side of cranberries, as it should be: tables, access
-- rules and functions. Run it on an empty Supabase project to set one up, or
-- again at any time; it only creates what is missing and replaces functions.
-- It does not upgrade an older install's stored data: for that, run the
-- numbered migrations in this folder instead.
--
-- To use a schema other than `public`: `npm run sql -- myschema schema`.
--
-- A write is a core plus a storage adaptor. The core (dv_apply, dv_read) owns
-- permission, retries, checking operations against the config, the title, the
-- revision and the change log. An adaptor owns where a document's records
-- live, as three functions named for it in dv_documents.adaptor:
--   dv_<adaptor>_read(document_id) returns jsonb       every collection's records
--   dv_<adaptor>_apply(document_id, config, op, stamp)  returns a conflict message, or null
--   dv_<adaptor>_init(document_id, config, data)        replaces the document's records

-- One row per document. `data` is used only by the blob adaptor.
create table if not exists public.dv_documents (
  id text primary key,
  config jsonb not null,
  data jsonb,
  revision bigint not null default 0,
  owner_id uuid references auth.users(id),
  public_read boolean not null default false,
  public_write boolean not null default false,
  adaptor text not null default 'triples' check (adaptor ~ '^[a-z][a-z0-9_]*$'),
  title text,
  check (not public_write or public_read)
);
alter table public.dv_documents enable row level security;
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

-- One value against its field definition. Relationship targets are checked by the adaptor.
create or replace function public.dv_check(def jsonb, v jsonb) returns void language plpgsql immutable set search_path = '' as $$
begin
  if def->>'type' in ('text','longtext') then
    if jsonb_typeof(v) is distinct from 'string' or length(v#>>'{}') > 10000 + 90000 * (def->>'type' = 'longtext')::int then raise exception 'Invalid text'; end if;
  elsif def->>'type' = 'choice' then
    if jsonb_typeof(v) is distinct from 'string' or not exists(select 1 from jsonb_array_elements(def->'options') o where o->'name' = v) then raise exception 'Invalid choice'; end if;
  elsif def->>'type' = 'many' then
    if jsonb_typeof(v) is distinct from 'array' or exists(select 1 from jsonb_array_elements(v) x where jsonb_typeof(x) <> 'string') then raise exception 'Invalid relationship'; end if;
    if (select count(*) <> count(distinct x) from jsonb_array_elements(v) x) then raise exception 'Duplicate relationship'; end if;
  else raise exception 'Invalid field definition'; end if;
end $$;

-- A whole document against its config: used when provisioning or changing a config.
create or replace function public.dv_validate(config jsonb, body jsonb) returns void language plpgsql set search_path = '' as $$
declare typ text; col jsonb; rec jsonb; f text; d jsonb;
begin
  if jsonb_typeof(body) is distinct from 'object' or jsonb_typeof(config->'collections') is distinct from 'object' then raise exception 'Invalid document'; end if;
  for typ, col in select * from jsonb_each(config->'collections') loop
    if jsonb_typeof(body->typ) is distinct from 'array' then raise exception 'Missing collection %',typ; end if;
    if (select count(*) <> count(distinct x->>'id') from jsonb_array_elements(body->typ) x) then raise exception 'Duplicate IDs'; end if;
    for rec in select * from jsonb_array_elements(body->typ) loop
      if jsonb_typeof(rec->'id') is distinct from 'string' or length(rec->>'id') = 0 then raise exception 'Invalid ID'; end if;
      if exists(select 1 from jsonb_object_keys(rec) k where k not in ('id','modified') and not col->'fields' ? k) then raise exception 'Unknown field'; end if;
      if rec ? 'modified' and jsonb_typeof(rec->'modified') <> 'string' then raise exception 'Invalid modified time'; end if;
      for f, d in select * from jsonb_each(col->'fields') loop
        perform public.dv_check(d, rec->f);
        if d->>'type' = 'many' and exists(select 1 from jsonb_array_elements(rec->f) m where not exists(select 1 from jsonb_array_elements(body->(d->>'of')) r where r->'id' = m)) then raise exception 'Missing related entity'; end if;
      end loop;
    end loop;
  end loop;
end $$;

-- The triples adaptor.
create or replace function public.dv_triples_record(doc text, config jsonb, typ text, rid text) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', rid)
    || coalesce((select jsonb_build_object('modified', m.value) from public.dv_facts m where m.document_id = doc and m.collection = typ and m.record = rid and m.field = 'modified'), '{}'::jsonb)
    || coalesce((select jsonb_object_agg(f.key, case when f.value->>'type' = 'many'
        then coalesce((select jsonb_agg(x.value order by x.position) from public.dv_facts x where x.document_id = doc and x.collection = typ and x.record = rid and x.field = f.key), '[]'::jsonb)
        else to_jsonb(coalesce((select x.value from public.dv_facts x where x.document_id = doc and x.collection = typ and x.record = rid and x.field = f.key and x.position = 0), f.value->>'default', f.value->'options'->0->>'name', ''))
      end) from jsonb_each(config->'collections'->typ->'fields') f), '{}'::jsonb) $$;

create or replace function public.dv_triples_read(doc text) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.key, coalesce((
    select jsonb_agg(public.dv_triples_record(doc, d.config, c.key, e.record) order by e.seq)
    from public.dv_facts e where e.document_id = doc and e.collection = c.key and e.field = 'id'), '[]'::jsonb)), '{}'::jsonb)
  from public.dv_documents d, jsonb_each(d.config->'collections') c where d.id = doc $$;

create or replace function public.dv_triples_init(doc text, config jsonb, body jsonb) returns void language plpgsql set search_path = '' as $$
begin
  delete from public.dv_facts where document_id = doc;
  insert into public.dv_facts(document_id,collection,record,field,value)
    select doc, c.key, r.value->>'id', 'id', '' from jsonb_each(config->'collections') c, jsonb_array_elements(body->c.key) with ordinality r(value,n) order by c.key, r.n;
  insert into public.dv_facts(document_id,collection,record,field,value)
    select doc, c.key, r.value->>'id', 'modified', r.value->>'modified' from jsonb_each(config->'collections') c, jsonb_array_elements(body->c.key) r where r.value ? 'modified';
  insert into public.dv_facts(document_id,collection,record,field,value)
    select doc, c.key, r.value->>'id', f.key, r.value->>f.key from jsonb_each(config->'collections') c, jsonb_array_elements(body->c.key) r, jsonb_each(c.value->'fields') f
    where f.value->>'type' <> 'many' and r.value ? f.key;
  insert into public.dv_facts(document_id,collection,record,field,position,value)
    select doc, c.key, r.value->>'id', f.key, (m.n - 1)::int, m.value from jsonb_each(config->'collections') c, jsonb_array_elements(body->c.key) r, jsonb_each(c.value->'fields') f,
      jsonb_array_elements_text(r.value->f.key) with ordinality m(value,n)
    where f.value->>'type' = 'many';
end $$;

create or replace function public.dv_triples_apply(doc text, config jsonb, op jsonb, stamp text) returns text language plpgsql set search_path = '' as $$
declare kind text := op->>'kind'; typ text := op->>'type'; rid text := op->>'id'; fld text := op->>'field';
  def jsonb := config->'collections'->(op->>'type')->'fields'->(op->>'field'); present boolean; f text; d jsonb;
begin
  present := exists(select 1 from public.dv_facts where document_id = doc and collection = typ and record = rid and field = 'id');
  if kind = 'create' then
    if present then return 'An entity with this ID already exists.'; end if;
    insert into public.dv_facts(document_id,collection,record,field,value) values (doc,typ,rid,'id','');
    for f, d in select * from jsonb_each(config->'collections'->typ->'fields') loop
      if d->>'type' = 'many' then
        insert into public.dv_facts(document_id,collection,record,field,position,value)
          select doc,typ,rid,f,(m.n - 1)::int,m.value from jsonb_array_elements_text(coalesce(op->'value'->f,'[]'::jsonb)) with ordinality m(value,n);
      elsif op->'value' ? f then
        insert into public.dv_facts(document_id,collection,record,field,value) values (doc,typ,rid,f,op->'value'->>f);
      end if;
    end loop;
  elsif kind = 'delete' then
    if not present or (public.dv_triples_record(doc,config,typ,rid) - 'modified') is distinct from ((op->'before') - 'modified') then return 'The entity changed before deletion.'; end if;
    delete from public.dv_facts where document_id = doc and collection = typ and record = rid;
    delete from public.dv_facts x using jsonb_each(config->'collections') c, jsonb_each(c.value->'fields') cf
      where x.document_id = doc and x.collection = c.key and x.field = cf.key and cf.value->>'type' = 'many' and cf.value->>'of' = typ and x.value = rid;
    return null;
  elsif kind = 'set' then
    if not present or public.dv_triples_record(doc,config,typ,rid)->fld is distinct from op->'before' then
      return 'Someone else changed this field. Your draft is retained; copy it before using the shared version.';
    end if;
    delete from public.dv_facts where document_id = doc and collection = typ and record = rid and field = fld;
    if def->>'type' = 'many' then
      insert into public.dv_facts(document_id,collection,record,field,position,value)
        select doc,typ,rid,fld,(m.n - 1)::int,m.value from jsonb_array_elements_text(op->'value') with ordinality m(value,n);
    else
      insert into public.dv_facts(document_id,collection,record,field,value) values (doc,typ,rid,fld,op->>'value');
    end if;
  elsif kind = 'link' then
    if not present then return 'The entity no longer exists.'; end if;
    insert into public.dv_facts(document_id,collection,record,field,position,value)
      select doc,typ,rid,fld,coalesce((select max(position) + 1 from public.dv_facts where document_id = doc and collection = typ and record = rid and field = fld),0),op->>'value'
      where not exists(select 1 from public.dv_facts where document_id = doc and collection = typ and record = rid and field = fld and value = op->>'value');
    if not found then return null; end if;
  elsif kind = 'unlink' then
    delete from public.dv_facts where document_id = doc and collection = typ and record = rid and field = fld and value = op->>'value';
    if not found then return null; end if;
  end if;
  -- Every member this write put in a relationship must exist.
  if exists(
    select 1 from public.dv_facts x, jsonb_each(config->'collections'->typ->'fields') cf
    where x.document_id = doc and x.collection = typ and x.record = rid and x.field = cf.key and cf.value->>'type' = 'many'
      and not exists(select 1 from public.dv_facts e where e.document_id = doc and e.collection = cf.value->>'of' and e.record = x.value and e.field = 'id')
  ) then raise exception 'Missing related entity'; end if;
  insert into public.dv_facts(document_id,collection,record,field,value) values (doc,typ,rid,'modified',stamp)
    on conflict (document_id,collection,record,field,position) do update set value = excluded.value;
  return null;
end $$;

-- The blob adaptor: the whole document in dv_documents.data.
-- A record written before its config gained a field reads with that field's default.
create or replace function public.dv_blob_read(doc text) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.key, coalesce((
    select jsonb_agg(coalesce((
        select jsonb_object_agg(f.key, case when f.value->>'type' = 'many' then '[]'::jsonb else to_jsonb(coalesce(f.value->>'default', f.value->'options'->0->>'name', '')) end)
        from jsonb_each(c.value->'fields') f), '{}'::jsonb) || r.value order by r.n)
    from jsonb_array_elements(d.data->c.key) with ordinality r(value,n)), '[]'::jsonb)), '{}'::jsonb)
  from public.dv_documents d, jsonb_each(d.config->'collections') c where d.id = doc $$;

create or replace function public.dv_blob_init(doc text, config jsonb, body jsonb) returns void language sql set search_path = '' as $$
  update public.dv_documents set data = body where id = doc $$;

create or replace function public.dv_blob_apply(doc text, config jsonb, op jsonb, stamp text) returns text language plpgsql set search_path = '' as $$
declare body jsonb; kind text := op->>'kind'; typ text := op->>'type'; rid text := op->>'id'; fld text := op->>'field';
  rec jsonb; idx int; other_type text; col jsonb; field_name text; d jsonb; revised jsonb; new_rows jsonb; members jsonb;
begin
  body := public.dv_blob_read(doc);
  select value, (ordinality - 1)::int into rec, idx from jsonb_array_elements(body->typ) with ordinality where value->>'id' = rid;
  if kind = 'create' then
    if rec is not null then return 'An entity with this ID already exists.'; end if;
    rec := (op->'value') || jsonb_build_object('modified', stamp);
    body := jsonb_set(body, array[typ], (body->typ) || jsonb_build_array(rec));
  elsif kind = 'delete' then
    if rec is null or (rec - 'modified') is distinct from ((op->'before') - 'modified') then return 'The entity changed before deletion.'; end if;
    body := jsonb_set(body, array[typ], (body->typ) - idx);
    for other_type, col in select * from jsonb_each(config->'collections') loop
      new_rows := '[]'::jsonb;
      for revised in select * from jsonb_array_elements(body->other_type) loop
        for field_name, d in select * from jsonb_each(col->'fields') loop
          if d->>'type' = 'many' and d->>'of' = typ then
            select coalesce(jsonb_agg(m),'[]'::jsonb) into members from jsonb_array_elements(revised->field_name) m where m <> to_jsonb(rid);
            revised := jsonb_set(revised, array[field_name], members);
          end if;
        end loop;
        new_rows := new_rows || jsonb_build_array(revised);
      end loop;
      body := jsonb_set(body, array[other_type], new_rows);
    end loop;
    update public.dv_documents set data = body where id = doc;
    return null;
  else
    if kind = 'set' then
      if rec is null or rec->fld is distinct from op->'before' then
        return 'Someone else changed this field. Your draft is retained; copy it before using the shared version.';
      end if;
      rec := jsonb_set(rec, array[fld], op->'value');
    elsif kind = 'link' then
      if rec is null then return 'The entity no longer exists.'; end if;
      if rec->fld @> jsonb_build_array(op->'value') then return null; end if;
      rec := jsonb_set(rec, array[fld], (rec->fld) || jsonb_build_array(op->'value'));
    else
      if rec is null or not rec->fld @> jsonb_build_array(op->'value') then return null; end if;
      select coalesce(jsonb_agg(m),'[]'::jsonb) into members from jsonb_array_elements(rec->fld) m where m <> op->'value';
      rec := jsonb_set(rec, array[fld], members);
    end if;
    rec := rec || jsonb_build_object('modified', stamp);
    body := jsonb_set(body, array[typ, idx::text], rec);
  end if;
  for field_name, d in select * from jsonb_each(config->'collections'->typ->'fields') loop
    if d->>'type' = 'many' and exists(select 1 from jsonb_array_elements(rec->field_name) m where not exists(select 1 from jsonb_array_elements(body->(d->>'of')) r where r->'id' = m)) then raise exception 'Missing related entity'; end if;
  end loop;
  update public.dv_documents set data = body where id = doc;
  return null;
end $$;

-- The core.
create or replace function public.dv_snapshot(doc public.dv_documents) returns jsonb language plpgsql set search_path = '' as $$
declare body jsonb;
begin
  execute format('select public.%I($1)', 'dv_' || doc.adaptor || '_read') into body using doc.id;
  return jsonb_build_object('data', body, 'revision', doc.revision, 'title', coalesce(doc.title, doc.config->>'title'));
end $$;

create or replace function public.dv_read(document_id text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare doc public.dv_documents;
begin
  select * into doc from public.dv_documents where id = document_id;
  if not found or coalesce(doc.public_read or doc.owner_id = auth.uid() or auth.role() = 'service_role', false) = false then raise exception 'Document unavailable'; end if;
  return public.dv_snapshot(doc);
end $$;

-- `actor` is the person the writer says they are; it is recorded, not verified.
create or replace function public.dv_apply(document_id text, request_id uuid, operations jsonb, actor text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare doc public.dv_documents; op jsonb; kind text; typ text; fld text; fields jsonb; f text; conflict text;
  stamp text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select * into doc from public.dv_documents where id = document_id for update;
  if not found then raise exception 'Document unavailable'; end if;
  -- Explicit null-safe permission check for anonymous users.
  if coalesce(doc.public_write or doc.owner_id = auth.uid() or auth.role() = 'service_role', false) = false then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if exists(select 1 from public.dv_changes c where c.document_id = dv_apply.document_id and c.request_id = dv_apply.request_id) then
    return jsonb_build_object('snapshot', public.dv_snapshot(doc));
  end if;
  if request_id is null or jsonb_typeof(operations) is distinct from 'array' or jsonb_array_length(operations) not between 1 and 1000 then raise exception 'Invalid operations'; end if;
  -- A conflict undoes the operations of this batch that were already applied.
  begin
    for op in select * from jsonb_array_elements(operations) loop
      kind := op->>'kind'; typ := op->>'type'; fld := op->>'field';
      -- The title belongs to the document, whatever stores its records.
      if kind = 'title' then
        if jsonb_typeof(op->'value') is distinct from 'string' or length(trim(op->>'value')) = 0 or length(op->>'value') > 500 then raise exception 'Invalid title'; end if;
        if coalesce(doc.title, doc.config->>'title') is distinct from op->>'before' then raise exception using errcode = 'DV001', message = 'Someone else changed the title.'; end if;
        doc.title := op->>'value';
        update public.dv_documents set title = doc.title where id = document_id;
        continue;
      end if;
      fields := doc.config->'collections'->typ->'fields';
      if fields is null then raise exception 'Unknown collection'; end if;
      if jsonb_typeof(op->'id') is distinct from 'string' or length(op->>'id') = 0 then raise exception 'Invalid ID'; end if;
      if kind in ('set','link','unlink') then
        if fld is null or not fields ? fld then raise exception 'Unknown field'; end if;
        if kind = 'set' then perform public.dv_check(fields->fld, op->'value');
        elsif fields->fld->>'type' is distinct from 'many' or jsonb_typeof(op->'value') is distinct from 'string' then raise exception 'Invalid relationship'; end if;
      elsif kind = 'create' then
        if op->'value'->>'id' is distinct from op->>'id' then raise exception 'ID mismatch'; end if;
        if exists(select 1 from jsonb_object_keys(op->'value') k where k not in ('id','modified') and not fields ? k) then raise exception 'Unknown field'; end if;
        for f in select jsonb_object_keys(fields) loop
          if op->'value' ? f then perform public.dv_check(fields->f, op->'value'->f); end if;
        end loop;
      elsif kind is distinct from 'delete' then raise exception 'Unknown operation'; end if;
      execute format('select public.%I($1,$2,$3,$4)', 'dv_' || doc.adaptor || '_apply') into conflict using document_id, doc.config, op, stamp;
      if conflict is not null then raise exception using errcode = 'DV001', message = conflict; end if;
    end loop;
  exception when sqlstate 'DV001' then
    select * into doc from public.dv_documents where id = document_id;
    return jsonb_build_object('conflict', sqlerrm, 'snapshot', public.dv_snapshot(doc));
  end;
  update public.dv_documents set revision = revision + 1 where id = document_id returning * into doc;
  insert into public.dv_changes(document_id,revision,request_id,at,by,operations) values (document_id,doc.revision,request_id,stamp,actor,operations);
  return jsonb_build_object('change', jsonb_build_object('revision', doc.revision, 'at', stamp));
end $$;

-- Trusted setup, for a seed script with the secret key. An existing document is left untouched.
create or replace function public.dv_provision(document_id text, config jsonb, data jsonb, public_read boolean default false, public_write boolean default false, adaptor text default 'triples') returns boolean
language plpgsql set search_path = '' as $$
begin
  perform public.dv_validate(config, data);
  insert into public.dv_documents(id,config,adaptor,public_read,public_write) values (document_id,config,adaptor,public_read,public_write) on conflict (id) do nothing;
  if not found then return false; end if;
  execute format('select public.%I($1,$2,$3)', 'dv_' || adaptor || '_init') using document_id, config, data;
  return true;
end $$;

-- Replace a document's config. The records it already has must fit the new one.
create or replace function public.dv_configure(document_id text, config jsonb) returns void language plpgsql set search_path = '' as $$
declare doc public.dv_documents;
begin
  update public.dv_documents d set config = dv_configure.config where d.id = document_id returning * into doc;
  if not found then raise exception 'Document unavailable'; end if;
  perform public.dv_validate(config, public.dv_snapshot(doc)->'data');
end $$;

-- Move a document's records to another adaptor.
create or replace function public.dv_move(document_id text, adaptor text) returns void language plpgsql set search_path = '' as $$
declare doc public.dv_documents; body jsonb;
begin
  select * into doc from public.dv_documents where id = document_id for update;
  if not found then raise exception 'Document unavailable'; end if;
  if doc.adaptor = adaptor then return; end if;
  body := public.dv_snapshot(doc)->'data';
  execute format('select public.%I($1,$2,$3)', 'dv_' || doc.adaptor || '_init') using document_id, doc.config, '{}'::jsonb;
  update public.dv_documents d set adaptor = dv_move.adaptor where d.id = document_id;
  execute format('select public.%I($1,$2,$3)', 'dv_' || adaptor || '_init') using document_id, doc.config, body;
end $$;

revoke all on function public.dv_check(jsonb,jsonb), public.dv_validate(jsonb,jsonb), public.dv_snapshot(public.dv_documents),
  public.dv_triples_record(text,jsonb,text,text), public.dv_triples_read(text), public.dv_triples_init(text,jsonb,jsonb), public.dv_triples_apply(text,jsonb,jsonb,text),
  public.dv_blob_read(text), public.dv_blob_init(text,jsonb,jsonb), public.dv_blob_apply(text,jsonb,jsonb,text),
  public.dv_read(text), public.dv_apply(text,uuid,jsonb,text),
  public.dv_provision(text,jsonb,jsonb,boolean,boolean,text), public.dv_configure(text,jsonb), public.dv_move(text,text) from public;
grant execute on function public.dv_read(text), public.dv_apply(text,uuid,jsonb,text) to anon, authenticated, service_role;
grant execute on function public.dv_check(jsonb,jsonb), public.dv_validate(jsonb,jsonb), public.dv_snapshot(public.dv_documents),
  public.dv_triples_record(text,jsonb,text,text), public.dv_triples_read(text), public.dv_triples_init(text,jsonb,jsonb), public.dv_triples_apply(text,jsonb,jsonb,text),
  public.dv_blob_read(text), public.dv_blob_init(text,jsonb,jsonb), public.dv_blob_apply(text,jsonb,jsonb,text),
  public.dv_provision(text,jsonb,jsonb,boolean,boolean,text), public.dv_configure(text,jsonb), public.dv_move(text,text) to service_role;
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='dv_changes') then
    alter publication supabase_realtime add table public.dv_changes;
  end if;
end $$;
