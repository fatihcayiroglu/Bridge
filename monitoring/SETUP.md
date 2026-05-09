# Bridge — Prometheus / Grafana Monitoring Kurulumu

## Hızlı Başlangıç

### 1. prom-client Kur
```bash
cd server
npm install prom-client
```

### 2. .env Ayarları
```env
METRICS_ENABLED=true
METRICS_SECRET=cok_gizli_bir_token_buraya
METRICS_PREFIX=bridge_
```

### 3. Docker Compose ile Prometheus + Grafana

`monitoring/docker-compose.yml` dosyasını kullan:

```bash
cd monitoring
docker compose up -d
```

Grafana → http://localhost:3001 (admin/admin)
Prometheus → http://localhost:9090

---

## Toplanan Metrikler

### HTTP
| Metrik | Açıklama |
|--------|----------|
| `bridge_http_request_duration_seconds` | Route'a göre yanıt süresi (histogram) |
| `bridge_http_requests_total` | Toplam istek sayısı (method, route, status) |
| `bridge_http_errors_total` | 4xx/5xx hata sayısı |

### WebSocket
| Metrik | Açıklama |
|--------|----------|
| `bridge_websocket_connections` | Anlık bağlı socket sayısı |
| `bridge_websocket_events_total` | Event tipi bazında sayım |

### Veritabanı
| Metrik | Açıklama |
|--------|----------|
| `bridge_db_query_duration_seconds` | Operasyon + koleksiyon bazında süre |
| `bridge_db_queries_total` | Toplam sorgu sayısı |

### Uygulama
| Metrik | Açıklama |
|--------|----------|
| `bridge_active_users` | Online benzersiz kullanıcı sayısı |
| `bridge_active_sockets` | Toplam açık socket |
| `bridge_voice_rooms` | Aktif ses odası sayısı |

### Node.js (otomatik)
- CPU kullanımı, bellek, GC istatistikleri, event loop gecikmesi

---

## Prometheus Scrape Konfigürasyonu

```yaml
# prometheus.yml
scrape_configs:
  - job_name: bridge
    scrape_interval: 15s
    static_configs:
      - targets: ['bridge:3000']  # Docker ağında Bridge container adı
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: cok_gizli_bir_token_buraya
```

---

## Grafana Alarm Önerileri

```yaml
# Yüksek hata oranı
alert: HighErrorRate
expr: rate(bridge_http_errors_total[5m]) > 1
for: 2m

# Yavaş yanıt süresi
alert: SlowResponses
expr: histogram_quantile(0.95, rate(bridge_http_request_duration_seconds_bucket[5m])) > 2
for: 5m

# Bağlantı patlaması
alert: ConnectionSpike
expr: bridge_active_sockets > 5000
for: 1m
```

---

## /metrics Güvenliği

Endpoint `METRICS_SECRET` env değişkeni ile korunur:

```bash
curl -H "Authorization: Bearer cok_gizli_bir_token_buraya" http://localhost:3000/metrics
```

Production'da `/metrics` Nginx seviyesinde iç ağa kısıtlanmalı:

```nginx
location /metrics {
    allow 10.0.0.0/8;   # iç ağ
    deny all;
}
```
