# refund_refused (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/topups.ts and src/core/billing/package-orders.ts when a successful refund webhook carries the SAME transaction id as the payment it supposedly refunds (or the package order has no payment reference). Fields: `kind` (`topup` or `package`), `workspace`, `eventKey`. It is refused as a relabelled payment.
## Impact
No money moves and no plan changes: the refund is ignored. Either the provider event is odd or someone tried to pass a payment off as a refund. The merchant has not been refunded by this event.
## Check first
1. Search logs for `{"alert":"refund_refused"...}` and note `kind`, `workspace`, `eventKey`.
2. Read D1 `topups` or `package_orders` for the workspace (`transaction_id` / `provider_ref`) and compare with the refund in the Kashier dashboard.
3. Read docs/billing.md, section "Top-ups (7.4)" (a refund is accepted only if its transaction id differs from the payment's).
## Fix
1. If the refund is real in Kashier, Not documented in code: ask the engineer on call. Do not edit ledger rows.
2. If it is not real, nothing to do.
## Verify it is resolved
The order row is unchanged and the wallet or plan matches the real money position.
## Related
docs/billing.md#top-ups-74-topups_enabledtrue; docs/billing.md#card-refunds-and-the-refund-webhook-kashier_refunds_enableddefault-off; duplicate_success
