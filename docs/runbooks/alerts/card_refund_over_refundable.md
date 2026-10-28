# card_refund_over_refundable (P0)
**Severity:** P0 wake someone now
## What it means
In `src/core/billing/refunds.ts`, right before a card refund is sent, `claimForCall` re-checks that the top-up still has room (`amount_minor - refunded_minor` minus other open refunds). When it does not, the refund is not sent, the `card_refunds` row is failed atomically and the amount becomes a manual payout. Fields: `requestId`, `workspace`, `cardRefundId`, `amountMinor`. The call site passes `severity: 'P1'`; this runbook treats it as P0 per policy.
## Impact
No card money was sent for this row, but the wallet was already debited. The merchant is owed a manual payout. Money is wrong until it is paid or reversed.
## Check first
1. Search logs for `{"alert":"card_refund_over_refundable"...}`; note `requestId`, `cardRefundId`.
2. `GET /api/v1/operator/refund-requests` and find the request; check it shows a manual amount.
3. Read docs/billing.md, "Card refunds", the item about `card_refund_over_refundable`.
## Fix
1. Do not retry the card refund.
2. Pay the manual amount outside the system, then record it with `POST /api/v1/operator/refund-requests/:id/manual-paid`.
3. Why another approval took the room: Not documented in code: ask the engineer on call.
## Verify it is resolved
The request reaches `paid` (manual payout recorded) and the alert does not repeat for the same `cardRefundId`.
## Related
docs/billing.md; refund_debit_incomplete; docs/runbooks/alerts.md
