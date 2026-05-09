# Bridge — Session 9 Değişiklikleri

## Hata Düzeltmeleri

---

### Fix 1 🔴 `ecosystem.config.js` — Yanlış giriş noktası

**Sorun:** `script: './server/server.js'` yazıyordu, bu dosya mevcut değil.

**Düzeltme:** `'./server/index.js'` olarak güncellendi.

---

### Fix 2 🔴 SQLite Migration `003_session9_features.sql` — Yanlış sıra

**Sorun:** `ALTER TABLE dm_messages ADD COLUMN readAt` ifadesi, `CREATE TABLE IF NOT EXISTS` ifadesinden önce geliyordu. Tablo hiç oluşturulmamışsa `ALTER` başarısız olur ve migration çöker.

**Düzeltme:** `CREATE TABLE IF NOT EXISTS` önce, `ALTER TABLE` sonra getirildi.

---

### Fix 3 🔴 PostgreSQL Migration Session 9 eksikti

**Sorun:** `server/db/migrations_pg/` klasöründe Session 9 için migration dosyası yoktu. `dm_messages.readAt` kolonu PostgreSQL ortamında hiç eklenmiyordu.

**Düzeltme:** `004_session9_features.sql` oluşturuldu.

---

### Fix 4 🟠 `socket/index.js` — IP rate store bellek sızıntısı

**Sorun:** `setInterval` içindeki `_ipRateStore` temizliği yorum satırıydı. Redis yokken Map hiç temizlenmiyordu → bellek sızıntısı.

**Düzeltme:** Temizlik satırları aktif edildi (sync Map işlemi, `await` kaldırıldı).

---

### Fix 5 🟠 `scripts/build.js` — Session 8/9 dosyaları chunk'a eklenmemişti

**Sorun:** `canvas.js`, `dm-read.js`, `voice-activity-ui.js`, `scheduled-ui.js`, `translate-btn.js` hiçbir chunk'a atanmamıştı. Production build'de bu dosyalar paketlenmiyordu.

**Düzeltme:**
- `chunk-comms`: `dm-read.js`, `voice-activity-ui.js` eklendi
- `chunk-features`: `canvas.js`, `scheduled-ui.js`, `translate-btn.js` eklendi

---

### Fix 6 🟡 HAProxy hata dosyaları eksikti

**Sorun:** `haproxy.cfg` içinde `errorfile` direktifleri `haproxy/errors/*.http` dosyalarına işaret ediyordu ama bu dosyalar yoktu. HAProxy başlarken config parse hatası veriyordu.

**Düzeltme:** `haproxy/errors/` dizini oluşturuldu, 400/403/408/429/500/502/503/504 hata dosyaları eklendi.

---

## Eklenen Özellikler

---

### 1. 🎨 Shared Canvas / Whiteboard (Server 9 özelliği)

**Server:** `server/socket/handlers/canvas.ts`
- Redis-backed (yoksa in-memory fallback)
- Kanal başına 2000 stroke, 24h TTL
- Maksimum 20 eşzamanlı client/kanal
- Olaylar: `canvas:join`, `canvas:leave`, `canvas:draw`, `canvas:stroke-delete`, `canvas:clear`, `canvas:state-request`, `canvas:state-sync`

**Client:** `client/js/core/canvas.js`
- Fullscreen overlay, 14 renk paleti, tool seçici, kalınlık slider
- Undo (kendi stroke'larını siler), Clear (tümünü temizler)
- Touch desteği

**Entegrasyon:**
```js
// server/socket/index.js (zaten eklendi — Session 9):
const { registerCanvasHandlers } = require('./handlers/canvas');
registerCanvasHandlers(socket, io, user);

// Client — index.html'e script ekle:
// <script src="/js/core/canvas.js"></script>
// Kanal header'ına: <button id="btn-canvas">🎨</button>
// JS: CanvasUI.init(socket);
```

---

### 2. ✓✓ DM Okundu Bilgisi (Session 8/9 özelliği)

**Server:** `server/socket/handlers/dm-read.js`
- `dm:read` event → `dm:read-ack` gönderir

**Client:** `client/js/core/dm-read.js`
- `DmRead.renderTick(el, isSelf, dmId, createdAt)` → `✓` / `✓✓`

**DB Migration:**
- SQLite: `server/db/sqlite/migrations/003_session9_features.sql`
- PostgreSQL: `server/db/migrations_pg/004_session9_features.sql`

**Entegrasyon:**
```js
// server/socket/index.js (zaten eklendi — Session 9):
const { registerDmReadHandlers } = require('./handlers/dm-read');
registerDmReadHandlers(socket, io, user);

// Client:
DmRead.init(socket, currentUser._id);
DmRead.renderTick(msgEl, msg.userId === currentUser._id, dmId, msg.createdAt);
DmRead.emitRead(socket, dmId); // DM paneli açılınca
```

---

### 3. 🔊 Ses Aktivitesi UI (Session 9 özelliği)

**Client:** `client/js/core/voice-activity-ui.js`
- Avatar glow, sidebar badge, speaking name bar
- Local VAD (Web Audio API energy threshold)

**Entegrasyon:**
```js
// index.html'e ekle: <script src="/js/core/voice-activity-ui.js"></script>
// voice.js init sonrasında:
VoiceActivityUI.init(socket);
```

---

### 4. 📅 Zamanlanmış Mesaj UI (Session 8 özelliği)

**Client:** `client/js/core/scheduled-ui.js`

**Entegrasyon:**
```js
// index.html'e ekle: <script src="/js/core/scheduled-ui.js"></script>
// Kanal header'ına: <button id="btn-schedule">⏰</button>
// JS: ScheduledUI.open(channelId, serverId);
```

---

### 5. 🌐 Mesaj Çeviri Butonu (Session 8 özelliği)

**Client:** `client/js/core/translate-btn.js`

**Entegrasyon:**
```js
// index.html'e ekle: <script src="/js/core/translate-btn.js"></script>
// Mesaj menüsü render fonksiyonunda:
TranslateBtn.patchMessageMenu();
```

---

## Socket Contracts (`server/socket/contracts.ts`)

Session 9 ile güncellendi:
- `CanvasStroke`, `CanvasDrawPayload`, `CanvasClearPayload` tipleri eklendi
- `DmReadReceiptPayload` eklendi
- `VoiceActivityPayload` (`isSpeaking` + `speaking` backward compat) eklendi

---

## Değişen Dosyalar

| Dosya | Değişiklik |
|-------|-----------|
| `ecosystem.config.js` | `server.js` → `index.js` giriş noktası düzeltmesi |
| `server/db/sqlite/migrations/003_session9_features.sql` | Migration sırası düzeltildi |
| `server/db/migrations_pg/004_session9_features.sql` | Yeni — PostgreSQL `dm_messages.readAt` |
| `server/socket/index.js` | Canvas + DM-read handler kayıtları, IP rate store fix |
| `server/socket/handlers/canvas.ts` | Yeni — ortak çizim tahtası |
| `server/socket/handlers/dm-read.js` | Yeni — DM okundu bilgisi |
| `server/socket/contracts.ts` | Canvas, DmRead, VoiceActivity tipleri |
| `client/js/core/canvas.js` | Yeni — canvas client |
| `client/js/core/dm-read.js` | Yeni — DM okundu client |
| `client/js/core/voice-activity-ui.js` | Yeni — konuşan kişi göstergesi |
| `scripts/build.js` | Session 8/9 dosyaları chunk'lara eklendi |
| `haproxy/errors/*.http` | Yeni — HAProxy hata sayfaları |
