# inquiry_multiple_success (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/payments.ts (Kashier `inquire`) during the daily repair when Kashier reports more than one successful payment for one of our order ids. Fields: `orderId`, `count`. The code does not guess between them.
## Impact
Nothing is credited or granted for that order by the repair, and it is asked again the next day (so the alert may repeat daily). The merchant may have paid more than once, so money may be wrong: possibly a double payment that needs a refund.
## Check first
1. Search logs for `{"alert":"inquiry_multiple_success"...}` and note `orderId`.
2. Read D1 `topups` or `package_orders` for that `order_id` (state and `transaction_id`).
3. Check the successful payments in the Kashier dashboard. Read docs/billing.md, section "Top-ups (7.4)", the Inquiry paragraph.
## Fix
1. The repair never resolves this alone. A live webhook for one of the transactions can still credit or grant it (the first transaction wins; a second different success raises `duplicate_success`).
2. Refund the extra payment through the documented refund flow: docs/billing.md section "Card refunds and the refund webhook". Never edit ledger rows.
3. Any other step: Not documented in code: ask the engineer on call.
## Verify it is resolved
The order is `paid` or granted exactly once and the alert stops repeating.
## Related
docs/billing.md#top-ups-74-topups_enabledtrue; duplicate_success; topup_amount_mismatch; package_amount_mismatch
