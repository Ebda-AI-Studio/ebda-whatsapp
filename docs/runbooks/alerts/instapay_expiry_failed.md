# instapay_expiry_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `dailyBilling` (src/index.ts) when `expireInstapay` (src/core/billing/instapay.ts) throws. That step expires InstaPay requests in `awaiting_proof` after 48 hours and closes their pending order or top-up. Field: `error` (error class name).
## Impact
Stale unpaid InstaPay requests stay open (they count toward the cap of 5 open requests per workspace). No money moves in this step and no confirmed payment is affected.
## Check first
1. Search logs for `{"alert":"instapay_expiry_failed"` and note `error`.
2. Read `instapay_requests` in D1 for rows with `state = 'awaiting_proof'` and `expires_at` in the past.
3. Check D1 status for the control-plane database.
## Fix
1. The step runs again on the next daily pass (cron `17 1 * * *`) and is safe to repeat. This is self-healing unless the error persists.
2. If it persists: Not documented in code: ask the engineer on call.
## Verify it is resolved
Overdue `awaiting_proof` rows are `expired`, their `package_orders` or `topups` row is `expired`, and the alert stops.
## Related
docs/billing.md (InstaPay); alerts: instapay_overdue_check_failed, instapay_repair_failed
