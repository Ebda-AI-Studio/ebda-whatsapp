# credit_pack_repair_failed (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/credit-packs.ts (repairCreditOrders) during the daily pass when asking the provider about a pending credit order threw. Field: `error` (an error class name).
## Impact
A merchant may have paid for credits whose webhook never arrived and whose repair also failed, so the credits are not added yet.
## Check first
1. Search logs for `{"alert":"credit_pack_repair_failed"` and note the fields.
2. Read D1 `credit_orders` for the order (state, `transaction_id`) and the workspace's `credit_ledger` rows with ref `credit-pack:<transactionId>`.
3. Read docs/billing.md, section "AI credit packs".
## Fix
1. Read `credit_orders` rows still `pending` older than 15 minutes.
2. The daily pass asks again the next day and credits once (ref `credit-pack:<transactionId>`), so waiting is safe.
3. If it keeps failing with the same `error`, ask the engineer on call. Do not add credits by hand before checking the order.
## Verify it is resolved
The order is `paid` and the ledger shows the purchase once.
## Related
docs/billing.md ("AI credit packs"); alerts: credit_pack_webhook_failed; topup_repair_failed
