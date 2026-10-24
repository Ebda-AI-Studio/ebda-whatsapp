# Backup and restore (Ebda WhatsApp)

## What runs
- Every workspace Durable Object arms a daily alarm for **02:00 Africa/Cairo** on its first ingest. The alarm writes
  `backups/<workspaceId>/<YYYY-MM-DD>/{contacts,conversations,messages,message_status_events}.ndjson` and `manifest.json`
  (row count + sha256 per table, schema version) to R2 bucket **`ebda-wa-backups`**, then re-arms for the next 02:00.
- All tables are read in one transaction, so a snapshot is consistent even while messages arrive.
- Large message bodies live in `ebda-wa-media` (`bodies/<workspaceId>/<wamid>`) and are NOT copied into the backup (Phase 3: add an R2→R2 copy or lifecycle-protected versioning).

## Mac copy
`scripts/backup-pull.sh [date]` mirrors one night's backups plus a D1 export to `~/Backups/ebda-whatsapp/<date>/`,
asserts every file's line count against the manifest, and keeps 30 days.
Install the daily 04:00 job only when Ahmad approves (it is not installed):
`cp ops/com.ebda.wa-backup-pull.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.ebda.wa-backup-pull.plist`

## Restore a workspace
1. Pick the snapshot prefix, e.g. `backups/ws-123/2026-10-24/`.
2. Restore into a FRESH workspace id (the target must be empty): call `WorkspaceDO.importSnapshot(prefix)` on
   `idFromName('<new id>')` (operator route lands in Phase 3; until then a one-off `wrangler` script).
3. It verifies every table's sha256 and row count BEFORE writing; on mismatch it returns `{ ok: false, reason }` and writes nothing.
4. Point the phone number's D1 row (`phone_numbers.workspace_id`) at the restored id.

## Drill
`test/backup.test.ts` runs export → import → equal counts and hashes, the tamper case and the non-empty-target case on every test run.
A live drill on the real account is part of the launch checklist.

## Erasure vs backups
`DELETE /api/v1/stores/:storeId/contacts/:waId` (owner or super admin) erases the contact from the live workspace and its R2 bodies.
Nightly backups taken before the request still hold the contact until they age out (R2 lifecycle on `ebda-wa-backups`: 30 days, to be set when the bucket is created; Mac copies: 30 days via `backup-pull.sh`). The privacy policy must state this 30-day backup window. A restore must re-apply erasures logged after the snapshot date (audit lines `contact_erased`).
