# store_event_failed (P1)
**Severity:** P1 look today
## What it means
Fires from the Store event consumer (src/core/store-events.ts) when handling one queued Store event throws (for example the D1 write for `store.plan_changed` or the workspace call). The message is retried with backoff (5 s doubling, capped at 300 s). Fields: `type`, `storeId`, `attempts`, `error` (error class).
## Impact
A Store event (plan change, order, link, opt-out) is not applied yet. A plan change not applied means the merchant's package is not updated. After the queue's retries are used up the message goes to the dead-letter queue.
## Check first
1. Search logs for `{"alert":"store_event_failed"` and note `type`, `storeId`, `attempts`.
2. Check for `{"warn":"store_event_unknown_workspace"` for the same store: an unregistered workspace is retried, not alerted.
3. Read docs/store-link.md (queue consumer `ebda-wa-events`, DLQ `ebda-wa-events-dlq`).
4. Read the workspace row in D1 (`workspaces`) and, for plan events, `workspace_subscriptions`.
## Fix
1. Retries are automatic; a transient D1 or Durable Object error clears itself. Events are applied idempotently.
2. If `attempts` keeps growing, fix the cause named by `error`, then the next retry succeeds. Replaying from the dead-letter queue: Not documented in code: ask the engineer on call.
## Verify it is resolved
The alert stops for that `storeId`, and the audit log line `{"audit":"store_event"` appears for the event with a status.
## Related
docs/store-link.md; docs/billing.md (Store plan); alert: store_plan_incomplete
