#!/usr/bin/env bash
# The ONE deploy path (Ruling WA-DEPLOY-3): Cloudflare Workers Builds runs this as the production deploy command, on a push to main. No Cloudflare
# token lives in GitHub. The build token belongs to Workers Builds (dashboard: Worker > Settings > Build > API token); it needs Workers Scripts, D1 and
# Queues edit on the personal account (docs/launch/README.md section 12 lists the exact settings). Nobody deploys from the Mac or from GitHub Actions.
#
# Build command (separate, before this): `npm run build:web`. Deploy command: `bash scripts/deploy-cf.sh`.
# Reads the Workers Builds defaults WORKERS_CI, WORKERS_CI_BRANCH and WORKERS_CI_COMMIT_SHA. Optional build variables: CLOUDFLARE_ACCOUNT_ID,
# META_VERIFY_TOKEN, META_APP_SECRET (verify-prod prints SKIP, which means NOT verified, for any check whose input is missing).
set -euo pipefail

EXPECTED_ACCOUNT_ID=69188202efc4df480140dd76545aa3ab   # personal / Whisky 11. Never deploy to the other account.
cd "$(dirname "$0")/.."

fail() { echo "deploy-cf.sh: $*" >&2; exit 1; }

# 1. Only Workers Builds on the production branch deploys. A local run, or a build of any other branch, is refused before anything is touched.
[ "${WORKERS_CI:-}" = "1" ] || fail "not running inside Workers Builds (WORKERS_CI is not 1). Deploys run only from Workers Builds (Ruling WA-DEPLOY-3)."
[ "${WORKERS_CI_BRANCH:-}" = "main" ] || fail "branch '${WORKERS_CI_BRANCH:-}' is not main. Only main deploys; turn off builds for other branches."
FULL_SHA="${WORKERS_CI_COMMIT_SHA:-}"
[ -n "${FULL_SHA}" ] || fail "WORKERS_CI_COMMIT_SHA is empty."
SHORT_SHA="${FULL_SHA:0:7}"

# 2. Account guard: wrangler.jsonc pins the account, and so must any account id the environment names.
pinned=$(sed -nE 's/.*"account_id"[[:space:]]*:[[:space:]]*"([0-9a-f]+)".*/\1/p' wrangler.jsonc | head -n1)
[ "${pinned}" = "${EXPECTED_ACCOUNT_ID}" ] || fail "wrangler.jsonc account_id is '${pinned}', expected ${EXPECTED_ACCOUNT_ID}. Refusing to deploy."
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ "${CLOUDFLARE_ACCOUNT_ID}" != "${EXPECTED_ACCOUNT_ID}" ]; then
  fail "CLOUDFLARE_ACCOUNT_ID is not ${EXPECTED_ACCOUNT_ID} (personal / Whisky 11). Refusing to deploy."
fi
[ -d web/dist ] || fail "web/dist is missing: the build command must be 'npm run build:web'."

echo "deploy-cf.sh: deploying ${SHORT_SHA} to account ${EXPECTED_ACCOUNT_ID}"

# 3. D1 first, then the code: the new code may need the new schema, and the old code tolerates it (migrations are additive, docs/runbooks/rollback.md).
npx wrangler d1 migrations list ebda-wa-platform --remote
npx wrangler d1 migrations apply ebda-wa-platform --remote
npx wrangler deploy --var "COMMIT_SHA:${SHORT_SHA}"

# 4. Prove it from the outside: the running commit must be this one, plus headers and webhooks. The live cron schedule is checked only when the build
#    has an API token and account id in its environment. A failure here fails the build AFTER the deploy: roll back by hand (docs/runbooks/rollback.md).
cron_args=()
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then cron_args=(--cron "17 1 * * *" --worker ebda-wa); fi
node scripts/verify-prod.mjs --base https://wa.ebda.app --expect "${SHORT_SHA}" --brand ebda ${cron_args[@]+"${cron_args[@]}"}
