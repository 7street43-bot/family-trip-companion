\set ON_ERROR_STOP on
create extension if not exists pgcrypto;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant authenticated, anon, service_role to current_user;

create schema auth;
create table auth.users(id uuid primary key);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
grant usage on schema auth to authenticated,anon;
grant execute on function auth.uid() to authenticated,anon;

create schema private;
revoke all on schema private from public,anon,authenticated;
grant usage on schema private to authenticated;

create table public.family_workspaces(
  id uuid primary key,
  name text not null,
  created_by uuid not null references auth.users(id),
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.family_workspace_members(
  workspace_id uuid not null references public.family_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  primary key(workspace_id,user_id)
);
create or replace function private.is_family_workspace_member(target_workspace uuid)
returns boolean
language sql stable security definer
set search_path=''
as $$
  select exists(
    select 1 from public.family_workspace_members m
    where m.workspace_id=target_workspace and m.user_id=auth.uid()
  );
$$;
revoke all on function private.is_family_workspace_member(uuid) from public,anon,authenticated;
grant execute on function private.is_family_workspace_member(uuid) to authenticated;
