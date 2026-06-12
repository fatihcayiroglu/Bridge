# Sprint 76 Değişiklikleri

## 🎯 Swagger API Dokümantasyonu — %100 Coverage

Sprint 75'te %74 olan Swagger coverage bu sprint ile **%100'e** tamamlandı.

### Annotate edilen dosyalar (37 dosya, 321 endpoint)

**Yeni tam annotasyon:**
- `activity.ts` — aktivite CRUD + server/user endpoints
- `admin/core.ts` — captcha-stats endpoint eklendi
- `admin-ipban-routes.ts` — IP ban CRUD (doğru path'larla yeniden yazıldı)
- `admin/ipban.ts` — TypeScript IP ban route tamamlandı
- `admin/sfu.ts` — mediasoup worker/room yönetimi
- `admin/federation-acl.ts` — whitelist/blacklist DELETE endpoint eklendi
- `ai/index.ts` — chat, models, usage endpoints
- `ai/moderation.ts` — AI içerik moderasyon
- `ai/streaming.ts` — SSE stream + cancel
- `automod.ts` — POST (kural oluştur) + PATCH/DELETE (kural güncelle/sil)
- `bridge.ts` — config, status, version
- `channelPerms/bulk.ts` — bulk-sync, preview, batch, export, import
- `channelPerms/overrides.ts` — kanal izin override CRUD + audit-log + inheritance
- `channels.ts` — kanal CRUD tamamlandı
- `client-error.ts` — hata raporlama + admin listeleme
- `customEmoji.ts` — GET /all + GET / (sayfalı) eklendi
- `federation/peers.ts` — info, servers, stats, peers CRUD, discover, ping, health, join/fetch-remote
- `federation/social.ts` — follow, following, followers, like, announce, timeline, notifications
- `health.ts` — live, ready, stats, server/:sid, ice-config
- `interactions.ts` — webhook alıcı + callback
- `invitePreview.ts` — davet önizleme HTML sayfası
- `linkPreview.ts` — URL önizleme + allowed domains
- `media.ts` — proxy, GIF arama, GIF trending
- `onboarding.ts` — GET/PUT sorular + status + complete
- `pins.ts` — liste + kaldır
- `podcast.ts` — RSS, JSON feed, embed, episodes CRUD, settings, record start/stop/status
- `polls.ts` — early-end endpoint eklendi
- `scheduled.ts` — POST (yeni mesaj oluştur) eklendi
- `semantic.ts` — search, digest, engagement
- `serverAssets.ts` — banner ve icon-image CRUD
- `serverGifs.ts` — GIF favori CRUD tamamlandı
- `serverProfile.ts` — slug GET/PUT + by-slug lookup
- `servers/channels.ts` — kanal listele/oluştur/güncelle/sil
- `servers/core.ts` — sunucu CRUD + members + audit-log tamamlandı
- `servers/invites.ts` — davet oluştur, kullan, QR (HTML/JSON/PNG)
- `servers/og-image.ts` — Open Graph SVG endpoint
- `soundboard.ts` — ses listele/ekle/sil
- `stats.ts` — sunucu istatistikleri
- `voicemsg.ts` — yükleme + transkripsiyon
- `webauthn.ts` — Passkey kayıt/giriş döngüsü + credential CRUD
- `webpush.ts` — subscribe, unsubscribe, VAPID key, test

### Kapsam özeti

| Metrik | Sprint 75 | Sprint 76 |
|--------|-----------|-----------|
| Swagger coverage | %74 | **%100** |
| Annotate edilen endpoint | ~238 | **321** |
| Eksik dosya | 26 | **0** |

### Breaking changes
Yok. Tüm değişiklikler yalnızca JSDoc annotasyonları — runtime davranışı değişmedi.

### Açık maddeler (Sprint 77+)
- Plugin sandbox gerçek izolasyon (vm.runInNewContext / worker_threads)
- `server/lib/` TypeScript migrasyonu
- Canary/blue-green deployment stratejisi
- `console.log` → pino logger geçişi (77 adet)
- Mediasoup k6 yük testi
