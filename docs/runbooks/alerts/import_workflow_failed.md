# import_workflow_failed (P1)
**Severity:** P1 look today
## What it means
`ImportWorkflow` in `src/core/campaigns/workflows.ts` threw while processing an uploaded contact file, after its step retries (5, exponential) were used up. Fields: `workspace`, `error` (error class). The import is marked failed with reason `internal_error`.
## Impact
One contact import failed, possibly partway: chunks already applied stay applied (each chunk is applied once). The merchant sees the import as failed. No money impact. The uploaded file is deleted when the import ends.
## Check first
1. Search the logs for `{"alert":"import_workflow_failed"...}`; note `workspace` and `error`.
2. Cloudflare dashboard, Workflows: the `ImportWorkflow` instance whose id is the import id.
3. Workspace DO table `imports` for that workspace (status, reason). Rejected rows: `GET /imports/:id/rejects` (docs/campaigns.md).
## Fix
1. Fix the cause shown in `error`. If it is a code bug, give the engineer on call the workspace and time.
2. The merchant can upload the file again; an import never clears an opt-out or overwrites consent already on record (docs/campaigns.md).
## Verify it is resolved
A new import of the same file reaches status done, and no new `import_workflow_failed` line appears.
## Related
import_start_failed, docs/campaigns.md
