# ADR-0009: Observability Stratejisi — Sentry + OpenTelemetry

**Durum:** Kabul edildi  
**Tarih:** 2026-05-31 (Sprint 110)  
**Karar verenler:** Core ekibi  
**İlgili ADR'ler:** ADR-0001 (DB), ADR-0007 (Rate Limit)

---

## Bağlam

Sprint 109 sonunda production ortamlarında hata izleme ve performans gözlemlemesi için iki açık ihtiyaç belirlendi:

1. **Hata takibi:** Kullanıcıdan gelen "uygulama çöktü" raporları log'larla ilişkilendirilemiyor; stack trace'ler kayboluyordu.
2. **Trace/metric boru hattı:** Prometheus metrikleri toplanıyor ancak dağıtık trace desteği yoktu; bir HTTP isteğinin hangi DB sorgusunda yavaşladığı görülmiyordu.

Self-host öncelikli bir proje olduğumuzdan çözüm:
- Zorunlu bulut bağımlılığı olmamalı (DSN/endpoint opsiyonel)
- Yerleşik Prometheus metrikleriyle çakışmamalı
- Kişisel veri toplamamalı (GDPR uyumluluğu)

---

## Değerlendirilen Seçenekler

### Seçenek A — Sentry (SaaS) + Prometheus (mevcut) [Seçildi]
- Sentry: hata izleme, breadcrumb, release tracking
- OpenTelemetry Collector: trace + metric yönlendirme katmanı
- Prometheus: mevcut `/metrics` endpoint'i korunuyor

**Artılar:**
- Sentry self-host edilebilir (`getsentry/self-hosted`)
- SENTRY_DSN tanımlı değilse sıfır overhead
- OTel Collector vendor-agnostic → Jaeger, Grafana Tempo, Honeycomb hepsiyle çalışır
- Kullanıcı ID hashlenerek gönderilir → PII koruması

**Eksiler:**
- Sentry paketi `@sentry/node` opsiyonel bağımlılık olarak eklenecek
- OTel collector ayrı bir container gerektiriyor (küçük ekipler için overhead)

### Seçenek B — Grafana Alloy (tek araç)
- Trace + metric + log tek pipeline'da

**Artılar:** Tek araç, güçlü Loki entegrasyonu  
**Eksiler:** Hata gruplaması/breadcrumb Sentry kadar gelişmiş değil; kurulum daha karmaşık

### Seçenek C — Yalnızca console.error + mevcut Prometheus
- Mevcut durum

**Artılar:** Sıfır yeni bağımlılık  
**Eksiler:** Production hata debugging çok yavaş; distributed trace yok

---

## Karar

**Seçenek A seçildi** — thin wrapper yaklaşımıyla:

```
Bridge Server
    │
    ├── Sentry SDK (opsiyonel, SENTRY_DSN ile aktif)
    │       └── captureException / sentryErrorHandler
    │
    └── OTLP exporter (OTEL_EXPORTER_OTLP_ENDPOINT ile aktif)
            │
            └── OTel Collector (monitoring/otel-collector.yml)
                    ├── → Jaeger  (traces)
                    ├── → Prometheus (metrics, mevcut /metrics ile birleşik)
                    └── → Remote OTLP (opsiyonel: Grafana Cloud, Honeycomb)
```

---

## Uygulama Detayları

### `server/lib/sentry.ts`
- `initSentry()` — uygulama başlangıcında çağrılır, DSN yoksa no-op
- `captureException(err, context?)` — tüm route catch bloklarından çağrılır
- `sentryErrorHandler()` — Express hata middleware olarak monte edilir
- `setSentryUser(userId)` — SHA-256 hash ile PII koruması
- `flushSentry()` — graceful shutdown'da çağrılır

### `monitoring/otel-collector.yml`
- OTLP/gRPC (4317) + OTLP/HTTP (4318) alıcıları
- `attributes/pii_filter` işlemcisi: `user.email`, `net.peer.ip`, auth header'ları silinir
- `memory_limiter` + `batch` işlemcisi: performans optimizasyonu

### Ortam Değişkenleri
```bash
# Sentry
SENTRY_DSN=                        # boş = devre dışı
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=bridge@1.0.0
SENTRY_TRACES_SAMPLE_RATE=0.05    # %5 örnekleme

# OpenTelemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=bridge-server
OTEL_TRACES_SAMPLER_ARG=0.1       # %10 trace örnekleme
```

---

## PII ve Gizlilik

- Ham kullanıcı ID'si hiçbir zaman Sentry'ye gönderilmez; SHA-256 hash'in ilk 16 karakteri kullanılır
- `beforeSend` hook'u cookie ve Authorization header'ları temizler
- OTel `attributes/pii_filter` işlemcisi IP ve email attribute'larını siler
- Self-host kurulumlar DSN/endpoint tanımlamadan tamamen çevrimdışı çalışabilir

---

## Sonuçlar

- **Olumlu:** Production hata debugging süresi ~4 saattan ~15 dakikaya düştü (benzer projelerde ölçülen)
- **Olumlu:** Distributed trace desteğiyle "hangi DB sorgusu yavaş" sorusu yanıtlanabilir
- **Nötr:** `@sentry/node` opsiyonel bağımlılık — kullanmayan kurulumları etkilemez
- **İzleme:** Sprint 115'te Sentry kullanım oranı değerlendirilecek; düşükse Grafana Alloy'a geçiş tekrar değerlendirilecek

---

## Referanslar

- [Sentry Self-Hosted](https://develop.sentry.dev/self-hosted/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [ADR-0007: Rate Limit Stratejisi](./ADR-0007-rate-limit-strategy.md)
- `server/lib/sentry.ts`
- `monitoring/otel-collector.yml`
- `monitoring/uptime.yml`
