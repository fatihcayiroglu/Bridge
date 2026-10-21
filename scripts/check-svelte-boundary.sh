#!/usr/bin/env bash
# scripts/check-svelte-boundary.sh
# ADR-0008 CI Guard — Servis katmanı ve framework'ten bağımsız katman Svelte import etmemeli
#
# Sprint 108
# CI: quality-gate.yml → typecheck-build işinde çalışır (Faz 16: önceden HİÇBİR iş çağırmıyordu)
# Test: scripts/check-svelte-boundary.test.js (npm run test:release-integrity)
#
# Listelenen bir dosya ya da dizin yoksa betik BAŞARISIZ olur. 2026-10-21'e kadar
# eksik dosyalar sessizce atlanıyordu: 8 girdinin 3'ü (socket.ts, auth.ts,
# offline-queue.ts) silinmişti ve kapı yine de yeşildi.
#
# Liste docs/FRONTEND_ARCHITECTURE.md → "Kesin Sınır: Servis Katmanı" ile aynı
# olmalı; test ikisini karşılaştırır.
#
# Kullanım:
#   bash scripts/check-svelte-boundary.sh          # denetle
#   bash scripts/check-svelte-boundary.sh --list   # korunan yolları yazdır

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Servis katmanı — asla Svelte import etmemeli. .svelte dosyaları buraya
# eklenmez: tanım gereği Svelte'dirler (soket SocketManager.svelte'te, mesaj
# yükleme MessageLoader.svelte'te, uygulama durumu AppState.svelte'te).
SERVICE_FILES=(
  "client/js/app.ts"
  "client/js/core/globals.ts"
  "client/js/core/state.ts"
  "client/js/core/bridge-registry.ts"
  "client/js/core/api-fetch.ts"
  "client/js/core/api-error.ts"
  "client/js/core/auth-compat.ts"
  "client/js/core/outbox-store.ts"
  # Framework'ten bağımsız modüller
  "client/js/core/messages/message-format.ts"
)

# Framework'ten bağımsız dizinler — içindeki HER kaynak dosya denetlenir (sonradan
# eklenenler dahil). Bu dizinlerde .svelte / .svelte.ts dosyası bulunamaz.
SERVICE_DIRS=(
  "client/js/core/local-first"
)

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${SERVICE_FILES[@]}"
  for DIR in "${SERVICE_DIRS[@]}"; do printf '%s/\n' "$DIR"; done
  exit 0
fi

ERRORS=()
VIOLATIONS=()
CHECKED_FILES=()
CHECKED=0

is_svelte_module() {
  case "$1" in
    *.svelte | *.svelte.*) return 0 ;;
    *) return 1 ;;
  esac
}

check_file() {
  CHECKED=$((CHECKED + 1))
  CHECKED_FILES+=("$1")
}

for FILE in "${SERVICE_FILES[@]}"; do
  if is_svelte_module "$FILE"; then
    ERRORS+=("$FILE: Svelte dosyası servis listesine eklenmez")
  elif [ ! -f "$FILE" ]; then
    ERRORS+=("$FILE: listede ama dosya yok (taşındıysa listeyi ve dokümanı güncelleyin)")
  else
    check_file "$FILE"
  fi
done

for DIR in "${SERVICE_DIRS[@]}"; do
  if [ ! -d "$DIR" ]; then
    ERRORS+=("$DIR/: listede ama dizin yok (taşındıysa listeyi ve dokümanı güncelleyin)")
    continue
  fi
  FOUND=0
  while IFS= read -r -d '' FILE; do
    if is_svelte_module "$FILE"; then
      VIOLATIONS+=("$FILE" "      Svelte modülü framework'ten bağımsız dizinde")
      FOUND=$((FOUND + 1))
      continue
    fi
    case "$FILE" in
      *.ts | *.mts | *.cts | *.js | *.mjs | *.cjs)
        FOUND=$((FOUND + 1))
        check_file "$FILE"
        ;;
    esac
  done < <(find "$DIR" -type f -print0 | sort -z)
  if [ "$FOUND" -eq 0 ]; then
    ERRORS+=("$DIR/: dizinde denetlenecek kaynak dosya yok")
  fi
done

if [ "${#CHECKED_FILES[@]}" -gt 0 ]; then
  # Valid imports may contain comments or line breaks between their tokens.
  SCAN_OUTPUT="$(node scripts/check-svelte-imports.cjs "${CHECKED_FILES[@]}")" || {
    ERRORS+=("TypeScript import scanner failed")
    SCAN_OUTPUT=""
  }
  if [ -n "$SCAN_OUTPUT" ]; then
    while IFS= read -r line; do VIOLATIONS+=("$line"); done <<< "$SCAN_OUTPUT"
  fi
fi

STATUS=0

if [ "${#ERRORS[@]}" -gt 0 ]; then
  echo "❌ Svelte sınır kontrolü yapılandırması bozuk — denetlenemeyen girdiler:"
  printf '  %s\n' "${ERRORS[@]}"
  echo ""
  STATUS=1
fi

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  echo "❌ ADR-0008 İHLALİ: Servis katmanı dosyaları Svelte import ediyor:"
  printf '  %s\n' "${VIOLATIONS[@]}"
  echo ""
  STATUS=1
fi

if [ "$STATUS" -ne 0 ]; then
  echo "Kurallar: docs/FRONTEND_ARCHITECTURE.md ve docs/ADR-0008-frontend-framework-strategy.md"
  exit 1
fi

echo "✅ Svelte servis katmanı sınır kontrolü geçti ($CHECKED dosya denetlendi)"
