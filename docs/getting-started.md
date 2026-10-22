# Getting Started

Commands and usage for the ScionHub OpenScion proof of concept. The CLI binary is `opnscn`. The Worker also serves this page at `GET /docs`.

## Install the CLI

```sh
cargo install --git https://github.com/scionhub/openscion --branch cursor/storage-and-multirepo-e719 openscion
```

Point the client at the Worker (every command also accepts `--server <URL>`):

```sh
export OPENSCION_SERVER=https://<this-worker-host>
```

## Clone without an account

Public-repo reads (catalog, refs, changesets, objects, trees, and `POST .../objects/resolve|missing|present`) need no token. `opnscn clone` works with no credentials file.

```sh
opnscn clone ./lotus --repo filecoin-project/lotus
opnscn clone ./lotus --repo filecoin-project/lotus --ref main
opnscn clone ./lotus --repo filecoin-project/lotus --path src
```

## Create an account and log in

Password is read from `OPNSCN_PASSWORD` (or `OPENSCION_PASSWORD`) or prompted on stdin. Username must match `^[a-z0-9][a-z0-9-]{2,31}$`; password at least 10 characters.

```sh
opnscn signup --username alice
opnscn signup --username alice --email alice@example.com
opnscn login --user alice
```

Both commands store a bearer token for later writes. Signup is capped at 5 attempts per IP per hour and 200 users total.

## Create a repository

Logged-in users can create a public repo under their username org (created on first use) or an org they belong to. `filecoin-project` stays admin-only. Non-admins are limited to 3 repos. The name must match `^[a-z0-9][a-z0-9._-]{0,63}$`.

```sh
opnscn repo create my-repo
opnscn repo create my-repo --org alice
```

The API is `POST /v1/repos` with `{ "name": "my-repo", "org": "alice" }` (`org` optional; defaults to your username). The response includes an informational `retention` object (`freeDays`, `payUrl`); nothing is deleted automatically.

Then import or push the first commit:

```sh
opnscn import ./src --repo alice/my-repo
# or, from a working copy of that repo:
opnscn commit -m "first" --ref main
```

## Edit and push a branch

Org members can move any ref. Anyone logged in can push under `refs/heads/users/<username>/*` on a public repo. Non-member uploads are capped at 10 MB.

```sh
cd lotus
# edit files, then either:
opnscn commit -m "my change" --ref refs/heads/users/alice/my-branch
# or, equivalent helper (prefixes refs/heads/users/<you>/ unless NAME already starts with refs/):
opnscn branch push my-branch
opnscn branch push my-branch -m "my change"
```

## Open, list, and merge a pull request

Repo is inferred from the working copy, or pass `--repo org/repo`.

```sh
opnscn pr create --title "Fix the thing" --head refs/heads/users/alice/my-branch
opnscn pr create --title "Fix the thing" --body "details" --head refs/heads/users/alice/my-branch --base main
opnscn pr list
opnscn pr show 1
opnscn pr merge 1
opnscn pr close 1
```

Merge is org admin/member only and fast-forwards the base ref to the head target when the head changeset’s first parent is still the current base. Close is the author or an admin.

## Sync a branch and resolve conflicts

`opnscn sync` three-way-merges the working copy with a target ref (default `main`), including uncommitted local edits. Upstream-only changes are taken; local-only changes are kept; both-changed paths get git-style markers. The next `opnscn commit` / `opnscn branch push` records a changeset whose first parent is that target so `opnscn pr merge` can fast-forward. Commit refuses while `<<<<<<< local` markers remain.

```sh
opnscn clone ./work --repo alice/my-repo
cd work
opnscn branch push feature
# ... meanwhile main moved; edit files, then:
opnscn sync
opnscn sync --from main --dir .
```

A conflicted file looks like:

```
<<<<<<< local
the line as it is on your branch
=======
the line as it is on main
>>>>>>> main
```

Edit the file to the resolved contents (remove the markers), then:

```sh
opnscn commit -m "merge main"
opnscn branch push feature
opnscn pr create --title "Feature" --head refs/heads/users/alice/feature
opnscn pr merge 1
```

## How reads reach Filecoin

Clone walks trees via `POST /v1/repos/{org}/{repo}/objects`, then resolves blob PieceCIDs with `POST .../objects/resolve`. The client Range-GETs the bundle piece on the storage provider. `GET .../objects/{id-or-pieceCid}` either 302s to the SP or returns a JSON hint `{ url, offset, length }` for the same Range GET. Authorization is never sent on the cross-origin hop.

Anonymous CORS GETs for a web repo page (no token):

- `GET /v1/repos/{org}/{repo}` — `{ org, name, visibility, created_at }` (empty repo with no refs still returns this)
- `GET /v1/repos/{org}/{repo}/refs/{name}` then `GET /v1/repos/{org}/{repo}/changesets/{id}` — id, message, author, `created_at`, parents, `root_tree`, metadata (including `pcid:<path>`)
- `GET /v1/repos/{org}/{repo}/tree/{ref}?path=<dir>` — `{ entries: [{ name, kind, id, size, pieceCid }] }` (`kind` is `file` / `dir` / `symlink`)
- `GET /v1/repos/{org}/{repo}/blob/{ref}?path=<file>` — `{ pieceCid, url, offset, length, size }` when packed; otherwise JSON with `contentBase64` / `raw` (`POST .../objects`)
- `GET /v1/repos/{org}/{repo}/commits/{ref}?limit=20` — latest reachable commits
- `GET /v1/orgs/{org}/repos` — repo names
- `GET /v1/repos/{org}/{repo}/branches` — `{ branches: [{ name, target }] }`

## PoC limits

- Filecoin Calibration network (calibnet), not mainnet.
- Each org (user namespaces count as orgs) gets its own PDP dataset on calibnet (clientDataSetId = sha256(org)), created lazily on the first on-chain add; filecoin-project uses dataset 46121. If the payer lacks lockup funds or allowance, pieces stay queued and are retried with backoff (reads keep working from the SP meanwhile).
- Commits (`commit` / `branch push`) upload only new or changed file content to the storage provider. Unchanged paths reuse the parent changeset’s `pcid:<path>` metadata, so a merged PR is cloneable.
- A single engine container (`max_instances 1`, lite, sleeps after 30s).
- Non-member blob uploads: 10 MB. Pull request title ≤ 120 characters, body ≤ 10 000.
- Signup: 5 attempts per IP per hour, 200 users total.
- Non-admin repo create: 3 repos per user. User-namespace org is auto-created on first `opnscn repo create`.
