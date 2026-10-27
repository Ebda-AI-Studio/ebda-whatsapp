# refund_id_conflict (P1)
**Severity:** P1 look today
## What it means
A Kashier refund id is already owned by another row in `card_refunds`, and the two disagree. Two sites: `reconcileOwned` in `src/core/billing/card-refunds.ts` (a webhook that is a chargeback or reversal carries an id our row owns; fields `workspace`, `orderId`, `refundId`, `operation`, `chargeback`) and the refund call in `src/core/billing/refunds.ts` (Kashier took our refund but its id belongs to another row; fields `requestId`, `workspace`, `refundId`, `ownedBy`).
## Impact
Money may be wrong. The event settled nothing and debited nothing, and a review item is left (`billing_audit` action `refund_id_conflict`, once per refund id). In the refunds.ts case the refund really happened at Kashier, but another row (a webhook debit or a held refund) may already have debited the same money, so the merchant may be debited twice.
## Check first
1. Search the logs for `{"alert":"refund_id_conflict"...}`; note `refundId`, `orderId`, `ownedBy`.
2. D1 `card_refunds` rows for that `order_id` and for that `kashier_refund_id` (columns `source`, `state`, `amount_minor`).
3. D1 `billing_audit` for the workspace; `GET /api/v1/operator/refund-requests` for the request.
4. Check the refund in Kashier's dashboard. Read docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off.
## Fix
1. Decide from Kashier's dashboard what really happened (one refund, or a refund plus a chargeback).
2. If the merchant was debited twice, give the money back through the adjustment flow (`POST /api/v1/operator/workspaces/:workspaceId/adjustments`, approved by a second super admin). Never edit ledger rows.
3. Not documented in code: any other resolution: ask the engineer on call. The system does not repair this itself.
## Verify it is resolved
`GET /api/v1/operator/workspaces/:workspaceId/wallet` matches what Kashier shows as refunded, and the request in `GET /api/v1/operator/refund-requests` is in a settled state.
## Related
refund_held, refund_held_debited, refund_excess_for_review, docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off
