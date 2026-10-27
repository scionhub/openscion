# SQLite storage efficiency: pieceCID once, cheap latest tree

Answers two questions Andy asked of ScionBase SQLite (engine file +
per-repo Durable Object + D1 accounting). Companion billing notes live
in [`storage-efficiency.md`](storage-efficiency.md).

**Verdict**

| Hope | Today |
| --- | --- |
| Every pieceCID is stored **exactly once** | **No.** D1 keys a piece once; RepoDO maps and every changeset's `pcid:` metadata copy the same identity again. |
| A branch's latest **tree** is O(1) | **Partial.** The tree *id* is a ref pointer (now denormalized onto `refs.root_tree`). Hydrate and the Worker browse fallback still walk the log to rebuild contents. |

This change adds the missing tip pointer and a write-path "one location
per member pieceCID" rule. It does not redesign multi-engine concurrency
or the PDP pipeline.

## Where pieceCIDs live

There is no single content-addressed `pieces` table that every plane
joins. The same CID string appears in several stores:

### 1. D1 accounting (unique per database)

Top and orgs D1 both use `piece_cid TEXT PRIMARY KEY`:

```text
apps/worker/migrations/top/0001_init.sql   pieces(piece_cid PRIMARY KEY, dataset_id, …)
apps/worker/migrations/orgs/0001_init.sql  pieces(piece_cid PRIMARY KEY, …, org)
```

That is "once" **inside that D1**. The same CID can still exist in both
databases (top leftover + orgs), in `uploads.piece_cid` (many rows per
CID), and in `piece_removals` / `bundle_refs`.

### 2. RepoDO map (unique per bundle, not per CID)

Per-repo Durable Object SQLite (`apps/worker/src/repo.ts`):

| Table | Key | What `piece_cid` means |
| --- | --- | --- |
| `bundles` | `piece_cid PRIMARY KEY` | Aggregate / bundle CID. Unique per repo. |
| `bundle_members` | `(bundle_piece_cid, piece_cid)` | Sub-piece location. Same CID could sit in two bundles. |
| `pending_adds` | `bundle_piece_cid PRIMARY KEY` | JSON `sub_pieces` copies member CIDs until drain. |

`GET …/bundles/find` already assumed one location (`WHERE piece_cid = ?
LIMIT 1`). The primary key did not enforce that. This change deletes any
other bundle's row before upsert and tries
`idx_bundle_member_piece_unique`.

### 3. Changeset metadata (copied on every commit) — the large leak

`scn commit` builds a **full snapshot** of `pcid:<path> → CID` and
stores it in `changesets.body`:

```text
crates/openscion/src/commands/mod.rs  merge_pcid_metadata
```

Unchanged paths **copy** the parent's CID string into the new changeset.
A 200k-file repo therefore writes ~200k CID strings into JSON on every
commit, then persists that blob in RepoDO `changesets.body` and, when
`--db` is set, in engine `changesets.body`. That is the opposite of
"expressed exactly once."

It is deliberate for cloneability (`docs/getting-started.md`: unchanged
paths reuse parent `pcid:` metadata so a merged PR is cloneable) — but
it is snapshot-in-the-log, not a content-addressed piece table.

### 4. Engine SQLite has no pieceCID column

`crates/openscion-server/src/storage/sqlite.rs` stores:

- `objects(id PRIMARY KEY, kind, bytes)` — BLAKE3 `ObjectId`, global
  across repos (`INSERT OR IGNORE`). Not a PieceCID.
- `changesets(repo_id, lsn, id, root_tree, body)` — `body` is the JSON
  changeset, including the `pcid:` map when the client sent one.
- `refs(repo_id, name, target, version, root_tree)` — changeset id +
  denormalized tree id. No piece column.

So engine SQLite never had a unique piece table to put a `UNIQUE` on.

## How a branch tip and its tree are resolved

### Intended cheap path (tree **id**)

A ref is a single row: name → changeset id. Each changeset row already
stores `root_tree`. Two primary-key lookups, or one join:

```text
refs.name  →  refs.target (= changeset id)  →  changesets.root_tree
```

This change also writes `refs.root_tree` at `set_ref` / RepoDO `POST
/refs`, and exposes it:

- Engine: `SqliteRepo::load_tip_tree` (PK lookup, no `ORDER BY lsn`).
- RepoDO: `TIP_TREE_SQL` on `GET /refs/:name`.

Warm engine browse is also O(1) in memory: `resolve_rev` →
`Repository::get_ref` (BTreeMap) → `changeset(id)` (HashMap) →
`info.root_tree` (`crates/openscion-server/src/api/browse.rs`,
`crates/openscion-core/src/repo/mod.rs`).

### Paths that still walk

1. **Engine hydrate** loads every changeset in LSN order and replays
   them so the in-memory log exists
   (`repo_manager/mod.rs` `load_changesets` loop;
   `sqlite.rs` `SELECT … ORDER BY lsn ASC`). Cold start is O(history),
   not O(1). After that, tip lookup is cheap.

2. **Worker browse fallback** (engine hairpin failed) fetches **all**
   changesets, then `applyChangesetSnapshot` folds every `lsn <= tip`
   to rebuild the file list (`apps/worker/src/browse.ts`). It uses
   `head.root_tree` only as an id in the JSON; it cannot fetch tree
   objects because RepoDO does not store them (except a small
   `objects` fallback for ≤1 MiB blobs).

3. That snapshot walk is **LSN-linear, not first-parent**. Changesets
   from another branch with a lower LSN are applied. Fine for a
   single-trunk POC; wrong once branches interleave.

`latestPcid` used to scan the whole log even when the tip already held
the full `pcid:` map. It now walks newest-first and returns the first
hit.

## Gaps vs the two hopes

**PieceCID once**

- Missing a global (or per-repo) `pieces(piece_cid PRIMARY KEY)` that
  maps and metadata *reference*.
- `bundle_members` key is `(bundle, piece)`, so the same CID can appear
  twice; `find` hides that with `LIMIT 1`.
- `merge_pcid_metadata` duplicates every live path's CID into each
  changeset. This dominates stored bytes for a large repo.
- D1 `pieces` is unique, but it is accounting, not the storage plane,
  and is duplicated across top/orgs.

**Cheap latest tree**

- Tree **id**: already on `changesets.root_tree`; refs now cache it.
  Use `load_tip_tree` / `TIP_TREE_SQL`. Do not `SELECT * FROM
  changesets ORDER BY lsn` to find `main`.
- Tree **contents** without a warm engine: still a log walk, because
  trees are not in RepoDO.
- Hydrate still replays the full log. A tip pointer does not skip that
  until the engine can lazy-load.

## Recommended fixes (payoff order)

1. **Stop copying the full `pcid:` map into every changeset**
   (highest payoff). Store `path → piece_cid` once (RepoDO table
   keyed by path at the tip, or by `(path, changeset)` with
   copy-on-write). Commits write only changed paths. Clone/browse
   read the tip map. Touches CLI metadata + clone; not done here.

2. **Content-addressed `pieces` / `bundle_members.piece_cid UNIQUE`**
   (this change starts it). One location per member CID; D1 stays
   accounting. Existing DOs with duplicates skip the unique index
   (try/catch); new writes delete the old row.

3. **Use the tip pointer everywhere** (this change adds the column
   and the O(1) query). Next: fallback `GET /refs/:name` (now
   includes `root_tree`) + `GET /changesets/:id` instead of listing
   the log when only the tip row is needed. File listing still needs
   trees or a stored snapshot.

4. **Persist derived trees in RepoDO** (or a tip snapshot table
   `tip_files(path, blob, kind, piece_cid)` updated on commit). Makes
   fallback O(tree) / O(1), and fixes the LSN-vs-first-parent bug.
   Medium design, not a unique-index.

5. **Lazy engine hydrate** — load objects + tip changeset + refs,
   replay the rest on demand. Needed for agent-scale cold start.
   Out of scope here (concurrency / restore semantics).

6. **Drop leftover top-D1 `pieces`** once orgs D1 is the only
   accounting store, so a CID is not registered twice across D1s.

## What this change implements

- Engine `refs.root_tree`, backfill, `set_ref` populate,
  `load_tip_tree`.
- RepoDO `refs.root_tree`, unique LSN index, unique member-piece
  index (best-effort), delete-before-insert on bundle-map writes.
- `latestPcid` newest-first.
- Tests: engine SQLite uniqueness + tip pointer; Worker relocate
  helper + `latestPcid`.
