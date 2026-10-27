# entitlement_event_not_queued (P1)
**Severity:** P1 look today
## What it means
The subscription change committed but the `whatsapp.entitlement_changed` event for the Store could not be queued. Fires in `announceSubscription` and in `rollRenewals` (`src/core/billing/subscriptions.ts`). Fields: `workspace`, `error` (error class only).
## Impact
The Store may show an old plan state for this merchant. The workspace and the money are correct, because the write is never undone.
## Check first
1. Search logs for `{"alert":"entitlement_event_not_queued"...}`; note `workspace`.
2. D1 (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT package_id, status, period_end, version FROM workspace_subscriptions WHERE workspace_id = '<id>'"`.
3. Read docs/billing.md, "Packages: three writers" and docs/store-link.md.
## Fix
1. The code does not retry the event by itself: the daily reconcile re-sends to the workspace, not to the Store.
2. The event id is derived from workspace and version, so announcing again is harmless. How to re-queue it safely: Not documented in code: ask the engineer on call.
## Verify it is resolved
The Store shows the same package and period as `workspace_subscriptions`.
## Related
docs/billing.md; docs/store-link.md; entitlement_push_failed
