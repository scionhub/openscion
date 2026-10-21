![OpenScion](https://raw.githubusercontent.com/tinyhumansai/openscion/refs/heads/main/docs/og.jpeg)

# OpenScion

OpenScion is an open-source, server-centric source control system for very
large monorepos where most clients are AI agents and CI jobs rather than people
on laptops. It follows the design Anthropic described for its internal system,
Scion, in
[*Redesigning source control*](https://www.anthropic.com/engineering/redesigning-source-control).

## Benchmarks

`opnscn` against git on synthetic repositories of 4 KiB files, measured with
`openscion-bench` (`cargo run -p openscion-benchmarks --release`):

![OpenScion vs git on synthetic repositories: median times to import a repository, clone everything, commit one changed file, and clone one directory, on 1,000 and 10,000 files](docs/images/opnscn-benchmarks.svg)

OpenScion imports and clones several times faster than git at both sizes. The
one-directory clone shows the design at work: `opnscn` fetches only the trees
on the path to the directory and the files beneath it, so its cost tracks the
slice you ask for rather than the size of the repository. Setup, methodology,
and raw numbers are in [`benchmarks/README.md`](benchmarks/README.md).

## Why

Git assumes every client is offline and keeps a full copy of history. An
agent-heavy monorepo breaks that assumption. Thousands of short-lived, always-online
jobs each want a small slice of a huge tree, and each one pays for the whole
repository anyway. Anthropic reports going from about 2,500 to over 30,000
merged changes a day in four months. At that point the main-branch history was
almost 100 GB, CI ran about 25 million checkouts a day, and they needed several
hundred git mirrors to keep up.

OpenScion takes the opposite approach:

- **The server does the work.** History, blame, commits, rebases, and merges
  run server-side. A client keeps a bounded cache and lays out files.
- **Changesets, not snapshots.** A changeset lists only the files that changed
  relative to its first parent. Creating one costs the size of the change, not
  the size of the repository.
- **Content addressing everywhere.** Blobs, trees, and changesets are named by
  their BLAKE3 hash. Any cache at any tier can serve them without coordination,
  and any client can verify them.
- **Few refs, moved by compare-and-swap.** Creating a changeset never touches a
  ref. Landing is a server-side rebase plus a single-record swap, retried on
  contention, with no global merge lock.
- **Source control as an API.** Log, diff, blame, ancestry, rebase, revert, and
  land are RPCs, so CI and bisect pipelines need no checkout.
- **Fetch only what you name.** Clients request specific trees and blobs
  instead of negotiating packfiles, so sparse checkouts need no special support.

OpenScion is purpose-built for one workload: large monorepos where most of the
traffic comes from agents and CI jobs. Server-side operations, fetching only
what is named, and lock-free landing are what keep thousands of concurrent
clients fast at that scale.

## Architecture

```text
 opnscn (client) ──► openscion-daemon ──► openscion-cache ──► openscion-server
 working copy     one per node         regional,           log, refs,
 fs watcher       node-wide objects    immutable objects   derived data
                                                              │
                                              metadata store ─┴─ object store
```

All tiers answer the same object RPCs, so a client talks to whichever one is
nearest. Mutable state (the log, refs, and derived indexes) lives only on the
server. Storage sits behind two ports, `ObjectStore` and `MetadataStore`. The
reference implementations are in-memory and local (filesystem, SQLite), so a
single node works without any cloud services.

## Documentation

| Document | What it covers |
| --- | --- |
| [Architecture](docs/specs/openscion-architecture.md) | goals, principles, components, tiers, delivery phases |
| [Data model](docs/specs/openscion-data-model.md) | object ids, paths, blobs, trees, changesets, the log, refs, derived data |
| [API](docs/specs/openscion-api.md) | operations, fetch protocol, rebase and landing, access control, errors |
| [Background: Scion](docs/research/scion.md) | notes on the system OpenScion is modelled on |
| [Background: git, GitHub, GitLab](docs/research/README.md) | how git stores and moves data, and how the two largest forges host it |
| [Roadmap](ROADMAP.md) | what exists, what is next, what is out of scope |
| [`AGENTS.md`](AGENTS.md) | repository guidelines for humans and coding agents |

## Layout

```text
crates/
├── openscion-proto/   # the protocol: payload types and the protocol version
├── openscion-core/    # the engine: data model, stores, derived data, rebase
├── openscion-server/  # openscion-server: the HTTP API over the engine
└── openscion/         # opnscn, the command-line client (crates.io: openscion)
benchmarks/            # openscion-bench: OpenScion vs git on synthetic repos
apps/web/              # the web GUI (Next.js + shadcn/ui)
docs/
├── research/          # source material: Scion, git, GitHub, GitLab
├── specs/             # what to build and why
├── plans/             # test-first implementation plans
└── adr/               # architecture decision records
```

`openscion-proto` holds every type that crosses a process boundary. It has no
transport, runtime, or behavior, so any tool can depend on it to speak the API.
`openscion-core` depends on it and re-exports it, so both crates name the same
types. The server, the CLI, and the GUI all speak that one API.

## Quick start

```sh
cargo run -p openscion-server                 # serves http://127.0.0.1:7878
cargo run -p openscion -- import ./tree       # opnscn: record a tree as `main`
cargo run -p openscion -- commit -m "edit" --dir ./tree
cargo run -p openscion -- clone ./copy        # or `--path dir` for one directory
cd apps/web && pnpm install && pnpm dev       # GUI on http://localhost:3000
cargo run -p openscion-benchmarks --release   # time the scenarios against git
```

Install the client from crates.io with `cargo install openscion`, which
provides the `opnscn` binary.

## Filecoin PDP POC (Cloudflare Worker)

This fork includes a proof-of-concept that stores content via Filecoin’s PDP (Proof of Data Possession) API and organizes it GitHub-style (organizations → repositories). The primary runtime is a Cloudflare Container running the Rust OpenScion server, fronted by a thin Worker for org routing and D1 access. Local dev may still use `wrangler dev` for the Worker and `docker` for the container.

- Single organization in this POC: `filecoin-project`
- One D1 database per organization. For `filecoin-project`, we bind `scionhub-filecoin-project` (`cd6d035d-e92c-487b-bdf1-fdd8cefa0ce3`) as the org’s DB.
- All content is identified by Filecoin PieceCID (CommP v2) in the Worker’s data model.
- Provider relationships and uploads happen server‑side; clients do not talk to storage providers directly.

### Architecture (POC scope)

- apps/worker (Cloudflare Worker, TypeScript)
  - HTTP API (fetch handler) scoped under `/orgs/filecoin-project/…`
  - D1 schema: providers, datasets, pieces (by PieceCID), uploads, repos
  - PDP adapter (`src/pdp.ts`) with clear POC stubs where Synapse/PDP integration belongs
- Rust workspace (openscion‑proto/core/server/cli) remains as-is and continues to use BLAKE3 object ids for the OpenScion engine. The POC service is a separate path that uses PieceCID for storage identifiers.

### APIs

- GET `/` and `/healthz`: service info and pricing note
- GET `/orgs/filecoin-project`: org landing and useful links
- Providers:
  - GET `/orgs/filecoin-project/providers`
  - POST `/orgs/filecoin-project/providers` (admin)
- Datasets:
  - GET `/orgs/filecoin-project/datasets`
  - POST `/orgs/filecoin-project/datasets` (admin)
- Uploads:
  - POST `/orgs/filecoin-project/uploads` — register/upload a piece
    - body: `{ datasetId, pieceCid? | bytesBase64? | contentUrl? | sizeBytes?, providerId? }`
    - POC: CommP computation and storage calls are stubbed unless PDP is configured (see Secrets)
- Pieces:
  - GET `/orgs/filecoin-project/pieces/{pieceCid}`
- Pricing:
  - GET `/pricing` — free for the first 6 months or 1 GB, then $5/GB/month; USD or ETH. POC only — no real billing.

### Direct retrieval (no server egress) and locate API

- Objects are addressed by BLAKE3 `ObjectId` in the v1 protocol, but stored in Filecoin pieces. The server maps `ObjectId -> (PieceCID, offset, length, providerUrl)` in D1 (`object_locations`).
- New endpoints:
  - POST `/v1/objects/locate` → `{ locations: [{ objectId, pieceCid, offset, length, providerUrl, pieceSize }] }`
  - GET `/v1/objects/{id}` → 307 redirect to the SP piece URL when the object is the whole piece; otherwise returns the single-object location JSON. Falls back to serving the object from the in-memory store when not yet sealed.
- The CLI uses `locate` whenever available and fetches directly from the SP’s HTTP retrieval (`GET {providerUrl}/piece/{pieceCid}`), slicing `offset..offset+length` locally and verifying BLAKE3. It falls back to `POST /v1/objects` when the server does not support `locate`.
- Stock upstream clients remain compatible via `POST /v1/objects` (still served as a proxy, uncached).
- Observations re: Curio retrieval:
  - Range: public docs don’t explicitly state `Range:` support on `/piece/{cid}`. The CLI currently downloads the full piece and slices locally. Switching to HTTP ranges is a follow-up once verified live.
  - CORS: Curio documents CORS for admin/UI surfaces; `/piece` is typically served as data and not called from browsers in this POC, so CORS does not affect the CLI. If a browser client is added, expose a Worker-side preflight/CORS grant or configure Curio accordingly.

### Local development

Requirements: Node 18+, `npm`, and `wrangler` (installed automatically from devDependencies).

```sh
# 1) Install Worker deps
cd apps/worker
npm install

# 2) Apply the org-scoped D1 schema locally
npx wrangler d1 migrations apply DB_FILECOIN_PROJECT --local

# 3) (Optional) Run the Rust server in a container locally
docker compose up --build -d

# 4) Run the Worker locally with a local D1
npx wrangler dev --local --var ADMIN_TOKEN=dev123 --var DEFAULT_PROVIDER_ID=dev-provider
```

Examples:

```sh
# Create a provider (admin)
curl -s -X POST 'http://localhost:8787/orgs/filecoin-project/providers' \
  -H 'Authorization: Bearer dev123' \
  -H 'Content-Type: application/json' \
  -d '{"id":"dev-provider","name":"Dev Provider","endpointUrl":"https://sp.dev","region":"us-east"}'

# Create a dataset (admin)
curl -s -X POST 'http://localhost:8787/orgs/filecoin-project/datasets' \
  -H 'Authorization: Bearer dev123' \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","description":"POC dataset"}'

# Register or upload a piece (CommP v2 is computed for provided bytes/url)
curl -s -X POST 'http://localhost:8787/orgs/filecoin-project/uploads' \
  -H 'Content-Type: application/json' \
  -d '{"datasetId":"<returned-id>","bytesBase64":"aGVsbG8="}'
```

### Secrets and config

Configure via Wrangler (secrets in production, vars in dev):

- `ADMIN_TOKEN` — required for admin routes (Providers/Datasets POST)
- `DEFAULT_PROVIDER_ID` — default storage provider id when one is not provided
- `PDP_BASE_URL` — optional, reserved
- `SYNAPSE_PRIVATE_KEY` — optional; when set and Synapse SDK is available, enables real upload/download
- `SOURCE_TAG` — optional; tag for Synapse client source (defaults to `openscion-poc-worker`)
- `CONTAINER_URL` — when set in the Worker (e.g. `http://127.0.0.1:7878`), enables `/orgs/{org}/engine/health` proxying to the Rust server

Wrangler binding (already set up in `apps/worker/wrangler.toml`):

```toml
[[d1_databases]]
binding = "DB_FILECOIN_PROJECT"               # Used when the URL has /orgs/filecoin-project/...
database_name = "scionhub-filecoin-project"
database_id = "cd6d035d-e92c-487b-bdf1-fdd8cefa0ce3"
migrations_dir = "migrations/filecoin-project"
# To add another org later, add another [[d1_databases]] with binding DB_<ORG_NAME_IN_UPPER_SNAKE_CASE>
```

### What’s stubbed in this POC

- PDP/Synapse integration:
  - PieceCID computation is real using `@web3-storage/data-segment` in Workers.
  - Store/deal initiation returns a queued state unless `@filoz/synapse-sdk` is available at runtime and `SYNAPSE_PRIVATE_KEY` is set; see “Synapse integration” below.
- Payments/billing: the `/pricing` endpoint states the model ($5/GB/month after first 6 months or 1 GB) and currencies (USD/ETH), but there is no real checkout.
- OpenScion engine vs POC service:
  - The Rust engine continues to use BLAKE3 object ids for trees/changesets. For blobs, PieceCID (CommP v2) is the intended external identifier; a first-class engine mapping layer is planned so stored content is addressed natively by PieceCID while internal DAG nodes (trees/changesets) remain BLAKE3 for canonical encodings and engine invariants.
 
### Synapse integration (uploads/downloads)

- Real Synapse SDK (`@filoz/synapse-sdk`) can be dynamically imported at runtime to call:
  - `storage.upload(Uint8Array)` and `storage.download({ pieceCid })`.
  - In this POC build, the SDK is not bundled by default to keep the Worker minimal and avoid bundler issues with package subpath exports. If you need real uploads/downloads:
    - Add `@filoz/synapse-sdk` to `apps/worker/package.json` and provide `SYNAPSE_PRIVATE_KEY`.
    - Ensure your bundler (wrangler/esbuild) treats `@filoz/synapse-sdk` as external or is able to resolve its subpath exports.
    - On success, `POST /orgs/{org}/uploads` with `bytesBase64` will invoke Synapse for storage; `GET /orgs/{org}/pieces/{cid}/bytes` will use Synapse for retrieval.

### Cloudflare Containers (routing model)

- The Rust service runs inside a Cloudflare Container (Dockerfile included) and exposes the existing OpenScion HTTP API plus Filecoin endpoints (see PR notes). A thin Worker/DO front handles:
  - org‑scoped routing (`/orgs/{org}/...`) and D1 queries (one DB per org, bound as `DB_<ORG>`),
  - forwarding engine requests to the container (e.g., health checks now; compute/store hooks can be routed here as the mapping layer matures).
- For production, configure a Container deployment in Wrangler (Containers) and bind the Worker front to the container service. For local dev, use `docker compose` for the server and `wrangler dev` for the Worker.

### Deploy

After configuring the D1 binding and secrets in your Cloudflare account:

```sh
cd apps/worker
# optional: update to the latest wrangler first
npm i -D wrangler@latest
# run DB migrations on remote
npx wrangler d1 migrations apply DB_FILECOIN_PROJECT --remote
# deploy the worker
npx wrangler deploy
```

## Development

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo build --all-targets --all-features
cargo test --all-features
```

CI runs those four checks. It also requires 90% line coverage in every source
file, builds rustdoc with `-D warnings`, builds with the MSRV, runs a
`cargo-deny` supply-chain check, and asserts that `openscion-proto` stays free
of transports and runtimes. To run the extra checks locally:

```sh
cargo doc --no-deps --all-features   # CI builds this with RUSTDOCFLAGS="-D warnings"
cargo deny check all
cargo install cargo-llvm-cov         # once
.github/scripts/check-file-coverage.sh 90 coverage.json
```

## Releasing

Run the **Release** workflow from the Actions tab and pick a `patch`, `minor`,
or `major` bump. The workflow re-validates the workspace, bumps the shared
`[workspace.package]` version, tags it, publishes `openscion-proto`,
`openscion-core`, and `openscion` to crates.io (using the
`CARGO_REGISTRY_TOKEN` secret), and creates a GitHub release. Do not edit the
version in the root `Cargo.toml` by hand.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Behavior changes start in
[`docs/specs/`](docs/specs/README.md); each accepted spec gets a test-first
plan in [`docs/plans/`](docs/plans/README.md) before any code is written.

## License

GPL-3.0-only. See [`LICENSE`](LICENSE).
