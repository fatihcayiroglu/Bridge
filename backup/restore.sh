#!/usr/bin/env bash
set -euo pipefail

DUMP_FILE="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$DUMP_FILE" ]; then
  echo "Usage: BRIDGE_RESTORE_CONFIRM=RESTORE $0 /path/to/bridge_*.sql.gz" >&2
  exit 64
fi
# P5 SH-02: run through bash — a fresh checkout or a copied script need not carry
# the exec bit (git stored 100644; restore.sh failed with "Permission denied").
bash "$SCRIPT_DIR/verify-backup.sh" "$DUMP_FILE"

if [ "${BRIDGE_RESTORE_DRY_RUN:-false}" = "true" ]; then
  echo "RESTORE_DRY_RUN=PASS"
  exit 0
fi

if [ "${BRIDGE_RESTORE_CONFIRM:-}" != "RESTORE" ]; then
  echo "Restore iptal: BRIDGE_RESTORE_CONFIRM=RESTORE açık onayı gerekli." >&2
  exit 77
fi

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD gerekli}"
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-bridge}"
POSTGRES_DB="${POSTGRES_DB:-bridge}"
command -v psql >/dev/null 2>&1 || { echo "psql bulunamadı" >&2; exit 69; }

# Restore is intentionally explicit and fail-closed. It does not drop/create a
# database automatically: operators must choose the target DB beforehand.
echo "Restore başlıyor: host=$POSTGRES_HOST port=$POSTGRES_PORT db=$POSTGRES_DB user=$POSTGRES_USER"
# Without -f, psql reads stdin in autocommit mode: ON_ERROR_STOP prevents
# subsequent statements but cannot undo earlier successful ones. -f - tells
# psql that stdin is a script; --single-transaction rolls back the whole dump
# on the first SQL error. -X ignores operator .psqlrc startup commands.
# pg_dump here is a plain SQL dump without CREATE DATABASE/-C, restored into
# an explicitly selected, initially empty target database.
gzip -cd "$DUMP_FILE" | PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -X -v ON_ERROR_STOP=1 --single-transaction -f - \
  -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB"
echo "RESTORE=PASS"
