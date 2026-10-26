# Cloudflare account setup (Ebda WhatsApp)

Account: personal/Whisky 11 (`69188202efc4df480140dd76545aa3ab`, pinned as `account_id` in `wrangler.jsonc`; `wrangler whoami` also lists another account, never deploy there).

## Resources
| Resource | Name | Status |
|---|---|---|
| Worker | `ebda-wa` (workers.dev) | live |
| D1 | `ebda-wa-platform` | live |
| Queues | `ebda-wa-send`, `ebda-wa-send-dlq` (consumed by this Worker: dead letters are marked failed and alerted) | live |
| R2 | `ebda-wa-media` | live |
| R2 | `ebda-wa-backups` (+ 30-day lifecycle) | create at the next approved deploy: `npx wrangler r2 bucket create ebda-wa-backups` then `npx wrangler r2 bucket lifecycle add ebda-wa-backups expire-30d --expire-days 30` |
| R2 | `ebda-wa-logs` (+ 30-day lifecycle) | create with Logpush (below) |

## Logs (G7, iceberg E3)
Workers Logs are on (`observability.enabled`). Logpush of Workers trace events to R2 `ebda-wa-logs` with 30-day retention. Needs an API token with *Logs: Edit* (account) and an R2 access key pair for the bucket (R2 → Manage API tokens → Object Read & Write on `ebda-wa-logs`); Ahmad runs these at deploy:

```sh
export CF_ACCOUNT=69188202efc4df480140dd76545aa3ab CF_TOKEN=<token with Logs: Edit> R2_KEY_ID=<r2 access key id> R2_SECRET=<r2 secret>
npx wrangler r2 bucket create ebda-wa-logs
npx wrangler r2 bucket lifecycle add ebda-wa-logs expire-30d --expire-days 30
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/logpush/jobs" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"ebda-wa-workers-trace","dataset":"workers_trace_events","enabled":true,
    "destination_conf":"r2://ebda-wa-logs/{DATE}?account-id='"$CF_ACCOUNT"'&access-key-id='"$R2_KEY_ID"'&secret-access-key='"$R2_SECRET"'",
    "filter":"{\"where\":{\"key\":\"ScriptName\",\"operator\":\"eq\",\"value\":\"ebda-wa\"}}",
    "output_options":{"field_names":["Event","EventTimestampMs","Logs","Exceptions","Outcome","ScriptName"],"timestamp_format":"rfc3339"}}'
```
The answer's `result.id` is the **job id: write it in the table below**. Verify (5 minutes after traffic):
```sh
curl -sS -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/logpush/jobs/<job id>" | jq '.result | {enabled, last_complete, last_error, error_message}'
```
Verified means `enabled: true`, `last_complete` is recent and `error_message` is null, and the bucket shows dated objects (R2 dashboard, or an S3 client against the account endpoint). Logs hold no message bodies or raw phone numbers (code logs class names and masked values only). The bucket's 30-day lifecycle is the retention.

| Item | Value |
|---|---|
| Logpush job id | ______ (fill in at deploy) |
| Verified on | ______ |

## Uptime on /health (iceberg E4)
`/health` already answers 503 when a required secret is missing, so a monitor on it also catches misconfiguration. Pick ONE (Ahmad creates it at deploy):
- **Cloudflare Health Check** (zone-level; needs a plan that includes Health Checks and the `ebda.app` zone in this account):
  ```sh
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/<zone id>/healthchecks" -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    --data '{"name":"ebda-wa-health","address":"wa.ebda.app","type":"HTTPS","check_regions":["WEU","ME"],"interval":60,"retries":2,"http_config":{"method":"GET","path":"/health","expected_codes":["200"],"port":443}}'
  ```
  then Notifications → *Health Check Status* → destination: the e-mail/PagerDuty you read (Cloudflare notifications cannot post to Telegram directly).
- **External prober** (free, the same one Ebda Store uses, UptimeRobot): HTTPS monitor on `https://wa.ebda.app/health`, keyword `"ok":true`, 1-minute interval, alert contact = the Ebda alerts Telegram chat.
Verify: stop it deliberately for one interval (a wrong `REQUIRED_SECRETS` var on a throwaway deploy makes `/health` 503) and confirm the alert arrives; record the monitor id here: ______

## Alert channel
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` (worker secrets, same bot/chat as Ebda Store): see `docs/runbooks/alerts.md`.

## Card webhook routing
`/kashier/*` is in `assets.run_worker_first`, so the provider's POST reaches the Worker and not the SPA fallback. `scripts/verify-prod.mjs` posts an unsigned body to `/kashier/webhook` and expects a 4xx that is not an HTML page.

## Billing alerts (G9)
Dashboard → Notifications → Add → *Usage Based Billing* for Workers requests, Durable Objects (requests + duration + storage), D1 (rows read/written), R2 (Class A/B ops + storage), Queues operations. Thresholds: start at 2× the spike's measured monthly projection (Task 0.6 report). Ahmad clicks.

## Sentry
Project `whisky11/ebda-whatsapp` (platform node-cloudflare-workers) created 2026-10-24 with the signed-in `sentry` CLI; its DSN is stored as the worker secret `SENTRY_DSN` (never in the repo). Reporting starts with the first deploy that includes Phase 1's `withSentry` wrapper. Without the secret the worker logs `sentry: SENTRY_DSN not set` once per isolate and sends nothing.

## Secrets
`META_APP_SECRET`, `META_VERIFY_TOKEN` (set), `META_SYSTEM_TOKEN`, `SUITE_BUYER_KEY_SECRET` (same value as Ebda Store's), `SENTRY_DSN` (set), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID` (the alert channel; without them alerts go to logs and Sentry only).
