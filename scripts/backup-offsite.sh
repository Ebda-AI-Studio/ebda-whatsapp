#!/usr/bin/env bash
# Off-Cloudflare copy of EVERYTHING the product keeps (T21): the nightly workspace snapshots (R2 ebda-wa-backups) AND the long message bodies (R2 ebda-wa-media, bodies/),
# which the snapshots do not contain. Uses rclone against R2's S3 API; the destination is any rclone remote or a local/external disk path, outside Cloudflare.
# Run it from a machine that is not Cloudflare (the Mac, or a small VPS). It never deletes a dated snapshot younger than 30 days and never prints a credential.
# Only TONIGHT's folders (`<workspace>/$DATE/`) are pulled, not the whole bucket. A snapshot that fails verification does not block the others: the good ones are copied and the job exits 1 with a summary.
#
# Order matters: snapshots are pulled to a LOCAL staging folder first and VERIFIED there (signature, hashes, row counts, the right workspace and date); only verified snapshots
# are copied to the destination. Every gate must print a positive marker and the script requires it: a verifier that exits 0 and says nothing, a staging folder with no
# snapshot, or a manifest that is missing all FAIL the job (the absence of an error is not a pass).
#
# Environment (never argv): OFFSITE_DEST (required)  where the copy goes, e.g. b2:ebda-wa-offsite or /Volumes/Backup/ebda-wa
#                           R2_RCLONE_REMOTE         rclone remote name of the R2 account (default r2); configure it with `rclone config` (S3, provider Cloudflare)
#                           BACKUP_HMAC_KEY (+ _PREVIOUS)  signature key of the manifests: REQUIRED (an unsigned or unkeyed check proves nothing about who wrote the folder)
#                           BACKUP_KEY_SINCE         YYYY-MM-DD the day signing went live; an UNSIGNED snapshot dated before it is reported as legacy and skipped (not copied, does not fail the job)
#                           OFFSITE_STAGE            local staging folder (default $TMPDIR/ebda-wa-offsite-<date>)
#                           OFFSITE_KEEP_DAYS        dated folders older than this are removed (default 30, the product's backup + erasure window)
# Usage: scripts/backup-offsite.sh [YYYY-MM-DD]   (default: today in Cairo)
set -euo pipefail
cd "$(dirname "$0")/.."
DATE="${1:-$(TZ=Africa/Cairo date +%F)}"
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad date: $DATE" >&2; exit 2; }
: "${OFFSITE_DEST:?set OFFSITE_DEST to an rclone destination outside Cloudflare}"
[[ -n "${BACKUP_HMAC_KEY:-}" ]] || { echo "set BACKUP_HMAC_KEY: the off-site copy only accepts signed snapshots" >&2; exit 2; }
R2="${R2_RCLONE_REMOTE:-r2}"
KEEP="${OFFSITE_KEEP_DAYS:-30}"
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "bad OFFSITE_KEEP_DAYS" >&2; exit 2; }
case "$OFFSITE_DEST" in "$R2":*) echo "OFFSITE_DEST must not be the R2 account itself" >&2; exit 2;; esac
command -v rclone >/dev/null || { echo "rclone is required (brew install rclone)" >&2; exit 2; }

DEST="${OFFSITE_DEST%/}"
STAGE="${OFFSITE_STAGE:-${TMPDIR:-/tmp}/ebda-wa-offsite-$DATE}"
STAGE="${STAGE%/}"
rm -rf "$STAGE"; mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

# 1. Pull ONLY tonight's snapshots (`<workspace>/$DATE/...`) to local staging; the older nights are already off-site.
rclone copy "$R2:ebda-wa-backups/backups" "$STAGE/snapshots" --checksum --fast-list --include "*/$DATE/**"
# 2. Verify every snapshot found there; at least one must exist, and each must print its VERIFIED line. A good one is moved to $STAGE/verified; a bad one is reported and left behind.
found=0; bad=0; legacy=0; good=0
mkdir -p "$STAGE/verified"
while IFS= read -r m; do
  found=$((found + 1))
  dir="$(dirname "$m")"
  out="$(node scripts/verify-backup-manifest-cli.mjs "$dir" 2>&1)" && ok=1 || ok=0
  if [[ $ok == 1 && "$out" == VERIFIED\ * ]]; then
    rel="${dir#"$STAGE/snapshots/"}"
    mkdir -p "$STAGE/verified/$(dirname "$rel")"; cp -R "$dir" "$STAGE/verified/$rel"
    good=$((good + 1))
  elif [[ $ok == 1 && "$out" == LEGACY-UNSIGNED\ * ]]; then legacy=$((legacy + 1)); echo "LEGACY: $out"
  else bad=$((bad + 1)); echo "NOT VERIFIED: $dir: ${out:-(no output)}" >&2; fi
done < <(find "$STAGE/snapshots" -name manifest.json)
[[ $found -gt 0 ]] || { echo "backup-offsite $DATE: no snapshot found to verify (an empty copy is not a verified one)" >&2; exit 1; }
if [[ $good == 0 ]]; then echo "backup-offsite $DATE: $bad of $found snapshot(s) NOT VERIFIED, $legacy legacy; nothing was copied off-site" >&2; exit 1; fi
# 3. Only verified snapshots leave staging: a dated folder per night, copy (never sync): yesterday's good copy must survive a bad night.
rclone copy "$STAGE/verified" "$DEST/snapshots/$DATE" --checksum
# 4. Long bodies: a mirror, so an erased body disappears from the copy at the next run (erasure must not live on off-site). Whatever a run deletes or
#    overwrites is moved into a dated folder first, kept for the same window, so one mistaken deletion on the Cloudflare side is recoverable.
rclone sync "$R2:ebda-wa-media/bodies" "$DEST/bodies" --checksum --fast-list --backup-dir "$DEST/bodies-removed/$DATE"
# 5. Prune only our own dated folders, never anything else under the destination. A local destination: `find`. An rclone REMOTE: `rclone delete --min-age` removes the files,
#    `rmdirs` the emptied folders, so an offboarded or erased workspace ages out of the off-site copy too (it must not live on there for ever).
if [[ -d "$DEST" ]]; then
  if [[ -d "$DEST/snapshots" ]]; then
    find "$DEST/snapshots" "$DEST/bodies-removed" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' -mtime +"$KEEP" -exec rm -rf {} + 2>/dev/null || true
  fi
else
  for d in snapshots bodies-removed; do
    rclone delete "$DEST/$d" --min-age "${KEEP}d" || echo "backup-offsite $DATE: prune of $DEST/$d failed" >&2
    rclone rmdirs "$DEST/$d" --leave-root || true
  done
fi
if [[ $bad -gt 0 ]]; then
  echo "backup-offsite $DATE: $bad of $found snapshot(s) NOT VERIFIED and not copied; $good copied, $legacy legacy" >&2
  exit 1
fi
echo "backup-offsite $DATE: $good snapshot(s) verified and copied, $legacy legacy-unsigned skipped; bodies mirrored"
