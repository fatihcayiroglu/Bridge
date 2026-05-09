# k6 Load Testing — Bridge

Gerçekçi yük senaryoları ile Bridge'in kaç kullanıcıya kadar dayanabileceğini ölçer.

## Kurulum

```bash
# macOS
brew install k6

# Ubuntu/Debian
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker
docker pull grafana/k6
```

## Testler

### 1. Mesaj API Yük Testi

```bash
# Smoke (2 VU, 1 dakika) — temel doğrulama
BASE_URL=http://localhost:3000 \
TEST_EMAIL=e2e_alice@bridge-e2e.test \
TEST_PASS=E2eTestPass123! \
SCENARIO=smoke \
k6 run k6/messages-load.js

# Normal yük (50 VU, 4 dakika)
SCENARIO=load k6 run k6/messages-load.js

# Stres testi (300 VU, 8 dakika)
SCENARIO=stress k6 run k6/messages-load.js

# Spike testi (0→500 VU)
SCENARIO=spike k6 run k6/messages-load.js
```

### 2. WebSocket Yük Testi

```bash
# 200 eşzamanlı WS bağlantısı
BASE_URL=http://localhost:3000 k6 run k6/websocket-load.js
```

### 3. Upload Yük Testi

```bash
BASE_URL=http://localhost:3000 k6 run k6/upload-load.js
```

### Tüm testleri sırayla çalıştır

```bash
./k6/run-all.sh
```

## Kapasite Analizi Metodolojisi

### Baseline (tek instance, SQLite)

| Metrik | Beklenen |
|--------|---------|
| Eşzamanlı kullanıcı | ~50-100 |
| Mesaj gönderme p95 | <200ms |
| WS bağlantı limiti | ~200 |
| Upload throughput | 10-30 MB/s |

### PostgreSQL + Redis ile

| Metrik | Beklenen |
|--------|---------|
| Eşzamanlı kullanıcı | ~500-1000 |
| Mesaj gönderme p95 | <100ms |
| WS bağlantı limiti | ~1000 (Redis adapter ile) |
| Upload throughput | 50+ MB/s |

### Redis Cluster + Yatay ölçekleme ile

| Metrik | Beklenen |
|--------|---------|
| Eşzamanlı kullanıcı | 5000+ |
| Mesaj gönderme p95 | <50ms |
| WS bağlantı limiti | Yatay ölçekleme ile sınırsız |

## Darboğaz Tespiti

```bash
# CPU/Memory izle (test sırasında)
top -b -n 60 -d 5 > system-metrics.txt &

# PostgreSQL bağlantı havuzu izle
watch -n2 'psql $DATABASE_URL -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state"'

# Redis bağlantı sayısı
redis-cli info clients | grep connected_clients
```

## Threshold'lar

Testler şu koşullarda **başarısız** sayılır:

- `http_req_duration p(95) > 500ms` — Yanıt gecikmesi
- `error_rate > 5%` — Hata oranı
- `ws_connect_success < 90%` — WS bağlantı başarısı
- `upload_success_rate < 85%` — Upload başarısı

## Sonuç Raporu

```bash
# JSON çıktı ile detaylı rapor
k6 run --out json=results.json k6/messages-load.js

# Grafana/InfluxDB entegrasyonu
k6 run --out influxdb=http://localhost:8086/bridge k6/messages-load.js
```
