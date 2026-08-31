# Family Trip Companion

Family Trip Companion PWA (baseline: V4.4 TEST3.4).

## Current architecture

- Static PWA: `public/`
- IndexedDB offline cache: `public/db.js`
- Netlify Functions: `netlify/functions/`
- Deployment configuration: `netlify.toml`
- Cloud Sync foundation migration: `supabase/migrations/`

## V4.5 Phase 1 goals

1. GitHub → Netlify continuous deployment.
2. Keep one permanent Netlify site and one-time environment configuration.
3. Add Supabase Auth/Database foundation for multi-device sync without removing IndexedDB offline support.
4. Preserve one-click acceptance testing.

See `docs/DEPLOYMENT.md`.

## V4.5 Phase 1 status
Cloud Sync database foundation is deployed to Supabase and read-back verified. The browser adapter is included but remains dormant until Google OAuth and the fixed Netlify deployment are configured. Existing IndexedDB behavior is unchanged.
