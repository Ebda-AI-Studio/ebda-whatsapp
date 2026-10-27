# yearly_refund_debt_not_posted (P1)
**Severity:** P1 look today
## What it means
During the daily repair (`repairRefundPlans` in src/core/billing/package-orders.ts) an applied yearly refund plan's wallet debt credit could not be posted. Fields: `workspace`, `orderId`, `error` (error name only).
## Impact
Money may be wrong: the merchant's wallet debt that should have been settled from the refund has not been credited yet, so their balance is lower than it should be.
## Check first
1. Search logs for `{"alert":"yearly_refund_debt_not_posted"` and read `error`.
2. Read D1 `package_refund_plans` for the order: `applied = 1`, `debt_settled_minor > 0`, `debt_posted = 0`.
3. Check GET /api/v1/operator/workspaces/:workspaceId/wallet for the `yearly-refund-debt:<orderId>` ledger ref.
4. Read docs/billing.md, "Yearly packages" (debt bullet).
## Fix
1. The system retries it every day with the same fixed ref, so it can only land once. Usually waiting is enough.
2. If it keeps failing, check that the workspace Durable Object is reachable. Not documented in code: ask the engineer on call. Do not post a manual adjustment while the daily retry is still pending, or it could double-credit.
## Verify it is resolved
`package_refund_plans.debt_posted = 1` and the wallet shows the `yearly-refund-debt:<orderId>` credit once.
## Related
docs/billing.md ("Yearly packages"), alert: package_refunded
