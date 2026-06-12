#!/usr/bin/env bash
# scripts/check-svelte-boundary.sh
# ADR-0008 CI Guard — Servis katmanı Svelte import etmemeli
#
# Sprint 108
# CI: lint-and-typecheck job'ında çalışır

set -euo pipefail

# Servis katmanı dosyaları — asla Svelte import etmemeli
SERVICE_FILES=(
  "client/js/core/socket.ts"
  "client/js/core/state.ts"
  "client/js/core/auth.ts"
  "client/js/core/globals.ts"
  "client/js/app.ts"
  "client/js/core/api-fetch.ts"
  "client/js/core/offline-queue.ts"
  "client/js/core/bridge-registry.ts"
)

VIOLATIONS=""

for FILE in "${SERVICE_FILES[@]}"; do
  if [ ! -f "$FILE" ]; then
    continue  # Dosya yoksa atla (henüz oluşturulmamış olabilir)
  fi

  # svelte import: from 'svelte', from 'svelte/...', *.svelte
  if grep -En "(from ['\"]svelte|from ['\"].*\.svelte)" "$FILE" 2>/dev/null | grep -v "^.*//"; then
    VIOLATIONS="$VIOLATIONS\n  $FILE"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "❌ ADR-0008 İHLALİ: Servis katmanı dosyaları Svelte import ediyor:"
  echo -e "$VIOLATIONS"
  echo ""
  echo "Kurallar: docs/FRONTEND_ARCHITECTURE.md ve docs/ADR-0008-frontend-framework-strategy.md"
  exit 1
fi

echo "✅ Svelte servis katmanı sınır kontrolü geçti"
