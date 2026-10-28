# upgrade_stranded_by_owner_refund (P1)
**Severity:** P1 look today
## What it means
The order that owns a period was fully refunded, but an upgrade paid on top of it is still paid and not refunded (`flagStrandedUpgrades` in src/core/billing/package-orders.ts). Fields: `workspace`, `orderId` (the upgrade), `ownerOrderId` (the refunded order). Raised once per upgrade.
## Impact
The merchant paid for an upgrade whose base period is gone. Money is held for something they may not be able to use. A person must refund it or keep it.
## Check first
1. Search logs for `{"alert":"upgrade_stranded_by_owner_refund"` and note both order ids.
2. Read D1 `package_orders` for both: the upgrade has `period_owner` = the owner order, `status = paid`, and `amount_minor` above `refunded_minor`.
3. Read docs/billing.md, "Yearly packages" (the stranded-upgrade bullet).
## Fix
1. Decide with the merchant: refund the upgrade (operator refund routes under /api/v1/operator, e.g. GET .../package-orders/:orderId/refund-quote and POST .../yearly-refund for yearly orders) or keep it.
2. The system never refunds it by itself.
## Verify it is resolved
The upgrade order shows refunded, or the decision to keep it is recorded in the on-call notes.
## Related
docs/billing.md, alerts: package_refunded, switch_order_stale, upgrade_refund_not_reverted
