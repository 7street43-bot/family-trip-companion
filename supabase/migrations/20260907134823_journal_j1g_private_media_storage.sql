-- Applied to Production as migration 20260907134823 journal_j1g_private_media_storage.
-- Private Journal photo storage + metadata mutation layer.
-- Upload protocol: reserve metadata -> upload exact private object -> finalize metadata.

alter table public.journal_media
  add column if not exists upload_state text not null default 'pending';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.journal_media'::regclass
      and conname='journal_media_upload_state_valid'
  ) then
    alter table public.journal_media
      add constraint journal_media_upload_state_valid
      check (upload_state in ('pending','ready'));
  end if;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values (
  'journal-media','journal-media',false,26214400,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']::text[]
)
on conflict (id) do update set
  name=excluded.name,
  public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create or replace function private.journal_media_storage_path_valid(p_name text)
returns boolean
language sql
immutable
set search_path=''
as $$
  select coalesce(
    p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$'
    and split_part(p_name,'/',3)=split_part(split_part(p_name,'/',4),'.',1),
    false
  );
$$;

revoke all on function private.journal_media_storage_path_valid(text) from public,anon;
grant execute on function private.journal_media_storage_path_valid(text) to authenticated,service_role;

drop policy if exists "journal media members can read objects" on storage.objects;
create policy "journal media members can read objects"
on storage.objects for select to authenticated
using (
  bucket_id='journal-media'
  and private.journal_media_storage_path_valid(name)
  and private.is_family_workspace_member(split_part(name,'/',1)::uuid)
  and exists (
    select 1 from public.journal_media m
    where m.id=split_part(name,'/',3)::uuid
      and m.workspace_id=split_part(name,'/',1)::uuid
      and m.entry_id=split_part(name,'/',2)::uuid
      and m.storage_path=name
      and m.upload_state='ready'
      and m.deleted_at is null
  )
);

drop policy if exists "journal media reserver can upload object" on storage.objects;
create policy "journal media reserver can upload object"
on storage.objects for insert to authenticated
with check (
  bucket_id='journal-media'
  and private.journal_media_storage_path_valid(name)
  and private.is_family_workspace_member(split_part(name,'/',1)::uuid)
  and exists (
    select 1 from public.journal_media m
    where m.id=split_part(name,'/',3)::uuid
      and m.workspace_id=split_part(name,'/',1)::uuid
      and m.entry_id=split_part(name,'/',2)::uuid
      and m.storage_path=name
      and m.upload_state='pending'
      and m.deleted_at is null
      and m.created_by=auth.uid()
  )
);

create or replace function private.journal_media_mutate_impl(
  p_action text,
  p_workspace_id uuid,
  p_entry_id uuid,
  p_media_id uuid,
  p_expected_version bigint,
  p_payload jsonb,
  p_source text,
  p_mutation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  uid uuid := auth.uid();
  action text := lower(trim(coalesce(p_action,'')));
  src text := lower(trim(coalesce(p_source,'')));
  prior public.journal_revisions%rowtype;
  er public.journal_entries%rowtype;
  mr public.journal_media%rowtype;
  path text;
  mime text;
  so integer;
  base_version bigint;
  out_operation text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_workspace_id is null or not private.is_family_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied';
  end if;
  if p_entry_id is null then raise exception 'entry_id required' using errcode='22023'; end if;
  if p_media_id is null then raise exception 'media_id required' using errcode='22023'; end if;
  if p_mutation_id is null then raise exception 'mutation_id required' using errcode='22023'; end if;
  if src not in ('mobile','desktop','gpt') then raise exception 'invalid journal actor source' using errcode='22023'; end if;
  if action not in ('reserve','finalize','update','archive','restore') then
    raise exception 'invalid media action' using errcode='22023';
  end if;

  select * into prior from public.journal_revisions
  where workspace_id=p_workspace_id and mutation_id=p_mutation_id;
  if found then
    if prior.actor_id is distinct from uid then
      return jsonb_build_object('status','conflict','reason','mutation_id_reused');
    end if;
    return jsonb_build_object(
      'status','replayed','targetType',prior.target_type,'targetId',prior.target_id,
      'version',prior.result_version,'operation',prior.operation
    );
  end if;

  select * into er from public.journal_entries
  where id=p_entry_id and workspace_id=p_workspace_id;
  if not found or er.deleted_at is not null then
    return jsonb_build_object('status','conflict','reason','entry_missing');
  end if;

  if action='reserve' then
    if p_expected_version is distinct from 0 then raise exception 'reserve expected_version must be 0' using errcode='22023'; end if;
    if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'payload must be object' using errcode='22023'; end if;
    if (p_payload - array['storage_path','mime_type','width','height','caption','taken_at','sort_order']) <> '{}'::jsonb then
      raise exception 'reserve payload contains forbidden fields' using errcode='22023';
    end if;
    path:=nullif(p_payload->>'storage_path','');
    mime:=lower(nullif(p_payload->>'mime_type',''));
    if path is null or not private.journal_media_storage_path_valid(path) then
      raise exception 'invalid storage_path' using errcode='22023';
    end if;
    if split_part(path,'/',1)::uuid<>p_workspace_id
      or split_part(path,'/',2)::uuid<>p_entry_id
      or split_part(path,'/',3)::uuid<>p_media_id then
      raise exception 'storage_path identity mismatch' using errcode='22023';
    end if;
    if mime not in ('image/jpeg','image/png','image/webp','image/heic','image/heif') then
      raise exception 'unsupported media type' using errcode='22023';
    end if;
    if p_payload ? 'width' and jsonb_typeof(p_payload->'width')<>'null' and (p_payload->>'width')::integer<=0 then raise exception 'invalid width' using errcode='22023'; end if;
    if p_payload ? 'height' and jsonb_typeof(p_payload->'height')<>'null' and (p_payload->>'height')::integer<=0 then raise exception 'invalid height' using errcode='22023'; end if;
    so:=coalesce((p_payload->>'sort_order')::integer,1000);
    if so<0 then raise exception 'invalid sort_order' using errcode='22023'; end if;
    if exists(select 1 from public.journal_media where id=p_media_id or storage_path=path) then
      return jsonb_build_object('status','conflict','reason','media_exists');
    end if;

    insert into public.journal_media(
      id,workspace_id,entry_id,storage_path,mime_type,width,height,caption,taken_at,
      sort_order,version,created_by,updated_by,upload_state
    ) values (
      p_media_id,p_workspace_id,p_entry_id,path,mime,
      case when jsonb_typeof(p_payload->'width')='null' then null else (p_payload->>'width')::integer end,
      case when jsonb_typeof(p_payload->'height')='null' then null else (p_payload->>'height')::integer end,
      case when jsonb_typeof(p_payload->'caption')='null' then null else p_payload->>'caption' end,
      case when jsonb_typeof(p_payload->'taken_at')='null' or not (p_payload ? 'taken_at') then null else (p_payload->>'taken_at')::timestamptz end,
      so,1,uid,uid,'pending'
    ) returning * into mr;
    base_version:=0;
    out_operation:='register';

  else
    if p_expected_version is null or p_expected_version<1 then raise exception 'invalid expected_version' using errcode='22023'; end if;
    select * into mr from public.journal_media
    where id=p_media_id and entry_id=p_entry_id and workspace_id=p_workspace_id
    for update;
    if not found then return jsonb_build_object('status','conflict','reason','media_missing'); end if;

    select * into prior from public.journal_revisions
    where workspace_id=p_workspace_id and mutation_id=p_mutation_id;
    if found then
      if prior.actor_id is distinct from uid then return jsonb_build_object('status','conflict','reason','mutation_id_reused'); end if;
      return jsonb_build_object('status','replayed','targetType',prior.target_type,'targetId',prior.target_id,'version',prior.result_version,'operation',prior.operation);
    end if;
    if mr.version<>p_expected_version then
      return jsonb_build_object('status','conflict','reason','version_mismatch','serverVersion',mr.version);
    end if;
    base_version:=mr.version;

    if action='finalize' then
      if mr.deleted_at is not null then return jsonb_build_object('status','conflict','reason','media_archived','serverVersion',mr.version); end if;
      if mr.upload_state='ready' then return jsonb_build_object('status','conflict','reason','already_ready','serverVersion',mr.version); end if;
      if not exists(
        select 1 from storage.objects o
        where o.bucket_id='journal-media' and o.name=mr.storage_path
      ) then
        return jsonb_build_object('status','conflict','reason','object_missing','serverVersion',mr.version);
      end if;
      update public.journal_media set upload_state='ready',version=mr.version+1,updated_by=uid,updated_at=now()
      where id=mr.id and workspace_id=p_workspace_id returning * into mr;
      out_operation:='update';

    elsif action='update' then
      if mr.deleted_at is not null then return jsonb_build_object('status','conflict','reason','media_archived','serverVersion',mr.version); end if;
      if mr.upload_state<>'ready' then return jsonb_build_object('status','conflict','reason','media_not_ready','serverVersion',mr.version); end if;
      if p_payload is null or jsonb_typeof(p_payload)<>'object' or p_payload='{}'::jsonb then raise exception 'patch must be non-empty object' using errcode='22023'; end if;
      if (p_payload - array['width','height','caption','taken_at','sort_order']) <> '{}'::jsonb then raise exception 'patch contains forbidden fields' using errcode='22023'; end if;
      if p_payload ? 'width' and jsonb_typeof(p_payload->'width')<>'null' and (p_payload->>'width')::integer<=0 then raise exception 'invalid width' using errcode='22023'; end if;
      if p_payload ? 'height' and jsonb_typeof(p_payload->'height')<>'null' and (p_payload->>'height')::integer<=0 then raise exception 'invalid height' using errcode='22023'; end if;
      if p_payload ? 'sort_order' and (jsonb_typeof(p_payload->'sort_order')='null' or (p_payload->>'sort_order')::integer<0) then raise exception 'invalid sort_order' using errcode='22023'; end if;
      update public.journal_media set
        width=case when p_payload ? 'width' then case when jsonb_typeof(p_payload->'width')='null' then null else (p_payload->>'width')::integer end else mr.width end,
        height=case when p_payload ? 'height' then case when jsonb_typeof(p_payload->'height')='null' then null else (p_payload->>'height')::integer end else mr.height end,
        caption=case when p_payload ? 'caption' then case when jsonb_typeof(p_payload->'caption')='null' then null else p_payload->>'caption' end else mr.caption end,
        taken_at=case when p_payload ? 'taken_at' then case when jsonb_typeof(p_payload->'taken_at')='null' then null else (p_payload->>'taken_at')::timestamptz end else mr.taken_at end,
        sort_order=case when p_payload ? 'sort_order' then (p_payload->>'sort_order')::integer else mr.sort_order end,
        version=mr.version+1,updated_by=uid,updated_at=now()
      where id=mr.id and workspace_id=p_workspace_id returning * into mr;
      out_operation:='update';

    elsif action='archive' then
      if mr.deleted_at is not null then return jsonb_build_object('status','conflict','reason','already_archived','serverVersion',mr.version); end if;
      update public.journal_media set deleted_at=now(),version=mr.version+1,updated_by=uid,updated_at=now()
      where id=mr.id and workspace_id=p_workspace_id returning * into mr;
      out_operation:='delete';

    else
      if mr.deleted_at is null then return jsonb_build_object('status','conflict','reason','not_archived','serverVersion',mr.version); end if;
      update public.journal_media set deleted_at=null,version=mr.version+1,updated_by=uid,updated_at=now()
      where id=mr.id and workspace_id=p_workspace_id returning * into mr;
      out_operation:='restore';
    end if;
  end if;

  insert into public.journal_revisions(
    workspace_id,entry_id,target_type,target_id,operation,mutation_id,actor_id,actor_source,
    base_version,result_version,snapshot
  ) values (
    p_workspace_id,p_entry_id,'media',mr.id,out_operation,p_mutation_id,uid,src,
    base_version,mr.version,to_jsonb(mr)
  );

  return jsonb_build_object(
    'status','applied','targetType','media','targetId',mr.id,
    'version',mr.version,'operation',out_operation,'uploadState',mr.upload_state,
    'storagePath',mr.storage_path
  );
exception when unique_violation then
  select * into prior from public.journal_revisions where workspace_id=p_workspace_id and mutation_id=p_mutation_id;
  if found and prior.actor_id is not distinct from uid then
    return jsonb_build_object('status','replayed','targetType',prior.target_type,'targetId',prior.target_id,'version',prior.result_version,'operation',prior.operation);
  end if;
  return jsonb_build_object('status','conflict','reason','media_exists');
end;
$$;

create or replace function public.journal_media_mutate(
  p_action text,
  p_workspace_id uuid,
  p_entry_id uuid,
  p_media_id uuid,
  p_expected_version bigint,
  p_payload jsonb,
  p_source text,
  p_mutation_id uuid
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.journal_media_mutate_impl(
    p_action,p_workspace_id,p_entry_id,p_media_id,p_expected_version,p_payload,p_source,p_mutation_id
  );
$$;

revoke all on function private.journal_media_mutate_impl(text,uuid,uuid,uuid,bigint,jsonb,text,uuid) from public,anon;
revoke all on function public.journal_media_mutate(text,uuid,uuid,uuid,bigint,jsonb,text,uuid) from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.journal_media_mutate_impl(text,uuid,uuid,uuid,bigint,jsonb,text,uuid) to authenticated,service_role;
grant execute on function public.journal_media_mutate(text,uuid,uuid,uuid,bigint,jsonb,text,uuid) to authenticated,service_role;

revoke insert,update,delete,truncate on public.journal_media from anon,authenticated;

-- Intentionally no authenticated UPDATE/DELETE policies on storage.objects in J1G.
-- Archived media remains physically private for later server-side retention/GC rather than client-side hard delete.