# erasure_record_failed (P1)
**Severity:** P1 look today
## What it means
A contact was erased but its erasure record was not written. Fires from src/core/erasure.ts with `workspace`. The record is what stops a restore from bringing the person back.
## Impact
Until the record exists, a backup restore could resurrect the erased person's data. A data-protection risk, not an outage.
## Check first
1. Find the workspace in the alert and check D1 health.
2. `SELECT count(*) FROM erasure_records WHERE workspace_id = '<id>'` (read only): is the latest erasure there?
## Fix
1. Re-run the erasure for the same contact (idempotent, it rewrites the record): the owner's contact delete in the app, or `DELETE /api/v1/operator/workspaces/:workspaceId/contacts/:waId` with a reason.
2. Confirm a row now exists in `erasure_records`.
## Verify it is resolved
`erasure_records` has the row for that workspace and the alert does not fire again on the re-run.
## Related
docs/erasure-and-audit.md; alerts: audit_write_failed
