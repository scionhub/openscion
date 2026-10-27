/** Anonymous tree/compare helpers that fill file sizes from the bundle map. */

/** Pre-`2c8b182` uploads wrote user-repo maps under the platform engine org. */
export const LEGACY_BUNDLE_ORG = "filecoin-project";
/** Match engine `get_blob`: inline at most 1 MiB when the piece map has no row. */
export const INLINE_BLOB_MAX = 1_048_576;

/** Catalog-backed browse reads: missing repos must not look like a missing ref. */
const BROWSE_READ =
  /^\/v1\/repos\/([^/]+)\/([^/]+)\/(tree|blob|commits|branches|compare|diff|refs|file-map)(?:\/|$)/;
/** Piece resolve / object hint: same catalog check, Worker→RepoDO (no engine hairpin). */
const OBJECTS_READ = /^\/v1\/repos\/([^/]+)\/([^/]+)\/objects\/(resolve|[^/]+)$/;

/**
 * `{org, repo}` when `path` is a browse read (`tree` / `blob` / `commits` /
 * `branches` / `compare` / `diff` / `refs`) or an object resolve/hint.
 */
export function browseRepoFromPath(path: string): { org: string; repo: string } | null {
  const match = path.match(BROWSE_READ) ?? path.match(OBJECTS_READ);
  if (!match) return null;
  return { org: decodeURIComponent(match[1]!), repo: decodeURIComponent(match[2]!) };
}

/** PieceCIDs from `POST .../objects/resolve` (`ids` or `pieceCids`). */
export function resolveRequestIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as { ids?: unknown; pieceCids?: unknown }).ids
    ?? (body as { pieceCids?: unknown }).pieceCids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** SP piece URL, matching engine `first_provider_url` + `/piece/{bundle}`. */
export function pieceUrl(providerBase: string, bundleCid: string): string {
  return `${providerBase.replace(/\/+$/, "")}/piece/${bundleCid}`;
}

export type BundleHit = {
  pieceCid: string;
  bundleCid: string;
  offset: number;
  length: number;
  url: string;
};

/** Attach provider URLs to RepoDO bundle rows. */
export function attachResolveUrls(
  rows: { pieceCid?: string; bundleCid?: string; offset?: number; length?: number }[],
  providerBase: string
): BundleHit[] {
  const out: BundleHit[] = [];
  for (const row of rows) {
    if (!row.pieceCid || !row.bundleCid || row.offset == null || row.length == null) continue;
    out.push({
      pieceCid: row.pieceCid,
      bundleCid: row.bundleCid,
      offset: row.offset,
      length: row.length,
      url: pieceUrl(providerBase, row.bundleCid),
    });
  }
  return out;
}

/**
 * Names to try when looking up `name`, matching `openscion_core::lookup_ref_names`.
 *
 * A short name tries the short form (legacy `main`) then `refs/heads/<name>`.
 * A full `refs/heads/...` name tries that first, then the short form.
 */
export function lookupRefNames(name: string): string[] {
  const trimmed = name.trim().replace(/^\/+/, "");
  if (!trimmed) return [];
  const names = [trimmed];
  if (trimmed.startsWith("refs/heads/")) {
    const rest = trimmed.slice("refs/heads/".length);
    if (rest) names.push(rest);
  } else if (!trimmed.startsWith("refs/")) {
    names.push(`refs/heads/${trimmed}`);
  }
  return names;
}

/** First stored ref whose name is an alias of `name`, or `undefined`. */
export function findStoredRef<T extends { name: string }>(refs: T[], name: string): T | undefined {
  const candidates = lookupRefNames(name);
  return refs.find((row) => candidates.includes(row.name));
}

type Env = {
  ENGINE?: DurableObjectNamespace;
  REPO?: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
  PDP_BASE_URL?: string;
};

function repoStub(env: Env, org: string, repo: string): DurableObjectStub | null {
  if (!env.REPO) return null;
  return env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
}

function providerBaseUrl(env: Env): string {
  return (env.PDP_BASE_URL || "").replace(/\/+$/, "");
}

type TreeEntry = {
  name?: string;
  kind?: string;
  size?: number | null;
  pieceCid?: string | null;
};

/** Tip path → COMMP from RepoDO `file_pieces`. Empty when the DO is unreachable. */
export async function fetchFileMap(
  env: Env,
  origin: URL,
  org: string,
  repo: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const stub = repoStub(env, org, repo);
  if (!stub) return out;
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/file-map`, origin).toString(), {
      method: "GET",
      headers: h,
    })
  );
  if (!r.ok) return out;
  const j = (await r.json()) as { files?: { path?: string; pieceCid?: string }[] };
  for (const row of j.files ?? []) {
    if (row.path && row.pieceCid) out.set(row.path, row.pieceCid);
  }
  return out;
}

/** Fill missing `pieceCid` on tree entries from the tip file-map. */
export function overlayFileMapOnEntries(
  entries: TreeEntry[],
  prefix: string,
  fileMap: Map<string, string>
): void {
  const base = prefix.replace(/^\/+|\/+$/g, "");
  for (const e of entries) {
    if (!e.name || e.kind === "dir") continue;
    if (e.pieceCid) continue;
    const full = base ? `${base}/${e.name}` : e.name;
    const cid = fileMap.get(full);
    if (cid) e.pieceCid = cid;
  }
}

export async function fillEntrySizes(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  entries: TreeEntry[]
): Promise<void> {
  const missing = entries.filter(
    (e) => e.kind !== "dir" && (e.size == null || e.size === undefined) && e.pieceCid
  );
  if (missing.length === 0) return;
  const lengths = await resolveLengths(
    env,
    origin,
    org,
    repo,
    missing.map((e) => e.pieceCid!).filter(Boolean)
  );
  for (const e of missing) {
    const n = e.pieceCid ? lengths.get(e.pieceCid) : undefined;
    if (n != null) e.size = n;
  }
}

type BundleRow = { pieceCid?: string; bundleCid?: string; offset?: number; length?: number };

async function fetchBundleRows(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  pieceCids: string[]
): Promise<BundleRow[]> {
  if (pieceCids.length === 0) return [];
  const stub = repoStub(env, org, repo);
  if (!stub) return [];
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  h.set("content-type", "application/json");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/bundles/resolve`, origin).toString(), {
      method: "POST",
      headers: h,
      body: JSON.stringify({ pieceCids }),
    })
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { results?: BundleRow[] };
  return j.results ?? [];
}

export async function resolveLengths(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  pieceCids: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const row of await fetchBundleRows(env, origin, org, repo, pieceCids)) {
    if (row.pieceCid && row.length != null) out.set(row.pieceCid, row.length);
  }
  return out;
}

export type BundleMapWrite = {
  bundleCid: string;
  members: { pieceCid: string; offset: number; length: number }[];
};

/** Group resolve rows by bundle so they can be copied onto another RepoDO. */
export function groupBundleRows(rows: BundleRow[]): BundleMapWrite[] {
  const by = new Map<string, { pieceCid: string; offset: number; length: number }[]>();
  for (const row of rows) {
    if (!row.pieceCid || !row.bundleCid || row.offset == null || row.length == null) continue;
    const list = by.get(row.bundleCid) ?? [];
    list.push({ pieceCid: row.pieceCid, offset: row.offset, length: row.length });
    by.set(row.bundleCid, list);
  }
  return [...by.entries()].map(([bundleCid, members]) => ({ bundleCid, members }));
}

/** Read every bundle + member from a RepoDO (admin backfill / self-heal). */
export async function exportBundleMaps(
  env: Env,
  origin: URL,
  org: string,
  repo: string
): Promise<BundleMapWrite[]> {
  const stub = repoStub(env, org, repo);
  if (!stub) return [];
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/bundles/export`, origin).toString(), {
      method: "GET",
      headers: h,
    })
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { bundles?: BundleMapWrite[] };
  return Array.isArray(j.bundles) ? j.bundles : [];
}

/** Write bundle-map rows through a DO stub (no public hairpin). */
export async function persistBundleMaps(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  bundles: BundleMapWrite[]
): Promise<number> {
  if (bundles.length === 0) return 0;
  const stub = repoStub(env, org, repo);
  if (!stub) return 0;
  let wrote = 0;
  for (const bundle of bundles) {
    if (!bundle.bundleCid || !Array.isArray(bundle.members) || bundle.members.length === 0) continue;
    const h = new Headers();
    h.set("x-internal-secret", env.INTERNAL_SECRET || "");
    h.set("content-type", "application/json");
    const r = await stub.fetch(
      new Request(new URL(`/__internal/do/${org}/${repo}/bundle-map`, origin).toString(), {
        method: "POST",
        headers: h,
        body: JSON.stringify(bundle),
      })
    );
    if (r.ok) wrote += 1;
  }
  return wrote;
}

/**
 * Resolve PieceCIDs via RepoDO (no engine→Worker hairpin) and attach SP URLs.
 * Empty when the bundle map has no row — not a 400. Tree `pcid:` metadata
 * can name a piece that is not yet in `bundle_members` (restore/map gap).
 *
 * User-repo imports before the path-org packer fix stored rows on
 * `filecoin-project/{repo}`. Missing ids are retried there and copied onto
 * `{org}/{repo}` so later resolves hit the canonical DO.
 */
export async function resolvePiecesFromRepoDO(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  pieceCids: string[]
): Promise<BundleHit[]> {
  const rows = await fetchBundleRows(env, origin, org, repo, pieceCids);
  const found = new Set(rows.map((r) => r.pieceCid).filter((id): id is string => !!id));
  const missing = pieceCids.filter((id) => !found.has(id));
  if (missing.length > 0 && org !== LEGACY_BUNDLE_ORG) {
    const legacy = await fetchBundleRows(env, origin, LEGACY_BUNDLE_ORG, repo, missing);
    if (legacy.length > 0) {
      rows.push(...legacy);
      await persistBundleMaps(env, origin, org, repo, groupBundleRows(legacy)).catch(() => 0);
    }
  }
  return attachResolveUrls(rows, providerBaseUrl(env));
}

/** Standard base64 for a byte array (chunked to stay under `apply` limits). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Small object bytes persisted on the RepoDO browse fallback. */
export async function fetchObjectBytesFromRepoDO(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  objectId: string
): Promise<Uint8Array | null> {
  if (!objectId) return null;
  const stub = repoStub(env, org, repo);
  if (!stub) return null;
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/objects/${encodeURIComponent(objectId)}`, origin).toString(), {
      method: "GET",
      headers: h,
    })
  );
  if (!r.ok) return null;
  const j = (await r.json()) as { bytesBase64?: string };
  if (typeof j.bytesBase64 !== "string" || j.bytesBase64.length === 0) return null;
  try {
    return base64ToBytes(j.bytesBase64);
  } catch {
    return null;
  }
}

export type BlobHint = {
  path?: string;
  pieceCid?: string | null;
  blob?: string | null;
  url?: string | null;
  offset?: number | null;
  length?: number | null;
  size?: number | null;
  contentBase64?: string;
};

/** Attach SP range and/or inline bytes onto an engine-shaped blob body. */
export async function fillBlobLocation(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  body: BlobHint
): Promise<BlobHint> {
  if (!body.pieceCid && body.path) {
    const fileMap = await fetchFileMap(env, origin, org, repo);
    body.pieceCid = fileMap.get(body.path.trim().replace(/^\/+|\/+$/g, "")) ?? body.pieceCid;
  }
  if (body.pieceCid && (body.url == null || body.offset == null)) {
    const hits = await resolvePiecesFromRepoDO(env, origin, org, repo, [body.pieceCid]);
    const next = attachBlobResolve(body as BlobFallbackBody, hits[0]);
    Object.assign(body, next);
  }
  if (body.url == null && !body.contentBase64 && body.blob) {
    const bytes = await fetchObjectBytesFromRepoDO(env, origin, org, repo, body.blob);
    if (bytes && bytes.length <= INLINE_BLOB_MAX) {
      body.contentBase64 = bytesToBase64(bytes);
      if (body.size == null) body.size = bytes.length;
    }
  }
  return body;
}

export async function proxyEngine(
  env: Env,
  request: Request,
  origin: URL
): Promise<Response> {
  const id = env.ENGINE.idFromName("filecoin-project");
  const stub = env.ENGINE.get(id);
  const u = new URL(request.url);
  u.pathname = "/orgs/filecoin-project" + origin.pathname;
  return stub.fetch(new Request(u.toString(), request));
}

// --- Fallbacks when the engine cannot restore from RepoDO (hairpin blocked) ---

type RefRow = { name: string; target: string; version: number };
type Change =
  | { op: "upsert"; path: string; kind: "file" | "executable" | "symlink"; blob: string }
  | { op: "delete"; path: string };
type ChangesetRow = {
  id: string;
  lsn: number;
  root_tree: string;
  changeset: {
    parents: string[];
    changes: Change[];
    author: string;
    message: string;
    created_at: number;
    metadata?: Record<string, string>;
  };
};

async function fetchRefs(env: Env, origin: URL, org: string, repo: string): Promise<RefRow[]> {
  const stub = repoStub(env, org, repo);
  if (!stub) return [];
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/refs`, origin).toString(), { method: "GET", headers: h })
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { refs?: RefRow[] };
  return j.refs ?? [];
}

async function fetchChangesets(
  env: Env,
  origin: URL,
  org: string,
  repo: string
): Promise<ChangesetRow[]> {
  const stub = repoStub(env, org, repo);
  if (!stub) return [];
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/changesets`, origin).toString(), {
      method: "GET",
      headers: h
    })
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { changesets?: ChangesetRow[] };
  return j.changesets ?? [];
}

export async function fallbackRefFromRepoDO(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  name: string
): Promise<Response | null> {
  const refs = await fetchRefs(env, origin, org, repo);
  if (refs.length === 0) return null;
  const found = findStoredRef(refs, name);
  if (!found) return new Response(JSON.stringify({ code: "NoSuchRef", message: `no such ref: ${name}` }), {
    status: 404,
    headers: { "content-type": "application/json" }
  });
  return new Response(JSON.stringify(found), { headers: { "content-type": "application/json" } });
}

type SnapshotFile = { blob: string; kind: "file" | "executable" | "symlink" };

/** Linear snapshot through `upto` (same walk as the tree fallback). */
export function applyChangesetSnapshot(changesets: ChangesetRow[], upto: number): Map<string, SnapshotFile> {
  const files = new Map<string, SnapshotFile>();
  for (const row of changesets) {
    if (row.lsn > upto) break;
    for (const ch of row.changeset.changes) {
      if (ch.op === "delete") {
        files.delete(ch.path);
      } else if (ch.op === "upsert") {
        files.set(ch.path, { blob: ch.blob, kind: ch.kind });
      }
    }
  }
  return files;
}

/** Latest COMMP for `path` on or before `upto`.
 *
 * Tip reads prefer the RepoDO `file_pieces` map. Historical reads (and
 * pre-cutover data) still walk leftover changeset `pcid:` metadata.
 */
export function latestPcid(
  changesets: ChangesetRow[],
  upto: number,
  path: string,
  fileMap?: Map<string, string> | null
): string | null {
  const tipLsn = changesets.reduce((max, row) => Math.max(max, row.lsn), -1);
  if (fileMap && upto >= tipLsn) {
    const hit = fileMap.get(path);
    if (hit) return hit;
  }
  for (let i = changesets.length - 1; i >= 0; i--) {
    const row = changesets[i]!;
    if (row.lsn > upto) continue;
    const v = row.changeset.metadata?.[`pcid:${path}`];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export type BlobFallbackBody = {
  ref: string;
  path: string;
  kind: string;
  blob: string;
  size: number | null;
  pieceCid: string | null;
  url: string | null;
  offset: number | null;
  length: number | null;
  raw: string;
  contentBase64?: string;
};

export type BlobFallbackFail = { ok: false; status: number; body: unknown };
export type BlobFallbackOk = { ok: true; body: BlobFallbackBody };

/** Missing or blank `path` query is 400, matching engine `get_blob`. */
export function blobPathError(pathParam: string): BlobFallbackFail | null {
  if (pathParam.trim().replace(/^\/+|\/+$/g, "").length === 0) {
    return {
      ok: false,
      status: 400,
      body: { code: "InvalidChange", message: "path is required" },
    };
  }
  return null;
}

function resolveHead(
  refs: RefRow[],
  changesets: ChangesetRow[],
  rev: string
): { ok: true; head: ChangesetRow } | BlobFallbackFail {
  const isId = /^[0-9a-f]{64}$/i.test(rev);
  let head: ChangesetRow | undefined;
  if (isId) {
    head = changesets.find((c) => c.id.toLowerCase() === rev.toLowerCase());
  } else {
    const found = findStoredRef(refs, rev);
    if (!found) {
      return { ok: false, status: 404, body: { code: "NoSuchRef", message: `no such ref: ${rev}` } };
    }
    head = changesets.find((c) => c.id.toLowerCase() === found.target.toLowerCase());
  }
  if (!head) {
    return { ok: false, status: 404, body: { code: "NotFound", message: "unknown revision" } };
  }
  return { ok: true, head };
}

/**
 * Rebuild one file from RepoDO refs + changesets (engine-shaped get_blob JSON).
 * `url`/`offset`/`length` stay null until `fillBlobLocation`.
 */
export function buildBlobFallback(args: {
  refs: RefRow[];
  changesets: ChangesetRow[];
  rev: string;
  path: string;
  org: string;
  repo: string;
  fileMap?: Map<string, string> | null;
}): BlobFallbackOk | BlobFallbackFail {
  const missing = blobPathError(args.path);
  if (missing) return missing;
  const cleaned = args.path.trim().replace(/^\/+|\/+$/g, "");
  const resolved = resolveHead(args.refs, args.changesets, args.rev);
  if (!resolved.ok) return resolved;
  const files = applyChangesetSnapshot(args.changesets, resolved.head.lsn);
  const file = files.get(cleaned);
  if (!file) {
    return { ok: false, status: 404, body: { code: "NotFound", message: `path not found: ${cleaned}` } };
  }
  const kind = file.kind === "symlink" ? "symlink" : "file";
  return {
    ok: true,
    body: {
      ref: args.rev,
      path: cleaned,
      kind,
      blob: file.blob,
      size: null,
      pieceCid: latestPcid(args.changesets, resolved.head.lsn, cleaned, args.fileMap),
      url: null,
      offset: null,
      length: null,
      raw: `/v1/repos/${args.org}/${args.repo}/objects`,
    },
  };
}

/** Attach a RepoDO bundle hit onto an engine-shaped blob body. */
export function attachBlobResolve(body: BlobFallbackBody, hit: BundleHit | undefined): BlobFallbackBody {
  if (!hit) return body;
  return {
    ...body,
    url: hit.url,
    offset: hit.offset,
    length: hit.length,
    size: body.size ?? hit.length,
  };
}

export async function fallbackTreeFromRepoDO(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  rev: string,
  pathParam: string
): Promise<Response | null> {
  const refs = await fetchRefs(env, origin, org, repo);
  const changesets = await fetchChangesets(env, origin, org, repo);
  if (changesets.length === 0) return null;
  const resolved = resolveHead(refs, changesets, rev);
  if (!resolved.ok) {
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { "content-type": "application/json" },
    });
  }
  const head = resolved.head;
  const files = applyChangesetSnapshot(changesets, head.lsn);
  const fileMap = await fetchFileMap(env, origin, org, repo);
  // Emit one directory of entries
  const cleaned = (pathParam || "").replace(/^\/+|\/+$/g, "");
  const prefix = cleaned ? cleaned + "/" : "";
  const children = new Map<string, { dir: boolean; blob?: string; kind?: string; pieceCid?: string | null }>();
  const tipLsn = changesets.reduce((max, row) => Math.max(max, row.lsn), -1);
  const atTip = head.lsn >= tipLsn;
  for (const [p, v] of files.entries()) {
    if (cleaned && !p.startsWith(prefix)) continue;
    const rest = cleaned ? p.slice(prefix.length) : p;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      const meta = head.changeset.metadata ?? {};
      children.set(rest, {
        dir: false,
        blob: v.blob,
        kind: v.kind,
        pieceCid: (atTip ? fileMap.get(p) : undefined) ?? meta[`pcid:${p}`] ?? null
      });
    } else {
      const top = rest.slice(0, slash);
      if (!children.has(top)) children.set(top, { dir: true });
    }
  }
  const entries = Array.from(children.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, info]) => {
      const base: any = {
        name,
        kind: info.dir ? "dir" : info.kind ?? "file",
        id: info.dir ? "0".repeat(64) : info.blob ?? "0".repeat(64),
        size: null
      };
      if (!info.dir) {
        base.pieceCid = info.pieceCid ?? null;
      }
      return base;
    });
  // Fill sizes from bundle map where available
  await fillEntrySizes(env, origin, org, repo, entries);
  const body = {
    ref: rev,
    path: cleaned,
    tree: head.root_tree ?? "0".repeat(64),
    commit: head.id,
    entries
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/**
 * Engine-fail fallback for `GET .../blob/{rev}?path=`.
 * Mirrors {@link fallbackTreeFromRepoDO}: resolve the ref in RepoDO, rebuild
 * the file snapshot, take `pcid:{path}` from changeset metadata, and attach
 * `url`/`offset`/`length` from the bundle map when present.
 *
 * Small files may also carry `contentBase64` from the RepoDO object store
 * when the piece map has no row (import hairpin / empty PDP map).
 */
export async function fallbackBlobFromRepoDO(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  rev: string,
  pathParam: string
): Promise<Response | null> {
  const missing = blobPathError(pathParam);
  if (missing) {
    return new Response(JSON.stringify(missing.body), {
      status: missing.status,
      headers: { "content-type": "application/json" },
    });
  }
  const refs = await fetchRefs(env, origin, org, repo);
  const changesets = await fetchChangesets(env, origin, org, repo);
  if (changesets.length === 0) return null;
  const fileMap = await fetchFileMap(env, origin, org, repo);
  const built = buildBlobFallback({ refs, changesets, rev, path: pathParam, org, repo, fileMap });
  if (!built.ok) {
    return new Response(JSON.stringify(built.body), {
      status: built.status,
      headers: { "content-type": "application/json" },
    });
  }
  const body = await fillBlobLocation(env, origin, org, repo, built.body);
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
