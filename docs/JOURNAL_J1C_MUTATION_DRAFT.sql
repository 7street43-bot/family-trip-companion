-- J1C DRAFT ONLY — DO NOT APPLY FROM THIS FILE
-- Authenticated Journal mutation API with optimistic concurrency, mutation-id idempotency,
-- soft delete/restore and revision history. Public RPCs are SECURITY INVOKER;
-- the single privileged implementation lives in the non-exposed private schema.

begin;

create or replace function private.journal_mutate_impl(
  p_action text,
  p_workspace_id uuid,
  p_entry_id uuid,
  p_block_id uuid,
  p_expected_version bigint,
  p_payload jsonb,
  p_source text,
  p_mutation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  action text := lower(trim(coalesce(p_action,'')));
  src text := lower(trim(coalesce(p_source,'')));
  prior public.journal_revisions%rowtype;
  er public.journal_entries%rowtype;
  br public.journal_blocks%rowtype;
  out_id uuid;
  out_entry_id uuid;
  out_version bigint;
  out_type text;
  out_operation text;
  base_version bigint;
  snap jsonb;
  tags_arr text[];
  participants_arr text[];
  so integer;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_workspace_id is null or not private.is_family_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied';
  end if;
  if p_mutation_id is null then raise exception 'mutation_id required' using errcode='22023'; end if;
  if src not in ('mobile','desktop','gpt') then raise exception 'invalid journal actor source' using errcode='22023'; end if;
  if action not in (
    'entry.create','entry.update','entry.archive','entry.restore',
    'block.create','block.update','block.reorder','block.delete','block.restore'
  ) then raise exception 'invalid journal action' using errcode='22023'; end if;

  select * into prior
  from public.journal_revisions
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

  if action='entry.create' then
    if p_entry_id is not null or p_block_id is not null then raise exception 'create ids must be null' using errcode='22023'; end if;
    if p_expected_version is distinct from 0 then raise exception 'create expected_version must be 0' using errcode='22023'; end if;
    if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'payload must be object' using errcode='22023'; end if;
    if not (p_payload ? 'entry_date') or jsonb_typeof(p_payload->'entry_date')='null' then raise exception 'entry_date required' using errcode='22023'; end if;
    if (p_payload - array['entry_date','timezone','title','summary','tags','participants','trip_ref']) <> '{}'::jsonb then
      raise exception 'create payload contains forbidden fields' using errcode='22023';
    end if;
    if p_payload ? 'tags' then
      if jsonb_typeof(p_payload->'tags') <> 'array' or exists(select 1 from jsonb_array_elements(p_payload->'tags') x where jsonb_typeof(x.value)<>'string') then
        raise exception 'tags must be a string array' using errcode='22023';
      end if;
      select coalesce(array_agg(value),'{}'::text[]) into tags_arr from jsonb_array_elements_text(p_payload->'tags');
    else tags_arr := '{}'::text[]; end if;
    if p_payload ? 'participants' then
      if jsonb_typeof(p_payload->'participants') <> 'array' or exists(select 1 from jsonb_array_elements(p_payload->'participants') x where jsonb_typeof(x.value)<>'string') then
        raise exception 'participants must be a string array' using errcode='22023';
      end if;
      select coalesce(array_agg(value),'{}'::text[]) into participants_arr from jsonb_array_elements_text(p_payload->'participants');
    else participants_arr := '{}'::text[]; end if;

    insert into public.journal_entries(
      workspace_id,trip_ref,entry_date,timezone,title,summary,tags,participants,
      version,created_by,updated_by,created_source,updated_source
    ) values (
      p_workspace_id,
      case when jsonb_typeof(p_payload->'trip_ref')='null' then null else nullif(p_payload->>'trip_ref','') end,
      (p_payload->>'entry_date')::date,
      coalesce(nullif(p_payload->>'timezone',''),'Asia/Taipei'),
      case when jsonb_typeof(p_payload->'title')='null' then null else p_payload->>'title' end,
      case when jsonb_typeof(p_payload->'summary')='null' then null else p_payload->>'summary' end,
      tags_arr,participants_arr,1,uid,uid,src,src
    ) returning * into er;
    out_id:=er.id; out_entry_id:=er.id; out_version:=er.version; out_type:='entry'; out_operation:='create'; base_version:=0; snap:=to_jsonb(er);

  elsif action in ('entry.update','entry.archive','entry.restore') then
    if p_entry_id is null then raise exception 'entry_id required' using errcode='22023'; end if;
    if p_expected_version is null or p_expected_version<1 then raise exception 'invalid expected_version' using errcode='22023'; end if;
    select * into er from public.journal_entries
    where id=p_entry_id and workspace_id=p_workspace_id for update;
    if not found then return jsonb_build_object('status','conflict','reason','entry_missing'); end if;

    -- Recheck after row lock so concurrent retries with the same mutation_id replay instead of conflict.
    select * into prior from public.journal_revisions
    where workspace_id=p_workspace_id and mutation_id=p_mutation_id;
    if found then
      if prior.actor_id is distinct from uid then return jsonb_build_object('status','conflict','reason','mutation_id_reused'); end if;
      return jsonb_build_object('status','replayed','targetType',prior.target_type,'targetId',prior.target_id,'version',prior.result_version,'operation',prior.operation);
    end if;
    if er.version<>p_expected_version then return jsonb_build_object('status','conflict','reason','version_mismatch','serverVersion',er.version); end if;
    base_version:=er.version;

    if action='entry.update' then
      if er.deleted_at is not null then return jsonb_build_object('status','conflict','reason','entry_archived','serverVersion',er.version); end if;
      if p_payload is null or jsonb_typeof(p_payload)<>'object' or p_payload='{}'::jsonb then raise exception 'patch must be a non-empty object' using errcode='22023'; end if;
      if (p_payload - array['entry_date','timezone','title','summary','tags','participants','trip_ref']) <> '{}'::jsonb then
        raise exception 'patch contains forbidden fields' using errcode='22023';
      end if;
      if p_payload ? 'entry_date' and jsonb_typeof(p_payload->'entry_date')='null' then raise exception 'entry_date cannot be null' using errcode='22023'; end if;
      if p_payload ? 'timezone' and jsonb_typeof(p_payload->'timezone')='null' then raise exception 'timezone cannot be null' using errcode='22023'; end if;
      tags_arr:=er.tags; participants_arr:=er.participants;
      if p_payload ? 'tags' then
        if jsonb_typeof(p_payload->'tags') <> 'array' or exists(select 1 from jsonb_array_elements(p_payload->'tags') x where jsonb_typeof(x.value)<>'string') then raise exception 'tags must be a string array' using errcode='22023'; end if;
        select coalesce(array_agg(value),'{}'::text[]) into tags_arr from jsonb_array_elements_text(p_payload->'tags');
      end if;
      if p_payload ? 'participants' then
        if jsonb_typeof(p_payload->'participants') <> 'array' or exists(select 1 from jsonb_array_elements(p_payload->'participants') x where jsonb_typeof(x.value)<>'string') then raise exception 'participants must be a string array' using errcode='22023'; end if;
        select coalesce(array_agg(value),'{}'::text[]) into participants_arr from jsonb_array_elements_text(p_payload->'participants');
      end if;
      update public.journal_entries set
        trip_ref=case when p_payload ? 'trip_ref' then case when jsonb_typeof(p_payload->'trip_ref')='null' then null else nullif(p_payload->>'trip_ref','') end else er.trip_ref end,
        entry_date=case when p_payload ? 'entry_date' then (p_payload->>'entry_date')::date else er.entry_date end,
        timezone=case when p_payload ? 'timezone' then p_payload->>'timezone' else er.timezone end,
        title=case when p_payload ? 'title' then case when jsonb_typeof(p_payload->'title')='null' then null else p_payload->>'title' end else er.title end,
        summary=case when p_payload ? 'summary' then case when jsonb_typeof(p_payload->'summary')='null' then null else p_payload->>'summary' end else er.summary end,
        tags=tags_arr,participants=participants_arr,version=er.version+1,
        updated_by=uid,updated_source=src,updated_at=now()
      where id=er.id and workspace_id=p_workspace_id returning * into er;
      out_operation:='update';
    elsif action='entry.archive' then
      if er.deleted_at is not null then return jsonb_build_object('status','conflict','reason','already_archived','serverVersion',er.version); end if;
      update public.journal_entries set deleted_at=now(),version=er.version+1,updated_by=uid,updated_source=src,updated_at=now()
      where id=er.id and workspace_id=p_workspace_id returning * into er;
      out_operation:='delete';
    else
      if er.deleted_at is null then return jsonb_build_object('status','conflict','reason','not_archived','serverVersion',er.version); end if;
      update public.journal_entries set deleted_at=null,version=er.version+1,updated_by=uid,updated_source=src,updated_at=now()
      where id=er.id and workspace_id=p_workspace_id returning * into er;
      out_operation:='restore';
    end if;
    out_id:=er.id; out_entry_id:=er.id; out_version:=er.version; out_type:='entry'; snap:=to_jsonb(er);

  else
    if p_entry_id is null then raise exception 'entry_id required' using errcode='22023'; end if;
    select * into er from public.journal_entries where id=p_entry_id and workspace_id=p_workspace_id;
    if not found then return jsonb_build_object('status','conflict','reason','entry_missing'); end if;
    if er.deleted_at is not null then return jsonb_build_object('status','conflict','reason','entry_archived'); end if;

    if action='block.create' then
      if p_block_id is not null or p_expected_version is distinct from 0 then raise exception 'invalid block create identity/version' using errcode='22023'; end if;
      if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'payload must be object' using errcode='22023'; end if;
      if p_payload->>'block_type' not in ('text','photo_gallery','place','highlight','expense','child_moment','rating') then raise exception 'invalid block_type' using errcode='22023'; end if;
      so:=coalesce((p_payload->>'sort_order')::integer,1000); if so<0 then raise exception 'invalid sort_order' using errcode='22023'; end if;
      if not (p_payload ? 'content') or jsonb_typeof(p_payload->'content')<>'object' then raise exception 'content must be object' using errcode='22023'; end if;
      insert into public.journal_blocks(workspace_id,entry_id,block_type,sort_order,content,version,created_by,updated_by,created_source,updated_source)
      values(p_workspace_id,p_entry_id,p_payload->>'block_type',so,p_payload->'content',1,uid,uid,src,src) returning * into br;
      base_version:=0; out_operation:='create';
    else
      if p_block_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'block_id/expected_version required' using errcode='22023'; end if;
      select * into br from public.journal_blocks where id=p_block_id and entry_id=p_entry_id and workspace_id=p_workspace_id for update;
      if not found then return jsonb_build_object('status','conflict','reason','block_missing'); end if;
      select * into prior from public.journal_revisions where workspace_id=p_workspace_id and mutation_id=p_mutation_id;
      if found then
        if prior.actor_id is distinct from uid then return jsonb_build_object('status','conflict','reason','mutation_id_reused'); end if;
        return jsonb_build_object('status','replayed','targetType',prior.target_type,'targetId',prior.target_id,'version',prior.result_version,'operation',prior.operation);
      end if;
      if br.version<>p_expected_version then return jsonb_build_object('status','conflict','reason','version_mismatch','serverVersion',br.version); end if;
      base_version:=br.version;
      if action='block.update' then
        if br.deleted_at is not null then return jsonb_build_object('status','conflict','reason','block_deleted','serverVersion',br.version); end if;
        if p_payload is null or not (p_payload ? 'content') or jsonb_typeof(p_payload->'content')<>'object' then raise exception 'content must be object' using errcode='22023'; end if;
        so:=case when p_payload ? 'sort_order' and jsonb_typeof(p_payload->'sort_order')<>'null' then (p_payload->>'sort_order')::integer else br.sort_order end;
        if so<0 then raise exception 'invalid sort_order' using errcode='22023'; end if;
        update public.journal_blocks set content=p_payload->'content',sort_order=so,version=br.version+1,updated_by=uid,updated_source=src,updated_at=now()
        where id=br.id and entry_id=p_entry_id and workspace_id=p_workspace_id returning * into br;
        out_operation:='update';
      elsif action='block.reorder' then
        so:=(p_payload->>'sort_order')::integer; if so is null or so<0 then raise exception 'invalid sort_order' using errcode='22023'; end if;
        if br.deleted_at is not null then return jsonb_build_object('status','conflict','reason','block_deleted','serverVersion',br.version); end if;
        update public.journal_blocks set sort_order=so,version=br.version+1,updated_by=uid,updated_source=src,updated_at=now()
        where id=br.id and entry_id=p_entry_id and workspace_id=p_workspace_id returning * into br;
        out_operation:='reorder';
      elsif action='block.delete' then
        if br.deleted_at is not null then return jsonb_build_object('status','conflict','reason','already_deleted','serverVersion',br.version); end if;
        update public.journal_blocks set deleted_at=now(),version=br.version+1,updated_by=uid,updated_source=src,updated_at=now()
        where id=br.id and entry_id=p_entry_id and workspace_id=p_workspace_id returning * into br;
        out_operation:='delete';
      else
        if br.deleted_at is null then return jsonb_build_object('status','conflict','reason','not_deleted','serverVersion',br.version); end if;
        update public.journal_blocks set deleted_at=null,version=br.version+1,updated_by=uid,updated_source=src,updated_at=now()
        where id=br.id and entry_id=p_entry_id and workspace_id=p_workspace_id returning * into br;
        out_operation:='restore';
      end if;
    end if;
    out_id:=br.id; out_entry_id:=br.entry_id; out_version:=br.version; out_type:='block'; snap:=to_jsonb(br);
  end if;

  insert into public.journal_revisions(
    workspace_id,entry_id,target_type,target_id,operation,mutation_id,actor_id,actor_source,base_version,result_version,snapshot
  ) values (
    p_workspace_id,out_entry_id,out_type,out_id,out_operation,p_mutation_id,uid,src,base_version,out_version,snap
  );

  return jsonb_build_object(
    'status','applied','targetType',out_type,'targetId',out_id,'version',out_version,'operation',out_operation
  );
exception when unique_violation then
  select * into prior from public.journal_revisions where workspace_id=p_workspace_id and mutation_id=p_mutation_id;
  if found and prior.actor_id is not distinct from uid then
    return jsonb_build_object('status','replayed','targetType',prior.target_type,'targetId',prior.target_id,'version',prior.result_version,'operation',prior.operation);
  end if;
  raise;
end;
$$;

create or replace function public.journal_create(
  p_workspace_id uuid,
  p_entry_date date,
  p_mutation_id uuid,
  p_source text,
  p_timezone text default 'Asia/Taipei',
  p_title text default null,
  p_summary text default null,
  p_tags text[] default '{}'::text[],
  p_participants text[] default '{}'::text[],
  p_trip_ref text default null
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.journal_mutate_impl(
    'entry.create',p_workspace_id,null,null,0,
    jsonb_build_object('entry_date',p_entry_date,'timezone',p_timezone,'title',p_title,'summary',p_summary,'tags',to_jsonb(p_tags),'participants',to_jsonb(p_participants),'trip_ref',p_trip_ref),
    p_source,p_mutation_id
  );
$$;

create or replace function public.journal_update(
  p_workspace_id uuid,p_entry_id uuid,p_expected_version bigint,p_patch jsonb,p_source text,p_mutation_id uuid
)
returns jsonb language sql security invoker set search_path=''
as $$ select private.journal_mutate_impl('entry.update',p_workspace_id,p_entry_id,null,p_expected_version,p_patch,p_source,p_mutation_id); $$;

create or replace function public.journal_archive(
  p_workspace_id uuid,p_entry_id uuid,p_expected_version bigint,p_archived boolean,p_source text,p_mutation_id uuid
)
returns jsonb language sql security invoker set search_path=''
as $$ select private.journal_mutate_impl(case when p_archived then 'entry.archive' else 'entry.restore' end,p_workspace_id,p_entry_id,null,p_expected_version,'{}'::jsonb,p_source,p_mutation_id); $$;

create or replace function public.journal_block_mutate(
  p_workspace_id uuid,p_entry_id uuid,p_operation text,p_mutation_id uuid,p_source text,
  p_block_id uuid default null,p_expected_version bigint default 0,p_block_type text default null,
  p_sort_order integer default null,p_content jsonb default '{}'::jsonb
)
returns jsonb language sql security invoker set search_path=''
as $$
  select private.journal_mutate_impl(
    'block.'||lower(trim(p_operation)),p_workspace_id,p_entry_id,p_block_id,p_expected_version,
    jsonb_build_object('block_type',p_block_type,'sort_order',p_sort_order,'content',p_content),p_source,p_mutation_id
  );
$$;

-- Legacy project default privileges are permissive: explicitly remove public/anon execution.
revoke all on function public.journal_create(uuid,date,uuid,text,text,text,text,text[],text[],text) from public,anon,authenticated;
revoke all on function public.journal_update(uuid,uuid,bigint,jsonb,text,uuid) from public,anon,authenticated;
revoke all on function public.journal_archive(uuid,uuid,bigint,boolean,text,uuid) from public,anon,authenticated;
revoke all on function public.journal_block_mutate(uuid,uuid,text,uuid,text,uuid,bigint,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.journal_create(uuid,date,uuid,text,text,text,text,text[],text[],text) to authenticated;
grant execute on function public.journal_update(uuid,uuid,bigint,jsonb,text,uuid) to authenticated;
grant execute on function public.journal_archive(uuid,uuid,bigint,boolean,text,uuid) to authenticated;
grant execute on function public.journal_block_mutate(uuid,uuid,text,uuid,text,uuid,bigint,text,integer,jsonb) to authenticated;

-- The implementation is private/non-exposed. Authenticated needs EXECUTE because wrappers are SECURITY INVOKER.
revoke all on function private.journal_mutate_impl(text,uuid,uuid,uuid,bigint,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function private.journal_mutate_impl(text,uuid,uuid,uuid,bigint,jsonb,text,uuid) to authenticated;

-- Defense in depth: browser roles remain SELECT-only on Journal tables.
revoke insert,update,delete,truncate on public.journal_entries from anon,authenticated;
revoke insert,update,delete,truncate on public.journal_blocks from anon,authenticated;
revoke insert,update,delete,truncate on public.journal_media from anon,authenticated;
revoke insert,update,delete,truncate on public.journal_revisions from anon,authenticated;

commit;
