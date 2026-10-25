## ScionBase-native CI: Docker test checks

ScionBase runs repository-defined CI checks by discovering Docker test jobs under `.scm/` and executing them on self-hosted runners. This spec is the maintainer-facing contract: how tests are discovered, how the runner builds and runs them, and exactly which environment variables are available at build-time and run-time.

### 1) Overview

- Discovery: every directory whose name matches `test[0-9A-Za-z._-]*` under `.scm/` and contains a `Dockerfile` becomes one CI check named after the folder (e.g., `.scm/test1` → check `test1`).
- Enqueueing: checks are queued automatically for the tip of `main` and for every open PR head. The system remembers which changesets were already scanned to avoid duplicate rows.
- Runner model: registered runners long-poll the server for queued work, claim one job atomically, then:
  1. clone/check out the exact changeset for the job,
  2. build any declared shared “needs” images,
  3. build the test image,
  4. run the container with the repository mounted read-only at `/workspace`,
  5. stream logs and report the result.
- Exit codes: container exit status 0 → success; non‑zero → failure. A job that exceeds its timeout is marked failure. Infrastructure errors (e.g., cannot spawn docker) are marked error.
- Logs: stdout/stderr are streamed to the check log; the platform keeps the last 1 MB (older content is truncated).
- Limits and defaults: at most 64 tests per changeset are enqueued (MAX_JOBS = 64). A job with no `timeout` metadata runs for up to 600 seconds (default); a per‑test `timeout` may raise or lower it within 1–3600 seconds.

### 2) Layout reference under `.scm/`

| Path | Kind | Purpose |
| --- | --- | --- |
| `.scm/test1/Dockerfile` | file | REQUIRED for a test job; each `test*` dir with a `Dockerfile` becomes a check |
| `.scm/test1/labels` | file (optional) | Comma/whitespace‑separated runner labels required by this job (e.g., `linux,x64`) |
| `.scm/test1/timeout` | file (optional) | Timeout in seconds, integer; default 600, max 3600 |
| `.scm/test1/README` | file (optional) | Free‑form notes for humans; ignored by the platform |
| `.scm/test1/needs` | file (optional) | Declares shared images to build before this test; see “needs” contract below |
| `.scm/build/Dockerfile` | file | A “need” folder; can be referenced by tests but is NOT a check itself |

Notes:
- Need folders (e.g., `.scm/build`) are not checks. Only `test*` directories with a `Dockerfile` enqueue checks.
- All docker builds use the repository root as the build context.

### 3) Discovery rules

- A directory qualifies as a test when its name matches `test[0-9A-Za-z._-]*` and it contains a `Dockerfile`.
- Optional metadata files in the test directory (labels, timeout, README, needs) are read when present.
- Needs are not checks; they are built only when referenced by a test’s `needs` file.

### 4) Shared images with `needs`

Goals: build a base or a shared artifact once per runner/changeset, then let multiple tests `FROM` it without re‑building the same binary repeatedly.

File format (`.scm/<testDir>/needs`):
- One directive per line.
- Blank lines and lines starting with `#` are ignored.
- Each directive must be `docker:<folder>` where `<folder>` is a single path segment under `.scm/` (no slashes, not `.` or `..`). Maximum 8 entries are honored per test.

Tagging and FROM:

| Built need | Local tags created | Recommended FROM in test |
| --- | --- | --- |
| `.scm/build/Dockerfile` | `scn-need/build` and `scn-need/build:<changeset12>` | `FROM scn-need/build` |

Failure behavior:
- If a need’s `Dockerfile` is missing or cannot be built, the dependent check fails with a clear summary and the job log contains the docker output.

Worked example (shared binary build used by two tests):

```
.scm/
  build/Dockerfile
  test2/
    needs           # docker:build
    Dockerfile      # FROM scn-need/build
  test3/
    needs           # docker:build
    labels          # e.g., linux,x64
    timeout         # e.g., 900
    Dockerfile      # FROM scn-need/build
```

### 5) Which commit is tested?

ScionBase enqueues checks for a specific 64‑hex changeset id and each runner checks out that exact changeset before any docker build. There is no platform‑side `${commit}` interpolation in Dockerfiles. If you need the id:
- Use the workspace contents at build or run time (e.g., read files from `/workspace`), and/or
- Read `SCN_CHANGESET` or `GITHUB_SHA` (identical values) from the environment at run time, or
- Use the corresponding `ARG` values at build time (see build‑args table).

### 6) Environment variables and build‑args (complete reference)

At run time the runner injects both ScionBase‑native and GitHub‑compatible variables. The same set (except `GITHUB_RUN_ID`) is also provided as docker build‑args. Dockerfiles must declare `ARG` to observe build‑time values; the primary contract is run‑time `-e`.

Table A — ScionBase variables (run time)

| Name | Always? | Example | Meaning |
| --- | --- | --- | --- |
| `SCN_CI` | yes | `1` | Marks a ScionBase CI container |
| `SCN_JOB` | yes | `test2` | Check name |
| `SCN_CHANGESET` | yes | `012345…64hex` | 64‑hex changeset id under test |
| `SCN_REPO` | yes | `org/repo` | Repository locator |

Table B — GitHub‑compatible variables (run time)

| Name | Always? | Example | Maps to / notes |
| --- | --- | --- | --- |
| `GITHUB_ACTIONS` | yes | `true` | Convenience flag for common scripts |
| `GITHUB_SHA` | yes | `012345…64hex` | Same value as `SCN_CHANGESET` |
| `GITHUB_REPOSITORY` | yes | `org/repo` | Repository name |
| `GITHUB_REPOSITORY_OWNER` | yes | `org` | Repository owner |
| `GITHUB_JOB` | yes | `test2` | Check name |
| `GITHUB_WORKSPACE` | yes | `/workspace` | Mounted workspace path (read‑only) |
| `GITHUB_REF` | when job has a ref | `refs/heads/main` | Branch/ref string carried by the job |
| `GITHUB_REF_NAME` | when job has a ref | `main` | Final path segment of `GITHUB_REF` |
| `GITHUB_RUN_ID` | yes | job id (UUID/opaque) | Check run identifier (best‑effort) |

Table C — Build‑args (docker `--build-arg`)

| Name | Provided? | Example | Notes |
| --- | --- | --- | --- |
| `SCN_CHANGESET` | yes | `012345…64hex` | Use `ARG SCN_CHANGESET` in Dockerfile to read |
| `SCN_REPO` | yes | `org/repo` |  |
| `SCN_JOB` | yes | `test2` |  |
| `GITHUB_ACTIONS` | yes | `true` |  |
| `GITHUB_SHA` | yes | `012345…64hex` |  |
| `GITHUB_REPOSITORY` | yes | `org/repo` |  |
| `GITHUB_REPOSITORY_OWNER` | yes | `org` |  |
| `GITHUB_JOB` | yes | `test2` |  |
| `GITHUB_WORKSPACE` | yes | `/workspace` |  |
| `GITHUB_REF` | when job has a ref | `refs/heads/main` |  |
| `GITHUB_REF_NAME` | when job has a ref | `main` |  |
| `GITHUB_RUN_ID` | no | — | Not passed as build‑arg |

Other variables:
- `CI=1` is always present at run time for parity with many CI scripts.

Not provided (non‑goals for v1): tokens/secrets (`GITHUB_TOKEN`, registry creds), matrix metadata, job URLs, full Actions context. Secrets are out of scope; prefer runner‑local or private registry in a later phase.

### 7) Lifecycle (numbered flow)

1. Push to `main` or open/refresh a PR.
2. Server scans `.scm/` for `test*` directories and enqueues up to 64 checks for the head changeset (and `main`).
3. Runner polls; when it claims a job it records “running” and starts streaming logs.
4. Runner checks out the exact changeset.
5. Runner builds declared needs (e.g., `.scm/build/Dockerfile`) and tags them (`scn-need/<folder>`, `scn-need/<folder>:<changeset12>`).
6. Runner builds the test image (`docker build -f .scm/testN/Dockerfile .`) with build‑args.
7. Runner executes the container with `/workspace` mounted read‑only and env vars set; logs are streamed and capped.
8. Runner reports the final state; required checks are evaluated by the server/UI.

### 8) Worked examples

Minimal single test (`.scm/test1/Dockerfile`):

```Dockerfile
FROM alpine:3.20
WORKDIR /workspace
CMD ["/bin/sh", "-lc", "echo \"ScionBase CI example: OK ($GITHUB_SHA $SCN_JOB)\" && exit 0"]
```

Shared need + two consumers:

```Dockerfile
# .scm/build/Dockerfile
FROM alpine:3.20
RUN echo "built once" > /root/base.txt
```

```text
# .scm/test2/needs
docker:build
```

```Dockerfile
# .scm/test2/Dockerfile
FROM scn-need/build
WORKDIR /workspace
CMD ["/bin/sh", "-lc", "test -f /root/base.txt && echo \"test2 OK ($GITHUB_JOB)\" && exit 0"]
```

```text
# .scm/test3/needs
docker:build
```

```text
# .scm/test3/labels
linux,x64
```

```text
# .scm/test3/timeout
900
```

```Dockerfile
# .scm/test3/Dockerfile
FROM scn-need/build
WORKDIR /workspace
# Use build args (declare ARG to read values at build time)
ARG GITHUB_SHA
RUN echo "building for $GITHUB_SHA" > /root/build-arg.txt
CMD ["/bin/sh", "-lc", "grep -q built && echo \"test3 OK ($GITHUB_REF_NAME)\" && exit 0 || exit 1"]
```

### 9) CLI reference (maintainers and runners)

Runner:
- Register and store token locally:  
  `scn runner register --repo org/repo --labels linux,x64`
- Start polling (outbound HTTPS only):  
  `scn runner run --repo org/repo`

Maintainers:
- List checks:  
  `scn ci list --repo org/repo --ref main`
- Print a log:  
  `scn ci log test2 --repo org/repo --ref main`
- Re‑run a check:  
  `scn ci rerun test2 --repo org/repo --ref main`

### 10) Limits & non‑goals

- This is not a GitHub Actions YAML interpreter; we only provide a familiar env surface for common scripts.
- No secrets/vault in v1; private registries and credential flows are deferred.
- Needs are direct only in v1 (no transitive graphs). Maximum 8 per test.
- Check count is capped at 64 per changeset; logs keep only the last 1 MB.
