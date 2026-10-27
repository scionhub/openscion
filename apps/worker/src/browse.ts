/** Anonymous tree/compare helpers that fill file sizes from the bundle map. */

type Env = {
  ENGINE: DurableObjectNamespace;
  REPO: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
};

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

export async function resolveLengths(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  pieceCids: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pieceCids.length === 0) return out;
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
  if (!r.ok) return out;
  const j = (await r.json()) as { results?: { pieceCid: string; length: number }[] };
  for (const row of j.results ?? []) {
    if (row.pieceCid) out.set(row.pieceCid, row.length);
  }
  return out;
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
  const candidates = [name, `refs/heads/${name}`, `refs/${name}`];
  const found = refs.find((r) => candidates.includes(r.name));
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
    const candidates = [rev, `refs/heads/${rev}`, `refs/${rev}`];
    const found = refs.find((r) => candidates.includes(r.name));
    if (!found) return new Response(JSON.stringify({ code: "NoSuchRef", message: `no such ref: ${rev}` }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
    head = changesets.find((c) => c.id.toLowerCase() === found!.target.toLowerCase());
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
