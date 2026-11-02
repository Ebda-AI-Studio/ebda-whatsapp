# Backup and restore (Ebda Chat)

## What runs
- Every workspace Durable Object arms a daily alarm for **02:00 Africa/Cairo** on its first ingest. The alarm writes
  `backups/<workspaceId>/<YYYY-MM-DD>/{contacts,conversations,messages,message_status_events,notes,conversation_tags,templates,uploads}.ndjson` and `manifest.json`
  (row count + sha256 per table, schema version) to R2 bucket **`ebda-wa-backups`**, then schedules the next one for 02:00 (the backup is a task in the DO scheduler: a failed run is retried with backoff from 30 s up to 1 h and logs `{alert:'backup_failed'}` each time).
- All tables are read in one transaction, so a snapshot is consistent even while messages arrive.
- Large message bodies live in `ebda-wa-media` (`bodies/<workspaceId>/<wamid>`) and are NOT in the nightly snapshot; `scripts/backup-offsite.sh` mirrors that prefix off Cloudflare (below).

## Consistency model of the chunked export (T17, Ruling WA-BACKUP-CHUNK-1)
The nightly export no longer reads the whole workspace in one transaction. Each table is read in keyset chunks (`DEFAULT_CHUNK_ROWS`, 500: small enough that a request waits tens of milliseconds, measured by the 500k spike), each chunk its own short read, and streamed to R2 (a plain put while small, a multipart upload past 5 MiB; every part but the last is exactly 5 MiB, R2's rule) and hashed as it goes. The cursor is `rowid` (or the primary key of a WITHOUT ROWID table), never a nullable column. Every rowid table stops at the `max(rowid)` taken at the start, so a message written during the export never refers to a conversation the snapshot lacks. The snapshot is therefore consistent per row, not per workspace instant: a tag or recipient row (WITHOUT ROWID tables have no high-water mark) may be one chunk newer than the contacts. After each table the rows written must equal `count(*)` under the same condition, otherwise the export fails with `backup_export_mismatch` and writes no manifest. Restore is unchanged: it still reads the whole snapshot and inserts it in one transaction, which is the next scale limit (a restore of a very large workspace needs a chunked import; not built, see `docs/launch/README.md`, WA-SCALE-1).
Cost if wrong: a restore may contain a tag or recipient row for a contact created seconds after the snapshot began; harmless because rows refer to each other by value and the restore does not check foreign keys.

## Mac copy
`scripts/backup-pull.sh [date]` mirrors one night's backups plus a D1 export to `~/Backups/ebda-whatsapp/<date>/`,
asserts every file's line count against the manifest, keeps 30 days (prunes only `YYYY-MM-DD` folders), exports D1 first, and skips (then reports, exit 1) workspaces that have no snapshot yet.
Install the daily 04:00 job only when Ahmad approves (it is not installed):
`cp ops/com.ebda.wa-backup-pull.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.ebda.wa-backup-pull.plist`

## Off-Cloudflare copy, bodies included (T21)
`scripts/backup-offsite.sh [date]` (rclone; run from the Mac or a small VPS, not from Cloudflare) copies TONIGHT's snapshots (only `<workspace>/<date>/`, not the whole bucket) to `$OFFSITE_DEST/snapshots/<date>/` and **mirrors `bodies/`** to `$OFFSITE_DEST/bodies/`. The mirror deletes what erasure deleted, so an erased body does not live on off-site; whatever a run removes is first moved to `bodies-removed/<date>/` and kept for `OFFSITE_KEEP_DAYS` (30), then pruned (the same window the privacy policy states). It pulls the snapshots to a local staging folder first and verifies EVERY one there with `scripts/verify-backup-manifest-cli.mjs` (signature, sha256, row counts, and that the manifest names this folder's workspace and date); only verified snapshots are copied to the destination. One bad snapshot does not block the rest: the good ones are copied and the job exits 1 with a summary (`N of M NOT VERIFIED`). `BACKUP_HMAC_KEY` is required (the script exits 2 without it). An UNSIGNED manifest is `NOT VERIFIED`, unless its date is before `BACKUP_KEY_SINCE` (the day signing went live): that snapshot is reported as `LEGACY-UNSIGNED`, skipped (not copied) and does not fail the job. The prune covers an rclone remote too (`rclone delete --min-age <KEEP>d` and `rmdirs` on `snapshots/` and `bodies-removed/`), so an offboarded or erased workspace ages out of the off-site copy within the window. A verifier that prints no `VERIFIED <workspace> <date> <n> files` line, or a staging folder with no snapshot, fails the job: the absence of an error is never read as success. Credentials come from rclone's own config or environment, never from arguments. Install it as a daily job only when Ahmad approves; the Mac pull (`backup-pull.sh`) and this script can both run.
D1 has its own restore path: `d1-time-travel.md`.

## Signed manifests (M-174)
With the secret `BACKUP_HMAC_KEY` set (at least 32 characters; `npx wrangler secret put BACKUP_HMAC_KEY`), each `manifest.json` carries `signature: "hmac-sha256:<hex>"` over its canonical form. A restore with the key set **requires** a valid signature, and the manifest must name exactly the folder it is read from (`backups/<workspace>/<date>/`), so one workspace's genuine signed manifest cannot be placed in another's folder (an unsigned manifest is treated as a stripped signature and refused; a signed one is refused where no key is set, instead of skipping the check). To change the key: set the new one as `BACKUP_HMAC_KEY` and the old as `BACKUP_HMAC_KEY_PREVIOUS` until the old backups age out (30 days), then remove it. Verify a copy offline: `BACKUP_HMAC_KEY=... node scripts/verify-backup-manifest-cli.mjs <.../workspace/date folder>`.

## Restore a workspace
1. Pick the snapshot prefix, e.g. `backups/ws-123/2026-10-24/`.
2. Restore into a FRESH workspace id (the target must be empty): call `WorkspaceDO.importSnapshot(prefix)` on
   `idFromName('<new id>')` (operator route lands in Phase 3; until then a one-off `wrangler` script).
3. It verifies every table's sha256 and row count BEFORE writing; on mismatch it returns `{ ok: false, reason }` and writes nothing. The hash proves **integrity** (corruption, truncation); the HMAC signature (above) proves the manifest was written by us.
   Restored `body_r2_key` values still point at the source workspace's `bodies/<old id>/…` objects, which stay valid; erasing in the restored workspace deletes them.
   The restored workspace arms its own nightly backup alarm.
4. Point the phone number's D1 row (`phone_numbers.workspace_id`) at the restored id.

## Drill
`test/backup.test.ts` runs export → import → equal counts and hashes, the corrupted-file case and the non-empty-target case on every test run.
A live drill on the real account is part of the launch checklist.

## Erasure vs backups
`DELETE /api/v1/stores/:storeId/contacts/:waId` (owner or super admin) erases the contact from the live workspace and its R2 bodies.
Nightly backups taken before the request still hold the contact until they age out (R2 lifecycle on `ebda-wa-backups`: 30 days, to be set when the bucket is created; Mac copies: 30 days via `backup-pull.sh`). The privacy policy must state this 30-day backup window. A restore must re-apply erasures logged after the snapshot date (audit lines `contact_erased`).

## Phase 2 additions
- The four Phase 2 tables (`notes`, `conversation_tags`, `templates`, `uploads`) are optional in the manifest: a Phase 1 backup (four tables) still restores; the new tables come back empty.
- Not in the backup, by design: the search index (rebuilt from message previews on restore), the scheduler/event/throttle/tombstone tables (operational, regenerated), and R2 objects (long bodies, inbound/outbound media, uploads), which live in the `ebda-wa-media` bucket and are not copied.
- After a restore the nightly backup and R2 drain are scheduled again; throttled sends that were waiting are not restored (their messages come back as `queued`).
