# cod_outcome_push_failed (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/workspace-do.ts (tryPushCod) when the immediate attempt to tell the Store the merchant's cash-on-delivery answer (confirmed or refused) failed. Fields: `workspace`, `error` (an error class name).
## Impact
The Store does not yet know the COD outcome for one order, so it may show it as unanswered. The merchant's answer is saved on our side. No money moves here.
## Check first
1. Search logs for `{"alert":"cod_outcome_push_failed"...}` and note `error`.
2. Check whether the Store link is reachable and credentials are valid: read docs/store-link.md.
3. Look in the workspace Durable Object table `scheduled_tasks` for kind `cod_outcome_push` still pending.
## Fix
1. The system retries by itself: a scheduled task `cod_outcome_push` keeps trying until the push succeeds, then removes itself.
2. If the Store link is down or misconfigured, fix that. Not documented in code: ask the engineer on call for the exact step.
## Verify it is resolved
The `cod_outcome_push` task is gone from `scheduled_tasks` and the Store shows the order outcome. The alert stops.
## Related
docs/store-link.md; docs/store-feature-map.md
