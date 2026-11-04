//! Hard-coded Curio production PieceCIDs used by the non-Filecoin API suite.
//!
//! Live `GET /v1/repos/filecoin-project/curio/changesets/{main}` returned 400
//! (`InvalidChange` / changesets fetch failed — known tip issue, open PR #7),
//! so these are taken from committed fixtures rather than a live tree walk.
//! Both are PieceCID v2 (`bafkzci…`, the form this PoC stores); the older
//! `baga…` CommP spelling does not appear in this tree.

/** Source: `crates/openscion-server/src/pdp/mod.rs` typed-data AddPieces fixture. */
export const CURIO_PIECE_A =
  "bafkzcibeuc4a2dvtor6eqkb2c6wbs5sxxesah5j76jg74oksxqh3ruhzmstlrcnqhm";

/** Source: `apps/worker/src/repo_delete.test.ts` padded-size fixture. */
export const CURIO_PIECE_B =
  "bafkzcibdquhar56zu34ur45sr2dw47vzaifuipgtxdsml2awx3lmctcsofjjdhrr";

export const PIECE_SOURCES = {
  [CURIO_PIECE_A]: "crates/openscion-server/src/pdp/mod.rs (AddPieces typed-data fixture)",
  [CURIO_PIECE_B]: "apps/worker/src/repo_delete.test.ts (paddedSizeFromPieceCid fixture)",
} as const;
