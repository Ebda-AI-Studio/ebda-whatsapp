# Deploy, rollback and the forward-only migration rule

## Deploying (the normal path)
Actions → **cf-deploy** → *Run workflow* on `main` (a human go; nothing deploys by itself). It refuses any commit that is not on `main` and any Cloudflare account except the personal one (`69188202efc4df480140dd76545aa3ab`), then: typecheck → `wrangler d1 migrations list` → `apply --remote` (D1 first) → `wrangler deploy --var COMMIT_SHA:<sha>` → `scripts/verify-prod.mjs --expect <sha>` (fails the job if `/health` reports another commit, and prints the live cron schedule). A failed run sends a Telegram message with the commit and the run link.

Secrets the workflow needs (repo → Settings → Secrets; Ahmad creates them, nothing here creates them):
| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts: Edit and D1: Edit on the personal account (deploy, migrations, reading the cron schedule) |
| `CLOUDFLARE_ACCOUNT_ID` (secret or variable) | must equal `69188202efc4df480140dd76545aa3ab`, or the job stops |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` | the failure notice (same bot and chat as the runtime alerts) |
| `META_VERIFY_TOKEN`, `META_APP_SECRET` | optional: lets verify-prod also run the webhook handshake and signed-webhook checks (otherwise they print SKIP) |

The first deploy (GO-1) is done by hand from Ahmad's Mac with OAuth wrangler: see `docs/launch/README.md` section 12.

## Rolling back the code
1. `npx wrangler versions list` → pick the last good version id (the Worker keeps recent versions).
2. `npx wrangler rollback <version id>` (or Dashboard → Workers → ebda-wa → Deployments → Rollback).
3. Verify: `node scripts/verify-prod.mjs --base https://wa.ebda.app --expect <the OLD short sha> --brand ebda`. `/health` reports the commit baked into that version, so the check passes only if the old code is serving. A `COMMIT_SHA` that does not match means the rollback did not take effect: do not assume it did.
4. Open the incident (below) and fix forward; do not leave production on an old version without a ticket.

A rollback restores code only. It does not touch the D1 schema, the Durable Object schemas, queues, R2 or secrets.

## Why a rollback is safe: migrations are forward-only AND additive
- **D1** (`migrations/d1/*.sql`) and **Durable Object SQLite** (`src/core/do-migrations.ts`, applied in order and recorded in `_migrations`) only move forward. There is no "down" migration, and a rollback never reverses one.
- So the previous Worker version will run against the NEWER schema. That works only if no migration removes or renames anything the older code uses. Every migration is therefore **additive**: new tables, new columns (with a default or nullable), new indexes, new seed rows. The guard test `test/migrations-additive.test.ts` fails CI on `DROP TABLE/COLUMN/INDEX/VIEW/TRIGGER`, `RENAME`, `ALTER ... DROP/RENAME/ALTER`, `DELETE FROM`, `TRUNCATE` or `writable_schema` in any D1 or DO migration. A destructive step needs an explicit, reasoned entry in that test's `ALLOWED` list and a human decision first.
- To retire a column or table: stop using it in one release, wait until no rollback target still reads it, then drop it by a reviewed, allow-listed migration.
- Data written by the new code during the bad window stays; the old code ignores columns it does not know. A rollback therefore never loses data.
- DO migrations run on first access of each workspace, so after a deploy some workspaces are on the new schema and some not yet; both are fine because the new code only adds.

## After a rollback: verify, then investigate
- `verify-prod` PASS on every line you can run; SKIP lines are NOT verified, say so.
- Check the cron: `verify-prod` prints the live schedule when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set (add `--cron "17 1 * * *" --worker ebda-wa`). The daily cron cannot be waited on, so a REAL tick is proven by the next run's `{"cron":"daily_billing","done":true}` log line (Workers Logs), or immediately with a manual `scheduled` call: `npx wrangler dev --test-scheduled` locally, `curl "http://localhost:8787/__scheduled?cron=17+1+*+*+*"`.
- Entitlements are re-sent by that daily run; a rollback never changes them.

## Incident runbooks (what a P0/P1 Telegram alert links to)
Every alert links to `docs/runbooks/alerts.md#<alert name>` (added with the alert channel). The ones you will meet during or after a deploy:
- `unhandled_error` → alerts.md#unhandled_error (a route threw after the deploy: roll back first, then read Sentry)
- `secret_misconfigured` → alerts.md#secret_misconfigured (`/health` is 503 after the deploy: a secret is missing, set it, no rollback needed)
- `send_dlq` → alerts.md#send_dlq
- `entitlement_push_failed` → alerts.md#entitlement_push_failed
- `ledger_mirror_mismatch` → alerts.md#ledger_mirror_mismatch (money: stop and read `docs/billing.md` before any rollback)
- Backups and restoring data: `docs/runbooks/backup-restore.md`.
