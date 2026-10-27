/** Anonymous tree/compare helpers that fill file sizes from the bundle map. */

/** Catalog-backed browse reads: missing repos must not look like a missing ref. */
const BROWSE_READ =
  /^\/v1\/repos\/([^/]+)\/([^/]+)\/(tree|blob|commits|branches|compare|diff|refs)(?:\/|$)/;
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
  ENGINE: DurableObjectNamespace;
  REPO: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
  PDP_BASE_URL?: string;
};

function providerBaseUrl(env: Env): string {
  return (env.PDP_BASE_URL || "").replace(/\/+$/, "");
}

type TreeEntry = {
  name?: string;
  kind?: string;
  size?: number | null;
  pieceCid?: string | null;
};

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
  const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
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

/**
 * Resolve PieceCIDs via RepoDO (no engine→Worker hairpin) and attach SP URLs.
 * Empty when the bundle map has no row — not a 400.
 */
export async function resolvePiecesFromRepoDO(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  pieceCids: string[]
): Promise<BundleHit[]> {
  const rows = await fetchBundleRows(env, origin, org, repo, pieceCids);
  return attachResolveUrls(rows, providerBaseUrl(env));
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
  const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
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
  const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
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
  // Resolve rev to a target changeset id
  const isId = /^[0-9a-f]{64}$/i.test(rev);
  let head: ChangesetRow | undefined;
  if (isId) {
    head = changesets.find((c) => c.id.toLowerCase() === rev.toLowerCase());
  } else {
    const found = findStoredRef(refs, rev);
    if (!found) return new Response(JSON.stringify({ code: "NoSuchRef", message: `no such ref: ${rev}` }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
    head = changesets.find((c) => c.id.toLowerCase() === found.target.toLowerCase());
  }
  if (!head) return new Response(JSON.stringify({ code: "NotFound", message: "unknown revision" }), {
    status: 404,
    headers: { "content-type": "application/json" }
  });
  // Build a snapshot by applying linear history up to head.lsn (acceptable for current repos)
  const upto = head.lsn;
  const files = new Map<string, { blob: string; kind: "file" | "executable" | "symlink" }>();
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
  // Emit one directory of entries
  const cleaned = (pathParam || "").replace(/^\/+|\/+$/g, "");
  const prefix = cleaned ? cleaned + "/" : "";
  const children = new Map<string, { dir: boolean; blob?: string; kind?: string; pieceCid?: string | null }>();
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
        pieceCid: meta[`pcid:${p}`] ?? null
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
