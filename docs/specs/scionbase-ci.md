## ScionBase-native CI: Docker test jobs

ScionBase runs repository-defined CI checks by discovering Docker test jobs under `.scm/` and executing them on self-hosted runners.

- Discovery: each `.scm/test*/Dockerfile` becomes one check named after the folder (e.g. `.scm/test1` → `test1`).
- Build: the runner builds the image with repository root as the build context: `docker build -f .scm/testN/Dockerfile -t <tag> .`.
- Run: the runner starts the container with the repository mounted read-only at `/workspace` and `WORKDIR=/workspace`. The container's default `CMD`/`ENTRYPOINT` runs the test and must exit with status code:
  - exit 0 → success
  - non‑zero → failure
  - timeout → failure
- Logs: stdout/stderr are streamed to the check log and truncated at 1 MB.

Optional per-test metadata files:
- `.scm/testN/labels` — comma/whitespace-separated runner labels required by this job (e.g. `linux,x64`).
- `.scm/testN/timeout` — timeout in seconds (default 600, max 3600).
- `.scm/testN/README` — free-form notes for humans (ignored by the platform).

Environment variables inside the container:
- `CI=1`, `SCN_CI=1`
- `SCN_JOB` — check name (e.g., `test1`)
- `SCN_CHANGESET` — 64-hex changeset id
- `SCN_REPO` — `<org>/<repo>`

Contract summary:
- Add a new test by committing `.scm/testX/Dockerfile`.
- The image builds with repo root context; test code may `COPY . .` or read `/workspace` at runtime.
- Exit status sets the check result; logs are capped to 1 MB.

Runner CLI:
- Register a runner and store its token: `scn runner register --repo org/repo --labels linux,x64`
- Start it (outbound HTTPS only): `scn runner run --repo org/repo`

Maintainer CLI:
- List checks: `scn ci list --repo org/repo --ref main`
- Print a log: `scn ci log <name> --repo org/repo --ref main`
- Re-run a check: `scn ci rerun <name> --repo org/repo --ref main`
