# entitlement_push_failed (P1)
**Severity:** P1 look today
## What it means
Pushing a plan change to a workspace Durable Object failed. Fires in `announceSubscription` and in `reconcileEntitlements` (`src/core/billing/subscriptions.ts`). Fields: `workspace`, `error` (error class only). The D1 write already committed.
## Impact
The workspace may run on its old entitlement copy (it could deny a feature the merchant paid for, or allow one after it lapsed) until the push succeeds. No money is wrong.
## Check first
1. Search logs for `{"alert":"entitlement_push_failed"...}`; note `workspace`.
2. D1 (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT * FROM workspace_subscriptions WHERE workspace_id = '<id>'"`.
3. Read docs/billing.md, "Packages: three writers" (a failed push is healed by the daily reconcile).
## Fix
1. The system repairs itself: the daily reconcile re-sends every subscription and the workspace ignores versions it already has.
2. If the alert keeps firing for the same workspace on consecutive days, the Durable Object is failing: Not documented in code: ask the engineer on call.
## Verify it is resolved
The next daily pass raises no alert for the workspace, and the workspace's feature gates match `workspace_subscriptions`.
## Related
docs/billing.md; entitlement_reconcile_failed; entitlement_event_not_queued
