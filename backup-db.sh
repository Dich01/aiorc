#!/bin/bash
# AIOrc DB backup — safe snapshot of data/aiorc.db (WAL-aware via sqlite3 .backup).
# Keeps the last 14 backups in ~/AIOrc-backups. Scheduled daily via launchd
# (~/Library/LaunchAgents/com.aiorc.backup.plist); run manually any time:
#   ./backup-db.sh

set -e
cd "$(dirname "$0")"

BACKUP_DIR="$HOME/AIOrc-backups"
DB="data/aiorc.db"
KEEP=14

[ -f "$DB" ] || { echo "ERROR: no existe $DB"; exit 1; }
mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/aiorc-$STAMP.db"

sqlite3 "$DB" ".backup '$DEST'"

# Rotate: keep only the newest $KEEP
ls -t "$BACKUP_DIR"/aiorc-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs rm -f 2>/dev/null || true

COUNT=$(ls "$BACKUP_DIR"/aiorc-*.db 2>/dev/null | wc -l | tr -d ' ')
SIZE=$(du -h "$DEST" | cut -f1)
echo "Backup OK: $DEST ($SIZE) — $COUNT backup(s) en $BACKUP_DIR"
