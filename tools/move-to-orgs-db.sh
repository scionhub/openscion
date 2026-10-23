#!/usr/bin/env bash
# Copy repo-scoped tables from scionhub-top into scionbase-orgs.
# Never prints tokens, credentials, or table contents.
#
# Usage (from repo root):
#   DRY_RUN=1 ./tools/move-to-orgs-db.sh
#   ./tools/move-to-orgs-db.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${ROOT}/apps/worker/wrangler.toml"
WRANGLER="${WRANGLER:-npx -y wrangler@4.86.0}"
SRC_DB="scionhub-top"
DST_DB="scionbase-orgs"
DRY_RUN="${DRY_RUN:-0}"

# Moved tables. Identity stays on top (users, tokens, orgs, org_members,
# memberships, signup_attempts). Extra `org` columns on the destination are
# filled after import; named INSERTs keep dump value-counts compatible.
TABLES=(repos pulls datasets providers pieces uploads)

# Source column lists matching live top after migrations 0001–0008 (+ datasets.onchain_id).
# Destination may have additional trailing `org` columns; named INSERTs leave those NULL.
cols_for() {
  case "$1" in
    repos) echo "id, name, visibility, created_at, created_by" ;;
    pulls) echo "id, org, repo, number, author_user_id, title, body, head_ref, head_target, base_ref, state, created_at, merged_by, merged_at" ;;
    datasets) echo "id, name, description, created_at, org, onchain_id" ;;
    providers) echo "id, name, endpoint_url, region, status, created_at" ;;
    pieces) echo "piece_cid, dataset_id, size_bytes, provider_id, status, created_at" ;;
    uploads) echo "id, piece_cid, source, state, error, created_at" ;;
    *) echo "unknown table: $1" >&2; return 1 ;;
  esac
}

log() { printf '%s\n' "$*" >&2; }

if [[ ! -f "$CONFIG" ]]; then
  log "missing wrangler config: $CONFIG"
  exit 1
fi

if grep -q 'TODO-create-with-wrangler-d1-create' "$CONFIG"; then
  log "ORGS_DB database_id is still the placeholder. Create the DB and put the id in wrangler.toml:"
  log "  npx -y wrangler@4.86.0 d1 create scionbase-orgs"
  if [[ "$DRY_RUN" != "1" ]]; then
    exit 1
  fi
  log "DRY_RUN: continuing so commands can be printed"
fi

name_inserts() {
  local table="$1"
  local cols="$2"
  local file="$3"
  # wrangler 4.86 `d1 export --no-schema` emits INSERT INTO "table" VALUES(...);
  sed -E -i \
    "s/INSERT INTO [\"']?${table}[\"']? VALUES/INSERT INTO ${table} (${cols}) VALUES/g" \
    "$file"
}

run_wrangler() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: $WRANGLER $*"
    return 0
  fi
  # shellcheck disable=SC2086
  $WRANGLER "$@"
}

parse_count() {
  # wrangler --json: [{"results":[{"n":N}],"success":true}, ...]
  python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    print(0)
    raise SystemExit(0)
data = json.loads(raw)
rows = data
if isinstance(data, dict):
    rows = data.get("results") or data.get("result") or [data]
if not isinstance(rows, list):
    rows = [rows]
for block in rows:
    if not isinstance(block, dict):
        continue
    results = block.get("results") or block.get("result") or []
    if isinstance(results, dict):
        results = [results]
    for row in results:
        if isinstance(row, dict) and "n" in row:
            print(int(row["n"]))
            raise SystemExit(0)
print(0)
'
}

count_rows() {
  local db="$1"
  local table="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "0"
    return 0
  fi
  local out
  out="$($WRANGLER d1 execute "$db" --config "$CONFIG" --remote --yes --json \
    --command "SELECT COUNT(*) AS n FROM ${table}" 2>/dev/null)" || out=""
  printf '%s' "$out" | parse_count
}

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/move-to-orgs-db.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

log "export dir: $WORKDIR (deleted on exit; contents not printed)"
if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN=1: no remote writes"
fi

mismatch=0
for table in "${TABLES[@]}"; do
  cols="$(cols_for "$table")"
  dump="${WORKDIR}/${table}.sql"
  log "export ${SRC_DB}.${table}"
  run_wrangler d1 export "$SRC_DB" --config "$CONFIG" --remote --skip-confirmation \
    --table "$table" --no-schema --output "$dump"
  if [[ "$DRY_RUN" != "1" ]]; then
    if [[ ! -s "$dump" ]]; then
      log "${table}: empty export (0 rows)"
      : >"$dump"
    else
      name_inserts "$table" "$cols" "$dump"
    fi
  fi
  log "import ${DST_DB}.${table}"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: would execute ${dump} against ${DST_DB}"
  else
    if [[ -s "$dump" ]]; then
      # Prefer the 6-column datasets list; retry without onchain_id if the
      # source DB never received the runtime ALTER.
      if ! $WRANGLER d1 execute "$DST_DB" --config "$CONFIG" --remote --yes --file "$dump"; then
        if [[ "$table" == "datasets" ]]; then
          log "${table}: retry without onchain_id"
          sed -E -i \
            "s/INSERT INTO datasets \\([^)]*\\) VALUES/INSERT INTO datasets (id, name, description, created_at, org) VALUES/g" \
            "$dump"
          $WRANGLER d1 execute "$DST_DB" --config "$CONFIG" --remote --yes --file "$dump"
        else
          log "${table}: import failed"
          exit 1
        fi
      fi
    fi
  fi
done

if [[ "$DRY_RUN" != "1" ]]; then
  log "fill repos.org from repos.id"
  $WRANGLER d1 execute "$DST_DB" --config "$CONFIG" --remote --yes --command \
    "UPDATE repos SET org = CASE WHEN instr(id, '/') > 0 THEN substr(id, 1, instr(id, '/') - 1) ELSE id END WHERE org IS NULL OR org = ''"
fi

log "row counts (source -> dest)"
for table in "${TABLES[@]}"; do
  src="$(count_rows "$SRC_DB" "$table")"
  dst="$(count_rows "$DST_DB" "$table")"
  log "  ${table}: ${src} -> ${dst}"
  if [[ "$DRY_RUN" != "1" && "$src" != "$dst" ]]; then
    mismatch=1
  fi
done

if [[ "$mismatch" -ne 0 ]]; then
  log "row count mismatch; inspect with wrangler d1 execute (do not dump tokens)"
  exit 1
fi

log "done"
