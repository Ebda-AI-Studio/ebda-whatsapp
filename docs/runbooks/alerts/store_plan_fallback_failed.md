# store_plan_fallback_failed (P1)
**Severity:** P1 look today
## What it means
When a bought or operator package ended, handing the workspace back to the Store-included plan (`fallbackToStorePlan` in `src/core/billing/subscriptions.ts`) threw. It fires from the daily `reconcileEntitlements` and from `finishRefund` in `src/core/billing/package-orders.ts`. Fields: `workspace`, `error`.
## Impact
A merchant whose package ended (or was refunded) may stay on the lapsed package instead of the included WhatsApp plan, so they may be wrongly limited. No money moves.
## Check first
1. Search the logs for `{"alert":"store_plan_fallback_failed"...}`; note `workspace` and `error`.
2. D1 `store_plan_applied` for the workspace (`includes_whatsapp`, `status`, `period_end`): fallback only runs when `includes_whatsapp = 1`.
3. D1 `workspace_subscriptions` for the workspace: `package_id`, `period_end`, `queued_periods`, `source`.
## Fix
1. The system repairs itself: the daily `reconcileEntitlements` selects every lapsed package with no queued period and tries the fallback again.
2. If it keeps failing, fix the cause shown in `error` (usually D1). Not documented in code: any manual repair beyond that: ask the engineer on call.
## Verify it is resolved
`workspace_subscriptions.package_id` is the Store-included package for that workspace, and the alert stops after the next daily pass.
## Related
queued_period_roll_failed, store_plan_incomplete, entitlement_push_failed, docs/billing.md#packages-and-entitlements-71
