//! Browse catalog gating, short vs full ref aliases, and blob RepoDO fallback.

import {
  attachBlobResolve,
  attachResolveUrls,
  blobPathError,
  browseRepoFromPath,
  buildBlobFallback,
  bytesToBase64,
  fallbackBlobFromRepoDO,
  fillBlobLocation,
  findStoredRef,
  groupBundleRows,
  lookupRefNames,
  pieceUrl,
  resolvePiecesFromRepoDO,
  resolveRequestIds,
} from "./browse";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

ok(browseRepoFromPath("/v1/repos/filecoin-project/synapse-sdk/tree/main")?.repo === "synapse-sdk", "tree");
ok(browseRepoFromPath("/v1/repos/andy/synapse-201438/blob/refs%2Fheads%2Fmain")?.org === "andy", "blob");
ok(browseRepoFromPath("/v1/repos/andy/demo/commits/main")?.repo === "demo", "commits");
ok(browseRepoFromPath("/v1/repos/andy/demo/branches")?.repo === "demo", "branches");
ok(browseRepoFromPath("/v1/repos/andy/demo/compare/main...head")?.repo === "demo", "compare");
ok(browseRepoFromPath("/v1/repos/andy/demo/diff")?.repo === "demo", "diff");
ok(browseRepoFromPath("/v1/repos/andy/demo/refs/main")?.repo === "demo", "refs");
ok(browseRepoFromPath("/v1/repos/andy/synapse-201438/objects/resolve")?.repo === "synapse-201438", "resolve");
ok(
  browseRepoFromPath("/v1/repos/andy/synapse-201438/objects/bafkzcibd2qhqph2qowi3fezoxnss3fcf5kcuvjgsgtge6ai4rzovuqtsyaqtcojb")
    ?.org === "andy",
  "object hint"
);
ok(browseRepoFromPath("/v1/repos/andy/demo") === null, "repo GET is not browse");
ok(browseRepoFromPath("/v1/repos/andy/demo/settings") === null, "settings is not browse");
ok(browseRepoFromPath("/v1/repos/andy/demo/pulls") === null, "pulls is not browse");
ok(browseRepoFromPath("/v1/repos/andy/demo/objects") === null, "objects batch is not browse");

ok(JSON.stringify(resolveRequestIds({ ids: ["bafk1"] })) === JSON.stringify(["bafk1"]), "ids");
ok(JSON.stringify(resolveRequestIds({ pieceCids: ["bafk2"] })) === JSON.stringify(["bafk2"]), "pieceCids");
ok(resolveRequestIds({ ids: [1, ""] }).length === 0, "ignore non-strings");

const hits = attachResolveUrls(
  [{ pieceCid: "pcid", bundleCid: "bundle", offset: 10, length: 20 }],
  "https://team-server.curiostorage.org/"
);
ok(hits.length === 1 && hits[0]!.url === "https://team-server.curiostorage.org/piece/bundle", "url");
ok(hits[0]!.offset === 10 && hits[0]!.length === 20, "range");
ok(pieceUrl("https://sp.example", "bafk") === "https://sp.example/piece/bafk", "piece url");
ok(attachResolveUrls([{ pieceCid: "x" }], "https://sp").length === 0, "incomplete row");

ok(JSON.stringify(lookupRefNames("main")) === JSON.stringify(["main", "refs/heads/main"]), "short");
ok(
  JSON.stringify(lookupRefNames("refs/heads/main")) === JSON.stringify(["refs/heads/main", "main"]),
  "full"
);
ok(
  JSON.stringify(lookupRefNames("users/alice/feat")) ===
    JSON.stringify(["users/alice/feat", "refs/heads/users/alice/feat"]),
  "user short"
);
ok(JSON.stringify(lookupRefNames("refs/tags/v1")) === JSON.stringify(["refs/tags/v1"]), "tag");
ok(lookupRefNames("").length === 0, "empty");

const storedShort = [{ name: "main", target: "aa" }, { name: "demo-pr", target: "bb" }];
ok(findStoredRef(storedShort, "main")?.target === "aa", "short stored, short query");
ok(findStoredRef(storedShort, "refs/heads/main")?.target === "aa", "short stored, full query");
ok(findStoredRef(storedShort, "missing") === undefined, "missing ref on existing list");

const storedFull = [{ name: "refs/heads/demo-pr", target: "cc" }];
ok(findStoredRef(storedFull, "demo-pr")?.target === "cc", "full stored, short query");
ok(findStoredRef(storedFull, "refs/heads/demo-pr")?.target === "cc", "full stored, full query");

ok(browseRepoFromPath("/v1/repos/ghost/nope/blob/main") !== null, "unknown repo blob is still catalog-gated");
ok(blobPathError("") !== null && blobPathError("")!.status === 400, "missing path 400");
ok(blobPathError("   ") !== null && blobPathError("/")!.status === 400, "blank path 400");

const README_PIECE = "bafkzcibd2qhqph2qowi3fezoxnss3fcf5kcuvjgsgtge6ai4rzovuqtsyaqtcojb";
const headId = "aa".repeat(32);
const refs = [{ name: "refs/heads/main", target: headId, version: 1 }];
const changesets = [
  {
    id: headId,
    lsn: 1,
    root_tree: "bb".repeat(32),
    changeset: {
      parents: [],
      changes: [{ op: "upsert" as const, path: "README.md", kind: "file" as const, blob: "cc".repeat(32) }],
      author: "andy",
      message: "init",
      created_at: 1,
      metadata: { "pcid:README.md": README_PIECE },
    },
  },
];
const built = buildBlobFallback({
  refs,
  changesets,
  rev: "main",
  path: "README.md",
  org: "andy",
  repo: "synapse-201438",
});
ok(built.ok, "blob fallback builds for main");
if (built.ok) {
  ok(built.body.pieceCid === README_PIECE, "pieceCid from metadata");
  ok(built.body.blob === "cc".repeat(32), "blob id");
  ok(built.body.path === "README.md", "path");
  const attached = attachBlobResolve(built.body, {
    pieceCid: README_PIECE,
    bundleCid: "bafkbundle",
    offset: 0,
    length: 42,
    url: "https://team-server.curiostorage.org/piece/bafkbundle",
  });
  ok(attached.url === "https://team-server.curiostorage.org/piece/bafkbundle", "url attach");
  ok(attached.offset === 0 && attached.length === 42 && attached.size === 42, "range attach");
}
ok(buildBlobFallback({ refs, changesets, rev: "main", path: "", org: "andy", repo: "x" }).ok === false, "empty path fails");
ok(
  (buildBlobFallback({ refs, changesets, rev: "main", path: "", org: "andy", repo: "x" }) as { status: number }).status === 400,
  "empty path status 400"
);

function mockRepoEnv(data: {
  refs: { name: string; target: string; version: number }[];
  changesets: unknown[];
  bundles: { pieceCid: string; bundleCid: string; offset: number; length: number }[];
  legacyBundles?: { pieceCid: string; bundleCid: string; offset: number; length: number }[];
  objects?: Record<string, string>;
  writes?: { url: string; body: string }[];
}) {
  const writes = data.writes ?? [];
  return {
    PDP_BASE_URL: "https://team-server.curiostorage.org",
    INTERNAL_SECRET: "s",
    REPO: {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          const u = new URL(req.url);
          const name = String(id);
          const legacy = name.startsWith("filecoin-project/");
          if (u.pathname.endsWith("/refs")) return Response.json({ refs: data.refs });
          if (u.pathname.endsWith("/changesets")) return Response.json({ changesets: data.changesets });
          if (u.pathname.endsWith("/bundles/resolve")) {
            const body = (await req.json()) as { pieceCids?: string[] };
            const ids = new Set(body.pieceCids ?? []);
            const rows = (legacy ? data.legacyBundles ?? [] : data.bundles).filter((b) => ids.has(b.pieceCid));
            return Response.json({ results: rows });
          }
          if (u.pathname.endsWith("/bundle-map") && req.method === "POST") {
            writes.push({ url: u.pathname, body: await req.text() });
            return Response.json({ ok: true });
          }
          const obj = u.pathname.match(/\/objects\/([^/]+)$/);
          if (obj && req.method === "GET") {
            const b64 = data.objects?.[decodeURIComponent(obj[1]!)];
            if (!b64) return new Response("no", { status: 404 });
            return Response.json({ id: obj[1], bytesBase64: b64 });
          }
          return new Response("no", { status: 404 });
        },
      }),
    },
    ENGINE: { idFromName: () => ({}), get: () => ({}) },
  } as unknown as Parameters<typeof fallbackBlobFromRepoDO>[0];
}

const env = mockRepoEnv({
  refs,
  changesets,
  bundles: [{ pieceCid: README_PIECE, bundleCid: "bafkbundle", offset: 8, length: 99 }],
});
const origin = new URL("https://api.scionbase.ai/v1/repos/andy/synapse-201438/blob/main?path=README.md");
const fallback = await fallbackBlobFromRepoDO(env, origin, "andy", "synapse-201438", "main", "README.md");
ok(fallback !== null && fallback.status === 200, "engine-fail blob fallback 200");
const fb = (await fallback!.json()) as { pieceCid?: string; url?: string; offset?: number; length?: number };
ok(fb.pieceCid === README_PIECE, "fallback pieceCid");
ok(fb.url === "https://team-server.curiostorage.org/piece/bafkbundle", "fallback url");
ok(fb.offset === 8 && fb.length === 99, "fallback range");

const noPath = await fallbackBlobFromRepoDO(env, origin, "andy", "synapse-201438", "main", "");
ok(noPath !== null && noPath.status === 400, "fallback missing path 400");

const grouped = groupBundleRows([
  { pieceCid: "a", bundleCid: "b1", offset: 0, length: 2 },
  { pieceCid: "c", bundleCid: "b1", offset: 2, length: 3 },
  { pieceCid: "skip" },
]);
ok(grouped.length === 1 && grouped[0]!.members.length === 2, "group members");

const writes: { url: string; body: string }[] = [];
const legacyEnv = mockRepoEnv({
  refs,
  changesets,
  bundles: [],
  legacyBundles: [{ pieceCid: README_PIECE, bundleCid: "bafklegacy", offset: 4, length: 11 }],
  writes,
});
const legacyHits = await resolvePiecesFromRepoDO(
  legacyEnv,
  origin,
  "andy",
  "synapse-201438",
  [README_PIECE]
);
ok(legacyHits.length === 1 && legacyHits[0]!.bundleCid === "bafklegacy", "legacy org map");
ok(legacyHits[0]!.url === "https://team-server.curiostorage.org/piece/bafklegacy", "legacy url");
ok(writes.some((w) => w.url.includes("/andy/synapse-201438/bundle-map")), "self-heal copy");

const emptyHits = await resolvePiecesFromRepoDO(legacyEnv, origin, "andy", "synapse-201438", ["bafkmissing"]);
ok(emptyHits.length === 0, "unknown piece stays empty");

const blobId = "cc".repeat(32);
const inlineEnv = mockRepoEnv({
  refs,
  changesets,
  bundles: [],
  objects: { [blobId]: bytesToBase64(new TextEncoder().encode("# synapse\n")) },
});
const inlined = await fillBlobLocation(inlineEnv, origin, "andy", "synapse-201438", {
  pieceCid: README_PIECE,
  blob: blobId,
  url: null,
  offset: null,
  length: null,
  size: null,
});
ok(inlined.url == null, "inline does not invent an SP url");
ok(inlined.contentBase64 === btoa("# synapse\n"), "contentBase64 from RepoDO objects");
ok(inlined.size === 10, "inline size");

const inlineFallback = await fallbackBlobFromRepoDO(
  inlineEnv,
  origin,
  "andy",
  "synapse-201438",
  "main",
  "README.md"
);
ok(inlineFallback !== null && inlineFallback.status === 200, "empty-map fallback still 200");
const inlineBody = (await inlineFallback!.json()) as { contentBase64?: string; url?: string | null };
ok(inlineBody.contentBase64 === btoa("# synapse\n"), "fallback inlines README bytes");
ok(inlineBody.url == null, "fallback url stays null without a map row");

console.log("browse ok");
