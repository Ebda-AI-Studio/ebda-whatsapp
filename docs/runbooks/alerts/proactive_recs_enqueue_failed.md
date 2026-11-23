# proactive_recs_enqueue_failed (P1)
**Severity:** P1 look today
## What it means
Fires from src/core/store-link/proactive-recs.ts when queueing the post-order product suggestion template threw. The queueing transaction rolled back (no message row, no wallet hold) and the order was marked `store_orders.recs_outcome = 'failed:enqueue'`. Fields: `workspace`, `error`.
## Impact
One customer did not get one optional marketing message. No money moved and nothing is left `queued`. It is never retried for that order.
## Check first
1. Search logs for `{"alert":"proactive_recs_enqueue_failed"` and note `workspace`.
2. Read the order outcome: `SELECT order_id, recs_outcome FROM store_orders WHERE recs_outcome = 'failed:enqueue'` in that workspace.
3. Read docs/rulings/CHAT-RECS-SWITCH-1.md and the template row (`templates`) named in the owner setting.
## Fix
1. A repeat means a systematic fault (a malformed stored template, a schema problem): fix that, then ask the owner to keep the switch off until it is fixed.
2. Do not clear `recs_outcome` by hand to resend: the customer frequency cap and consent were already evaluated.
## Verify it is resolved
The alert stops and new orders end in `sent` or a `skipped:<reason>`.
## Related
docs/rulings/CHAT-RECS-SWITCH-1.md; alerts: send_enqueue_failed
