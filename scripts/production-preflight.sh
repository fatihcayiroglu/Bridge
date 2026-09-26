#!/usr/bin/env bash
# Bridge production/release preflight kontrolü
# Ağ gerektirmeyen, hızlı ve deterministik kontroller yapar.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0
STRICT="${PREFLIGHT_STRICT:-0}"

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

require_media_policy() {
  if [[ "${REQUIRE_TURN:-false}" == "true" ]]; then
    if [[ -n "${TURN_SECRET:-}" && -n "${TURN_HOST:-}" ]]; then
      ok "REQUIRE_TURN credentialed coturn yapılandırması mevcut"
    elif [[ -n "${TURN_URL:-}" && -n "${TURN_USERNAME:-}" && -n "${TURN_CREDENTIAL:-}" ]]; then
      ok "REQUIRE_TURN credentialed statik TURN yapılandırması mevcut"
    else
      fail "REQUIRE_TURN=true ancak credentialed TURN yapılandırması eksik"
    fi
  fi
  if [[ "${REQUIRE_SFU:-false}" == "true" ]]; then
    if [[ -n "${MEDIASOUP_ANNOUNCED_IP:-}" ]]; then
      ok "REQUIRE_SFU public announced IP tanımlı"
    else
      fail "REQUIRE_SFU=true ancak MEDIASOUP_ANNOUNCED_IP eksik"
    fi
    require_grep '"mediasoup"[[:space:]]*:' "server/package.json" "REQUIRE_SFU mediasoup dependency sözleşmesi mevcut"
  fi
}

secret_entropy_hint() {
  local var_name="$1"
  local value="${!var_name-}"
  if [[ -z "$value" ]]; then
    if [[ "$STRICT" == "1" ]]; then fail "$var_name production preflight için zorunlu"; else warn "$var_name tanımlı değil (CI/local için normal olabilir)"; fi
    return
  fi
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
# Faz 16: bu beş mandal `verify:all` içinde vardı ama CI'da YOKTU; yani yalnızca
# biri elle çalıştırdığında korurlardı. CI'ya eklendiler ve varlıkları burada
# mandallandı — tekrar sessizce düşerlerse preflight KIRMIZI olur.
#
# `run:` ŞARTI BİLEREK: ilk yazımda yalnızca dosya adı aranıyordu ve mutasyon
# kontrolü (P5) bunu yakaladı — adı geçen bir YORUM satırı kapıyı tatmin ediyor,
# adım `echo skipped`e çevrilse bile preflight YEŞİL kalıyordu. Kapı artık
# çalıştırma satırının kendisini istiyor.
require_grep "run: npm run check:any" ".github/workflows/quality-gate.yml" "CI 'as any' mandalı mevcut"
require_grep "run: npm run check:brand" ".github/workflows/quality-gate.yml" "CI marka rengi sözleşmesi mevcut"
require_grep "run: npm run check:native-version" ".github/workflows/quality-gate.yml" "CI yerel sürüm paritesi mevcut"
require_grep "run: node scripts/check-no-legacy.mjs" ".github/workflows/quality-gate.yml" "CI legacy giriş noktası kapısı mevcut"
require_grep "run: bash scripts/check-svelte-boundary.sh" ".github/workflows/quality-gate.yml" "CI ADR-0008 Svelte sınır muhafızı mevcut"
# Faz 17: iki KAPSAM kapısı da CI'da koşmalıdır.
#  · sunucu  — `jest --coverage`, eşikler server/package.json `coverageThreshold` içinde;
#              kapsamsız koşarsa eşikler HİÇ uygulanmaz (bu tuzağa daha önce düşüldü).
#  · istemci — `test:svelte:coverage`, %90 S/B/F/L; betik vardı ama HİÇBİR YERDE
#              çağrılmıyordu, yani istemci eşiği yalnızca elle koşana uygulanıyordu.
require_grep "jest --coverage" ".github/workflows/quality-gate.yml" "CI sunucu paketi KAPSAMLA koşuyor (eşikler uygulanıyor)"
require_grep "run: npm run test:svelte:coverage" ".github/workflows/quality-gate.yml" "CI istemci %90 kapsam kapısı mevcut"
require_grep "docker build" ".github/workflows/quality-gate.yml" "CI Docker build gate mevcut"
require_grep "latest.*yml" ".github/workflows/electron-release.yml" "Electron updater metadata release'e yükleniyor"
require_grep "electron-builder" "electron/package.json" "Electron builder konfigürasyonu mevcut"
# ══════════════════════════════════════════════════════════════════════════
# BAYAT KAPI — GÜVENLİK DÜZELTMESİNİN TERSİNİ İSTİYORDU (Final21 Faz 16)
# ══════════════════════════════════════════════════════════════════════════
# Buradaki eski satır `provider.*github` dizgisinin `electron/package.json`
# içinde OLMASINI şart koşuyordu. Faz 12 (F21-12-06) tam da o sabit beslemeyi
# GÜVENLİK NEDENİYLE kaldırdı: `bridge-app/bridge` deposu 404'tü, o adı kim
# oluşturursa kurulu her istemciye güncelleme gönderebilirdi. Sonuç: preflight
# Faz 12'den beri KIRMIZIydı ve CI'da da koşuyordu; kapı, güvensiz yapılandırmayı
# geri istiyordu. Şimdi sözleşmenin DOĞRU yönü mandallanıyor.
if grep -Eq '"publish"' "$ROOT/electron/package.json" 2>/dev/null; then
  fail "electron/package.json sabit güncelleme beslemesi içeriyor (Faz 12'de kaldırılmıştı)"
else
  ok "Electron paketinde sabit güncelleme beslemesi YOK (besleme iş akışında enjekte edilir)"
fi
require_grep "c\.publish\.provider=github" ".github/workflows/electron-release.yml" \
  "İmzalı release iş akışı güncelleme beslemesini kendi deposundan enjekte ediyor"
require_file "electron/updatePolicy.ts"
require_grep "allowDowngrade = false" "electron/updater.ts" "Updater sürüm düşürmeye kapalı"
require_grep "allowUnsignedUpdates" "electron/updatePolicy.ts" "İmzasız besleme yalnızca açıkça işaretli derlemede"

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
require_media_policy

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
  REDIS_PASSWORD="preflight-redis-password-hex" \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/tmp/bridge-compose-preflight.yml \
    && ok "docker compose config geçerli" \
    || fail "docker compose config başarısız"
else
  if [[ "$STRICT" == "1" ]]; then
    fail "docker compose yok; strict production preflight compose şemasını doğrulayamıyor"
  else
    warn "docker compose yok; compose şema kontrolü atlandı"
  fi
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo
  echo "❌ Production preflight başarısız. Yukarıdaki maddeleri düzelt."
  exit 1
fi

echo
echo "✅ Production preflight geçti."
