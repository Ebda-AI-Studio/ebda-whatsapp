# scheduled_task_invalid (P1)
**Severity:** P1 look today
## What it means
A scheduled task in a workspace Durable Object had a payload that can never be parsed, so it was dropped instead of retried forever. Fields: `kind` (`send_release`, `bot_turn` in `src/core/workspace-do.ts`, or `opt_out_push` in `src/core/store-link/consent.ts`) and `workspace`.
## Impact
`send_release`: one held message was not released to the send queue. `bot_turn`: one bot reply was skipped (the customer can write again). `opt_out_push`: one opt-out change was not sent to the Store, so the Store may still think that buyer can be messaged (consent), until a later change is sent.
## Check first
1. Search the logs for `{"alert":"scheduled_task_invalid"...}`; note `kind` and `workspace`.
2. Workspace DO table `scheduled_tasks` (columns `kind`, `payload`, `attempts`, `last_error`) for that workspace.
3. Look for a recent deploy that changed the payload shape of that kind (`src/core/scheduler.ts`).
## Fix
1. This is a code or data bug, not a transient fault: the task is not retried. Give the engineer on call the `kind`, `workspace` and time.
2. For `opt_out_push`, ask the engineer on call to confirm the buyer's opt-out reached the Store.
## Verify it is resolved
No new `scheduled_task_invalid` lines for that `kind` after the fix is deployed, and the affected message or opt-out state is correct.
## Related
docs/store-link.md#consent-wa-consent-1, docs/store-link.md#scheduler-kinds-added, r2_deletes_still_owed
