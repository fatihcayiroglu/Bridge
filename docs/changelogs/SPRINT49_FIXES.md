# Sprint 49 — Cluster Bug Fix + JS→TS Geçişi (2026-05-16)

## Özet
4 teknik borç kapatıldı: stage disconnect cluster bug, voice handler tipleri,
logger tutarlılığı, modal artifact temizliği + 3 JS→TS tam geçişi + 25 dosyaya JSDoc.

---

## 1. Stage Disconnect — Cluster Bug Düzeltmesi (KRİTİK)

**Sorun:**
```typescript
// ÖNCE — _memRooms iteration (Redis modunda yetersiz)
for (const [channelId] of _memRooms) { ... }
```
Redis modunda başka bir PM2 worker'ına bağlanan kullanıcı `_memRooms`'a
yazılmadığından disconnect anında temizlenmiyordu. Kullanıcı stage room'da
"hayalet" olarak kalıyordu.

**Düzeltme:**
```typescript
// SONRA — socket.rooms iteration (her zaman doğru)
for (const room of socket.rooms) {
  if (!room.startsWith('stage:')) continue;
  const channelId = room.slice('stage:'.length);
  // ...temizlik
}
```
Socket.IO'nun `socket.rooms` Set'i her zaman bu socket'in katıldığı odaları
içerir — single-node ve Redis-cluster modda tutarlı çalışır.

**Etkilenen dosyalar:**
- `server/socket/handlers/stage.ts`
- `server/tests/stage-socket.test.js` — `makeSocket` helper'ına `rooms` property eklendi
- `server/tests/stage-socket-extra.test.js` — aynı fix

---

## 2. Voice Handler TypeScript Tip Signature

**Sorun:**
```typescript
function registerVoiceHandlers(socket, io, user) { // implicit any ×3
```
Strict mode altında tutarsız — diğer handler'lar tamamen tiplendirilmişti.

**Düzeltme:** `socket`, `io`, `user` parametrelerine tam inline interface tipleri eklendi.

---

## 3. setupSocket.ts — console.* → pino logger

**Sorun:** Mediasoup başlatma log'ları `console.log/error` kullanıyordu.

**Düzeltme:** `logger.info/error` + structured log objeleri (`event: 'mediasoup.start'` vb.)

---

## 4. Modal Artifact Temizliği

`modal-core.ts` ve `modal-state.ts`'teki `[c] ?? c));` truncated satırları silindi.
`escHtml` zaten `utils.ts`'den import ediliyor.

---

## 5. JS → TypeScript Geçişi (3 tam dönüşüm)

| Dosya | Önceki | Sonraki | Notlar |
|-------|--------|---------|--------|
| `core/mention-autocomplete.js` | .js | `.ts` | `Member` interface, tam tipler |
| `core/messages/reactions.js` | .js | `.ts` | `Reactions` type alias |
| `core/messages/scroll.js` | .js | `.ts` | `ScrollPos` type, `initInfiniteScroll` parametreleri |

`scripts/build.js` güncellendi — 3 yeni `.ts` entry eklendi.

---

## 6. JSDoc Tip Annotasyonları (25 dosya)

Kalan 25 `.js` dosyasına Sprint 49 notu ve `@typedef` başlangıçları eklendi.
IIFE pattern nedeniyle tam `.ts` dönüşümü ileriki sprint'lere bırakıldı.

---

## Değişen Dosyalar

```
server/socket/handlers/stage.ts                 (GÜNCELLENDİ — disconnect cluster fix)
server/socket/handlers/voice.ts                 (GÜNCELLENDİ — handler tip signature)
server/app/setupSocket.ts                       (GÜNCELLENDİ — console → logger)
server/tests/stage-socket.test.js               (GÜNCELLENDİ — socket.rooms fix)
server/tests/stage-socket-extra.test.js         (GÜNCELLENDİ — socket.rooms fix)
client/js/core/channel-perms/modal-core.ts      (GÜNCELLENDİ — artifact temizliği)
client/js/core/channel-perms/modal-state.ts     (GÜNCELLENDİ — artifact temizliği)
client/js/core/mention-autocomplete.ts          (YENİ — JS→TS)
client/js/core/messages/reactions.ts            (YENİ — JS→TS)
client/js/core/messages/scroll.ts               (YENİ — JS→TS)
scripts/build.js                                (GÜNCELLENDİ — 3 yeni .ts entry)
client/js/core/*.js (25 dosya)                  (GÜNCELLENDİ — Sprint 49 JSDoc notu)
SPRINT49_FIXES.md                               (YENİ)
```

## Sayısal Özet

| Metrik | Değer |
|---|---|
| Cluster bug düzeltmesi | ✅ |
| Tiplendirilmemiş handler | 0 (voice.ts düzeltildi) |
| console.* → logger | 3 satır |
| Silinen artifact satırı | 2 |
| Tam TS'e geçen dosya | 3 |
| JSDoc notu eklenen .js | 25 |
| Kalan .js-only dosyası | 25 (IIFE pattern — ileriki sprint) |
