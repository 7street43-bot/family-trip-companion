# Preview / Production Safety Gate

## Fixed production baseline
- Production branch: `main`
- Production runtime baseline: `4.5.0-phase1.2`
- Production baseline commit: `b539cd322ae074c47e37228ebc32856322668e10`
- Production site: `https://comfy-heliotrope-475c71.netlify.app`

## Preview branch
- Working branch: `preview`
- `preview` was created as an exact copy of the production baseline above.
- All routine ChatGPT maintenance must target `preview` first.

## Current phase scope
This phase is infrastructure-only. Do not modify:
- Production app behavior or UI on `main`
- `netlify/functions/**`
- `.env*` runtime secrets/configuration
- `supabase/**`
- Google API configuration
- Supabase project configuration/data
- user IndexedDB data

## Release gate
1. Make changes on `preview` only.
2. Run preview/static QA.
3. Verify the preview site, including real-device checks when needed.
4. Do not merge/push to `main` unless the user explicitly authorizes a production release.
5. After production release, run the existing AUTO GATE.
6. If production regression occurs, restore the fixed baseline commit or a later explicitly approved production baseline.

## Rollback refs
- `rollback/v4.5.0-phase1.2`
- `safety-baseline`

Both currently point to the original production baseline commit and must not be used for routine development.
