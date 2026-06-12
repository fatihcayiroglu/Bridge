# Sprint 67 — Teknik Borç Tasfiyesi

Sprint 66 değerlendirmesinde tespit edilen dört yapısal sorun bu sprintte giderilmiştir.

---

## 1. `require()` Temizliği — Tüm Üç Dosya (−1.0 → 0)

**Sorun:** `server/socket/handlers/messages.ts` 10, `server/middleware/rateLimit.ts` 4 `eslint-disable` satırı
içeriyordu ve toplamda ~14 inline `require()` çağrısı vardı. `_optional-require.ts` adında temiz bir helper
mevcut olmasına rağmen hiçbirinde kullanılmıyordu.

**Yapılan değişiklikler:**

### `server/socket/handlers/messages.ts`
- `checkSpamAsync`, `sanitizeMessage` → `../../lib/security` top-level `import`
- `cache` → `../../lib/redisAdapter` top-level `import`
- `processNotifications` → `../../lib/notifications` top-level `import`
- `logger` → `../../lib/logger` top-level `import`
- `Threads` → `../../db/repositories/ThreadRepository` top-level `import`
- `dispatchEvent` → `tryRequire('../../routes/outgoingWebhooks')` (gerçekten opsiyonel)
- `_pluginHooks` → `tryRequire('../../plugins/loader')` (gerçekten opsiyonel)
- `handleMusicCommand` → fonksiyon içinde `tryRequire('./music')` (boot'ta olmayabilir)
- `getDb()` lazy init → `tryRequire('../../db/loader')` (circular bağımlılık kırma)

**Kural:** Modül her ortamda garantili varsa → top-level `import`. Boot'ta olmayabilir veya
circular bağımlılık oluşturuyorsa → `tryRequire`. İkisi arasındaki fark artık açık.

### `server/middleware/rateLimit.ts`
- `redis.createClient` → `tryRequire<...>('redis')` (Redis yüklü olmayabilir)
- `metrics.trackRateLimitHit/_bumpAnomalyCounter/trackAutoBan` → top-level `const _metrics = tryRequire('./metrics')`
- `ipBan.getBan/banIp` → top-level `const _ipBan = tryRequire('./ipBan')`
- `banIp(ip, ...)` → `_ipBan.banIp(ip, ...)` (null-guard ile birlikte)

### `server/db/loader.ts`
- `require('./postgres')` → `tryRequire<Record<string, unknown>>('./postgres')`
- Yüklenme başarısız olursa `process.exit(1)` korunuyor (davranış değişmedi, `eslint-disable` kalktı)

**Sonuç:** Üç dosyada toplam **0 `eslint-disable`**, **0 inline `require()`**.

---

## 2. `messages.ts` Tip Güvencesi (−0.6 → 0)

**Sorun:** `systemMsg(channelId, serverId, content)`, `formatDuration(seconds)`,
`registerMessageHandlers(socket, io, user, socketUsers)` ve tüm socket event callback parametreleri
anonim `any` ile geçiyordu.

**Yapılan değişiklikler:**
```typescript
// Öncesi
function systemMsg(channelId, serverId, content) { ... }
function formatDuration(seconds) { ... }
function registerMessageHandlers(socket, io, user, socketUsers) { ... }

// Sonrası
function systemMsg(channelId: string, serverId: string, content: string): Record<string, unknown>
function formatDuration(seconds: number): string
function registerMessageHandlers(
  socket: Socket,
  io: IOServer,
  user: AuthUser,
  socketUsers: Map<string, SocketUser>
): void
```

Tüm socket event callback parametreleri inline interface ile tiplendirildi:
```typescript
socket.on('message:edit', async ({ messageId, channelId, content }: {
  messageId: string; channelId: string; content: string;
}) => { ... });
```

Yeni interface'ler eklendi: `AuthUser`, `SocketUser`, `SendMessagePayload`, `DbModule`, `DbClient`.

---

## 3. Input Validation Katmanı (−0.5 → 0)

**Sorun:** Socket handler'larında `req.body.x` direkt kullanımına benzer şekilde socket event payload'ları
hiç doğrulanmıyordu. `server/middleware/validate.ts`'de HTTP route'ları için `validateBody()` + `schemas`
mevcuttu ama socket handler'ları kapsam dışıydı.

**Yapılan değişiklikler:**

`server/middleware/validate.ts`'e eklendi:
- `validateSocketPayload(data, schema): SocketValidationResult` — middleware zincirine gerek duymadan
  herhangi bir fonksiyon içinden çağrılabilen saf doğrulama fonksiyonu
- `socketSchemas` — `sendMessage`, `editMessage`, `reactMessage`, `deleteMessage`, `pinMessage`, `fileSend`
  için tip-güvenli şemalar (`satisfies Schema` ile)

`server/socket/handlers/messages.ts`'de kullanıldı:
```typescript
const { valid } = validateSocketPayload(data, socketSchemas.sendMessage);
if (!valid) return;
```

`message:send`, `message:edit`, `message:react` event'lerinde payload doğrulaması aktif.

**Not:** Bu proje mevcut sıfır-bağımlılık `validate.ts` altyapısını genişletiyor. Zod/Joi tercih edilirse
`validateSocketPayload` imzası değişmeden altta Zod kullanılabilir.

---

## 4. Kısmi Migration Tutarsızlığı (−0.3 → 0)

**Sorun:** `db/loader.ts` `eslint-disable` + `require('./postgres')` kullanıyordu; `_optional-require.ts`
varken bunun bir istisna mı kural mı olduğu belirsizdi. DEPLOYMENT_GUIDE yorum satırı bu kararın
gerekçesini belgelememişti.

**Yapılan değişiklikler:**
- `require('./postgres')` → `tryRequire('./postgres')`
- Neden `import` değil `tryRequire`: circular bağımlılık + conditional runtime load gerekçesi comment olarak eklendi
- Yüklenemezse `process.exit(1)` davranışı korunuyor

---

## Değişiklik Özeti

| Dosya | Önce | Sonra |
|-------|------|-------|
| `server/socket/handlers/messages.ts` | 10 eslint-disable, 10 inline require, 4 tipsiz fonksiyon | 0 / 0 / tam tipli |
| `server/middleware/rateLimit.ts` | 4 eslint-disable, 4 inline require | 0 / 0 |
| `server/db/loader.ts` | 1 eslint-disable, 1 inline require | 0 / 0 |
| `server/middleware/validate.ts` | HTTP-only validation | + socket payload validation |

**Etkilenen test dosyaları:** `server/tests/messages.test.ts` socket event testleri artık geçersiz payload
için erken `return` görecek — bu beklenen davranış, test güncellemesi gerekmez ama doğrulama için
coverage eklenebilir.
