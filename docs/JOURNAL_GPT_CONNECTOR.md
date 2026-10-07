# Journal GPT Connector｜J1F

## Current implemented gateway

- Endpoint: `POST /api/journal-gpt`
- Authentication: user Supabase access token (`Authorization: Bearer ...`)
- Actor source: server-forced `gpt`
- No service-role credentials
- Mutations require a UUID `mutationId` or `Idempotency-Key`
- Commands share the same J1D client contract used by browser clients.

Supported commands:

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

## Current activation boundary (2026-10-07)

The Journal backend is ready for user-scoped GPT reads/writes on the dedicated Family Trip Companion Supabase project. App authentication and the live ChatGPT-side user authorization path are intentionally deferred by project decision, so this connector must remain behind the Auth Live Gate. Never store a Supabase JWT, secret key, or service-role key in Project instructions.

Use user-scoped OAuth/OIDC when the ChatGPT-side connection is activated. Existing Journal RLS and workspace membership rules remain authoritative.

## Future activation sequence

1. Finish the App Auth decision and Live Gate.
2. Configure the user-scoped OAuth/OIDC authorization path for the ChatGPT-side connector.
3. Remote tools call the Journal gateway using the user's access token; never use service role.
4. Keep write actions confirmation-aware and preserve `mutationId` idempotency.
5. Test create/read/update/conflict/replay/media reserve-finalize on a non-production workspace before enabling daily use.

References:
- Supabase OAuth 2.1 Server: https://supabase.com/docs/guides/auth/oauth-server
- Supabase MCP Authentication: https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- OpenAI custom MCP apps / developer mode: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta


## Media safety contract

GPT may reserve/finalize/update/archive/restore Journal media metadata, but it cannot directly upload binary files through `/api/journal-gpt`. Binary upload remains on the authenticated App/client path to the private `journal-media` bucket. This preserves the existing RLS path and prevents privileged Storage credentials from entering the GPT gateway.
