# package_chargeback (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/package-orders.ts (refundOrder) when a provider chargeback for a package order has been applied in full (cumulative refunds reached the order amount). Fields: `workspace`, `orderId`, `amountMinor`, `eventKey` (the provider event).
## Impact
The order becomes `charged_back`. If it owned the running period the plan is cancelled now (or the next queued period starts) and that period's unused credits are zeroed. The merchant loses the package. Money was already taken back by the card network; the wallet is not debited by this path.
## Check first
1. Search logs for `{"alert":"package_chargeback"...}` and note `workspace` and `orderId`.
2. Read D1 `package_orders` for that `order_id` (expect `status = 'charged_back'`) and `workspace_subscriptions` for the workspace (expect `cancelled` or the next period).
3. Read docs/billing.md, section "Packages: three writers, one place", the "Full" refund bullet.
## Fix
1. This alert is a notice: the system already applied the change. No repair is needed if the rows match step 2 above.
2. Decide with the owner whether to contact the merchant or restore access. Any manual plan change uses `PUT /api/v1/operator/workspaces/:workspaceId/subscription` (super admin, reason required, audited).
3. If the rows do not match, Not documented in code: ask the engineer on call.
## Verify it is resolved
The `package_orders` row is `charged_back` and the subscription row shows the intended state. The alert does not repeat for the same `eventKey` (a replay is a no-op).
## Related
docs/billing.md#packages-three-writers-one-place-package_checkout_enabled-for-purchase; package_refund_contention; refund_refused
