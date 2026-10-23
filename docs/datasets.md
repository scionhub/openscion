# Shared Filecoin datasets

New organizations do **not** get their own on-chain PDP dataset. Pieces are
added to the shared platform dataset (`filecoin-project`, on-chain id **46121**)
so each signup does not pay the per-dataset create fee.

## Which dataset an org uses

Resolution, in order:

1. The org already has a `datasets` row with a non-empty `onchain_id` (it paid
   and created one) → keep using that org’s dataset.
2. An admin recorded `mode = own` on `org_datasets` → use that org; the dataset
   is created lazily on the next add-pieces call.
3. Otherwise → shared platform dataset. The RepoDO alarm sends
   `{ org: "filecoin-project", pieces, allow_create: false }` so the engine
   never creates a dataset for a shared-mode org.

`POST /v1/admin/orgs/{org}/dataset-mode` with `{ "mode": "own" | "shared" }`
records intent only. Marking `own` does not create on-chain immediately; that
happens on the next add, which is the explicit paid decision.

## Size threshold (40 GiB)

`SHARED_DATASET_MAX_BYTES` (default **42949672960**, 40 GiB) is below the
~49 GiB point where the 0.12 USDFC/month per-dataset minimum stops dominating
at 2.5 USDFC/TiB/month. Approximate usage is the sum of padded bundle sizes
actually added (minimum 128 bytes per bundle), stored in `dataset_usage` on
`ORGS_DB`.

When the shared dataset is over the threshold, `GET /v1/admin/durability`
includes `sharedDataset: { bytes, threshold, over: true }`. Nothing is
auto-created; an admin decides whether a given org should switch to `own`.

## Batching

Pending on-chain adds sit in each RepoDO until **either**:

- the oldest pending bundle is at least `ADD_BATCH_WINDOW_SECS` old (default
  **3600**), or
- pending count reaches `ADD_BATCH_MAX_PIECES` (default **50**), or
- an admin kicks (`POST /v1/admin/repos/{org}/{repo}/kick`).

The alarm then sends **all** due bundles in one add-pieces call (capped at
`ADD_BATCH_MAX_PIECES`). The 4h stale watchdog is unchanged and is longer than
the default window, so items that are only waiting for the window are not
flagged stale. `GET /v1/admin/durability` reports `nextDrainAt` per repo.

**Trade-off:** new data waits up to the window before it is added to the
on-chain dataset. Until then it lives only in the storage provider’s parked
storage plus engine memory, so durability is weaker in that window.
