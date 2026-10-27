# package_paid_not_granted (P0)
**Severity:** P0 wake someone now
## What it means
The daily `repairPackageOrders` (`src/core/billing/package-orders.ts`) found a `package_orders` row with `status = 'paid'`, `granted_at IS NULL` and a `provider_ref`. That should be impossible, because claim and grant run in one batch. Fields: `workspace`, `orderId`. Switch-kind orders are reported elsewhere.
## Impact
A merchant paid for a package and may not have the plan. Money was taken.
## Check first
1. Search logs for `{"alert":"package_paid_not_granted"...}`; note `orderId`.
2. D1 (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT order_id, status, granted_at, provider_ref FROM package_orders WHERE order_id = '<id>'"`.
3. Check `package_repair_failed` for the same `orderId`; read docs/billing.md, "Packages: three writers", item 6 (Daily).
## Fix
1. The system repairs itself: the same pass immediately calls `grantOrder` for the row. If it succeeds, `granted_at` is set and no more action is needed.
2. If `package_repair_failed` follows, ask the engineer on call. As a stopgap the operator can assign the plan with `PUT /api/v1/operator/workspaces/:workspaceId/subscription`.
3. Why the grant was skipped: Not documented in code: ask the engineer on call.
## Verify it is resolved
The row has `granted_at` set, `GET /api/v1/operator/workspaces/:workspaceId/wallet` or the workspace subscription shows the package, and the alert is absent from the next daily pass.
## Related
docs/billing.md; instapay_confirmed_not_granted; package_amount_mismatch
