# credit_pack_webhook_failed (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/topups.ts (handleProviderWebhook) when applying a Kashier webhook to an AI credit order threw an unexpected error. Field: `error` (an error class name). The webhook answers 500 so Kashier retries.
## Impact
A card payment for credits may be paid but not yet credited. The merchant sees no new credits until a retry or the daily repair lands it.
## Check first
1. Search logs for `{"alert":"credit_pack_webhook_failed"` and note the fields.
2. Read D1 `credit_orders` for the order (state, `transaction_id`) and the workspace's `credit_ledger` rows with ref `credit-pack:<transactionId>`.
3. Read docs/billing.md, section "AI credit packs".
## Fix
1. Note `error` from the log line.
2. Kashier redelivers on 5xx and the daily repair asks about pending credit orders, so credit is applied once however often it runs.
3. If the same `error` repeats, ask the engineer on call. Do not credit by hand before checking `credit_orders`.
## Verify it is resolved
The order is `paid`, the credit ledger shows the purchase once, and no further alert follows.
## Related
docs/billing.md ("AI credit packs"); alerts: credit_pack_repair_failed; topup_webhook_failed; package_webhook_failed
