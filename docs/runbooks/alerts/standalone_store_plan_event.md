# standalone_store_plan_event (P1)
**Severity:** P1 look today
## What it means
Fires from `applyStorePlan` (src/core/billing/store-plan.ts) when a `store.plan_changed` event named a standalone workspace id. It was ignored (Ruling CHAT-SA-6: a Store plan can never write to a standalone workspace).
## Impact
None: nothing was granted or cancelled. A Store event for an `sw_` id means the Store sent an id it should not know.
## Check first
1. Find the log line and the workspace id.
2. Check that the Store did not link a store to an `sw_` workspace: standalone ids are minted only by Chat.
3. Check the event queue consumer refuses non-UUID ids too (`store_event_non_store_id` log).
## Fix
1. Fix the sender: Store events carry Store UUIDs only.
2. No data repair is needed here.
## Verify it is resolved
The alert stops; `store_plan_applied` has no row for the workspace.
## Related
docs/billing.md (Standalone workspaces), alert: standalone_subscription_refused
