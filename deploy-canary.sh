#!/usr/bin/env bash
# deploy-canary.sh — Blue-Green / Canary Deployment (Oracle Linux / PM2 + Nginx)
#
# Kullanım:
#   bash deploy-canary.sh                      # varsayılan: yeşil slota deploy, %10 canary
#   bash deploy-canary.sh --slot green         # hedef slot
#   bash deploy-canary.sh --weight 50          # nginx canary ağırlığı (0-100)
#   bash deploy-canary.sh --promote            # canary'yi primary yap (%100)
#   bash deploy-canary.sh --rollback           # aktif slotu önceki ile değiştir
#
# Gereksinimler:
#   - PM2, Nginx yüklü
#   - infra/nginx-upstream.conf şablonu mevcut
#   - ecosystem.config.js'de bridge-blue / bridge-green tanımlı

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Yardımcı fonksiyonlar ─────────────────────────────────────
# Sprint 77 FIX: Bash fonksiyonları çağrılmadan önce tanımlanmalı.
# Önceki sürümde _update_nginx / _switch_active script sonunda tanımlanıyordu;
# set -euo pipefail ile rollback ve nginx güncelleme adımlarında
# "command not found" hatasına neden oluyordu.


_update_nginx() {
  local primary_slot="$1" primary_port="$2"
  local secondary_slot="$3" secondary_port="$4"
  local primary_weight="$5"
  local secondary_weight=$((100 - primary_weight))

  if [[ ! -f "$NGINX_UPSTREAM" ]]; then
    log_warn "Nginx upstream dosyası bulunamadı: ${NGINX_UPSTREAM} — nginx güncellenmedi."
    return 0
  fi

  cat > "$NGINX_UPSTREAM" << EOF
# Otomatik oluşturuldu — deploy-canary.sh tarafından güncellenir
# Düzenlemeyin; değişiklikler deploy sırasında üzerine yazılır.
upstream bridge_backend {
    least_conn;
    server 127.0.0.1:${primary_port}   weight=${primary_weight};   # ${primary_slot}
    server 127.0.0.1:${secondary_port} weight=${secondary_weight};  # ${secondary_slot}
    keepalive 32;
}
EOF

  if nginx -t -q 2>/dev/null; then
    nginx -s reload
    log_success "Nginx upstream güncellendi: ${primary_slot}(${primary_weight}%) + ${secondary_slot}(${secondary_weight}%)"
  else
    log_error "Nginx config hatalı — upstream güncellenmedi."
  fi
}

_switch_active() {
  local new_slot="$1"
  echo "ACTIVE_SLOT=${new_slot}" > "$STATE_FILE"
  log_info "Aktif slot: ${new_slot}"
}

# ── Parametreler ─────────────────────────────────────────────
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${DEPLOY_DIR}/.deploy-state"   # aktif slot durumu
NGINX_UPSTREAM="${DEPLOY_DIR}/infra/nginx-upstream.conf"
ECOSYSTEM_FILE="${DEPLOY_DIR}/ecosystem.config.js"

TARGET_SLOT=""
CANARY_WEIGHT=10
PROMOTE=false
ROLLBACK=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --slot)     TARGET_SLOT="$2";     shift 2 ;;
    --weight)   CANARY_WEIGHT="$2";   shift 2 ;;
    --promote)  PROMOTE=true;          shift   ;;
    --rollback) ROLLBACK=true;         shift   ;;
    *)          log_warn "Bilinmeyen argüman: $1"; shift ;;
  esac
done

# ── Mevcut durum ─────────────────────────────────────────────
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$STATE_FILE"
  CURRENT_SLOT="${ACTIVE_SLOT:-blue}"
else
  CURRENT_SLOT="blue"
fi

CURRENT_PORT=$([ "$CURRENT_SLOT" = "blue" ] && echo "3001" || echo "3002")

# ── Rollback ─────────────────────────────────────────────────
if $ROLLBACK; then
  log_info "Rollback başlıyor — aktif slot: ${CURRENT_SLOT}"
  PREV_SLOT=$([ "$CURRENT_SLOT" = "blue" ] && echo "green" || echo "blue")
  PREV_PORT=$([ "$PREV_SLOT"    = "blue" ] && echo "3001"  || echo "3002")

  if ! pm2 list | grep -q "bridge-${PREV_SLOT}"; then
    log_error "Önceki slot (bridge-${PREV_SLOT}) PM2'de bulunamadı — rollback mümkün değil."
    exit 1
  fi

  _update_nginx "$PREV_SLOT" "$PREV_PORT" "$CURRENT_SLOT" "$CURRENT_PORT" 100
  _switch_active "$PREV_SLOT"
  log_success "Rollback tamamlandı: ${CURRENT_SLOT} → ${PREV_SLOT}"
  exit 0
fi

# ── Hedef slot belirle ────────────────────────────────────────
if [[ -z "$TARGET_SLOT" ]]; then
  TARGET_SLOT=$([ "$CURRENT_SLOT" = "blue" ] && echo "green" || echo "blue")
fi

if [[ "$TARGET_SLOT" == "$CURRENT_SLOT" ]]; then
  log_warn "Hedef slot (${TARGET_SLOT}) zaten aktif — deploy atlandı."
  exit 0
fi

TARGET_PORT=$([ "$TARGET_SLOT" = "blue" ] && echo "3001" || echo "3002")
log_info "Canary deploy: ${CURRENT_SLOT}:${CURRENT_PORT} → ${TARGET_SLOT}:${TARGET_PORT} (ağırlık: ${CANARY_WEIGHT}%)"

# ── Yeni slotu başlat ────────────────────────────────────────
log_info "1/4 — bridge-${TARGET_SLOT} başlatılıyor..."
pm2 start "$ECOSYSTEM_FILE" --only "bridge-${TARGET_SLOT}" --env production

# ── Health check ─────────────────────────────────────────────
log_info "2/4 — Health check (port ${TARGET_PORT})..."
HEALTH_URL="http://127.0.0.1:${TARGET_PORT}/api/health"
MAX_TRIES=15; SLEEP=2; PASS=false

for i in $(seq 1 $MAX_TRIES); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$HEALTH_URL" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    PASS=true; break
  fi
  log_info "  Deneme ${i}/${MAX_TRIES}: HTTP ${HTTP_CODE} — ${SLEEP}s bekleniyor..."
  sleep "$SLEEP"
done

if ! $PASS; then
  log_error "Health check başarısız (${MAX_TRIES} deneme). Yeni slot durduruluyor."
  pm2 stop "bridge-${TARGET_SLOT}" 2>/dev/null || true
  exit 1
fi
log_success "Health check geçti"

# ── Nginx upstream güncelle ───────────────────────────────────
log_info "3/4 — Nginx upstream güncelleniyor (canary ağırlığı: ${CANARY_WEIGHT}%)..."
_update_nginx "$TARGET_SLOT" "$TARGET_PORT" "$CURRENT_SLOT" "$CURRENT_PORT" "$CANARY_WEIGHT"

if $PROMOTE || [[ "$CANARY_WEIGHT" -ge 100 ]]; then
  log_info "  Tam promote: %100 trafiği ${TARGET_SLOT}'a yönlendiriliyor..."
  _update_nginx "$TARGET_SLOT" "$TARGET_PORT" "$CURRENT_SLOT" "$CURRENT_PORT" 100
  _switch_active "$TARGET_SLOT"
  log_success "4/4 — ${CURRENT_SLOT} durduruluyor..."
  pm2 stop "bridge-${CURRENT_SLOT}" 2>/dev/null || true
  log_success "Canary promote tamamlandı. Aktif slot: ${TARGET_SLOT}"
else
  # Kısmi canary — hem eski hem yeni çalışıyor
  echo "ACTIVE_SLOT=${CURRENT_SLOT}" > "$STATE_FILE"
  echo "CANARY_SLOT=${TARGET_SLOT}"  >> "$STATE_FILE"
  echo "CANARY_WEIGHT=${CANARY_WEIGHT}" >> "$STATE_FILE"
  log_success "Canary aktif: %${CANARY_WEIGHT} → ${TARGET_SLOT}:${TARGET_PORT}, kalan → ${CURRENT_SLOT}:${CURRENT_PORT}"
  log_info "  Promote için: bash deploy-canary.sh --promote"
  log_info "  Geri almak:   bash deploy-canary.sh --rollback"
fi

