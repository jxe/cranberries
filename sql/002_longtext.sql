-- Adds the "longtext" field kind: text that may be empty and span lines.
-- Run after 001. Replaces the validator only; documents are unchanged.
create or replace function public.dv_validate(config jsonb, body jsonb) returns void language plpgsql set search_path = '' as $$
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
        if d = '"text"'::jsonb or d = '"longtext"'::jsonb then
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
