# refund_held (P1)
**Severity:** P1 look today
## What it means
`applyProviderRefund` in `src/core/billing/card-refunds.ts` received a Kashier refund webhook whose id differs from the id Kashier gave our own refund of the same top-up and amount (created within 7 days, not yet confirmed by a webhook). It is probably our refund under a second id, so it is HELD with no wallet movement. Fields: `workspace`, `orderId`, `refundId` (the webhook id), `candidate` (our `card_refunds` id), `candidateRefundId`.
## Impact
No money moved. The held refund waits for an operator. If it is actually a second, separate refund, the merchant has not yet been debited for it.
## Check first
1. Search the logs for `{"alert":"refund_held"...}`; note `refundId` and `candidate`.
2. D1 `card_refunds`: the row with `source = 'held'` and `kashier_refund_id = <refundId>`, and the candidate row.
3. Kashier's dashboard: is `refundId` a separate refund from `candidateRefundId`?
4. Read docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off (Id mismatch trap).
## Fix
1. Run `POST /api/v1/operator/card-refunds/held/:refundId/match` (super admin). It verifies with Kashier and confirms our refund without moving money.
2. If Kashier lists both ids as separate successful refunds, the match is refused (`separate_refund_debited`) and the held one is debited as an unknown refund: see refund_held_debited.
3. The system does not clear a held row by itself.
## Verify it is resolved
The held row's state is `matched` (a repeat of the match call returns `{ ok: true }`) and no new `refund_held` appears for that id.
## Related
refund_held_debited, refund_id_conflict, docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off
