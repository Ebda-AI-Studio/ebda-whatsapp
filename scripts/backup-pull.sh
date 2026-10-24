#!/usr/bin/env bash
# Mirrors last night's Ebda WhatsApp backups (R2 ebda-wa-backups) and a D1 export to this Mac. Keeps 30 days.
# Keys are deterministic (backups/<workspace>/<date>/<table>.ndjson), so no bucket listing is needed:
# the workspace list comes from D1. Usage: scripts/backup-pull.sh [YYYY-MM-DD]   (default: today in Cairo)
set -euo pipefail
cd "$(dirname "$0")/.."
DATE="${1:-$(TZ=Africa/Cairo date +%F)}"
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad date: $DATE" >&2; exit 2; }
DEST="${EBDA_WA_BACKUP_DIR:-$HOME/Backups/ebda-whatsapp}/$DATE"
mkdir -p "$DEST"
TABLES=(contacts conversations messages message_status_events)

WORKSPACES=$(npx wrangler d1 execute ebda-wa-platform --remote --json --command "SELECT id FROM workspaces ORDER BY id" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s)[0].results)console.log(r.id)})')
count=0
for ws in $WORKSPACES; do
  [[ "$ws" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "skip unsafe workspace id" >&2; continue; }
  mkdir -p "$DEST/$ws"
  for f in manifest.json "${TABLES[@]/%/.ndjson}"; do
    npx wrangler r2 object get "ebda-wa-backups/backups/$ws/$DATE/$f" --remote --file "$DEST/$ws/$f" >/dev/null
  done
  # Row-count assert against the manifest (rule: a backup that cannot be counted is not a backup).
  for t in "${TABLES[@]}"; do
    want=$(node -e "console.log(require('$DEST/$ws/manifest.json').tables['$t'].rows)")
    got=$(grep -c '' "$DEST/$ws/$t.ndjson" || true)
    [[ "$want" == "$got" ]] || { echo "row count mismatch $ws/$t: manifest $want, file $got" >&2; exit 1; }
  done
  count=$((count + 1))
done
npx wrangler d1 export ebda-wa-platform --remote --output "$DEST/d1-ebda-wa-platform.sql" >/dev/null
find "$(dirname "$DEST")" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
echo "backup-pull $DATE: $count workspace(s) + D1 → $DEST"
