-- V4.5 Phase 1: Cloud Sync foundation (hardened)
-- Goals:
-- 1) same logical stores as IndexedDB
-- 2) deterministic cross-device delta cursor via server change_seq
-- 3) optimistic concurrency via RPC; direct client writes are revoked
-- 4) soft-delete tombstones for reliable offline reconciliation
-- 5) RLS-isolated family workspace, ready for future family sharing

create table if not exists public.family_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  created_by uuid not null references auth.users(id) on delete cascade,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists family_workspaces_primary_owner_uq
  on public.family_workspaces (created_by)
  where is_primary;

create table if not exists public.family_workspace_members (
  workspace_id uuid not null references public.family_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create sequence if not exists public.family_sync_change_seq as bigint;

create table if not exists public.family_sync_records (
  workspace_id uuid not null references public.family_workspaces(id) on delete cascade,
  store_name text not null check (store_name in ('entities','packItems','packState','itineraries','settings','journals')),
  record_id text not null check (char_length(record_id) between 1 and 200),
  payload jsonb,
  version bigint not null default 1 check (version > 0),
  deleted_at timestamptz,
  client_updated_at timestamptz,
  updated_by uuid not null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  change_seq bigint not null default 0,
  primary key (workspace_id, store_name, record_id),
  constraint active_sync_record_requires_payload
    check (deleted_at is not null or payload is not null)
);

create index if not exists family_sync_records_delta_idx
  on public.family_sync_records (workspace_id, change_seq);
create index if not exists family_sync_records_store_delta_idx
  on public.family_sync_records (workspace_id, store_name, change_seq);

-- Server-authoritative timestamps + monotonic delta cursor.
create or replace function public.family_touch_workspace_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists family_workspaces_touch_updated_at on public.family_workspaces;
create trigger family_workspaces_touch_updated_at
before update on public.family_workspaces
for each row execute function public.family_touch_workspace_updated_at();

create or replace function public.family_sync_stamp_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.change_seq := nextval('public.family_sync_change_seq');
  return new;
end;
$$;

drop trigger if exists family_sync_records_stamp_change on public.family_sync_records;
create trigger family_sync_records_stamp_change
before insert or update on public.family_sync_records
for each row execute function public.family_sync_stamp_change();

alter table public.family_workspaces enable row level security;
alter table public.family_workspace_members enable row level security;
alter table public.family_sync_records enable row level security;

-- Security-definer membership helpers avoid recursive RLS checks.
create or replace function public.is_family_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.family_workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_family_workspace_owner(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.family_workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

-- Idempotent bootstrap for the user's primary workspace.
create or replace function public.ensure_personal_family_workspace(workspace_name text default '我的家庭')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  workspace_id uuid;
  safe_name text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  safe_name := coalesce(nullif(trim(workspace_name), ''), '我的家庭');
  if char_length(safe_name) > 80 then
    raise exception 'workspace name too long';
  end if;

  select w.id into workspace_id
  from public.family_workspaces w
  where w.created_by = uid and w.is_primary
  limit 1;

  if workspace_id is null then
    begin
      insert into public.family_workspaces(name, created_by, is_primary)
      values (safe_name, uid, true)
      returning id into workspace_id;
    exception when unique_violation then
      select w.id into workspace_id
      from public.family_workspaces w
      where w.created_by = uid and w.is_primary
      limit 1;
    end;
  end if;

  insert into public.family_workspace_members(workspace_id, user_id, role)
  values (workspace_id, uid, 'owner')
  on conflict (workspace_id, user_id) do update
    set role = 'owner';

  return workspace_id;
end;
$$;

-- Optimistic-lock mutation endpoint.
-- expected_version=0 means create-only. Existing rows require exact version match.
-- Deletion is a tombstone update, never a physical DELETE.
create or replace function public.family_sync_push(
  p_workspace_id uuid,
  p_store_name text,
  p_record_id text,
  p_expected_version bigint,
  p_payload jsonb default null,
  p_deleted boolean default false,
  p_client_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  current_row public.family_sync_records%rowtype;
  result_row public.family_sync_records%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_family_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied';
  end if;
  if p_store_name not in ('entities','packItems','packState','itineraries','settings','journals') then
    raise exception 'invalid store_name';
  end if;
  if p_record_id is null or char_length(p_record_id) < 1 or char_length(p_record_id) > 200 then
    raise exception 'invalid record_id';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'invalid expected_version';
  end if;
  if not p_deleted and p_payload is null then
    raise exception 'active record requires payload';
  end if;

  select * into current_row
  from public.family_sync_records r
  where r.workspace_id = p_workspace_id
    and r.store_name = p_store_name
    and r.record_id = p_record_id
  for update;

  if not found then
    if p_expected_version <> 0 then
      return jsonb_build_object(
        'status','conflict',
        'reason','server_record_missing',
        'expectedVersion',p_expected_version
      );
    end if;

    insert into public.family_sync_records(
      workspace_id, store_name, record_id, payload, version,
      deleted_at, client_updated_at, updated_by
    ) values (
      p_workspace_id, p_store_name, p_record_id,
      case when p_deleted then null else p_payload end,
      1,
      case when p_deleted then now() else null end,
      p_client_updated_at,
      uid
    ) returning * into result_row;
  else
    if current_row.version <> p_expected_version then
      return jsonb_build_object(
        'status','conflict',
        'reason','version_mismatch',
        'expectedVersion',p_expected_version,
        'serverVersion',current_row.version,
        'serverChangeSeq',current_row.change_seq,
        'serverUpdatedAt',current_row.updated_at,
        'serverDeletedAt',current_row.deleted_at,
        'serverPayload',current_row.payload
      );
    end if;

    update public.family_sync_records r
    set payload = case when p_deleted then null else p_payload end,
        version = current_row.version + 1,
        deleted_at = case when p_deleted then now() else null end,
        client_updated_at = p_client_updated_at,
        updated_by = uid
    where r.workspace_id = p_workspace_id
      and r.store_name = p_store_name
      and r.record_id = p_record_id
    returning * into result_row;
  end if;

  return jsonb_build_object(
    'status','applied',
    'version',result_row.version,
    'changeSeq',result_row.change_seq,
    'updatedAt',result_row.updated_at,
    'deletedAt',result_row.deleted_at
  );
end;
$$;

-- SELECT policies. Mutations are RPC-only.
drop policy if exists "workspace members can read workspaces" on public.family_workspaces;
create policy "workspace members can read workspaces"
on public.family_workspaces for select to authenticated
using (public.is_family_workspace_member(id));

drop policy if exists "members can read memberships" on public.family_workspace_members;
create policy "members can read memberships"
on public.family_workspace_members for select to authenticated
using (public.is_family_workspace_member(workspace_id));

drop policy if exists "members can read sync records" on public.family_sync_records;
create policy "members can read sync records"
on public.family_sync_records for select to authenticated
using (public.is_family_workspace_member(workspace_id));

-- Remove any older permissive mutation policies if this migration is replayed over a draft.
drop policy if exists "workspace owners can update workspace" on public.family_workspaces;
drop policy if exists "owners can add members" on public.family_workspace_members;
drop policy if exists "owners can remove members" on public.family_workspace_members;
drop policy if exists "members can insert sync records" on public.family_sync_records;
drop policy if exists "members can update sync records" on public.family_sync_records;
drop policy if exists "members can delete sync records" on public.family_sync_records;

-- Explicit grants: browser clients can read only through RLS; writes go through RPC.
revoke all on public.family_workspaces from anon, authenticated;
revoke all on public.family_workspace_members from anon, authenticated;
revoke all on public.family_sync_records from anon, authenticated;
grant select on public.family_workspaces to authenticated;
grant select on public.family_workspace_members to authenticated;
grant select on public.family_sync_records to authenticated;

revoke all on function public.is_family_workspace_member(uuid) from public, anon, authenticated;
revoke all on function public.is_family_workspace_owner(uuid) from public, anon, authenticated;
revoke all on function public.ensure_personal_family_workspace(text) from public, anon, authenticated;
revoke all on function public.family_sync_push(uuid,text,text,bigint,jsonb,boolean,timestamptz) from public, anon, authenticated;
grant execute on function public.is_family_workspace_member(uuid) to authenticated;
grant execute on function public.is_family_workspace_owner(uuid) to authenticated;
grant execute on function public.ensure_personal_family_workspace(text) to authenticated;
grant execute on function public.family_sync_push(uuid,text,text,bigint,jsonb,boolean,timestamptz) to authenticated;

-- Realtime publication for authenticated cross-device deltas.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'family_sync_records'
  ) then
    alter publication supabase_realtime add table public.family_sync_records;
  end if;
end $$;
