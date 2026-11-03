//! History reads over the RepoDO changeset chain: log, blame, and show.
//!
//! Blob bytes come from the RepoDO object cache (blake3 ids). Responses never
//! include COMMP PieceCIDs; changeset `metadata` is dropped on the way out.

import { lookupRefNames } from "./browse";

export type HistoryChange = { op: "upsert" | "delete"; path: string; blob?: string };

export type HistoryCommit = {
  id: string;
  parents: string[];
  author: string;
  message: string;
  created_at: number;
  changes: HistoryChange[];
};

export type LogQuery = {
  path?: string;
  author?: string;
  since?: number;
  until?: number;
  grep?: string;
  limit: number;
  cursor?: string;
};

export type BlameLine = { line: number; changeset: string; author: string; text: string };

type RepoNs = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(input: Request): Promise<Response> };
};

export type HistoryEnv = {
  REPO?: RepoNs;
  INTERNAL_SECRET?: string;
};

const ID_RE = /^[0-9a-f]{64}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** True when `changePath` is `path` or a file under a directory `path`. */
export function pathMatches(changePath: string, filter: string): boolean {
  const want = filter.replace(/^\/+|\/+$/g, "");
  if (!want) return true;
  return changePath === want || changePath.startsWith(`${want}/`);
}

/** Drop metadata (which may hold leftover `pcid:` keys) from a log row. */
export function publicCommit(commit: HistoryCommit): {
  id: string;
  author: string;
  message: string;
  created_at: number;
  parents: string[];
  paths: string[];
} {
  return {
    id: commit.id,
    author: commit.author,
    message: commit.message,
    created_at: commit.created_at,
    parents: commit.parents,
    paths: commit.changes.map((change) => change.path),
  };
}

/** Accepts a RepoDO row (`{ id, changeset }`) or a flat changeset. */
export function asCommit(row: unknown): HistoryCommit | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  const body = rec.changeset && typeof rec.changeset === "object" ? (rec.changeset as Record<string, unknown>) : rec;
  const id = String(rec.id ?? body.id ?? "");
  if (!ID_RE.test(id)) return null;
  const parents = Array.isArray(body.parents) ? body.parents.filter((p): p is string => typeof p === "string") : [];
  const changes: HistoryChange[] = [];
  if (Array.isArray(body.changes)) {
    for (const raw of body.changes) {
      if (!raw || typeof raw !== "object") continue;
      const change = raw as Record<string, unknown>;
      const op = change.op === "delete" ? "delete" : change.op === "upsert" ? "upsert" : null;
      const path = typeof change.path === "string" ? change.path : "";
      if (!op || !path) continue;
      const blob = typeof change.blob === "string" ? change.blob : undefined;
      changes.push(blob ? { op, path, blob } : { op, path });
    }
  }
  return {
    id,
    parents,
    author: typeof body.author === "string" ? body.author : "",
    message: typeof body.message === "string" ? body.message : "",
    created_at: Number(body.created_at ?? rec.created_at ?? 0) || 0,
    changes,
  };
}

function byId(commits: HistoryCommit[]): Map<string, HistoryCommit> {
  return new Map(commits.map((commit) => [commit.id, commit]));
}

/** Every commit reachable by following parents, each id once. */
export function reachable(commits: HistoryCommit[], start: string): HistoryCommit[] {
  const index = byId(commits);
  const out: HistoryCommit[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    const commit = index.get(id);
    if (!commit) continue;
    seen.add(id);
    out.push(commit);
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** Oldest-first first-parent chain ending at `tip`. */
export function firstParentChain(commits: HistoryCommit[], tip: string): HistoryCommit[] {
  const index = byId(commits);
  const newestFirst: HistoryCommit[] = [];
  const seen = new Set<string>();
  let id: string | undefined = tip;
  while (id && !seen.has(id)) {
    const commit = index.get(id);
    if (!commit) break;
    seen.add(id);
    newestFirst.push(commit);
    id = commit.parents[0];
  }
  return newestFirst.reverse();
}

function matches(commit: HistoryCommit, query: LogQuery): boolean {
  if (query.path && !commit.changes.some((change) => pathMatches(change.path, query.path!))) return false;
  if (query.author && !commit.author.toLowerCase().includes(query.author.toLowerCase())) return false;
  if (query.grep && !commit.message.toLowerCase().includes(query.grep.toLowerCase())) return false;
  if (query.since != null && commit.created_at < query.since) return false;
  if (query.until != null && commit.created_at > query.until) return false;
  return true;
}

/** Newest-first filtered log page. `cursor` is the last id of the previous page. */
export function walkLog(
  commits: HistoryCommit[],
  start: string,
  query: LogQuery
): { commits: ReturnType<typeof publicCommit>[]; next_cursor: string | null } {
  const limit = Math.min(100, Math.max(1, query.limit || 20));
  const filtered = reachable(commits, start)
    .filter((commit) => matches(commit, query))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
  let startAt = 0;
  if (query.cursor) {
    const idx = filtered.findIndex((commit) => commit.id === query.cursor);
    startAt = idx >= 0 ? idx + 1 : 0;
  }
  const page = filtered.slice(startAt, startAt + limit);
  const more = startAt + limit < filtered.length;
  return {
    commits: page.map(publicCommit),
    next_cursor: more && page.length ? page[page.length - 1]!.id : null,
  };
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

type Edit = { op: "eq" | "del" | "ins"; text: string };

/** Line diff. Large inputs become a single delete+insert so blame still terminates. */
export function diffLines(before: string[], after: string[]): Edit[] {
  const n = before.length;
  const m = after.length;
  if (n * m > 250_000) {
    return [...before.map((text) => ({ op: "del" as const, text })), ...after.map((text) => ({ op: "ins" as const, text }))];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = before[i] === after[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      edits.push({ op: "eq", text: before[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      edits.push({ op: "del", text: before[i]! });
      i++;
    } else {
      edits.push({ op: "ins", text: after[j]! });
      j++;
    }
  }
  while (i < n) edits.push({ op: "del", text: before[i++]! });
  while (j < m) edits.push({ op: "ins", text: after[j++]! });
  return edits;
}

export type FileVersion = { id: string; author: string; text: string };

/** Attribute each line of the newest text to the commit that introduced it. */
export function blameLines(versionsOldestFirst: FileVersion[]): BlameLine[] {
  if (!versionsOldestFirst.length) return [];
  const first = versionsOldestFirst[0]!;
  let current = splitLines(first.text).map((text) => ({ text, changeset: first.id, author: first.author }));
  for (let index = 1; index < versionsOldestFirst.length; index++) {
    const next = versionsOldestFirst[index]!;
    const nextLines = splitLines(next.text);
    const edits = diffLines(current.map((line) => line.text), nextLines);
    const rebuilt: { text: string; changeset: string; author: string }[] = [];
    let oldIndex = 0;
    for (const edit of edits) {
      if (edit.op === "eq") {
        const kept = current[oldIndex];
        rebuilt.push(kept ?? { text: edit.text, changeset: next.id, author: next.author });
        oldIndex++;
      } else if (edit.op === "del") {
        oldIndex++;
      } else {
        rebuilt.push({ text: edit.text, changeset: next.id, author: next.author });
      }
    }
    current = rebuilt;
  }
  return current.map((line, index) => ({ line: index + 1, changeset: line.changeset, author: line.author, text: line.text }));
}

/** File text after each first-parent commit that set `path`, oldest first. */
export function versionsForPath(chainOldestFirst: HistoryCommit[], path: string, blobs: Record<string, string>): FileVersion[] {
  let blob: string | null = null;
  const out: FileVersion[] = [];
  for (const commit of chainOldestFirst) {
    for (const change of commit.changes) {
      if (change.path !== path) continue;
      blob = change.op === "delete" ? null : change.blob ?? null;
    }
    if (!blob) continue;
    const text = blobs[blob];
    if (text == null) continue;
    const prev = out[out.length - 1];
    if (!prev || prev.text !== text) out.push({ id: commit.id, author: commit.author, text });
  }
  return out;
}

function hunks(edits: Edit[]): string[] {
  const lines: string[] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  const context = 3;
  while (i < edits.length) {
    while (i < edits.length && edits[i]!.op === "eq") {
      oldLine++;
      newLine++;
      i++;
    }
    if (i >= edits.length) break;
    let start = i;
    let eqRun = 0;
    let end = i;
    while (end < edits.length) {
      if (edits[end]!.op === "eq") {
        eqRun++;
        if (eqRun > context * 2) break;
      } else {
        eqRun = 0;
      }
      end++;
    }
    if (eqRun > context) end -= eqRun - context;
    const pre = Math.min(context, start);
    start -= pre;
    const slice = edits.slice(start, end);
    let oldCount = 0;
    let newCount = 0;
    let oldStart = oldLine - pre;
    let newStart = newLine - pre;
    for (const edit of slice) {
      if (edit.op !== "ins") oldCount++;
      if (edit.op !== "del") newCount++;
    }
    if (oldCount === 0) oldStart = 0;
    if (newCount === 0) newStart = 0;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const edit of slice) {
      const mark = edit.op === "eq" ? " " : edit.op === "del" ? "-" : "+";
      lines.push(`${mark}${edit.text}`);
      if (edit.op !== "ins") oldLine++;
      if (edit.op !== "del") newLine++;
    }
    i = end;
    while (i < edits.length && edits[i]!.op === "eq") {
      oldLine++;
      newLine++;
      i++;
    }
  }
  return lines;
}

/** Unified diff of one path. A NUL byte is reported as a binary file. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const header = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  if (before.includes("\0") || after.includes("\0")) {
    return [...header, "Binary file"].join("\n");
  }
  const body = hunks(diffLines(splitLines(before), splitLines(after)));
  return body.length ? [...header, ...body].join("\n") : header.slice(0, 1).join("\n");
}

/** Diff of `commit` against its first parent. Missing blob text is called out. */
export function showDiff(chainOldestFirst: HistoryCommit[], commit: HistoryCommit, blobs: Record<string, string>): string {
  const prior = chainOldestFirst.filter((item) => item.id !== commit.id);
  const parts: string[] = [];
  for (const change of commit.changes) {
    const beforeBlob = blobAt(prior, change.path);
    const before = beforeBlob && blobs[beforeBlob] != null ? blobs[beforeBlob]! : "";
    const after = change.op === "delete" ? "" : change.blob && blobs[change.blob] != null ? blobs[change.blob]! : "";
    const missing = (beforeBlob && blobs[beforeBlob] == null) || (change.op === "upsert" && change.blob && blobs[change.blob] == null);
    if (missing) {
      parts.push(`diff --git a/${change.path} b/${change.path}\n# content unavailable`);
      continue;
    }
    const diff = unifiedDiff(change.path, before, after);
    if (diff) parts.push(diff);
  }
  return parts.join("\n");
}

function blobAt(chainOldestFirst: HistoryCommit[], path: string): string | null {
  let blob: string | null = null;
  for (const commit of chainOldestFirst) {
    for (const change of commit.changes) {
      if (change.path !== path) continue;
      blob = change.op === "delete" ? null : change.blob ?? null;
    }
  }
  return blob;
}

function numParam(value: string | null): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

async function repoFetch(env: HistoryEnv, origin: URL, org: string, repo: string, sub: string, method: string, body?: string): Promise<Response> {
  if (!env.REPO) return json({ error: "repo storage unavailable" }, 503);
  const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
  const headers = new Headers();
  headers.set("x-internal-secret", env.INTERNAL_SECRET || "");
  if (body) headers.set("content-type", "application/json");
  return stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/${sub}`, origin).toString(), {
      method,
      headers,
      body,
    })
  );
}

async function loadCommits(env: HistoryEnv, origin: URL, org: string, repo: string): Promise<HistoryCommit[]> {
  const resp = await repoFetch(env, origin, org, repo, "changesets", "GET");
  if (!resp.ok) return [];
  const body = (await resp.json()) as { changesets?: unknown[] };
  return (body.changesets ?? []).map(asCommit).filter((commit): commit is HistoryCommit => commit != null);
}

async function loadRefs(env: HistoryEnv, origin: URL, org: string, repo: string): Promise<{ name: string; target: string }[]> {
  const resp = await repoFetch(env, origin, org, repo, "refs", "GET");
  if (!resp.ok) return [];
  const body = (await resp.json()) as { refs?: { name?: string; target?: string }[] };
  return (body.refs ?? [])
    .filter((row) => typeof row.name === "string" && typeof row.target === "string")
    .map((row) => ({ name: row.name!, target: row.target! }));
}

async function loadTags(env: HistoryEnv, origin: URL, org: string, repo: string): Promise<{ name: string; target: string }[]> {
  const resp = await repoFetch(env, origin, org, repo, "tags", "GET");
  if (!resp.ok) return [];
  const body = (await resp.json()) as { tags?: { name?: string; target?: string }[] };
  return (body.tags ?? [])
    .filter((row) => typeof row.name === "string" && typeof row.target === "string")
    .map((row) => ({ name: row.name!, target: row.target! }));
}

/** Resolve a branch, tag, or changeset id to a changeset id. */
export function resolveTip(
  name: string,
  refs: { name: string; target: string }[],
  tags: { name: string; target: string }[],
  commits: HistoryCommit[]
): string | null {
  if (ID_RE.test(name) && commits.some((commit) => commit.id === name)) return name;
  const want = new Set(lookupRefNames(name));
  const ref = refs.find((row) => want.has(row.name));
  if (ref) return ref.target;
  const tag = tags.find((row) => row.name === name || row.name === name.replace(/^refs\/tags\//, ""));
  return tag?.target ?? null;
}

async function loadBlob(env: HistoryEnv, origin: URL, org: string, repo: string, id: string): Promise<string | null> {
  const resp = await repoFetch(env, origin, org, repo, `objects/${encodeURIComponent(id)}`, "GET");
  if (!resp.ok) return null;
  const body = (await resp.json()) as { bytesBase64?: string };
  if (typeof body.bytesBase64 !== "string") return null;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(body.bytesBase64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

const LOG = /^\/v1\/repos\/([^/]+)\/([^/]+)\/log$/;
const BLAME = /^\/v1\/repos\/([^/]+)\/([^/]+)\/blame$/;
const SHOW = /^\/v1\/repos\/([^/]+)\/([^/]+)\/changesets\/([0-9a-f]{64})\/diff$/;

/** `GET .../log`, `GET .../blame`, `GET .../changesets/{id}/diff`. */
export async function handleHistory(request: Request, env: HistoryEnv, path: string, origin: URL): Promise<Response | null> {
  const log = path.match(LOG);
  const blame = path.match(BLAME);
  const show = path.match(SHOW);
  if (!log && !blame && !show) return null;
  if (request.method.toUpperCase() !== "GET") return json({ error: "method not allowed" }, 405);
  const org = decodeURIComponent((log ?? blame ?? show)![1]!);
  const repo = decodeURIComponent((log ?? blame ?? show)![2]!);
  const commits = await loadCommits(env, origin, org, repo);
  const url = new URL(request.url);
  if (log) {
    const refs = await loadRefs(env, origin, org, repo);
    const tags = await loadTags(env, origin, org, repo);
    const name = url.searchParams.get("ref") || url.searchParams.get("branch") || "main";
    const tip = resolveTip(name, refs, tags, commits);
    if (!tip) return json({ error: "not found" }, 404);
    const page = walkLog(commits, tip, {
      path: url.searchParams.get("path") || undefined,
      author: url.searchParams.get("author") || undefined,
      since: numParam(url.searchParams.get("since")),
      until: numParam(url.searchParams.get("until")),
      grep: url.searchParams.get("grep") || undefined,
      limit: Number(url.searchParams.get("n") || url.searchParams.get("limit") || 20),
      cursor: url.searchParams.get("cursor") || undefined,
    });
    return json({ ref: name, ...page });
  }
  if (blame) {
    const file = url.searchParams.get("path") || "";
    if (!file) return json({ error: "path is required" }, 400);
    const refs = await loadRefs(env, origin, org, repo);
    const tags = await loadTags(env, origin, org, repo);
    const name = url.searchParams.get("ref") || url.searchParams.get("branch") || "main";
    const tip = resolveTip(name, refs, tags, commits);
    if (!tip) return json({ error: "not found" }, 404);
    const cached = await repoFetch(env, origin, org, repo, `blame-cache?path=${encodeURIComponent(file)}&tip=${tip}`, "GET");
    if (cached.ok) {
      const hit = (await cached.json()) as { body?: string };
      if (typeof hit.body === "string") {
        try {
          return json(JSON.parse(hit.body));
        } catch {
          /* recompute */
        }
      }
    }
    const chain = firstParentChain(commits, tip);
    const ids = new Set<string>();
    for (const commit of chain) {
      for (const change of commit.changes) {
        if (change.path === file && change.blob) ids.add(change.blob);
      }
    }
    const blobs: Record<string, string> = {};
    for (const id of ids) {
      const text = await loadBlob(env, origin, org, repo, id);
      if (text != null) blobs[id] = text;
    }
    const versions = versionsForPath(chain, file, blobs);
    if (!versions.length) return json({ error: "content unavailable", path: file }, 404);
    const payload = { path: file, tip, lines: blameLines(versions) };
    await repoFetch(env, origin, org, repo, "blame-cache", "POST", JSON.stringify({ path: file, tip, body: JSON.stringify(payload) })).catch(() => undefined);
    return json(payload);
  }
  const id = show![3]!;
  const commit = commits.find((item) => item.id === id);
  if (!commit) return json({ error: "not found" }, 404);
  const chain = firstParentChain(commits, id);
  const ids = new Set<string>();
  for (const item of chain) {
    for (const change of item.changes) {
      if (change.blob) ids.add(change.blob);
    }
  }
  const blobs: Record<string, string> = {};
  for (const blob of ids) {
    const text = await loadBlob(env, origin, org, repo, blob);
    if (text != null) blobs[blob] = text;
  }
  return json({
    id: commit.id,
    author: commit.author,
    message: commit.message,
    created_at: commit.created_at,
    parents: commit.parents,
    diff: showDiff(chain, commit, blobs),
  });
}
