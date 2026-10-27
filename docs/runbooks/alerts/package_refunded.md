# package_refunded (P1)
**Severity:** P1 look today
## What it means
A refund covering the whole package order was applied (src/core/billing/package-orders.ts). A chargeback raises `package_chargeback` instead. Fields: `workspace`, `orderId`, `amountMinor` (this refund, minor units), `eventKey`.
## Impact
The order is now `refunded`. If it owned the running period the plan is cancelled with `period_end = now` and unused credits expire. The merchant loses the package. Money moved at the provider; check it matches.
## Check first
1. Search logs for `{"alert":"package_refunded"` and note `orderId`.
2. Confirm the refund was expected (merchant request or provider dashboard).
3. Read the order's state in D1 `package_orders` (status `refunded`, `refunded_minor`) and `workspace_subscriptions`.
4. Read docs/billing.md, "Packages: three writers, one place", the Full refund paragraph.
## Fix
1. Normally none: this is a notice. The system already cancelled the plan and expired credits.
2. If the refund was a mistake, Not documented in code: ask the engineer on call. Do not edit ledger rows.
## Verify it is resolved
The subscription is `cancelled` or fell back to `store-included`, and GET /api/v1/operator/workspaces/:workspaceId/wallet looks right.
## Related
docs/billing.md ("Packages: three writers, one place"), alerts: package_partial_refund, upgrade_refund_not_reverted, upgrade_stranded_by_owner_refund
