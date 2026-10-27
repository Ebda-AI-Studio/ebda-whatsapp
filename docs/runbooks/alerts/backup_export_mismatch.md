# backup_export_mismatch (P1)
**Severity:** P1 look today
## What it means
The nightly snapshot of one workspace (`exportTable` in `src/core/backup-export.ts`) read a table in chunks and, at the end, the number of rows it wrote did not equal `count(*)` of the table under the same condition. Fields: `table`, `exported`, `counted` (counts only). The export threw, wrote neither that table's file nor `manifest.json`, so there is no half-snapshot that could pass for a complete one.
## Impact
That workspace has no new snapshot for the date until a run succeeds. The previous snapshots are untouched. No customer-facing effect.
## Check first
1. Search logs for `{"alert":"backup_export_mismatch"...}`; note the `table` and the two counts.
2. A difference of a few rows on a busy table means rows were deleted or added while the table was being read (an erasure, a purge, a WITHOUT ROWID table that has no high-water mark). The backup task retries with backoff (30 s up to 1 h, `backup_failed` is logged on each failure), so a one-off clears itself.
3. A large or repeating difference is a bug in the export. Do not edit data.
## Fix
1. Wait for the next retry; check that the log shows the same workspace's export succeeding (`manifest.json` present under `backups/<workspace>/<date>/` in `ebda-wa-backups`).
2. If it repeats for the same table: Not documented in code: ask the engineer on call (read `docs/runbooks/backup-restore.md`, "Consistency model").
## Verify it is resolved
`manifest.json` for the date exists and `scripts/verify-backup-manifest-cli.mjs <folder>` prints `VERIFIED`; the alert stops.
## Related
docs/runbooks/backup-restore.md; docs/runbooks/d1-time-travel.md
