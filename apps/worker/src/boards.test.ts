//! Board name/sources parsing and cross-org visibility.

import { orgAdminRole } from "./authz";
import {
  issueVisible,
  parseBoardName,
  parseSources,
  parseStateFilter,
} from "./boards";

if (parseBoardName("triage").ok !== true) throw new Error("valid board name must parse");
if (parseBoardName("  ").ok) throw new Error("blank board name must fail");
if (parseBoardName("a/b").ok) throw new Error("board name must not contain /");
if (parseBoardName("x".repeat(65)).ok) throw new Error("board name over 64 must fail");

if (!parseStateFilter(undefined).ok || (parseStateFilter(undefined) as { value: string }).value !== "open") {
  throw new Error("missing state defaults to open");
}
if (parseStateFilter("closed").ok !== true) throw new Error("closed state must parse");
if (parseStateFilter("wip").ok) throw new Error("unknown state must fail");

const all = parseSources(null);
if (!all.ok || all.value !== null) throw new Error("null sources means all orgs");
const empty = parseSources([]);
if (!empty.ok || empty.value !== null) throw new Error("empty sources means all orgs");

const mixed = parseSources(["acme", "acme/web", { org: "other", repo: "api" }]);
if (!mixed.ok || !mixed.value || mixed.value.length !== 3) throw new Error("mixed sources must parse");
if (mixed.value[0]?.org !== "acme" || mixed.value[0]?.repo !== null) {
  throw new Error("org-only source must leave repo null");
}
if (mixed.value[1]?.org !== "acme" || mixed.value[1]?.repo !== "web") {
  throw new Error("org/repo string must split");
}
if (parseSources(["/repo"]).ok) throw new Error("source missing org must fail");
if (parseSources([1]).ok) throw new Error("numeric source must fail");

const privateRepos = new Set(["secret/hidden"]);
const writable = new Set(["secret"]);
if (!issueVisible({ org: "acme", repo: "web" }, privateRepos, new Set(), false)) {
  throw new Error("public issue must be visible to anyone");
}
if (issueVisible({ org: "secret", repo: "hidden" }, privateRepos, new Set(), false)) {
  throw new Error("private issue must be hidden from strangers");
}
if (!issueVisible({ org: "secret", repo: "hidden" }, privateRepos, writable, false)) {
  throw new Error("private issue must be visible to org writers");
}
if (!issueVisible({ org: "secret", repo: "hidden" }, privateRepos, new Set(), true)) {
  throw new Error("site admin must see private issues");
}

if (!orgAdminRole("admin") || !orgAdminRole("owner")) throw new Error("admin and owner administer the org");
if (orgAdminRole("member") || orgAdminRole(undefined)) throw new Error("member is not an org admin");
