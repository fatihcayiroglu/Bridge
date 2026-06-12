# Sprint 89 — Güvenlik & Güvenilirlik Düzeltmeleri

Bu sprint, önceki code review'da tespit edilen 6 eksikliği kapatır.

---

## Düzeltmeler

### 1. SFU Worker Crash Recovery Race Condition (`server/socket/handlers/mediasoup/workers.ts`)

**Problem:** `_restartWorker(index)` crash sonrası yeni worker oluşturulana kadar geçen ~100ms aralıkta `getNextWorkerWithIndex()` dead worker referansına erişip "worker closed" hatasına yol açıyordu. `sfuWorkers[index] = newWorker` ataması Promise suspend nedeniyle JS event loop'a yeniden girildiğinde henüz tamamlanmamış olabiliyordu.

**Çözüm:** `_restartingSlots: Set<number>` eklendi. Restart başladığında slot kilitlenir; `getNextWorkerWithIndex()` kilitli slot'ları atlar. Yeni worker hazır olunca lock kaldırılır, atama atomik hale getirilir. `isSFUReady()` de kilitli slotları hesaba katar.

---

### 2. Bot Token Cache Flooding (`server/middleware/csrf.ts`)

**Problem:** CSRF bot token cache'i FIFO eviction kullanıyordu. 10.001 farklı sahte token göndererek aktif botların gerçek token'larını cache'den evict etmek mümkündü.

**Çözüm:** FIFO → LRU ile değiştirildi. Her `_getBotTokenCached()` çağrısında entry silинir ve sona taşınır. Eviction sırasında daima en uzun süredir kullanılmayan atılır. Cache kapasitesi 10.000 → 1.000'e indirildi (aktif bot sayısıyla daha orantılı).

---

### 3. `search.ts` TypeScript `any` Temizliği + Membership Guard (`server/routes/search.ts`)

**Problem:** `parseSearchQuery`, `highlightSnippet`, `safeJSON` fonksiyonları implicit `any` parametresi alıyordu. `results` nesnesi `Record<string,any>` tipindeydi. Ayrıca `serverId` filtresi caller'ın o sunucuya üye olup olmadığını açıkça doğrulamıyordu (zincir zaten kesiştiriyordu ama hata mesajı yoktu).

**Çözüm:** Tüm `any` türleri kaldırıldı; açık arayüzler tanımlandı. `serverId` filtresi için explicit 403 dönülüyor.

---

### 4. Versiyon Güncelleme (`package.json`)

`1.87.0` → `1.88.0` (Sprint 88 değişikliklerini doğru yansıtıyor).

> Not: Sprint 89 sürümü `1.89.0` olacak; bu düzeltme geride kalan Sprint 88 semantic versioning hatasını da kapatıyor.

---

### 5. Kanal Mesajları E2EE — Opt-in (`server/lib/channelE2EE.ts`, `server/socket/handlers/channelE2EEHandlers.ts`)

**Problem:** Kanal (text channel) mesajları server üzerinde plaintext saklanıyordu. Yalnızca DM'de X3DH tabanlı E2EE mevcuttu. Discord'dan gerçek anlamda ayrışmak için kanal mesajlarında da E2EE gerekiyor.

**Çözüm:** Server-side opak saklama altyapısı:
- `channelE2EE.ts`: Redis-backed wrappedKey paketi yönetimi (epoch, per-user sarmalanmış anahtar).
- `channelE2EEHandlers.ts`: 4 socket event:
  - `channel:e2ee:setup` — AES-KW ile sarmalanmış kanal anahtarlarını kaydet
  - `channel:e2ee:keys:get` — çağıranın kendi wrappedKey'ini iste
  - `channel:e2ee:keys:add` — yeni üye için anahtar ekle
  - `channel:e2ee:status` — E2EE aktif mi?
- `messages.ts`: `type: 'e2ee'` mesajlar `encryptedContent + iv` ile kabul edilir; `content` alanı boş bırakılır (server plaintext görmez).

**Güvenlik garantisi:** Server operatörü dahil kimse kanal içeriğini okuyamaz. Key escrow yok.

---

### 6. Server-side Delivery ACK (`server/lib/deliveryAck.ts`)

**Problem:** Gönderen client, mesajın DB'ye yazıldığını ve broadcast edildiğini doğrulayamıyordu. Bağlantı kopması halinde mesaj sessizce kaybolabiliyordu.

**Çözüm:** Opt-in `ackId` sistemi:
- Client `message:send` payload'una isteğe bağlı `ackId` (UUID) ekler.
- Server mesajı DB'ye kaydedip broadcast ettikten sonra `message:ack` eventi gönderir.
- Redis'te 5 dakika TTL ile deduplication: aynı `ackId` ikinci kez gelirse DB'ye yeniden yazılmaz.
- `ackId` olmayan mesajlar eski davranışla çalışır — geriye dönük uyumlu.

---

## Dosya Özeti

| Dosya | Değişiklik |
|-------|-----------|
| `server/socket/handlers/mediasoup/workers.ts` | Race condition fix — `_restartingSlots` lock mekanizması |
| `server/middleware/csrf.ts` | FIFO → LRU cache eviction |
| `server/routes/search.ts` | `any` temizliği + explicit membership guard |
| `package.json` | `1.87.0` → `1.88.0` |
| `server/lib/channelE2EE.ts` | **YENİ** — Kanal E2EE anahtar yönetimi |
| `server/socket/handlers/channelE2EEHandlers.ts` | **YENİ** — E2EE socket handler'ları |
| `server/socket/handlers/messages.ts` | E2EE tip desteği + delivery ACK |
| `server/lib/deliveryAck.ts` | **YENİ** — Server-side delivery ACK |
| `server/socket/index.ts` | E2EE handler kaydı |
