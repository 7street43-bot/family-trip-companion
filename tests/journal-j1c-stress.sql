\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('11111111-1111-1111-1111-111111111111'),
 ('22222222-2222-2222-2222-222222222222');
insert into public.family_workspaces(id,name,created_by) values
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Test Family','11111111-1111-1111-1111-111111111111');
insert into public.family_workspace_members(workspace_id,user_id,role) values
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','owner');

-- Public Journal RPCs must never be SECURITY DEFINER.
do $$
begin
  if exists(
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'journal_%' and p.prosecdef
  ) then raise exception 'public journal SECURITY DEFINER detected'; end if;
end$$;

-- anon cannot call mutation RPCs.
set role anon;
do $$
begin
  begin
    perform public.journal_create('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-09-07','90000000-0000-0000-0000-000000000001','mobile');
    raise exception 'anon unexpectedly executed journal_create';
  exception when insufficient_privilege then null; end;
end$$;
reset role;

-- authenticated member can use RPC but cannot directly write tables.
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
do $$
begin
  begin
    insert into public.journal_entries(workspace_id,entry_date,created_source,updated_source)
    values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-09-07','mobile','mobile');
    raise exception 'direct insert unexpectedly allowed';
  exception when insufficient_privilege then null; end;
end$$;

select (public.journal_create(
 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-09-07','10000000-0000-0000-0000-000000000001','mobile',
 'Asia/Taipei','First day','hello',array['family'],array['twin'],'trip-1'
)->>'targetId')::uuid as entry_id \gset
select set_config('test.entry_id', :'entry_id', false);

do $$
begin
  if (select count(*) from public.journal_entries where id=current_setting('test.entry_id')::uuid)<>1 then raise exception 'entry create missing'; end if;
  if (select version from public.journal_entries where id=current_setting('test.entry_id')::uuid)<>1 then raise exception 'entry version != 1'; end if;
  if (select count(*) from public.journal_revisions where target_id=current_setting('test.entry_id')::uuid)<>1 then raise exception 'create revision missing'; end if;
end$$;

-- Same mutation id must replay without a second row/revision.
select public.journal_create(
 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-09-07','10000000-0000-0000-0000-000000000001','mobile',
 'Asia/Taipei','ignored',null,'{}','{}',null
) as replay_result \gset
select case when (:'replay_result'::jsonb->>'status')='replayed' then 1 else 1/0 end;
do $$ begin
 if (select count(*) from public.journal_revisions where mutation_id='10000000-0000-0000-0000-000000000001')<>1 then raise exception 'duplicate mutation added revision'; end if;
end$$;

-- Valid update applies once; stale update must conflict and not create a revision.
select public.journal_update(
 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id',1,
 '{"title":"Updated","tags":["family","zoo"]}'::jsonb,'desktop','10000000-0000-0000-0000-000000000002'
) as update_result \gset
select case when (:'update_result'::jsonb->>'status')='applied' then 1 else 1/0 end;
select public.journal_update(
 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id',1,
 '{"title":"STALE"}'::jsonb,'desktop','10000000-0000-0000-0000-000000000003'
) as stale_result \gset
select case when (:'stale_result'::jsonb->>'reason')='version_mismatch' then 1 else 1/0 end;
do $$
begin
  if (select title from public.journal_entries where id=current_setting('test.entry_id')::uuid)<>'Updated' then raise exception 'stale write changed row'; end if;
  if exists(select 1 from public.journal_revisions where mutation_id='10000000-0000-0000-0000-000000000003') then raise exception 'conflict created revision'; end if;
end$$;

-- Forbidden system fields cannot be patched.
do $$
begin
  begin
    perform public.journal_update(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',current_setting('test.entry_id')::uuid,2,
      '{"version":999}'::jsonb,'mobile','10000000-0000-0000-0000-000000000004'
    );
    raise exception 'forbidden patch accepted';
  exception when sqlstate '22023' then null; end;
end$$;

-- Block lifecycle: create/update/reorder/delete/restore.
select (public.journal_block_mutate(
 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id','create','20000000-0000-0000-0000-000000000001','mobile',
 null,0,'text',100,'{"text":"hello"}'::jsonb
)->>'targetId')::uuid as block_id \gset
select set_config('test.block_id', :'block_id', false);
select public.journal_block_mutate('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id','update','20000000-0000-0000-0000-000000000002','gpt',:'block_id',1,null,100,'{"text":"updated"}') as b1 \gset
select public.journal_block_mutate('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id','reorder','20000000-0000-0000-0000-000000000003','desktop',:'block_id',2,null,10,'{}') as b2 \gset
select public.journal_block_mutate('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id','delete','20000000-0000-0000-0000-000000000004','mobile',:'block_id',3,null,null,'{}') as b3 \gset
select public.journal_block_mutate('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id','restore','20000000-0000-0000-0000-000000000005','mobile',:'block_id',4,null,null,'{}') as b4 \gset

do $$
begin
  if (select version from public.journal_blocks where id=current_setting('test.block_id')::uuid)<>5 then raise exception 'block lifecycle version mismatch'; end if;
  if (select deleted_at from public.journal_blocks where id=current_setting('test.block_id')::uuid) is not null then raise exception 'block restore failed'; end if;
  if (select count(*) from public.journal_revisions where target_id=current_setting('test.block_id')::uuid)<>5 then raise exception 'block revision count mismatch'; end if;
end$$;

-- Entry archive and restore are soft operations with versions/revisions.
select public.journal_archive('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id',2,true,'mobile','30000000-0000-0000-0000-000000000001') as a1 \gset
select public.journal_archive('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',:'entry_id',3,false,'mobile','30000000-0000-0000-0000-000000000002') as a2 \gset

do $$
begin
  if (select version from public.journal_entries where id=current_setting('test.entry_id')::uuid)<>4 then raise exception 'entry archive/restore version mismatch'; end if;
  if (select deleted_at from public.journal_entries where id=current_setting('test.entry_id')::uuid) is not null then raise exception 'entry restore failed'; end if;
end$$;

-- Outsider must be rejected.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
do $$
begin
  begin
    perform public.journal_create('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-09-08','90000000-0000-0000-0000-000000000002','mobile');
    raise exception 'outsider unexpectedly created journal';
  exception when others then if sqlerrm<>'workspace access denied' then raise; end if; end;
end$$;

-- Cross-actor reuse of another member's mutation_id is a conflict, not a replay.
reset role;
insert into public.family_workspace_members(workspace_id,user_id,role) values
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222','member');
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
select public.journal_create(
 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-09-08','10000000-0000-0000-0000-000000000001','mobile'
) as cross_actor_result \gset
select case when (:'cross_actor_result'::jsonb->>'reason')='mutation_id_reused' then 1 else 1/0 end;

reset role;
-- Final ACL/RLS invariants.
do $$
begin
  if exists(select 1 from information_schema.role_table_grants where table_schema='public' and table_name like 'journal_%' and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')) then raise exception 'authenticated direct write grant exists'; end if;
  if exists(select 1 from pg_policies where schemaname='public' and tablename like 'journal_%' and cmd<>'SELECT') then raise exception 'journal write policy exists'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'journal_%' and p.prosecdef) then raise exception 'public SECURITY DEFINER exists'; end if;
  if exists(select 1 from information_schema.routine_privileges where routine_schema='public' and routine_name like 'journal_%' and grantee in ('PUBLIC','anon') and privilege_type='EXECUTE') then raise exception 'anon/public RPC execute exists'; end if;
end$$;

\echo 'J1C CONTRACT TESTS = PASS'
