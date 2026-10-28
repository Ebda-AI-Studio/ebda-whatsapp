# audit_write_failed (P1)
**Severity:** P1 look today
## What it means
An action went through but its `audit_log` row was not written. Fires from `recordAudit` (src/core/audit.ts) with `workspace` (when known) and `action`. The Worker log still has the line `{"audit":"action"}` for it.
## Impact
A gap in the who-did-what trail. The action itself succeeded; this is a records problem, not a merchant-facing outage.
## Check first
1. Check D1 health (Cloudflare dashboard, D1 `ebda-wa-platform`) and any D1 incident around the alert time.
2. Find the matching `{"audit":"action"}` log line for the action and workspace.
## Fix
1. Once D1 is healthy, note the gap in the incident log with the log line as evidence (the immutable table cannot be back-filled by hand).
2. If it repeats with D1 healthy, a writer is sending a value the table rejects: Not documented in code: ask the engineer on call.
## Verify it is resolved
A fresh action by the same actor writes its `audit_log` row (`GET /api/v1/operator/audit-log` lists it) and the alert stops.
## Related
docs/erasure-and-audit.md; alerts: erasure_record_failed
