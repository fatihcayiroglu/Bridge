# Bridge — HANDOFF.md
> **Bu belge bir Claude oturumundan diğerine devir notudur.**
> Bir sonraki Claude instance'ı bu dosyayı okuyarak projeye sıfırdan bağlam kurabilir.

---

## Proje Özeti

Bridge, self-host destekli, ActivityPub federe bir Discord alternatifidir.
- **Stack**: Node.js 22 + Express 5 (server), Svelte 5 Runes (client — tüm migration'lar tamamlandı), PostgreSQL 16, Redis 7, Socket.IO 4, Mediasoup SFU
- **Monorepo**: `server/`, `client/`, `bot-sdk/`, `plugins/`, `electron/`, `mobile/`, `e2e/`, `k6/`
- **Versiyon**: 1.122.0 / Sprint 122 (2026-06-08) — rev.1
- **Dil**: Türkçe (README, CHANGELOG, kod yorumları)
- **Lisans**: MIT
- **Durum**: ✅ **Kod tabanı ~%87 tamamlandı** — kritik güvenlik açıkları kapatıldı; production hazırlığı için bkz. `docs/PRODUCTION_READINESS.md`

---

## Son Üç Sprint Özeti

### Sprint 122 ✅ — Güvenlik Sertleştirme, DM Gizlilik Politikası & Kararlılık
- **Kritik: `/metrics` açık endpoint** — `METRICS_SECRET` olmadan production'da 503; `env.ts`'e zorunlu kural eklendi
- **Kritik: SFU üyelik kontrolü eksikti** — `sfu:join`'da `Members.findOne()` ile sunucu üyeliği doğrulanıyor
- **Kritik: DM gizlilik politikası** — `dmPrivacy: everyone|friends|none`; migration 017 eklendi
- **dm:disconnect Map iteration** — safe delete pattern (toEnd[] dizisi) ile race condition giderildi
- **DM/GDM socket rate limit** — process-local Map → Redis-backed sliding window (cluster-safe)
- **autoModeration race condition** — `INSERT … ON CONFLICT DO NOTHING` ile atomik mod-log upsert
- **Electron CSP** — `onHeadersReceived` ile Content-Security-Policy header enjekte edildi
- **ROADMAP.md sürüm tutarsızlığı** — `1.118.0/Sprint 118` → `1.122.0/Sprint 122`
- **Versiyon senkronizasyonu** — package.json dosyaları 1.122.0'a güncellendi

### Sprint 121 ✅ — i18n Tamamlama, Güvenlik Düzeltmeleri & Kod Temizliği
- **i18n eksik çeviriler** — ja/ko/zh/ru/pt: 71→189 anahtar; de/fr: 173→189 anahtar; en/tr: 183→204 (14 key eklendi); TR 17 key eklendi
- **Güvenlik: replyTo cross-server bilgi sızıntısı** — `messages-send.ts`: replyTo mesajı artık aynı kanal+sunucuya ait olduğu doğrulanıyor
- **Güvenlik: file:send path traversal** — `messages-send.ts`: fileUrl normalize edilerek `../` path traversal engelleniyor
- **Güvenlik: typing:start üyelik kontrolü** — `messages-send.ts`: üye olmayan kanalda typing event gönderimi engellendi
- **HTTP durum kodu düzeltmesi** — `routes/auth.ts`: duplicate username kaydı 400→409 (OpenAPI spec ile uyumlu)
- **contentSanitizer regex** — `lib/contentSanitizer.ts`: target=_blank rel ekleme regex güvenli hale getirildi
- **wsConnectionLimit IP güvenliği** — `socket/middleware/wsConnectionLimit.ts`: TRUSTED_PROXY_COUNT desteği eklendi
- **Artık CSS dosyaları silindi** — `sprint91.css` + `sprint92.css` (style.css'ten çıkarılmıştı ama dosyalar kalmıştı)
- **CHANGELOG tarihi düzeltildi** — Sprint 120 girişi `2026-06-06` → `2026-06-07`
- **SECURITY.md sürüm tablosu** — `1.117.x` satırı `✅ Kritik` → `❌ EOL` (politikayla uyumlu hale getirildi)
- **Versiyon senkronizasyonu** — package.json dosyaları 1.121.0'a güncellendi

### Sprint 120 ✅ — Güvenlik Entegrasyonu & Refactor

### Sprint 119 ✅ — Dış İnceleme Düzeltmeleri
- **Admin panel Svelte migration** — 10 vanilla TS → `AdminPanel.svelte` (876 satır); eski TS dosyaları `client/_archived_legacy/admin_legacy/`'ye taşındı
- **Socket handler error handling** — 18/18 handler'da try/catch tamamlandı
- **Plugin testleri** — `plugins/tests/plugin-system.test.ts` (28 test)
- **Helm chart** — `k8s/helm/bridge/` (Chart.yaml + values + templates)
- **OpenAPI tamamlandı** — webhook, plugin, federation, admin endpoint'leri `openapi.yaml`'a merge edildi (1932 satır)
- **SECURITY.md** — tüm placeholder'lar kaldırıldı, self-host kılavuzu eklendi, sürüm tablosu 1.118.x'e güncellendi
- **_legacy temizliği** — tüm `_legacy/` dizinleri `_archived_legacy/` altına taşındı; CI guard aktif
- **Versiyon senkronizasyonu** — tüm package.json dosyaları 1.118.0'a güncellendi

### Sprint 119 ✅ — Dış İnceleme Düzeltmeleri
- **wsConnectionLimitMiddleware** — `server/socket/middleware/wsConnectionLimit.ts` (D5: IP başına WS limiti)
- **federationRateLimit** — `server/middleware/federationRateLimit.ts` (D6: AP inbox flood koruması)
- **contentSanitizer** — `server/lib/contentSanitizer.ts` (T5: DOMPurify/jsdom sunucu tarafı sanitization)
- **THREAT_MODEL.md** — STRIDE bazlı tehdit modeli belgelendi
- **k6 yük testi** — `k6/full-load.js` (load/spike/soak/stress senaryoları)
- **AP CI testleri** — `e2e/helpers/mastodon-mock-server.ts` + `e2e/tests/activitypub-ci.spec.ts`

### Sprint 120 ✅ — Güvenlik Entegrasyonu & Refactor
- **D5 entegrasyon** — `wsConnectionLimitMiddleware` socket middleware zincirine (MIDDLEWARE 0) eklendi
- **D6 entegrasyon** — `federationGlobalRateLimit` + `federationInboxRateLimit` AP inbox route'una bağlandı
- **T5 entegrasyon** — `sanitizeMessageContent()` messages-send.ts, messages-edit.ts ve routes/messages.ts'e eklendi
- **I7 WebRTC IP sızıntısı** — `FORCE_TURN=true` desteği `/api/rtc/ice-config` + `client/js/webrtc.ts`
- **VoicePanel Refactor** — PTT mantığı `VoicePTTController.svelte`'e, SS mantığı `VoiceScreenShareController.svelte`'e devredildi
- **i18n sistemi** — `client/js/core/i18n/` (Svelte5 Runes tabanlı, tr/en/es/de/fr başlangıç dilleri)
- **Vault audit log** — Vault sır erişimleri audit_log tablosuna yazılıyor (ADR-0012)
- **Mediasoup config refactor** — `SIMULCAST_ENCODINGS` / `SCREENSHARE_ENCODINGS` merkezi `config.ts`'te
- **Versiyon senkronizasyonu** — tüm package.json dosyaları 1.120.0'a güncellendi

---

## Mimari — Bilmen Gerekenler

### ADR-0008: Frontend Framework Stratejisi — KAPALI ✅
Migration **tamamen** tamamlandı. Admin panel dahil tüm UI Svelte 5 Runes. Kural hâlâ geçerli:

```
SVELTE KULLAN:                    VANILLA TS KAL:
*.svelte bileşenler          ←→   bridge-registry.ts
*-svelte.ts mount shimler    ←→   logger.ts
                                  (servis katmanı)
```

**CI Guard aktif**: `scripts/check-svelte-boundary.sh` + `scripts/check-no-legacy.mjs`

### BridgeRegistry Pattern
```typescript
BridgeRegistry.call('toast', 'mesaj', 'success');
BridgeRegistry.call('loadServers');
BridgeRegistry.call('openAdminDashboard');  // Sprint 118'de eklendi
```

### Admin Panel (Sprint 118 — Tamamlandı ✅)
- `client/js/admin/AdminPanel.svelte` — tek bileşen, 8 sekme
- `client/js/admin/admin-svelte.ts` — mount shim
- `client/js/admin/index.ts` — yalnızca admin-svelte.ts'i re-export eder
- Eski 10 TS dosyası → `client/_archived_legacy/admin_legacy/` (arşivlendi)

### Socket Handler Error Handling (Sprint 118 — Tamamlandı ✅)
Tüm 18 handler'da try/catch var. Yeni handler yazarken pattern:
```typescript
socket.on('event:name', (payload) => {
  try {
    // işlem
  } catch (err) {
    logger.error({ event: 'event.name.error', err }, 'açıklama');
  }
});
```

### OpenAPI Spec (Sprint 118 — Tamamlandı ✅)
- `docs/api/openapi.yaml` — **1932 satır**, tam spec (merge edildi)
- Webhook, Plugin, Federation, Admin endpoint'leri dahil
- `docs/api/openapi-additions-s118.yaml` — kayıt amaçlı bırakıldı (içeriği openapi.yaml'a merge edildi)

---

## Tamamlanan İş — Sprint 119–120 ✅

Sprint 118 teknik borcu kapattı. Sprint 119'da dış kod inceleme bulguları düzeltildi; Sprint 120'de güvenlik katmanları entegre edildi:

| Kalem | Durum |
|-------|-------|
| Admin panel Svelte migration | ✅ Sprint 118 |
| Admin legacy dosyaları arşivlendi | ✅ Sprint 118 |
| Socket error handling (18/18) | ✅ Sprint 118 |
| Plugin test coverage | ✅ Sprint 118 |
| Helm chart | ✅ Sprint 118 |
| OpenAPI tam spec (merge edildi) | ✅ Sprint 118 |
| SECURITY.md placeholder'ları | ✅ Sprint 118 |
| _legacy/ temizliği (tüm dizinler) | ✅ Sprint 118 |
| Versiyon senkronizasyonu (1.118.0) | ✅ Sprint 118 |
| `.gitignore` eksikliği | ✅ Sprint 119 |
| Bot marketplace örnek seed botları | ✅ Sprint 119 |
| k6 gerçekçi yük testi scripti | ✅ Sprint 119 |
| Production hazırlık belgesi | ✅ Sprint 119 |
| wsConnectionLimitMiddleware (D5) entegrasyon | ✅ Sprint 120 |
| federationRateLimit (D6) entegrasyon | ✅ Sprint 120 |
| contentSanitizer (T5) entegrasyon | ✅ Sprint 120 |
| i18n sistemi (Svelte5 Runes) | ✅ Sprint 120 |
| VoicePanel PTT/SS refactor | ✅ Sprint 120 |
| Vault audit log (ADR-0012) | ✅ Sprint 120 |
| Mediasoup config refactor (simulcast) | ✅ Sprint 120 |
| Versiyon senkronizasyonu (1.120.0) | ✅ Sprint 120 |
| i18n eksik çeviriler tamamlandı (ja/ko/zh/ru/pt/de/fr) | ✅ Sprint 121 |
| Artık CSS dosyaları silindi (sprint91.css, sprint92.css) | ✅ Sprint 121 |
| CHANGELOG tarih hatası düzeltildi | ✅ Sprint 121 |
| SECURITY.md sürüm tablosu düzeltildi (1.117.x EOL) | ✅ Sprint 121 |
| Versiyon senkronizasyonu (1.121.0) | ✅ Sprint 121 |
| i18n eksik çeviriler tamamlandı (es/de/fr/ja/ko/zh/ru/pt) | ✅ Sprint 120 |
| MAX_UNAUTH_WS_PER_IP wsConnectionLimit'e eklendi | ✅ Sprint 120 |
| style.css sprint91/92 çift import düzeltildi | ✅ Sprint 120 |
| Mobile App Store pipeline | ✅ Sprint 115 |
| Electron notarization pipeline | ✅ Sprint 115 |
| E2EE production default | ✅ Sprint 115 |
| k6 baseline | ✅ Sprint 115 |
| CI/CD pipeline | ✅ Sprint 114 |

### Production'a Geçiş İçin Yapılacaklar (Kod değil, sahada test)

Bunlar kod eksikliği değil; gerçek ortamda doğrulama gerektiren maddelerdir:

| Madde | Durum | Açıklama |
|-------|-------|----------|
| ActivityPub / Mastodon interop | ⚠️ Bekliyor | `mastodon-activitypub.spec.ts` CI'da çalışmıyor; gerçek token gerekli |
| Mediasoup SFU ölçek testi | ⚠️ Bekliyor | `k6/mediasoup-sfu-load.js` staging'de çalıştırılmalı |
| Gerçek yük baseline | ⚠️ Bekliyor | Mevcut p95=61ms yalnızca CI/localhost; `k6/load-realistic.js` staging'de çalıştırılmalı |
| App Store yayını | ❌ Yapılmadı | Pipeline hazır; hesap ve içerik incelemesi gerekli |
| Bağımsız güvenlik denetimi | ❌ Yapılmadı | Kod mekanizmaları iyi; pentest yapılmamış |

Detaylar: `docs/PRODUCTION_READINESS.md`

---

## CI/CD Durumu

| Job | Durum |
|-----|-------|
| lint-and-typecheck | ✅ |
| server-tests (155 dosya) | ✅ |
| structural-guards | ✅ (check-no-legacy dahil) |
| e2e-tests (27 spec) | ✅ |
| security-audit | ✅ |
| mobile-publish (tag-driven) | ✅ |
| electron-release (tag-driven) | ✅ |

---

## Deployment

```bash
# Docker Compose (development)
docker-compose up -d

# Docker Compose (production cluster)
docker-compose -f docker-compose.cluster.yml up -d

# Kubernetes (ham manifest)
kubectl apply -k k8s/

# Kubernetes (Helm — Sprint 118'de eklendi)
helm dependency update ./k8s/helm/bridge
helm install bridge ./k8s/helm/bridge --namespace bridge \
  --set secrets.JWT_SECRET="$(openssl rand -hex 32)" \
  --set secrets.REFRESH_SECRET="$(openssl rand -hex 32)"
```

---

## Önemli Dosyalar

| Dosya | İçerik |
|-------|--------|
| `CHANGELOG.md` | Sprint bazlı değişiklik geçmişi |
| `ROADMAP.md` | Uzun vadeli plan |
| `SECURITY.md` | Güvenlik politikası (Sprint 118'de temizlendi) |
| `docs/DATABASE_SCHEMA.md` | 64 tablo, ilişki diyagramı |
| `docs/api/openapi.yaml` | Ana OpenAPI spec (1932 satır — tam) |
| `docs/ADR-*.md` | 13 Architecture Decision Record |
| `DEPLOYMENT_GUIDE.md` | Production deployment adımları |
| `DEVELOPER_GUIDE.md` | Geliştirici kurulumu |
| `k8s/helm/bridge/` | Helm chart (Sprint 118 — yeni) |
| `client/_archived_legacy/` | Arşivlenmiş eski dosyalar (aktif değil) |
