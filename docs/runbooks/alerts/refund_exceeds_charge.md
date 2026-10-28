# refund_exceeds_charge (P1)
**Severity:** P1 look today
## What it means
A provider refund or chargeback pushed an order's refunded total past what was charged. Fires from src/core/billing/refund-excess.ts with `workspace`, `orderId`, `kind`, `overMinor`; `unclamped: true` means a row has `refunded_minor` above `amount_minor` anyway, `reconcileFailed: true` means the nightly check itself threw. Nothing was rejected: the wallet was debited or the package revoked from the event.
## Impact
Possibly money returned twice, or a chargeback after a partial refund. The part beyond the charge is in `over_charge_minor` and in `billing_audit` (`refund_exceeds_charge`, `ref` = the provider's transaction id).
## Check first
1. Find the order in the Kashier dashboard: was money returned twice?
2. `SELECT ref FROM billing_audit WHERE action = 'refund_exceeds_charge' ORDER BY id DESC LIMIT 5` (read only).
## Fix
1. Reconcile with the provider and with the merchant; if the provider returned too much, that is a provider dispute, not a code fix.
2. `unclamped: true`: a writer does not clamp; find it (test/refund-writers.test.ts should have caught it) and tell the engineer on call.
3. `reconcileFailed`: check D1 and wait for the next daily pass.
## Verify it is resolved
The provider and our `over_charge_minor` agree, and the nightly check raises nothing.
## Related
docs/billing.md; alerts: card_refund_over_refundable
