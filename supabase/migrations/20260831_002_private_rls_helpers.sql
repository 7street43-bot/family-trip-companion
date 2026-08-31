-- V4.5 Phase 1: move RLS helper functions out of the exposed public API schema.
create schema if not exists private;

create or replace function private.is_family_workspace_member(target_workspace uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.family_workspace_members m
    where m.workspace_id = target_workspace and m.user_id = auth.uid()
  );
$$;

create or replace function private.is_family_workspace_owner(target_workspace uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.family_workspace_members m
    where m.workspace_id = target_workspace and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
revoke all on function private.is_family_workspace_member(uuid) from public, anon;
revoke all on function private.is_family_workspace_owner(uuid) from public, anon;
grant execute on function private.is_family_workspace_member(uuid) to authenticated;
grant execute on function private.is_family_workspace_owner(uuid) to authenticated;

drop policy if exists "workspace members can read workspaces" on public.family_workspaces;
create policy "workspace members can read workspaces" on public.family_workspaces
for select to authenticated using (private.is_family_workspace_member(id));

drop policy if exists "members can read memberships" on public.family_workspace_members;
create policy "members can read memberships" on public.family_workspace_members
for select to authenticated using (private.is_family_workspace_member(workspace_id));

drop policy if exists "members can read sync records" on public.family_sync_records;
create policy "members can read sync records" on public.family_sync_records
for select to authenticated using (private.is_family_workspace_member(workspace_id));

create or replace function public.family_sync_push(
  p_workspace_id uuid,
  p_store_name text,
  p_record_id text,
  p_expected_version bigint,
  p_payload jsonb default null,
  p_deleted boolean default false,
  p_client_updated_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  current_row public.family_sync_records%rowtype;
  result_row public.family_sync_records%rowtype;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not private.is_family_workspace_member(p_workspace_id) then raise exception 'workspace access denied'; end if;
  if p_store_name not in ('entities','packItems','packState','itineraries','settings','journals') then raise exception 'invalid store_name'; end if;
  if p_record_id is null or char_length(p_record_id) < 1 or char_length(p_record_id) > 200 then raise exception 'invalid record_id'; end if;
  if p_expected_version is null or p_expected_version < 0 then raise exception 'invalid expected_version'; end if;
  if not p_deleted and p_payload is null then raise exception 'active record requires payload'; end if;

  select * into current_row from public.family_sync_records r
  where r.workspace_id=p_workspace_id and r.store_name=p_store_name and r.record_id=p_record_id for update;

  if not found then
    if p_expected_version <> 0 then
      return jsonb_build_object('status','conflict','reason','server_record_missing','expectedVersion',p_expected_version);
    end if;
    insert into public.family_sync_records(workspace_id,store_name,record_id,payload,version,deleted_at,client_updated_at,updated_by)
    values (p_workspace_id,p_store_name,p_record_id,case when p_deleted then null else p_payload end,1,case when p_deleted then now() else null end,p_client_updated_at,uid)
    returning * into result_row;
  else
    if current_row.version <> p_expected_version then
      return jsonb_build_object('status','conflict','reason','version_mismatch','expectedVersion',p_expected_version,'serverVersion',current_row.version,'serverChangeSeq',current_row.change_seq,'serverUpdatedAt',current_row.updated_at,'serverDeletedAt',current_row.deleted_at,'serverPayload',current_row.payload);
    end if;
    update public.family_sync_records r set
      payload=case when p_deleted then null else p_payload end,
      version=current_row.version+1,
      deleted_at=case when p_deleted then now() else null end,
      client_updated_at=p_client_updated_at,
      updated_by=uid
    where r.workspace_id=p_workspace_id and r.store_name=p_store_name and r.record_id=p_record_id
    returning * into result_row;
  end if;

  return jsonb_build_object('status','applied','version',result_row.version,'changeSeq',result_row.change_seq,'updatedAt',result_row.updated_at,'deletedAt',result_row.deleted_at);
end;
$$;

revoke all on function public.is_family_workspace_member(uuid) from public, anon, authenticated;
revoke all on function public.is_family_workspace_owner(uuid) from public, anon, authenticated;
drop function if exists public.is_family_workspace_member(uuid);
drop function if exists public.is_family_workspace_owner(uuid);
