\set ON_ERROR_STOP on
create extension if not exists pgcrypto;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth; create schema if not exists private; create schema if not exists storage;
grant usage on schema auth,private,storage to authenticated,service_role;

create table auth.users(id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable set search_path='' as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.family_workspaces(id uuid primary key);
create table public.workspace_members(workspace_id uuid not null,user_id uuid not null,primary key(workspace_id,user_id));
create or replace function private.is_family_workspace_member(p_workspace_id uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=auth.uid())
$$;
revoke all on function private.is_family_workspace_member(uuid) from public,anon;
grant execute on function private.is_family_workspace_member(uuid) to authenticated,service_role;

create table public.journal_entries(id uuid primary key,workspace_id uuid not null,deleted_at timestamptz,unique(id,workspace_id));
create table public.journal_media(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,entry_id uuid not null,block_id uuid,
 storage_path text not null unique,mime_type text not null,width integer,height integer,caption text,taken_at timestamptz,
 sort_order integer not null default 1000,version bigint not null default 1,created_by uuid,updated_by uuid,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz,
 check(width is null or width>0),check(height is null or height>0),check(sort_order>=0),check(version>0),unique(id,entry_id,workspace_id)
);
create table public.journal_revisions(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,entry_id uuid not null,target_type text not null,target_id uuid not null,
 operation text not null,mutation_id uuid not null,actor_id uuid,actor_source text not null,base_version bigint not null,result_version bigint not null,
 snapshot jsonb not null,created_at timestamptz not null default now(),unique(workspace_id,mutation_id)
);
alter table public.journal_media enable row level security;
create policy "journal members can read media metadata" on public.journal_media for select to authenticated using(private.is_family_workspace_member(workspace_id));
grant select on public.journal_media,public.journal_entries to authenticated;

create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null,name text not null,owner_id text,metadata jsonb not null default '{}'::jsonb,unique(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to authenticated;
grant select,insert,update,delete on storage.buckets to service_role;

insert into auth.users values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.family_workspaces values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into public.workspace_members values
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.journal_entries values
 ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',null),
 ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222',null);

\ir ../docs/JOURNAL_J1G_MEDIA_DRAFT.sql

do $$ begin
 if not exists(select 1 from storage.buckets where id='journal-media' and public=false and file_size_limit=26214400) then raise exception 'bucket invariant'; end if;
 if has_table_privilege('authenticated','public.journal_media','INSERT') or has_table_privilege('authenticated','public.journal_media','UPDATE') or has_table_privilege('authenticated','public.journal_media','DELETE') then raise exception 'direct media write grant'; end if;
end $$;

set role authenticated;
set request.jwt.claim.sub='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

do $$ declare r jsonb; begin
 r:=public.journal_media_mutate('reserve','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555',0,
 '{"storage_path":"11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/55555555-5555-4555-8555-555555555555.jpg","mime_type":"image/jpeg","caption":"A","sort_order":10}'::jsonb,'mobile','66666666-6666-4666-8666-666666666666');
 if r->>'status'<>'applied' or r->>'uploadState'<>'pending' then raise exception 'reserve failed %',r; end if;
end $$;

-- Browser direct metadata update must fail by privilege.
do $$ declare denied boolean:=false; begin
 begin update public.journal_media set caption='bypass' where id='55555555-5555-4555-8555-555555555555'; exception when insufficient_privilege then denied:=true; end;
 if not denied then raise exception 'direct metadata update allowed'; end if;
end $$;

-- Unreserved object must fail INSERT RLS.
do $$ declare denied boolean:=false; begin
 begin insert into storage.objects(bucket_id,name,owner_id) values('journal-media','11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/88888888-8888-4888-8888-888888888888/88888888-8888-4888-8888-888888888888.jpg',auth.uid()::text); exception when others then denied:=true; end;
 if not denied then raise exception 'unreserved upload allowed'; end if;
end $$;

insert into storage.objects(bucket_id,name,owner_id,metadata) values('journal-media','11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/55555555-5555-4555-8555-555555555555.jpg',auth.uid()::text,'{"mimetype":"image/jpeg"}');

do $$ declare r jsonb;r2 jsonb;v bigint; begin
 r:=public.journal_media_mutate('finalize','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555',1,'{}','mobile','77777777-7777-4777-8777-777777777777');
 if r->>'status'<>'applied' or r->>'uploadState'<>'ready' or (r->>'version')::bigint<>2 then raise exception 'finalize failed %',r; end if;
 r2:=public.journal_media_mutate('finalize','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555',1,'{}','mobile','77777777-7777-4777-8777-777777777777');
 select version into v from public.journal_media where id='55555555-5555-4555-8555-555555555555';
 if r2->>'status'<>'replayed' or v<>2 then raise exception 'finalize replay failed %, v%',r2,v; end if;
end $$;

do $$ declare n integer; begin select count(*) into n from storage.objects where bucket_id='journal-media'; if n<>1 then raise exception 'member read failed %',n; end if; end $$;

-- Cross workspace reserve must throw.
do $$ declare denied boolean:=false; begin
 begin perform public.journal_media_mutate('reserve','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','99999999-9999-4999-8999-999999999999',0,
 '{"storage_path":"22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444/99999999-9999-4999-8999-999999999999/99999999-9999-4999-8999-999999999999.jpg","mime_type":"image/jpeg"}','mobile','12121212-1212-4212-8212-121212121212'); exception when others then denied:=true; end;
 if not denied then raise exception 'cross workspace reserve allowed'; end if;
end $$;

-- Path filename/media-id mismatch must throw.
do $$ declare denied boolean:=false; begin
 begin perform public.journal_media_mutate('reserve','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','89898989-8989-4989-8989-898989898989',0,
 '{"storage_path":"11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/89898989-8989-4989-8989-898989898989/88888888-8888-4888-8888-888888888888.jpg","mime_type":"image/jpeg"}','mobile','13131313-1313-4313-8313-131313131313'); exception when others then denied:=true; end;
 if not denied then raise exception 'forged path allowed'; end if;
end $$;

-- With no UPDATE/DELETE policy PostgreSQL RLS yields ROW_COUNT=0; object must remain intact.
do $$ declare u integer;d integer;n integer; begin
 update storage.objects set metadata='{}'::jsonb where bucket_id='journal-media'; get diagnostics u=row_count;
 delete from storage.objects where bucket_id='journal-media'; get diagnostics d=row_count;
 select count(*) into n from storage.objects where bucket_id='journal-media';
 if u<>0 or d<>0 or n<>1 then raise exception 'hard write isolation failed update=% delete=% remain=%',u,d,n; end if;
end $$;

set request.jwt.claim.sub='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
do $$ declare n integer; begin select count(*) into n from storage.objects where bucket_id='journal-media'; if n<>0 then raise exception 'cross workspace object leak %',n; end if; end $$;

reset role;
select 'J1G SERIAL STORAGE + METADATA SECURITY V2 = PASS' as result;
