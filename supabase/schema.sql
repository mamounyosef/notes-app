-- Cloud sync for the Notes app.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- Safe to run again: everything is created only when missing.

/* ---------------- notes (pages, tree, settings) ---------------- */

-- Grows with every write, so a computer can ask "what changed since N".
create sequence if not exists public.notes_change_seq;

create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('page', 'workspace', 'settings')),
  doc_id text not null default '',
  data jsonb,
  rev bigint not null default 1,
  change_seq bigint not null default nextval('public.notes_change_seq'),
  deleted boolean not null default false,
  device text,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, doc_id)
);
create index if not exists docs_user_seq on public.docs (user_id, change_seq);

-- Every replaced or deleted version is kept for 30 days (at most the newest
-- 500 per note), so nothing a sync ever overwrites is gone for good. A write
-- that changes nothing adds no version, so a sync loop cannot fill the database.
create table if not exists public.doc_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  kind text not null,
  doc_id text not null,
  data jsonb,
  rev bigint,
  deleted boolean,
  device text,
  saved_at timestamptz not null default now()
);
create index if not exists doc_history_doc on public.doc_history (user_id, kind, doc_id, saved_at);

/* ---------------- files (images and artifacts) ---------------- */

-- One row per file path. The bytes live in Storage at <user id>/blobs/<sha>.
create table if not exists public.files (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  path text not null,
  sha text,
  size bigint not null default 0,
  rev bigint not null default 1,
  change_seq bigint not null default nextval('public.notes_change_seq'),
  deleted boolean not null default false,
  device text,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);
create index if not exists files_user_seq on public.files (user_id, change_seq);

/* ---------------- row level security: only your own rows ---------------- */

alter table public.docs enable row level security;
alter table public.files enable row level security;
alter table public.doc_history enable row level security;

drop policy if exists "own docs select" on public.docs;
drop policy if exists "own docs insert" on public.docs;
drop policy if exists "own docs update" on public.docs;
create policy "own docs select" on public.docs for select to authenticated using ((select auth.uid()) = user_id);
create policy "own docs insert" on public.docs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own docs update" on public.docs for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own files select" on public.files;
drop policy if exists "own files insert" on public.files;
drop policy if exists "own files update" on public.files;
create policy "own files select" on public.files for select to authenticated using ((select auth.uid()) = user_id);
create policy "own files insert" on public.files for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own files update" on public.files for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own history select" on public.doc_history;
create policy "own history select" on public.doc_history for select to authenticated using ((select auth.uid()) = user_id);

/* ---------------- history trigger ---------------- */

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

drop trigger if exists docs_history on public.docs;
create trigger docs_history after update or delete on public.docs
for each row execute function public.docs_keep_history();

/* ---------------- writes: only on top of the latest version ---------------- */

-- Saves a note only if nobody changed it since p_expected_rev (0 = new).
-- Otherwise returns ok=false and the app fetches, merges and tries again.
create or replace function public.push_doc(
  p_kind text, p_doc_id text, p_data jsonb, p_expected_rev bigint, p_deleted boolean, p_device text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rev bigint;
  v_seq bigint;
begin
  if p_expected_rev = 0 then
    insert into public.docs (user_id, kind, doc_id, data, rev, deleted, device)
    values (auth.uid(), p_kind, p_doc_id, p_data, 1, p_deleted, p_device)
    on conflict (user_id, kind, doc_id) do nothing
    returning rev, change_seq into v_rev, v_seq;
  else
    update public.docs
    set data = p_data, rev = rev + 1, deleted = p_deleted, device = p_device,
        change_seq = nextval('public.notes_change_seq'), updated_at = now()
    where user_id = auth.uid() and kind = p_kind and doc_id = p_doc_id and rev = p_expected_rev
    returning rev, change_seq into v_rev, v_seq;
  end if;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'rev', v_rev, 'change_seq', v_seq);
end;
$$;

create or replace function public.push_file(
  p_path text, p_sha text, p_size bigint, p_expected_rev bigint, p_deleted boolean, p_device text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rev bigint;
  v_seq bigint;
begin
  if p_expected_rev = 0 then
    insert into public.files (user_id, path, sha, size, rev, deleted, device)
    values (auth.uid(), p_path, p_sha, p_size, 1, p_deleted, p_device)
    on conflict (user_id, path) do nothing
    returning rev, change_seq into v_rev, v_seq;
  else
    update public.files
    set sha = p_sha, size = p_size, rev = rev + 1, deleted = p_deleted, device = p_device,
        change_seq = nextval('public.notes_change_seq'), updated_at = now()
    where user_id = auth.uid() and path = p_path and rev = p_expected_rev
    returning rev, change_seq into v_rev, v_seq;
  end if;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'rev', v_rev, 'change_seq', v_seq);
end;
$$;

revoke execute on function public.push_doc(text, text, jsonb, bigint, boolean, text) from public, anon;
revoke execute on function public.push_file(text, text, bigint, bigint, boolean, text) from public, anon;
grant execute on function public.push_doc(text, text, jsonb, bigint, boolean, text) to authenticated;
grant execute on function public.push_file(text, text, bigint, bigint, boolean, text) to authenticated;
grant usage, select on sequence public.notes_change_seq to authenticated;

/* ---------------- live updates ---------------- */

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'files') then
    alter publication supabase_realtime add table public.files;
  end if;
end;
$$;

/* ---------------- agent chats ---------------- */

-- One row per conversation with the in-app agent, so chats follow you
-- between computers. Attachments live in Storage like the note files.
create table if not exists public.agent_chats (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb,
  rev bigint not null default 1,
  change_seq bigint not null default nextval('public.notes_change_seq'),
  deleted boolean not null default false,
  device text,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists agent_chats_user_seq on public.agent_chats (user_id, change_seq);

alter table public.agent_chats enable row level security;
drop policy if exists "own chats select" on public.agent_chats;
drop policy if exists "own chats insert" on public.agent_chats;
drop policy if exists "own chats update" on public.agent_chats;
create policy "own chats select" on public.agent_chats for select to authenticated using ((select auth.uid()) = user_id);
create policy "own chats insert" on public.agent_chats for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own chats update" on public.agent_chats for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.push_chat(
  p_id text, p_data jsonb, p_expected_rev bigint, p_deleted boolean, p_device text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rev bigint;
  v_seq bigint;
begin
  if p_expected_rev = 0 then
    insert into public.agent_chats (user_id, id, data, rev, deleted, device)
    values (auth.uid(), p_id, p_data, 1, p_deleted, p_device)
    on conflict (user_id, id) do nothing
    returning rev, change_seq into v_rev, v_seq;
  else
    update public.agent_chats
    set data = p_data, rev = rev + 1, deleted = p_deleted, device = p_device,
        change_seq = nextval('public.notes_change_seq'), updated_at = now()
    where user_id = auth.uid() and id = p_id and rev = p_expected_rev
    returning rev, change_seq into v_rev, v_seq;
  end if;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'rev', v_rev, 'change_seq', v_seq);
end;
$$;

revoke execute on function public.push_chat(text, jsonb, bigint, boolean, text) from public, anon;
grant execute on function public.push_chat(text, jsonb, bigint, boolean, text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'agent_chats') then
    alter publication supabase_realtime add table public.agent_chats;
  end if;
end;
$$;

/* ---------------- storage for file bytes ---------------- */

insert into storage.buckets (id, name, public)
values ('vault', 'vault', false)
on conflict (id) do nothing;

drop policy if exists "vault own read" on storage.objects;
drop policy if exists "vault own write" on storage.objects;
drop policy if exists "vault own update" on storage.objects;
create policy "vault own read" on storage.objects for select to authenticated
  using (bucket_id = 'vault' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "vault own write" on storage.objects for insert to authenticated
  with check (bucket_id = 'vault' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "vault own update" on storage.objects for update to authenticated
  using (bucket_id = 'vault' and (storage.foldername(name))[1] = (select auth.uid()::text));
