#!/usr/bin/env bash
# deploy.sh — Bridge Production Deploy Script (Oracle Linux)
# Kullanım: bash deploy.sh [--branch main] [--env production]
# Sıra: git pull → npm install → tsc build → pm2 reload
set -euo pipefail

# ── Renkli çıktı ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Parametreler ─────────────────────────────────────────────
BRANCH="${BRANCH:-main}"
NODE_ENV="${NODE_ENV:-production}"
APP_NAME="${PM2_APP:-bridge}"
DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
SERVER_DIR="${DEPLOY_DIR}/server"
LOG_DIR="${DEPLOY_DIR}/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Argüman parse
while [[ $# -gt 0 ]]; do
  case $1 in
    --branch)  BRANCH="$2";   shift 2 ;;
    --env)     NODE_ENV="$2"; shift 2 ;;
    --app)     APP_NAME="$2"; shift 2 ;;
    *)         log_warn "Bilinmeyen argüman: $1"; shift ;;
  esac
done

# ── Ön kontroller ─────────────────────────────────────────────
log_info "Bridge Deploy başlıyor — branch: ${BRANCH}, env: ${NODE_ENV}"
log_info "Deploy dizini: ${DEPLOY_DIR}"

# Log dizinini oluştur
mkdir -p "${LOG_DIR}"
DEPLOY_LOG="${LOG_DIR}/deploy_${TIMESTAMP}.log"
exec > >(tee -a "${DEPLOY_LOG}") 2>&1

# Gerekli araçları kontrol et
for cmd in git node npm pm2 npx; do
  if ! command -v "${cmd}" &>/dev/null; then
    log_error "${cmd} bulunamadı. Lütfen önce kurulumu tamamlayın."
    exit 1
  fi
done

NODE_VER=$(node --version)
log_info "Node.js sürümü: ${NODE_VER}"

# Node.js 18+ gerekli
NODE_MAJOR=$(echo "${NODE_VER}" | sed 's/v//' | cut -d. -f1)
if [[ ${NODE_MAJOR} -lt 18 ]]; then
  log_error "Node.js 18 veya üzeri gerekli (mevcut: ${NODE_VER})"
  exit 1
fi

# ── Deploy adımları ───────────────────────────────────────────

# ── 1. Git pull ───────────────────────────────────────────────
log_info "1/5 — Git pull (branch: ${BRANCH})"
cd "${DEPLOY_DIR}"

# Yerel değişiklikleri stash'le (yapılandırma dosyaları korunur)
if ! git diff --quiet HEAD; then
  log_warn "Takip edilen dosyalarda yerel değişiklikler var — stash'leniyor"
  git stash push -m "deploy_${TIMESTAMP}_auto_stash" || {
    log_error "git stash başarısız. Manuel olarak temizleyin."
    exit 1
  }
fi

git fetch origin "${BRANCH}" --prune
git checkout "${BRANCH}"
git reset --hard "origin/${BRANCH}"

COMMIT_HASH=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --pretty=format:'%s')
log_success "Git pull tamamlandı — commit: ${COMMIT_HASH} — ${COMMIT_MSG}"

# ── 2. npm install ─────────────────────────────────────────────
log_info "2/5 — npm install (server)"
cd "${SERVER_DIR}"

# package-lock.json varsa ci kullan (deterministik kurulum)
if [[ -f "package-lock.json" ]]; then
  npm ci --omit=dev --no-audit --prefer-offline 2>&1 || {
    log_warn "npm ci başarısız, npm install deneniyor..."
    npm install --omit=dev --no-audit
  }
else
  npm install --omit=dev --no-audit
fi

log_success "npm install tamamlandı"

# ── 3. TypeScript build ────────────────────────────────────────
log_info "3/5 — TypeScript derleme"
cd "${SERVER_DIR}"

# Eski dist'i temizle
if [[ -d "dist" ]]; then
  rm -rf dist
  log_info "Eski dist/ temizlendi"
fi

# TypeScript derle
if ! npx tsc --project tsconfig.build.json 2>&1; then
  log_error "TypeScript derleme başarısız!"
  log_error "Detaylar için: ${DEPLOY_LOG}"
  exit 1
fi

log_success "TypeScript derleme tamamlandı"

# ── 4. .env kontrolü ──────────────────────────────────────────
log_info "4/5 — Ortam değişkenleri kontrolü"
ENV_FILE="${SERVER_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  log_error ".env dosyası bulunamadı: ${ENV_FILE}"
  log_error "Örnek: cp ${SERVER_DIR}/.env.example ${ENV_FILE} && nano ${ENV_FILE}"
  exit 1
fi

# Kritik env değişkenlerini kontrol et
MISSING_VARS=()
for var in JWT_SECRET NODE_ENV; do
  if ! grep -q "^${var}=" "${ENV_FILE}"; then
    MISSING_VARS+=("${var}")
  fi
done

if [[ ${#MISSING_VARS[@]} -gt 0 ]]; then
  log_error "Eksik ortam değişkenleri: ${MISSING_VARS[*]}"
  exit 1
fi

# Redis URL uyarısı (production'da zorunlu)
if [[ "${NODE_ENV}" == "production" ]] && ! grep -q "^REDIS_URL=" "${ENV_FILE}"; then
  log_warn "REDIS_URL tanımlı değil — cluster modunda Socket.IO olayları paylaşılamaz!"
fi

log_success "Ortam değişkenleri doğrulandı"

# ── 5. PM2 reload (zero-downtime) ─────────────────────────────
log_info "5/5 — PM2 reload (zero-downtime)"
cd "${DEPLOY_DIR}"

ECOSYSTEM_FILE="${DEPLOY_DIR}/ecosystem.config.js"

if [[ ! -f "${ECOSYSTEM_FILE}" ]]; then
  log_error "ecosystem.config.js bulunamadı: ${ECOSYSTEM_FILE}"
  exit 1
fi

# PM2 uygulama çalışıyor mu kontrol et
if pm2 list | grep -q "${APP_NAME}"; then
  # Zero-downtime graceful reload
  pm2 reload "${ECOSYSTEM_FILE}" --env "${NODE_ENV}" --update-env
  log_success "PM2 reload tamamlandı (zero-downtime)"
else
  # İlk kez başlatma
  log_warn "Uygulama PM2'de bulunamadı, yeni olarak başlatılıyor..."
  pm2 start "${ECOSYSTEM_FILE}" --env "${NODE_ENV}"
  pm2 save
  log_success "PM2 ile uygulama başlatıldı ve kaydedildi"
fi

# ── Sonuç özeti ───────────────────────────────────────────────
echo ""
log_success "══════════════════════════════════════════════════"
log_success "  Deploy BAŞARILI!"
log_success "  Commit  : ${COMMIT_HASH} — ${COMMIT_MSG}"
log_success "  Branch  : ${BRANCH}"
log_success "  Env     : ${NODE_ENV}"
log_success "  Log     : ${DEPLOY_LOG}"
log_success "══════════════════════════════════════════════════"
echo ""

# PM2 durumunu göster
pm2 list

# Opsiyonel: son log satırlarını göster
log_info "Son uygulama logları:"
pm2 logs "${APP_NAME}" --lines 10 --nostream 2>/dev/null || true
