# r2_deletes_still_owed (P1)
**Severity:** P1 look today
## What it means
The workspace task `r2_drain` (`src/core/workspace-do.ts`) tried to delete R2 objects owed to a workspace (message bodies, media, import files) and R2 refused some. Fields: `workspace`, `keys` (how many objects are still owed). It retries every hour.
## Impact
Objects that should be gone (for example after a contact erasure request) still exist in R2. This is a privacy and retention concern, not a money one. Merchants see nothing.
## Check first
1. Search the logs for `{"alert":"r2_deletes_still_owed"...}`; note `workspace` and whether `keys` is falling over time.
2. Check Cloudflare status and the R2 buckets `ebda-wa-media` (see wrangler.jsonc).
3. Read docs/runbooks/backup-restore.md#erasure-vs-backups.
## Fix
1. The system repairs itself: the task retries every hour until R2 confirms every delete, then it goes back to its normal schedule.
2. If `keys` does not fall after R2 is healthy: Not documented in code: ask the engineer on call.
## Verify it is resolved
The alert stops and the next `r2_drain` run does not log it again.
## Related
docs/runbooks/backup-restore.md#erasure-vs-backups, scheduled_task_invalid
