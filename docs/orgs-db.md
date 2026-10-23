# Split D1: `scionhub-top` and `scionbase-orgs`

OpenScion uses **exactly two** static D1 bindings. There is no runtime D1
creation and no per-org database.

| Binding | Database | Holds |
| --- | --- | --- |
| `DB_SCIONHUB_TOP` | `scionhub-top` | Identity and the orgs list: `users`, `tokens`, `orgs`, `org_members`, `memberships`, `signup_attempts` |
| `ORGS_DB` | `scionbase-orgs` | Repo-scoped metadata for every org: `repos`, `repo_owners`, `pulls`, `pr_comments`, `pr_approvals`, `datasets`, `org_datasets`, `dataset_usage`, `providers`, `pieces`, `uploads` |

Worker code falls back to the top DB when `env.ORGS_DB` is undefined, so a
deploy before `scionbase-orgs` exists keeps serving from `scionhub-top`.

Cross-DB SQL joins are not possible. Author names on pull requests are loaded
from top (`users`) and merged in the Worker after reading `pulls` from
`ORGS_DB`. Creating an org writes only top; creating a repo writes membership
on top first, then the `repos` row on `ORGS_DB`. There is **no cross-DB
transaction** — order writes and compensate (see [Risks](#risks)).

The Worker never stores Cloudflare API tokens. Apply schema and move data with
Wrangler locally, using account credentials already configured for the CLI.

## Cut over

Run from the repository root. Use Wrangler 4.86: `d1 export` requires
`--output`, accepts `--table` and `--no-schema`, and skips the remote-export
prompt with `--skip-confirmation` (`-y`). `d1 execute` uses `--file` / `--command`
and `--yes`.

1. **Create the database** (once):

   ```sh
   npx -y wrangler@4.86.0 d1 create scionbase-orgs
   ```

2. **Put the id in `apps/worker/wrangler.toml`.** Replace
   `TODO-create-with-wrangler-d1-create` on the `ORGS_DB` binding with the
   UUID printed by `d1 create`. Do not commit account tokens. Container
   config in the same file stays unchanged.

3. **Apply orgs migrations** (creates empty tables matching the live top
   schema, including `repos.created_by` and `datasets.org`):

   ```sh
   npx -y wrangler@4.86.0 d1 migrations apply scionbase-orgs --config apps/worker/wrangler.toml --remote
   ```

4. **Copy rows** from top into orgs (dry-run first). The script never prints
   tokens or table contents:

   ```sh
   DRY_RUN=1 ./tools/move-to-orgs-db.sh
   ./tools/move-to-orgs-db.sh
   ```

   It exports each moved table with
   `wrangler d1 export scionhub-top --remote --table <name> --no-schema --output <file>`,
   rewrites `INSERT` statements to named columns so extra `org` columns stay
   nullable, executes against `scionbase-orgs`, fills `repos.org` from
   `repos.id`, and checks row counts.

5. **Deploy the Worker** (binds `ORGS_DB`). Confirm catalog, PRs, and dataset
   routes against the new DB.

6. **Later: drop the moved tables from top.** Do **not** put this SQL in
   `migrations/top` (Wrangler would auto-apply it). After the new DB is
   verified, run [`tools/sql/drop-moved-tables.sql`](../tools/sql/drop-moved-tables.sql)
   manually:

   ```sh
   npx -y wrangler@4.86.0 d1 execute scionhub-top --config apps/worker/wrangler.toml --remote --file tools/sql/drop-moved-tables.sql
   ```

## Risks

- **No cross-DB transactions.** Org create is top-only. Repo create writes
  `orgs`/`memberships` on top, then `repos` on `ORGS_DB`. If the second write
  fails, compensate by retrying the `repos` insert; do not roll back a valid
  membership. A pull-request insert does not touch top.
- **10 GB per D1 database.** `scionbase-orgs` is shared by every org. Metadata
  is small relative to object bytes (R2 / Filecoin); still watch
  `wrangler d1 info scionbase-orgs` as org count grows.
- **Consistency.** Top is the source of truth for “does this org exist?”;
  `ORGS_DB` is the source of truth for repos, PRs, and datasets. A repo row
  without a matching org (or the reverse) can appear if a write is interrupted.
  List endpoints tolerate empty sets; create paths check top before inserting
  into `ORGS_DB`.
- **Fallback.** If `ORGS_DB` is missing at runtime, repo-scoped queries hit
  top. After the drop-tables step, that fallback would fail — only drop after
  the binding is live.
