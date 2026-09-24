#!/usr/bin/env bash
#
# Nightly MongoDB backup for the Kinkology stack.
#
# Dumps the `kinkology` database out of the running mongo container to a
# timestamped gzip archive, then prunes archives older than RETENTION_DAYS.
# Designed to be run from cron on the VPS host.
#
# INSTALL (on the VPS):
#   1. Copy this script somewhere stable and make it executable:
#        sudo install -m 755 backup-mongo.sh /usr/local/bin/backup-mongo.sh
#   2. Pick a backup directory (default /var/backups/kinkology) — make sure it
#      exists and has room:
#        sudo mkdir -p /var/backups/kinkology
#   3. Add a cron entry (as root) to run nightly at 03:30:
#        sudo crontab -e
#      add:
#        30 3 * * * /usr/local/bin/backup-mongo.sh >> /var/log/kinkology-backup.log 2>&1
#   4. Test it once by hand first:
#        sudo /usr/local/bin/backup-mongo.sh
#
# RESTORE (from an archive):
#   gunzip -c /var/backups/kinkology/kinkology-YYYYMMDD-HHMMSS.gz \
#     | docker exec -i "$MONGO_CONTAINER" mongorestore --archive --drop --gzip
#   (--drop replaces existing data; omit it to merge.)
#
set -euo pipefail

# --- config (override via environment) -------------------------------------
DB_NAME="${DB_NAME:-kinkology}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/kinkology}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
# Name of the running mongo container. Auto-detected if not set.
MONGO_CONTAINER="${MONGO_CONTAINER:-}"

# --- locate the mongo container ---------------------------------------------
if [[ -z "$MONGO_CONTAINER" ]]; then
  MONGO_CONTAINER="$(docker ps --filter "name=mongo" --format '{{.Names}}' | head -n1)"
fi
if [[ -z "$MONGO_CONTAINER" ]]; then
  echo "ERROR: no running mongo container found (set MONGO_CONTAINER)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/${DB_NAME}-${TS}.gz"

echo "[$(date -Is)] dumping '$DB_NAME' from container '$MONGO_CONTAINER' -> $OUT"

# mongodump streams a gzipped archive to stdout; capture it on the host.
docker exec "$MONGO_CONTAINER" \
  mongodump --db "$DB_NAME" --archive --gzip > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[$(date -Is)] backup complete: $OUT ($SIZE)"

# --- prune old backups ------------------------------------------------------
echo "[$(date -Is)] pruning backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -name "${DB_NAME}-*.gz" -type f -mtime "+${RETENTION_DAYS}" -print -delete || true

echo "[$(date -Is)] done. current backups:"
ls -lh "$BACKUP_DIR"/${DB_NAME}-*.gz 2>/dev/null | tail -5 || echo "  (none)"
