# openscion

`opnscn`, the OpenScion command-line client. In the full design it lays out a
sparse working copy, watches it for edits, uploads blobs, and wraps the server's
history and landing APIs (see
[`docs/specs/openscion-architecture.md`](../../docs/specs/openscion-architecture.md)).
Today it implements import, commit, and clone against an `openscion-server`.

```sh
opnscn version
opnscn server-info                                   # default https://api.scionbase.ai
opnscn --server http://host:7878 import ./tree       # first changeset, creates `main`
opnscn commit -m "edit the readme" --dir ./tree      # record changes, move `main` by CAS
opnscn clone ./copy                                  # the whole snapshot
opnscn clone ./slice --path services/api             # one directory of it
```

| Command | What it does |
| --- | --- |
| `opnscn version` | prints the client and protocol versions |
| `opnscn server-info` | asks the server for its version and checks that the protocol binds |
| `opnscn import [DIR]` | records a directory as the repository's first changeset and creates the ref |
| `opnscn commit -m MSG [--dir DIR]` | records every change since the base changeset and moves the ref by compare-and-swap |
| `opnscn clone DEST [--path P]` | fetches a snapshot, or only the directory `P`, into a new working copy |

`--server` (or `OPENSCION_SERVER`) picks the server; `--ref` picks the ref
(default `main`); `--author` (or `OPENSCION_AUTHOR`) sets the author. A working
copy keeps its state in `.opnscn/state.json`, and `commit` talks to the server
the working copy came from. If someone else moved the ref first, `commit`
fails with `RefConflict`: there is no rebase yet.

By default the client talks to the hosted ScionBase API over HTTPS. To work
with a locally running `openscion-server` over HTTP, pass `--server` (or set
`OPENSCION_SERVER`) to point the client at your local base URL.
