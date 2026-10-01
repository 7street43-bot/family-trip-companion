-- Family Trip Companion｜Family Workspace sharing
-- Preview candidate only until the final integrated release gate.
-- Design goals:
-- 1) owner creates a short-lived single-use invite token
-- 2) signed-in family member redeems it and becomes a member
-- 3) no direct client writes to memberships or invites
-- 4) all privileged RPCs authenticate and authorize explicitly

create table if not exists public.family_workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.family_workspaces(id) on delete cascade,
  invite_token uuid not null unique default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  constraint family_workspace_invites_expiry_valid check (expires_at > created_at),
  constraint family_workspace_invites_redeem_pair check (
    (redeemed_by is null and redeemed_at is null)
    or (redeemed_by is not null and redeemed_at is not null)
  )
);

create index if not exists family_workspace_invites_workspace_created_idx
  on public.family_workspace_invites (workspace_id, created_at desc);
create index if not exists family_workspace_invites_active_token_idx
  on public.family_workspace_invites (invite_token)
  where redeemed_at is null and revoked_at is null;

alter table public.family_workspace_invites enable row level security;
revoke all on public.family_workspace_invites from public, anon, authenticated;

-- Owners can create one-time invites valid for 1..168 hours.
create or replace function public.family_create_invite(
  p_workspace_id uuid,
  p_valid_hours integer default 24
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  invite_row public.family_workspace_invites%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if not private.is_family_workspace_owner(p_workspace_id) then
    raise exception 'workspace owner required';
  end if;
  if p_valid_hours is null or p_valid_hours < 1 or p_valid_hours > 168 then
    raise exception 'invalid invite validity';
  end if;

  insert into public.family_workspace_invites(
    workspace_id, created_by, expires_at
  ) values (
    p_workspace_id, uid, now() + make_interval(hours => p_valid_hours)
  ) returning * into invite_row;

  return jsonb_build_object(
    'status','created',
    'inviteId',invite_row.id,
    'token',invite_row.invite_token,
    'workspaceId',invite_row.workspace_id,
    'expiresAt',invite_row.expires_at
  );
end;
$$;

-- A signed-in user redeems a valid invite and joins the owner's workspace.
create or replace function public.family_redeem_invite(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  invite_row public.family_workspace_invites%rowtype;
  workspace_name text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_token is null then
    raise exception 'invite token required';
  end if;

  select * into invite_row
  from public.family_workspace_invites i
  where i.invite_token = p_token
  for update;

  if not found then
    raise exception 'invite invalid';
  end if;
  if invite_row.revoked_at is not null then
    raise exception 'invite revoked';
  end if;
  if invite_row.redeemed_at is not null then
    raise exception 'invite already used';
  end if;
  if invite_row.expires_at <= now() then
    raise exception 'invite expired';
  end if;

  insert into public.family_workspace_members(workspace_id, user_id, role)
  values (invite_row.workspace_id, uid, 'member')
  on conflict (workspace_id, user_id) do nothing;

  update public.family_workspace_invites
  set redeemed_by = uid,
      redeemed_at = now()
  where id = invite_row.id;

  select w.name into workspace_name
  from public.family_workspaces w
  where w.id = invite_row.workspace_id;

  return jsonb_build_object(
    'status','joined',
    'workspaceId',invite_row.workspace_id,
    'workspaceName',workspace_name,
    'role','member'
  );
end;
$$;

create or replace function public.family_revoke_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  invite_row public.family_workspace_invites%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select * into invite_row
  from public.family_workspace_invites i
  where i.id = p_invite_id
  for update;

  if not found then
    raise exception 'invite not found';
  end if;
  if not private.is_family_workspace_owner(invite_row.workspace_id) then
    raise exception 'workspace owner required';
  end if;
  if invite_row.redeemed_at is not null then
    raise exception 'invite already used';
  end if;

  update public.family_workspace_invites
  set revoked_at = coalesce(revoked_at, now())
  where id = p_invite_id;

  return jsonb_build_object('status','revoked','inviteId',p_invite_id);
end;
$$;

-- Owner may remove members, but never the owner row.
create or replace function public.family_remove_member(
  p_workspace_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  target_role text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if not private.is_family_workspace_owner(p_workspace_id) then
    raise exception 'workspace owner required';
  end if;
  if p_user_id is null then
    raise exception 'member required';
  end if;

  select m.role into target_role
  from public.family_workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;

  if not found then
    raise exception 'member not found';
  end if;
  if target_role = 'owner' then
    raise exception 'cannot remove owner';
  end if;

  delete from public.family_workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;

  return jsonb_build_object('status','removed','workspaceId',p_workspace_id,'userId',p_user_id);
end;
$$;

-- A non-owner member can leave a shared family workspace.
create or replace function public.family_leave_workspace(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  current_role text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select m.role into current_role
  from public.family_workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = uid;

  if not found then
    raise exception 'workspace membership not found';
  end if;
  if current_role = 'owner' then
    raise exception 'owner cannot leave primary workspace';
  end if;

  delete from public.family_workspace_members
  where workspace_id = p_workspace_id and user_id = uid;

  return jsonb_build_object('status','left','workspaceId',p_workspace_id);
end;
$$;

revoke all on function public.family_create_invite(uuid,integer) from public, anon, authenticated;
revoke all on function public.family_redeem_invite(uuid) from public, anon, authenticated;
revoke all on function public.family_revoke_invite(uuid) from public, anon, authenticated;
revoke all on function public.family_remove_member(uuid,uuid) from public, anon, authenticated;
revoke all on function public.family_leave_workspace(uuid) from public, anon, authenticated;

grant execute on function public.family_create_invite(uuid,integer) to authenticated;
grant execute on function public.family_redeem_invite(uuid) to authenticated;
grant execute on function public.family_revoke_invite(uuid) to authenticated;
grant execute on function public.family_remove_member(uuid,uuid) to authenticated;
grant execute on function public.family_leave_workspace(uuid) to authenticated;
