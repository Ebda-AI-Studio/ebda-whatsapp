#!/usr/bin/env bash
# Ebda WhatsApp: create the account resources this Worker binds to (docs/launch/README.md §6).
# Idempotent: lists what exists and only creates what is missing.
# DRY RUN by default (reads only, prints the commands it would run). `--apply` creates; run it only after the launch go.
# Refuses any Cloudflare account except the personal one in wrangler.jsonc.
set -euo pipefail

ACCOUNT=69188202efc4df480140dd76545aa3ab
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
W="npx wrangler"

cd "$(dirname "$0")/.."
grep -q "\"account_id\": \"$ACCOUNT\"" wrangler.jsonc || { echo "wrangler.jsonc is not pinned to $ACCOUNT; refusing"; exit 2; }
$W whoami 2>/dev/null | grep -q "$ACCOUNT" || { echo "wrangler is not logged in to account $ACCOUNT; refusing"; exit 2; }
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT

todo=0
run() { # run <description> <command...>
  local what=$1; shift
  todo=$((todo + 1))
  if [ $APPLY = 1 ]; then echo "create: $what"; "$@"; else echo "would create: $what  →  $*"; fi
}
have() { grep -qx -- "$1" <<<"$2"; }

# ---- D1 (the database id is already in wrangler.jsonc; the database must exist under it).
d1=$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const d of JSON.parse(s))console.log(d.name)})')
have ebda-wa-platform "$d1" && echo "ok: D1 ebda-wa-platform" || run "D1 ebda-wa-platform (then put its id in wrangler.jsonc)" $W d1 create ebda-wa-platform

# ---- R2 buckets (+ 30-day lifecycle on backups).
r2=$($W r2 bucket list 2>/dev/null | sed -n 's/^name:[[:space:]]*//p')
for b in ebda-wa-media ebda-wa-backups; do
  have "$b" "$r2" && echo "ok: R2 $b" || run "R2 bucket $b" $W r2 bucket create "$b"
done
if have ebda-wa-backups "$r2" && $W r2 bucket lifecycle list ebda-wa-backups 2>/dev/null | grep -q expire-30d; then echo "ok: R2 ebda-wa-backups lifecycle expire-30d"
else run "R2 lifecycle expire-30d on ebda-wa-backups" $W r2 bucket lifecycle add ebda-wa-backups expire-30d --expire-days 30 -y; fi

# Import CSVs hold customers' phone numbers: the app deletes each one when its import ends; this 7-day expiry is the backstop (R2 bucket ebda-wa-media, prefix imports/).
if have ebda-wa-media "$r2" && $W r2 bucket lifecycle list ebda-wa-media 2>/dev/null | grep -q imports-expire-7d; then echo "ok: R2 ebda-wa-media lifecycle imports-expire-7d"
else run "R2 lifecycle imports-expire-7d on ebda-wa-media (prefix imports/)" $W r2 bucket lifecycle add ebda-wa-media imports-expire-7d imports/ --expire-days 7 -y; fi

# ---- Queues: sends (live now) and the Store link pair (bound once the Store side exists).
qs=$($W queues list 2>/dev/null | grep -oE 'ebda-[a-z-]+' | sort -u || true)
for q in ebda-wa-send ebda-wa-send-dlq ebda-wa-events ebda-wa-events-dlq ebda-store-events; do
  have "$q" "$qs" && echo "ok: queue $q" || run "queue $q" $W queues create "$q"
done

# ---- Vectorize (AI knowledge base; @cf/baai/bge-m3 = 1024 dimensions).
vx=$($W vectorize list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const d of JSON.parse(s))console.log(d.name)}catch{}})')
have ebda-wa-kb "$vx" && echo "ok: Vectorize ebda-wa-kb" || run "Vectorize ebda-wa-kb" $W vectorize create ebda-wa-kb --dimensions=1024 --metric=cosine

# Analytics Engine datasets and Workflows are created by the deploy itself; Durable Object SQLite migrates in code.
echo
if [ $APPLY = 1 ]; then echo "applied $todo change(s). Next: uncomment the matching bindings in wrangler.jsonc, then migrations + deploy (docs/launch §11-12)."
else echo "dry run: $todo resource(s) missing. Nothing was created. Re-run with --apply after the launch go."; fi
