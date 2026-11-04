# Non-Filecoin API CI

Automated HTTP suite for the ScionBase Worker control plane. It does not spend
Filecoin funds and must not run against `api.scionbase.ai`.

## Layout

| Path | Role |
| --- | --- |
| `.scm/build/Dockerfile` | Shared need: `openscion-server` + Node |
| `.scm/test-api/` | ScionBase CI check (`needs: docker:build`) |
| `tools/api-ci/` | Harness + suite (real Worker `fetch` + Rust engine) |

Discovery and env vars follow the Docker test contract in PR #5
(`docs/specs/scionbase-ci.md` on `cursor/docker-test-ci-d956`): `.scm/test*`
folders with a `Dockerfile`, optional `needs` / `timeout` / `labels` / `README`.
The runner mounts the repo read-only at `/workspace` and sets `CI=1` plus
`SCN_*` and GitHub-compatible variables.

This storage tip's worker still queues `.scionbase/ci.yml` jobs. Merge (or
cherry-pick) PR #5 before a ScionBase runner will pick up `.scm/test-api`.

## How it runs

1. Start `openscion-server` with `ADMIN_TOKEN` / `INTERNAL_SECRET` generated
   for the process and **no** `PDP_PRIVATE_KEY` (engine `is_enabled()` is false).
2. Serve the Worker `handle`/`fetch` in Node with in-memory D1 (`node:sqlite`)
   and Durable Object stubs. `ENGINE` proxies to the Rust process, including
   `/__internal/auth/hash` and `/__internal/auth/verify` (Argon2).
3. Exercise signup/login, orgs, repos, owners, protected deletes, settings,
   in-memory refs, pull requests, CI runner CRUD, health/docs/pricing, and
   mock piece add/del/swap.
4. Delete throwaway repos. Never mutate `filecoin-project/curio` or `lotus`.

## Curio pieces

Hard-coded PieceCIDs from committed fixtures (live tree restore on Curio
returned 400). Registration is metadata / mock only. See
[`tools/api-ci/README.md`](../tools/api-ci/README.md).
