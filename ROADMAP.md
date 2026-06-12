# Bridge — Roadmap

---

## Mevcut Durum

### Tamamlanan Özellikler

| Kategori | Özellik |
|----------|---------|
| **Auth** | JWT + Refresh token rotasyonu, WebAuthn/Passkey (FIDO2), 2FA (TOTP) |
| **Mesajlaşma** | Real-time Socket.IO, düzenleme geçmişi, reaksiyonlar, thread |
| **Dosya** | Chunked upload (büyük dosyalar) |
| **Sesli** | WebRTC P2P ses kanalları, SFU group voice (Mediasoup) |
| **Roller** | Gelişmiş izin sistemi (kanal bazlı granüler) |
| **Moderasyon** | Ban/kick/timeout, auto-mod AI, IP ban, içerik tarama |
| **DM** | Direkt mesajlaşma + E2E şifreleme |
| **Arkadaşlar** | Arkadaş sistemi |
| **Keşif** | Sunucu keşif sayfası |
| **Bot** | Bot API + Webhook + SDK |
| **Poll** | Anket sistemi |
| **Soundboard** | Ses panosu |
| **Mobile** | PWA + Capacitor iOS/Android |
| **Güvenlik** | Redis cache, rate limiting, HTTP Signature |
| **Federasyon** | ActivityPub (followers/following/notes, NodeInfo, RSA key) |
| **AI** | Özet, çeviri, moderasyon, yanıt önerisi, semantik arama |
| **Plugin** | Plugin sistemi (sandbox izolasyonu) |
| **SSO** | Kurumsal SSO (harici bağımlılıksız) |
| **Audit Log** | Admin paneli audit log export |
| **Monitoring** | Prometheus + Grafana dashboard |
| **Test** | Jest (server) + Playwright (E2E) altyapısı |
| **Dokümantasyon** | DB Schema referansı (64 tablo, tasarım kararları, migration rehberi) |
| **Mimari** | ADR-0006 (Federation asymmetric key), ADR-0007 (Rate limit stratejisi) |

---

## Kısa Vadeli Hedefler

### UI Kimlik v2 (Bridge ≠ Discord)

- ~~Discord moru (#5865f2) kaldırıldı~~ ✅ Köprü mavisi `#2d9cdb` + amber vurgu
- ~~Layout modları (Odak / Kompakt)~~ ✅ Ayarlar → Görünüm
- ~~Tasarım yönü belgesi~~ ✅ [docs/DESIGN_DIRECTION.md](docs/DESIGN_DIRECTION.md)
- ~~UI metinlerinde Hub / Space terminolojisi~~ ✅ Sprint 110 — 15 dil i18n dosyasına `hub`/`space`/`flow`/`hubs`/`spaces`/`flows` anahtarları eklendi
- ~~Komut paleti (`⌘K`) — global gezinme~~ ✅ Sprint 111 — `client/js/core/command-palette.ts`, 12 yerleşik komut, fuzzy arama, recent history
- ~~Varsayılan düzen: Odak modu değerlendirmesi~~ ✅ Sprint 111 — ADR-0011 (Focus Mode ertelendi: kullanıcı araştırması Sprint 115'te)

### Performans & Güvenilirlik

**CI/CD**
- ~~GitHub Actions CI pipeline~~ ✅ Sprint 114 — lint, server-tests, structural-guards, e2e, security-audit

**Veritabanı**
- ~~SQLite → PostgreSQL geçişi~~ ✅ Sprint 38'de tamamlandı — sistem PostgreSQL 16 kullanıyor
- ~~CDN + WebP otomatik dönüşümü (`sharp`)~~ ✅ Sprint 106'da tamamlandı — `WEBP_CONVERT=true` ile aktif; `sharp` paketine bağlı
- ~~Cloudflare R2 / MinIO medya depolama~~ ✅ Sprint 95'te tamamlandı — `CDN_PROVIDER=r2|minio|b2|local`

**Önbellek**
- ~~Mesaj cache TTL optimizasyonu~~ ✅ Sprint 106'da tamamlandı — adaptif TTL (aktif kanal: 5s / orta: 15s / sessiz: 45s); edit+delete cache invalidation eklendi
- ~~User presence cache (online/offline)~~ ✅ Sprint 97'de tamamlandı — Redis TTL heartbeat + cluster Pub/Sub (`lib/presenceCache.ts`)
- ~~Channel list cache~~ ✅ Sprint 106'da tamamlandı — Redis-backed 30s TTL; create/update/delete'te invalidate

### Sosyal Özellikler

**Topluluk Profilleri**
- ~~Sunucu "hakkında" sayfası (web'den erişilebilir): `bridge.app/s/sunucu-adi`~~ ✅ Sprint 111 — `GET /api/servers/:slug/public` endpoint + `server-about.html` SSR şablonu
- ~~Üye sayısı, aktivite grafiği, son mesajlar (preview)~~ ✅ Sprint 111 — `/api/discover/featured` payload'a `memberCount`, `weeklyMsgCount`, `activitySpark` eklendi

**Gelişmiş Profil**
- ~~Bağlantılar: GitHub, Twitter, Steam, Spotify~~ ✅ Sprint 111 — `server_links` DB kolonu + `PATCH /api/servers/:id/links` + UI form
- ~~"Şu an çalınan" Spotify entegrasyonu~~ ✅ Sprint 111 — OAuth2 akışı + `SPOTIFY_CLIENT_ID`/`SECRET` env vars `.env.example`'a eklendi
- ~~Rozetler (kullanıcı başarıları)~~ ✅ Sprint 111 — `badges.ts` coverage %85, `BADGE_DEFINITIONS`, `awardBadge`/`revokeBadge` API

**Keşif Güçlendirmesi**
- ~~Haftalık "Öne Çıkan Sunucular"~~ ✅ Sprint 110 — `GET /api/discover/featured`, Redis cache (5 dk TTL)
- ~~Kategori bazlı gezinme~~ ✅ Sprint 110 — `GET /api/discover/categories`, `?category=` filtresi
- ~~Gerçek zamanlı aktif üye sayısı~~ ✅ Sprint 110 — `discover:memberCount` presence cache, Socket.IO push

---

## Orta Vadeli Hedefler

### Altyapı

**Yatay Ölçekleme**
```
nginx (reverse proxy)
  ├── Node.js instance 1
  ├── Node.js instance 2
  └── Node.js instance N
      ↕
  Redis (pub/sub)
      ↕
  PostgreSQL (primary + replica)
```

Redis adapter mevcut — `REDIS_URL` ortam değişkeni yeterli.

**Monitoring**
- ~~OpenTelemetry entegrasyonu~~ ✅ Sprint 110 — `monitoring/otel-collector.yml`, `OTEL_EXPORTER_OTLP_ENDPOINT` env
- ~~Sentry error tracking~~ ✅ Sprint 110 — `SENTRY_DSN` env destegi, `server/lib/sentry.ts` wrapper
- ~~Uptime monitoring~~ ✅ Sprint 110 — `monitoring/uptime.yml` (Uptime Kuma), healthcheck endpoint `/api/health`

### AI Özellikleri

- ~~Vektör embedding ile semantik mesaj arama~~ ✅ Sprint 112 — `lib/pgvector.ts` (generateEmbedding, vectorSearch, saveMessageEmbedding), cosine similarity, OpenAI/Ollama/Nomic provider desteği, migration SQL. ADR-0009 Faz 1 tamamlandı.
- ~~Doğal dil sorguları ("bu haftaki önemli kararlar")~~ ✅ Sprint 111 — `POST /api/semantic/search` + `GET /api/semantic/digest/:serverId` endpointleri; AI modeli opsiyonel
- ~~Otomatik moderasyon pipeline (5 dk tarama döngüsü)~~ ✅ Sprint 111 — `PLUGIN_MODERATION.md` + `CONTENT_SCAN_ENABLED` env var + cron job altyapısı
- ~~Çok dilli arayüz (TR/EN/DE/FR)~~ ✅ Sprint 111 — 15 dil (TR/EN/DE/FR/ES/JA/PT/KO/RU/IT/ZH/AR/NL/HE/FA), 202 anahtar, `check-i18n-parity.js` CI guard

---

## Kısa Vadeli — Sprint 113–116 Planı (TAMAMLANDI ✅)

| Görev | Sprint | Durum |
|-------|--------|-------|
| ~~pgvector Faz 2: Geçmiş mesaj batch embed~~ | Sprint 113 | ✅ `server/jobs/embedHistory.ts` + batch embed job |
| ~~Federation shared-secret → tam RSA~~ | Sprint 113 | ✅ ADR-0006 Faz 3: `httpSignatureV3.ts`, HMAC kaldırıldı |
| ~~voice.ts Svelte geçişi~~ | Sprint 113 | ✅ `VoicePanel.svelte` + `voice-svelte.ts` |
| ~~group-dm.ts Svelte geçişi~~ | Sprint 113 | ✅ `GroupDmPanel.svelte` + `group-dm-svelte.ts` |
| ~~GitHub Actions CI pipeline~~ | Sprint 114 | ✅ 5 job: lint, server-tests, structural-guards, e2e, security-audit |
| ~~DiscoverPanel Svelte geçişi~~ | Sprint 114 | ✅ `DiscoverPanel.svelte` + ADR-0008 Faz 2 |
| ~~Mobile iOS/Android native projeler~~ | Sprint 115 | ✅ ADR-0013 K1: `mobile/ios/App/` + `mobile/android/` |
| ~~Electron release pipeline~~ | Sprint 115 | ✅ ADR-0013 K2: `.github/workflows/electron-release.yml` |
| ~~E2EE production default: true~~ | Sprint 115 | ✅ ADR-0013 K3: `BRIDGE_E2EE_ENABLED` varsayılan açık |
| ~~SAST + Dependency Review CI~~ | Sprint 115 | ✅ ADR-0013 K4: CodeQL + dependency-review job |
| ~~OpenAPI 3.1 Spec~~ | Sprint 115 | ✅ ADR-0013 K6: `docs/api/openapi.yaml` (1128 satır) |
| ~~Svelte Migration Faz 3 (169 dosya)~~ | Sprint 116 | ✅ ADR-0008 KAPANDI: 143 bileşen, sıfır vanilla TS |

## Uzun Vadeli Vizyon


### Bridge'i Discord'dan Ayıran 5 Temel Özellik

**1. Gerçek Gizlilik (E2EE)**
Mesajlar sunucuda şifreli; sağlayıcı okuyamaz. **Sprint 115'ten itibaren production'da varsayılan açık.** ✅

**2. Native AI Entegrasyonu**
Konuşma özeti, çeviri, öneri sistemi mevcut. Hedef: AI moderatör, AI kanal organizatörü.

**3. Tüm Premium Özellikler Ücretsiz**

| Özellik | Discord | Bridge |
|---------|---------|--------|
| Animasyonlu avatar | Nitro ($10/ay) | Ücretsiz |
| Profil banner | Nitro | Ücretsiz |
| Yüksek kalite ses | Nitro | Ücretsiz |
| Büyük dosya upload | Nitro | Yapılandırılabilir |

**4. Açık Kaynak & Federasyon**
ActivityPub ile farklı Bridge sunucuları birbirine bağlanabilir. Docker ile tek komut kurulum. Plugin/extension sistemi.

**5. Topluluk Analitiği**
Üye büyüme grafikleri, en aktif saatler, popüler içerikler, bağlılık skoru.

---

## Teknik Borç

| Öncelik | Görev |
|---------|-------|
| ✅ Tamamlandı | Büyük modülleri klasör bazlı böl — `servers.ts` → `routes/servers/`, `ai.ts` → `routes/ai/` (Sprint 27) |
| ✅ Tamamlandı | `_legacy/` klasörlerini temizle — 73 eski JS dosyası kaldırıldı (Sprint 27) |
| ✅ Tamamlandı | Geçiş tsconfig'lerini birleştir — bridge4/15/18 → subsets.json (Sprint 27) |
| ✅ Tamamlandı | CI/CD pipeline'ı Node 22 LTS için güncellendi (.nvmrc = 22, ci.yml node-version-file ile okur) |
| ✅ Tamamlandı | ActivityPub private key DB'de şifreli saklanıyor — AES-256-GCM (Sprint 38) |
| ✅ Tamamlandı | **Vault/Secrets Manager adapter** — HashiCorp KV v2 (static token + AppRole), AWS Secrets Manager, env fallback, 5dk TTL cache, validateRequiredSecrets (Sprint 112) |
| ✅ Tamamlandı | **ActivityPub C2S outbox POST** — `POST /federation/users/:username/outbox`, JWT auth, public/unlisted/followers visibility, deliverToFollowers entegrasyonu (Sprint 112) |
| ✅ Tamamlandı | **pgvector embedding Faz 1** — cosine similarity arama, OpenAI/Ollama/Nomic, migration SQL, semantic.ts entegrasyonu (Sprint 112) |
| ✅ Tamamlandı | **Storybook 8 (ADR-0008 Faz 3)** — Svelte bileşen izole geliştirme, addon-a11y WCAG 2.1 AA, SettingsModal + ChannelList story'leri (Sprint 112) |
| ✅ Tamamlandı | federation-integrations.ts duplikasyonu giderildi — federation-ui.ts canonical (Sprint 38) |
| ✅ Tamamlandı | Deployment Guide SQLite referansları temizlendi (Sprint 38) |
| ✅ Tamamlandı | channel-perms/modal-state.ts window.* → ESM + BridgeRegistry (Sprint 38) |
| ✅ Tamamlandı | `webrtc.ts` / `webrtc-sfu.ts` window.* temizliği — BridgeRegistry'e geçildi (Sprint 33) |
| ✅ Tamamlandı | Client test coverage artırımı — voice.test.js (+13), settings-modal.test.js (+12), bot-marketplace.test.js (+12) (Sprint 48) |
| ✅ Tamamlandı | `node-fetch` bağımlılığı kaldırıldı — package.json'da mevcut değil, fetch.ts yorum güncellendi (Sprint 48) |
| ✅ Tamamlandı | Rate limit granülerliği — per-user IP tracking, `per-user-ip` modu eklendi (Sprint 41/50) |
| ✅ Tamamlandı | Socket.IO room memory leak kontrolü — disconnect'te tüm room'lar temizleniyor, canvas/voice/discover leak'ları doğrulandı (Sprint 50) |
| ✅ Tamamlandı | Client-side bundle optimizasyonu — Sprint 50 TS modülleri entry'lere eklendi, check-bundle-budget.js geliştirildi, JS budget 1.2 MB'a güncellendi (Sprint 50) |
| ✅ Tamamlandı | 25 JS dosyasının TypeScript'e tam dönüşümü (6770 satır TS üretildi) — voice, web-push, offline-banner, analytics, mobile, virtual-scroll, i18n, canvas, ip-ban, styles, partials, stage, user-connections, channel-stage, discover, mobile-ux, emoji-picker, calendar-picker, clyde, group-dm-core, onboarding-tour, server-ui, bot-marketplace, messages/loader, messages/virtual-scroll (Sprint 50) |
| ✅ Tamamlandı | Test coverage artırımı — 7 yeni client test (web-push, offline-banner, virtual-scroll, emoji-picker, clyde, server-ui) + 2 yeni server test (connections, canvas) (Sprint 50) |
| ✅ Tamamlandı | **Federation per-peer RSA doğrulaması** — ADR-0006 Faz 2: `httpSignatureV2.ts` RSA-2048 öncelikli doğrulama, HMAC fallback (Sprint 108) |
| ✅ Tamamlandı | **WCAG 2.1 AA uyumluluğu** — `a11y-wcag-aa.ts`: skip-link, landmark patch, reduced motion, live region, kontrast hesaplayıcı, voice/stage ARIA (Sprint 108) |
| ✅ Tamamlandı | **Frontend framework sınır kuralları** — ADR-0008: Svelte/vanilla TS katman modeli, CI guard (`check-svelte-boundary.sh`) (Sprint 108) |
| ✅ Tamamlandı | **Client test coverage** — Global threshold %75 → %80; servers/forum/music/onboarding +48 test (Sprint 108) |
| ✅ Tamamlandı | **Bot Marketplace coverage %100** — tüm submodüller bağımsız test, `marketplace-state.ts` localStorage guard, CI guard adımı, threshold %57 → %100 (Sprint 109) |
| ✅ Tamamlandı | **pgvector Faz 2 — Batch Embed Job** — `server/jobs/embedHistory.ts`, günlük 03:00 UTC cron, historyLimit + AbortSignal graceful iptal, `npm run embed-history` CLI (Sprint 113) |
| ✅ Tamamlandı | **Federation RSA-only (ADR-0006 Faz 3)** — `httpSignatureV3.ts`: HMAC fallback tamamen kaldırıldı, RSA-only doğrulama, peer RSA key zorunlu (Sprint 113) |
| ✅ Tamamlandı | **GitHub Actions CI pipeline** — 5 job: lint-and-typecheck, server-tests, structural-guards, e2e-tests, security-audit (Sprint 114) |
| ✅ Tamamlandı | **Mobile iOS native proje** — `mobile/ios/App/`: AppDelegate.swift, Info.plist, Xcode project, URL scheme, push notification, background modes (Sprint 115 / ADR-0013 K1) |
| ✅ Tamamlandı | **Mobile Android native proje** — `mobile/android/`: MainActivity.kt, AndroidManifest, proguard, Gradle signing konfig (Sprint 115 / ADR-0013 K1) |
| ✅ Tamamlandı | **Mobile publish pipeline** — `.github/workflows/mobile-publish.yml`: iOS TestFlight + Android Play Store, tag push tetiklemesi (Sprint 115 / ADR-0013 K1) |
| ✅ Tamamlandı | **Electron release pipeline** — `.github/workflows/electron-release.yml`: Windows NSIS/MSIX, macOS DMG + notarization, Linux AppImage/deb/snap (Sprint 115 / ADR-0013 K2) |
| ✅ Tamamlandı | **E2EE production aktivasyonu** — `BRIDGE_E2EE_ENABLED` varsayılan `true`, DEPLOYMENT_GUIDE'a migration notu eklendi (Sprint 115 / ADR-0013 K3) |
| ✅ Tamamlandı | **SAST + Dependency Review** — CodeQL (javascript-typescript, security-and-quality) + PR'larda high severity bağımlılık taraması (Sprint 115 / ADR-0013 K4) |
| ✅ Tamamlandı | **OpenAPI 3.1 Spec** — `docs/api/openapi.yaml` (1128 satır): auth, users, servers, channels, messages, e2ee, search, moderation, federation, health. `/api/docs` Swagger UI (Sprint 115 / ADR-0013 K6) |
| ✅ Tamamlandı | **k6 performans baseline** — `k6/results/baseline-summary.json`: p95=61ms, p99=142ms, error_rate=0% (Sprint 115 / ADR-0013 K10) |
| ✅ Tamamlandı | **Versiyon senkronizasyonu** — root, server, bot-sdk, mobile, electron, e2e tüm package.json versiyonları senkronize (Sprint 115 / ADR-0013 K9) |
| ✅ Tamamlandı | **Svelte Migration Faz 3 — ADR-0008 KAPANDI** — 143 Svelte bileşeni, 126 mount shim, `client/js/core` sıfır vanilla TS, `svelte-migration-complete` CI guard (Sprint 116) |

---

## Başarı Metrikleri

| Dönem | Hedef |
|-------|-------|
| 6 ay | 1.000 aktif kullanıcı, <100ms ortalama API yanıt süresi, %99.5 uptime |
| 12 ay | 10.000 aktif kullanıcı, PostgreSQL geçişi tamamlandı, E2EE production aktif |
| 24 ay | 100.000 aktif kullanıcı, tam ActivityPub federasyonu, sürdürülebilir model |

---

## Sürdürülebilirlik

Bridge tamamen ücretsiz ve açık kaynak olarak konumlanmaktadır.

| Model | Durum |
|-------|-------|
| Reklam | ❌ Asla |
| Bireysel ücret | ❌ Tüm özellikler ücretsiz |
| Bağış (Ko-fi / GitHub Sponsors) | ✅ Açık kaynak için ideal |
| Self-hosting (altyapı maliyeti dağıtılır) | ✅ |
| Kurumsal deployment (ileride) | 🔮 Değerlendirilebilir |

---

*Son güncelleme: Haziran 2026 — Versiyon: 1.122.0 / Sprint 122*


## Sprint 82 — Tamamlandı ✅

- ✅ Activities sistemi (Watch Together, Satranç, Çiz, Kelime, Trivia)
- ✅ Super Reactions (uzun basma + parçacık animasyonu)
- ✅ Clips sistemi (30s rolling buffer, quickClip)
- ✅ Sticker sistemi (global + sunucu paketleri, REST API)
- ✅ i18n: ES, JA, PT, KO, RU dil desteği (4 → 9 dil)
- ✅ 147 yeni test (permissions extended dahil)

