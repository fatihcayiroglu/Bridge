# Bridge — Production Deployment Rehberi

## ⚠️ Sprint 115 — E2EE Varsayılan Açık (Breaking Change)

Sprint 115'ten itibaren **E2EE varsayılan olarak AÇIKTIR** (`BRIDGE_E2EE_ENABLED !== 'false'`).

Eğer E2EE'yi kapatmak istiyorsanız: `BRIDGE_E2EE_ENABLED=false`

Mevcut deploymentlar için migration adımları → [ADR-0013](docs/ADR-0013-sprint115-production-readiness.md)

---


> Sprint 50 ile eklendi. Bu rehber güvenli, production-ready bir Bridge kurulumu için
> gereken tüm adımları kapsar.

---

## İçindekiler

1. [Zorunlu Ön Koşullar](#zorunlu-ön-koşullar)
2. [Güvenli Secret Yönetimi](#güvenli-secret-yönetimi)
3. [İlk Kurulum Adımları](#ilk-kurulum-adımları)
4. [Rate Limit Davranışı](#rate-limit-davranışı)
5. [Ağ Güvenliği — DNS Rebinding & Egress](#ağ-güvenliği--dns-rebinding--egress)
6. [SSRF Koruması Sınırları](#ssrf-koruması-sınırları)
7. [Egress Firewall (iptables / nftables)](#egress-firewall-iptables--nftables)
8. [Reverse Proxy (Nginx / Caddy)](#reverse-proxy-nginx--caddy)
9. [TLS / HTTPS](#tls--https)
10. [Yedekleme](#yedekleme)
11. [Güncelleme](#güncelleme)
12. [Güvenlik Kontrol Listesi](#güvenlik-kontrol-listesi)

---

## Zorunlu Ön Koşullar

| Araç | Minimum Versiyon |
|------|-----------------|
| Docker | 24.x |
| Docker Compose | v2.20+ |
| Sunucu RAM | 1 GB (önerilen 2 GB+) |
| İşletim Sistemi | Ubuntu 22.04+ / Debian 12+ |

---

## Güvenli Secret Yönetimi

### Asla yapılmaması gerekenler

- `JWT_SECRET` veya `REFRESH_SECRET` için kısa, tahmin edilebilir değer kullanmak
- `POSTGRES_PASSWORD` için varsayılan veya boş değer bırakmak
- Secret'ları `Dockerfile` içinde `ARG` / `ENV` olarak tanımlamak (image layer'a sızar)
- Secret'ları Git'e commit etmek

### Doğru yaklaşım: `.env` dosyası (tek sunucu)

```bash
# 1. .env dosyası oluştur (Docker Compose)
cp .env.docker .env

# 2. Güvenli rastgele değerler üret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# → JWT_SECRET için kopyala
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# → REFRESH_SECRET için kopyala
openssl rand -hex 32
# → POSTGRES_PASSWORD için kopyala

# 3. .env'i düzenle
nano .env
```

`.env` örneği (minimum zorunlu alanlar):

```env
JWT_SECRET=buraya_en_az_64_karakter_rastgele_hex
REFRESH_SECRET=buraya_baska_en_az_64_karakter_rastgele_hex
POSTGRES_PASSWORD=buraya_en_az_32_karakter_rastgele_hex

# Opsiyonel ama önerilir
INSTANCE_URL=https://bridge.senindomain.com
ALLOWED_ORIGINS=https://bridge.senindomain.com
```

```bash
# .env dosyasını yalnızca sahibi okuyabilsin
chmod 600 .env
```

### Docker Secrets (swarm / production gelişmiş)

```bash
# Secret oluştur
echo "super_secret_value" | docker secret create jwt_secret -

# compose'da kullan (docker-compose.cluster.yml'e ekle)
secrets:
  jwt_secret:
    external: true
```

---

## İlk Kurulum Adımları

```bash
# 1. Repository
git clone https://github.com/bridge-app/bridge.git
cd bridge

# 2. .env dosyasını oluştur ve doldur (yukarıya bak)
cp .env.docker .env
nano .env

# 3. Servisleri başlat
docker compose up -d

# 4. İlk kullanıcı = otomatik admin
# Tarayıcıdan http://localhost:3001 → kayıt ol
```

> **Not:** `JWT_SECRET`, `REFRESH_SECRET` veya `POSTGRES_PASSWORD` eksikse
> `docker compose up` hata verir ve başlamaz. Bu kasıtlı bir güvenlik mekanizmasıdır.

---

## Rate Limit Davranışı

Bridge'in rate limiter (`server/middleware/rateLimit.ts`) dört strateji kullanır:

| Strateji | Key | Kullanıldığı endpoint'ler |
|---|---|---|
| `_ip` | IP adresi | login, register, 2FA |
| `_u` | User ID | upload, messages, AI |
| `_c` | IP + User ID | çoğu authenticated endpoint |
| `_uip` | Per-user-IP | moderation, AI (VPN dönüşüm engeli) |

**Otomatik IP ban:** Bir IP, ihlal eşiğini (`RL_*_MAX` değerinin 3 katı) aşarsa
`server/middleware/ipBan.ts` devreye girer ve o IP'yi geçici olarak engeller.
Ban süresi `IP_BAN_DURATION_MS` env değişkeni ile yapılandırılır (varsayılan: 1 saat).

**Özelleştirme:** Tüm rate limit değerleri env değişkenleriyle override edilebilir:

```env
RL_LOGIN_MAX=5          # dakikada max login denemesi
RL_LOGIN_WIN=60000      # pencere süresi (ms)
RL_MESSAGES_MAX=20      # dakikada max mesaj
RL_AI_MAX=5             # dakikada max AI isteği
```

---

## Ağ Güvenliği — DNS Rebinding & Egress

### Sorun: SSRF korumasının sınırı

Bridge'in `server/lib/fetch.ts` modülü, dış HTTP isteklerini (link önizleme,
federasyon, AI API çağrıları) private IP aralıklarına karşı filtreler.
Ancak bu filtre **hostname bazlıdır** — DNS çözümlemesi yapılmadan önce uygulanır.

**DNS rebinding saldırısı senaryosu:**

```
1. Saldırgan kötü niyetli bir domain kaydeder: evil.attacker.com
2. DNS kaydı başlangıçta public bir IP gösterir → SSRF filtresi geçer
3. Kısa TTL ile DNS kaydı 192.168.1.1 gibi bir private IP'ye değiştirilir
4. Sunucu tekrar fetch yaptığında aynı domain artık iç ağa istek atar
```

Bu saldırı tipi, yalnızca hostname kontrolüyle **tam olarak engellenemez.**

### Çözüm 1: Egress Firewall (önerilir — iptables)

Bridge container'ından private IP aralıklarına giden trafiği engelle:

```bash
# /etc/bridge-egress.sh olarak kaydet, boot'ta çalıştır

#!/bin/bash
# Bridge container egress — private IP'lere çıkış engeli
# Container subnet'ini bul (genellikle 172.17.0.0/16)
BRIDGE_SUBNET=$(docker inspect bridge-server \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  | head -1 | sed 's/\.[0-9]*$/\.0\/24/')

# Private IPv4 aralıkları — RFC 1918 + cloud metadata
PRIVATE_RANGES=(
  "10.0.0.0/8"
  "172.16.0.0/12"
  "192.168.0.0/16"
  "127.0.0.0/8"
  "169.254.0.0/16"    # AWS metadata: 169.254.169.254
  "100.64.0.0/10"     # CGNAT
)

for range in "${PRIVATE_RANGES[@]}"; do
  iptables -I DOCKER-USER -s "$BRIDGE_SUBNET" -d "$range" -j DROP
  ip6tables -I DOCKER-USER -s "$BRIDGE_SUBNET" -d "::1/128" -j DROP
  ip6tables -I DOCKER-USER -s "$BRIDGE_SUBNET" -d "fc00::/7" -j DROP
  ip6tables -I DOCKER-USER -s "$BRIDGE_SUBNET" -d "fe80::/10" -j DROP
done

echo "Bridge egress firewall aktif."
```

```bash
chmod +x /etc/bridge-egress.sh
# systemd ile boot'ta çalıştır:
# /etc/systemd/system/bridge-egress.service oluştur (aşağıya bak)
```

`/etc/systemd/system/bridge-egress.service`:

```ini
[Unit]
Description=Bridge Egress Firewall
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/etc/bridge-egress.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable bridge-egress
systemctl start bridge-egress
```

### Çözüm 2: Egress Firewall (nftables — modern Linux)

```nft
# /etc/nftables.d/bridge-egress.nft

table inet bridge_egress {
  chain output {
    type filter hook output priority 0; policy accept;

    # Bridge container subnet → private IP'lere çıkış engeli
    ip saddr 172.17.0.0/16 ip daddr {
      10.0.0.0/8,
      172.16.0.0/12,
      192.168.0.0/16,
      127.0.0.0/8,
      169.254.0.0/16,
      100.64.0.0/10
    } drop

    ip6 saddr fd00::/8 ip6 daddr {
      ::1/128,
      fc00::/7,
      fe80::/10
    } drop
  }
}
```

```bash
nft -f /etc/nftables.d/bridge-egress.nft
```

### Çözüm 3: DNS-level koruma (önerilir ek katman olarak)

```bash
# Unbound veya CoreDNS ile private-address doğrulama
# Unbound örneği (/etc/unbound/unbound.conf.d/bridge.conf):

server:
  # Yanıt olarak dönen private IP'leri reddet (DNS rebinding önlemi)
  private-address: 10.0.0.0/8
  private-address: 172.16.0.0/12
  private-address: 192.168.0.0/16
  private-address: 127.0.0.0/8
  private-address: 169.254.0.0/16
  private-address: ::1/128
  private-address: fc00::/7
  private-address: fe80::/10
```

---

## SSRF Koruması Sınırları

`server/lib/fetch.ts` şu özelliklere sahiptir:

- ✅ Private IPv4 aralıkları hostname bazlı engeller (RFC 1918, link-local, CGNAT, metadata)
- ✅ Private IPv6 aralıkları engeller (loopback, ULA, link-local, mapped)
- ✅ `SSRF_ALLOWLIST` env ile güvenilir hostname'ler whitelist'e eklenebilir
- ✅ Timeout (varsayılan 10 sn) ve User-Agent header'ı ekler
- ⚠️ DNS çözümü sonrası IP kontrolü yapmaz — egress firewall ile tamamlanmalıdır
- ⚠️ IPv6-in-IPv4 (6to4, Teredo) tunnel'ları tam engellenmeyebilir

**Sonuç:** `lib/fetch.ts` + egress iptables birlikte kullanıldığında production için
yeterli koruma sağlar.

---

## Reverse Proxy (Nginx / Caddy)

### Caddy (önerilen — otomatik TLS)

```caddyfile
# /etc/caddy/Caddyfile
bridge.senindomain.com {
    reverse_proxy localhost:3001

    # WebSocket desteği (Socket.IO için zorunlu)
    @websockets {
        header Connection *Upgrade*
        header Upgrade    websocket
    }
    reverse_proxy @websockets localhost:3001

    # Güvenlik başlıkları
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Frame-Options            "DENY"
        X-Content-Type-Options     "nosniff"
        Referrer-Policy            "strict-origin-when-cross-origin"
        Content-Security-Policy    "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss:;"
        Permissions-Policy         "camera=(), microphone=(), geolocation=()"
        -Server
    }
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name bridge.senindomain.com;

    ssl_certificate     /etc/letsencrypt/live/bridge.senindomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.senindomain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384;

    # WebSocket (Socket.IO)
    location /socket.io/ {
        proxy_pass         http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        proxy_pass         http://localhost:3001;
        proxy_set_header   Host               $host;
        proxy_set_header   X-Real-IP          $remote_addr;
        proxy_set_header   X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto  $scheme;

        # Güvenlik başlıkları
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Frame-Options           "DENY"                                always;
        add_header X-Content-Type-Options    "nosniff"                             always;
        add_header Referrer-Policy           "strict-origin-when-cross-origin"     always;
    }
}

server {
    listen 80;
    server_name bridge.senindomain.com;
    return 301 https://$host$request_uri;
}
```

> Bridge'in rate limiter'ı doğru IP adresini okuyabilmesi için
> `TRUSTED_PROXY_COUNT=1` env değişkenini ayarla (tek nginx arkasında).

---

## TLS / HTTPS

```bash
# Let's Encrypt (Certbot)
apt install certbot python3-certbot-nginx
certbot --nginx -d bridge.senindomain.com

# Otomatik yenileme
systemctl enable certbot.timer
```

---

## Yedekleme

Backup servisi docker-compose.yml'de tanımlıdır. Her gece 02:30'da çalışır.

```bash
# Manuel yedek al
docker compose exec backup backup.sh

# Yedekleri listele
ls -lh /var/lib/bridge-backups/postgres/

# Geri yükle
docker compose exec -T postgres psql -U bridge bridge \
  < /var/lib/bridge-backups/postgres/bridge_20260501_023000.sql
```

---

## Güncelleme

### Docker Compose (basit, kısa kesinti var)

```bash
git pull

# Image yeniden build et ve servisi yeniden başlat
docker compose build bridge
docker compose up -d bridge

# Migration gerekiyorsa (otomatik çalışır index.ts başlangıcında)
# Manuel migration:
docker compose exec bridge node server/dist/db/migrate-postgres.js
```

> ⚠️ `docker compose up -d --build` yaklaşımı production'da **kısa kesintiye** (1-3 sn) neden olur.
> Sıfır kesinti için aşağıdaki PM2 yöntemini kullan.

---

### PM2 ile Sıfır-Kesintili Güncelleme (önerilen)

`ecosystem.config.js`'deki `wait_ready` + `graceful_timeout` kombinasyonu PM2'nin
`reload` komutunu rolling restart'a dönüştürür: yeni instance hazır olana kadar
eski instance istekleri almaya devam eder.

**Ön koşul:** `server/index.ts`'te uygulama başladığında `process.send('ready')` çağrısı
yapılmalı (PM2 cluster modunda bu sinyal beklenilir).

```typescript
// server/index.ts — http.listen callback'inde
httpServer.listen(PORT, () => {
  logger.info(`Bridge ${PORT} portunda çalışıyor`);
  if (process.send) process.send('ready'); // PM2 reload sinyali
});
```

**Güncelleme prosedürü:**

```bash
# 1. Kodu çek
git pull

# 2. Derle (PM2 hâlâ eski build'i serve ediyor)
npm run build --workspace=server

# 3. Sıfır-kesintili reload
pm2 reload ecosystem.config.js --only bridge

# 4. Migration gerekiyorsa (build sonrası, reload öncesi çalıştır)
node server/dist/db/migrate-postgres.js

# 5. Durumu doğrula
pm2 status
pm2 logs bridge --lines 50
```

**Nasıl çalışır:**
1. PM2, cluster'daki her worker'a sırayla `SIGINT` gönderir
2. Worker yeni bağlantı almayı bırakır, mevcut istekleri tamamlar (`graceful_timeout: 10000 ms`)
3. Yeni worker başlar, `process.send('ready')` bekler (`listen_timeout: 15000 ms`)
4. Yeni worker hazır → sıradaki eski worker kapatılır
5. Tüm worker'lar dönünceye kadar tekrar eder — hiç kesinti olmaz

**HAProxy ile Manuel Canary (tek VPS, ek güvenlik):**

```bash
# haproxy/haproxy.cfg'de iki backend tanımlıysa:
# backend bridge_blue  → port 3001
# backend bridge_green → port 3002

# 1. Green'i yeni build ile başlat
PORT=3002 pm2 start ecosystem.config.js --only bridge-green

# 2. HAProxy'yi green'e geçir (sıfır kesinti)
echo "set server bridge_backend/green weight 100" |   socat stdio /run/haproxy/admin.sock
echo "set server bridge_backend/blue weight 0" |   socat stdio /run/haproxy/admin.sock

# 3. Blue'yu durdur
pm2 stop bridge-blue

# Sorun çıkarsa geri al:
echo "set server bridge_backend/blue weight 100" |   socat stdio /run/haproxy/admin.sock
echo "set server bridge_backend/green weight 0" |   socat stdio /run/haproxy/admin.sock
```

---

## Güvenlik Kontrol Listesi

Canlıya almadan önce aşağıdakileri kontrol et:

- [ ] `JWT_SECRET` en az 64 karakter rastgele hex
- [ ] `REFRESH_SECRET` en az 64 karakter rastgele hex, JWT_SECRET'tan farklı
- [ ] `POSTGRES_PASSWORD` en az 32 karakter rastgele hex
- [ ] `.env` dosyası `chmod 600` ile korunuyor
- [ ] `.env` `.gitignore`'da (commit edilmemeli)
- [ ] `ALLOWED_ORIGINS` production domain'e ayarlı (`http://localhost:3001` değil)
- [ ] `NODE_ENV=production` set edilmiş
- [ ] PostgreSQL 5432 portu dış dünyaya kapalı (docker-compose.yml'de expose yok ✅)
- [ ] Redis 6379 portu dış dünyaya kapalı (docker-compose.yml'de expose yok ✅)
- [ ] Reverse proxy arkasında HTTPS aktif
- [ ] `TRUSTED_PROXY_COUNT` doğru set edilmiş (nginx arkasında: `1`)
- [ ] Egress firewall aktif (bkz. [Egress Firewall](#egress-firewall-iptables--nftables))
- [ ] `INSTANCE_URL` production URL'sine ayarlı (federasyon için)
- [ ] `FEDERATION_SECRET` güçlü rastgele değer (federasyon kullanılıyorsa)
- [ ] Backup servisi çalışıyor: `docker compose ps backup`
- [ ] Health endpoint erişilebilir: `curl https://bridge.senindomain.com/api/health`

---

## CDN & Medya Depolama

> Sprint 63'te `.env.example` güncellendi. Bu bölüm eksik olan
> deployment adımlarını tamamlar.

Bridge dört depolama backend'ini destekler: `local`, `r2`, `minio`, `s3`.
`CDN_PROVIDER` ortam değişkeni ile seçilir. Varsayılan `local`'dir.

### Local (Varsayılan)

Dosyalar sunucu diskinde saklanır. Tek sunucu kurulumlarında yeterlidir.
Ölçekleme veya sunucu geçişi gerektiğinde başka bir backend'e geçin.

```env
CDN_PROVIDER=local
# CDN_LOCAL_PATH=/data/uploads  # varsayılan: process.cwd()/uploads
```

**Avantaj:** Sıfır ek servis, kurulum yok.
**Dezavantaj:** Birden fazla sunucu örneği çalıştırırken dosyalar paylaşılamaz.

---

### Cloudflare R2 (Önerilen — Production)

R2; egress ücreti olmayan S3-uyumlu nesne depolama servisidir.

#### 1. R2 Bucket Oluştur

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → R2 → **Create bucket**
2. Bucket adı: `bridge-uploads` (veya tercih ettiğin isim)
3. Bölge: otomatik (global CDN)

#### 2. API Token Üret

1. Cloudflare Dashboard → **Manage Account** → API Tokens → Create Token
2. "Edit Cloudflare Workers" şablonunu kullan veya özel:
   - Permission: **R2: Edit**
   - Account Resources: hesabın
3. **Account ID**'yi not al (Dashboard sağ üst)

#### 3. CORS Ayarla (gerekirse)

Bucket Settings → CORS Policy:

```json
[
  {
    "AllowedOrigins": ["https://bridge.senindomain.com"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

#### 4. `.env` Yapılandırması

```env
CDN_PROVIDER=r2
R2_ACCOUNT_ID=abc123def456...      # Cloudflare Account ID
S3_BUCKET=bridge-uploads
S3_ACCESS_KEY_ID=your_r2_api_key
S3_SECRET_ACCESS_KEY=your_r2_secret
S3_REGION=auto
# S3_ENDPOINT otomatik: https://<account_id>.r2.cloudflarestorage.com
```

#### 5. Özel Domain (Opsiyonel)

R2 bucket → Settings → Custom Domain → `media.senindomain.com`

```env
CDN_PUBLIC_URL=https://media.senindomain.com
```

---

### MinIO (Self-Hosted)

MinIO; sunucunda çalışan S3-uyumlu nesne depodur. Tam kontrol ve
egress ücreti yok; ek bakım gerektirir.

#### Docker Compose ile MinIO Ekle

`docker-compose.yml`'e ekle:

```yaml
  minio:
    image: minio/minio:RELEASE.2024-01-01T00-00-00Z
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER:     ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - minio_data:/data
    ports:
      - "127.0.0.1:9000:9000"   # API — yalnızca localhost
      - "127.0.0.1:9001:9001"   # Console — yalnızca localhost
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  minio_data:
```

#### Bucket Oluştur

```bash
# MinIO Client (mc) ile:
docker run --rm --network bridge_default \
  minio/mc alias set bridge http://minio:9000 minioadmin "$MINIO_ROOT_PASSWORD"
docker run --rm --network bridge_default \
  minio/mc mb bridge/bridge-uploads
docker run --rm --network bridge_default \
  minio/mc anonymous set download bridge/bridge-uploads  # public read (opsiyonel)
```

#### `.env` Yapılandırması

```env
CDN_PROVIDER=minio
S3_ENDPOINT=http://minio:9000     # Docker compose içinde servis adı
S3_BUCKET=bridge-uploads
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=your_strong_password_here
S3_REGION=us-east-1               # MinIO için rastgele değer kabul eder
CDN_PUBLIC_URL=https://media.senindomain.com  # nginx proxy varsa

MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=guclu_bir_sifre_en_az_32_karakter
```

#### Nginx Proxy (Public URL için)

```nginx
server {
    listen 443 ssl;
    server_name media.senindomain.com;

    ssl_certificate     /etc/letsencrypt/live/media.senindomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/media.senindomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 100m;
    }
}
```

---

### AWS S3

#### Bucket & IAM

1. S3 → Create bucket → **Block all public access** (bridge kendi imzalı URL üretir)
2. IAM → User → Attach policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::bridge-uploads",
        "arn:aws:s3:::bridge-uploads/*"
      ]
    }
  ]
}
```

3. IAM → User → Access Keys → Create access key (Application access)

#### `.env` Yapılandırması

```env
CDN_PROVIDER=s3
S3_BUCKET=bridge-uploads
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_REGION=eu-central-1
# S3_ENDPOINT bırakılırsa AWS varsayılan endpoint kullanılır
```

#### CloudFront CDN (Opsiyonel)

1. CloudFront → Create Distribution → Origin: S3 bucket
2. Origin Access Control (OAC) kur — public access kapalı kalır
3. `.env`'e ekle:

```env
CDN_PUBLIC_URL=https://d1234abcde.cloudfront.net
```

---

### Depolama Geçişi (local → cloud)

Mevcut `uploads/` klasöründen nesne depoya geçmek için:

```bash
# R2 örneği — mc (MinIO Client) tüm S3-uyumlu servisleri destekler
docker run --rm -v ./uploads:/data minio/mc \
  alias set r2 https://<account_id>.r2.cloudflarestorage.com \
  $S3_ACCESS_KEY_ID $S3_SECRET_ACCESS_KEY

docker run --rm -v ./uploads:/data minio/mc \
  mirror /data r2/bridge-uploads --overwrite

# Sonra .env'de CDN_PROVIDER=r2 yap ve yeniden başlat
docker compose restart bridge
```

---

### Güvenlik Kontrol Listesi — CDN

- [ ] `S3_SECRET_ACCESS_KEY` `.env`'de, `.gitignore`'da
- [ ] `MINIO_ROOT_PASSWORD` en az 32 karakter (MinIO kullanılıyorsa)
- [ ] MinIO console (9001) dış dünyaya **kapalı** (yalnızca 127.0.0.1)
- [ ] R2 / S3 bucket doğrudan public erişim kapalı (`Block public access` aktif)
- [ ] `CDN_PUBLIC_URL` production domain'ine ayarlı (localhost değil)
- [ ] Upload boyut limiti `MAX_UPLOAD_SIZE_MB` ile sınırlandırılmış
- [ ] Dosya tipi whitelist aktif (sadece izin verilen MIME type'lar)

