//! Commit statuses. Rows live in D1 and store blake3 changeset ids, never PieceCIDs.

import { d1All, d1Run, dbOrgs, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";

export const STATUS_STATES = ["pending", "success", "failure"] as const;
export type StatusState = (typeof STATUS_STATES)[number];
export const CONTEXT_RE = /^[A-Za-z0-9_./-]{1,64}$/;
const ID_RE = /^[0-9a-f]{64}$/;

export const STATUS_DDL = `CREATE TABLE IF NOT EXISTS commit_statuses (
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  changeset TEXT NOT NULL,
  context TEXT NOT NULL,
  state TEXT NOT NULL,
  target_url TEXT,
  description TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org, repo, changeset, context)
)`;

export type StatusRow = {
  context: string;
  state: string;
  target_url: string | null;
  description: string | null;
  updated_at: number;
  updated_by: string | null;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Create the status table and the settings column. Safe to call repeatedly. */
export async function ensureStatusSchema(env: D1Env): Promise<void> {
  const db = dbOrgs(env);
  await d1Run(db, STATUS_DDL);
  try {
    await d1Run(db, `ALTER TABLE repo_settings ADD COLUMN required_status_contexts TEXT NOT NULL DEFAULT '[]'`);
  } catch {
    /* column already present */
  }
}

export function parseStatusContexts(raw: unknown): string[] {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && CONTEXT_RE.test(item)) : [];
  } catch {
    return [];
  }
}

export function validateStatusBody(raw: unknown): { ok: true; state: StatusState; context: string; target_url: string | null; description: string | null } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "JSON object body required" };
  const body = raw as Record<string, unknown>;
  const state = body.state;
  const context = body.context;
  if (typeof state !== "string" || !STATUS_STATES.includes(state as StatusState)) {
    return { ok: false, error: "state must be pending, success, or failure" };
  }
  if (typeof context !== "string" || !CONTEXT_RE.test(context)) {
    return { ok: false, error: "context must match [A-Za-z0-9_./-]{1,64}" };
  }
  let target_url: string | null = null;
  if (body.target_url != null && body.target_url !== "") {
    if (typeof body.target_url !== "string" || !/^https?:\/\//.test(body.target_url)) {
      return { ok: false, error: "target_url must be an http(s) URL" };
    }
    target_url = body.target_url;
  }
  const description = typeof body.description === "string" ? body.description.slice(0, 140) : null;
  return { ok: true, state: state as StatusState, context, target_url, description };
}

/** Contexts that are missing or not `success`. */
export function failingStatusContexts(required: string[], rows: { context: string; state: string }[]): string[] {
  const states = new Map(rows.map((row) => [row.context, row.state]));
  return required.filter((name) => states.get(name) !== "success");
}

export function statusReason(context: string, state: string | undefined): string {
  if (!state) return `required status ${context} is missing`;
  if (state === "pending") return `required status ${context} is pending`;
  return `required status ${context} is ${state}`;
}

export async function listStatuses(env: D1Env, org: string, repo: string, changeset: string): Promise<StatusRow[]> {
  try {
    await ensureStatusSchema(env);
    return await d1All<StatusRow>(
      dbOrgs(env),
      `SELECT context, state, target_url, description, updated_at, updated_by
         FROM commit_statuses WHERE org = ? AND repo = ? AND changeset = ? ORDER BY context ASC`,
      [org, repo, changeset]
    );
  } catch {
    return [];
  }
}

export async function requiredStatusReasons(env: D1Env, org: string, repo: string, changeset: string | null, required: string[]): Promise<string[]> {
  if (!required.length) return [];
  if (!changeset) return required.map((name) => statusReason(name, undefined));
  const rows = await listStatuses(env, org, repo, changeset);
  return failingStatusContexts(required, rows).map((name) => statusReason(name, rows.find((row) => row.context === name)?.state));
}

const STATUS = /^\/v1\/repos\/([^/]+)\/([^/]+)\/statuses\/([0-9a-f]{64})$/;

/** `GET` and `POST /v1/repos/{org}/{repo}/statuses/{changeset}`. */
export async function handleStatuses(request: Request, env: D1Env, path: string, actor: Actor | null): Promise<Response | null> {
  const match = path.match(STATUS);
  if (!match) return null;
  const method = request.method.toUpperCase();
  const org = decodeURIComponent(match[1]!);
  const repo = decodeURIComponent(match[2]!);
  const changeset = match[3]!;
  if (!ID_RE.test(changeset)) return json({ error: "changeset must be 64 hex" }, 400);
  if (method === "GET") {
    return json({ changeset, statuses: await listStatuses(env, org, repo, changeset) });
  }
  if (method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!actor) return json({ error: "unauthorized" }, 401);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = validateStatusBody(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  await ensureStatusSchema(env);
  const updated = nowMs();
  await d1Run(
    dbOrgs(env),
    `INSERT INTO commit_statuses (org, repo, changeset, context, state, target_url, description, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org, repo, changeset, context) DO UPDATE SET
       state = excluded.state, target_url = excluded.target_url, description = excluded.description,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [org, repo, changeset, parsed.context, parsed.state, parsed.target_url, parsed.description, actor.name, updated]
  );
  return json({
    changeset,
    context: parsed.context,
    state: parsed.state,
    target_url: parsed.target_url,
    description: parsed.description,
    updated_at: updated,
  });
}
