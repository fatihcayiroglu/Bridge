# Sprint 46 — Güvenlik & Kalite Düzeltmeleri (2026-05-16)

## Özet
Sprint 45 incelemesinde tespit edilen 6 sorun giderildi.

---

## 1. `sso.ts` — SSO secret güvenlik açığı kapatıldı (KRİTİK)

**Sorun:**
```typescript
// ÖNCE — hardcoded fallback, _validateSecret() devre dışı
const JWT_SECRET     = process.env.JWT_SECRET     || 'bridge-secret';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'bridge-refresh';
const accessToken = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '15m' });
```
`middleware/auth.ts`'in production'da `process.exit` çalıştıran `_validateSecret()` guard'ı
bu dosyada hiç çağrılmıyordu. SSO akışı zayıf fallback secret ile token imzalayabiliyordu.

**Düzeltme:**
- `jwt`, `JWT_SECRET`, `REFRESH_SECRET` yerel tanımları kaldırıldı
- `makeToken` + `makeRefreshToken` auth middleware'den import ediliyor
- `issueTokens` async yapıldı; çağrı noktaları `await` aldı
- `Auth.insertRefreshToken` çağrıları silindi (`makeRefreshToken` zaten kaydeder)
- `REFRESH_MS` sabiti ve artık kullanılmayan `Auth` import'u temizlendi

---

## 2. `webauthn.ts` — Implicit any parametreler tiplendirildi

**Sorun:** 9 yardımcı fonksiyon untyped parametre kullanıyordu (`implicit any`).

**Düzeltme:** Tüm helper'lara tam TypeScript tipleri eklendi:
| Fonksiyon | Eski | Yeni |
|---|---|---|
| `b64uEncode(buf)` | any | `Buffer \| Uint8Array` → `string` |
| `b64uDecode(str)` | any | `string` → `Buffer` |
| `randomChallenge()` | untyped | `Buffer` dönüş |
| `parseAuthenticatorData(buf)` | any | `Buffer` → detaylı return type |
| `verifyRpIdHash(hash)` | any | `Buffer` → `boolean` |
| `coseToJwk(buf)` | any | `Buffer` → `Record<string, unknown>` |
| `jwkToPem(jwk)` | any | `{ x: string; y: string }` → `string` |
| `rsaJwkToPem(jwk)` | any | `{ n: string; e: string }` → `string` |
| `encodeLength(len)` | any | `number` → `Buffer` |

---

## 3. `auth.ts` — Duplicate @openapi blokları temizlendi

**Sorun:** `/register` ve `/login` endpoint'lerinin her biri iki ayrı `@openapi` JSDoc bloğu
içeriyordu (toplam 16 blok, 8 endpoint için). Swagger UI'da duplicate görünüyordu.

**Düzeltme:** Her endpoint için iki blok tek bir kapsamlı blokta birleştirildi
(14 blok, 8 endpoint için doğru). Her iki bloğun en iyi özellikleri korundu:
minLength/maxLength kısıtları + format: password + 409 response + tam schema.

---

## 4. `voice.ts` — voiceRooms Redis-backed (cluster-safe)

**Sorun:** `const voiceRooms = {}` — plain object, process-local.
stageRooms Sprint 45'te Redis'e taşındı; voiceRooms atlandı.

**Düzeltme:** stageRooms mimarisiyle aynı pattern:
- `_loadRoom` / `_saveRoom` — Redis varsa `cache.get/set/del`, yoksa `_fallback` Map
- Redis key: `bridge:voice:room:<channelId>` (TTL: 4 saat)
- `voice:join`, `voice:leave`, `voice:e2e-key` handler'ları async'e çevrildi
- `leaveVoice` async yapıldı (çağrı noktaları `void` ile fire-and-forget)
- `VoicePeer` interface eklendi
- `voiceRooms` export korundu (in-memory fallback referansı — geriye dönük uyumluluk)

---

## 5. `console.*` → pino logger (8 çağrı, 6 dosya)

**Sorun:** Routes katmanında 8 adet `console.warn`/`console.error` kalmıştı.

**Düzeltme:** Tüm çağrılar `logger.warn` / `logger.error`'a taşındı,
structured log objesi `{ err, event: '...' }` formatında eklendi:

| Dosya | Değişiklik |
|---|---|
| `serverTemplates.ts` | logger import + 1 console.warn |
| `webauthn.ts` | logger import + 1 console.warn + 1 console.error |
| `badges.ts` | logger import + 1 console.error |
| `interactions.ts` | logger import + 1 console.warn |
| `voicemsg.ts` | logger import + 3 console.warn |
| `outgoingWebhooks.ts` | 1 console.warn (logger zaten import'luydu) |

---

## 6. `presenceCache.ts` — Cluster-safe Pub/Sub koordinasyonu

**Sorun:** `_socketMap` process-local'dı. PM2 cluster modunda aynı kullanıcı iki
worker'a düşerse `isUserOnline()` tutarsız sonuç verebilirdi. Belgelenmiş ama çözümsüzdü.

**Düzeltme:**
- `trackSocket()` → ilk socket kaydında `markOnline()` + Redis Pub/Sub `presence:joined` yayını
- `releaseSocket()` → son socket kapanınca `markOffline()` + Redis Pub/Sub `presence:left` yayını
- `isUserOnline()` → önce process-local socket map (hızlı path), sonra Redis TTL key (cluster-wide)
- `subscribeToChannel` + `publishToChannel` yardımcıları `redisAdapter.ts`'e eklendi ve export edildi
- `socket/index.ts`: `await trackSocket(...)` — `markOnline` redundant çağrısı kaldırıldı
- `socket/handlers/infra.ts`: `await releaseSocket(...)` — `markOffline` redundant çağrısı kaldırıldı
- Redis yoksa davranış öncekiyle aynı (in-memory fallback)

---

## ⚠️ Kaçırılan Aksiyon (Sprint 48'de Düzeltildi)

`pgCollection.ts` bu sprintte implement edildi ancak `server/db/postgres/index.ts` importu güncellenmedi.
Production kodu Sprint 48'e kadar `collection.ts` (whitelist korumasız) üzerinden çalıştı.

**Sprint 48'de yapılan:** `index.ts` importu düzeltildi + CI guard eklendi.
**Alınan ders:** `@deprecated` geçişlerinde CI guard aynı sprint'te yazılmalı.

---

## Değişen Dosyalar

```
server/routes/sso.ts                         (GÜNCELLENDİ — kritik güvenlik)
server/routes/webauthn.ts                    (GÜNCELLENDİ — implicit any)
server/routes/auth.ts                        (GÜNCELLENDİ — duplicate @openapi)
server/socket/handlers/voice.ts              (GÜNCELLENDİ — Redis migration)
server/routes/serverTemplates.ts             (GÜNCELLENDİ — pino)
server/routes/badges.ts                      (GÜNCELLENDİ — pino)
server/routes/interactions.ts                (GÜNCELLENDİ — pino)
server/routes/voicemsg.ts                    (GÜNCELLENDİ — pino)
server/routes/outgoingWebhooks.ts            (GÜNCELLENDİ — pino)
server/lib/presenceCache.ts                  (GÜNCELLENDİ — cluster-safe)
server/lib/redisAdapter.ts                   (GÜNCELLENDİ — subscribeToChannel/publishToChannel)
server/socket/index.ts                       (GÜNCELLENDİ — await trackSocket)
server/socket/handlers/infra.ts              (GÜNCELLENDİ — await releaseSocket)
SPRINT46_FIXES.md                            (YENİ)
```

## Sayısal Özet

| Metrik | Değer |
|---|---|
| Kapatılan kritik güvenlik açığı | 1 (sso.ts secret) |
| TypeScript any → tipli | 9 fonksiyon |
| Silinen duplicate @openapi blok | 2 |
| Redis'e taşınan plain object | 1 (voiceRooms) |
| Pino'ya taşınan console.* çağrısı | 8 |
| Cluster-safe yapılan bileşen | 1 (presenceCache) |
| Toplam değişen dosya | 13 |
