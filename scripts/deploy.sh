#!/usr/bin/env bash
# The ONE deploy path (Ruling WA-DEPLOY-2). The cf-deploy workflow runs it on every push to main (and on dispatch), in CI; it is not run from the Mac (MAC-LIGHT-1).
# The guards live HERE: the commit being deployed must be an ancestor of origin/main and the tree must be clean. A PR that edits this file, the workflow,
# verify-prod or wrangler.jsonc needs Ahmad's `deploy-change` label (deploy-change-label.yml), because the Free plan has no environment protection.
#
# Prerequisites (the caller does them, WITHOUT any Cloudflare secret in the environment): `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build:web`.
# Optional env: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (CI; on the Mac wrangler uses OAuth), META_VERIFY_TOKEN, META_APP_SECRET (verify-prod checks).
set -euo pipefail

EXPECTED_ACCOUNT_ID=69188202efc4df480140dd76545aa3ab   # personal / Whisky 11. `wrangler whoami` also lists another account: never deploy there.
cd "$(dirname "$0")/.."

fail() { echo "deploy.sh: $*" >&2; exit 1; }

# 1. Account guard: wrangler.jsonc pins the account, and so must any account id the environment names.
pinned=$(sed -nE 's/.*"account_id"[[:space:]]*:[[:space:]]*"([0-9a-f]+)".*/\1/p' wrangler.jsonc | head -n1)
[ "${pinned}" = "${EXPECTED_ACCOUNT_ID}" ] || fail "wrangler.jsonc account_id is '${pinned}', expected ${EXPECTED_ACCOUNT_ID}. Refusing to deploy."
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ "${CLOUDFLARE_ACCOUNT_ID}" != "${EXPECTED_ACCOUNT_ID}" ]; then
  fail "CLOUDFLARE_ACCOUNT_ID is not ${EXPECTED_ACCOUNT_ID} (personal / Whisky 11). Refusing to deploy."
fi

# 2. Only reviewed, merged code: the commit being deployed must be an ancestor of origin/main, and the tree must be exactly that commit.
git fetch --quiet origin main || fail "cannot fetch origin/main to prove the commit is merged"
SHA=$(git rev-parse HEAD)
git merge-base --is-ancestor "${SHA}" origin/main || fail "${SHA} is not an ancestor of origin/main. Only commits merged to main are deployed."
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "the working tree has uncommitted changes; deploy from a clean checkout of main"
SHORT_SHA=$(git rev-parse --short=7 "${SHA}")
[ -d web/dist ] || fail "web/dist is missing: run 'npm run build:web' first"

echo "deploy.sh: deploying ${SHORT_SHA} to account ${EXPECTED_ACCOUNT_ID}"

# 3. D1 first, then the code: the new code may need the new schema, and the old code tolerates it (migrations are additive, docs/runbooks/rollback.md).
npx wrangler d1 migrations list ebda-wa-platform --remote
npx wrangler d1 migrations apply ebda-wa-platform --remote
npx wrangler deploy --var "COMMIT_SHA:${SHORT_SHA}"

# 4. Prove it from the outside: the running commit must be this one, plus headers, webhooks and the LIVE cron schedule.
node scripts/verify-prod.mjs --base https://wa.ebda.app --expect "${SHORT_SHA}" --brand ebda --cron "17 1 * * *" --worker ebda-wa
