# Journal GPT Connector｜J1F → MCP Preview

## Current implemented gateway

- Existing command gateway: `POST /api/journal-gpt`
- New scoped MCP endpoint: `POST /api/journal-mcp`
- OAuth Protected Resource Metadata: `/.well-known/oauth-protected-resource`
- Authorization UI candidate: `/oauth/consent/`
- Authentication: user Supabase access token (`Authorization: Bearer ...`)
- Actor source: server-forced `gpt`
- No service-role credentials
- Mutations preserve idempotency through the existing Journal gateway
- Journal RLS and Family Workspace membership remain authoritative
- Preview backend change policy: explicitly approved; Production remains blocked until all Live gates pass.

## MCP tools

- `family_list_workspaces`
- `journal_list_entries`
- `journal_get_entry`
- `journal_create_entry`
- `journal_update_entry`
- `journal_set_archived`
- `journal_mutate_block`
- `journal_reserve_media`
- `journal_finalize_media`
- `journal_update_media`
- `journal_set_media_archived`

The MCP server does **not** expose generic SQL, Supabase administration, or unrelated application tables.

## Existing Journal command coverage

- `createEntry`
- `updateEntry`
- `archiveEntry`
- `restoreEntry`
- `createBlock`
- `updateBlock`
- `reorderBlock`
- `deleteBlock`
- `restoreBlock`
- `listEntries`
- `getEntry`
- `reserveMedia`
- `finalizeMedia`
- `updateMedia`
- `archiveMedia`
- `restoreMedia`

## Activation gates

The Journal code path is Preview-ready on the dedicated Family Trip Companion Supabase project (`edjnwbticmkajwdqbgjz`). Live activation remains fail-closed until all external gates pass:

1. Email Auth Custom SMTP is configured and Live Email Login passes.
2. Supabase OAuth 2.1 Server is enabled.
3. Authorization Path is exactly `/oauth/consent/` on the fixed Production Site URL.
4. OAuth client registration / dynamic registration is configured according to the consuming MCP host.
5. OAuth access-token validation and Family Workspace RLS are verified with a real non-production user/workspace first.
6. ChatGPT-side user authorization is explicitly enabled for this project.
7. Create/read/update/conflict/replay/media reserve-finalize tests pass before Production promotion.

## Security rules

- Never store a Supabase JWT, refresh token, secret key, or service-role key in ChatGPT Project instructions.
- User authorization must occur through OAuth 2.1 / PKCE and the explicit consent UI.
- MCP calls use the signed-in user's token, so existing RLS applies.
- Write tools remain confirmation-aware through MCP tool annotations and optimistic-lock versions.
- Conflicts fail closed; GPT must not overwrite a newer server version.

## References

- Supabase OAuth 2.1 Server: https://supabase.com/docs/guides/auth/oauth-server
- Supabase MCP Authentication: https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- OpenAI MCP / plugin server guidance: https://developers.openai.com/plugins/build/mcp-server
- OpenAI Developer Mode / MCP availability: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-apps-in-chatgpt-beta

## Dedicated Supabase runtime config

Journal GPT/MCP uses dedicated runtime keys and must not reuse the App-wide Supabase variables:

- `JOURNAL_SUPABASE_URL`
- `JOURNAL_SUPABASE_PUBLISHABLE_KEY`

If these are absent, the Journal backend falls back to the dedicated Family Trip Companion project `edjnwbticmkajwdqbgjz`. This prevents the legacy/central-database `SUPABASE_URL` from silently overriding Journal routing.

## Media contract

GPT can reserve/finalize/update/archive/restore Journal media metadata. It cannot upload image binary through the MCP or `/api/journal-gpt`. The authenticated App/client remains responsible for uploading the actual file to the private `journal-media` bucket, after which GPT may finalize the reserved media record. No service-role credential is exposed.
