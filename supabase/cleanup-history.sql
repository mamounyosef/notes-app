-- One-off repair after a sync loop filled doc_history with copies.
-- Supabase: SQL Editor > New query > paste > Run. Then run the VACUUM below
-- on its own (it cannot run together with other statements).
--
-- Lossless: it only removes old versions that are exactly identical to a
-- newer version of the same note that is kept. The docs table (your notes)
-- is not touched, and every distinct version stays.

-- 1) The improved history trigger (same as supabase/schema.sql): writes that
--    change nothing add no version, and at most 500 versions per note.
create or replace function public.docs_keep_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.data is not distinct from old.data and new.deleted = old.deleted then
    return null;
  end if;
  insert into public.doc_history (user_id, kind, doc_id, data, rev, deleted, device)
  values (old.user_id, old.kind, old.doc_id, old.data, old.rev, old.deleted, old.device);
  delete from public.doc_history
  where user_id = old.user_id and kind = old.kind and doc_id = old.doc_id
    and (saved_at < now() - interval '30 days'
      or id in (select id from public.doc_history
                where user_id = old.user_id and kind = old.kind and doc_id = old.doc_id
                order by saved_at desc, id desc offset 500));
  return null;
end;
$$;

-- 2) Remove exact duplicate versions, keeping the newest of each.
with ranked as (
  select id,
         row_number() over (
           partition by user_id, kind, doc_id, deleted, md5(coalesce(data::text, ''))
           order by saved_at desc, id desc
         ) as n
  from public.doc_history
)
delete from public.doc_history h
using ranked r
where h.id = r.id and r.n > 1;

-- 3) What is left.
select count(*) as versions_left,
       count(distinct (kind, doc_id)) as notes_with_history,
       pg_size_pretty(pg_total_relation_size('public.doc_history')) as size_before_vacuum
from public.doc_history;

-- 4) Run this ALONE afterwards to give the space back:
-- vacuum full public.doc_history;
