# package_webhook_failed (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/topups.ts (handleProviderWebhook) when applying a Kashier webhook to a package order threw an unexpected error (other than refund contention). Field: `error` (an error class name). The webhook answers 500 so Kashier retries.
## Impact
A package payment may be taken but the package not yet granted. The merchant may still be without their plan. Money may be wrong until it is granted.
## Check first
1. Search logs for `{"alert":"package_webhook_failed"...}` and note `error`.
2. Read D1 `package_orders` for recent rows still `pending` and `unconfirmed_webhooks` for open rows.
3. Read docs/billing.md, section "Packages: three writers, one place".
## Fix
1. Retries fix it by themselves: Kashier redelivers on 5xx, and the daily repair (`repairPackageOrders`) asks Kashier about pending orders 15 minutes to 7 days old. A grant is applied once.
2. If it repeats, watch for `package_paid_not_granted` (P0). Not documented in code: ask the engineer on call for the root cause.
## Verify it is resolved
The `package_orders` row is `paid` with `granted_at` set, the workspace subscription shows the package, and no further alert follows.
## Related
docs/billing.md#packages-three-writers-one-place-package_checkout_enabled-for-purchase; package_paid_not_granted; topup_webhook_failed
