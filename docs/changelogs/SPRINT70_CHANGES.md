# Sprint 70 — Test Altyapısı Düzeltmeleri + 4K Video Gönderme

## 🐛 Bug Fix'ler (Sprint 69 test sorunları)

### Fix 1 — `jest.resetModules()` + hoisted `jest.mock()` çakışması (`server/tests/apnsJwtCache.test.ts`)
- **Sorun:** `beforeEach` içindeki `resetModules()` çağrısı, dosya başında hoisted edilen `jest.mock('fs')` ve `jest.mock('crypto')` kayıtlarını her testten önce siliyordu. Sonraki testte mock'lar etkisiz kalırdı.
- **Düzeltme:** `resetModules()` kaldırıldı; `jest.mock()` kayıtları zaten dosya düzeyinde hoisted olduğu için `clearAllMocks()` yeterlidir.

### Fix 2 — `jest.electron.config.js`'de `.js` transform eksikliği (`electron/jest.electron.config.js`)
- **Sorun:** `transform` yalnızca `.ts` uzantısını yakalıyordu. `main.test.js` `.js` uzantılı olduğundan transform'dan geçmeden çalışır, `@babel/preset-env` olmadan modern syntax hata verebilirdi.
- **Düzeltme:** `'^.+\\.js$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }]` eklendi.

### Fix 3 — `dm-call.test.ts`'de `IceConnectionState` type eksikliği (`client/tests/dm-call.test.ts`)
- **Sorun:** `it.each` bloğunda `as [IceConnectionState, boolean][]` cast kullanılıyor ama type hiç import edilmemişti; TypeScript derleme hatası verirdi.
- **Düzeltme:** `type IceConnectionState = 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed'` local type tanımı dosya başına eklendi.

---

## ✨ Yeni Özellik — 4K Video Gönderme (`client/js/core/dm-call.ts`)

DM araması sırasında veya bağımsız olarak 4K video klip kaydedip karşı tarafa dosya olarak gönderme.

### Teknik detaylar

| Özellik | Değer |
|---------|-------|
| Video çözünürlüğü | 3840×2160 (4K UHD), ideal; cihaz desteklemiyorsa 1080p fallback |
| Kare hızı | 30 fps (max 60 fps) |
| Bit hızı | 25 Mbps |
| Kayıt süresi | Max 30 saniye (otomatik durdurma) |
| Codec önceliği | VP9 → H.264 → WebM → varsayılan |
| Yükleme yöntemi | Chunked upload (5MB/chunk) — mevcut `/api/upload/chunk` endpoint |
| Dosya formatı | `.webm` (VP9) veya `.mp4` |
| Server limit | 2GB (mevcut) — 30s@25Mbps ≈ 89MB, limitin çok altında |

### Yeni API/export

```ts
DmCall.send4KVideo()   // 4K video kayıt/gönderme toggle
```

### Yeni internal fonksiyonlar

| Fonksiyon | Açıklama |
|-----------|----------|
| `send4KVideo()` | Kayıt başlat/durdur toggle — MediaRecorder + getDisplayMedia |
| `_stop4KRecording()` | Aktif kaydı durdur (buton tıklaması veya timer) |
| `_upload4KFile(file)` | Chunked upload + socket `file:send` emit |
| `_show4KProgress()` | Overlay içi upload progress bar |
| `_update4KProgress()` | Progress güncelle |
| `_hide4KProgress()` | Progress kaldır |

### Yeni state

| Değişken | Açıklama |
|----------|----------|
| `_currentDmChannelId` | DM kanal ID — socket `file:send`'de kullanılır |
| `_4kTimer` | Otomatik durdurma timer ref |
| `_currentRecorder` | Aktif MediaRecorder ref |

### UX akışı

1. Arama bağlandıktan sonra 🎬 butonu görünür
2. Butona tık → `getDisplayMedia` izni istenir (4K ekran yakalama)
3. Kayıt başlar → buton ⏹️'a döner, overlay'de durum gösterilir
4. ⏹️'a tık veya 30 saniye → kayıt durur
5. Upload progress overlay'de gösterilir
6. Tamamlandığında `socket.emit('file:send', ...)` → DM kanalında video mesajı

### Yeni test dosyası

`client/tests/dm-call-4k.test.ts` — 4K kayıt ve yükleme mantığı için 15 birim testi:
- MediaRecorder codec seçimi
- getDisplayMedia 4K parametreleri
- NotAllowedError sessiz yutma
- MediaRecorder state geçişleri
- 25 Mbps bit hızı doğrulaması
- Chunked upload (3 chunk) — fetch çağrı sayısı
- Başarısız chunk hata yönetimi
- Upload tamamlandığında `socket.emit('file:send')` doğrulaması
- MIME type server uyumu
- 30s@25Mbps boyut hesabı (< 200MB)
- `_currentDmChannelId` guard — null/boş/dolu senaryolar (+3)

---

## 🔧 Kod Kalitesi — `client/js/core/dm-call.ts` TypeScript Geçişi

Sprint 70 kapsamında `dm-call.ts` gerçek TypeScript'e dönüştürüldü.

### Değişiklikler

| Alan | Öncesi | Sonrası |
|------|--------|---------|
| Modül tipi | `'use strict'` + saf JS | Gerçek TypeScript tip annotation'ları |
| State tanımları | `let x = null` | `let x: Type \| null = null` |
| Fonksiyon imzaları | Parametresiz | Tam parametre ve dönüş tipleri |
| DOM erişimleri | Cast yok | `as HTMLVideoElement \| null` gibi güvenli cast'ler |
| Interface'ler | Yok | `IceConfig`, `FileUploadChunkResponse`, `ImageUploadResponse`, `CallType`, `CallRole` |
| Socket event handler'ları | `any` implicit | Inline tip annotation |

### Bug Fix'ler (inceleme bulguları)

**Fix A — Dead code `_stop4KRecording` iç fonksiyonu silindi**
- **Sorun:** `send4KVideo()` içinde `function _stop4KRecording()` tanımı vardı ancak hiçbir zaman çağrılmıyordu. Modül seviyesindeki `_stop4KRecording` ile aynı isme sahipti; okuyucuyu yanıltıyor, hangi versiyonun ne zaman çalıştığını belirsizleştiriyordu.
- **Düzeltme:** İç fonksiyon silindi. `_currentRecorder` module-level ref üzerinden çalışan dış `_stop4KRecording()` tek yetkili implementasyon olarak bırakıldı.

**Fix B — `_4kTimer` ve `_currentRecorder` module state bloğuna taşındı**
- **Sorun:** Bu iki `let` değişkeni `send4KVideo()` fonksiyonundan *sonra* tanımlanıyordu. Hoisting sayesinde çalışıyordu ancak okunabilirlik açısından kötü pratikti; diğer tüm state değişkenleriyle birlikte olmaları gerekiyordu.
- **Düzeltme:** Modülün state bloğuna (`_currentCallId`, `_pc` vb. ile birlikte) taşındı.

**Fix C — `send4KVideo()` başına `_currentDmChannelId` guard eklendi**
- **Sorun:** `_currentDmChannelId` null iken kayıt ve upload başarıyla tamamlanıyor, ancak `file:send` emit edilmiyordu. Kullanıcı video gönderdi zannederken karşı taraf mesajı hiç almıyordu — sessiz başarısızlık.
- **Düzeltme:** Fonksiyon başında erken dönüş + kullanıcıya `'error'` toast: `"4K video göndermek için aktif bir DM araması gerekli"`. Boşuna kayıt ve upload yapılmaz.

---

## Dosya Değişiklikleri

| Dosya | Durum |
|-------|-------|
| `client/js/core/dm-call.ts` | ✏️ Güncellendi (4K özelliği + TypeScript geçişi + 3 bug fix) |
| `client/tests/dm-call-4k.test.ts` | ✏️ Güncellendi (+3 guard testi → toplam 15 test) |
| `client/tests/dm-call.test.ts` | ➕ Sprint 69'dan (IceConnectionState fix) |
| `client/tests/helpers/webrtc-mock.ts` | ➕ Sprint 69'dan |
| `client/tests/helpers/canvas-mock.ts` | ➕ Sprint 69'dan |
| `client/tests/canvas-stage-logic.test.ts` | ➕ Sprint 69'dan |
| `electron/jest.electron.config.js` | ✏️ .js transform fix |
| `electron/tests/__mocks__/electron.js` | ➕ Sprint 69'dan |
| `electron/tests/__mocks__/electron-updater.js` | ➕ Sprint 69'dan |
| `electron/tests/main.test.js` | ➕ Sprint 69'dan |
| `jest.mobile.config.js` | ➕ Sprint 69'dan |
| `mobile/tests/__mocks__/@capacitor/core.js` | ➕ Sprint 69'dan |
| `mobile/tests/__mocks__/capacitor-plugins.js` | ➕ Sprint 69'dan |
| `mobile/tests/capacitor-bridge.test.js` | ➕ Sprint 69'dan |
| `server/tests/apnsJwtCache.test.ts` | ➕ Sprint 69'dan (resetModules fix) |
