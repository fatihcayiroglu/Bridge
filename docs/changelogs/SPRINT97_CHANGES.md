# Sprint 97 — 10/10 Eksiklik Kapatma

Sprint 96 incelemesinde tespit edilen 4 açık madde kapatıldı.

---

## 1. `serverEvents.ts` → Repository Pattern Tam Geçiş

**Sorun:** `server/routes/serverEvents.ts` içinde 10+ `db.query()` çağrısı vardı.
`ServerEventRepository` Sprint 96'da oluşturulmuş ama sadece eventReminders job'u
tarafından kullanılıyordu; route hâlâ `db.query()` ile çalışıyordu.

**Değişen Dosyalar:**

- **`server/db/repositories/ServerEventRepository.ts`** — Genişletildi:
  - `findByServer(serverId, userId, filter, limit, offset)` — filtreli liste + count
  - `findOne(eventId, serverId)` — creator join dahil
  - `exists(eventId, serverId)` — hafif varlık kontrolü
  - `findRsvpList(eventId)` — user detail join, max 50
  - `findMyRsvp(eventId, userId)` — tek kullanıcı RSVP
  - `upsertRsvp / deleteRsvp / countAttendees` — RSVP CRUD
  - `create / update / delete` — etkinlik CRUD
  - `update()` — field map ile kısmi güncelleme (PATCH için)
  - Sprint 96 metodları (`findScheduledInWindow`, `findAttendees`) korundu

- **`server/routes/serverEvents.ts`** — `db.query()` → `ServerEvents.*` tam geçiş.
  Tüm 7 endpoint artık sadece repository kullanıyor; `db` import'u kaldırıldı.

- **`server/db/repositories/index.ts`** — `ServerEvents` export'a eklendi.

---

## 2. `initNativePush` — Retry + Login Re-registration

**Sorun:** Token → server kaydı tek deneme `fetch().catch(() => {})` ile yapılıyordu.
Login sırasında auth token henüz yoksa kayıt sessizce düşüyordu; uygulama yeniden
başlatılana kadar push bildirimleri çalışmıyordu.

**Değişen:** `client/js/core/mobile-ux.ts`

- `registerPushToken(token, retries=3)` — bağımsız token kayıt fonksiyonu.
  5xx → exponential back-off (1s → 2s → 4s). 4xx → retry yapılmaz.
- `_cachedPushToken` — son alınan token modül scope'da saklanır.
- `_pushListenersAttached` — SPA navigasyon / hot-reload'da çift listener önler.
- `onNativePushLogin()` — **yeni export**. Login başarı callback'inden çağrılır.
  Token bellekteyse hemen `registerPushToken()` çağırır; yoksa `Push.register()`
  ile yeniden token talep eder.
- `Push.register()` çağrısı listener kurulduktan sonra yapılacak şekilde sıra düzeltildi.

**Kullanım (auth login callback'inden):**
```ts
import { onNativePushLogin } from './core/mobile-ux.js';
// ... login başarılı
onNativePushLogin();
```

---

## 3. `eventReminders.ts` — Graceful Shutdown

**Sorun:** `setInterval` handle saklanmıyordu; SIGTERM/SIGINT'te interval temizlenemiyordu.
Kubernetes rolling update'lerde pod kapanırken son birkaç saniye içinde iş başlayabiliyordu.

**Değişen:** `server/jobs/eventReminders.ts`

- `_reminderInterval` ve `_reminderInitTimer` — module-level handle değişkenleri.
- `stopEventReminderJob()` — **yeni export**. Her iki handle'ı temizler, loglama yapar.
- `startEventReminderJob()` — setTimeout/setInterval handle'ları artık değişkenlere atanıyor.

**Değişen:** `server/index.ts`

- `stopEventReminderJob` import edildi.
- `gracefulShutdown(signal)` fonksiyonu eklendi: `stopEventReminderJob()` → `server.close()` → `process.exit(0)`.
- 10s timeout sonrası zorla çıkış (`setTimeout(...).unref()`).
- `process.on('SIGTERM')` ve `process.on('SIGINT')` handler'ları eklendi.

---

## 4. ESLint `no-restricted-imports` — Repository Kuralı Aktif

**Sorun:** `REPOSITORY_PATTERN.md`'de belgelenen kural (`routes/` ve `socket/handlers/`'da
`db/loader` / `db/postgres` import yasak) ESLint'e eklenmemişti; `stats.ts`,
`announcement.ts`, `boosts.ts`, `bot-marketplace.ts` gibi dosyalar hâlâ `pool.query`
çağırıyordu, CI bunu yakalamıyordu.

**Değişen:** `server/eslint.config.js`

```js
{
  files: ['routes/**/*.ts', 'routes/**/*.js', 'socket/handlers/**/*.ts', ...],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['**/db/loader', '**/db/index', '**/db/postgres', '**/db/postgres/index*'],
        message: 'Route ve handler dosyalarında doğrudan DB erişimi yasak. db/repositories kullanın.',
      }]
    }]
  }
}
```

Bu kural `serverEvents.ts`'i zaten temizlenmiş olan tek yeni ihlal olarak yakalar.
Geriye kalan `stats.ts`, `announcement.ts`, `boosts.ts`, `bot-marketplace.ts`,
`spotify-oauth.ts` dosyaları gelecek sprint'lerin repository geçiş listesine girer;
CI artık yeni ihlal eklenmesini engeller.

---

## Etkilenen Dosyalar Özeti

| Dosya | Değişiklik |
|---|---|
| `server/db/repositories/ServerEventRepository.ts` | Route metodları eklendi (8 yeni) |
| `server/db/repositories/index.ts` | `ServerEvents` export eklendi |
| `server/routes/serverEvents.ts` | `db.query` → `ServerEvents.*` tam geçiş |
| `client/js/core/mobile-ux.ts` | `registerPushToken`, `onNativePushLogin`, listener guard |
| `server/jobs/eventReminders.ts` | `stopEventReminderJob`, handle değişkenleri |
| `server/index.ts` | Graceful shutdown + SIGTERM/SIGINT handler |
| `server/eslint.config.js` | `no-restricted-imports` route kuralı aktif |
