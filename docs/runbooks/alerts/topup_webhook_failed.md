# topup_webhook_failed (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/topups.ts (handleProviderWebhook) when applying a Kashier webhook to a top-up threw an unexpected error. Field: `error` (an error class name). The webhook answers 500 so Kashier retries.
## Impact
A card top-up may be paid but not yet credited to the wallet. The merchant sees no new balance. Money may be wrong until it lands. A retry or the daily repair usually fixes it.
## Check first
1. Search logs for `{"alert":"topup_webhook_failed"...}` and note `error`.
2. Read D1 `topups` for recent rows still `pending` that the merchant says they paid, and `unconfirmed_webhooks` for open rows.
3. Read docs/billing.md, section "Top-ups (7.4)".
## Fix
1. Retries fix it by themselves: Kashier redelivers on 5xx, and the daily repair (`repairTopups`) asks Kashier about pending top-ups older than 15 minutes. Credit is applied once (ref `kashier:<transactionId>`), so retrying is safe.
2. If it fails again with the same `error`, Not documented in code: ask the engineer on call. Do not credit the wallet by hand before checking the `topups` row.
## Verify it is resolved
The `topups` row is `paid`, the wallet shows the credit, and no further alert follows.
## Related
docs/billing.md#top-ups-74-topups_enabledtrue; package_webhook_failed; topup_unknown_order; topup_amount_mismatch
