# webhook_unconfirmed_aged (P1)
**Severity:** P1 look today
## What it means
A kept Kashier webhook has stayed `open` in `unconfirmed_webhooks` for more than 24 hours after it first arrived (`reconfirmUnconfirmed`, `src/core/billing/topups.ts`). Raised once per row. Fields: `eventKey`, `firstSeen`, `lastStatus` (HTTP status of the last reconfirm attempt).
## Impact
A payment or refund is not yet confirmed, so no credit or grant happened. A merchant may be waiting. It can still resolve: the pass keeps trying once a day until 14 attempts.
## Check first
1. Search logs for `{"alert":"webhook_unconfirmed_aged"...}`; note `eventKey`, `lastStatus`.
2. D1 (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT event_key, order_id, attempts, last_reason FROM unconfirmed_webhooks WHERE event_key = '<eventKey>'"`.
3. `lastStatus` 503 means Kashier could not be reached or did not confirm the transaction; check `KASHIER_SECRET_KEY` and `KASHIER_API_URL`.
4. Read docs/billing.md, "Top-ups".
## Fix
1. The system repairs itself: the daily pass retries until it resolves or is abandoned (`webhook_unconfirmed_abandoned`).
2. Fix any root cause such as a missing secret (`npx wrangler secret put KASHIER_SECRET_KEY`; never print values). If it keeps failing, ask the engineer on call.
## Verify it is resolved
The row's `status` becomes `resolved` with a `resolution` such as `credited` or `granted`.
## Related
docs/billing.md; webhook_unconfirmed_abandoned; webhook_reconfirm_failed
