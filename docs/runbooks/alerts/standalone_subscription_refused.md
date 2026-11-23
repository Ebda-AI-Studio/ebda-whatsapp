# standalone_subscription_refused (P1)
**Severity:** P1 look today
## What it means
Fires from `setSubscription` (src/core/billing/subscriptions.ts) when a write tried to give a standalone workspace (`sw_` id) the Store's `store-included` package, a `store_plan` source, or a trial (Ruling CHAT-SA-6). Nothing was written.
## Impact
None for the client: the refused write is exactly what must never happen. It points at a caller that treats a standalone workspace like a Store workspace.
## Check first
1. Find the log line: it carries the workspace, the `source`, the `packageId` and the `status` of the refused write.
2. If `source` is `operator`, an operator tried to set a trial or `store-included`: a paid Chat package is allowed, a trial is not.
3. If `source` is `store_plan` or `purchase`, find the caller (a Store event, a new route) that passed an `sw_` id.
## Fix
1. Fix the caller so it never writes these for an `sw_` id. Do not remove the guard.
2. If a client truly needs a trial period, assign a paid Chat package with an operator subscription instead.
## Verify it is resolved
The alert stops and `workspace_subscriptions` shows no `store-included` row for the workspace.
## Related
docs/billing.md (Standalone workspaces), alert: standalone_store_plan_event
