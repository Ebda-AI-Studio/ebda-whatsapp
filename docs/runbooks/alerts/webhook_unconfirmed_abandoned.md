# webhook_unconfirmed_abandoned (P1)
**Severity:** P1 look today
## What it means
`reconfirmUnconfirmed` (`src/core/billing/topups.ts`) gave up on a kept Kashier webhook: 14 attempts, or the signature was rejected (401). The `unconfirmed_webhooks` row is set to `abandoned` and never retried. Fields: `eventKey`, `firstSeen`, `attempts`.
## Impact
A payment, refund or chargeback may have happened at Kashier with no effect on our side. Money may be wrong: a merchant may have paid and not been credited or granted.
## Check first
1. Search logs for `{"alert":"webhook_unconfirmed_abandoned"...}`; note `eventKey`.
2. D1 (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT event_key, order_id, attempts, last_reason FROM unconfirmed_webhooks WHERE event_key = '<eventKey>'"`.
3. Using that `order_id`, read the `topups` or `package_orders` row and compare with the Kashier dashboard.
4. Read docs/billing.md, "Top-ups".
## Fix
1. The system does not retry an abandoned row.
2. If Kashier shows the payment as successful and our row is not credited or granted, use the documented operator routes: a package via `PUT /api/v1/operator/workspaces/:workspaceId/subscription`, a wallet credit via the adjustments flow (`POST /api/v1/operator/workspaces/:workspaceId/adjustments`). Confirm the choice with the engineer on call.
3. Do not edit the `unconfirmed_webhooks` row.
## Verify it is resolved
The order shows the right state (credited or granted, or confirmed failed at Kashier) and nothing is left unexplained.
## Related
docs/billing.md; webhook_unconfirmed_aged; webhook_reconfirm_failed
