# Bridge'e Katkıda Bulunma

[![CI](https://github.com/bridge-app/bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/bridge-app/bridge/actions/workflows/ci.yml)
[![Server Coverage](https://img.shields.io/badge/server%20coverage-%E2%89%A590%25-1D9E75)](https://github.com/bridge-app/bridge/actions)
[![Client Coverage](https://img.shields.io/badge/client%20coverage-%E2%89%A585%25-1D9E75)](https://github.com/bridge-app/bridge/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20%2B%200%20any-378ADD)](https://github.com/bridge-app/bridge)
[![i18n](https://img.shields.io/badge/i18n-15%20dil%20%7C%20202%20anahtar-BA7517)](./client/js/core/i18n)

Bridge açık kaynak bir projedir. Her türlü katkıya açığız!

## Başlamak

```bash
git clone https://github.com/bridge-app/bridge.git
cd bridge/server
npm install
cp server/.env.example server/.env   # JWT_SECRET ve REFRESH_SECRET doldur
npm start
```

## Pull Request Süreci

1. Repo'yu fork'la
2. Feature branch oluştur: `git checkout -b feature/ozellik-adi`
3. **Testleri yaz** — yeni kod için test beklenir (hedef: %90 satır coverage)
4. **CI guard'larını kontrol et:** `npm run lint && npm run typecheck`
5. Değişikliklerini commit'le: `git commit -m 'feat: kısa açıklama'`
6. Branch'i push'la: `git push origin feature/ozellik-adi`
7. Pull Request aç — PR şablonunu doldur

**PR boyut kısıtlaması:** Tek bir PR'da 400'den fazla satır değişiklik tercih edilmez.
Büyük özellikler birden fazla PR'a bölünmeli; her PR bağımsız olarak merge edilebilir olmalıdır.

## Commit Mesaj Formatı

[Conventional Commits](https://www.conventionalcommits.org/) standardını kullanıyoruz:

```
feat: yeni özellik
fix: hata düzeltmesi
docs: dokümantasyon güncellemesi
refactor: kod yeniden düzenleme (özellik/hata yok)
test: test ekleme/düzenleme
chore: build, bağımlılık güncellemeleri
```

## Testleri Çalıştırma

### Server testleri
```bash
cd server
npm test                    # Tüm testler (146 dosya)
npm run test:coverage       # Coverage raporu (eşik: %90 satır)
npm run test:watch          # Watch modu (geliştirme sırasında)
```

### Client testleri
```bash
cd client/tests
npm test                    # Tüm client testleri (65 dosya)
npm run test:coverage       # Coverage raporu (eşik: %85 satır)
```

### E2E testleri
```bash
cd e2e
npx playwright test         # Tüm E2E (26 spec)
npx playwright test auth    # Tek spec
npx playwright test --ui    # Playwright UI modu
```

### CI guard'larını yerel çalıştırma
```bash
# TypeScript any kontrolü (ceiling = 0)
node scripts/check-any-count.js

# i18n parity (15 dil eşleşmeli)
node scripts/check-i18n-parity.js

# Hub/Space/Flow terminoloji anahtarları
bash -c 'for lang in tr en de fr; do grep -q "hub" client/js/core/i18n/${lang}.ts || echo "EKSIK: $lang"; done'

# Svelte sınır kontrolü (ADR-0008)
bash scripts/check-svelte-boundary.sh

# npm audit
cd server && npm run audit:check
```

## Kod Stili

- ESLint kurallarına uy: `npm run lint`
- `'use strict'` direktifi kullan
- Async/await tercih et, callback zinciri kullanma
- Türkçe yorum yazabilirsin — proje Türkçe topluluğa odaklanıyor

---

## Proje Kuralları (Sprint 67+)

Aşağıdaki kurallar CI'da zorlanır. PR açmadan önce kontrol et.

### 1. `tryRequire` Kuralı

Opsiyonel runtime bağımlılıkları (Redis, prom-client, sharp vb.) doğrudan `require()` ile yüklenmez.
`server/lib/_optional-require.ts` içindeki `tryRequire` wrapper'ı kullanılır:

```typescript
// ❌ Yanlış
const { createClient } = require('redis');

// ✅ Doğru
import { tryRequire } from '../lib/_optional-require';
const redisLib = tryRequire<{ createClient(opts: { url: string }): RedisClient }>('redis');
if (!redisLib) return null; // modül yoksa graceful degrade
const { createClient } = redisLib;
```

**Neden:** Opsiyonel bağımlılıklar deploy'da bulunmayabilir. `tryRequire` bulunamazsa `null`
döndürür; uygulama çökmek yerine ilgili özelliği devre dışı bırakır. Ayrıca lint CI'da
`@typescript-eslint/no-require-imports` kuralını ihlal etmez — `tryRequire` içindeki tek
`eslint-disable` yorumu kasıtlıdır ve belgelenmiştir.

### 2. Socket Payload Doğrulama Kuralı

Socket.IO handler'larında gelen her payload `validateSocketPayload` ile doğrulanır:

```typescript
// ❌ Yanlış — payload doğrudan kullanılıyor
socket.on('canvas:draw', (payload) => {
  const { channelId } = payload;
});

// ✅ Doğru
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';

socket.on('canvas:draw', (payload) => {
  if (!validateSocketPayload(payload, socketSchemas.canvasDraw).valid) return;
  const { channelId, stroke } = payload as { channelId: string; stroke: unknown };
});
```

Yeni socket event'leri için `server/middleware/validate.ts` içindeki `socketSchemas`'a şema ekle.

### 3. TypeScript Strict Gate

`server/` altındaki tüm dosyalar strict TypeScript modunda derlenir (`noImplicitAny: true`,
`strictNullChecks: true`). Yeni dosyalarda `any` kullanımı kabul edilmez.

**Doğru alternatifleri:**

| Kaçınılacak | Tercih edilecek |
|---|---|
| `catch (e: any)` | `catch (e: unknown)` + `instanceof Error` kontrolü |
| `(err: any, req: any, ...)` | `import type { ErrorRequestHandler } from 'express'` |
| `socket: any` | `import type { Socket } from 'socket.io'` veya yerel interface |
| `register(...) as any` | `register(...) as unknown as BeklenenTip` |

Strict gate'e yeni dosya eklemek için `server/tsconfig.json`'daki `include` listesine
ilgili glob'u ekle ve CI'ın geçtiğini doğrula.

### 4. Express Error Handler Tipi

Express error handler'larında 4 parametre için `any` kullanılmaz:

```typescript
// ❌ Yanlış
router.use((err: any, req: any, res: any, next: any) => { ... });

// ✅ Doğru
import type { ErrorRequestHandler } from 'express';
const errHandler: ErrorRequestHandler = (err, req, res, next) => { ... };
router.use(errHandler);
```

### 5. `eslint-disable` Yorumu Kullanımı

`eslint-disable` yorumları yalnızca gerçek teknik zorunluluk için kullanılır:

- ✅ `tryRequire` içindeki tek `no-require-imports` suppress — kasıtlı, belgelenmiş
- ✅ `require('../../package.json')` gibi JSON import'ları — Node.js'te zorunlu
- ❌ String içindeki `require(...)` örnekleri için suppress — string'i düz yaz, suppress kaldır
- ❌ `import` sözdizimi kullanan satırın üstünde `no-require-imports` suppress — oxymoron

---

## Sorun Bildirimi

[Issues](https://github.com/bridge-app/bridge/issues) sayfasını kullan.  
Güvenlik açıkları için lütfen önce özel mesaj at.

## Lisans

Katkılarınız MIT lisansı altında yayınlanacaktır.

### 6. Sprint Changelog Konumu

Sprint notları (`SPRINT*_CHANGES.md`) repo kökünde **tutulmaz**.
Tüm changelog dosyaları `docs/changelogs/` dizininde saklanır:

```
docs/changelogs/
  SPRINT29_CHANGES.md
  SPRINT30_CHANGES.md
  ...
  SPRINT102_CHANGES.md
```

Yeni sprint notu oluştururken dosyayı doğrudan `docs/changelogs/` altına ekle.

---

### 7. Migration Dosyası İsimlendirme Kuralı

`server/db/migrations_pg/` altındaki migration dosyaları şu kurallara uyar:

**SQL migration (pgMigrate / CLI):**
```
NNN_kisa_aciklama.sql          → 011_sprint96_boost_vanity.sql
```

**Rollback:**
```
rollback/NNN_kisa_aciklama.down.sql
```

**TypeScript sabitleri (EXTRA_TABLES için):**

Eğer bir migration ek TypeScript sabitleri gerektiriyorsa (örn. `EXTRA_TABLES`'a spread edilecek
diziler), `_inline.ts` son ekiyle **aynı numarayı** paylaşır:

```
010_bot_marketplace.sql           ← SQL migration (CLI ile çalıştırılır)
010_bot_marketplace_inline.ts     ← TS sabitleri (migrations.ts EXTRA_TABLES'a spread edilir)
```

`_inline.ts` dosyası **bağımsız bir migration numarası değildir**; `.sql` dosyasıyla birlikte
aynı özellik setine aittir. Yalnızca `migrations.ts`'in `import` ettiği sabitler burada tanımlanır.

**Kural:** Her yeni migration için önce `.sql` yaz. TypeScript sabitleri gerektiriyorsa
`_inline.ts` ekle ve `migrations.ts` başına import ekle.
