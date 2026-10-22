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

## How reads reach Filecoin

Clone walks trees via `POST /v1/repos/{org}/{repo}/objects`, then resolves blob PieceCIDs with `POST .../objects/resolve`. The client Range-GETs the bundle piece on the storage provider. `GET .../objects/{id-or-pieceCid}` either 302s to the SP or returns a JSON hint `{ url, offset, length }` for the same Range GET. Authorization is never sent on the cross-origin hop.

## PoC limits

- Filecoin Calibration network (calibnet), not mainnet.
- Imported bundles are added on-chain to one PDP dataset per org (calibnet dataset 46121 for filecoin-project).
- Branch/PR commits made with `commit` / `branch push` are not yet bundled to the SP, so cloning a merged change is not supported yet in this PoC.
- A single engine container (`max_instances 1`, lite, sleeps after 30s).
- Non-member blob uploads: 10 MB. Pull request title ≤ 120 characters, body ≤ 10 000.
- Signup: 5 attempts per IP per hour, 200 users total.
