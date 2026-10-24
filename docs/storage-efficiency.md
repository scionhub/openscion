# Storage Efficiency: D1 (Top) + RepoDO (Per-Repo SQLite)

This document summarizes how metadata is stored across the Cloudflare D1 “top” database and per‑repo Durable Objects (DOs), what is written/read per operation, and an estimate of billed rows and stored bytes for importing a large repository such as `filecoin-project/lotus`.

## Schema split (after PieceCID redirect redesign)

- Top D1 (`scionhub-top`)
  - `users(id, name, password_hash, admin, created_at, email)` — `email` added in 0005
  - `tokens(id, user_id, token_hash, created_at, revoked)`
  - `orgs(id, created_at)` — added in 0002
  - `memberships(org_id, user_id, role, can_write, created_at)` — added in 0002
  - `signup_attempts(ip, attempted_at)` — added in 0005
  - `pulls(id, org, repo, number, author_user_id, title, body, head_ref, head_target, base_ref, state, created_at, merged_by, merged_at)` — added in 0005
  - Registry (POC continuity): `repos(id, name, visibility, created_at)`
  - Providers/datasets registry: `providers`, `datasets`
  - Piece accounting (optional): `pieces(piece_cid, dataset_id, size_bytes, provider_id, status, created_at)`, `uploads(id, piece_cid, …)` — no per‑object rows
  - No blob bytes, no `staging_*`, no `object_locations` (dropped in 0004)

- Per‑repo Durable Object (RepoDO, SQLite)
  - `refs(name PRIMARY KEY, target, version, updated_at)`
  - `changesets(id PRIMARY KEY, lsn, root_tree, body(JSON), created_at)`
  - `bundles(piece_cid PRIMARY KEY, created_at)`
  - `bundle_members(bundle_piece_cid, piece_cid, offset, length, created_at, PRIMARY KEY(bundle_piece_cid, piece_cid))`

Blob bytes are never stored in RepoDO or top D1. The server aggregates upload batches in‑memory (bounded), uploads bundles (CAR pieces) directly to the SP, registers sub‑pieces on‑chain, and records the (subPieceCID → bundleCID, offset, length) mapping in the RepoDO.

## Operations and their read/write profiles

- Import (initial push)
  1) Client batches blobs into ≤64 MiB frame streams.
  2) Server writes each unique blob to in‑memory repo and an in‑memory aggregation buffer (≤32–64 MiB per piece).
  3) For each aggregate:
     - Upload bytes directly to SP; wait parked; create‑and‑add with `subPieces`.
     - RepoDO: upsert one `bundles` row and `bundle_members` rows (one per sub‑piece).
  4) Changeset + ref: RepoDO `changesets` + `refs` as before.

- Clone
  - Read `refs` (RepoDO) and one `changesets` row.
  - Object fetch: client calls `GET /v1/repos/{org}/{repo}/objects/{pieceCid}` and follows 302 to SP `/piece/{pieceCid}`.
    - When a provider does not serve sub‑pieces by CID, server resolves `(bundleCid, offset, length)` from RepoDO and proxies a ranged GET (rare fallback).

## Estimated counts for a large import (lotus)

Assumptions (order‑of‑magnitude):
- ~60 k commits (changesets), ~200 k unique blobs (post‑dedup across the tree).
- Mean blob size ~8 KiB (many small files); total blob bytes ~1.6 GiB.
- Packer threshold 1 MiB → ~1.6 GiB / 1 MiB ≈ 1 600 pieces.

Writes:
- RepoDO:
  - `changesets`: ~60 k rows
  - `refs`: O(branches×updates), typically hundreds to thousands
- RepoDO:
  - `bundles`: ~1 600 rows (one per aggregate)
  - `bundle_members`: ~200 k rows (one per object)
- Top D1:
  - `pieces`/`uploads`: O(bundles) if enabled for accounting; otherwise none on the write path
  - No `staging_*`, no `object_locations`

Reads (clone main):
- RepoDO: `refs` (1), `changesets` (1)
- Top D1: `providers` (cached infrequently). No per‑object lookups.

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
   This seeds the `filecoin-project` org and adds owner membership for `andy` (id `0ae8965c-8dad-4b1b-a2ea-87d106161ee0`). It also drops legacy `staging_*` and `object_locations` tables (0004).

2) Ensure `INTERNAL_SECRET` is set and only sent via the `x-internal-secret` header by the Worker on internal calls.

3) Provide PDP secrets (for live flows):
   - `PDP_BASE_URL=https://team-server.curiostorage.org`
   - `PDP_CHAIN_ID=314159`
   - `PDP_SERVICE_CONTRACT=0x02925630df557F957f70E112bA06e50965417CA0`
   - `PDP_PAYER=0x2d633437f7E2138B400AF6882bee2d79C81CF401`
   - `PDP_PRIVATE_KEY` as a secret (wrangler).

