# Deployment baseline — V4.5 Phase 1

## Target architecture

- One permanent GitHub repository.
- One permanent Netlify site connected to the repository.
- Production branch: `main`.
- Netlify publish directory: `public`.
- Netlify Functions directory: `netlify/functions`.
- Environment variables are configured once on the permanent Netlify site.

## Fixed production site

- Netlify account: `kumohsun11@gmail.com`
- Production Site URL: `https://comfy-heliotrope-475c71.netlify.app`
- Do not use the older `peppy-dodol-f0e1ce.netlify.app` origin for OAuth or production sync.

## Netlify environment variables

- `GOOGLE_PLACES_API_KEY` — secret, server-side Functions.
- `SUPABASE_URL` — public runtime configuration.
- `SUPABASE_PUBLISHABLE_KEY` — public client key; never use a service-role key in the browser.
- `APP_SITE_URL` — set exactly to `https://comfy-heliotrope-475c71.netlify.app`.

## Release workflow

1. Change code on a feature branch.
2. Run local/predeploy QA.
3. Merge to `main` only after PASS.
4. Netlify deploys automatically from GitHub.
5. On iPhone: Settings → `執行 V4.4/V4.5 完整自動驗收`.
6. `AUTO GATE PASS` is required before considering the release accepted.
7. Persistence / device-interaction gates remain real-device gates.

## Important

Never commit API secrets. `.env*` is ignored except `.env.example`.
