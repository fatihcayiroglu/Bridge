# Bridge — Sprint 15 Delivery

## Kapsam

Sprint 15: strictNullChecks altyapısı + Bot SDK TypeScript migration.

---

## Yapılan Değişiklikler

### 1. `server/types/express.d.ts` — YENİ DOSYA

Express global namespace augmentation.

```typescript
// Tüm route handler'larında req.user tipi artık Express.User
// authMiddleware sonrası garantili non-null erişim için:
import type { AuthedRequest } from './types/express';

router.get('/me', authMiddleware, asyncHandler(async (req: AuthedRequest, res) => {
  const id = req.user.id;  // ✅ null check gerekmez
}));
```

**Dışa aktarılanlar:**
| Export | Açıklama |
|--------|----------|
| `AuthedRequest` | authMiddleware sonrası `user: JwtPayload` (non-optional) |
| `OptionalAuthRequest` | Public+auth karışık endpointler için |
| `assertAuthed(req)` | Runtime assertion — programcı hatası için |

---

### 2. `server/middleware/auth.ts` — GELİŞTİRİLDİ

`AuthedRequest` ve `castAuthed()` eklendi.

```typescript
// require()-style route'larda kullanım:
const { castAuthed } = require('../middleware/auth');

router.get('/profile', authMiddleware, asyncHandler(async (req, res) => {
  const { id } = castAuthed(req).user;  // ✅
}));
```

**Yeni exportlar:**
- `AuthedRequest` — `user: JwtPayload` (non-optional)
- `castAuthed(req: Request): AuthedRequest` — güvenli tip dönüşümü

---

### 3. `server/middleware/metrics.ts` — DÜZELTİLDİ

`strictNullChecks` uyumluluğu sağlandı.

**Değişiklik:** `let x: Histogram | undefined` → `let x!: Histogram`  
(Definite assignment assertion — tümü `initMetrics()` içinde birlikte set ediliyor)

Buna bağlı olarak kullanım noktalarındaki gereksiz `x!.method()` → `x.method()` düzeltildi.

---

### 4. `bot-sdk/src/index.ts` — YENİ DOSYA (TypeScript Migration)

Bot SDK v1.2.0 JS → v2.0.0 TypeScript tam geçişi.

| Metrik | JS (v1.2.0) | TS (v2.0.0) |
|--------|-------------|-------------|
| Satır | 585 | 816 |
| `export interface` | 0 | 24 |
| `export class` | 6 (any) | 6 (tam tipli) |
| `export const` | 0 | 1 |
| Generic sınıf | 0 | 2 (`BotStore<V>`, `PaginationHelper<T>`) |

**Yeni tipler (seçilmiş):**
```typescript
BotOptions, BotInfo, BotMessage, BotEvents,
CommandContext, ContextCommandContext, ModalContext,
InteractionData, RateLimitData,
ActionRow, Button, ServerMember,
PaginationPage, PaginationOptions<T>,
EmbedFieldOptions, ModalDefinition, ModalField
```

**Breaking change özeti:**
- `sendInteractiveMessage()` yeni metod (buton gönderimi için)
- `EmbedBuilder.addField(name, val, inline?)` → `addField(name, val, { inline? })`
- `BotStore` artık generic: `new BotStore<string>()`
- build adımı: `npm run build` (dist/ klasörü oluşur)

---

### 5. `bot-sdk/tsconfig.json` — YENİ DOSYA

Strict modda TypeScript konfigürasyonu (`strict: true`, `noImplicitAny`, `noImplicitReturns`).

---

### 6. `bot-sdk/package.json` — GÜNCELLENDİ

- `version`: `1.2.0` → `2.0.0`
- `main`: `src/index.js` → `dist/index.js`
- `types`: `dist/index.d.ts` eklendi
- `devDependencies`: `typescript ^5.4.0`, `@types/node ^22.0.0` eklendi
- `scripts`: `build`, `build:watch`, `typecheck`, `clean`, `prepublish`

---

## Değişen Dosyalar

```
server/types/express.d.ts          ← YENİ
server/middleware/auth.ts          ← GELİŞTİRİLDİ
server/middleware/metrics.ts       ← DÜZELTİLDİ
bot-sdk/src/index.ts               ← YENİ (JS yerini alır)
bot-sdk/tsconfig.json              ← YENİ
bot-sdk/package.json               ← GÜNCELLENDİ
bot-sdk/CHANGELOG.md               ← GÜNCELLENDİ
```

---

## Entegrasyon Adımları

### Bot SDK (bot-sdk klasöründe):
```bash
npm install           # typescript + @types/node yükle
npm run build         # dist/ klasörünü oluştur
```

### Server strictNullChecks (mevcut route'lara geçiş):

`require()` tarzı route'larda `castAuthed` kullanımı:
```javascript
const { castAuthed } = require('../middleware/auth');

router.post('/message', authMiddleware, asyncHandler(async (req, res) => {
  const uid = castAuthed(req).user.id;  // artık tip hatası yok
  // ...
}));
```

Yeni TypeScript-style route'larda `AuthedRequest`:
```typescript
import { AuthedRequest } from '../middleware/auth';

router.post('/message', authMiddleware, asyncHandler(async (req: AuthedRequest, res) => {
  const uid = req.user.id;  // ✅
}));
```

---

## Bu Sprint'te Yapılmayan (Kapsam Dışı)

| Görev | Sebep |
|-------|-------|
| SQLite → PostgreSQL migration çalıştırma | DB bağlantısı gerekiyor |
| Client Sentry entegrasyonu | Frontend build pipeline değişikliği |
| CSS Modules refactor | Büyük frontend refactor — ayrı sprint |
| Frontend framework kararı (Svelte/Vue) | Teknik karar, kod değişikliği değil |
| Route'lardaki 50-100 strictNull hatası (tam) | Route'lar require()-style — `any` döndüğünden TS zaten sessiz; gerçek hatalar middleware/lib'de düzeltildi |
