# billing_unpriced_model (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/engine.ts (settleDelivered) when Meta's status for a delivered message names a pricing model other than PMP. Fields: `workspace`, `model` (first 16 characters of Meta's `pricing_model`).
## Impact
The send row is marked `unpriced` and its wallet hold is released: the merchant is not charged for that message. Meta may have billed the platform, so we may be out of pocket by that amount. Merchant balances are not wrong.
## Check first
1. Search logs for `{"alert":"billing_unpriced_model"...}` and note `workspace` and `model`.
2. Read the workspace Durable Object table `billable_sends` for rows with `unpriced = 1`.
3. Read docs/billing.md, section "Money flow for a platform_line message", step 4 (Meta statuses).
## Fix
1. The system does not retry or charge these rows. Whether to charge the merchant: Not documented in code: ask the engineer on call.
2. If a charge is decided, use the documented operator adjustment flow: `POST /api/v1/operator/workspaces/:workspaceId/adjustments` then `POST /api/v1/operator/adjustments/:id/decision` (large amounts need a second super admin).
3. A recurring model means Meta changed its pricing model; the engineer on call must update the pricing code.
## Verify it is resolved
No new alert for new deliveries of that model, and any decided adjustment shows in `GET /api/v1/operator/workspaces/:workspaceId/wallet`.
## Related
docs/billing.md#money-flow-for-a-platform_line-message; rate_missing_no_estimate
