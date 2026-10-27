# topup_refunded_by_provider (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/card-refunds.ts (applyProviderRefund) after a refund or chargeback that we did not start was debited from the wallet as one `chargeback` entry (ref `chargeback:<refundId>`). Fields: `workspace`, `orderId`.
## Impact
The merchant's wallet was reduced by the refunded amount (up to what the top-up credited) and may now be negative. Messages may stop sending until the merchant tops up. The money movement is correct by design.
## Check first
1. Search logs for `{"alert":"topup_refunded_by_provider"...}` and note `workspace` and `orderId`.
2. Check the wallet: `GET /api/v1/operator/workspaces/:workspaceId/wallet` (super admin) for the `chargeback` entry.
3. Read docs/billing.md, section "Card refunds and the refund webhook", the "Refund webhook" bullet. Also watch for `refund_excess_for_review` and `refund_held`.
## Fix
1. No repair is needed: the debit posts once and a replay posts nothing.
2. Tell the merchant what happened if they ask. A wrong or duplicate debit is returned only through the adjustment flow: `POST /api/v1/operator/workspaces/:workspaceId/adjustments` and `POST /api/v1/operator/adjustments/:id/decision`.
## Verify it is resolved
The wallet shows exactly one `chargeback:<refundId>` entry for the refund.
## Related
docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enableddefault-off; refund_debit_incomplete; card_refund_over_refundable
