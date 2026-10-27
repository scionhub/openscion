# Concurrency and atomicity audit (live PoC)

Branch tip audited: `cursor/storage-and-multirepo-e719` (`0eb71eb`), plus the
transactional guards in this change. Line numbers in §3 are from that tip
unless marked updated.

## Status (this PR)

| ID | Gap | This PR |
| --- | --- | --- |
| **H1** | RepoDO / SQLite persist last-writer-wins | **Closed** — persist is CAS (`expected` / version predecessor); same target is idempotent; conflict → 409 |
| **H2** | Persist swallowed + hydrate from stale RepoDO after sleep | **Guarded, not redesigned** — see below |
| **H3** | PR merge/close blind `UPDATE` | **Closed** — `WHERE state = 'open'`; 0 rows → 409; close cannot overwrite `merged` |
| **H4** | Multi-process SQLite LSN | **Open** (redesign) |
| **M2** | Merge-gate TOCTOU | **Partial** — gate re-checked immediately before CAS |
| **M3** | Auto-close issues loop | **Partial** — each close is `WHERE state = 'open'` |
| **M4** | Invite accept two writes; last-owner RMW | **Closed** — D1 batch + `WHERE state = 'pending'`; last-owner `COUNT(*)` in the `UPDATE`/`DELETE` |
| **M7** | Blob → map saga | **Open** (pipeline redesign) |
| Other M/L | Fork saga, hydrate-no-op, sessions, … | **Open** as listed in §3 |

Still not atomic: engine CAS and D1/RepoDO persist remain two phases. If the
engine moves `main` and the follow-up D1 `UPDATE` hits 0 rows, the client
gets 409 (no false success). Reverse-CAS / tip repair is **not** in this PR.

### H2 — Andy: stale Durable Object?

**Yes, with a precise split.**

The live tip while the container is warm is **engine RAM**
(`RepoManager` `HashMap` + per-repo `RwLock`). RepoDO is the durable mirror.
D1 did **not** store tips.

Path that rolls the tip back:

1. Engine ref CAS succeeds in RAM (`api/mod.rs` `update_ref`).
2. Worker persist to RepoDO is best-effort — errors are logged and swallowed
   (`apps/worker/src/container.ts`).
3. `EngineContainer.sleepAfter = "30s"` drops the process.
4. Next write hydrates from RepoDO (`fetchRepoSnapshot` →
   `hydrateEngine`). `RepoManager::hydrate` is a **no-op if the repo is
   already loaded**; a cold start loads the snapshot as truth.
5. If step 2 failed, that snapshot is the **previous** tip → rollback.

So H2 is **stale RepoDO (and empty/cold RAM) vs the tip that last succeeded
in engine memory**. It is not “D1 vs DO” unless we record a watermark.

**This PR’s guard (smallest solid fix):**

- After a successful engine ref CAS, write `(org, repo, ref, target, version)`
  to D1 `repo_tips` (watermark of the last engine win).
- Take a short D1 `repo_leases` row around ref persist and PR merge so
  concurrent isolates serialize and re-check before mutating.
- Before hydrate+write (and before merge CAS), if a D1 watermark is **ahead
  of** the RepoDO/engine copy, return **409** `stale repository snapshot`
  instead of transacting on the stale copy.

**Deferred (full H2):** fail the HTTP write when persist throws; drop RAM and
re-hydrate on persist fail; make hydrate replace/CAS-merge; rebuild a missing
changeset from D1 (D1 has no objects). A 409 here can leave the repo
write-blocked until RepoDO is replayed or the watermark is corrected —
safer than a silent rollback.

## Executive answer

**No — not transparently, and not atomically, for many independent engines.**

The live PoC can accept **concurrent clients on one repo** because `/v1`
is pinned to **one** `EngineContainer` (`max_instances = 1`,
`idFromName("filecoin-project")`) and per-repo metadata lives in **one**
`RepoDO`. That is single-writer affinity, not multi-server safety.

In-process ref CAS is real. Persist and PR merge are now **conditional
writes** on the shared stores. They are still not one cross-tier
transaction. A second engine process would still lose updates without
moving CAS into the shared store as the source of truth.

## 1. Process / deployment model

Unchanged: one `EngineContainer`, `max_instances = 1`, in-memory engine,
one `RepoDO` per `org/repo`, two D1s, no KV, no `withSession`,
`blockConcurrencyWhile` unused. See the original write-up on PR #20 for
the full table.

## 2. What IS atomic today

Everything in the original table, plus:

| Operation | Mechanism |
| --- | --- |
| RepoDO ref persist | CAS on `expected` / version predecessor; idempotent same target |
| Dev SQLite `set_ref` | `ON CONFLICT DO UPDATE WHERE` next version or same target |
| PR merge / close | `UPDATE … WHERE state = 'open'`; require `changes = 1` |
| Last org owner | `UPDATE`/`DELETE` with `COUNT(*)` of remaining owners |
| Last repo owner | same pattern on `repo_owners` |
| Invite accept | one `db.batch` (membership + `state = 'pending'` → accepted) |
| Invite cancel/decline | `WHERE state = 'pending'` |
| Issue close / reopen | `WHERE state = 'open'` / `'closed'` |
| Repo write lease | D1 `repo_leases` UPSERT where expired or same holder |
| Tip watermark | D1 `repo_tips`; refuse write when watermark ≻ snapshot |

## 3. Gaps / races

### High

**H1. Closed.** RepoDO POST `/refs` no longer `INSERT OR REPLACE`. Rust
SQLite persist matches. Engine `do_post` now forwards `expected`.

**H2. Guarded.** See Status. Hydrate-no-op and swallowed persist remain.

**H3. Closed** for the D1 row (conditional update). Two-phase
engine-then-D1 remains: CAS can succeed and D1 can still 409.

**H4. Open.** Multi-process SQLite LSN / `INSERT OR IGNORE` by LSN.

### Medium (unchanged unless noted)

**M1.** Commit is still two RPCs (changeset then ref).

**M2.** Partial — mergeGate runs again immediately before CAS. Approvals
can still flip in the last milliseconds.

**M3.** Partial — auto-close uses `WHERE state = 'open'`. Still a loop,
not one statement.

**M4. Closed** for last-owner and invite accept/cancel/decline.

**M5–M13.** Open as in PR #20 (fork saga, two D1s, blob/map pipeline,
pending-adds, authz TOCTOU, signup RMW, stale browse, settings LWW,
allocator fallback).

### Low

**L1–L5.** Open (process caches, board UNIQUE → 500, approval PK,
location REPLACE, webhook `waitUntil`).

## 4–6. Consistency, locks, partial failure

Same as PR #20. Engine HTTP 200 is still returned if Worker persist
throws. `do_post` errors are still ignored. This PR does not fail the
client write on persist failure (that is the rest of H2).

## 7. How far from multi-server safe

Still a single-engine hydrate/persist cache. New: the CAS predicate
exists on RepoDO and optional SQLite, and D1 remembers the last engine
tip. Engine RAM is still truth until sleep. Keep `max_instances = 1`.

## 8. Left for later

- Fail HTTP + drop RAM when persist fails; hydrate must replace on write.
- Reverse-CAS / repair when merge D1 update hits 0 after a ref move.
- Fork object-copy saga; blob → map → pieces.
- D1 Sessions; `Land` retry; `blockConcurrencyWhile`.
- True multi-engine transparency.

## 9. Deploy notes

- **Worker + D1:** ship this Worker and apply
  `apps/worker/migrations/orgs/0017_repo_tips_and_leases.sql` on
  `scionbase-orgs`. Lease/watermark helpers no-op (do not block) if the
  tables are missing.
- **Container rebuild:** needed for Rust SQLite `set_ref` CAS and
  `expected` on engine `do_post`. Production `/v1` uses in-memory engine
  (`OPENSCION_DB` unset); RepoDO CAS is Worker-side and does not need the
  new image. Rebuild when using file SQLite or the hairpin `do_post`.
