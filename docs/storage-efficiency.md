# Storage Efficiency: D1 (Top) + RepoDO (Per-Repo SQLite)

This document summarizes how metadata is stored across the Cloudflare D1 “top” database and per‑repo Durable Objects (DOs), what is written/read per operation, and an estimate of billed rows and stored bytes for importing a large repository such as `filecoin-project/lotus`.

## Schema split

- Top D1 (`scionhub-top`)
  - `users(id, name, password_hash, admin, created_at)`
  - `tokens(id, user_id, token_hash, created_at, revoked)`
  - `orgs(id, created_at)` — added in 0002
  - `memberships(org_id, user_id, role, can_write, created_at)` — added in 0002
  - Registry (POC continuity): `repos(id, name, visibility, created_at)`
  - Providers/datasets (POC): `providers`, `datasets`
  - Piece tracking and mapping:
    - `pieces(piece_cid, dataset_id, size_bytes, provider_id, status, created_at)`
    - `object_locations(object_id, piece_cid, offset, length, provider_id, created_at)`
    - `uploads(id, piece_cid, source, state, error, created_at)`
  - Durable staging (pending pack/flush):
    - `staging_meta(object_id, total_length, created_at)`
    - `staging_objects(object_id, chunk_index, bytes, created_at)` (64 KiB chunks)

- Per‑repo Durable Object (RepoDO, SQLite)
  - `refs(name PRIMARY KEY, target, version, updated_at)`
  - `changesets(id PRIMARY KEY, lsn, root_tree, body(JSON), created_at)`

Blob bytes are never stored in RepoDO or top D1. They are kept transiently in D1 staging during packing, then uploaded to the storage provider (PDP/SP), and the (object_id → piece, offset, length) mapping is recorded in `object_locations`.

## Operations and their read/write profiles

- Import (initial push)
  1) Client batches blobs into 64 MiB frame streams (≤100 MB Worker limit).
  2) Server writes each unique blob to in‑memory repo, then:
     - Top D1 staging: one `staging_meta` row per blob, plus ~⌈size/64 KiB⌉ `staging_objects` rows (and as many bytes) to allow durable retries.
  3) Packer flush:
     - Compute PieceCID over a concatenation buffer (size threshold 1 MiB).
     - Create or upsert one `pieces` row (idempotent).
     - Insert one `uploads` row (state tracking).
     - For every object in the pack, insert one `object_locations` row with (offset,length).
     - Upload piece bytes to PDP/SP, wait for “parked”, call create‑and‑add pieces.
     - On success, delete corresponding `staging_meta`/`staging_objects` rows.
  4) Changeset + ref:
     - RepoDO: 1 `changesets` row per commit; 1 `refs` write per moved ref.

- Clone
  - Read `refs` (RepoDO), read one `changesets` row, then locate blobs:
    - One `SELECT … WHERE object_id IN (…)` against `object_locations` joined with `pieces`/`providers`.
  - Client fetches piece ranges via HTTP Range; falls back to `/v1/objects` only for missing mappings.

## Estimated counts for a large import (lotus)

Assumptions (order‑of‑magnitude):
- ~60 k commits (changesets), ~200 k unique blobs (post‑dedup across the tree).
- Mean blob size ~8 KiB (many small files); total blob bytes ~1.6 GiB.
- Packer threshold 1 MiB → ~1.6 GiB / 1 MiB ≈ 1 600 pieces.

Writes:
- RepoDO:
  - `changesets`: ~60 k rows
  - `refs`: O(branches×updates), typically hundreds to thousands
- Top D1:
  - `staging_meta`: 200 k rows (transient)
  - `staging_objects`: ~200 k × (8 KiB / 64 KiB) ≈ 25 k rows (transient) plus stored bytes equal to blob bytes (freed after park/add)
  - `pieces`: ~1 600 rows
  - `uploads`: ~1 600 rows
  - `object_locations`: 200 k rows

Reads (clone main):
- RepoDO: `refs` (1), `changesets` (1)
- Top D1: `locate` query touching `object_locations` (+`pieces`/`providers`) once per fetch batch; billed as rows read equal to number of located objects.

## Efficiency notes and cheap fixes

- Batching
  - Client upload frames are capped at 64 MiB to stay under Worker limits and bound container memory during decode.
  - Locate uses a single `IN (…)` query per batch to avoid N+1.
- Transactions
  - D1 does not expose explicit multi‑statement transactions in Workers; where possible, we use `INSERT OR IGNORE/REPLACE` and minimize round‑trips.
- Avoid duplicate storage
  - Blob bytes are not persisted in RepoDO or top D1 (beyond transient staging); only mappings are kept.
- Indices
  - Indices exist on `pieces(dataset_id)`, `uploads(piece_cid)`, `object_locations(piece_cid/provider_id)`, and staging timestamps to keep scans bounded.

## What you need to deploy

1) Apply migrations on the top D1 database:
   - Local: `npm run migrate:local` (from `apps/worker/`)
   - Remote: `npm run migrate:remote`
   This seeds the `filecoin-project` org and adds owner membership for `andy` (id `0ae8965c-8dad-4b1b-a2ea-87d106161ee0`).

2) Ensure `INTERNAL_SECRET` is set and only sent via the `x-internal-secret` header by the Worker on internal calls.

3) Provide PDP secrets (for live flows):
   - `PDP_BASE_URL=https://team-server.curiostorage.org`
   - `PDP_CHAIN_ID=314159`
   - `PDP_SERVICE_CONTRACT=0x02925630df557F957f70E112bA06e50965417CA0`
   - `PDP_PAYER=0x2d633437f7E2138B400AF6882bee2d79C81CF401`
   - `PDP_PRIVATE_KEY` as a secret (wrangler).

