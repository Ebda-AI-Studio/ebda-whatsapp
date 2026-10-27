# switch_order_stale (P1)
**Severity:** P1 look today
## What it means
A package upgrade or queued-switch payment arrived for an order that was expired, quoted in an earlier month, or priced against a period that has moved on (src/core/billing/package-orders.ts). The payment is recorded as `paid` but deliberately not granted. Fields: `workspace`, `orderId`, `kind`. Raised once per order.
## Impact
Money was taken and the merchant did not get the plan. They are owed a refund (or a re-buy). Money may be unreconciled until a person acts.
## Check first
1. Search logs for `{"alert":"switch_order_stale"` and note `orderId`.
2. Read D1 `package_orders` for the order: `status = paid`, `granted_at` empty, `provider_ref` set.
3. Read docs/billing.md ("Yearly packages", the stale-order rule) and Ruling WA-YEARLY-SWITCH-3 in docs/launch/README.md.
## Fix
1. Refund the payment. For a yearly order GET /api/v1/operator/package-orders/:orderId/refund-quote then POST /api/v1/operator/package-orders/:orderId/yearly-refund with a reason; for other cases use the documented refund-request routes under /api/v1/operator.
2. Tell the merchant; they may re-buy at the current price.
3. The system never grants it by itself and does not repeat the alert daily.
## Verify it is resolved
The order shows refunded (`refunded_minor` equals the amount) and the merchant has the right plan.
## Related
docs/billing.md, docs/launch/README.md (WA-YEARLY-SWITCH-3), alerts: package_paid_not_granted, upgrade_stranded_by_owner_refund
