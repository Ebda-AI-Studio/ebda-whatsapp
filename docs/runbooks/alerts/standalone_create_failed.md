# standalone_create_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `POST /workspaces` (src/routes/workspaces.ts) when the single D1 batch that creates a standalone workspace threw. The person got a 503 `creation_unavailable`; nothing was created (the batch is atomic) and an invite code, if one was used, was not consumed.
## Impact
A client with an invite cannot create their workspace until D1 is healthy. No data is lost and no code is burnt.
## Check first
1. Check D1 health (Cloudflare dashboard, D1 `ebda-wa-platform`) around the alert time.
2. Look for the `standalone_create_failed` log line: its `reason` names the D1 error.
3. If D1 is healthy, check that migration `0042_standalone_workspaces.sql` is applied in production.
## Fix
1. Once D1 is healthy ask the client to retry; the same code still works.
2. If the migration is missing, apply it, then retry.
## Verify it is resolved
A retry creates the workspace and the operator workspace list shows it.
## Related
docs/runbooks/standalone-workspaces.md, alert: audit_write_failed
