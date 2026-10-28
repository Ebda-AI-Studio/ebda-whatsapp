# store_plan_incomplete (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/store-plan.ts (not on every branch yet) when a Store event `store.plan_changed` has `includesWhatsApp = true` but lacks `status` or `periodEnd`. Nothing is granted.
## Impact
The merchant's WhatsApp package stays as it was (possibly none, so service may stay blocked) until a complete event arrives. The event is not lost: it is simply ignored. No money moves.
## Check first
1. Search logs for `{"alert":"store_plan_incomplete"` and note the workspace.
2. Check the Store's event producer: it must send both `status` and `periodEnd` on every grant.
3. Read docs/billing.md, "Packages: three writers, one place", item 1 (Store plan).
## Fix
1. Fix the Store side so each plan event carries both fields (ask the Store engineer).
2. A new complete `store.plan_changed` event fixes the workspace; no replay or data repair is needed here.
3. If the merchant is blocked meanwhile, an operator can set the package with PUT /api/v1/operator/workspaces/:workspaceId/subscription (it refuses `store-included`).
## Verify it is resolved
The next complete event is applied, the alert stops, and D1 `workspace_subscriptions` shows the expected package and `period_end`.
## Related
docs/billing.md ("Packages: three writers, one place"), alert: entitlement_push_failed
