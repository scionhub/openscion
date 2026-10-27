# Non-Filecoin Worker API CI

HTTP suite that boots the real Worker `fetch` handler plus `openscion-server`
(the same Rust engine production uses for Argon2) and walks every control-plane
route that does **not** need a funded Filecoin write wallet.

ScionBase CI discovers this as `.scm/test-api` (Docker `.scm/testN` contract
from PR #5). The storage-tip worker still scans `.scionbase/ci.yml`; a runner
that understands `.scm/test*` is required for automatic enqueue (merge #5).

## Run locally

From the repository root, with Rust 1.88+ and Node 22+:

```sh
cargo build -p openscion-server
(cd apps/worker && npm install)
(cd tools/api-ci && npm install && npx tsx run.ts)
```

Or point at a binary:

```sh
export OPENSCION_SERVER=./target/release/openscion-server
npx --prefix tools/api-ci tsx tools/api-ci/run.ts
```

Via Docker (same contract the runner uses):

```sh
docker build -f .scm/build/Dockerfile -t scn-need/build .
docker build -f .scm/test-api/Dockerfile -t scn-test/api .
docker run --rm -e CI=1 -e SCN_CI=1 -e SCN_JOB=test-api \
  -e GITHUB_ACTIONS=true -e GITHUB_JOB=test-api \
  -v "$PWD":/workspace:ro -w /workspace scn-test/api
```

Exit 0 on success; non-zero on the first failed assertion group (the process
exits 1 after printing every failure).

## What it hits

Auth/signup/login/`/v1/me`, orgs, repos (username + org), owners (last-owner
409), protected delete of `filecoin-project/curio` and `lotus` (403), settings,
in-memory refs/changesets (tiny blobs, no PDP keys), PRs (edit, comments,
resolve, author-cannot-approve, owner approval, mergeability, close), CI
runner CRUD, `/healthz`, `/pricing`, `/docs`, `/v1/version`.

Ephemeral users (`ciu…` / `civ…`) and throwaway org/repo names. Created repos
are DELETE'd with `{confirm}` at the end. The real Curio/Lotus rows are only
asserted undeletable.

## Curio pieces (no write wallet)

Two hard-coded PieceCID v2 values already in this tree (live changeset GET on
`filecoin-project/curio` returned 400 / `InvalidChange` — known tip issue):

| CID | Source |
| --- | --- |
| `bafkzcibeuc4a2dvtor6eqkb2c6wbs5sxxesah5j76jg74oksxqh3ruhzmstlrcnqhm` | `crates/openscion-server/src/pdp/mod.rs` |
| `bafkzcibdquhar56zu34ur45sr2dw47vzaifuipgtxdsml2awx3lmctcsofjjdhrr` | `apps/worker/src/repo_delete.test.ts` |

The suite registers them via `POST /orgs/{org}/uploads` (mock `queued`),
attaches a bundle-map, deletes the pending-add (admin), calls engine
`add-pieces` / `remove-pieces` with PDP disabled (`mock: true`, no `tx`),
proves `x-scn-force-add-error` / `/v1/admin/test/force-add-error` returns 502
without a wallet, and opens a PR whose metadata swaps A → B.

`PDP_BASE_URL` and `PDP_PRIVATE_KEY` are cleared on the engine. No production
`ADMIN_TOKEN` or human password is used.

## Gaps on this tip

Issues, webhooks, boards, draft/squash/request-changes are not implemented
here (open PRs #3/#4). Those routes are asserted absent. `PATCH /v1/me`
(`tagline`) is implemented; an email-only body is 400 (not a user update).
