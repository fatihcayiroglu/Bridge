# Sprint 96 — message:ack `_tmpId` Echo · Event Push Notifications · Mobile Native Push + Swipe

## 1. message:ack Server-Side `_tmpId` Echo

### Sorun
Client optimistic render'da `msg-${tmpId}` DOM elementi oluşturuyordu; ancak server
`message:ack` eventi içine `tmpId` koymadığı için `_markPendingSent` hiç tetiklenmiyordu.
Pending badge (⏳) kalıcı görünüyor, mesaj "gönderilmedi" zannediliyordu.

### Değişen Dosyalar
- **`server/socket/handlers/messages.ts`**
  - `SendMessagePayload` arayüzüne `_tmpId?: string` eklendi
  - Destructuring'e `_tmpId` dahil edildi
  - `sendAck` çağrısına `tmpId` alanı eklendi; `ackId` olmayan ancak `_tmpId` gönderen
    client'lar için `sendTmpAck` lightweight path eklendi

- **`server/lib/deliveryAck.ts`**
  - `AckRecord` interface'ine `tmpId?: string` eklendi
  - `sendAck` — `tmpId` varsa event payload'a dahil eder
  - `sendTmpAck(socket, tmpId, messageId, channelId)` — yeni fonksiyon; ackId olmaksızın
    sadece DOM senkronizasyonu için ACK gönderir (Redis'e yazmaz)

- **`client/js/core/messages/input.ts`**
  - Ack listener: `d.tmpId` kontrolü eklendi (daha önce yalnızca `d.ackId` bakıyordu)
  - `message:send` / `message:reply` emit'leri zaten `_tmpId` gönderiyordu — değişmedi

### Davranış
```
Client emit:  message:send { channelId, content, serverId, _tmpId: "pending-xyz" }
Server:       DB'ye yaz → broadcast → sendTmpAck(socket, "pending-xyz", realId, channelId)
Client recv:  message:ack { tmpId: "pending-xyz", messageId: "abc123", ... }
              → _markPendingSent("pending-xyz") → ⏳ badge kaldır, ✓ göster
```

---

## 2. Etkinlik Öncesi Push Bildirimleri

### Yeni Dosya: `server/jobs/eventReminders.ts`
Her dakika çalışan bir `setInterval` job. `server_events` tablosundan başlamak üzere
olan etkinlikleri (±30 saniyelik toleransla 5 ve 15 dakika öncesinde) tespit eder;
`server_event_rsvp` tablosundan `going` veya `interested` RSVP'si olan kullanıcılara
`sendPushToUser` aracılığıyla Web Push + FCM + APNs bildirim gönderir.

**Duplicate önleme:** Redis'te `evtremind:{eventId}:{windowMin}` anahtarı 2 dakika TTL
ile saklanır. Multi-instance deploy'da da güvenli çalışır.

**Bildirim payload:**
```json
{
  "title": "🗓️ Etkinlik Adı",
  "body":  "Etkinlik 5 dakika içinde başlıyor!",
  "data":  { "type": "event:reminder", "eventId": "...", "url": "/app?server=...&event=..." }
}
```

### `server/index.ts`
`startEventReminderJob()` import'u ve çağrısı eklendi.

---

## 3. Mobile Native Push + Enhanced Swipe Gesture

### `client/js/core/mobile-ux.ts`

#### `initNativePush()` — yeni fonksiyon
Capacitor `PushNotifications` plugin'ini kullanarak:
- `register()` → APNs/FCM token alır
- `registration` event → `/api/mobile/push/register` endpoint'ine token + platform gönderir
- `pushNotificationReceived` → foreground bildirimler toast olarak gösterilir
- `pushNotificationActionPerformed` → bildirime tıklandığında `navigateToUrl` çağrılır

`initMobileUX()` içinden otomatik çağrılır; Capacitor yoksa sessizce atlanır.

#### `initSwipeNavigation()` — geliştirildi (Sprint 96)
| Hareket | Sonuç |
|---|---|
| Sol köşeden (< 20px) sağa swipe | Server list açılır |
| Sol kenardan (20–60px) sağa swipe | Channel sidebar açılır |
| Sağ kenardan (> w-40px) sola swipe | Member list açılır |
| Herhangi yerden sola swipe | Tüm paneller kapanır |

Velocity threshold (0.3 px/ms) eklendi — yavaş parmak sürükleme ile swipe ayırt edilir.
Dikey dominant hareketler (scroll) otomatik elenir.

**`CapacitorWindow` interface** — `PushNotifications` plugin tipi eklendi.

---

## Etkilenen Dosyalar Özeti

| Dosya | Değişiklik |
|---|---|
| `server/lib/deliveryAck.ts` | `AckRecord.tmpId`, `sendTmpAck()` |
| `server/socket/handlers/messages.ts` | `_tmpId` destructuring + ACK path |
| `client/js/core/messages/input.ts` | Ack listener `tmpId` kontrolü |
| `server/jobs/eventReminders.ts` | **YENİ** — etkinlik öncesi push job |
| `server/index.ts` | `startEventReminderJob()` kaydı |
| `client/js/core/mobile-ux.ts` | `initNativePush()`, gelişmiş swipe |

---

## Sprint 96 — Eksiklik Düzeltmeleri

### Fix 1: `server/tests/jobs-eventReminders.test.ts` — YENİ
7 test case: başlatma, 5dk/15dk window push, `not_going` filtresi, Redis duplicate önleme,
TTL=300 doğrulama, RSVP boş skip, push hatası sonrası devam.

### Fix 2: `client/js/mobile.ts` — Swipe çakışması giderildi
`document.touchstart/touchmove/touchend` swipe bloğu `if (!_isCapacitor)` guard ile
sarmalandı. Capacitor ortamında `mobile-ux.ts`'deki gelişmiş swipe aktif kalır, double-fire olmaz.

### Fix 3: `client/js/core/mobile-ux.ts` — `registrationError` listener eklendi
Capacitor `PushNotifications.registrationError` eventi artık yakalanıyor; izin reddi veya
cihaz desteği yoksa sessizce uyarı loglanır, uygulama çökmez.

### Fix 4: Redis TTL 2dk → 5dk (`server/jobs/eventReminders.ts`)
Duplicate önleme flag'i 120s → 300s. 1dk interval + ±30s tolerans + multi-instance
deployment marjı hesaba katıldı.
