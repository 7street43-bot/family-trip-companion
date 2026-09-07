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

## ChatGPT Project activation boundary (2026-09-07)

The backend is ready for user-scoped AI writes, but a Plus account cannot currently attach a private full-MCP app with write/modify actions directly to a Project. Do not work around this by storing a Supabase JWT or service-role key in Project instructions.

When account-side write-capable custom apps are available, use a remote MCP app with Supabase OAuth 2.1/OIDC. Supabase Auth can act as an OAuth 2.1 authorization server and issue normal user JWTs, so existing Journal RLS and workspace membership rules remain authoritative.

## Future activation sequence

1. Enable Supabase OAuth 2.1 Server.
2. Configure the production authorization path (planned: `/oauth/consent`).
3. Register the ChatGPT/MCP client or enable MCP dynamic client registration where appropriate.
4. Use asymmetric JWT signing (RS256/ES256) before requesting OIDC `openid` ID tokens.
5. Remote MCP tools call the Journal gateway using the user's OAuth access token; never use service role.
6. Keep write actions confirmation-aware and preserve `mutationId` idempotency.
7. Test create/read/update/conflict/replay on a non-production workspace before enabling daily use.

References:
- Supabase OAuth 2.1 Server: https://supabase.com/docs/guides/auth/oauth-server
- Supabase MCP Authentication: https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- OpenAI custom MCP apps / developer mode: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta
