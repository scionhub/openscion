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

Shared Docker “needs” (optional):
- A test may declare simple pre-built images in `.scm/<testDir>/needs`.
- Format (one directive per line; ignore blanks and `#` comments):
  - `docker:<folder>` — before this test is built/run, the runner builds `.scm/<folder>/Dockerfile` (repo root as context) and tags it so the test can `FROM` it.
  - `<folder>` must be a single segment under `.scm/` (reject `..`, slashes, empty). At most 8 entries.
- Tag convention: the runner tags the image as `scn-need/<folder>` (and also with a changeset-suffixed tag for cache isolation). Tests should `FROM scn-need/<folder>`.
- Needs are not checks by themselves; only `test*` directories become checks.
- Discovery of needs happens per test from its `needs` file; the queued job includes the resolved list.

Contract summary:
- Add a new test by committing `.scm/testX/Dockerfile`.
- The image builds with repo root context; test code may `COPY . .` or read `/workspace` at runtime.
- Exit status sets the check result; logs are capped to 1 MB.

Which commit is tested:
- ScionBase enqueues checks for a specific 64‑hex changeset. Runners check out that exact changeset before any Docker build. The `${commit}` placeholder is not expanded by the platform in Dockerfiles; use the workspace contents at build/run time instead.

Environment variables inside the container:
- Always set:
  - `CI=1`, `SCN_CI=1`
  - `SCN_JOB` — check name (e.g., `test1`)
  - `SCN_CHANGESET` — 64‑hex changeset id
  - `SCN_REPO` — `<org>/<repo>`
- GitHub‑compatible duplicates:
  - `GITHUB_ACTIONS=true`
  - `GITHUB_SHA` — same as `SCN_CHANGESET`
  - `GITHUB_REPOSITORY` — `<org>/<repo>`
  - `GITHUB_REPOSITORY_OWNER` — `<org>`
  - `GITHUB_JOB` — check name
  - `GITHUB_WORKSPACE=/workspace`
  - `GITHUB_REF` and `GITHUB_REF_NAME` when the job carries a ref (e.g. `refs/heads/main` / `main`)
  - `GITHUB_RUN_ID` — the check id (best‑effort)
- These variables are also passed as Docker `--build-arg`s for convenience; the primary contract is the runtime `-e` environment.

Example:
```
.scm/
  build/Dockerfile         # shared base
  test1/Dockerfile         # trivial example
  test2/
    needs                  # contains: docker:build
    Dockerfile             # starts with: FROM scn-need/build
```

Runner CLI:
- Register a runner and store its token: `scn runner register --repo org/repo --labels linux,x64`
- Start it (outbound HTTPS only): `scn runner run --repo org/repo`

Maintainer CLI:
- List checks: `scn ci list --repo org/repo --ref main`
- Print a log: `scn ci log <name> --repo org/repo --ref main`
- Re-run a check: `scn ci rerun <name> --repo org/repo --ref main`
