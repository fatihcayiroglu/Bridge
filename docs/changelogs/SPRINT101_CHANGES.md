# Sprint 101 — Kapsamlı Tip Güvenliği Taraması

> **Hedef:** Baştan sona tam kod incelemesi — `strict: true` altında implicit `any` barındıran tüm server dosyaları tiplendirildi; escapeHtml duplikasyonu giderildi; version senkronize edildi.

---

## Kapsam

Sprint 99 + Sprint 100'de `server/music.ts` ve `server/socket/handlers/music.ts` düzeltilmişti.  
Bu sprint, `npx tsc -p server/tsconfig.json --noEmit` sıfır hata vermesi için kalan tüm implicit `any`'leri kapattı.

---

## Düzeltilen Dosyalar

### 1. `server/routes/twoFactor.ts` — TOTP Utility Fonksiyonları

RFC 6238 implementasyonundaki 5 yardımcı fonksiyonun tümü tiplendirildi:

```ts
// Önce
function base32Decode(str) { ... }
function base32Encode(buf) { ... }
function hotp(secret, counter) { ... }
function totpNow(secret) { ... }
function generateBackupCodes(n = 8) { ... }

// Sonra
function base32Decode(str: string): Buffer { ... }
function base32Encode(buf: Buffer | Uint8Array): string { ... }
function hotp(secret: string, counter: number): string { ... }
function totpNow(secret: string): string[] { ... }
function generateBackupCodes(n = 8): string[] { ... }
```

### 2. `server/routes/invitePreview.ts` — Duplike escapeHtml + Untyped Helpers

Yerel `function escapeHtml(str)` kaldırıldı; `lib/security.ts`'ten import edildi.  
`ServerRow` interface tanımlandı; yardımcı fonksiyonlar tam tipli:

```ts
import { escapeHtml } from '../lib/security';

interface ServerRow { _id: string; name: string; description?: string; icon?: string; iconUrl?: string; }
function isSafeIconUrl(url: unknown): url is string { ... }
function resolveIcon(server: ServerRow): { type: string; value: string } { ... }
function buildHtml({ server, memberCount, inviteCode, instanceName, instanceUrl }: { ... }): string { ... }
```

### 3. `server/routes/serverProfile.ts` — Duplike escHtml + Untyped slugify

Yerel `escHtml` yerine `lib/security.ts` import'u; `slugify` tiplendirildi:

```ts
import { escapeHtml as _escHtml } from '../lib/security';
const escHtml = (str: unknown): string => _escHtml(str as string);
function slugify(name: string): string { ... }
```

### 4. `server/routes/automod.ts` — `checkMod`

```ts
// Önce
async function checkMod(userId, serverId) { ... }
// Sonra
async function checkMod(userId: string, serverId: string): Promise<boolean> { ... }
```

### 5. `server/routes/semantic.ts` — `keywordSearch`

```ts
function keywordSearch(query: string, messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> { ... }
```

### 6. `server/routes/channelPerms/helpers.ts` — Socket Yardımcıları

```ts
import type { Request } from 'express';

function getIo(req: Request): import('socket.io').Server | null { ... }
function emitPermsUpdated(req: Request, serverId: string, channelId: string): void { ... }
async function sendPermLogMessage(
  req: Request, serverId: string, channelId: string, action: string,
  actorName: string, targetName: string,
  oldVals: Record<string, unknown> | null, newVals: Record<string, unknown> | null,
): Promise<void> { ... }
```

### 7. `server/routes/client-error.ts` — `isValidReport`

```ts
function isValidReport(body: unknown): body is { message: string; type?: string; stack?: string; url?: string } { ... }
```

Type predicate (`body is ...`) sayesinde çağıran tarafta tip narrowing otomatik çalışır.

### 8. `server/socket/handlers/infra.ts` — `registerInfraHandlers` + `handleDisconnect`

Proje genelindeki en uzun untyped imza ikisi:

```ts
interface InfraHandlerOptions {
  socketUsers:        Map<string, SafeUser>;
  typingTimers:       Map<string, ReturnType<typeof setTimeout>>;
  TYPING_TIMEOUT_MS:  number;
  _socketRateStore:   Map<string, number[]>;
  leaveVoice:         (socket: Socket, user: { _id: string }, io: Server) => Promise<void>;
  voiceActivity:      Map<string, number>;
  refreshMemberships: (userId: string) => Promise<void>;
  safeUser:           SafeUser;
}

function registerInfraHandlers(
  socket: Socket, rawSocket: Socket, io: Server,
  user: SafeUser & { _id: string },
  opts: InfraHandlerOptions,
): void { ... }

async function handleDisconnect(
  rawSocket: Socket, user: SafeUser & { _id: string },
  opts: DisconnectOptions,
): Promise<void> { ... }
```

### 9. `server/db/postgres/pgCollection.ts` — DB Core

```ts
function toRow(obj: Record<string, unknown>): Record<string, unknown> { ... }
function fromRow(row: Record<string, unknown> | null): Record<string, unknown> | null { ... }
type QueryValue = string | number | boolean | null | Record<string, unknown> | Array<...>;
function buildWhere(query: Record<string, QueryValue> | null | undefined): { sql: string; params: unknown[]; counter: { n: number } } { ... }
function addParam(v: unknown): string { ... }
function processKey(k: string, v: QueryValue): void { ... }
```

### 10. `server/db/postgres/collection.ts` — Legacy SQLite Compat Layer

```ts
function buildWhere(query: Record<string, unknown> | null | undefined): { sql: string; params: unknown[] } { ... }
function safeCol(name: string): string { ... }
function processKey(k: string, v: unknown): void { ... }
```

### 11. Versiyon Senkronizasyonu

`package.json` + `server/package.json`: `1.97.0` → `1.98.0`

---

## Özet Tablosu

| # | Dosya | Düzeltme |
|---|-------|----------|
| 1 | `server/routes/twoFactor.ts` | 5 TOTP fonksiyon tam tipli |
| 2 | `server/routes/invitePreview.ts` | escapeHtml import + ServerRow interface + 3 helper |
| 3 | `server/routes/serverProfile.ts` | escHtml dedup + slugify |
| 4 | `server/routes/automod.ts` | checkMod |
| 5 | `server/routes/semantic.ts` | keywordSearch |
| 6 | `server/routes/channelPerms/helpers.ts` | getIo + emitPermsUpdated + sendPermLogMessage |
| 7 | `server/routes/client-error.ts` | isValidReport (type predicate) |
| 8 | `server/socket/handlers/infra.ts` | registerInfraHandlers + handleDisconnect + 2 interface |
| 9 | `server/db/postgres/pgCollection.ts` | toRow + fromRow + buildWhere + addParam + processKey |
| 10 | `server/db/postgres/collection.ts` | buildWhere + safeCol + processKey |
| 11 | `package.json` × 2 | 1.97.0 → 1.98.0 |

## Sonuç

Sprint 99 → Sprint 100 → Sprint 101 zinciri tamamlandığında:

- `npx tsc -p server/tsconfig.json --noEmit` → **sıfır hata**
- `escapeHtml` tek kaynaktan (`lib/security.ts`) tüketiliyor — 2 duplikasyon kaldırıldı
- Tüm DB query builder fonksiyonları SQL injection korumasının üstüne tip güvencesi ekledi
- Socket handler'ların public API'si interface'ler aracılığıyla belgelendi
