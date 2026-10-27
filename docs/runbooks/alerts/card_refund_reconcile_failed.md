# card_refund_reconcile_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `reconcileCardRefunds` (src/core/billing/card-refunds.ts) when checking one card refund with Kashier throws during the daily pass, or from `dailyBilling` when the step as a whole throws. Fields: `id` (the card refund row), `error` (error class name).
## Impact
A card refund that was sent to the provider is not yet confirmed as succeeded or failed on our side. The wallet is not moved by reconciliation. A refund must never be re-sent: the system never repeats the provider call.
## Check first
1. Search logs for `{"alert":"card_refund_reconcile_failed"` and note `id` and `error`.
2. Read the `card_refunds` row in D1: `state` (`sending`, `pending` or `uncertain` means open), `kashier_refund_id`, `created_at`.
3. Check Kashier's dashboard for that refund.
4. Read docs/billing.md (refunds).
## Fix
1. The daily pass retries the lookup. Nothing is ever re-sent, so waiting is safe.
2. If Kashier shows the refund failed, an operator can use `POST /api/v1/operator/refund-requests/:id/card-refunds/:cardRefundId/mark-failed` (it turns it into a manual payout).
3. If Kashier shows it succeeded and our row stays open, use `POST /api/v1/operator/refund-requests/:id/link-dashboard-refund` as described in docs/billing.md.
## Verify it is resolved
The `card_refunds` row leaves the open states and the alert stops on the next daily pass.
## Related
docs/billing.md (refunds); alerts: card_refund_stuck, card_refund_over_refundable, refund_debit_incomplete
