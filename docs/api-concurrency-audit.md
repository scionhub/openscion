# Concurrency and atomicity audit (live PoC)

Branch tip audited: `cursor/storage-and-multirepo-e719` (`0eb71eb`).
Scope: Worker + Durable Objects + D1 + EngineContainer + Filecoin/PDP as
**currently wired**. No invented features. Line numbers are from that tip.

## Executive answer

**No — not transparently, and not atomically, for many independent engines.**

The live PoC can accept **concurrent clients on one repo** because `/v1`
is pinned to **one** `EngineContainer` (`max_instances = 1`,
`idFromName("filecoin-project")`) and per-repo metadata lives in **one**
`RepoDO`. That is single-writer affinity, not multi-server safety.

In-process ref CAS is real. Persistence (RepoDO / optional SQLite) is
blind upsert. PR merge, fork, invite-accept, and blob+map writes span
tiers with **no cross-store transaction**. A second engine process would
lose updates.

## 1. Process / deployment model

| Layer | Count / affinity | Shared? | Evidence |
| --- | --- | --- | --- |
| Worker isolates | Many, stateless | Yes (D1 + DO stubs) | `apps/worker/src/index.ts` |
| `EngineContainer` DO | **One** for all `/v1` | Process-local RAM | `index.ts:636–641`, `pulls.ts:48–55` |
| Container | `max_instances = 1`, lite, `sleepAfter = "30s"` | No | `wrangler.toml:5–9`, `container.ts:18–20` |
| Engine SQLite | Unset in image → **in-memory** | No | `Dockerfile:15–16`, `config/mod.rs:29–32` |
| `RepoDO` | One per `org/repo` (`idFromName`) | Yes (DO SQLite) | `repo.ts:1–2`, `restore.ts:65–68` |
| `D1Gateway` | One per org name | Façade over shared D1 | `d1.ts:3–19` |
| D1 `scionhub-top` | One global | Users, tokens, orgs, invites | `wrangler.toml:22–26`, `orgs-db.md` |
| D1 `scionbase-orgs` | One global | Repos, PRs, issues, boards, CI | `wrangler.toml:28–32` |
| Workers KV | **None** | — | no `kv_namespaces` |
| Filecoin/PDP | Shared calibnet SP | Pieces on SP; map in RepoDO | `wrangler.toml:41–45`, `repo.ts:500–517` |

Sticky sessions: **none**. Auth is Bearer → D1 `tokens`
(`authz.ts:59–74`). Routing affinity is **DO `idFromName`**, not cookies.

`OrgRouter` / `CONTAINER_URL` (`router.ts`) is **not** wired from
`index.ts`. Optional `ENGINE.idFromName(org)` (`index.ts:1037–1046`) is
not the `/v1` path.

Engine RAM: `RepoManager.repos: HashMap<(org,repo), Arc<RwLock<Repository>>>`
(`repo_manager/mod.rs:52–55`). Locks are **one process**. After 30s idle
the container sleeps; next start hydrates from RepoDO or starts empty
(`repo_manager/mod.rs:126–132`, `169–172`).

**Unknown:** Cloudflare isolate stickiness; whether DO input-gates fully
serialize after the first `await` (this code never calls
`blockConcurrencyWhile`). D1 replica lag (no `withSession` anywhere).

## 2. What IS atomic today

| Operation | Mechanism | Evidence |
| --- | --- | --- |
| In-memory ref move | Target CAS; mismatch → `RefConflict`, no write | `openscion-core/src/repo/mod.rs:267–280` |
| `UpdateRef` wire type | `expected: Option<ObjectId>` + `new` | `openscion-proto/src/refs/types.rs:31–39` |
| Same-process concurrent refs | Per-repo `RwLock` then CAS | `api/mod.rs:1760–1771` |
| Content-addressed put | `entry(id).or_insert`; corrupt id rejected | `store/mod.rs:43–61` |
| Duplicate identical changeset | Hash id; return existing | `repo/mod.rs:166–172` |
| Object persist (dev SQLite) | `INSERT OR IGNORE` by id | `storage/sqlite.rs:214` |
| PR / issue number | `UPDATE repo_counters SET next = next + 1 … RETURNING` | `issues.ts:127–137`, `orgs/0010_issues_and_counters.sql:4–11` |
| Signup / token uniqueness | `users.name UNIQUE`, `tokens.token_hash UNIQUE` | `top/0001_init.sql:8,17` |
| One pending invite per user | Partial unique index | `top/0010_org_invitations.sql:31` |
| PR approvals (same user) | PK `(org,repo,number,user_id)`; read-then-return | `orgs/0002_pr_review.sql:20–27`, `pulls.ts:811–818` |
| CI job claim | `UPDATE … WHERE id=? AND state='queued'`; require `changes=1` | `ci.ts:488–492` |
| CI stale-run expire | `UPDATE … WHERE id=? AND state='running'` | `ci.ts:406` |
| Board name | `UNIQUE(org, name)` | `orgs/0015_issue_boards.sql:14` |
| Issues / pulls number | `UNIQUE(org, repo, number)` | `orgs/0001_init.sql:36`, `0010_….sql:28` |
| Membership row | `PRIMARY KEY(org_id, user_id)` | `0010_org_invitations.sql:15` |
| Staging chunk batch | `db.batch(stmts)` (one D1, not cross-DB) | `d1.ts:232–257` |
| RepoDO request fan-in | One DO id per repo (platform mailbox) | `repo.ts:1–2` |
| Piece map member upsert | `INSERT OR REPLACE` by `(bundle, piece)` | `repo.ts:140–146` |
| Two lands, one engine | Second `409`; first tip wins | `repo/mod.rs:271–275` + `RwLock` |

Spec: one-record CAS, no two-ref atomic swap
(`docs/specs/openscion-data-model.md:199–205`).
`Land` retry loop is specified (`openscion-api.md:163–177`) and **not**
implemented in the CLI (`crates/openscion/src/commands/commit.rs`:
single `update_ref`).

## 3. Gaps / races

Severity: **high** = lost tip / split-brain; **med** = metadata wrong or
TOCTOU; **low** = clutter / quota / UX.

### High

**H1. RepoDO / SQLite persist is not CAS.** Engine CAS then
`INSERT OR REPLACE` with no `WHERE target = ?`.
`repo.ts:92–97`, `sqlite.rs:298–301`, `api/mod.rs:1772–1781`
(`let _ = do_post`).
Scenario: two engine processes (or persist-after-sleep) both “win”
locally; last REPLACE wins. In-memory `version` is informational only
(`repo/mod.rs:277`).

**H2. Hydrate is no-op if the repo is already loaded.**
`repo_manager/mod.rs:187–195`. Persist errors are logged and swallowed
(`container.ts:103–116`).
Scenario: write succeeds in RAM, RepoDO persist fails; container sleeps
30s (`container.ts:20`); cold start hydrates stale/empty snapshot
(`restore.ts:70–71`, `repo_manager/mod.rs:169–172`) → **tip rollback**.

**H3. PR merge is two-phase, not a transaction.** Engine CAS, then
separate D1 `UPDATE pulls` **without** `AND state = 'open'`
(`pulls.ts:1076–1086`, squash `1062–1069`).
Scenario A: CAS ok, D1 fails → `main` advanced, PR still `open`.
Scenario B: two merges of the same PR; both pass `state === "open"`
(`985`); one CAS wins; both may mark `merged`.
Scenario C: concurrent **close** (`987–993`, no `AND state='open'`)
overwrites `merged` → `closed` (or the reverse).

**H4. N independent `openscion-server` + shared SQLite is unsafe.**
Changesets: `INSERT OR IGNORE` with LSN from `log.len()+1`
(`sqlite.rs:248–252`, `repo/mod.rs:178`). Same LSN, different ids →
second insert silently dropped; memory still holds it.

### Medium

**M1. Commit / push is two RPCs.** `create_changeset` then `update_ref`.
Changeset in log, ref unchanged on CAS fail (spec-ok; no rollback).
Persist of each is best-effort (`api/mod.rs:1515–1526`,
`restore.ts:201–232`).

**M2. Merge gate TOCTOU.** `mergeGate` then compare/squash/CAS
(`pulls.ts:1009–1083`). Approvals, comments, CI, or `protectMain` can
change in between. Gate is not re-checked immediately before CAS.
Squash can take many engine GETs (`1021–1044`).

**M3. Auto-close fixed issues is a loop of single updates**
(`pulls.ts:1101–1121`). Merge can succeed while some issues stay open.

**M4. Invite accept is two D1 writes.** Membership then invite state
(`memberships.ts:187–192`). Crash between: member exists, invite still
`pending` (retry is `INSERT OR IGNORE`). Reverse failure: invite
`accepted`, no row. Last-owner check is read-then-write
(`memberships.ts:21–28, 218–234`) — two demotes can leave **zero**
owners.

**M5. Fork is a saga, not atomic.** Engine `PUT` repo → D1 `repos` →
owner → `forked_from` → best-effort ref copy (`forks.ts:80–131`).
Ref copy does **not** copy changesets/objects; `update_ref` requires the
target in the log (`repo/mod.rs:269`). Copy failure is non-fatal
(`forks.ts:127–129`). Exists-check then insert (`65–70`) races two
forks (UNIQUE `repos.id` saves one). Quota is count-then-create
(`72–78`).

**M6. Repo / org create spans two D1s with no transaction.**
Documented (`orgs-db.md:76–87`). Membership on top can exist without
`ORGS_DB.repos`.

**M7. Blob path: RAM + optional SQLite, then SP upload, then bundle map.**
`api/mod.rs:214–252`, `container.ts:117–120`, `repo.ts:140–148`.
Partial: objects in engine, piece on SP, map missing → browse 404 until
retry. `missing_objects` is a D1 locate+staging snapshot
(`api/mod.rs:498–530`) — two clients can both see missing and both
upload (content-addressed, idempotent).

**M8. Pending add-pieces: map first, dataset add later.** Alarm batches
to the **same** engine (`repo.ts:500–517`). Add can fail; pieces stay
queued with backoff (`541–555`). Reads may work from SP; catalog
`dataset_usage` updates only on success (`525`). Drain vs concurrent
POST `pending_adds` (`271–279`) is same-DO SQLite, not cross-process
CAS.

**M9. Authz is check-then-act.** `authorizeMutation` then handler
(`index.ts:331–335`, `authz.ts:137–202`). Membership/role can change
before the write. Token revoke is D1 `revoked=0` on each request
(`authz.ts:66–68`) — good — but there is no session version.

**M10. Signup rate limit is insert-then-count** (`authz.ts:218–226`).
Burst can exceed 5/IP. User cap is the same pattern (`227–230`);
`UNIQUE(name)` still prevents duplicate users.

**M11. Browse fallbacks can serve stale RepoDO** when the engine is
ahead or down (`index.ts:556–568`, `browse.ts` fallbacks). No
`Cache-Control`; no D1 Sessions API (`withSession` **absent**).
Read-your-writes across Worker isolates is **best-effort**.

**M12. Settings last-write-wins.** Blind `ON CONFLICT DO UPDATE`
(`settings.ts:75–80`). Concurrent `protectMain` / `requiredApprovals`
patches lose one. Merge uses settings from `mergeGate` start, not CAS
time.

**M13. Number allocator fallback is RMW** (`issues.ts:138–142`). Primary
`UPDATE … RETURNING` is atomic; the `catch` path can duplicate numbers
→ later `UNIQUE` 500.

### Low

**L1. Packer status + SP capability caches are `OnceLock<RwLock<…>>`**
(`api/packer.rs:301–304`, `api/mod.rs:1616–1619`). Per process only.

**L2. Board create: exists-check then INSERT** (`boards.ts:251–259`).
`UNIQUE(org,name)` converts the race to 500 unless caught.

**L3. Approval INSERT after SELECT** (`pulls.ts:811–825`). Duplicate
hits PK. Reviews are append-only; merge uses latest per owner
(`pulls.ts:479–490`).

**L4. `D1Gateway` `INSERT OR REPLACE` on `object_locations`**
(`d1.ts:169`) — last location wins for an id (content-addressed, usually
harmless).

**L5. Webhook emit is `waitUntil` after the write** (`pulls.ts:618`,
`1072`). Delivery can drop; not part of the transaction.

## 4. Cross-request consistency

| Path | Consistency | Notes |
| --- | --- | --- |
| Same warm engine | Read-your-writes | In-memory repo |
| Engine sleep / new container | RepoDO snapshot | Persist-fail → stale (H2) |
| Worker GET tree/ref/blob | Engine first, RepoDO fallback | Can hide a live engine error with older DO data |
| D1 catalog | Shared; no sessions | Replica stale reads **unknown** (platform) |
| Piece bytes on SP | Immutable CID | Safe to cache; map is RepoDO |
| Two D1 databases | No join, no XA | `orgs-db.md:14–18` |

## 5. In-memory locks — one process only

| Primitive | Scope | File |
| --- | --- | --- |
| `Arc<RwLock<RepoManager>>` | One server | `api/mod.rs:36–37` |
| `Arc<RwLock<Repository>>` | One loaded repo | `repo_manager/mod.rs:48` |
| `OnceLock` packer / SP cache | One process | `packer.rs:301`, `api/mod.rs:1616` |
| Optional `OPENSCION_DB` | Local file | **not** set in the container image |
| RepoDO SQLite | One DO instance | serializes SQL, not engine CAS |
| `blockConcurrencyWhile` | **unused** | — |

These do **not** protect a second EngineContainer, a second
`openscion-server`, or a Client talking to a different `ENGINE` id.

## 6. Error paths (partial failure)

```text
blob POST  → memory objects → SP piece → RepoDO bundle-map / objects
changeset  → memory log     → (optional sqlite) → RepoDO INSERT OR IGNORE
ref CAS    → memory map     → (optional sqlite REPLACE) → RepoDO REPLACE
PR merge   → engine CAS     → D1 pulls.merged → issue closes (loop)
fork       → engine PUT     → D1 repos → owners → copy refs (no objects)
invite     → membership     → invitation.accepted
```

No step rolls back a later failure. Engine HTTP `200` is returned even
if Worker persist throws (`container.ts:114–116`). Engine `do_post`
errors are ignored (`api/mod.rs:1780`).

## 7. How far from multi-server safe

Checklist vs “N engines, same repo, transparent, atomic interactions”:

- [x] Content-addressed objects (put is idempotent)
- [x] In-process ref CAS + `RefConflict`
- [x] Shared D1 for identity / PRs / issues
- [x] Per-repo durable mirror (RepoDO)
- [x] CI claim uses `WHERE state=`
- [ ] **One authoritative CAS store visible to every engine** (RepoDO/D1
      `UPDATE refs SET … WHERE target = expected`)
- [ ] Hydrate always reconciles; persist failure fails the request
- [ ] Engine is a cache, not the source of truth (today RAM **is** truth
      until sleep)
- [ ] `max_instances > 1` or per-org engines without split-brain
- [ ] PR merge + ref CAS in one atomic saga (`WHERE state='open'`,
      compensate or reconcile)
- [ ] Cross-D1 and invite/fork sagas use `db.batch` / idempotency keys
- [ ] D1 Sessions (or equivalent) for read-your-writes
- [ ] `Land` retry on the client
- [ ] `blockConcurrencyWhile` (or equivalent) around hydrate+write+persist
- [ ] No swallowed persist errors

**Distance:** the PoC is a **single-engine, hydrate/persist cache** in
front of RepoDO + D1. Multi-server safety needs the CAS predicate to
move **into** the shared store and the engine to treat RAM as dirty
cache.

## 8. Recommended fixes (design only)

Ranked by impact. Do not implement here.

1. **RepoDO CAS** — `UPDATE refs SET target=?, version=version+1 WHERE
   name=? AND target=?` (or `version=?`); `changes=0` → 409. Engine
   applies only after DO ack. Makes N engines safe for tips.
2. **Fail the HTTP write if persist fails**; on persist fail, drop the
   in-memory repo (`clear` that key) so the next call re-hydrates.
3. **Hydrate must replace or CAS-merge**, never `return existing`
   (`repo_manager/mod.rs:193–195`) on a write path.
4. **PR merge:** `UPDATE pulls SET state='merged' … WHERE id=? AND
   state='open'`; if 0 rows, leave the ref (or attempt reverse CAS).
   Same `AND state='open'` on close. Re-run `mergeGate` immediately
   before CAS.
5. **Invite accept / last-owner / repo create:** one `db.batch` or a
   single SQL (`UPDATE memberships … WHERE (SELECT COUNT(*) …) > 1`).
6. **D1 Sessions** on Worker catalog reads after writes (read-your-writes).
7. **`blockConcurrencyWhile`** in `EngineContainer.fetch` around
   hydrate → container → persist for the same `org/repo`.
8. **Land retry** in CLI/API (already specified).
9. **Fork:** copy changeset log + objects (or share content-addressed
   store) before publishing refs; do not 201 until copy completes.
10. **Keep `max_instances = 1`** until (1)–(3) land. Raising it first
    creates H1/H2 in production.

## 9. Unknowns

- Cloudflare D1 read-replica delay without Sessions.
- Whether the platform serializes DO `fetch` across `await` points.
- Whether any live deploy uses `ENGINE.idFromName(org)` for real `/v1`
  traffic (code allows it; default path does not).
- Hairpin `WORKER_BASE_URL` reachability from the container (Worker
  hydrate/persist is the intended bypass).
- PDP/SP linearizability (treat pieces as immutable blobs).
