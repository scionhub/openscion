//! GitHub-compatible CODEOWNERS matching for pull-request review gates.

/** One CODEOWNERS rule. Last matching rule for a path wins. */
export type CodeownersRule = {
  /** Repository path of the CODEOWNERS file. */
  source: string;
  /** Original pattern text. */
  pattern: string;
  /** Normalized usernames (no leading `@`, lowercase). */
  owners: string[];
  /** Directory prefix for nested files (`src/` for `src/CODEOWNERS`). */
  dirPrefix: string;
};

const ROOT_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** Strip `@` and lowercase a CODEOWNERS owner token. */
export function normalizeOwner(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/** True when `path` is a nested CODEOWNERS file (not the three GitHub roots). */
export function isNestedCodeowners(path: string): boolean {
  if (path === "CODEOWNERS" || path === ".github/CODEOWNERS" || path === "docs/CODEOWNERS") {
    return false;
  }
  return path.endsWith("/CODEOWNERS");
}

/** Directory the nested file's patterns are relative to, or `""` for a root file. */
export function codeownersDirPrefix(sourcePath: string): string {
  if (!isNestedCodeowners(sourcePath)) return "";
  const slash = sourcePath.lastIndexOf("/");
  return slash >= 0 ? sourcePath.slice(0, slash + 1) : "";
}

/** Candidate CODEOWNERS paths: GitHub roots plus a file in each ancestor of `changed`. */
export function candidateCodeownersPaths(changedPaths: string[]): string[] {
  const out = new Set<string>(ROOT_LOCATIONS);
  for (const path of changedPaths) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      out.add(`${parts.slice(0, i).join("/")}/CODEOWNERS`);
    }
  }
  return [...out];
}

/** Parse a CODEOWNERS file. Comments and blank lines are ignored. */
export function parseCodeowners(text: string, sourcePath: string): CodeownersRule[] {
  const dirPrefix = codeownersDirPrefix(sourcePath);
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const pattern = tokens[0]!;
    const owners = tokens.slice(1).map(normalizeOwner).filter(Boolean);
    if (owners.length === 0) continue;
    rules.push({ source: sourcePath, pattern, owners, dirPrefix });
  }
  return rules;
}

function stripComment(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "#" && (i === 0 || line[i - 1] !== "\\")) {
      break;
    }
    if (line[i] === "\\" && line[i + 1] === "#") {
      out += "#";
      i++;
      continue;
    }
    out += line[i];
  }
  return out;
}

/** GitHub-style gitignore glob: last matching pattern in `rules` wins. */
export function ownersForPath(path: string, rules: CodeownersRule[]): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (pathMatchesRule(path, rule)) owners = rule.owners;
  }
  return owners;
}

export function pathMatchesRule(path: string, rule: CodeownersRule): boolean {
  const normalized = path.replace(/^\/+/, "");
  if (rule.dirPrefix) {
    if (normalized !== rule.dirPrefix.slice(0, -1) && !normalized.startsWith(rule.dirPrefix)) {
      return false;
    }
    const relative = normalized.startsWith(rule.dirPrefix)
      ? normalized.slice(rule.dirPrefix.length)
      : "";
    return pathMatchesPattern(relative, rule.pattern);
  }
  return pathMatchesPattern(normalized, rule.pattern);
}

/** Match a repo-relative path against one CODEOWNERS / gitignore-style pattern. */
export function pathMatchesPattern(path: string, pattern: string): boolean {
  let pat = pattern.trim();
  if (!pat) return false;
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);
  const re = globToRegExp(pat, anchored);
  if (dirOnly) {
    return re.test(path) || path.startsWith(pathMatchPrefix(pat, anchored) + "/");
  }
  return re.test(path);
}

function pathMatchPrefix(pattern: string, anchored: boolean): string {
  if (anchored) return pattern.replace(/\*\*.*$/, "").replace(/\/$/, "");
  return pattern;
}

function globToRegExp(pattern: string, anchored: boolean): RegExp {
  let i = 0;
  let out = "^";
  if (!anchored && !pattern.includes("/")) {
    out += "(?:.*/)?";
  }
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 2) === "**") {
      out += ".*";
      i += 2;
      continue;
    }
    const c = pattern[i]!;
    if (c === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if ("+()^$[]{}|.\\".includes(c)) out += `\\${c}`;
    else out += c;
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

/** Sort CODEOWNERS files so a GitHub root file is first, then nested by depth. */
export function sortCodeownersSources(paths: string[]): string[] {
  const root = ROOT_LOCATIONS.find((p) => paths.includes(p));
  const nested = paths
    .filter((p) => p !== root && isNestedCodeowners(p))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return root ? [root, ...nested] : nested;
}

/** Unique required owner-sets for changed paths (empty if nothing matched). */
export function requiredOwnerSets(changedPaths: string[], rules: CodeownersRule[]): string[][] {
  const sets = new Map<string, string[]>();
  for (const path of changedPaths) {
    const owners = ownersForPath(path, rules);
    if (owners.length === 0) continue;
    const key = [...owners].sort().join(",");
    if (!sets.has(key)) sets.set(key, owners);
  }
  return [...sets.values()];
}

export type ApprovalEval = {
  satisfied: boolean;
  qualifying: number;
  mode: "codeowners" | "fallback";
  reason?: string;
  requiredSets: string[][];
};

/**
 * GitHub-like coverage: every required owner-set needs one matching approval.
 * With no matching CODEOWNERS, any collaborator approval counts (fallback).
 */
export function evaluateApprovalGate(args: {
  changedPaths: string[];
  rules: CodeownersRule[];
  approverLogins: string[];
  collaboratorLogins: string[];
  requiredApprovals: number;
}): ApprovalEval {
  const approvers = new Set(args.approverLogins.map(normalizeOwner).filter(Boolean));
  const collaborators = new Set(args.collaboratorLogins.map(normalizeOwner).filter(Boolean));
  const need = Math.max(1, args.requiredApprovals);
  const requiredSets = requiredOwnerSets(args.changedPaths, args.rules);

  if (requiredSets.length === 0) {
    const qualifying = [...approvers].filter((n) => collaborators.has(n));
    const satisfied = qualifying.length >= need;
    return {
      satisfied,
      qualifying: qualifying.length,
      mode: "fallback",
      requiredSets,
      reason: satisfied
        ? undefined
        : need === 1
          ? "at least one approval is required"
          : `at least ${need} approvals are required (${qualifying.length} so far)`,
    };
  }

  const missing: string[] = [];
  for (const set of requiredSets) {
    if (!set.some((owner) => approvers.has(owner))) {
      missing.push(set.map((o) => `@${o}`).join(" or "));
    }
  }
  const qualifying = [...approvers].filter((n) => requiredSets.some((set) => set.includes(n)));
  if (missing.length > 0) {
    return {
      satisfied: false,
      qualifying: qualifying.length,
      mode: "codeowners",
      requiredSets,
      reason: `CODEOWNERS approval required from ${missing.join("; ")}`,
    };
  }
  if (qualifying.length < need) {
    return {
      satisfied: false,
      qualifying: qualifying.length,
      mode: "codeowners",
      requiredSets,
      reason: `at least ${need} CODEOWNERS approvals are required (${qualifying.length} so far)`,
    };
  }
  return { satisfied: true, qualifying: qualifying.length, mode: "codeowners", requiredSets };
}

/** Whether `login` is a required CODEOWNER for any of `changedPaths`. */
export function isCodeownerForChanges(login: string, changedPaths: string[], rules: CodeownersRule[]): boolean {
  const name = normalizeOwner(login);
  if (!name) return false;
  return changedPaths.some((path) => ownersForPath(path, rules).includes(name));
}
