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
gzip -t "$DUMP_FILE"
# Sağlama dosyası YALNIZCA dosya adını taşır (Final21 Faz 19). Mutlak yol yazılıyordu; oysa
# verify-backup.sh dökümün kendi dizininde `sha256sum -c` çalıştırır: S3'ten indirilen ya da başka
# bir diske kopyalanan HER yedek doğrulamada düşüyordu (ölçüldü, tools/p19-compose-prod-boot.sh).
(cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP_FILE")" > "$(basename "$DUMP_FILE").sha256")
echo "[$(date)] DB dump doğrulandı: $DUMP_FILE"

# Uploads rsync
# Sahiplik KOPYALANMAZ (Final21 Faz 19): üretim sertleştirmesi CAP_CHOWN'u düşürür; `rsync -a`
# chown denemesiyle kod 23 veriyor, `set -e` betiği orada kesiyordu (eski dökümler silinmiyor,
# S3 yüklemesi hiç yapılmıyordu). Geri yükleme sahipliği hedefte yeniden kurar.
rsync -a --no-owner --no-group --delete /app/server/uploads/ "$UPLOADS_BACKUP/"
echo "[$(date)] Uploads rsync tamamlandı"

# Eski dump'ları temizle
find "$BACKUP_DIR" \( -name "*.sql.gz" -o -name "*.sql.gz.sha256" \) -mtime "+${KEEP_DAYS}" -delete
echo "[$(date)] ${KEEP_DAYS} günden eski dump'lar silindi"

# S3 yükle (opsiyonel). Local backup başarısı remote kopyadan bağımsızdır,
# fakat remote failure açıkça raporlanır; sessiz false-success yoktur.
if [ -n "${S3_BUCKET:-}" ]; then
  ENDPOINT_ARGS=()
  [ -n "${S3_ENDPOINT:-}" ] && ENDPOINT_ARGS=(--endpoint-url "$S3_ENDPOINT")
  if aws s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/postgres/" \
      --storage-class "${S3_STORAGE_CLASS:-STANDARD_IA}" "${ENDPOINT_ARGS[@]}" \
    && aws s3 cp "${DUMP_FILE}.sha256" "s3://${S3_BUCKET}/postgres/" \
      --storage-class "${S3_STORAGE_CLASS:-STANDARD_IA}" "${ENDPOINT_ARGS[@]}"; then
    echo "[$(date)] S3 dump + checksum yükleme tamamlandı"
  else
    echo "[$(date)] UYARI: S3 yedek kopyası başarısız; yerel doğrulanmış backup korunuyor" >&2
  fi
fi

echo "[$(date)] Backup tamamlandı ✓"
