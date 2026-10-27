# webhook_reconfirm_failed (P1)
**Severity:** P1 look today
## What it means
The daily `reconfirmUnconfirmed` step (`dailyBilling` in `src/index.ts`) threw while re-running kept Kashier webhooks. Field: `error` (error class only). Other daily steps still ran.
## Impact
Payments whose first webhook could not be confirmed stay open one more day. A merchant may be waiting for a credit or a package after paying.
## Check first
1. Search logs for `{"alert":"webhook_reconfirm_failed"...}`; note `error`.
2. D1 (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT event_key, order_id, attempts, first_seen, last_reason FROM unconfirmed_webhooks WHERE status = 'open'"`.
3. Check that `KASHIER_SECRET_KEY` and `KASHIER_API_URL` are configured (see docs/billing.md, "Top-ups"); `secret_misconfigured` may be firing.
## Fix
1. The system repairs itself: one attempt a day. A row is abandoned after 14 attempts (`webhook_unconfirmed_abandoned`).
2. If it fails on consecutive days: Not documented in code: ask the engineer on call.
## Verify it is resolved
The next daily pass raises no `webhook_reconfirm_failed`, and open rows reach `resolved` or `attempts` increases.
## Related
docs/billing.md; webhook_unconfirmed_aged; webhook_unconfirmed_abandoned
