#!/usr/bin/env bash
# Backs up the Watchbot SQLite database to data/backups/ with a timestamp.
# Usage: bash scripts/backup-db.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="$SCRIPT_DIR/../data/watchbot.db"
BACKUP_DIR="$SCRIPT_DIR/../data/backups"

if [ ! -f "$DB_PATH" ]; then
  echo "✗ Database not found at: $DB_PATH"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/watchbot_$TIMESTAMP.db"

cp "$DB_PATH" "$BACKUP_FILE"

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "✓ Database backed up → $BACKUP_FILE ($SIZE)"
