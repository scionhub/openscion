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
| `scn clone ORG/REPO [DIR]` | fetches a snapshot into a new working copy |
| `scn branch` | lists remote branches; `new` / `switch` / `delete` manage them |
| `scn pull` | three-way merge the tracked upstream into the working copy |
| `scn merge REF` | three-way merge another ref into the working copy |
| `scn push [-m MSG]` | commit if needed and publish the current branch |
| `scn commit -m MSG [--dir DIR]` | record changes and move a ref by compare-and-swap |
| `scn pr create\|list\|show\|merge\|close` | pull requests |
| `scn org create\|list` | create or list organizations |
| `scn repo create NAME` | create a repository |
| `scn completion bash\|zsh\|fish` | print a shell completion script |

`--server` (or `SCN_SERVER`, falling back to `OPENSCION_SERVER`) picks the
server; `--branch` picks the ref to clone (default `main`); `--author` (or
`SCN_AUTHOR`, falling back to `OPENSCION_AUTHOR`) sets the author. If someone
else moved the ref first, `push` / `commit` fails with `RefConflict`.
