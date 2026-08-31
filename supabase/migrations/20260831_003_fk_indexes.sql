create index if not exists family_workspace_members_user_idx on public.family_workspace_members (user_id);
create index if not exists family_sync_records_updated_by_idx on public.family_sync_records (updated_by);
