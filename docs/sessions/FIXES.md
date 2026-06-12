# Bridge — Session 7 Fix Notları

**Tarih:** Mayıs 2026  
**Kapsam:** 6 hata düzeltmesi (2 kritik, 2 önemli, 2 orta)

---

## Fix 1 🔴 Dockerfile — server/node_modules eksikti

**Sorun:** Build stage'de `npm ci` sadece root bağımlılıklarını kuruyordu. `server/` dizininin kendi `package.json`'ı olmasına rağmen server bağımlılıkları (`pg`, `pino`, `socket.io` vb.) runtime container'ına taşınmıyordu. Container başlatılınca `MODULE_NOT_FOUND` hatasıyla crash ediyordu.

**Düzeltme:**
- Build stage'e `RUN cd server && npm ci --omit=dev` eklendi
- Runtime stage'e `COPY --from=build /app/server/node_modules ./server/node_modules` eklendi

---

## Fix 2 🔴 Service Worker — chunk sistemiyle uyumsuzdu

**Sorun:** `sw.js`'deki `STATIC_ASSETS` listesi eski tekli-dosya yapısına göre yazılmıştı (`js/app.js`, `js/core/messages.js` vb.). Sprint 10 ile bu dosyalar `chunk-*.js` sistemine geçti. Production'da önbelleğe alınmaya çalışılan dosyalar mevcut değildi → offline mod tamamen çalışmıyordu.

**Düzeltme:**
- `STATIC_ASSETS` listesi `chunk-boot.js` … `chunk-compat.js` olarak güncellendi
- `CACHE_VERSION` `'bridge-v1'` → `'bridge-v2'` olarak güncellendi (eski cache temizlensin diye)

---

## Fix 3 🟠 Service Worker — expired token sessiz mesaj kaybı

**Sorun:** `flushOutbox` fonksiyonunda 401 (token süresi dolmuş) yanıtı `400-499` aralığında değerlendirilip item siliniyordu ama kullanıcıya hiçbir bildirim gitmiyordu. Mesaj sessizce kayboluyordu.

**Düzeltme:**
- 401 durumu ayrı yakalanıyor
- Item siliniyor ama aynı zamanda `OUTBOX_AUTH_EXPIRED` mesajı tüm window client'larına gönderiliyor
- İstemci tarafı bu mesajı alıp kullanıcıyı "oturumunuz sona erdi, lütfen tekrar giriş yapın" şeklinde uyarabilir

---

## Fix 4 🟠 Bot SDK — yorum satırındaki versiyon yanlıştı

**Sorun:** `bot-sdk/src/index.js` ilk satırında `v1.1.0` yazıyordu, gerçek versiyon `1.2.0`'dı.

**Düzeltme:** Yorum satırı `v1.2.0` olarak güncellendi.

---

## Fix 5 🟠 Bot SDK — `_contextCommands` / `_modalHandlers` lazy init kaldırıldı

**Sorun:** Bu iki Map, constructor'da tanımlanmıyordu; ilk kullanıldıklarında `|| new Map()` ile lazy init ediliyordu. TypeScript geçişinde veya `hasOwnProperty` kontrollerinde beklenmedik davranış yaratırdı; ayrıca nesnenin shape'i constructor'dan okunamıyordu.

**Düzeltme:**
- `this._contextCommands = new Map()` ve `this._modalHandlers = new Map()` constructor'a taşındı
- Lazy init satırları kaldırıldı
- Gereksiz `?.` optional chain'ler temizlendi

---

## Fix 6 🟡 CI — session strict typecheck adımları eklendi

**Sorun:** `ci.yml`'deki typecheck job'u sadece `client/tsconfig.json` (strict: false) ile çalışıyordu. `tsconfig.session4.json` ve `tsconfig.session5.json` (strict: true) hiç çalışmıyordu. Strict modda hata veren dosyalar CI'ı geçebiliyordu.

**Düzeltme:**
- `Session 4 typecheck (strict)` adımı eklendi: `server/tsconfig.session4.json`
- `Session 5 typecheck (strict)` adımı eklendi: `client/tsconfig.session5.json`

---

## Değişen Dosyalar

| Dosya | Değişiklik |
|-------|-----------|
| `Dockerfile` | server deps kurulum + copy eklendi |
| `client/sw.js` | CACHE_VERSION bump, STATIC_ASSETS chunk listesi, 401 handling |
| `bot-sdk/src/index.js` | versiyon yorumu, constructor init, lazy init temizliği |
| `.github/workflows/ci.yml` | session4 + session5 typecheck adımları |

---

## Fix 7 🟡 Mediasoup SFU — UDP port aralığı aktif edildi

**Sorun:** `docker-compose.yml` ve `docker-compose.cluster.yml`'de Mediasoup için gerekli UDP port aralığı (40000-49999) yorum satırında bırakılmıştı. `MEDIASOUP_ANNOUNCED_IP` env değişkeni de tanımlı değildi. Sonuç: Group voice (SFU) production deployment'ta hiç çalışmıyordu.

**Düzeltme — `docker-compose.yml`:**
- `ports` bloğuna UDP aralığı eklendi (env var'dan override edilebilir)
- `environment` bloğuna `MEDIASOUP_ANNOUNCED_IP`, `MEDIASOUP_RTC_MIN_PORT/MAX_PORT`, `MEDIASOUP_WORKERS` ve bitrate ayarları eklendi
- Eski yorum bloğu kaldırıldı

**Düzeltme — `docker-compose.cluster.yml`:**
- Aynı değişiklikler bridge1, bridge2, bridge3 instance'larına uygulandı

**Düzeltme — `.env.docker`:**
- Mediasoup ayarları açıklamalı olarak `.env.docker` şablonuna eklendi

**Kullanım:**
```env
# .env dosyasına ekle:
MEDIASOUP_ANNOUNCED_IP=1.2.3.4   # sunucunun public IP'si — ZORUNLU
MEDIASOUP_WORKERS=2               # CPU sayısına göre ayarla
# Port aralığını daraltmak istersen:
MEDIASOUP_RTC_MIN_PORT=40000
MEDIASOUP_RTC_MAX_PORT=40099      # 100 eşzamanlı bağlantı için yeterli
```

**Not:** `MEDIASOUP_ANNOUNCED_IP` boş bırakılırsa kod P2P fallback'e düşüyor (webrtc-sfu.js bunu otomatik yapar) — geriye dönük uyumluluk korunuyor.
