#!/usr/bin/env bash
# Nightly database backup. Keeps 30 days. Run from cron by a user who can use Docker:
#   15 2 * * *  /opt/niinas/deploy/backup.sh >> /var/log/niinas-backup.log 2>&1
# Then copy the backup folder somewhere else too (another machine or cloud storage).
# A backup that lives on the same disk as the database is not enough.
set -euo pipefail

cd "$(dirname "$0")/.."
DEST=${DEST:-/var/backups/niinas}
KEEP_DAYS=${KEEP_DAYS:-30}

mkdir -p "$DEST"
FILE="$DEST/niinas-$(date -u +%Y-%m-%d_%H%M).dump"

docker compose exec -T db pg_dump --username=niinas --format=custom --no-owner niinas > "$FILE"
# A dump that cannot be read back is not a backup.
docker compose exec -T db pg_restore --list < "$FILE" > /dev/null
find "$DEST" -name 'niinas-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
