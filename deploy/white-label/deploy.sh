#!/usr/bin/env bash
# Deploys a white-label tenant from its rendered config, after proving web/dist was built for THAT tenant's brand.
# Usage: deploy/white-label/deploy.sh wrangler.<prefix>.jsonc
set -euo pipefail
cd "$(dirname "$0")/../.."
CFG="${1:-}"
[ -n "$CFG" ] || { echo "usage: deploy/white-label/deploy.sh wrangler.<prefix>.jsonc" >&2; exit 2; }
CFG_PATH="deploy/white-label/${CFG##*/}"
[ -f "$CFG_PATH" ] || { echo "error: $CFG_PATH not found (render it with bootstrap.sh)" >&2; exit 2; }
BRAND="$(sed -n 's/^[[:space:]]*"BRAND": "\([a-z0-9-]*\)",\{0,1\}$/\1/p' "$CFG_PATH" | head -1)"
[ -n "$BRAND" ] || { echo "error: no BRAND var in $CFG_PATH" >&2; exit 2; }
# OIDC_ISSUER (optional): the issuer in the tenant's IDENTITY_OIDC_CONFIG. When the brand signs in on its own provider, web/dist must name
# the same one (tokens from another issuer never verify) and its CSP must list exactly that origin.
node scripts/check-dist-brand.mjs web/dist "$BRAND"
npx wrangler deploy -c "$CFG_PATH" --var "COMMIT_SHA:$(git rev-parse --short HEAD)"
echo "Next: node scripts/verify-prod.mjs --base <https origin> --expect $(git rev-parse --short HEAD) --brand $BRAND"
