-- J1B follow-up: remove legacy default privileges not needed by the journal server role.
revoke all on public.journal_entries from service_role;
revoke all on public.journal_blocks from service_role;
revoke all on public.journal_media from service_role;
revoke all on public.journal_revisions from service_role;

grant select, insert, update, delete on public.journal_entries to service_role;
grant select, insert, update, delete on public.journal_blocks to service_role;
grant select, insert, update, delete on public.journal_media to service_role;
grant select, insert, update, delete on public.journal_revisions to service_role;
