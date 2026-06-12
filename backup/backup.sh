#!/usr/bin/env bash
set -euo pipefail

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="/backups/postgres"
UPLOADS_BACKUP="/backups/uploads"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR" "$UPLOADS_BACKUP"

echo "[$(date)] Backup başlıyor..."

# pg_dump
DUMP_FILE="$BACKUP_DIR/bridge_${TIMESTAMP}.sql.gz"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  -h postgres -U bridge -d bridge \
  | gzip > "$DUMP_FILE"
echo "[$(date)] DB dump: $DUMP_FILE"

# Uploads rsync
rsync -a --delete /app/server/uploads/ "$UPLOADS_BACKUP/"
echo "[$(date)] Uploads rsync tamamlandı"

# Eski dump'ları temizle
find "$BACKUP_DIR" -name "*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
echo "[$(date)] ${KEEP_DAYS} günden eski dump'lar silindi"

# S3 yükle (opsiyonel)
if [ -n "${S3_BUCKET:-}" ]; then
  ENDPOINT_ARGS=""
  [ -n "${S3_ENDPOINT:-}" ] && ENDPOINT_ARGS="--endpoint-url $S3_ENDPOINT"
  aws s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/postgres/" \
    --storage-class "${S3_STORAGE_CLASS:-STANDARD_IA}" \
    $ENDPOINT_ARGS \
    && echo "[$(date)] S3 yükleme tamamlandı" \
    || echo "[$(date)] S3 yükleme başarısız (devam ediliyor)"
fi

echo "[$(date)] Backup tamamlandı ✓"
