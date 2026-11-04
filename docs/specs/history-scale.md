# History at archive scale

Status: Implemented. Owner: engine.

## Problem

Log, blame, show, bisect, and historical tree reads loaded every changeset
into the Worker. A repository of tens of thousands of commits exceeded the
Worker memory limit, and a push walked parents with one HTTP request each.

## Goals

- Answer those reads from SQL, with a limit, without returning every body.
- Keep a path→PieceCID checkpoint every 1000 changesets.
- Push missing changesets in batches.
- Archive the oldest contiguous changesets into immutable SQLite pieces
  addressed by COMMP `PieceCID`. Commit ids do not change, and log, blame,
  show, bisect, and tree output stay the same.

## Non-goals

- Deleting history, rewriting ids, or storing a separate blame snapshot.
- Changing the on-disk changeset encoding.

## Behavior

`changeset_parents` and `changeset_paths` are filled on insert and backfilled
once. `scn log --cursor` pages. `GET /changesets` without an id is paged.

`POST /v1/repos/{org}/{repo}/admin/archive` with `{ "before", "dry_run"? }`
is limited to repo owners and site admins. `before` is a changeset id, ref,
or date. The oldest live rows below that cutoff are packed in chunks of about
10 000 changesets or a configured byte size, uploaded through the repo piece
store, recorded in `history_archives` and `changeset_locate`, and deleted from
the live tables only after a read-back checksum. Pieces are write-once.

When `HISTORY_ARCHIVE_MAX_BYTES` is set and `databaseSize` exceeds it, full
chunks are archived and a short tail stays live.

Reads walk the live database, then open the archive that holds the next
parent. A historical tree uses the checkpoint on the chunk boundary, so it
opens at most one archive.

`POST /changesets/have`, `POST /changesets/export`, and
`GET /changesets/{id}/ancestors` let a push send one existence check and then
import parent-before-child chunks.

## Invariants

- A changeset id is the hash of its canonical body and is never rewritten.
- An archive file is not modified after it is stored.
- Live rows are deleted only after the piece reads back and its checksum,
  lsn range, and boundary checkpoint match.

## Acceptance

A synthetic repository archived in several chunks returns byte-identical
log, blame, show, bisect, and tree output. A 20 000-commit repository answers
`log -n 20`, show, a path-filtered log, blame, a historical tree, and a short
bisect without reading every changeset body.
