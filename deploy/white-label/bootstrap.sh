#!/usr/bin/env bash
# Creates a white-label tenant's Cloudflare resources in THE CLIENT'S account and renders wrangler.<prefix>.jsonc.
# Usage: deploy/white-label/bootstrap.sh --account <id> --prefix <name> --brand <brand> --identity ebda|oidc --url https://<host> [--dry-run]
# The operator must retype the account id: resources are created wherever wrangler is logged in, and this must be the client's.
set -euo pipefail
cd "$(dirname "$0")"

ACCOUNT="" PREFIX="" BRAND="" IDENTITY="" URL="" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --account) ACCOUNT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --brand) BRAND="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 2; }
[[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || fail "--account must be a 32-character Cloudflare account id"
[[ "$PREFIX" =~ ^[a-z][a-z0-9-]{2,30}$ ]] || fail "--prefix must be 3-31 chars: lowercase letters, digits, dashes (e.g. client-wa)"
[[ "$BRAND" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || fail "--brand must name a brand pack (src/addons/<brand>)"
[[ "$IDENTITY" == "ebda" || "$IDENTITY" == "oidc" ]] || fail "--identity must be ebda or oidc"
[[ "$URL" =~ ^https://[a-z0-9.-]+$ ]] || fail "--url must be the tenant's https origin (no path)"
DATASET="${PREFIX//-/_}"
OUT="wrangler.${PREFIX}.jsonc"

run() { if [ "$DRY" = 1 ]; then echo "DRY: $*"; else echo "+ $*"; "$@"; fi; }
wr() { CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" run npx wrangler "$@"; }

if [ "$DRY" = 0 ]; then
  npx wrangler whoami 2>/dev/null | grep -q "$ACCOUNT" || fail "wrangler is not logged into account $ACCOUNT (run npx wrangler login as the client's user)"
  read -r -p "Type the account id again to create resources in it: " AGAIN
  [ "$AGAIN" = "$ACCOUNT" ] || fail "account id did not match; nothing was created"
fi

wr d1 create "${PREFIX}-platform"
wr r2 bucket create "${PREFIX}-media"
wr r2 bucket create "${PREFIX}-backups"
wr r2 bucket lifecycle add "${PREFIX}-backups" expire-30d --expire-days 30
wr queues create "${PREFIX}-send"
wr queues create "${PREFIX}-send-dlq"

if [ "$DRY" = 1 ]; then
  D1_ID="00000000-0000-0000-0000-000000000000"
else
  D1_ID="$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" npx wrangler d1 info "${PREFIX}-platform" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).uuid))')"
  [[ "$D1_ID" =~ ^[0-9a-f-]{36}$ ]] || fail "could not read the D1 id"
fi

sed -e "s/__ACCOUNT_ID__/${ACCOUNT}/g" -e "s/__PREFIX__/${PREFIX}/g" -e "s/__D1_ID__/${D1_ID}/g" -e "s/__BRAND__/${BRAND}/g" \
    -e "s/__IDENTITY_MODE__/${IDENTITY}/g" -e "s#__PUBLIC_BASE_URL__#${URL}#g" -e "s/__DATASET__/${DATASET}/g" wrangler.template.jsonc > "$OUT"
grep -q "__[A-Z_]*__" "$OUT" && fail "unrendered placeholder left in $OUT"
echo "rendered $OUT"

wr d1 migrations apply "${PREFIX}-platform" --remote -c "$OUT"

cat <<NEXT

Next (see deploy/white-label/README.md):
  1. Secrets, each with: npx wrangler secret put <NAME> -c deploy/white-label/${OUT}
     META_APP_SECRET META_VERIFY_TOKEN META_SYSTEM_TOKEN TOKEN_ENC_KEY AGENT_SECRETS_KEY SENTRY_DSN$( [ "$IDENTITY" = oidc ] && echo " IDENTITY_OIDC_CONFIG" )
  2. Build the brand: BRAND=${BRAND} npm run build:web
  3. Deploy: npx wrangler deploy -c deploy/white-label/${OUT} --var COMMIT_SHA:\$(git rev-parse --short HEAD)
  4. Verify: node scripts/verify-prod.mjs --base ${URL} --expect \$(git rev-parse --short HEAD)
NEXT
