# entitlement_reconcile_failed (P1)
**Severity:** P1 look today
## What it means
The whole `reconcileEntitlements` step of the daily billing pass (`dailyBilling` in `src/index.ts`) threw. Field: `error` (error class only). It is one of several independent steps, so the others still ran.
## Impact
That day's queued-period rolls, fallback to the Store plan and entitlement re-sends did not complete. Workspaces keep their last entitlement copy. No money is wrong.
## Check first
1. Search logs for `{"alert":"entitlement_reconcile_failed"...}`; note `error` and the time (the cron is `17 1 * * *` UTC).
2. Look for per-workspace alerts in the same pass: `queued_period_roll_failed`, `store_plan_fallback_failed`, `entitlement_push_failed`.
3. Check D1 availability with `npx wrangler tail`.
## Fix
1. The system repairs itself: the pass runs again at the next daily cron.
2. If it fails two days in a row, or you need it now: Not documented in code: ask the engineer on call (no operator route runs the daily pass).
## Verify it is resolved
The next daily pass raises no `entitlement_reconcile_failed`.
## Related
docs/billing.md; entitlement_push_failed
