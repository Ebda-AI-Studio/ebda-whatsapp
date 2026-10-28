# refund_excess_for_review (P1)
**Severity:** P1 look today
## What it means
`applyProviderRefund` in `src/core/billing/card-refunds.ts` received a refund or chargeback we did not start that is larger than what the top-up credited to the wallet, and the card fee (`fee_minor`) does not explain the difference. The wallet debit was capped at the credited amount. Fields: `workspace`, `orderId`, `refundId`, `excessMinor` (the unexplained part), `chargeback`. The excess is also noted on the `card_refunds` row and in `billing_audit` (`refund_excess_review`).
## Impact
Money may be wrong. The merchant was debited the credited amount (the wallet may go into debt), but `excessMinor` left Kashier without a matching debit, so the platform may be out of pocket by that amount.
## Check first
1. Search the logs for `{"alert":"refund_excess_for_review"...}`; note `excessMinor` and `chargeback`.
2. D1 `topups` for the `order_id` (`amount_minor`, `fee_minor`, `refunded_minor`) and `card_refunds` row `wh:<refundId>` (its `note` holds `excess_minor` and `fee_minor`).
3. Kashier's dashboard: the real refund or chargeback amount.
## Fix
1. Decide with the engineer on call whether the excess is a fee or a real loss.
2. Not documented in code: any further wallet correction: ask the engineer on call. Never edit ledger rows; corrections use the adjustment flow (`POST /api/v1/operator/workspaces/:workspaceId/adjustments`, second approver).
3. The system does not repair this itself.
## Verify it is resolved
The decision is recorded and the wallet (`GET /api/v1/operator/workspaces/:workspaceId/wallet`) matches the real refunds in Kashier.
## Related
refund_unmatched_no_credit, refund_held_debited, docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off
