#!/usr/bin/env bash
# Bridge 10/10 kalite kapısı
#
# Amaç: CI ile aynı kritik kontrolleri yerelde tek komutla çalıştırmak.
# Kullanım:
#   ./scripts/quality-gate.sh
#   SKIP_INSTALL=1 ./scripts/quality-gate.sh
#   FAST=1 ./scripts/quality-gate.sh        # ağır e2e browser install adımını atlar

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${LOG_DIR:-$ROOT/.quality-logs}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
FAST="${FAST:-0}"
mkdir -p "$LOG_DIR"

section() {
  printf '\n\033[1;36m==> %s\033[0m\n' "$1"
}

run() {
  local name="$1"; shift
  local logfile="$LOG_DIR/${name//[^a-zA-Z0-9_.-]/_}.log"
  echo "→ $name"
  if "$@" >"$logfile" 2>&1; then
    echo "  ✅ geçti ($logfile)"
  else
    echo "  ❌ kaldı ($logfile)"
    tail -120 "$logfile" || true
    exit 1
  fi
}

run_bash() {
  local name="$1"; shift
  run "$name" bash -lc "$*"
}

section "Ortam"
run_bash "node-version" "cd '$ROOT' && node -e \"const major=+process.versions.node.split('.')[0]; if(major<22){throw new Error('Node 22+ gerekli, mevcut '+process.version)}; console.log(process.version)\""
run_bash "npm-version" "cd '$ROOT' && npm --version"

if [[ "$SKIP_INSTALL" != "1" ]]; then
  section "Bağımlılık kurulumu"
  run_bash "root-npm-ci" "cd '$ROOT' && npm ci"
  run_bash "server-npm-ci" "cd '$ROOT/server' && npm ci"
  if [[ -d "$ROOT/electron" ]]; then run_bash "electron-npm-ci" "cd '$ROOT/electron' && npm ci"; fi
  if [[ -f "$ROOT/e2e/package.json" ]]; then run_bash "e2e-npm-ci" "cd '$ROOT/e2e' && npm ci"; fi
else
  echo "SKIP_INSTALL=1 → npm ci adımları atlandı."
fi

section "Güvenlik audit"
run_bash "root-audit" "cd '$ROOT' && npm audit --audit-level=high"
run_bash "server-audit" "cd '$ROOT/server' && npm audit --audit-level=high"
if [[ -d "$ROOT/electron" ]]; then run_bash "electron-audit" "cd '$ROOT/electron' && npm audit --audit-level=high"; fi
if [[ -f "$ROOT/e2e/package.json" ]]; then run_bash "e2e-audit" "cd '$ROOT/e2e' && npm audit --audit-level=high"; fi

section "Statik kalite"
run_bash "root-typecheck" "cd '$ROOT' && npm run typecheck"
run_bash "strict-client" "cd '$ROOT' && npm run typecheck:strict-client"
run_bash "client-bridge5" "cd '$ROOT' && npm run typecheck:client-bridge5"
run_bash "svelte-check" "cd '$ROOT' && npm run typecheck:svelte"
if [[ -f "$ROOT/e2e/package.json" ]]; then run_bash "e2e-typecheck" "cd '$ROOT/e2e' && npm run typecheck"; fi

section "Build"
run_bash "client-build-budget" "cd '$ROOT' && npm run build:ci"
run_bash "server-build" "cd '$ROOT/server' && npm run build"
if [[ -d "$ROOT/electron" ]]; then run_bash "electron-compile" "cd '$ROOT/electron' && npm run compile"; fi
run_bash "mobile-build" "cd '$ROOT' && npm run mobile:build:ci"

section "Test"
run_bash "server-tests" "cd '$ROOT/server' && npm test -- --runInBand --forceExit"
if [[ -d "$ROOT/electron" ]]; then run_bash "electron-tests" "cd '$ROOT/electron' && npm test -- --runInBand --forceExit"; fi
run_bash "mobile-tests" "cd '$ROOT' && npx jest --config jest.mobile.config.js --passWithNoTests --runInBand --forceExit"

section "Production preflight"
run_bash "production-preflight" "cd '$ROOT' && ./scripts/production-preflight.sh"

if [[ "$FAST" != "1" && -f "$ROOT/e2e/package.json" ]]; then
  section "E2E hazırlık doğrulaması"
  run_bash "playwright-config-list" "cd '$ROOT/e2e' && npx playwright test --list"
else
  echo "FAST=1 veya e2e yok → Playwright test listeleme adımı atlandı."
fi

section "Sonuç"
echo "✅ Bridge kalite kapısı tamamlandı. Loglar: $LOG_DIR"
