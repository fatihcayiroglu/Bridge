# Deployment Guide

## Gereksinimler

| Bileşen | Minimum | Önerilen |
|---------|---------|----------|
| Node.js | 22+ | 22 LTS |
| RAM | 512 MB | 2 GB |
| Disk | 5 GB | 20 GB |
| OS | Linux/macOS | Ubuntu 22.04 |

---

## 1. Ortam Değişkenleri

### Zorunlu

```env
JWT_SECRET=<en az 64 karakterlik rastgele string>
REFRESH_SECRET=<farklı, en az 64 karakterlik rastgele string>
```

Secret üret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Veritabanı (PostgreSQL — zorunlu)

> **Not:** SQLite desteği Sprint 30'da kaldırıldı. Bridge artık yalnızca PostgreSQL kullanır.

```env
# PostgreSQL bağlantı adresi (zorunlu)
DATABASE_URL=postgresql://bridge:sifre@localhost:5432/bridge

# Redis (yatay ölçekleme + rate limiting cache — şiddetle önerilir)
REDIS_URL=redis://localhost:6379
```

### Diğer

```env
PORT=3001
NODE_ENV=production
INSTANCE_NAME=Bridge
INSTANCE_URL=https://bridge.senindomain.com
ALLOWED_ORIGINS=https://bridge.senindomain.com
MAX_FILE_SIZE_MB=2048
LOG_LEVEL=info
```

---

## 2. Kurulum

```bash
cd server
npm install --omit=dev
cp server/.env.example server/.env
# .env'i yukarıdaki değerlerle doldur
```

---

## 3. Veritabanı Migration

```bash
npm run db:migrate:pg
```

Migration durumu:
```bash
npm run db:migrate:pg:status
```

**Federasyon aktifse** — AP private key şifreleme migration'ı da çalıştır:
```bash
# 1. SQL migration
psql -d bridge -f server/db/migrations_pg/008_encrypt_ap_private_keys.sql
# 2. Mevcut verileri şifrele (AP_ENCRYPTION_KEY set edilmiş olmalı)
AP_ENCRYPTION_KEY=<64-hex> node server/scripts/encrypt-ap-keys.js
```

---

## 4. Sunucuyu Başlat

```bash
npm start
```

Production'da process manager kullanmak önerilir:

```bash
# PM2 ile
npm install -g pm2
pm2 start index.js --name bridge
pm2 save && pm2 startup
```

---

## 5. Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl http2;
    server_name bridge.senindomain.com;

    ssl_certificate     /etc/letsencrypt/live/bridge.senindomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.senindomain.com/privkey.pem;

    # WebSocket desteği
    location / {
        proxy_pass         http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}

server {
    listen 80;
    server_name bridge.senindomain.com;
    return 301 https://$host$request_uri;
}
```

**Proxy arkasında `TRUSTED_PROXY_COUNT` ayarla:**
```env
TRUSTED_PROXY_COUNT=1
```

---

## 6. Docker ile

```bash
cp .env.docker .env
# .env'deki JWT_SECRET ve REFRESH_SECRET'ı doldur

docker compose up -d

# Güncelleme
git pull
docker compose build bridge
docker compose up -d bridge
```

**Çok instance (yatay ölçekleme):**
```bash
docker compose -f docker-compose.cluster.yml up -d
```
Redis gerektirir.

---

## 7. Health Probes

| Endpoint | Açıklama | Kullanım |
|----------|----------|---------|
| `GET /api/health` | Genel durum | Docker HEALTHCHECK |
| `GET /api/health/live` | Process canlı mı? | Kubernetes liveness |
| `GET /api/health/ready` | DB bağlantısı var mı? | Kubernetes readiness |
| `GET /api/health/stats` | Detaylı metrikler | Sadece internal IP |

---

## 8. Monitoring

Prometheus + Grafana kurulumu için:

```bash
cd monitoring
docker compose up -d
```

- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000 (admin/admin)

Metrik endpoint: `GET /api/metrics` (Prometheus formatı)

Uyarı kuralları: `monitoring/rules/bridge_alerts.yml`

---

## 9. Logging

Structured JSON loglar `pino` ile üretilir. Seviye ayarı:

```env
LOG_LEVEL=info   # debug | info | warn | error | fatal
```

Log stream'i parse için:
```bash
node index.js | npx pino-pretty
```

---

## 10. Rate Limiter & Otomatik IP Ban

### Strateji

Bridge'in rate limiter'ı her endpoint için farklı granülerlik kullanır:

| Strateji | Kullanıldığı yerler | Açıklama |
|---|---|---|
| **IP-only** | `/auth/login`, `/auth/register` | Kimlik doğrulanmamış istekler |
| **User-only** | `upload`, `messages`, `ai` | Kullanıcıya özel kota |
| **IP+User dual-key** | Çoğu API endpoint'i | Her iki limit de ayrı ayrı kontrol edilir; biri aşılınca `429` döner |
| **Global** | Tüm `/api` trafiği | Arka plan güvenlik ağı (varsayılan: 300 istek/dakika) |

> **Sprint 41 notu:** IP+User dual-key implementasyonu tamamlandı. Artık bir kullanıcı farklı IP'lerden aynı kotayı paylaşamaz; aynı zamanda tek IP'den farklı kullanıcı hesaplarıyla kota bypass yapılamaz.

### Otomatik IP Ban

Rate limiter, belirli bir pencere içinde eşiği tekrar tekrar aşan IP adreslerini **otomatik olarak geçici ban**lar:

```env
# İhlal sayısı bu eşiği geçince IP otomatik ban'lanır (varsayılan: 10)
RATE_LIMIT_BAN_THRESHOLD=10
# Ban süresi (ms) — varsayılan: 15 dakika
RATE_LIMIT_BAN_DURATION_MS=900000
```

Ban edilen IP'ler `ipBan` tablosuna yazılır ve `ipBanMiddleware` tarafından sonraki isteklerde `403` ile engellenir. Ban süresi dolunca otomatik kaldırılır.

**Manuel ban yönetimi** için admin API:
```bash
# Aktif banları listele
GET /api/v1/admin/ip-bans

# IP ban'ı kaldır
DELETE /api/v1/admin/ip-bans/:ip
```

### Rate Limit Sınırlarını Özelleştirme

Tüm limitler environment variable ile override edilebilir:

```env
# Format: RL_<ENDPOINT>_MAX ve RL_<ENDPOINT>_WIN (ms)
RL_LOGIN_MAX=10          # Varsayılan: 10
RL_LOGIN_WIN=60000       # Varsayılan: 60 saniye
RL_REGISTER_MAX=5
RL_MESSAGES_MAX=30
RL_AI_MAX=10
RL_AI_STREAM_MAX=5
RL_UPLOAD_MAX=20
RL_GLOBAL_MAX=300
```

> ⚠️ **Dikkat:** Redis olmadan rate limiter in-memory çalışır. Bu durumda çok instance deployment'ta her instance kendi limitini bağımsız tutar — limitler instance'lar arası paylaşılmaz. Production'da Redis zorunludur.

---

## 11. HAProxy Cluster

`haproxy/haproxy.cfg` — çoklu Bridge instance için yük dengeleme. WebSocket sticky session gerektirir:

```bash
haproxy -f haproxy/haproxy.cfg
```

---

## 12. Güncelleme

```bash
git pull
cd server && npm install --omit=dev
npm run db:migrate:pg

# Yeniden başlat
pm2 restart bridge
# veya Docker:
docker compose up -d --build bridge
```

---

## 13. Backup

**PostgreSQL:**
```bash
pg_dump bridge > backup_$(date +%Y%m%d).sql
```

Upload dosyaları:
```bash
rsync -av server/uploads/ backup-server:/backups/bridge-uploads/
```

> ⚠️ **Kritik:** `AP_ENCRYPTION_KEY` değerini de yedekle. Bu anahtar olmadan
> federation private key'leri kurtarılamaz. Güvenli bir password manager'da sakla.

---

## 14. Swagger / API Dokümantasyonu

Bridge, `GET /api/docs` endpoint'inde Swagger UI sunar. CI pipeline'ı bu endpoint'in aktif olduğunu doğrular.

### Kapsam Kontrolü

```bash
# Annotasyon kapsam raporu (yerel):
npx ts-node scripts/check-swagger-coverage.ts

# CI modu — kapsam eşiğin altındaysa exit 1:
npx ts-node scripts/check-swagger-coverage.ts --ci
```

Mevcut eşik: **%70** (CI'da zorunlu). Yeni route eklenirse annotasyon eklemeyi unutma.

### CI Entegrasyonu

`.github/workflows/ci.yml`'de Swagger sağlık kontrolü:

```yaml
- name: Swagger endpoint check
  run: |
    BASE_URL="${{ env.TEST_BASE_URL || 'http://localhost:3001' }}"
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/docs")
    if [ "$STATUS" != "200" ]; then
      echo "❌ /api/docs returned $STATUS"
      exit 1
    fi
    echo "✅ /api/docs is up"
```

---

## 15. Güvenlik — Bot Token Yönetimi

### Bot Token Hash Depolama (Sprint 75)

Bot token'ları artık ham metin yerine SHA-256 hash olarak saklanıyor. CSRF middleware, `x-bot-token` / `x-api-key` başlıklarını DB'deki hash ile doğruluyor — sadece header varlığı bypass için yeterli değil.

```bash
# Bot token üret (admin API):
POST /api/servers/:serverId/bots          # token bir kez döner
POST /api/servers/:serverId/bots/:id/token  # token yenile
```

**Güvenlik gereksinimleri:**
- Token'ı sadece ilk üretimde göster, tekrar erişilemez.
- Sızdığını düşündüğün token'ı hemen yenile (`/token` endpoint'i).
- Token'ı `.env` dosyasına veya kaynak koduna yazma.

### Rate Limit Auto-Ban Detayları

`rateLimit.ts` ihlal sayacı belirli bir eşiği geçince IP'yi otomatik ban'lar.

```env
RATE_LIMIT_BAN_THRESHOLD=10      # kaç ihlal → ban (varsayılan: 10)
RATE_LIMIT_BAN_DURATION_MS=900000  # ban süresi ms (varsayılan: 15 dakika)
```

**Ban tetikleme koşulları:**
- Aynı IP, bir pencere içinde aynı endpoint'e `RATE_LIMIT_BAN_THRESHOLD` kez `429` aldıysa ban.
- Ban kaydı `ipBan` tablosuna yazılır; `ipBanMiddleware` sonraki her istekte kontrol eder.
- Ban süresi dolunca kayıt silinir (veya TTL ile otomatik expire).

**Log çıktısı:**

```
[ipBan] AUTO-BAN: 1.2.3.4 — endpoint: login — ihlal: 12 — süre: 15dk
```

**Manuel müdahale:**

```bash
# Aktif banları listele
GET /api/v1/admin/ip-bans

# Belirli bir IP'yi erken çöz
DELETE /api/v1/admin/ip-bans/1.2.3.4
```

> ⚠️ **Dikkat:** Yanlış ban'ı önlemek için meşru yük testleri sırasında `RATE_LIMIT_BAN_THRESHOLD` değerini geçici olarak yükselt veya test IP'lerini whitelist'e al.

---

## 16. Sorun Giderme

**Port zaten kullanımda:**
```bash
lsof -i :3001
kill -9 <PID>
```

**PostgreSQL bağlantı hatası:**
`DATABASE_URL` ortam değişkenini kontrol et. DB servisinin çalıştığından emin ol:
```bash
psql "$DATABASE_URL" -c "SELECT 1"
```

**WebSocket bağlantısı kopuyor:**
Nginx `proxy_read_timeout` değerini artır (en az 86400).

**Redis bağlantı hatası:**
Redis olmadan da çalışır (in-memory mode). Loglarda `[Redis] REDIS_URL set edilmemiş` görürsün.
Üretim ortamında Redis kesinlikle önerilir — rate limiting ve multi-instance socket clustering için gereklidir.

---

## RTL Screenshot Baseline Kurulumu (E2E)

Sprint 87'de eklenen `e2e/tests/rtl.spec.ts` görsel regresyon testleri Playwright snapshot karşılaştırması kullanır.
Baseline PNG'ler git'e commit edilmeden CI'da bu testler hata verir.

### İlk Kez Baseline Oluşturma

```bash
# Uygulamayı ayağa kaldır
npm start

# Baseline snapshot'ları üret (SKIP_VISUAL_REGRESSION boş bırakılmalı)
cd e2e
SKIP_VISUAL_REGRESSION= npx playwright test tests/rtl.spec.ts --update-snapshots

# Üretilen dosyaları commit'le
git add tests/rtl.spec.ts-snapshots/
git commit -m "chore(e2e): add RTL screenshot baselines [ar, he, fa]"
git push
```

### CI'da Baseline Yokken (Bootstrap Öncesi)

```bash
# Visual regression grubunu atla; diğer RTL testleri çalışır
SKIP_VISUAL_REGRESSION=1 npx playwright test
```

### Baseline Güncelleme (UI Değişikliği Sonrası)

```bash
SKIP_VISUAL_REGRESSION= npx playwright test tests/rtl.spec.ts --update-snapshots
git add tests/rtl.spec.ts-snapshots/ && git commit -m "chore(e2e): update RTL baselines"
```

### GitHub Actions Entegrasyonu

`.github/workflows/e2e.yml` dosyasına şunu ekle:

```yaml
env:
  # Baselines commit'lenmişse boş bırak (testler çalışır).
  # Henüz commit'lenmemişse '1' yap (visual grup atlanır, CI kırılmaz).
  SKIP_VISUAL_REGRESSION: ""
```

---

## Sprint Changelog Dosyaları

Sprint notları `docs/changelogs/` dizininde bulunur. Belirli bir sprint'in değişikliklerini
incelemek için:

```bash
cat docs/changelogs/SPRINT102_CHANGES.md
ls docs/changelogs/   # tüm geçmiş
```

Repo kökünde `SPRINT*_CHANGES.md` dosyası bırakılmaz.
