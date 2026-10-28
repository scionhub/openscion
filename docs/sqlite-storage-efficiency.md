# SQLite storage: one COMMP table, tip file-map

Andy’s cutover: the per-repo Durable Object is the only store that
**remembers** Filecoin piece identity. D1 does not. Blake3 `ObjectId` is
still the VCS id for trees, changesets, and log objects — it is no longer
content identity for Filecoin pieces.

Schema version: `meta.commp_schema = 2`. A live v1 DO is migrated in
place (string columns interned, leftover changeset `pcid:` snapshots
folded into `file_pieces`). Do not silently drop calibnet data.

## RepoDO SQLite (canonical)

One table holds every COMMP PieceCID this repo has used. Every other
COMMP column is an integer FK:

```text
pieces (id INTEGER PK, commp TEXT UNIQUE)   -- the only CID string
bundles (piece_id PK → pieces)              -- aggregate / bundle
bundle_members (bundle_id, piece_id, offset, length, UNIQUE piece_id)
pending_adds (piece_id PK → pieces)         -- on-chain add queue
file_pieces (path PK, piece_id → pieces)    -- tip path → COMMP
```

External APIs still speak COMMP strings (`bafk…`) in URLs and JSON.
Writes intern; reads JOIN.

`objects(id, bytes)` is the small-blob browse fallback keyed by Blake3
`ObjectId`. That is VCS addressing, not Filecoin piece identity.

### What this replaces

| Before | After |
| --- | --- |
| `bundles.piece_cid` / `bundle_members.piece_cid` text | FK to `pieces.id` |
| `pending_adds.bundle_piece_cid` + JSON `sub_pieces` | FK; members come from `bundle_members` |
| Every changeset body `pcid:<path> → CID` snapshot | Tip `file_pieces` (O(changed paths) per commit) |
| D1 `pieces` / `uploads` / `object_locations` | No new writes; leftover rows are not SoT |

`GET/POST /v1/repos/{org}/{repo}/file-map` is the public tip map.
Clone, tree, and blob prefer it. Leftover `pcid:` metadata is a
read-only fallback for pre-cutover changesets.

The tip map is **tip-only**. Historical browse of an old revision after
the cutover will not reconstruct that revision’s COMMP set unless the
old changeset still carries `pcid:` keys. That is the cost of stopping
the snapshot explosion.

## D1

D1 is not a pieceCID store.

- `POST /__internal/d1/{org}/upload` acknowledges and does not insert.
- `POST /__internal/d1/{org}/locate` returns `{ locations: [] }`.
- `POST /orgs/{org}/uploads` still kicks PDP; it does not write
  `pieces` / `uploads` rows.
- `GET /orgs/{org}/pieces/{pieceCid}` echoes the COMMP from the URL.

Kept (not piece identity):

- `bundle_refs` — delete-safety index (which repo used which bundle).
- `piece_removals` — on-chain removal accounting.
- `datasets` / `providers` / `staging_*` — dataset policy and packer
  staging (Blake3 object bytes, not COMMP identity).

Live `pieces` / `uploads` / `object_locations` tables are **not
dropped** so calibnet D1 is not rewritten. They are leftover. Do not
add new writers.

## API / client

Content is COMMP end-to-end:

- Client already requests by PieceCID in the URL
  (`GET .../objects/{pieceCid}`, `POST .../objects/resolve`).
- `scn import` / `scn commit` compute COMMP, write the tip `file-map`,
  and **do not** attach `pcid:` metadata to the changeset.
- `scn clone` reads `GET .../file-map`, then leftover `pcid:`, then
  `POST .../objects` (Blake3 fallback for a local engine without RepoDO).
- Engine tree/blob/compare hairpin to RepoDO `file-map` and fall back
  to `pcid:` for old commits.
- `/v1/objects/locate` is not a Blake3→PieceCID directory. Resolve
  COMMP via RepoDO.

Blake3 remains the engine object id for trees and changesets. It is
not written as Filecoin content identity (`object_locations` is dead).

## Cheap latest tree (unchanged from the pointer work)

`refs.root_tree` plus `TIP_TREE_SQL` still give the tip **tree id** in
one PK lookup. Hydrate and the Worker browse fallback still walk the
log to rebuild **contents**. `file_pieces` makes the tip path→COMMP
map O(1) per path without that walk.

## Deploy notes

1. **Worker** — ship this Worker so `ensureCommpSchema` runs on the
   next RepoDO request. First touch of a live v1 DO migrates it
   (intern CIDs, recreate FK tables, fold tip `pcid:` into
   `file_pieces`, set `meta.commp_schema=2`).
2. **Engine container** — rebuild so packer/upload stop D1 CID writes
   and browse reads the file-map. Old containers keep trying D1
   upload; the Worker no-ops that call, so they are safe but still
   write `pcid:` if an old CLI is used.
3. **CLI** — clients that still send `pcid:` metadata are readable
   (legacy fallback) but new `scn` does not write it. Prefer a CLI
   bump with the Worker deploy.
4. **D1** — no migration to run. Do not `DROP` leftover piece tables
   until an explicit cleanup window.
5. **Breaking** — a clone of a post-cutover repo against a Worker that
   lacks `file-map` will fall back to objects (engine) or miss SP
   Range-GETs. Old CLIs talking to a new Worker still upload bundles;
   they just will not refresh `file_pieces` unless they POST the map.
6. **First-touch + VACUUM** — a normal request runs `ensureCommpSchema`
   before you can read the old size, so first-touch every live repo
   with the admin measure path (same `ADMIN_TOKEN` /
   `x-admin-token` as other `/v1/admin/repos/...` routes):

   `POST /v1/admin/repos/{org}/{repo}/sqlite-migrate`

   That call (1) reads `PRAGMA page_count` / `page_size` /
   `freelist_count` and `meta.commp_schema`, (2) migrates if the
   schema was <2, (3) commits implicit DO writes (`storage.sync` +
   event-loop yield — workerd wraps writes in `BEGIN` until the next
   KJ turn), (4) runs SQLite `VACUUM` outside that transaction, (5)
   reads the same pragmas again. `vacuumed` is true only when a
   reclaim statement succeeded; it is never faked. If `VACUUM` still
   fails (`cannot VACUUM from within a transaction` — the runtime
   `BEGIN`s before every write), the path tries
   `PRAGMA incremental_vacuum` and reports `reclaim`. Production DO
   SQLite also has `auto_vacuum`; the post-commit after-number can
   shrink even when both statements are rejected (`vacuumed: false`
   + `vacuum_error`). List catalog rows (`SELECT id FROM repos` /
   `GET /v1/orgs/{org}/repos`) and POST each.
   `GET /v1/admin/repos/{org}/{repo}/sqlite-stats` is the cheap
   post-check (this GET may migrate via `ensureSchema`).

## Tip writes stay CAS

`POST /refs` and engine `set_ref` remain compare-and-swap (see #21).
The file-map write is a separate POST and is not in that transaction.
A lost file-map update can be rebuilt from the bundle map + a rescan,
or by re-importing changed paths.
