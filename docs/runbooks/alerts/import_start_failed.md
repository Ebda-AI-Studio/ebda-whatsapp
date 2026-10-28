# import_start_failed (P1)
**Severity:** P1 look today
## What it means
`POST /imports` in `src/routes/imports.ts` took the workspace's import slot but could not store the CSV in R2 or could not start `ImportWorkflow`. Fields: `workspace`, `error` (error name). The import is marked failed with reason `could_not_start` and the caller gets 503.
## Impact
One contact import did not start. The merchant sees the failure and can upload again. No contacts were added, no money or consent effect.
## Check first
1. Search the logs for `{"alert":"import_start_failed"...}`; note `workspace` and `error`.
2. Check Cloudflare status for R2 (bucket `ebda-wa-media`, key prefix `imports/`) and Workflows (binding `IMPORT_WORKFLOW`).
3. Read docs/campaigns.md (the `POST /imports` bullet).
## Fix
1. Fix the cause (R2 or Workflows outage, or a missing binding after a deploy).
2. The system does not retry. The merchant uploads the file again; the failed import released the single import slot.
## Verify it is resolved
A new upload returns 202 with `status: pending`, and no new `import_start_failed` line appears.
## Related
import_workflow_failed, docs/campaigns.md
