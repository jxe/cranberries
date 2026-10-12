-- Run after 004. The document's title becomes saved data that anyone who may
-- write can change, starting from the title in its config.
alter table public.dv_documents add column title text;

create or replace function public.dv_snapshot(doc public.dv_documents) returns jsonb language plpgsql set search_path = '' as $$
declare body jsonb;
begin
  execute format('select public.%I($1)', 'dv_' || doc.adaptor || '_read') into body using doc.id;
  return jsonb_build_object('data', body, 'revision', doc.revision, 'title', coalesce(doc.title, doc.config->>'title'));
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

