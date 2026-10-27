# refund_reversal_blocked (P1)
**Severity:** P1 look today
## What it means
An operator abandoned a partly debited refund request, but `reverseUnreversedChunks` in `src/core/billing/card-refunds.ts` refused to give the wallet chunks back because at least one card refund row of the request may already have sent money (state calling, succeeded, uncertain, pending or linked). Fields: `requestId`, `workspace`. Raised once per request.
## Impact
Money may be wrong. The merchant's wallet was debited at approval, and since the card refund may have gone out, nothing was returned. If the card refund did not actually go out, the merchant is out of pocket.
## Check first
1. Search the logs for `{"alert":"refund_reversal_blocked"...}`; note `requestId`.
2. `GET /api/v1/operator/refund-requests` for that request, and D1 `card_refunds` rows with `request_id = <requestId>` (their `state`).
3. Kashier's dashboard: was money actually refunded for each row?
4. Read docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off (Abandoning a partly debited request).
## Fix
1. Settle each open row first: if Kashier shows no refund, `POST /api/v1/operator/refund-requests/:id/card-refunds/:cardRefundId/mark-failed`; if the card was refunded in the dashboard, `POST /api/v1/operator/refund-requests/:id/link-dashboard-refund`.
2. Not documented in code: returning the wallet debit after that: ask the engineer on call. The system does not repair this itself.
## Verify it is resolved
No row of the request is in a money-may-have-left state without an explanation, and the wallet matches what Kashier shows.
## Related
refund_debit_incomplete, refund_abandon_sweep_failed, docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off
