create index if not exists journal_entries_workspace_trip_ref_date_idx
on public.journal_entries (workspace_id, trip_ref, entry_date desc, updated_at desc)
where trip_ref is not null and deleted_at is null;
