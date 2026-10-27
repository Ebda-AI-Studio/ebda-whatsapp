# refund_unmatched_no_credit (P1)
**Severity:** P1 look today
## What it means
`applyProviderRefund` in `src/core/billing/card-refunds.ts` received a confirmed refund or chargeback from Kashier that we did not start, for a top-up that credited the wallet nothing (`amount_minor` is 0 or less), so there is nothing to take back. Fields: `workspace`, `orderId`, `refundId`, `amountMinor`. The webhook is answered 200 and a review item is recorded once (`billing_audit` action `refund_unmatched_review`).
## Impact
No wallet movement was made. Money went back to a card at Kashier, but the wallet was never credited by this top-up, so the platform may be out of pocket by `amountMinor`. Merchants see no change.
## Check first
1. Search the logs for `{"alert":"refund_unmatched_no_credit"...}`; note `orderId`, `refundId`, `amountMinor`.
2. D1 `topups` row for that `order_id` (`amount_minor`, `fee_minor`, `refunded_minor`, status), and `billing_audit` for the review item.
3. Kashier's dashboard: who issued the refund, and for which payment.
## Fix
1. Decide with the engineer on call whether it is a refund of a payment that was never credited (nothing to do) or a mismatch of order ids.
2. Not documented in code: any wallet correction here: ask the engineer on call. Do not edit ledger rows; wallet corrections go through the adjustment flow (`POST /api/v1/operator/workspaces/:workspaceId/adjustments`, second approver).
3. The system does not retry this: the delivery was answered.
## Verify it is resolved
A person has recorded the decision on the review item and the top-up and Kashier agree.
## Related
refund_excess_for_review, refund_id_conflict, docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off
