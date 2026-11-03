# openscion

`scn`, the ScionBase command-line client. A working copy in
`.scn/state.json` tracks the current branch and the remote ref it pushes to
(see
[`docs/specs/openscion-architecture.md`](../../docs/specs/openscion-architecture.md)).
Older working copies in `.opnscn/` are still read.

```sh
scn clone org/repo
scn branch new feature
scn pull
scn push -m "edit the readme"
scn pr create --title "edit the readme"
```

| Command | What it does |
| --- | --- |
| `scn version` | prints the client and protocol versions |
| `scn server-info` | asks the server for its version and checks that the protocol binds |
| `scn clone ORG/REPO` or `HOST/ORG/REPO` | fetches a snapshot; a host is resolved via `/.well-known/scionbase` |
| `scn branch` | lists remote branches; `new` / `switch` / `delete` manage them |
| `scn pull [REMOTE] [BRANCH]` | three-way merge a remote branch into the working copy |
| `scn fetch [REMOTE] [BRANCH]` | remember a remote tip without changing files |
| `scn remote` | add, remove, rename, list, or retarget remotes |
| `scn merge REF` | three-way merge another ref into the working copy |
| `scn push [REMOTE] [BRANCH]` | commit if needed and publish; cross-server pushes send missing pieces |
| `scn commit -m MSG [--dir DIR]` | record changes and move a ref by compare-and-swap |
| `scn pr create\|list\|show\|merge\|close` | pull requests |
| `scn org create\|list` | create or list organizations |
| `scn repo create NAME` | create a repository |
| `scn completion bash\|zsh\|fish` | print a shell completion script |

`org/repo` uses the default server. `host/org/repo` and `https://host/org/repo`
name one; `--server <url>` overrides the default when the command does not
name a host. `--branch` picks the ref to clone (default `main`); `--author`
(or `SCN_AUTHOR`, falling back to `OPENSCION_AUTHOR`) sets the author. If
someone else moved the ref first, `push` / `commit` fails with `RefConflict`.
Tokens from `scn login [host]` are stored per host.
