# package_refund_contention (P1)
**Severity:** P1 look today
## What it means
In `src/core/billing/topups.ts` the Kashier webhook handler caught `RefundContention` from `applyPackageWebhook` (`src/core/billing/package-orders.ts`): a package refund lost six races in a row against another change to the same order. Field: `eventKey`. The webhook is answered 500 and kept as an unconfirmed webhook with reason `refund_contention`.
## Impact
That package refund is not applied yet, so the order still shows paid and the plan is unchanged. No money was posted wrongly. Kashier retries the delivery and the daily pass retries it.
## Check first
1. Search the logs for `{"alert":"package_refund_contention"...}`; note `eventKey`.
2. D1 `unconfirmed_webhooks` rows with reason `refund_contention`, and the `package_orders` row for the order.
3. Read docs/billing.md#top-ups-74-topups_enabledtrue (webhook retry rules).
## Fix
1. The system repairs itself: Kashier redelivers, and the daily `reconfirmUnconfirmed` pass runs the kept webhook again (one attempt a day, up to 14).
2. If `webhook_unconfirmed_aged` or `webhook_unconfirmed_abandoned` follows, treat that as the real incident and escalate to the engineer on call.
## Verify it is resolved
The `package_orders` row shows the refund (status refunded, or `refunded_minor` raised) and the `unconfirmed_webhooks` row is closed.
## Related
package_refund_unmatched, webhook_unconfirmed_aged, docs/billing.md#top-ups-74-topups_enabledtrue
