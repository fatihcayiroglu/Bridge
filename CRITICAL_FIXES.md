# Bridge — Kritik Fix Notları

**Tarih:** Nisan 2026  
**Kapsam:** 4 kritik güvenlik ve güvenilirlik düzeltmesi

---

## Fix 1: Memory Leak — `spamMap`, `csrfTokens`, `violationMap`
**Dosya:** `server/lib/security.js`

**Sorun:** Üç ayrı `Map` objesi sınırsız büyüyordu. Uzun süreli çalışmada her kullanıcı bir kayıt bırakıyor, hiçbiri temizlenmiyordu (10.000 kullanıcı ≈ binlerce stale kayıt).

**Düzeltme:**
- `MAX_SPAM_ENTRIES = 10_000`, `MAX_CSRF_ENTRIES = 50_000`, `MAX_VIOLATION_ENTRIES = 50_000` üst sınır eklendi
- Dolduğunda en eski kayıt silinir (LRU-lite, `Map` insertion-order'ı garanti eder)
- Tüm `setInterval` cleanup'larına `.unref()` eklendi — process kapanmasını engellemez
- CSRF cleanup sıklığı 10 dakikaya çıkarıldı (gereksiz iş azaltıldı)
- Regex escape düzeltmesi: `$regex` sorgusunda `%_\` karakterleri artık doğru escape ediliyor

---

## Fix 2: Global Antipattern — `global.bridgeIO` / `global.bridgeSocketUsers`
**Dosyalar:** `server/index.js`, `server/routes/threads.js`, `server/routes/groupDm.js`, `server/routes/servers.js`, `server/routes/interactions.js`, `server/routes/voicemsg.js`

**Sorun:** `io` ve `socketUsers` `global.*` üzerinden erişiliyordu. Bu:
- Test izolasyonunu kırıyor (`global` state testler arası sızıyor)
- Multi-instance deployment'ta belirsiz davranışa yol açıyor
- Node.js modül sistemini atlıyor

**Düzeltme:**
- `global.bridgeIO` ve `global.bridgeSocketUsers` kaldırıldı
- `app.set('io', io)` ve `app.set('socketUsers', socketUsers)` zaten mevcuttu
- Tüm route'larda `req.app.get('io')` / `req.app.get('socketUsers')` kullanılıyor
- Test dosyası (`interactions.test.js`) değiştirilmedi — `global.bridgeIO = null` mock pattern'ı hâlâ çalışır

---

## Fix 3: MessageRepository Düzeltmeleri
**Dosya:** `server/db/repositories/MessageRepository.js`

**Sorun:** `$regex` escape sadece regex meta karakterlerini kaçırıyordu, SQL LIKE karakterleri (`%`, `_`, `\`) kaçırılmıyordu. Arama sorgusunda `%` içeren bir mesaj tüm mesajları döndürebiliyordu.

**Düzeltme:**
- LIKE-safe escape: `search.replace(/[%_\\]/g, c => \`\\${c}\`)` 
- Yeni `findLastTimestamps(channelIds)` metodu eklendi — sidebar için N ayrı sorgu yerine tek `$in` sorgusu
- Açıklayıcı yorumlar eklendi (syntax kasıtlı, NeDB değil SQLite layer)

---

## Fix 4: Redis Eksik Uyarısı
**Dosya:** `server/lib/redisAdapter.js`

**Sorun:** Production'da `REDIS_URL` yoksa sadece `console.log` ile geçiliyordu. Sessizce in-memory'e düşüp Socket.IO multi-instance çalışmıyordu.

**Düzeltme:**
- `NODE_ENV === 'production'` kontrolü eklendi
- Production'da `console.error` ile açık ve detaylı uyarı gösterilir
- Dev modunda davranış değişmedi

---

## Sonraki Adımlar (Bu PR'da değil)

| Öncelik | Görev |
|---------|-------|
| 🔴 Yüksek | SQLite → PostgreSQL geçişi (`DATABASE_URL` set et, `db/migrate-to-postgres.js` çalıştır) |
| ~~🟡 Orta~~ | ~~`global.bridgeIO` test mock'unu `app.set` tabanlıya geçir~~ ✅ Tamamlandı |
| 🟡 Orta | esbuild code splitting — lazy loading |
| 🟢 Düşük | CSS modülerleştirme |
---

## v-pg2: Esbuild Chunk Splitting (scripts/build.js)

**Sorun:** 74 ayrı `<script>` tag → seri HTTP istekleri, yavaş ilk yükleme.

**Çözüm:** Manuel chunk grupları — global-scope Vanilla JS ESM olmadığı için
esbuild'in `splitting: true` kullanılmadı. Bunun yerine dosyalar anlamlı
gruplara ayrılarak 8 bundle üretilir:

| Chunk | İçerik | Öncelik |
|---|---|---|
| `chunk-boot.js` | state, api, auth, utils, theme, i18n | Kritik — ilk |
| `chunk-core.js` | servers, channels, messages, socket, ui | Kritik |
| `chunk-comms.js` | dm, voice, emoji-picker | Yüksek |
| `chunk-webrtc.js` | webrtc, noise-suppression, video-quality | Orta |
| `chunk-features.js` | perms, search, moderation, ai, e2e | Orta |
| `chunk-pages.js` | app, discover, slash, polls, mobile | Orta |
| `chunk-heavy.js` | discord-import, bot-marketplace, admin | Düşük (lazy) |
| `chunk-compat.js` | v41–v44 compat shims | Düşük |

**Sonuç:** Tarayıcı 8 dosyayı paralel indirir (`defer`). İlk paint hızlanır,
CDN cache hit oranı artar (core değişmediğinde heavy chunk'ı tekrar indirmez).

**index.html değişikliği:** 74 `<script>` tag → 8 `<script defer>` tag.
