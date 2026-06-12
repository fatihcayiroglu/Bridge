# Sprint 10 — Değişiklik Günlüğü

## Özet
**Odak:** Güvenlik sertleştirme + performans + güvenilirlik

---

## 1. SVG Upload Sanitizasyonu

### Yeni: `server/lib/svgSanitizer.js`
- `sanitizeSvgString(content)` — tehlikeli element ve attribute'ları strip eder
- `sanitizeSvgFile(filePath)` — dosyayı okur, temizler, yazar; temizlenemezse rejects
- `isSvgSafe(content)` — hızlı boolean güvenlik kontrolü

**Strip edilen tehditler:**
- `<script>` ve tüm içeriği
- `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`
- `on*` event handler'ları (onerror, onload, onclick, vb.)
- `javascript:` URI'leri
- `xlink:href` harici referanslar
- `CDATA` bölümleri
- Tehlikeli processing instruction'ları

**Strateji:** reject-only yerine strip-then-verify — meşru SVG'ler görsel içeriği korunur, sadece tehlikeli kısımlar çıkarılır. Temizlik sonrası hâlâ tehlike varsa dosya reddedilir.

### Güncellendi: `server/routes/upload.js`
- Küçük upload ve chunked upload pipeline'larına SVG sanitize adımı eklendi
- `sanitizeSvgFile()` → `scanFile()` sonrası çalışır
- Temizleme yapıldıysa audit log'a yazar

### Güncellendi: `server/app/createApp.js`
- SVG statik servis'e özel güvenlik header'ları eklendi:
  ```
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
  X-Content-Type-Options: nosniff
  ```
- SVG dosyaları artık inline script çalıştıramaz

---

## 2. Refresh Token Ailesi (Family) Invalidation

### Güncellendi: `server/middleware/auth.js`

**`makeRefreshToken()`**
- Artık her yeni token oluşturulunca `family` UUID atanır
- Login başına yeni aile → farklı cihazlar farklı ailelerden

**`rotateRefreshToken()`**
- Rotation sırasında yeni token eski token'ın family'sini miras alır
- **Reuse detection'da:**
  - Önceki: tüm kullanıcı token'ları siliniyordu (tüm cihazlar logout)
  - Yeni: sadece saldırıya uğrayan aile silinir → diğer cihazlar etkilenmez

### Güncellendi: `server/db/repositories/AuthRepository.js`
- `revokeByFamily(family)` — aile bazlı toplu revoke
- `findByFamily(family)` — aile sorgulama

### Güncellendi: `server/db/repositories/types/repositories.d.ts`
- `revokeByFamily` ve `findByFamily` tip tanımları eklendi

---

## 3. Virtual Scroll — Aktif Edildi

### Taşındı: `client/js/core/messages/virtual-scroll.js`
- Kaynak: `client/js/core/v43/virtual-scroll.js` (v43'te monkey-patch olarak optionaldi)
- Hedef: `client/js/core/messages/` (Sprint 10'dan itibaren varsayılan aktif)

**Teknik özellikler:**
- DOM penceresi: WINDOW_SIZE = 80 mesaj
- Tüm mesajlar `_allMessages[]` in-memory dizisinde
- Spacer div'lerle gerçek scroll yüksekliği korunur
- `_bridgeVS.stats()` debug API'si

**Etki:** 5000 mesajlı kanalda DOM node sayısı 80'de sabit kalır (~60x daha az DOM)

### Güncellendi: `client/index.html`, `scripts/build.js`
- `messages/virtual-scroll.js` script listesine ve chunk-core'a eklendi

---

## 4. Offline Message Queue

### Yeni: `client/js/core/offline-queue.js`
- Socket kopukken `sendMessage()` kuyruğa alır
- `_enqueueOfflineMessage()` — harici erişim için global API
- `_flushPendingQueue()` — reconnect'te otomatik çağrılır
- Kuyrukta mesaj varken floating badge gösterir
- `document.visibilitychange` ve `window.online` event'lerini de dinler
- MAX_QUEUE_SIZE = 50, FLUSH_DELAY_MS = 300

### Güncellendi: `client/js/core/socket.js`
- `socket.on('reconnect')` handler genişletildi:
  - SW Background Sync tetiklenir (`bridge-outbox`)
  - Aktif kanalın mesajları yeniden yüklenir (missed message sync)
  - `_flushPendingQueue()` çağrılır

---

## 5. E2E Testler (Playwright)

### Yeni: `e2e/tests/security.spec.js`
- CSP header varlığı ve direktifleri (6 test)
- SVG XSS upload reddi (4 test)
- SVG statik servis header'ları
- httpOnly cookie JS erişilemezliği (page.evaluate)
- Token family invalidation akışı (2 test)
- Upload MIME validasyonu (4 test)

**Toplam: 20 test**

### Yeni: `e2e/tests/offline-queue.spec.js`
- Mesaj persistence (API seviyesi)
- Offline queue badge UI testi
- Service Worker outbox varlığı
- Reconnect pagination API testleri

**Toplam: 9 test**

### Yeni: `e2e/tests/virtual-scroll.spec.js`
- Virtual scroll modül yüklenme
- DOM node limiti (100+ mesaj)
- Pagination API testleri

**Toplam: 8 test**

### Güncellendi: `e2e/global.setup.js`
- Sprint 9 httpOnly cookie değişikliğiyle uyumlu (refreshToken artık body'de aranmıyor)
- Username ile de login denenebilir (email fallback)

### Güncellendi: `e2e/helpers/bridge.js`
- `createTestServer` ve `createTestChannel` BASE_URL kullanır (relative path bug düzeltildi)

---

## 6. Unit Testler

### Yeni: `server/tests/sprint10.test.js`
- `sanitizeSvgString` — 8 test (her tehdit vektörü)
- `sanitizeSvgFile` — 3 test (dosya yazma)
- `makeRefreshToken` — family ataması (2 test)
- `rotateRefreshToken` — family miras + reuse (2 test)
- `AuthRepository.revokeByFamily` — (2 test)

**Toplam: 17 yeni unit test**

---

## Dosya Değişiklik Özeti

| Dosya | Değişiklik |
|-------|-----------|
| `server/lib/svgSanitizer.js` | **YENİ** |
| `server/routes/upload.js` | SVG sanitize pipeline eklendi |
| `server/app/createApp.js` | SVG static header + cookie-parser |
| `server/middleware/auth.js` | family invalidation |
| `server/db/repositories/AuthRepository.js` | revokeByFamily, findByFamily |
| `server/db/repositories/types/repositories.d.ts` | tip tanımları |
| `client/js/core/messages/virtual-scroll.js` | **YENİ** (v43'ten taşındı) |
| `client/js/core/offline-queue.js` | **YENİ** |
| `client/js/core/socket.js` | reconnect handler genişletildi |
| `client/index.html` | yeni modüller eklendi |
| `scripts/build.js` | chunk-core güncellendi |
| `e2e/tests/security.spec.js` | **YENİ** |
| `e2e/tests/offline-queue.spec.js` | **YENİ** |
| `e2e/tests/virtual-scroll.spec.js` | **YENİ** |
| `e2e/global.setup.js` | Sprint 9 uyumluluğu |
| `e2e/helpers/bridge.js` | BASE_URL düzeltmesi |
| `server/tests/sprint10.test.js` | **YENİ** |

---

## Sprint 11 Önerileri
1. **TypeScript migration** — kademeli, `.js` → `.ts` modül bazlı
2. **Web Push Notifications** — VAPID + service worker push event
3. **Embed önbellekleme** — link preview'ları Redis/SQLite'ta cache
4. **E2E coverage** — DM akışları, ses kanalı, file upload UI testi
5. **DB transaction wrapper** — Unit of Work pattern, partial failure önlemi
