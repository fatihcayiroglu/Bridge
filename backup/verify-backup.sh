#!/usr/bin/env bash
set -euo pipefail

DUMP_FILE="${1:-}"
if [ -z "$DUMP_FILE" ]; then
  echo "Usage: $0 /path/to/bridge_YYYYmmdd_HHMMSS.sql.gz" >&2
  exit 64
fi
if [ ! -f "$DUMP_FILE" ]; then
  echo "Backup dump bulunamadı: $DUMP_FILE" >&2
  exit 66
fi
command -v gzip >/dev/null 2>&1 || { echo "gzip bulunamadı" >&2; exit 69; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum bulunamadı" >&2; exit 69; }

gzip -t "$DUMP_FILE"
if [ ! -s "$DUMP_FILE" ]; then
  echo "Backup dump boş" >&2
  exit 65
fi

CHECKSUM_FILE="${DUMP_FILE}.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
  (cd "$(dirname "$DUMP_FILE")" && sha256sum -c "$(basename "$CHECKSUM_FILE")")
else
  echo "UYARI: checksum sidecar yok; gzip bütünlüğü doğrulandı ancak artifact identity doğrulanamadı." >&2
fi

# A PostgreSQL custom/plain dump that cannot expose recognizable SQL through
# gzip is not accepted by this current backup format. Never restore opaque data.
if ! gzip -cd "$DUMP_FILE" | head -c 262144 | grep -Eq '(PostgreSQL database dump|CREATE TABLE|COPY |INSERT INTO|SET statement_timeout)'; then
  echo "Dump PostgreSQL SQL içeriği gibi görünmüyor; restore reddedildi." >&2
  exit 65
fi

echo "BACKUP_VERIFY=PASS"
echo "DUMP=$DUMP_FILE"
echo "SHA256=$(sha256sum "$DUMP_FILE" | awk '{print $1}')"
