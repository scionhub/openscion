# openscion

`opnscn`, the OpenScion command-line client. A working copy in
`.opnscn/state.json` tracks the current branch and the remote ref it pushes to
(see
[`docs/specs/openscion-architecture.md`](../../docs/specs/openscion-architecture.md)).

```sh
opnscn clone org/repo
opnscn branch new feature
opnscn pull
opnscn push -m "edit the readme"
opnscn pr create --title "edit the readme"
```

| Command | What it does |
| --- | --- |
| `opnscn version` | prints the client and protocol versions |
| `opnscn server-info` | asks the server for its version and checks that the protocol binds |
| `opnscn clone ORG/REPO [DIR]` | fetches a snapshot into a new working copy |
| `opnscn branch` | lists remote branches; `new` / `switch` / `delete` manage them |
| `opnscn pull` | three-way merge the tracked upstream into the working copy |
| `opnscn merge REF` | three-way merge another ref into the working copy |
| `opnscn push [-m MSG]` | commit if needed and publish the current branch |
| `opnscn commit -m MSG [--dir DIR]` | record changes and move a ref by compare-and-swap |
| `opnscn pr create\|list\|show\|merge\|close` | pull requests |
| `opnscn completion bash\|zsh\|fish` | print a shell completion script |

`--server` (or `OPENSCION_SERVER`) picks the server; `--branch` picks the ref
to clone (default `main`); `--author` (or `OPENSCION_AUTHOR`) sets the author.
If someone else moved the ref first, `push` / `commit` fails with
`RefConflict`.
