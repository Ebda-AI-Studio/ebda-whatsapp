#!/usr/bin/env bash
# Off-Cloudflare copy of EVERYTHING the product keeps (T21): the nightly workspace snapshots (R2 ebda-wa-backups) AND the long message bodies (R2 ebda-wa-media, bodies/),
# which the snapshots do not contain. Uses rclone against R2's S3 API; the destination is any rclone remote or a local/external disk path, outside Cloudflare.
# Run it from a machine that is not Cloudflare (the Mac, or a small VPS). It never deletes a dated snapshot younger than 30 days and never prints a credential.
#
# Environment (never argv): OFFSITE_DEST (required)  where the copy goes, e.g. b2:ebda-wa-offsite or /Volumes/Backup/ebda-wa
#                           R2_RCLONE_REMOTE         rclone remote name of the R2 account (default r2); configure it with `rclone config` (S3, provider Cloudflare)
#                           BACKUP_HMAC_KEY (+ _PREVIOUS)  when set, every snapshot manifest is verified (signature, hashes, row counts) after it is copied
#                           OFFSITE_KEEP_DAYS        dated folders older than this are removed (default 30, the product's backup + erasure window)
# Usage: scripts/backup-offsite.sh [YYYY-MM-DD]   (default: today in Cairo)
set -euo pipefail
cd "$(dirname "$0")/.."
DATE="${1:-$(TZ=Africa/Cairo date +%F)}"
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad date: $DATE" >&2; exit 2; }
: "${OFFSITE_DEST:?set OFFSITE_DEST to an rclone destination outside Cloudflare}"
R2="${R2_RCLONE_REMOTE:-r2}"
KEEP="${OFFSITE_KEEP_DAYS:-30}"
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "bad OFFSITE_KEEP_DAYS" >&2; exit 2; }
case "$OFFSITE_DEST" in "$R2":*) echo "OFFSITE_DEST must not be the R2 account itself" >&2; exit 2;; esac
command -v rclone >/dev/null || { echo "rclone is required (brew install rclone)" >&2; exit 2; }

DEST="${OFFSITE_DEST%/}"
# 1. Snapshots: a dated folder per night, copy (never sync): yesterday's good copy must survive a bad night.
rclone copy "$R2:ebda-wa-backups/backups" "$DEST/snapshots/$DATE" --checksum --fast-list
# 2. Long bodies: a mirror, so an erased body disappears from the copy at the next run (erasure must not live on off-site). Whatever a run deletes or
#    overwrites is moved into a dated folder first, kept for the same window, so one mistaken deletion on the Cloudflare side is recoverable.
rclone sync "$R2:ebda-wa-media/bodies" "$DEST/bodies" --checksum --fast-list --backup-dir "$DEST/bodies-removed/$DATE"
# 3. Verify what was copied (needs a local path; for a remote destination, pull the snapshot folder first with rclone copy).
if [[ -d "$DEST/snapshots/$DATE" ]]; then
  bad=0
  while IFS= read -r m; do
    node scripts/verify-backup-manifest.mjs "$(dirname "$m")" || bad=$((bad + 1))
  done < <(find "$DEST/snapshots/$DATE" -name manifest.json)
  [[ $bad == 0 ]] || { echo "backup-offsite $DATE: $bad snapshot(s) NOT VERIFIED" >&2; exit 1; }
fi
# 4. Prune only our own dated folders, never anything else under the destination.
if [[ -d "$DEST/snapshots" ]]; then
  find "$DEST/snapshots" "$DEST/bodies-removed" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' -mtime +"$KEEP" -exec rm -rf {} + 2>/dev/null || true
fi
echo "backup-offsite $DATE: snapshots and bodies copied to the destination"
