-- J1B DRAFT ONLY — DO NOT APPLY FROM THIS FILE
-- Goal: additive, empty, fail-closed Journal Core schema.
-- No existing Cloud Sync/Auth/Storage data is modified.
-- Authenticated clients receive SELECT only; there are intentionally no journal write RPCs in J1B.

begin;

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.family_workspaces(id) on delete cascade,
  trip_ref text,
  entry_date date not null,
  timezone text not null default 'Asia/Taipei',
  title text,
  summary text,
  tags text[] not null default '{}',
  participants text[] not null default '{}',
  version bigint not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_source text not null default 'system',
  updated_source text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint journal_entries_trip_ref_len check (trip_ref is null or char_length(trip_ref) <= 200),
  constraint journal_entries_timezone_len check (char_length(timezone) between 1 and 100),
  constraint journal_entries_title_len check (title is null or char_length(title) <= 200),
  constraint journal_entries_summary_len check (summary is null or char_length(summary) <= 5000),
  constraint journal_entries_tags_count check (cardinality(tags) <= 50),
  constraint journal_entries_participants_count check (cardinality(participants) <= 20),
  constraint journal_entries_version_positive check (version > 0),
  constraint journal_entries_created_source_valid check (created_source in ('mobile','desktop','gpt','import','system')),
  constraint journal_entries_updated_source_valid check (updated_source in ('mobile','desktop','gpt','import','system')),
  constraint journal_entries_id_workspace_uq unique (id, workspace_id)
);

create table public.journal_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.family_workspaces(id) on delete cascade,
  entry_id uuid not null,
  block_type text not null,
  sort_order integer not null default 1000,
  content jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_source text not null default 'system',
  updated_source text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint journal_blocks_entry_workspace_fk
    foreign key (entry_id, workspace_id)
    references public.journal_entries(id, workspace_id)
    on delete cascade,
  constraint journal_blocks_type_valid check (block_type in ('text','photo_gallery','place','highlight','expense','child_moment','rating')),
  constraint journal_blocks_sort_nonnegative check (sort_order >= 0),
  constraint journal_blocks_version_positive check (version > 0),
  constraint journal_blocks_created_source_valid check (created_source in ('mobile','desktop','gpt','import','system')),
  constraint journal_blocks_updated_source_valid check (updated_source in ('mobile','desktop','gpt','import','system')),
  constraint journal_blocks_id_entry_workspace_uq unique (id, entry_id, workspace_id)
);

create table public.journal_media (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.family_workspaces(id) on delete cascade,
  entry_id uuid not null,
  block_id uuid,
  storage_path text not null unique,
  mime_type text not null,
  width integer,
  height integer,
  caption text,
  taken_at timestamptz,
  sort_order integer not null default 1000,
  version bigint not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint journal_media_entry_workspace_fk
    foreign key (entry_id, workspace_id)
    references public.journal_entries(id, workspace_id)
    on delete cascade,
  constraint journal_media_block_entry_workspace_fk
    foreign key (block_id, entry_id, workspace_id)
    references public.journal_blocks(id, entry_id, workspace_id),
  constraint journal_media_storage_path_len check (char_length(storage_path) between 3 and 1024),
  constraint journal_media_mime_len check (char_length(mime_type) between 3 and 100),
  constraint journal_media_width_valid check (width is null or width > 0),
  constraint journal_media_height_valid check (height is null or height > 0),
  constraint journal_media_caption_len check (caption is null or char_length(caption) <= 1000),
  constraint journal_media_sort_nonnegative check (sort_order >= 0),
  constraint journal_media_version_positive check (version > 0),
  constraint journal_media_id_entry_workspace_uq unique (id, entry_id, workspace_id)
);

create table public.journal_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.family_workspaces(id) on delete cascade,
  entry_id uuid not null,
  target_type text not null,
  target_id uuid not null,
  operation text not null,
  mutation_id uuid not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_source text not null,
  base_version bigint not null,
  result_version bigint not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),

  constraint journal_revisions_target_type_valid check (target_type in ('entry','block','media')),
  constraint journal_revisions_operation_valid check (operation in ('create','update','delete','restore','reorder','register')),
  constraint journal_revisions_actor_source_valid check (actor_source in ('mobile','desktop','gpt','import','system')),
  constraint journal_revisions_versions_valid check (base_version >= 0 and result_version > 0),
  constraint journal_revisions_workspace_mutation_uq unique (workspace_id, mutation_id)
);

create index journal_entries_workspace_date_idx
  on public.journal_entries (workspace_id, entry_date desc, updated_at desc)
  where deleted_at is null;

create index journal_entries_workspace_updated_idx
  on public.journal_entries (workspace_id, updated_at desc);

create index journal_entries_tags_gin_idx
  on public.journal_entries using gin (tags);

create index journal_blocks_entry_sort_idx
  on public.journal_blocks (workspace_id, entry_id, sort_order, created_at)
  where deleted_at is null;

create index journal_media_entry_sort_idx
  on public.journal_media (workspace_id, entry_id, sort_order, created_at)
  where deleted_at is null;

create index journal_media_block_idx
  on public.journal_media (workspace_id, block_id)
  where block_id is not null and deleted_at is null;

create index journal_revisions_target_idx
  on public.journal_revisions (workspace_id, target_type, target_id, created_at desc);

create index journal_revisions_entry_idx
  on public.journal_revisions (workspace_id, entry_id, created_at desc);

alter table public.journal_entries enable row level security;
alter table public.journal_blocks enable row level security;
alter table public.journal_media enable row level security;
alter table public.journal_revisions enable row level security;

create policy "journal members can read entries"
on public.journal_entries
for select to authenticated
using (private.is_family_workspace_member(workspace_id));

create policy "journal members can read blocks"
on public.journal_blocks
for select to authenticated
using (private.is_family_workspace_member(workspace_id));

create policy "journal members can read media metadata"
on public.journal_media
for select to authenticated
using (private.is_family_workspace_member(workspace_id));

create policy "journal members can read revisions"
on public.journal_revisions
for select to authenticated
using (private.is_family_workspace_member(workspace_id));

-- Fail closed. The existing project still has legacy default privileges,
-- so remove browser mutation grants explicitly after object creation.
revoke all on public.journal_entries from anon, authenticated;
revoke all on public.journal_blocks from anon, authenticated;
revoke all on public.journal_media from anon, authenticated;
revoke all on public.journal_revisions from anon, authenticated;

grant select on public.journal_entries to authenticated;
grant select on public.journal_blocks to authenticated;
grant select on public.journal_media to authenticated;
grant select on public.journal_revisions to authenticated;

-- Server/admin access is explicit. service_role remains server-side only.
grant select, insert, update, delete on public.journal_entries to service_role;
grant select, insert, update, delete on public.journal_blocks to service_role;
grant select, insert, update, delete on public.journal_media to service_role;
grant select, insert, update, delete on public.journal_revisions to service_role;

-- No INSERT/UPDATE/DELETE policy is intentionally created in J1B.
-- No journal mutation RPC is intentionally created in J1B.
-- No Storage bucket/policy is created in J1B.
-- No Realtime publication is changed in J1B.

commit;
