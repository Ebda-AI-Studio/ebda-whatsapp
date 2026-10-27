# package_repair_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `repairPackageOrders` (src/core/billing/package-orders.ts) when looking up or granting one package order fails during the daily pass, and from `dailyBilling` (src/index.ts) when the whole step throws. Fields: `orderId`, `error` (error class name).
## Impact
A merchant who paid for a package (or a switch) may not have it granted yet. Money was taken, so this is a paid-but-not-served risk. Grants are idempotent, so a retry never grants twice.
## Check first
1. Search logs for `{"alert":"package_repair_failed"` and note `orderId` and `error`.
2. Read the `package_orders` row in D1 for that `order_id`: `status`, `granted_at`, `provider_ref`.
3. Check whether `package_paid_not_granted` fired for the same order.
4. Read docs/billing.md (package orders and daily repair).
## Fix
1. The daily pass (cron `17 1 * * *`) retries: it re-asks Kashier about pending or expired orders and grants any `paid` order with no `granted_at`. A transient failure heals itself.
2. If the same `orderId` fails on several days, grant through the documented operator route `PUT /api/v1/operator/workspaces/:workspaceId/subscription`, and confirm the amount with the payment provider first.
3. Anything beyond that: Not documented in code: ask the engineer on call.
## Verify it is resolved
`package_orders.granted_at` is set for the order, the workspace subscription shows the package, and the alert stops on the next daily pass.
## Related
docs/billing.md; alerts: package_paid_not_granted, package_amount_mismatch, instapay_repair_failed
