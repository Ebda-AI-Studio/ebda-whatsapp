# pricing_copy_missing (P1)
**Severity:** P1 look today
## What it means
`billClaim` in `src/core/workspace-do.ts` tried to bill a send but the workspace has never pulled its price inputs (D1 was unreachable at every attempt). Field: `workspace`. The send is given back to the queue and released again after 60 seconds (`pricing_unavailable`).
## Impact
Sends from that workspace are delayed, not lost and not billed wrongly: no wallet decision is made on an empty price copy. Merchants see messages stay queued.
## Check first
1. Search the logs for `{"alert":"pricing_copy_missing"...}` and, just before it, `pricing_pull_failed` for the same `workspace` (it gives the cause).
2. Check D1 availability for the Worker.
3. `GET /api/v1/operator/workspaces/:workspaceId/ops` shows the workspace state.
## Fix
1. Resolve the D1 problem shown by pricing_pull_failed.
2. The system repairs itself: once a pull succeeds the held sends are released on their 60 second retry.
## Verify it is resolved
The alert stops, the workspace's queued messages move to sent, and no new `pricing_pull_failed` appears.
## Related
pricing_pull_failed, docs/billing.md#who-pays-meta-wa-fund-1, docs/billing.md#alerts-structured-logs
