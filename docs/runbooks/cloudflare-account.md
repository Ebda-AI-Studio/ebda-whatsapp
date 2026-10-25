# Cloudflare account setup (Ebda WhatsApp)

Account: personal/Whisky 11 (`69188202efc4df480140dd76545aa3ab`, pinned as `account_id` in `wrangler.jsonc`; `wrangler whoami` also lists another account, never deploy there).

## Resources
| Resource | Name | Status |
|---|---|---|
| Worker | `ebda-wa` (workers.dev) | live |
| D1 | `ebda-wa-platform` | live |
| Queues | `ebda-wa-send`, `ebda-wa-send-dlq` | live |
| R2 | `ebda-wa-media` | live |
| R2 | `ebda-wa-backups` (+ 30-day lifecycle) | create at the next approved deploy: `npx wrangler r2 bucket create ebda-wa-backups` then `npx wrangler r2 bucket lifecycle add ebda-wa-backups expire-30d --expire-days 30` |
| R2 | `ebda-wa-logs` (+ 30-day lifecycle) | create with Logpush (below) |

## Logs (G7)
Workers Logs are on (`observability.enabled`). Logpush of Workers trace events to R2 `ebda-wa-logs` with 30-day retention:
create the bucket and lifecycle as above, then Dashboard → Analytics & Logs → Logpush → Create job → dataset *Workers trace events* → destination R2 `ebda-wa-logs` → filter `ScriptName = ebda-wa`. Needs a Logpush-capable token; Ahmad clicks.

## Billing alerts (G9)
Dashboard → Notifications → Add → *Usage Based Billing* for Workers requests, Durable Objects (requests + duration + storage), D1 (rows read/written), R2 (Class A/B ops + storage), Queues operations. Thresholds: start at 2× the spike's measured monthly projection (Task 0.6 report). Ahmad clicks.

## Sentry
Project `whisky11/ebda-whatsapp` (platform node-cloudflare-workers) created 2026-10-24 with the signed-in `sentry` CLI; its DSN is stored as the worker secret `SENTRY_DSN` (never in the repo). Reporting starts with the first deploy that includes Phase 1's `withSentry` wrapper. Without the secret the worker logs `sentry: SENTRY_DSN not set` once per isolate and sends nothing.

## Secrets
`META_APP_SECRET`, `META_VERIFY_TOKEN` (set), `META_SYSTEM_TOKEN`, `SUITE_BUYER_KEY_SECRET` (same value as Ebda Store's), `SENTRY_DSN` (set).
