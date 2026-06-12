# BRIDGE12 — Oturum 12: Eksik Entegrasyonlar & Ses

**Tarih:** 2026-05-10
**Durum:** ✅ Tamamlandı

---

## Yapılan Değişiklikler

### ✅ 1. `client/js/core/voice.ts` — VoiceActivityUI köprü entegrasyonu

**Sorun:** DELIVERY.md'de belirtilen `VoiceActivityUI.init(socket)` ve
`_bridgeStartLocalVAD` / `_bridgeStopLocalVAD` çağrıları yalnızca
`channel-list.ts`'te uygulanmıştı. `voice.ts` bu API'yi kendi tarafında
sunmuyordu; farklı yükleme sıralarında entegrasyon kopabilirdi.

**Çözüm:** `voice.ts` sonuna `_installVoiceActivityBridge()` IIFE eklendi:

```ts
window._bridgeVoiceOnJoin(localStream, channelId);  // kanal join sonrasında
window._bridgeVoiceOnLeave();                        // kanal leave sırasında
```

- `VoiceActivityUI.init(socket)` → tek seferlik başlatma (`_bridgeVADInitialized` bayrağı)
- `_bridgeStartLocalVAD(stream, channelId)` → mikrofon VAD'a iletilir
- `_bridgeVADCleanup()` → leave sırasında güvenli temizleme
- `_bridgeVoiceActivityInstalled` bayrağı ile çift kurulum engellenir

**Dosya:** `client/js/core/voice.ts`

---

### ✅ 2. `ecosystem.config.js` — Mediasoup worker fork zorunluluğu

**Sorun:** `instances: 'max'` + `exec_mode: 'cluster'` tüm uygulamaya
uygulanıyordu. Mediasoup, PM2 cluster fork'larıyla uyumsuzdur: her fork
kendi mediasoup worker seti oluşturur → RTP port çakışması → ses yönlendirme
hatası.

**Çözüm:** Uygulama iki ayrı PM2 sürecine bölündü:

| Süreç | `exec_mode` | `instances` | Açıklama |
|-------|------------|-------------|----------|
| `bridge` | `cluster` | `max` | Ana HTTP + Socket.IO — cluster ölçekleme |
| `bridge-sfu` | **`fork`** | **`1`** | Mediasoup — fork zorunlu, iç worker'lar C++ düzeyinde |

`MEDIASOUP_WORKERS` env değişkeni ile iç worker sayısı ayarlanabilir
(mediasoup.ts: `Math.min(MEDIASOUP_WORKERS, 4)`).

**Dosya:** `ecosystem.config.js`

---

### ✅ 3. `capacitor.config.js` — Canonical yapı netleştirildi

**Sorun:** İki config arasında `webDir` uyumsuzluğu:
- `capacitor.config.js` (kök): `webDir: 'mobile/www'` (kök'ten relative) ✓
- `mobile/capacitor.config.ts`: `webDir: 'www'` (mobile/'dan relative) ✓

Her ikisi de kendi bağlamında doğruydu, ancak:
- `Camera` plugin'i kök config'de yoktu
- Kök config'deki yorum satırları güncel değildi

**Çözüm:**
- Kök `capacitor.config.js` tamamen yeniden yazıldı
- `Camera` plugin bloğu eklendi (mobile/capacitor.config.ts ile senkron)
- Deep link açıklamaları güncellendi
- `webDir: 'mobile/www'` (kökten relative) → doğru ve açıkça belgelenmiş
- **Canonical kaynak:** `mobile/capacitor.config.ts` — tüm değişiklikler orada

**Dosya:** `capacitor.config.js`

---

### ✅ 4. `server/socket/index.ts` — Room memory leak düzeltmesi

**Sorun:** `channel:leave` eventi yoktu. Kullanıcı:
- Disconnect olmadan başka bir şeye geçerse (`channel:join` yeni odayı ekliyor
  ve eskiyi bırakıyor — bu zaten doğru)
- Ama bazı akışlarda (sayfa refresh olmadan SPA navigasyon) `currentChannel`
  sıfırlanmıyordu → `socket.rooms` seti kayıt tutuyordu

**Çözüm:**

```ts
socket.on('channel:leave', (channelId) => {
  try {
    if (channelId && typeof channelId === 'string') {
      socket.leave(`channel:${channelId}`);
      if ((socket as any).currentChannel === channelId) {
        (socket as any).currentChannel = null;
      }
    }
  } catch {}
});
```

- Mevcut cleanup mekanizmaları zaten sağlamdı:
  - `disconnect` → `infra.ts` `handleDisconnect` → tüm room'lardan çıkar
  - `channel:join` → yeni kanal join öncesinde eski kanaldan çıkar
  - `typingTimers`, `_socketRateStore`, `_ipRateStore` → periyodik cleanup'ları var
- Bu ek event: explicit leave sinyali gönderen client tarafları için savunma katmanı

**Dosya:** `server/socket/index.ts`

---

## Kapsam Dışı — Sonraki Oturumlar

### Oturum 13 — TS/JS dosya çoğaltmasını çöz (~3–5 saat)

- **Karar gerekiyor:** `client/js/core/` içinde 73 `.ts` + 79 `.js` paralel dosya
  - `.js` dosyaları esbuild çıktısıysa → `tsconfig` + `scripts/build.js`'e bağla, elle yazılmış `.js` kaldır
  - Bazıları elle yazılmış olabilir → tek tek inceleme gerekiyor
- **SQLite katmanı:** `server/db/sqlite/` — PostgreSQL geçişi tamamlandıysa silinmeli
  - `server/db/sqlite/migrations/` içinde 3 migration dosyası var
  - PostgreSQL migration'ları paralel mevcut → birini legacy olarak işaretle
- **v41/v42/v43/v44 shim klasörleri:** `client/js/core/v41..v44/`
  - Her birinde `.ts` + `.js` çiftleri var
  - İçerik aktif mi, boş gövde mi, ne için? → belgeleme veya konsolidasyon

### Oturum 13 (devam) — `@ts-nocheck` temizliği

- `server/lib/` — 17 dosya (Oturum 11'de yapılmadı)
- `server/db/` — 8 dosya
- `server/app/createApp.ts`
- `server/plugins/loader.ts`

### Oturum 14 — İyileştirme: Swagger & bakım borcu (~2–3 saat)

- `server/lib/swagger.ts` (61KB elle yazılmış) → `express-openapi` veya JSDoc decorator
- `node-fetch` → native `fetch` (Node 22+) — tüm server kodu
- Rate limit granülerliği: per-user IP tracking (`server/middleware/rateLimit.ts`)
- `server/routes/federation.ts` (31KB) → klasör bazlı modüler yapı

### Oturum 15+ — Uzun vade

- `scripts/build.js` → esbuild code splitting + lazy loading (`chunk-heavy.js`)
- CDN + WebP otomatik dönüşümü (sharp entegrasyonu)
- ARIA labels + klavye navigasyonu (`A11Y_AUDIT_CHECKLIST.md`)
- OpenTelemetry + Sentry entegrasyonu

---

## Değişen Dosyalar (Oturum 12)

```
client/js/core/voice.ts          ← VoiceActivityUI köprüsü eklendi
ecosystem.config.js              ← bridge-sfu fork süreci eklendi
capacitor.config.js              ← canonical yapı netleştirildi + Camera plugin
server/socket/index.ts           ← channel:leave eventi eklendi
BRIDGE12.md                      ← bu dosya
```
