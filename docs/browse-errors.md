# Browse errors: missing repo vs missing ref

Anonymous web reads (`tree`, `blob`, `commits`, `branches`, and similar) must
not confuse a missing catalog entry with a missing branch. Ref lookup accepts
both the short name (`main`) and `refs/heads/main` via
`lookup_ref_names` / `lookupRefNames`.

The live catalog check is Worker D1 (`GET /v1/repos/{org}/{repo}`). The engine
still creates an empty in-memory repo on first access, so browse must not
reach it for an unknown org/repo.

## Missing repository

Unknown `org/repo` on every browse read matches `GET /v1/repos/{org}/{repo}`:
HTTP 404 and `{"error":"not found"}`. Not an empty `{"branches":[]}`, and not
`ref "main" not found`.

```sh
# Expected: HTTP 404, {"error":"not found"}
curl -sS -D - "https://api.scionbase.ai/v1/repos/filecoin-project/synapse-sdk"
curl -sS -D - "https://api.scionbase.ai/v1/repos/filecoin-project/synapse-sdk/tree/main"
curl -sS -D - "https://api.scionbase.ai/v1/repos/filecoin-project/synapse-sdk/tree/refs%2Fheads%2Fmain"
curl -sS -D - "https://api.scionbase.ai/v1/repos/filecoin-project/synapse-sdk/branches"
curl -sS -D - "https://api.scionbase.ai/v1/repos/filecoin-project/synapse-sdk/commits/main"
```

## Short vs full ref on a real repo

`andy/synapse-201438` stores `main` as the short name and `demo-pr` as
`refs/heads/demo-pr`. Both forms must resolve:

```sh
# Expected: HTTP 200 tree JSON (same commit)
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://api.scionbase.ai/v1/repos/andy/synapse-201438/tree/main"
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://api.scionbase.ai/v1/repos/andy/synapse-201438/tree/refs%2Fheads%2Fmain"

# Expected: HTTP 200 for both stored-as-full forms
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://api.scionbase.ai/v1/repos/andy/synapse-201438/tree/demo-pr"
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://api.scionbase.ai/v1/repos/andy/synapse-201438/tree/refs%2Fheads%2Fdemo-pr"
```

Local fixture (engine tests): create `acme/alias`, store `main` short and
`refs/heads/demo-pr` full; `GET .../tree/{main,refs/heads/main,demo-pr,refs/heads/demo-pr}`
are all 200.

## Missing ref on an existing repo

```sh
# Expected: HTTP 404, engine {"code":"NotFound","message":"ref \"no-such-branch\" not found"}
# (or Worker fallback {"code":"NoSuchRef","message":"no such ref: no-such-branch"})
curl -sS -D - "https://api.scionbase.ai/v1/repos/andy/synapse-201438/tree/no-such-branch"
```

Not `{"error":"not found"}` — that body is reserved for a missing catalog repo.

## Piece resolve (no engine hairpin)

`POST /v1/repos/{org}/{repo}/objects/resolve` is answered by the Worker from
RepoDO `bundles/resolve`, then the provider URL is attached. It must not 400
with `invalid change at "repodo": resolve failed` when the engine cannot
hairpin HTTP back to the Worker.

```sh
# Expected: HTTP 200, results[0] has pieceCid, bundleCid, offset, length, url
curl -sS -D - -H 'content-type: application/json' \
  -d '{"ids":["bafkzcibd2qhqph2qowi3fezoxnss3fcf5kcuvjgsgtge6ai4rzovuqtsyaqtcojb"]}' \
  "https://api.scionbase.ai/v1/repos/andy/synapse-201438/objects/resolve"
```

`GET .../blob/main?path=README.md` still returns `contentBase64` for small
files; after this change it also fills `url` / `offset` / `length` from the
same RepoDO map so SP Range GETs work.
