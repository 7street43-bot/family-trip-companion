# Journal Security Contract — J1A

Status: DESIGN LOCK / NO PRODUCTION SCHEMA CHANGE

This document defines the security and concurrency contract for the Family Trip Companion travel journal before any Supabase DDL is applied.

## 1. Architecture

One authoritative Journal Core in Supabase, three interfaces:

- Mobile App: fast capture, offline queue, photos, lightweight edits.
- Desktop Web: full editor, batch maintenance, search, organization.
- GPT Project: natural-language create/search/append/update through an allowlisted Journal command interface only.

Supabase is authoritative after Journal Core launches. IndexedDB is an offline cache/operation queue, not an independent source of truth.

## 2. Existing compatibility

The current Cloud Sync foundation already allows `store_name = 'journals'`, but the current IndexedDB schema does not contain a `journals` object store. Therefore the new Journal Core must not assume an existing local journal dataset or overwrite any existing local store.

`family_sync_records` remains backward-compatible infrastructure. New structured journal data will use dedicated Journal Core tables; `family_sync_records/journals` may later be used only as a compatibility/sync envelope if required.

## 3. Proposed Journal Core objects

### journal_entries
One journal entry / day / story container.

Required security fields:
- id uuid (client-generatable)
- workspace_id uuid
- trip_ref text nullable
- entry_date date
- timezone text
- title text nullable
- summary text nullable
- tags text[]
- participants text[]
- version bigint > 0
- created_by uuid
- updated_by uuid
- created_source text
- updated_source text
- created_at timestamptz
- updated_at timestamptz
- deleted_at timestamptz nullable

### journal_blocks
Composable content inside an entry.

Initial block types:
- text
- photo_gallery
- place
- highlight
- expense
- child_moment
- rating

Required fields:
- id uuid
- workspace_id uuid
- entry_id uuid
- block_type text
- sort_order integer
- content jsonb
- version bigint > 0
- created_by / updated_by
- created_source / updated_source
- created_at / updated_at
- deleted_at nullable

Block-level versioning is mandatory so two devices can edit different blocks without causing whole-entry conflicts.

### journal_media
Metadata only. Binary files live in Supabase Storage.

Required fields:
- id uuid
- workspace_id uuid
- entry_id uuid
- block_id uuid nullable
- storage_path text unique
- mime_type text
- width / height nullable
- caption text nullable
- taken_at timestamptz nullable
- sort_order integer
- version bigint > 0
- created_by / updated_by
- created_at / updated_at
- deleted_at nullable

### journal_revisions
Append-only audit/recovery log.

Required fields:
- id bigint/uuid
- workspace_id uuid
- entry_id uuid nullable
- target_type text (`entry`, `block`, `media`)
- target_id uuid
- operation text
- mutation_id uuid
- actor_id uuid
- actor_source text
- base_version bigint
- result_version bigint
- snapshot jsonb
- created_at timestamptz

`(workspace_id, mutation_id)` must be unique for idempotent retries.

## 4. Authorization model

All Journal Core rows belong to a `family_workspaces.id`.

Authenticated access requires membership through the existing private workspace membership helper.

Rules:
- anon: no table access, no journal RPC execute, no Storage access.
- authenticated member: SELECT only through RLS for workspace rows.
- authenticated member: mutation only through hardened Journal RPCs.
- service_role: server/admin use only; never exposed to browser, mobile, desktop, or GPT prompt/context.
- family owner/member initially have the same journal content rights; role-specific restrictions can be added later without changing row ownership.

Direct browser INSERT/UPDATE/DELETE on Journal Core tables is prohibited.

## 5. RPC-only mutation boundary

Journal writes must be performed through small, allowlisted operations, not arbitrary SQL and not a generic unrestricted JSON mutation endpoint.

Planned operations:
- journal_entry_create
- journal_entry_update
- journal_block_create
- journal_block_update
- journal_reorder_blocks
- journal_media_register
- journal_soft_delete
- journal_restore

Every mutation must:
1. require authenticated identity;
2. derive actor identity from the authenticated context, never trust client-passed actor_id;
3. verify workspace membership;
4. validate target row belongs to the same workspace;
5. require `mutation_id`;
6. require `expected_version` for updates/deletes/restores;
7. reject stale writes with a conflict response;
8. write an immutable revision in the same transaction;
9. use `SET search_path = ''` for SECURITY DEFINER functions;
10. expose EXECUTE only to the intended role.

SECURITY DEFINER use must be intentional and individually reviewed. Advisor warnings are not to be suppressed globally.

## 6. Optimistic concurrency contract

No last-write-wins for user-authored journal content.

- Create: client generates UUID; expected_version = 0.
- Update: exact expected_version match required.
- Delete/restore: exact expected_version match required.
- Success: server increments version by exactly 1.
- Conflict: server returns current version and current record state; it never overwrites silently.
- Different blocks may be edited concurrently because blocks have independent versions.
- Same block edited concurrently must surface a conflict for merge/review.

Offline mobile retries use the same mutation_id so a network retry cannot create duplicate revisions or duplicate actions.

## 7. Delete and recovery contract

Client actions use soft delete only (`deleted_at`).

No mobile, desktop, or GPT command may physically DELETE a Journal Core row or Storage object immediately.

Restore clears the tombstone through an expected-version RPC and records a revision.

Physical purge is a future maintenance operation, owner/admin-only, with a retention period and separate explicit approval.

## 8. GPT interface boundary

GPT Project is a user interface, not a database administrator.

GPT must never receive:
- database password;
- service_role / secret key;
- unrestricted SQL mutation capability as the product path;
- credentials copied into prompts or project instructions.

Future GPT integration must expose only journal-specific commands such as:
- journal_create
- journal_append
- journal_update
- journal_search
- journal_archive
- journal_restore

The implementation may use a dedicated authenticated tool/API in J4, but the authorization must resolve to a specific workspace/user and preserve the same version + revision contract as mobile/desktop.

## 9. Mobile / Desktop identity

Mobile and desktop use the same Supabase Auth identity and workspace membership.

The source label (`mobile`, `desktop`) is audit metadata only; it is not an authorization claim.

Authorization never trusts a user-editable source label.

## 10. Storage contract

Bucket name (planned): `journal-media`.

Bucket requirements:
- private only;
- no anonymous read;
- image MIME types only in initial release;
- explicit file-size cap;
- no service key in client;
- Storage operations subject to `storage.objects` RLS.

Stable path format:

`<workspace_id>/<media_id>/<variant>.<ext>`

Examples:
- `<workspace>/<media>/display.webp`
- `<workspace>/<media>/thumb.webp`

The first folder segment is the workspace boundary used by Storage RLS.

A member may only SELECT/INSERT/UPDATE/DELETE objects whose first path segment is a workspace to which `auth.uid()` belongs.

Storage file deletion remains deferred while the related journal media row is soft-deleted, so undo remains possible.

## 11. Data API grants

Every J1B migration must explicitly define grants; never rely on Supabase project default privileges.

For each Journal Core table:
1. create table;
2. enable RLS;
3. revoke all from anon/authenticated;
4. grant only SELECT to authenticated;
5. create workspace membership SELECT policy;
6. perform writes only through allowlisted RPCs.

For functions:
- revoke EXECUTE from PUBLIC and anon;
- grant EXECUTE only to authenticated when the function is a client mutation endpoint;
- internal/private helper functions must not be exposed as general API endpoints.

## 12. Input limits

J1B must add bounded input validation to prevent accidental or abusive oversized payloads.

Initial design limits:
- title: 200 chars
- summary: 5,000 chars
- block JSON payload: bounded and type-validated by RPC
- tags: bounded count + per-tag length
- participants: bounded count + per-value length
- storage MIME/size: bucket-level restriction plus client validation

Exact byte limits will be fixed in J1B after implementation sizing tests.

## 13. Realtime

Realtime is optional for Journal Core v1.

Do not add all journal tables to `supabase_realtime` by default. Start with explicit sync/pull semantics; add Realtime only where it materially improves multi-device editing and after authorization/performance testing.

## 14. Migration / rollout rules

J1B migration must be additive only.

It must not:
- modify or delete existing Cloud Sync rows;
- change existing `family_sync_records` payloads;
- change Auth users;
- change existing Google API/Netlify behavior;
- migrate IndexedDB data automatically;
- enable Production App features before Preview validation.

Rollout order:
1. migration source reviewed on `preview`;
2. SQL reviewed against live J0 baseline;
3. apply schema only after explicit approval;
4. run security + performance advisors;
5. run read-back exact schema/policy/grant verification;
6. only then build mobile/desktop UI on Preview;
7. Production release remains a separate explicit approval.

## 15. J1A acceptance gates

J1A passes only if:
- one authoritative data model is defined;
- mobile/desktop/GPT share the same workspace authorization model;
- direct client writes are prohibited;
- explicit RLS/grants are required;
- version conflict behavior is defined;
- mutation idempotency is defined;
- soft delete + revision recovery are defined;
- private Storage path/RLS boundary is defined;
- GPT cannot become a broad database administrator;
- no Production Supabase schema/data is modified during J1A.
