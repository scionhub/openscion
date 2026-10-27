/** RepoDO hydrate/persist helpers so writes work without an engine→Worker hairpin. */

export type RestoreEnv = {
  REPO?: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
};

export type PersistKind = "changeset" | "ref" | "ref-delete";

export type RepoSnapshot = {
  changesets: unknown[];
  refs: unknown[];
};

export type ContainerFetch = (url: string, init: RequestInit) => Promise<Response>;

const REPO_SCOPE = /^\/v1\/repos\/([^/]+)\/([^/]+)(?:\/|$)/;
const CHANGESETS = /^\/v1\/repos\/[^/]+\/[^/]+\/changesets$/;
const REFS = /^\/v1\/repos\/[^/]+\/[^/]+\/refs\/(.+)$/;

/** `{org, repo}` when `path` is a repo-scoped API route. */
export function repoScope(path: string): { org: string; repo: string } | null {
  const match = path.match(REPO_SCOPE);
  if (!match) return null;
  return { org: decodeURIComponent(match[1]!), repo: decodeURIComponent(match[2]!) };
}

/** True for mutating calls that need the engine's in-memory repo loaded. */
export function isRepoWrite(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  return (
    !!repoScope(path) &&
    (verb === "POST" || verb === "PUT" || verb === "PATCH" || verb === "DELETE")
  );
}

/** Which RepoDO write to mirror after a successful engine response. */
export function persistKind(method: string, path: string): PersistKind | null {
  const verb = method.toUpperCase();
  if (verb === "POST" && CHANGESETS.test(path)) return "changeset";
  const ref = path.match(REFS);
  if (verb === "POST" && ref) return "ref";
  if (verb === "DELETE" && ref) return "ref-delete";
  return null;
}

/** Ref name from `/v1/repos/{org}/{repo}/refs/{name}`. */
export function refNameFromPath(path: string): string | null {
  const match = path.match(REFS);
  return match ? decodeURIComponent(match[1]!) : null;
}

function internalHeaders(env: RestoreEnv, contentType = false): Headers {
  const headers = new Headers();
  headers.set("x-internal-secret", env.INTERNAL_SECRET || "");
  if (contentType) headers.set("content-type", "application/json");
  return headers;
}

function repoStub(env: RestoreEnv, org: string, repo: string): DurableObjectStub | null {
  if (!env.REPO) return null;
  return env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
}

/** Reads changesets and refs from RepoDO. Failures become an empty snapshot. */
export async function fetchRepoSnapshot(
  env: RestoreEnv,
  origin: URL,
  org: string,
  repo: string
): Promise<RepoSnapshot> {
  const stub = repoStub(env, org, repo);
  if (!stub) return { changesets: [], refs: [] };
  const headers = internalHeaders(env);
  const [changesetsResp, refsResp] = await Promise.all([
    stub.fetch(
      new Request(new URL(`/__internal/do/${org}/${repo}/changesets`, origin).toString(), {
        method: "GET",
        headers,
      })
    ),
    stub.fetch(
      new Request(new URL(`/__internal/do/${org}/${repo}/refs`, origin).toString(), {
        method: "GET",
        headers,
      })
    ),
  ]);
  const changesets = changesetsResp.ok
    ? ((await changesetsResp.json()) as { changesets?: unknown[] }).changesets ?? []
    : [];
  const refs = refsResp.ok ? ((await refsResp.json()) as { refs?: unknown[] }).refs ?? [] : [];
  return { changesets, refs };
}

/** Posts a RepoDO snapshot into the engine so `get()` does not hairpin. */
export async function hydrateEngine(
  env: RestoreEnv,
  org: string,
  repo: string,
  snapshot: RepoSnapshot,
  containerFetch: ContainerFetch
): Promise<void> {
  const resp = await containerFetch(`http://container/__internal/hydrate/${org}/${repo}`, {
    method: "POST",
    headers: internalHeaders(env, true),
    body: JSON.stringify(snapshot),
  });
  if (!resp.ok) {
    console.error("[hydrate] engine rejected", org, repo, resp.status);
  }
}

export async function persistChangeset(
  env: RestoreEnv,
  origin: URL,
  org: string,
  repo: string,
  row: Record<string, unknown>
): Promise<void> {
  const stub = repoStub(env, org, repo);
  if (!stub) return;
  await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/changesets`, origin).toString(), {
      method: "POST",
      headers: internalHeaders(env, true),
      body: JSON.stringify(row),
    })
  );
}

export async function persistRef(
  env: RestoreEnv,
  origin: URL,
  org: string,
  repo: string,
  value: { name: string; target: string; version: number }
): Promise<void> {
  const stub = repoStub(env, org, repo);
  if (!stub) return;
  await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/refs`, origin).toString(), {
      method: "POST",
      headers: internalHeaders(env, true),
      body: JSON.stringify(value),
    })
  );
}

export async function persistDeleteRef(
  env: RestoreEnv,
  origin: URL,
  org: string,
  repo: string,
  name: string
): Promise<void> {
  const stub = repoStub(env, org, repo);
  if (!stub) return;
  await stub.fetch(
    new Request(
      new URL(`/__internal/do/${org}/${repo}/refs/${encodeURIComponent(name)}`, origin).toString(),
      { method: "DELETE", headers: internalHeaders(env) }
    )
  );
}

type FlatChangeset = {
  id?: string;
  lsn?: number;
  root_tree?: string;
  parents?: unknown;
  changes?: unknown;
  author?: string;
  message?: string;
  created_at?: number;
  metadata?: unknown;
};

/** Mirrors a successful engine write into RepoDO via a DO stub (no public hairpin). */
export async function persistEngineWrite(
  env: RestoreEnv,
  origin: URL,
  org: string,
  repo: string,
  kind: PersistKind,
  refName: string | undefined,
  responseBody: ArrayBuffer,
  containerFetch: ContainerFetch
): Promise<void> {
  const text = new TextDecoder().decode(responseBody);
  if (kind === "changeset") {
    const info = JSON.parse(text) as { id?: string };
    if (!info.id) return;
    const recResp = await containerFetch(
      `http://container/v1/repos/${org}/${repo}/changesets/${info.id}`,
      { method: "GET", headers: internalHeaders(env) }
    );
    if (!recResp.ok) return;
    const rec = (await recResp.json()) as FlatChangeset;
    await persistChangeset(env, origin, org, repo, {
      id: rec.id,
      lsn: rec.lsn,
      root_tree: rec.root_tree,
      changeset: {
        parents: rec.parents,
        changes: rec.changes,
        author: rec.author,
        message: rec.message,
        created_at: rec.created_at,
        metadata: rec.metadata,
      },
    });
    return;
  }
  if (kind === "ref") {
    const value = JSON.parse(text) as { name?: string; target?: string; version?: number };
    if (!value.name || !value.target || value.version == null) return;
    await persistRef(env, origin, org, repo, {
      name: value.name,
      target: value.target,
      version: value.version,
    });
    return;
  }
  if (kind === "ref-delete" && refName) {
    await persistDeleteRef(env, origin, org, repo, refName);
  }
}
