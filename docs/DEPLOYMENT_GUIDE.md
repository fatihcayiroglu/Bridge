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

### Veritabanı (varsayılan: SQLite)

```env
# PostgreSQL (production için önerilir)
DATABASE_URL=postgresql://bridge:sifre@localhost:5432/bridge

# Redis (yatay ölçekleme + cache)
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
cp .env.example .env
# .env'i yukarıdaki değerlerle doldur
```

---

## 3. Veritabanı Migration

**SQLite:**
```bash
npm run db:migrate
```

**PostgreSQL:**
```bash
npm run db:migrate:pg
```

Migration durumu:
```bash
npm run db:migrate:status        # SQLite
npm run db:migrate:pg:status     # PostgreSQL
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

## 10. HAProxy Cluster

`haproxy/haproxy.cfg` — çoklu Bridge instance için yük dengeleme. WebSocket sticky session gerektirir:

```bash
haproxy -f haproxy/haproxy.cfg
```

---

## 11. Güncelleme

```bash
git pull
cd server && npm install --omit=dev
npm run db:migrate       # SQLite
# veya
npm run db:migrate:pg    # PostgreSQL

# Yeniden başlat
pm2 restart bridge
# veya Docker:
docker compose up -d --build bridge
```

---

## 12. Backup

**SQLite:**
```bash
# WAL checkpoint + yedek
sqlite3 server/data/bridge.db ".backup backup_$(date +%Y%m%d).db"
```

**PostgreSQL:**
```bash
pg_dump bridge > backup_$(date +%Y%m%d).sql
```

Upload dosyaları:
```bash
rsync -av server/uploads/ backup-server:/backups/bridge-uploads/
```

---

## 13. Sorun Giderme

**Port zaten kullanımda:**
```bash
lsof -i :3001
kill -9 <PID>
```

**SQLite "database is locked":**
WAL modunda çalışır. Birden fazla process aynı dosyaya yazmamalı.
PostgreSQL'e geçiş önerilir.

**WebSocket bağlantısı kopuyor:**
Nginx `proxy_read_timeout` değerini artır (en az 86400).

**Redis bağlantı hatası:**
Redis olmadan da çalışır (in-memory mode). Loglarda `[Redis] REDIS_URL set edilmemiş` görürsün.
