# queued_period_roll_failed (P1)
**Severity:** P1 look today
## What it means
Rolling a paid, queued package period into the running one failed (`rollRenewals` in `src/core/billing/subscriptions.ts`), either in the workspace `subscription_expire` task (`src/core/workspace-do.ts`) or in the daily `reconcileEntitlements`. Fields: `workspace`, `error`.
## Impact
A merchant who paid for an early renewal may not see the new period start on time. The plan is never expired while a paid renewal is waiting: the task retries in 60 seconds, so the merchant keeps service. Money is not lost; the order stays paid.
## Check first
1. Search the logs for `{"alert":"queued_period_roll_failed"...}`; note `workspace` and `error`.
2. D1 `workspace_subscriptions` for that workspace: `queued_periods`, `period_end`, `status`.
3. D1 `package_orders` for the workspace: orders with a queue position are the paid queued ones.
4. Read docs/billing.md#packages-and-entitlements-71.
## Fix
1. If the error is a D1 outage, wait: the workspace task retries every 60 seconds and the daily pass retries too.
2. Not documented in code: what to do if the roll keeps failing with the same non-D1 error: ask the engineer on call.
## Verify it is resolved
`workspace_subscriptions.queued_periods` falls and `period_end` moves forward, the merchant's plan shows the new period, and the alert stops.
## Related
docs/billing.md#packages-and-entitlements-71, store_plan_fallback_failed, entitlement_push_failed
