//! Path helpers and snapshot/persist shaping for engine restore.

import {
  isRepoWrite,
  persistEngineWrite,
  persistKind,
  refNameFromPath,
  repoScope,
  type ContainerFetch,
  type RestoreEnv,
} from "./restore";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

ok(repoScope("/v1/repos/andy/demo/blobs")?.org === "andy", "blobs scope org");
ok(repoScope("/v1/repos/andy/demo/blobs")?.repo === "demo", "blobs scope repo");
ok(repoScope("/v1/orgs/andy/repos") === null, "org list is not a repo scope");
ok(isRepoWrite("POST", "/v1/repos/andy/demo/blobs"), "POST blobs is a write");
ok(isRepoWrite("PUT", "/v1/repos/andy/demo"), "PUT create is a write");
ok(!isRepoWrite("GET", "/v1/repos/andy/demo/refs/main"), "GET ref is not a write");
ok(persistKind("POST", "/v1/repos/andy/demo/blobs") === null, "blobs are not RepoDO metadata");
ok(persistKind("POST", "/v1/repos/andy/demo/changesets") === "changeset", "changeset persist");
ok(persistKind("POST", "/v1/repos/andy/demo/refs/main") === "ref", "ref persist");
ok(persistKind("DELETE", "/v1/repos/andy/demo/refs/heads%2Fmain") === "ref-delete", "ref delete");
ok(refNameFromPath("/v1/repos/andy/demo/refs/heads%2Fmain") === "heads/main", "ref name decode");

type Posted = { url: string; method: string; body: string };
const posted: Posted[] = [];
const env: RestoreEnv = {
  INTERNAL_SECRET: "s",
  REPO: {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get() {
      return {
        fetch: async (request: Request) => {
          posted.push({
            url: request.url,
            method: request.method,
            body: await request.text(),
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace,
};

const record: ContainerFetch = async (url, init) => {
  if (url.includes("/changesets/") && (init.method ?? "GET") === "GET") {
    return new Response(
      JSON.stringify({
        id: "aa".repeat(32),
        lsn: 1,
        root_tree: "bb".repeat(32),
        parents: [],
        changes: [],
        author: "andy",
        message: "import",
        created_at: 1,
        metadata: {},
      })
    );
  }
  return new Response("nope", { status: 404 });
};

await persistEngineWrite(
  env,
  new URL("https://api.scionbase.ai/"),
  "andy",
  "demo",
  "changeset",
  undefined,
  new TextEncoder().encode(JSON.stringify({ id: "aa".repeat(32), lsn: 1, root_tree: "bb".repeat(32) }))
    .buffer,
  record
);

ok(posted.length === 1, "one changeset persist");
ok(posted[0]!.url.includes("/__internal/do/andy/demo/changesets"), "changeset URL");
const changesetBody = JSON.parse(posted[0]!.body) as { changeset: { author: string }; id: string };
ok(changesetBody.changeset.author === "andy", "wrapped changeset body");
ok(changesetBody.id === "aa".repeat(32), "changeset id");

posted.length = 0;
await persistEngineWrite(
  env,
  new URL("https://api.scionbase.ai/"),
  "andy",
  "demo",
  "ref",
  "main",
  new TextEncoder().encode(JSON.stringify({ name: "main", target: "aa".repeat(32), version: 1 }))
    .buffer,
  record
);
ok(posted.length === 1 && posted[0]!.url.includes("/refs"), "ref persist URL");
const refBody = JSON.parse(posted[0]!.body) as { name: string; version: number };
ok(refBody.name === "main" && refBody.version === 1, "ref body");

posted.length = 0;
await persistEngineWrite(
  env,
  new URL("https://api.scionbase.ai/"),
  "andy",
  "demo",
  "ref-delete",
  "main",
  new ArrayBuffer(0),
  record
);
ok(posted[0]!.method === "DELETE" && posted[0]!.url.includes("/refs/main"), "ref delete");
