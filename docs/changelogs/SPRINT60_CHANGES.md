# Sprint 60 — Değişiklik Özeti

## 🔴 Acil Düzeltmeler

### ActivityPub DM Routing (`server/routes/federation/inbox-handlers.ts`)
- `_isApDm()` yardımcı fonksiyonu eklendi: `to[]` içinde `#Public` veya `/followers` URL yoksa DM olarak tanımlanır
- `handleApCreate()` içine DM dalı eklendi: remote kullanıcıdan local kullanıcıya gelen DM'ler artık `Dms.findOrCreateConversation()` + `Dms.insertMessage()` ile kaydediliyor
- Başarılı DM alımında `Notifications.insertInbox()` ile bildirim oluşturuluyor
- Genel federated note akışı bozulmadan korundu; yerel kullanıcı eşleşmezse uyarı loglanıyor
- `Dms` ve `Users` repository'leri import'a eklendi

### E2EE Toggle Timing Fix (`client/js/core/e2e.ts`, `client/js/core/dm.ts`)
- `e2e.ts` — `autoInit()` ve `setup()` başarıyla tamamlandığında `bridge:e2e:ready` CustomEvent dispatch ediyor
- `dm.ts` — `window.addEventListener('bridge:e2e:ready', _updateE2EBanner)` ile DM ekranı açıkken lazy init olan E2EE artık toggle'ı güncelliyor
- Önceki sorun: `_updateE2EBanner()` yalnızca `openDm()` çağrısında tetikleniyordu; BridgeE2E sonradan init olursa buton görünmez kalıyordu

## 🟡 Orta Öncelikli

### Swagger Coverage %69 → %74 (eşik %65 → %70)
Annotasyon eklenen dosyalar (`server/routes/`):
- **`userConnections.ts`** — 5 route: `GET /users/:userId/connections`, `GET /me/connections`, `PUT /me/connections/:platform`, `DELETE /me/connections/:platform`, `GET /connections/platforms`
- **`email.ts`** — 5 route: `POST /email/add`, `GET /email/verify`, `POST /email/resend`, `POST /email/forgot`, `POST /email/reset-password`
- **`categories.ts`** — 5 route: `GET`, `POST`, `PATCH /:catId`, `DELETE /:catId`, `POST /reorder`

`scripts/check-swagger-coverage.ts`: `MIN_COVERAGE_PCT` 65 → 70 güncellendi

### WebAuthn Passkey Butonu (`client/index.html`, `client/css/modules/auth.css`)
- Login formuna `BridgeWebAuthn.passkeyLogin()` butonu eklendi
- Register formuna `BridgeWebAuthn.registerPasskey()` butonu eklendi
- Her iki forma "veya" ayracı (`.auth-divider`) eklendi
- `auth.css`'e `.btn-secondary`, `.passkey-btn`, `.auth-divider` stilleri eklendi
- `BridgeWebAuthn` API'si önceden `window.BridgeWebAuthn` olarak expose edilmişti (Sprint 33 uyumluluğu)

### Spotify Widget (`server/lib/linkPreview.ts`, `client/js/core/messages/embeds.ts`)
- `linkPreview.ts` — `open.spotify.com` URL'leri HTTP fetch yapılmadan erken dönüyor; `type: 'spotify'` + `embedSrc` + `embedHeight` alanları set ediliyor
  - Desteklenen tipler: `track`, `album`, `playlist`, `episode`, `artist`
  - Tek track/episode → `height: 80`, diğerleri → `height: 352`
- `embeds.ts` — `renderEmbed()` başına Spotify iframe renderer eklendi; resmi Spotify embed URL'i kullanılıyor

## 🟢 Temizlik

### `asyncHandler.ts` (tamamlandı — Sprint 59'da silindi)
Dosya ve tüm referanslar zaten kaldırılmıştı; ek işlem gerekmedi.

### `check-swagger-coverage.ts` CI Debug Çıktısı
- `CI_MODE && routeCoverage < MIN_COVERAGE_PCT` dalına annotasyonsuz dosya listesi eklendi (max 10, route sayısına göre sıralı)
- CI loglarında başarısızlık nedenini görmek artık kolaylaşıyor

---

**Etkilenen dosyalar:** 9  
**Net ekleme:** ~190 satır  
**Net silme:** ~10 satır  
