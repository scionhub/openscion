//! Shared-piece skipping, protected-repo refusal, and delete response shape.

import {
  deleteRepoJson,
  mapBundleCidsToPieceIds,
  parseForceFlag,
  planPieceRemoval,
} from "./repo_delete";
import {
  isProtectedRepo,
  PROTECTED_REPOS,
  protectedDeleteDenied,
  protectedDeleteMessage,
} from "./owners";

const admin = { userId: "u-admin", name: "root", admin: true };

if (!PROTECTED_REPOS.includes("filecoin-project/curio") || !PROTECTED_REPOS.includes("filecoin-project/lotus")) {
  throw new Error("curio and lotus must be protected");
}
if (protectedDeleteDenied("filecoin-project", "curio", admin) !== 403) {
  throw new Error("curio must be refused even for a site admin");
}
if (protectedDeleteDenied("filecoin-project", "lotus", admin) !== 403) {
  throw new Error("lotus must be refused even for a site admin");
}
if (protectedDeleteDenied("alice", "demo", admin) !== null) {
  throw new Error("unprotected repos must not hit the hard delete block");
}
if (protectedDeleteMessage("filecoin-project", "curio") !== "cannot delete filecoin-project/curio") {
  throw new Error("protected delete must name the repo");
}
if (!isProtectedRepo("filecoin-project", "curio")) {
  throw new Error("isProtectedRepo must still match curio");
}

const pendingOnly = planPieceRemoval({
  registered: ["bafk-a", "bafk-pending"],
  pending: ["bafk-pending"],
  shared: [],
});
if (pendingOnly.toRemove.join() !== "bafk-a" || pendingOnly.pendingDropped !== 1) {
  throw new Error("pending bundles must be dropped, not scheduled for removal");
}
if (pendingOnly.skippedShared !== 0) {
  throw new Error("pending drop is not a shared skip");
}

const sharedSkip = planPieceRemoval({
  registered: ["bafk-own", "bafk-shared", "bafk-shared"],
  pending: [],
  shared: ["bafk-shared"],
});
if (sharedSkip.toRemove.join() !== "bafk-own") {
  throw new Error("shared bundles must be skipped");
}
if (sharedSkip.skippedShared !== 1) {
  throw new Error("duplicate shared CID must count as one skip");
}

const both = planPieceRemoval({
  registered: ["keep", "share", "pend"],
  pending: ["pend"],
  shared: ["share"],
});
if (both.toRemove.join() !== "keep" || both.skippedShared !== 1 || both.pendingDropped !== 1) {
  throw new Error("pending drop and shared skip must compose");
}

const empty = planPieceRemoval({ registered: [], pending: [], shared: [] });
if (empty.toRemove.length !== 0 || empty.skippedShared !== 0) {
  throw new Error("empty repo must plan zero removals");
}

const mapped = mapBundleCidsToPieceIds(
  ["bafk-a", "bafk-b", "bafk-a", "missing"],
  [
    { pieceCid: "bafk-a", pieceId: 11 },
    { pieceCid: "bafk-b", pieceId: 12 },
  ]
);
if (mapped.pieceIds.join() !== "11,12") {
  throw new Error("CID map must emit unique on-chain piece ids in first-seen order");
}
if (mapped.unresolved.join() !== "missing") {
  throw new Error("unmapped CIDs must be reported unresolved");
}

const forceOk = parseForceFlag({ confirm: "alice/demo", force: true });
if (!forceOk.ok || !forceOk.force) throw new Error("force true must parse");
const forceOff = parseForceFlag({ confirm: "alice/demo" });
if (!forceOff.ok || forceOff.force) throw new Error("missing force must default false");
if (parseForceFlag({ force: "yes" }).ok) throw new Error("non-boolean force must fail");

const body = deleteRepoJson({ removedPieces: 3, skippedShared: 2, tx: "0xabc" });
if (body.deleted !== true || body.removedPieces !== 3 || body.skippedShared !== 2 || body.tx !== "0xabc") {
  throw new Error("delete response must be {deleted, removedPieces, skippedShared, tx}");
}
const noTx = deleteRepoJson({ removedPieces: 0, skippedShared: 1, tx: null });
if (noTx.tx !== null) throw new Error("tx must be null when no removal was submitted");
