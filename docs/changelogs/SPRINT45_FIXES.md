# Sprint 45 — Kod Kalitesi Düzeltmeleri (2026-05-16)

## Özet
Sprint 44 incelemesinde tespit edilen 4 sorun giderildi.
Herhangi bir davranış değişikliği yapılmadı; yalnızca hata giderimi ve mimari iyileştirmeler.

---

## 1. `stage.ts` — In-memory stageRooms → Redis-backed (kritik)

**Sorun:**
`stageRooms` bir `Map<string, StageRoom>` olarak tutuluyordu.
PM2 cluster modunda (`instances: 'max'`) her worker ayrı bir Map kopyası oluşturuyordu.
Kullanıcı A worker-1'e, kullanıcı B worker-2'ye düştüğünde stage state tutarsız oluyor,
promote/demote/topic olayları yalnızca bir worker'da görünüyordu.

**Düzeltme:**
- `_loadRoom` / `_saveRoom` / `_deleteRoom` — Redis varsa Redis hash, yoksa Map fallback
- Redis key: `bridge:stage:room:<channelId>`
- Tüm handler'lar async'e çevrildi; artık her okuma/yazma aynı store'u kullanıyor
- Geriye dönük uyumluluk: `stageRooms` export'u korundu (in-memory fallback Map)

**Yan etki:** `stage:join`, `stage:setRole` vb. handler'lar `void (async () => {...})()` ile async'e çevrildi.

---

## 2. `stage.ts` — Promote yetki açığı düzeltildi

**Sorun:**
`stage:promote` sadece `room.speakers[0]?.userId === user._id` kontrolü yapıyordu.
Yani herhangi bir konuşmacı, başka bir dinleyiciyi konuşmacıya yükseltebiliyordu.

**Düzeltme:**
`_isAuthorized(channelId, userId, room)` yardımcı fonksiyonu eklendi:
- İlk konuşmacı (host) VEYA
- Server owner (Channels + Servers repo'dan kontrol)

`stage:demote`, `stage:setTopic`, `stage:setLive` de aynı kontrolü kullanıyor (daha önce
bunlar zaten speakers[0] kontrolüne sahipti; artık merkezi ve tutarlı).

---

## 3. `ipBan.ts` — Redis race condition giderildi (atomik SET)

**Sorun:**
```typescript
// ÖNCE — race condition
await redis.set(key, JSON.stringify(entry));
if (ttlSeconds > 0) await redis.expire(key, ttlSeconds);
// set() tamamlanır, expire() çalışmadan önce key'e erişilirse TTL'siz kalır
```

**Düzeltme:**
```typescript
// SONRA — atomik
if (ttlSeconds > 0) {
  await redis.setEx(key, ttlSeconds, JSON.stringify(entry)); // SET key value EX n
} else {
  await redis.set(key, JSON.stringify(entry));
}
```

`RedisLike` interface'ine `setEx(key, seconds, value)` eklendi.
Tek komutla atomik set+TTL — ara durumda hayalet ban oluşmaz.

---

## 4. `mediasoup.ts` (784 satır) → 4 modüle bölündü

**Sorun:**
Tek dosyada worker yönetimi, room/peer CRUD, transport, produce/consume, socket handler
iç içe yazılıydı. Okumak ve test etmek zordu.

**Yeni yapı:**
```
server/socket/handlers/mediasoup/
  types.ts    — tüm interface'ler (MediasoupWorker, SfuRoom, SfuPeer, …)
  config.ts   — env-driven SfuConfig
  workers.ts  — worker havuzu: initMediasoup, getNextWorker, _restartWorker
  rooms.ts    — room/peer CRUD: getOrCreateRoom, cleanupRoom, cleanupPeer, getRoomPeerList
  index.ts    — registerSFUHandlers (socket event binding)
```

Import yolları güncellendi:
- `server/app/setupSocket.ts`
- `server/socket/index.ts`

Public API değişmedi: `registerSFUHandlers`, `initMediasoup`, `isSFUReady`,
`sfuRooms`, `sfuPeers`, `cleanupRoom` aynı isimlerle export ediliyor.

---

## Değişen Dosyalar

```
server/socket/handlers/stage.ts                        (GÜNCELLENDİ)
server/middleware/ipBan.ts                             (GÜNCELLENDİ)
server/socket/handlers/mediasoup.ts                    (SİLİNDİ)
server/socket/handlers/mediasoup/types.ts              (YENİ)
server/socket/handlers/mediasoup/config.ts             (YENİ)
server/socket/handlers/mediasoup/workers.ts            (YENİ)
server/socket/handlers/mediasoup/rooms.ts              (YENİ)
server/socket/handlers/mediasoup/index.ts              (YENİ)
server/app/setupSocket.ts                              (import yolu güncellendi)
server/socket/index.ts                                 (import yolu güncellendi)
SPRINT45_FIXES.md                                      (YENİ)
```

## Sayısal Özet

| Metrik | Değer |
|---|---|
| Düzeltilen kritik bug (cluster state) | 1 |
| Düzeltilen güvenlik açığı (promote) | 1 |
| Düzeltilen race condition (Redis) | 1 |
| Bölünen monolitik dosya → modül sayısı | 1 → 4 |
| Toplam değişen / yeni dosya | 11 |
