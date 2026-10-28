# card_refund_stuck (P1)
**Severity:** P1 look today
## What it means
Fires once per card refund from `reconcileCardRefunds` (src/core/billing/card-refunds.ts) when a refund row is still `sending`, `pending` or `uncertain` after 3 days (older than `STUCK_AFTER_MS`). Fields: `id` (card refund row), `workspace`, `state`.
## Impact
Money may have left to the customer's card, or may not have. The system cannot tell, and it will never re-send the refund by itself.
## Check first
1. Search logs for `{"alert":"card_refund_stuck"` and note `id`, `workspace`, `state`.
2. Read the `card_refunds` row in D1 (`state`, `kashier_refund_id`, `amount_minor`, `order_id`).
3. Look at Kashier's dashboard for a refund on that order with that amount.
4. Read docs/billing.md (refunds, "uncertain").
## Fix
1. A person checks Kashier's dashboard (docs/billing.md says so). The alert fires once, so it will not remind you.
2. If Kashier shows the refund was paid: link it with `POST /api/v1/operator/refund-requests/:id/link-dashboard-refund` (see docs/billing.md).
3. If Kashier shows no refund was made: `POST /api/v1/operator/refund-requests/:id/card-refunds/:cardRefundId/mark-failed` turns it into a manual payout.
4. Never repeat a provider refund call by hand.
## Verify it is resolved
The row is `succeeded` or `failed` (not open) and the refund request is no longer waiting on it (`GET /api/v1/operator/refund-requests`).
## Related
docs/billing.md (refunds); alerts: card_refund_reconcile_failed, card_refund_over_refundable
