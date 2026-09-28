#!/usr/bin/env bash
#
# Off-box sync for Kinkology MongoDB backups.
#
# The nightly backup-mongo.sh writes archives to a local directory ON THE VPS.
# If the VPS disk dies, those backups die with it. This script copies the
# backup directory to a SECOND location off the box. Run it right after the
# dump (same cron line, chained with &&) so each night's backup is mirrored.
#
# It supports two targets — pick ONE by setting SYNC_MODE:
#
#   SYNC_MODE=rsync   push to another host over SSH (e.g. your Mac, a NAS,
#                     a second VPS). Needs key-based SSH set up so cron runs
#                     unattended. Set RSYNC_DEST=user@host:/path/to/dir
#
#   SYNC_MODE=s3      push to an S3 bucket (or any S3-compatible store like
#                     Backblaze B2, Wasabi). Needs the AWS CLI installed and
#                     credentials configured (aws configure / env / IAM role).
#                     Set S3_DEST=s3://your-bucket/kinkology-backups
#
# EXAMPLE cron (as your user, chained after the dump):
#   30 3 * * * BACKUP_DIR=/home/administrator/kinkology-backups \
#     /usr/local/bin/backup-mongo.sh && \
#     SYNC_MODE=rsync RSYNC_DEST=steph@my-mac.local:~/kinkology-offsite \
#     BACKUP_DIR=/home/administrator/kinkology-backups \
#     /usr/local/bin/backup-sync.sh >> /home/administrator/kinkology-backup.log 2>&1
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/kinkology}"
SYNC_MODE="${SYNC_MODE:-}"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "ERROR: BACKUP_DIR '$BACKUP_DIR' does not exist." >&2
  exit 1
fi

case "$SYNC_MODE" in
  rsync)
    : "${RSYNC_DEST:?Set RSYNC_DEST=user@host:/path for SYNC_MODE=rsync}"
    echo "[$(date -Is)] rsync '$BACKUP_DIR/' -> '$RSYNC_DEST'"
    # -a archive, -z compress, --delete keeps the mirror in sync (drops files
    # locally pruned by the 14-day rotation). SSH must be key-based for cron.
    rsync -az --delete -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
      "$BACKUP_DIR/" "$RSYNC_DEST/"
    echo "[$(date -Is)] rsync off-box sync complete"
    ;;
  s3)
    : "${S3_DEST:?Set S3_DEST=s3://bucket/prefix for SYNC_MODE=s3}"
    command -v aws >/dev/null 2>&1 || { echo "ERROR: aws CLI not installed." >&2; exit 1; }
    echo "[$(date -Is)] aws s3 sync '$BACKUP_DIR/' -> '$S3_DEST/'"
    # --delete mirrors the rotation; drop it to keep S3 copies forever.
    aws s3 sync "$BACKUP_DIR/" "$S3_DEST/" --delete
    echo "[$(date -Is)] S3 off-box sync complete"
    ;;
  "")
    echo "ERROR: set SYNC_MODE=rsync or SYNC_MODE=s3 (see header for setup)." >&2
    exit 1
    ;;
  *)
    echo "ERROR: unknown SYNC_MODE '$SYNC_MODE' (use rsync or s3)." >&2
    exit 1
    ;;
esac
