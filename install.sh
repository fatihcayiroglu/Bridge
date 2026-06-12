#!/usr/bin/env bash
# install.sh — Bridge Tek Komut Kurulum
# Kullanım: bash install.sh
# Gereksinim: Ubuntu/Debian 20.04+ veya RHEL/Oracle Linux 8+, root veya sudo yetkisi
set -euo pipefail

# ── Renkler ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}▸${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✗${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${NC}"; }

# ── Yardımcılar ───────────────────────────────────────────────────────────────
gen_secret() { openssl rand -hex 64; }

detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "$ID"
  else
    echo "unknown"
  fi
}

command_exists() { command -v "$1" &>/dev/null; }

get_public_ip() {
  curl -sf --max-time 5 https://api.ipify.org \
    || curl -sf --max-time 5 https://checkip.amazonaws.com \
    || echo ""
}

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo -e "${BOLD}"
echo "  ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗"
echo "  ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝"
echo "  ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  "
echo "  ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  "
echo "  ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗"
echo "  ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝"
echo -e "${NC}"
echo "  Gerçek zamanlı chat — Tek komut kurulum"
echo "  ─────────────────────────────────────────"
echo ""

# ── Root kontrolü ─────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  error "Bu script root yetkisiyle çalıştırılmalı."
  echo "  Tekrar dene: sudo bash install.sh"
  exit 1
fi

# ── Kurulum dizini ────────────────────────────────────────────────────────────
INSTALL_DIR="${BRIDGE_DIR:-/opt/bridge}"
DATA_DIR="/var/lib/bridge"

# ── Kullanıcıdan bilgi al ─────────────────────────────────────────────────────
header "1/6 — Yapılandırma"

# Public IP otomatik bul
PUBLIC_IP=$(get_public_ip)

echo ""
echo "  Sunucunun dışarıdan erişilebilir adresi nedir?"
echo "  (Domain varsa örn: chat.example.com — yoksa IP ile devam et)"
echo ""
if [ -n "$PUBLIC_IP" ]; then
  read -rp "  Adres [$PUBLIC_IP]: " USER_HOST
  HOST="${USER_HOST:-$PUBLIC_IP}"
else
  read -rp "  Adres: " HOST
  if [ -z "$HOST" ]; then
    error "Adres boş olamaz."
    exit 1
  fi
fi

# HTTP mi HTTPS mi?
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # IP adresi — SSL olamaz
  PROTOCOL="http"
  SSL=false
else
  # Domain — SSL sor
  echo ""
  read -rp "  Let's Encrypt SSL kur? (önerilen) [E/h]: " SSL_CHOICE
  if [[ "${SSL_CHOICE,,}" == "h" || "${SSL_CHOICE,,}" == "n" ]]; then
    PROTOCOL="http"
    SSL=false
  else
    PROTOCOL="https"
    SSL=true
  fi
fi

BASE_URL="${PROTOCOL}://${HOST}"

echo ""
read -rp "  Port [3001]: " USER_PORT
PORT="${USER_PORT:-3001}"

echo ""
echo "  ─────────────────────────────────────────"
echo "  Bridge şu adreste erişilebilir olacak:"
echo -e "  ${BOLD}${BASE_URL}:${PORT}${NC}"
echo "  ─────────────────────────────────────────"
echo ""
read -rp "  Devam edilsin mi? [E/h]: " CONFIRM
if [[ "${CONFIRM,,}" == "h" || "${CONFIRM,,}" == "n" ]]; then
  echo "İptal edildi."
  exit 0
fi

# ── Docker kurulumu ───────────────────────────────────────────────────────────
header "2/6 — Docker"

OS=$(detect_os)

install_docker() {
  info "Docker kuruluyor ($OS)..."
  case "$OS" in
    ubuntu|debian)
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl gnupg lsb-release
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/$OS/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/$OS \
        $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    ol|rhel|centos|fedora|rocky|almalinux)
      dnf config-manager --add-repo \
        https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || \
      yum-config-manager --add-repo \
        https://download.docker.com/linux/centos/docker-ce.repo
      dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin \
        || yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    *)
      error "Desteklenmeyen OS: $OS"
      error "Docker'ı kendin kur: https://docs.docker.com/engine/install/"
      exit 1
      ;;
  esac
  systemctl enable --now docker
  success "Docker kuruldu: $(docker --version)"
}

if command_exists docker && docker compose version &>/dev/null; then
  success "Docker mevcut: $(docker --version)"
else
  install_docker
fi

# ── Kurulum dizinini hazırla ──────────────────────────────────────────────────
header "3/6 — Dizin Yapısı"

mkdir -p "$INSTALL_DIR" "$DATA_DIR/postgres" "$DATA_DIR/redis" \
         "$DATA_DIR/uploads" "$DATA_DIR/backups" "$INSTALL_DIR/logs"

# Script'in çalıştığı dizindeki dosyaları kopyala (veya mevcut dizini kullan)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  cp "$SCRIPT_DIR/docker-compose.yml" "$INSTALL_DIR/"
  [ -f "$SCRIPT_DIR/Dockerfile" ] && cp -r "$SCRIPT_DIR"/* "$INSTALL_DIR/" 2>/dev/null || true
  success "Proje dosyaları kopyalandı → $INSTALL_DIR"
else
  error "docker-compose.yml bulunamadı. install.sh'ı proje kökünden çalıştır."
  exit 1
fi

# ── .env üret ─────────────────────────────────────────────────────────────────
header "4/6 — Ortam Değişkenleri"

ENV_FILE="$INSTALL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  warn ".env zaten mevcut — üzerine yazılmıyor."
  warn "Sıfırlamak için: rm $ENV_FILE && bash install.sh"
else
  info "Güvenli secret'lar üretiliyor..."

  JWT_SECRET=$(gen_secret)
  REFRESH_SECRET=$(gen_secret)
  POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-32)

  cat > "$ENV_FILE" << EOF
# Bridge — Otomatik Oluşturuldu ($(date '+%Y-%m-%d %H:%M:%S'))
# !! Bu dosyayı kimseyle paylaşma !!

# ── Zorunlu ───────────────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}
REFRESH_SECRET=${REFRESH_SECRET}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# ── Erişim ────────────────────────────────────────────────────
ALLOWED_ORIGINS=${BASE_URL}:${PORT}
WEBAUTHN_RP_ID=${HOST}
WEBAUTHN_RP_NAME=Bridge
WEBAUTHN_ORIGIN=${BASE_URL}:${PORT}

# ── Mediasoup (grup sesli görüşme) ────────────────────────────
# IP ise otomatik dolduruldu, domain ise kendin gir:
MEDIASOUP_ANNOUNCED_IP=${PUBLIC_IP:-}
MEDIASOUP_RTC_MIN_PORT=40000
MEDIASOUP_RTC_MAX_PORT=49999
MEDIASOUP_WORKERS=1

# ── Yedekleme ─────────────────────────────────────────────────
BACKUP_KEEP_DAYS=7

# ── Opsiyonel — İstersen doldur ───────────────────────────────
# GROQ_API_KEY=
# GEMINI_API_KEY=
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=
# VAPID_PUBLIC_KEY=
# VAPID_PRIVATE_KEY=
EOF

  chmod 600 "$ENV_FILE"
  success ".env oluşturuldu (secret'lar otomatik üretildi)"
fi

# ── docker-compose.yml'i porta göre güncelle ──────────────────────────────────
if [ "$PORT" != "3001" ]; then
  sed -i "s/\"3001:3001\"/\"${PORT}:3001\"/" "$INSTALL_DIR/docker-compose.yml"
fi

# ── SSL — Let's Encrypt ───────────────────────────────────────────────────────
if [ "$SSL" = true ]; then
  header "5/6 — SSL (Let's Encrypt)"

  if ! command_exists certbot; then
    info "Certbot kuruluyor..."
    case "$OS" in
      ubuntu|debian) apt-get install -y -qq certbot ;;
      *) dnf install -y certbot || yum install -y certbot ;;
    esac
  fi

  # 80 portunu geçici olarak dinleyecek basit standalone mod
  info "Sertifika alınıyor: $HOST"
  certbot certonly --standalone \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    -d "$HOST" \
    && SSL_OK=true || SSL_OK=false

  if [ "$SSL_OK" = true ]; then
    success "SSL sertifikası alındı"
    # Nginx konfigürasyonu oluştur
    mkdir -p "$INSTALL_DIR/nginx"
    cat > "$INSTALL_DIR/nginx/bridge.conf" << NGINX
server {
    listen 80;
    server_name ${HOST};
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    server_name ${HOST};
    ssl_certificate     /etc/letsencrypt/live/${HOST}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${HOST}/privkey.pem;
    location / {
        proxy_pass http://bridge:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
NGINX
    # docker-compose.yml'de nginx servisini etkinleştir
    warn "SSL için nginx servisini docker-compose.yml'den manuel uncomment et."
    warn "Sertifika yolu: /etc/letsencrypt/live/${HOST}/"
  else
    warn "SSL alınamadı — HTTP ile devam ediliyor."
    PROTOCOL="http"
    BASE_URL="http://${HOST}"
  fi
else
  header "5/6 — SSL"
  info "SSL atlandı (IP ile kurulum)"
fi

# ── Servisleri başlat ─────────────────────────────────────────────────────────
header "6/6 — Başlatılıyor"

cd "$INSTALL_DIR"

info "Image'lar indiriliyor / derleniyor (ilk kurulumda 3-5 dk sürebilir)..."
docker compose up -d --build

# Health check bekle
info "Servisin ayağa kalkması bekleniyor..."
TRIES=0
MAX_TRIES=30
until curl -sf "http://localhost:${PORT}/api/health" &>/dev/null; do
  TRIES=$((TRIES + 1))
  if [ $TRIES -ge $MAX_TRIES ]; then
    error "Servis ${MAX_TRIES} denemede ayağa kalkmadı."
    error "Logları incele: docker compose logs bridge"
    exit 1
  fi
  sleep 3
done

# ── Özet ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ══════════════════════════════════════════════════"
echo "  ✓  Bridge başarıyla kuruldu!"
echo "  ══════════════════════════════════════════════════"
echo -e "${NC}"
echo -e "  🌐  Adres   : ${BOLD}${BASE_URL}:${PORT}${NC}"
echo -e "  📁  Dizin   : ${INSTALL_DIR}"
echo -e "  🔑  Env     : ${ENV_FILE}"
echo ""
echo "  Yararlı komutlar:"
echo "    docker compose -f $INSTALL_DIR/docker-compose.yml logs -f     # Loglar"
echo "    docker compose -f $INSTALL_DIR/docker-compose.yml restart      # Yeniden başlat"
echo "    docker compose -f $INSTALL_DIR/docker-compose.yml down         # Durdur"
echo ""
echo "  Güncelleme:"
echo "    cd $INSTALL_DIR && docker compose pull && docker compose up -d --build"
echo ""
