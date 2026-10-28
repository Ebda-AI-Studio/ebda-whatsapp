# package_partial_refund (P1)
**Severity:** P1 look today
## What it means
A refund smaller than the order amount was applied (src/core/billing/package-orders.ts). Fields: `workspace`, `orderId`, `amountMinor` (this refund), `eventKey`.
## Impact
The running period the order owns was shortened by the refunded fraction (monthly or yearly rule), the subscription version went up, and the same fraction of unused credits expired. A partial refund of a period that has not started only changes `refunded_minor`. Money moved at the provider.
## Check first
1. Search logs for `{"alert":"package_partial_refund"` and note `orderId`.
2. Confirm the refund was expected at the provider.
3. Read D1 `package_orders` (`refunded_minor`) and `package_refunds` (`applied`, `shortened`) for that order, and `workspace_subscriptions.period_end`.
4. Read docs/billing.md, "Packages: three writers, one place", the Partial paragraph.
## Fix
1. Normally none: this is a notice and the system already shortened the period.
2. If the new end date looks wrong, Not documented in code: ask the engineer on call. For a yearly order a human refund uses GET .../package-orders/:orderId/refund-quote then POST .../package-orders/:orderId/yearly-refund under /api/v1/operator.
## Verify it is resolved
`period_end` matches the documented formula and the merchant sees the new end date.
## Related
docs/billing.md ("Yearly packages", "Packages: three writers, one place"), alert: package_refunded
