# Getting Started

Commands and usage for the ScionBase proof of concept. The CLI binary is `scn`. The Worker also serves this page at `GET /docs`.

## Install the CLI

Linux x86_64 binary from the [`scn-v0.1.0`](https://github.com/scionhub/openscion/releases/tag/scn-v0.1.0) GitHub release (asset `scn-x86_64-unknown-linux-gnu.tar.gz`):

```sh
curl -fsSL -o scn.tar.gz \
  https://github.com/scionhub/openscion/releases/download/scn-v0.1.0/scn-x86_64-unknown-linux-gnu.tar.gz
tar -xzf scn.tar.gz
install -m 0755 scn ~/.local/bin/scn
```

Or build from source:

```sh
cargo install --git https://github.com/scionhub/openscion --branch cursor/storage-and-multirepo-e719 openscion
```

Point the client at the Worker (every command also accepts `--server <URL>`):

```sh
export SCN_SERVER=https://<this-worker-host>
```

## Clone

Public-repo reads need no token. `scn clone` works with no credentials file.

```sh
scn clone filecoin-project/lotus
scn clone filecoin-project/lotus ./lotus --branch main
scn clone filecoin-project/lotus --path src
```

`<REPO>` is `<org>/<repo>`. `[DIR]` defaults to the repository name.

## Create an account and log in

Password is read from `SCN_PASSWORD` (or `OPNSCN_PASSWORD` / `OPENSCION_PASSWORD`) or prompted on stdin. Username must match `^[a-z0-9][a-z0-9-]{2,31}$`; password at least 10 characters.

```sh
scn signup --username alice
scn signup --username alice --email alice@example.com
scn login --user alice
```

Both commands store a bearer token for later writes. Signup is capped at 5 attempts per IP per hour and 200 users total.

## Organizations

Logged-in users can create up to 3 organizations (admins unlimited). Names use the same rule as usernames (`^[a-z0-9][a-z0-9-]{2,31}$`); reserved names and existing users or orgs are rejected. The creator is inserted as org admin.

```sh
scn org create my-org
scn org list
```

The API is `POST /v1/orgs` with `{ "name": "my-org" }` (Bearer). `GET /v1/orgs` lists memberships. `GET /v1/me` returns `{ user: { id, name, admin }, orgs: [{ id, role }] }`, including the caller's own username namespace.

## Create a repository

Logged-in users can create a public repo under their username org (created on first use) or an org they belong to. `filecoin-project` stays admin-only. Non-admins are limited to 3 repos. The name must match `^[a-z0-9][a-z0-9._-]{0,63}$`.

```sh
scn repo create my-repo
scn repo create my-repo --org alice
```

The API is `POST /v1/repos` with `{ "name": "my-repo", "org": "alice" }` (`org` optional; defaults to your username), or `PUT /v1/repos/{org}/{repo}`. The creator is inserted as the first repo owner. The response includes an informational `retention` object (`freeDays`, `payUrl`); nothing is deleted automatically. Authenticated `GET /v1/repos/{org}/{repo}` includes `viewer: { owner, canMerge }`. `GET /v1/me` lists `ownedRepos`.

Owners (anonymous GET): `GET /v1/repos/{org}/{repo}/owners` → `{ owners: [{ user, created_at, added_by }] }`. `POST` with `{ "username" }` (owners or site admin; username is resolved in top `users`) adds an owner. `DELETE .../owners/{username}` is the same permission and cannot remove the last owner.

Delete a repo: `DELETE /v1/repos/{org}/{repo}` with `{ "confirm": "org/repo" }` (must match exactly). Owners or site admin only. Drops the repo row, refs/branches (RepoDO reset + engine refs), pulls, comments, approvals, and owners. Filecoin pieces are append-only and remain. `filecoin-project/curio` and `filecoin-project/lotus` cannot be deleted unless the caller is a site admin (confirm is still required).

Then import or commit:

```sh
scn import ./src --repo alice/my-repo
scn commit -m "first"
```

## Branch

A working copy in `.scn/state.json` tracks the current branch and the remote ref it pushes to. Short names map to `refs/heads/...` (`main` → `refs/heads/main`, `users/alice/feat` → `refs/heads/users/alice/feat`). Org members and admins get `refs/heads/<name>` for new branches; everyone else gets `refs/heads/users/<you>/<name>`.

```sh
scn branch
scn branch new feature
scn branch new feature --from main
scn branch switch main
scn branch delete feature
```

`scn branch` lists remote branches and marks the current one with `*`. `branch new` creates a local branch and switches to it (the remote ref is created on first `push`). `branch switch` re-fetches that ref when the working copy is clean. `branch delete` removes the remote ref (and refuses to delete the current branch).

## Pull

Fetch the tracked upstream and three-way-merge it into the working copy, including uncommitted local edits. Upstream-only changes are taken; local-only changes are kept; both-changed paths get git-style markers.

```sh
scn pull
```

## Merge

Three-way merge another ref into the working copy (same engine as `pull`). The next `scn push` / `scn commit` records a changeset whose first parent is that ref so `scn pr merge` can fast-forward. Commit and push refuse while `<<<<<<< local` markers remain.

```sh
scn merge main
scn merge users/alice/feat
```

A conflicted file looks like:

```
<<<<<<< local
the line as it is on your branch
=======
the line as it is on main
>>>>>>> main
```

Edit the file to the resolved contents (remove the markers), then push.

## Push

Commit local changes if needed and publish the current branch to its upstream ref (compare-and-swap / fast-forward). A missing remote ref is created. `-m` is required when there are local changes.

```sh
scn push
scn push -m "fix the parser"
```

## Open, list, and merge a pull request

`--head` defaults to the current branch's upstream; `--base` defaults to `main`. Repo is inferred from the working copy, or pass `--repo org/repo`.

```sh
scn pr create --title "Fix the thing"
scn pr create --title "Fix the thing" --body "details" --head refs/heads/users/alice/my-branch --base main
scn pr list
scn pr show 1
scn pr merge 1
scn pr close 1
```

Merge is org admin/member or a repo owner, and fast-forwards the base ref to the head target when the head changeset’s first parent is still the current base. Merge also requires at least one approval by a **repo owner** (non-owner approvals do not count; the PR author still cannot approve their own pull) and zero unresolved comments; otherwise `409 { error: "merge blocked", reasons: [...] }`. `GET .../pulls/{n}/mergeability` returns `{ mergeable, reasons, ownerApprovals, unresolvedComments }`. Close is the author or an admin. The author may `PATCH /v1/repos/{org}/{repo}/pulls/{n}` with `{ title?, body? }` (others 403, anonymous 401). `GET` of a pull includes `comment_count` and `approval_count`. File diffs (`GET .../pulls/{n}/files` and `GET .../compare/...`) use `status: added | modified | removed`.

Comments (anonymous GET): `GET/POST /v1/repos/{org}/{repo}/pulls/{n}/comments` with `{ body, path?, line?, side? }` (`side` is `old` or `new`; omit `path` for a general conversation comment; body ≤ 10 000 characters). `PATCH .../comments/{id}` with `{ resolved: bool }` is the comment author or the PR author. `DELETE .../comments/{id}` is the comment author or a site admin. Approvals (anonymous GET): `GET/POST/DELETE /v1/repos/{org}/{repo}/pulls/{n}/approvals` — each approval is `{ user, owner }`; the PR author cannot approve (403); `POST` is idempotent; `DELETE` removes your own approval.

## Shell completion

```sh
scn completion bash > ~/.local/share/bash-completion/completions/scn
scn completion zsh  > "${fpath[1]}/_scn"
scn completion fish > ~/.config/fish/completions/scn.fish
```

Bash can complete branch names by also sourcing a wrapper that calls `scn __complete-branches` (a hidden command that prints remote branch names).

## How reads reach Filecoin

Clone walks trees via `POST /v1/repos/{org}/{repo}/objects`, then resolves blob PieceCIDs with `POST .../objects/resolve`. The client Range-GETs the bundle piece on the storage provider. `GET .../objects/{id-or-pieceCid}` either 302s to the SP or returns a JSON hint `{ url, offset, length }` for the same Range GET. Authorization is never sent on the cross-origin hop.

Anonymous CORS GETs for a web repo page (no token):

- `GET /v1/repos/{org}/{repo}` — `{ org, name, visibility, created_at }` (empty repo with no refs still returns this); authenticated callers also get `viewer: { owner, canMerge }`
- `GET /v1/repos/{org}/{repo}/owners` — `{ owners: [{ user, created_at, added_by }] }`
- `GET /v1/repos/{org}/{repo}/refs/{name}` then `GET /v1/repos/{org}/{repo}/changesets/{id}` — id, message, author, `created_at`, parents, `root_tree`, metadata (including `pcid:<path>`)
- `GET /v1/repos/{org}/{repo}/tree/{ref}?path=<dir>` — `{ entries: [{ name, kind, id, size, pieceCid }] }` (`kind` is `file` / `dir` / `symlink`)
- `GET /v1/repos/{org}/{repo}/blob/{ref}?path=<file>` — `{ pieceCid, url, offset, length, size }` when packed; otherwise JSON with `contentBase64` / `raw` (`POST .../objects`)
- `GET /v1/repos/{org}/{repo}/commits/{ref}?limit=20` — latest reachable commits
- `GET /v1/orgs/{org}/repos` — repo names
- `GET /v1/repos/{org}/{repo}/branches` — `{ branches: [{ name, target }] }`
- `DELETE /v1/repos/{org}/{repo}/refs/{name}` — drop a ref (owner of `users/<you>/*`, or org member; default branch is admin-only)

## PoC limits

- Filecoin Calibration network (calibnet), not mainnet.
- New orgs share the platform PDP dataset (`filecoin-project`, on-chain 46121) instead of creating their own. An admin can switch an org to `own` (`POST /v1/admin/orgs/{org}/dataset-mode`); creation is lazy on the next add. If the shared dataset exceeds 40 GiB (`SHARED_DATASET_MAX_BYTES`), `/v1/admin/durability` flags `sharedDataset.over` and an admin decides — nothing is auto-created. Pending adds batch up to `ADD_BATCH_WINDOW_SECS` (default 1h) or `ADD_BATCH_MAX_PIECES` (50). See [datasets.md](datasets.md). If the payer lacks lockup funds or allowance, pieces stay queued and are retried with backoff (reads keep working from the SP meanwhile).
- Commits (`commit` / `push`) upload only new or changed file content to the storage provider. Unchanged paths reuse the parent changeset’s `pcid:<path>` metadata, so a merged PR is cloneable.
- A single engine container (`max_instances 1`, lite, sleeps after 30s).
- Non-member blob uploads: 10 MB. Pull request title ≤ 120 characters, body ≤ 10 000.
- Signup: 5 attempts per IP per hour, 200 users total.
- Non-admin repo create: 3 repos per user. User-namespace org is auto-created on first `scn repo create`.
