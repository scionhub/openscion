# Self-hosting ScionBase

Run the Worker, its D1 databases, and the EngineContainer on your own
Cloudflare account. Clients then clone with `scn clone <your-host>/<org>/<repo>`.

## What runs

- **Worker** (`apps/worker`) — HTTP API, auth, catalog, and PieceCID maps.
- **D1** — `DB_SCIONHUB_TOP` (users, tokens) and `ORGS_DB` (orgs, repos, pulls).
- **EngineContainer** — the Rust engine, one Durable Object container
  (`containers/openscion-server/Dockerfile`, port 7878). RepoDO and D1Gateway
  are Durable Objects in the same Worker.

`GET /.well-known/scionbase` returns `{ "api_base": "<origin>" }`. Set the
`API_BASE` var when the public API origin is not the host that received the
request. `scn` uses that value; if the document is missing it uses `https://host`.

## Bindings

From `wrangler.toml`:

| Binding | Kind | Role |
| --- | --- | --- |
| `DB_SCIONHUB_TOP` | D1 `scionhub-top` | accounts and tokens (`migrations/top`) |
| `ORGS_DB` | D1 `scionbase-orgs` | orgs, repos, history metadata (`migrations/orgs`) |
| `ENGINE` | Durable Object `EngineContainer` | engine container |
| `REPO` | Durable Object `RepoDO` | per-repo PieceCID and ref metadata |
| `D1GW` | Durable Object `D1Gateway` | engine reads of D1 |

Create the D1 databases, put their ids in `wrangler.toml`, then apply migrations
from `apps/worker`:

```sh
npx wrangler d1 migrations apply scionhub-top --remote
npx wrangler d1 migrations apply scionbase-orgs --remote
```

`migrations/filecoin-project` is the older per-org schema and is not required
for a new install.

## Secrets and vars

Set secrets with `npx wrangler secret put <NAME>`:

- `INTERNAL_SECRET` — Worker to engine and RepoDO. The container receives it
  as `INTERNAL_SECRET`, and `WORKER_BASE_URL` is set to the request origin.
- `ADMIN_TOKEN` — `/v1/admin/*`.
- `PDP_PRIVATE_KEY`, `SYNAPSE_API_KEY`, `SYNAPSE_PRIVATE_KEY` — Filecoin
  Calibration uploads. Omit them to run the API without on-chain adds.

Non-secret vars already in `wrangler.toml` (`PDP_BASE_URL`, `PDP_CHAIN_ID`,
`PDP_SERVICE_CONTRACT`, `PDP_PAYER`, `PDP_PAYEE`, batching limits) can stay or
be replaced. `CONTAINER_URL` is only for a local engine (`wrangler dev`);
production uses the container binding.

Deploy:

```sh
npx wrangler deploy
```

## Custom domain

Attach the hostname in the Cloudflare dashboard (Workers → your worker →
Settings → Domains & Routes), or add a route in `wrangler.toml`:

```toml
routes = [{ pattern = "git.example/*", zone_name = "example" }]
```

The hostname must serve `GET /.well-known/scionbase`. Then:

```sh
scn login git.example --user alice
scn clone https://git.example/alice/widgets
```

A second server is another deployment. `scn remote add` and `scn push other`
copy history by PieceCID and upload only pieces the destination lacks. Create
the repo on that server first, or `scn push --create other main`.
