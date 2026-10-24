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
