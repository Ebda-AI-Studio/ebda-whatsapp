# package_amount_mismatch (P0)
**Severity:** P0 wake someone now
## What it means
A confirmed SUCCESS payment for a package order has a currency or amount that differs from the stored `package_orders` row (`applyPackageWebhook` in `src/core/billing/package-orders.ts`). The alert is raised once per order (guarded by `auditOnce`). Field: `workspace`. No package is granted.
## Impact
The merchant paid but has no plan. Money was taken for a different amount than the order. Money may be wrong.
## Check first
1. Search logs for `{"alert":"package_amount_mismatch"...}`; note `workspace`.
2. D1 (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT order_id, amount_minor, currency, status FROM package_orders WHERE workspace_id = '<id>' ORDER BY created_at DESC LIMIT 5"` and compare with the Kashier dashboard.
3. The `billing_audit` table holds the once-per-order record.
4. Read docs/billing.md, "Packages: three writers", item 3.
## Fix
1. The system does not retry: the repair re-asks Kashier but a wrong amount changes nothing.
2. Decide with the engineer whether to refund the payment or to assign the plan by hand: `PUT /api/v1/operator/workspaces/:workspaceId/subscription`.
3. Why the amount differed (price change, wrong checkout): Not documented in code: ask the engineer on call.
## Verify it is resolved
The merchant has the package, or the payment is refunded; no new alert for the same order.
## Related
docs/billing.md; topup_amount_mismatch; package_paid_not_granted
