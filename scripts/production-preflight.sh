#!/usr/bin/env bash
# Bridge production/release preflight kontrolü
# Ağ gerektirmeyen, hızlı ve deterministik kontroller yapar.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0

ok() { echo "✅ $1"; }
warn() { echo "⚠️  $1"; }
fail() { echo "❌ $1"; FAILED=1; }

require_file() {
  [[ -f "$ROOT/$1" ]] && ok "$1 mevcut" || fail "$1 eksik"
}

require_grep() {
  local pattern="$1" file="$2" label="$3"
  if grep -Eq "$pattern" "$ROOT/$file" 2>/dev/null; then ok "$label"; else fail "$label"; fi
}

secret_entropy_hint() {
  local var_name="$1"
  local value="${!var_name-}"
  if [[ -z "$value" ]]; then warn "$var_name tanımlı değil (CI/local için normal olabilir)"; return; fi
  if [[ ${#value} -lt 32 ]]; then fail "$var_name en az 32 karakter olmalı"; return; fi
  case "$value" in
    *CHANGE_ME*|*changeme*) fail "$var_name placeholder gibi görünüyor" ;;
    *) ok "$var_name uzunluk/placeholder kontrolü geçti" ;;
  esac
}

cd "$ROOT"

echo "== Dosya varlığı =="
require_file "Dockerfile"
require_file "docker-compose.yml"
require_file "docker-compose.prod.yml"
require_file ".github/workflows/quality-gate.yml"
require_file ".github/workflows/electron-release.yml"
require_file "docs/DESKTOP_AUTO_UPDATE.md"
require_file "docs/runbooks/RELEASE_AND_ROLLBACK.md"
require_file "server/.env.example"
require_file "scripts/quality-gate.sh"

echo
echo "== Docker/ops güvenliği =="
require_grep "USER bridge" "Dockerfile" "Docker runtime non-root kullanıcıyla çalışıyor"
require_grep "/api/health/ready" "Dockerfile" "Dockerfile readiness endpoint'i kullanıyor"
require_grep "no-new-privileges:true" "docker-compose.prod.yml" "Compose production no-new-privileges aktif"
require_grep "cap_drop:" "docker-compose.prod.yml" "Compose production Linux capabilities düşürüyor"
require_grep "read_only: true" "docker-compose.prod.yml" "Compose production read-only filesystem aktif"
require_grep "METRICS_SECRET" "server/.env.example" "Metrics secret env dokümante"
require_grep "AP_ENCRYPTION_KEY" "server/.env.example" "ActivityPub encryption key dokümante"

echo
echo "== CI/CD ve release =="
require_grep "npm audit --audit-level=high" ".github/workflows/quality-gate.yml" "CI audit gate mevcut"
require_grep "npm run typecheck:svelte" ".github/workflows/quality-gate.yml" "CI Svelte kalite kapısı mevcut"
require_grep "docker build" ".github/workflows/quality-gate.yml" "CI Docker build gate mevcut"
require_grep "latest.*yml" ".github/workflows/electron-release.yml" "Electron updater metadata release'e yükleniyor"
require_grep "electron-builder" "electron/package.json" "Electron builder konfigürasyonu mevcut"
require_grep "provider.*github" "electron/package.json" "Electron updater publish provider GitHub"

echo
echo "== Sağlık/observability =="
require_grep "router.get\('/live'" "server/routes/health.ts" "Liveness endpoint mevcut"
require_grep "router.get\('/ready'" "server/routes/health.ts" "Readiness endpoint mevcut"
require_grep "metricsEndpoint" "server/middleware/metrics.ts" "Prometheus metrics endpoint mevcut"
require_grep "METRICS_SECRET" "server/middleware/metrics.ts" "Metrics endpoint bearer secret destekli"

echo
echo "== Secret kontrolleri (env varsa) =="
secret_entropy_hint JWT_SECRET
secret_entropy_hint REFRESH_SECRET
secret_entropy_hint FEDERATION_SECRET
secret_entropy_hint AP_ENCRYPTION_KEY
secret_entropy_hint METRICS_SECRET

echo
echo "== Docker compose config =="
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  # Dummy güçlü secret'larla compose şemasını doğrula; container başlatmaz.
  POSTGRES_PASSWORD="preflight-postgres-password-32chars" \
  JWT_SECRET="preflight-jwt-secret-32chars-minimum-value" \
  REFRESH_SECRET="preflight-refresh-secret-32chars-minimum" \
  FEDERATION_SECRET="preflight-federation-secret-32chars-minimum" \
  AP_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
  METRICS_SECRET="preflight-metrics-secret" \
  MINIO_ACCESS_KEY="minioadmin" \
  MINIO_SECRET_KEY="minioadmin123" \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/tmp/bridge-compose-preflight.yml \
    && ok "docker compose config geçerli" \
    || fail "docker compose config başarısız"
else
  warn "docker compose yok; compose şema kontrolü atlandı"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo
  echo "❌ Production preflight başarısız. Yukarıdaki maddeleri düzelt."
  exit 1
fi

echo
echo "✅ Production preflight geçti."
