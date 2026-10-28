# duplicate_success (P0)
**Severity:** P0 wake someone now
## What it means
A second successful payment with a different transaction id arrived for an order that is already paid. Fires in `applyPackageWebhook` (`src/core/billing/package-orders.ts`, `kind: 'package'`) and in `applyTopupWebhook` (`src/core/billing/topups.ts`, `kind: 'topup'`). Fields: `kind`, `workspace`, `orderId` (packages), `eventKey`. Nothing is granted or credited for the second payment.
## Impact
The merchant may have been charged twice by Kashier for one order. Our books are correct (one effect), but the extra payment needs a refund.
## Check first
1. Search logs for `{"alert":"duplicate_success"...}`; note `kind`, `workspace`, `eventKey`.
2. For packages, a `package_duplicate_payment` row is recorded in `billing_audit`; read the order in `package_orders`.
3. Confirm in the Kashier dashboard that two payments exist for the order.
4. Read docs/billing.md, "Top-ups", the sentence on `duplicate_success`.
## Fix
1. No system repair exists: the second payment is not reversed automatically.
2. Refund the extra payment in the Kashier dashboard, using the finance process. The code has no operator route for this: Not documented in code, ask the engineer on call.
3. Do not edit ledger rows.
## Verify it is resolved
Kashier shows the extra payment refunded, and the wallet or subscription still shows exactly one credit or grant.
## Related
docs/billing.md; docs/runbooks/alerts.md; package_amount_mismatch
