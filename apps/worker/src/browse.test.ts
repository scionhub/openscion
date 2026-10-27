//! Browse catalog gating and short vs full ref aliases.

import {
  attachResolveUrls,
  browseRepoFromPath,
  findStoredRef,
  lookupRefNames,
  pieceUrl,
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

console.log("browse ok");
