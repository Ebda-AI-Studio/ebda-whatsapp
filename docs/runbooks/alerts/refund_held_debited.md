# refund_held_debited (P1)
**Severity:** P1 look today
## What it means
An operator matched a held refund (`matchHeldRefund` in `src/core/billing/card-refunds.ts`) but Kashier lists BOTH the held id and our refund's own id as separate successful refunds: money left Kashier twice. The match was refused and the held refund was debited from the wallet as an unknown refund. Fields: `workspace`, `orderId`, `refundId`, `candidate`, `debitedMinor` (capped at what the top-up credited).
## Impact
Money moved. The merchant's wallet was debited `debitedMinor` (it may go into debt) on top of the debit taken at approval, which is correct only if the second refund was real.
## Check first
1. Search the logs for `{"alert":"refund_held_debited"...}`; note `refundId`, `debitedMinor`.
2. Confirm in Kashier's dashboard that two separate refunds exist for the order.
3. D1 `card_refunds` for the order (the former held row is now `source = 'webhook'`, `state = 'succeeded'`), and `GET /api/v1/operator/workspaces/:workspaceId/wallet` for the ledger entry `chargeback:<refundId>`.
## Fix
1. If the second refund was real, nothing to undo. Check the merchant is informed.
2. If it was not real, give the money back through the adjustment flow (`POST /api/v1/operator/workspaces/:workspaceId/adjustments`; a second super admin approves). Never edit ledger rows.
3. The system does not repair this itself; the debit is idempotent so a retry cannot debit twice.
## Verify it is resolved
The wallet balance matches the real refunds in Kashier, and an adjustment (if made) appears as approved in `GET /api/v1/operator/adjustments`.
## Related
refund_held, refund_excess_for_review, docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enabled-default-off
