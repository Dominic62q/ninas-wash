#!/usr/bin/env bash
# Nightly database backup. Keeps 30 days. Run from cron as the `niinas` user:
#   15 2 * * *  /opt/niinas/deploy/backup.sh >> /var/log/niinas-backup.log 2>&1
# Then copy /var/backups/niinas somewhere else too (another machine or cloud storage).
# A backup that lives on the same disk as the database is not enough.
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/niinas/api.env}
DEST=${DEST:-/var/backups/niinas}
KEEP_DAYS=${KEEP_DAYS:-30}

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
mkdir -p "$DEST"
FILE="$DEST/niinas-$(date -u +%Y-%m-%d_%H%M).dump"

pg_dump --format=custom --no-owner "$DATABASE_URL" --file="$FILE"
# A dump that cannot be read back is not a backup.
pg_restore --list "$FILE" > /dev/null
find "$DEST" -name 'niinas-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
