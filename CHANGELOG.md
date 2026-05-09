# Changelog

Tüm önemli değişiklikler bu dosyada belgelenir.
Format: [Keep a Changelog](https://keepachangelog.com/tr/1.0.0/)
Versiyonlama: [Semantic Versioning](https://semver.org/)

---

## [Unreleased] — Sprint 6-7 İyileştirmeleri

### Eklendi
- **`server/lib/env.js`** — Sunucu başlamadan önce ortam değişkeni doğrulama.
  JWT_SECRET uzunluğu, DATABASE_URL formatı, WEBAUTHN_ORIGIN/RP_ID tutarlılığı,
  SMTP ve VAPID çift kontrolü. Hatalı config'de açık hata mesajı + `process.exit(1)`.
- **`backup/`** klasörü ve `Dockerfile` — docker-compose.yml'de referans edilen
  ama eksik olan backup servisi tamamlandı. PostgreSQL `pg_dump` (custom format),
  uploads rsync, S3/MinIO opsiyonel yükleme, cron ile her gece 02:30 otomatik yedek.
- **CI: PostgreSQL servis container'ı** — `.github/workflows/ci.yml` artık
  GitHub Actions'ta gerçek bir PostgreSQL 16 instance'ı ayağa kaldırıyor.
  Schema kurulumu + migration sonrası testler çalışıyor.
- **CI: Docker build doğrulama** — PR'larda `docker-validate` job'ı Dockerfile'ın
  derlenip derlenmediğini kontrol ediyor (push etmeden).
- **Docker: multi-arch build** — `docker.yml` artık `linux/amd64` ve `linux/arm64`
  için paralel image üretiyor. ARM sunucular ve Apple Silicon native çalışır.
- **Docker: SBOM + Provenance** — Her image build'inde Software Bill of Materials
  ve SLSA provenance otomatik oluşturuluyor (supply chain güvenliği).
- **Docker: Otomatik deploy** — SSH üzerinden `docker compose pull + up` zinciri.
  `vars.AUTO_DEPLOY=true` ile etkinleştirilen opsiyonel adım.

### Değiştirildi
- **`server/index.js`** — `require('./lib/env')` eklendi; hatalı yapılandırma
  artık sessizce geçmiyor, sunucu başlamıyor.
- **`.github/workflows/ci.yml`** — Test matrixine PostgreSQL bağımlı adımlar eklendi.
  Coverage badge Codecov'a yükleniyor.
- **`.github/workflows/docker.yml`** — QEMU + Buildx ile multi-arch; deployment job eklendi.

### Düzeltildi
- `backup/` klasörü eksikliği — `docker-compose.yml` backup servisini build ederken
  `./backup/Dockerfile` bulunamıyordu, `docker compose up` hata veriyordu.

---

## [Sprint 6] — Nisan 2026

### Düzeltildi (Kritik)
- **Memory Leak** — `spamMap`, `csrfTokens`, `violationMap` sınırsız büyümesi engellendi.
  LRU-lite pattern ile üst sınır getirildi. `setInterval` `.unref()` ile işaretlendi.
- **Global Antipattern** — `global.bridgeIO` / `global.bridgeSocketUsers` kaldırıldı,
  `app.set/get` pattern'ına geçildi. Test izolasyonu düzeldi.
- **MessageRepository `$regex` Escape** — SQL LIKE karakterleri (`%`, `_`, `\`) artık
  doğru escape ediliyor. `%` içeren arama tüm mesajları döndürmüyor.
- **Redis Eksik Uyarısı** — Production'da `REDIS_URL` yoksa `console.error` ile
  açık uyarı. Sessiz in-memory fallback artık gözden kaçmıyor.

### Eklendi
- **esbuild Chunk Splitting** — 74 `<script>` → 8 paralel `<script defer>` chunk.
  `chunk-boot`, `chunk-core`, `chunk-comms`, `chunk-webrtc`, `chunk-features`,
  `chunk-pages`, `chunk-heavy`, `chunk-compat`.
- **`MessageRepository.findLastTimestamps`** — Sidebar için N sorgu → tek `$in`.

---

## Sonraki Adımlar

| Öncelik | Görev | Durum |
|---------|-------|-------|
| 🔴 | TypeScript geçişi (repositories katmanından başla) | Planlandı |
| 🟡 | OpenAPI şeması tamamlama (tüm route'lar) | Planlandı |
| 🟡 | Client-side Sentry entegrasyonu | Planlandı |
| 🟢 | Frontend framework geçişi (Svelte/Vue) | Uzun vade |
