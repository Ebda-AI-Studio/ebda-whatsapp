# topup_unknown_order (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/topups.ts (handleProviderWebhook) when a correctly signed Kashier webhook names an order id that is neither a top-up nor a package order of ours. The alert has no fields. The webhook is answered 200 and ignored.
## Impact
Nothing is credited or granted. Usually harmless (a test event, another system sharing the Kashier merchant account). If a merchant says they paid and got nothing, the order row may be missing and money may be wrong.
## Check first
1. Search logs for `{"alert":"topup_unknown_order"...}` and note the time.
2. Ask whether a real merchant payment happened at that time; if so find the order in D1 `topups` and `package_orders` by the merchant's workspace.
3. Read docs/billing.md, section "Top-ups (7.4)".
## Fix
1. If no merchant paid, nothing to do.
2. If a merchant did pay, Not documented in code: ask the engineer on call. Do not credit the wallet by hand.
## Verify it is resolved
No real payment is left without a matching order row, and the alert is not repeating.
## Related
docs/billing.md#top-ups-74-topups_enabledtrue; topup_webhook_failed; package_webhook_failed
