-- J1B follow-up: covering indexes for foreign-key maintenance and advisor hygiene.
create index journal_entries_created_by_idx on public.journal_entries (created_by) where created_by is not null;
create index journal_entries_updated_by_idx on public.journal_entries (updated_by) where updated_by is not null;

create index journal_blocks_entry_workspace_fk_idx on public.journal_blocks (entry_id, workspace_id);
create index journal_blocks_created_by_idx on public.journal_blocks (created_by) where created_by is not null;
create index journal_blocks_updated_by_idx on public.journal_blocks (updated_by) where updated_by is not null;

create index journal_media_entry_workspace_fk_idx on public.journal_media (entry_id, workspace_id);
create index journal_media_block_entry_workspace_fk_idx on public.journal_media (block_id, entry_id, workspace_id) where block_id is not null;
create index journal_media_created_by_idx on public.journal_media (created_by) where created_by is not null;
create index journal_media_updated_by_idx on public.journal_media (updated_by) where updated_by is not null;

create index journal_revisions_actor_id_idx on public.journal_revisions (actor_id) where actor_id is not null;
