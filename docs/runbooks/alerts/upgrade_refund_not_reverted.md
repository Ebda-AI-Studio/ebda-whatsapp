# upgrade_refund_not_reverted (P1)
**Severity:** P1 look today
## What it means
An upgrade order that had been granted was fully refunded, but the subscription had already moved on from the period it was granted in, so the upgrade was not rolled back (src/core/billing/package-orders.ts). Fields: `workspace`, `orderId`.
## Impact
Money was refunded but the merchant may still hold the upgraded package for the current period, and the upgrade credits were not taken back. Revenue leak until a person decides.
## Check first
1. Search logs for `{"alert":"upgrade_refund_not_reverted"` and note `orderId`.
2. Read D1 `package_orders` (kind `upgrade`, `from_package`, `quoted_period_start`) and the current `workspace_subscriptions` row.
3. Read docs/billing.md, "Packages: three writers, one place".
## Fix
1. A person decides whether to put the workspace back on `from_package`. The operator route is PUT /api/v1/operator/workspaces/:workspaceId/subscription (needs reason; refuses `store-included` and a past `periodEnd` for active).
2. The system does not do this itself.
3. Do not delete or edit ledger rows. For credits, Not documented in code: ask the engineer on call.
## Verify it is resolved
`workspace_subscriptions.package_id` is the intended package and the version has gone up.
## Related
docs/billing.md, alerts: package_refunded, upgrade_stranded_by_owner_refund
