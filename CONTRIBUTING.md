# Bridge'e Katkıda Bulunma

[![CI](https://github.com/fatihcayiroglu/Bridge/actions/workflows/quality-gate.yml/badge.svg)](https://github.com/fatihcayiroglu/Bridge/actions/workflows/quality-gate.yml)
[![Server Coverage](https://img.shields.io/badge/server%20coverage-%E2%89%A590%25-1D9E75)](https://github.com/fatihcayiroglu/Bridge/actions)
[![Client Coverage](https://img.shields.io/badge/client%20coverage-%E2%89%A590%25-1D9E75)](https://github.com/fatihcayiroglu/Bridge/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20%2B%200%20any-378ADD)](https://github.com/fatihcayiroglu/Bridge)
[![i18n](https://img.shields.io/badge/i18n-10%20dil%20%7C%202270%20anahtar-BA7517)](./client/js/core/i18n)

Bridge açık kaynak bir projedir. Her türlü katkıya açığız!

## Başlamak

```bash
git clone https://github.com/fatihcayiroglu/Bridge.git
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
npm test                    # Tüm server testleri
npm run test:coverage       # Coverage raporu / release eşikleri
npm run test:watch          # Watch modu (geliştirme sırasında)
```

### Gerçek PostgreSQL testleri (Final21 Faz 16'da belgelendi)

Bazı davranışlar YALNIZCA gerçek veritabanında görünür: birim testlerin bellek-içi deposu
NOT NULL'ı ve sütun izin listesini zorlamaz. İki paket vardır. Varsayılan `npm test` içinde
bağlantı dizesi olmadığı için **atlanırlar** (ATLANMIŞ olarak raporlanır). Aşağıdaki özel
komutlar ise adres verilmezse **çalışmayı reddeder (çıkış 1)**: Final21 Faz 19'a kadar
adressiz çağrı tüm testleri atlayıp çıkış 0 veriyordu, yani bir kapı "geçti" diye kaydedebiliyordu:

```bash
cd server
# Şema / eşzamanlılık / sorgu planı paketi (tests/pg-integration/*.pgtest.ts)
PG_TEST_URL=postgresql://user:pass@host:port/tek_kullanimlik_db npm run test:pg

# Birleşik arama canlı paketi (FTS indeks hizası, aksan duyarsızlaştırma, yetki kapsamı)
SEARCH_IT_DATABASE_URL=postgresql://user:pass@host:port/tek_kullanimlik_db npm run test:search-it
```

Veritabanı **tek kullanımlık** olmalı ve migration'ları uygulanmış olmalıdır
(`DATABASE_URL=... npm run db:migrate:pg`). Faz 16'ya kadar bu paketler hiçbir yerde
belgelenmemişti: arama paketi kendi fikstüründe kırıktı (migration 071'de eklenen yabancı
anahtarlar) ve 16 test yalnızca "atlanmış" görünüyordu.

### Client testleri
```bash
npm run test:svelte              # tüm client paketi (CI bunu koşar)
npm run test:svelte:coverage     # + %90 S/B/F/L kapsam kapısı (CI bunu da koşar)
```

`test:svelte:coverage`, vitest kapsamını ölçtükten sonra
`client/scripts/production-reachable-coverage.js --enforce-90` çalıştırır ve İKİ sayı basar:
**TÜM KAYNAK** ve **ÜRETİMDE ULAŞILABİLİR** (yalnızca gerçek giriş noktalarından import
grafiğiyle erişilen dosyalar). Ulaşılamayan dosyalar kapsamdan DIŞLANMAZ — gizlemek yüzde
oyunu olurdu; iki sayı arasındaki fark ürün hakkında bir bulgudur (bağlanmamış özellik /
ölü modül). Son ölçüm: 223/223 dosya ulaşılabilir, yani ölü modül yok.

> Faz 17 notu: bu betik package.json'da tanımlıydı ama hiçbir yerde ÇAĞRILMIYORDU —
> ne CI, ne `verify:all`, ne preflight. Yani istemci eşiği yalnızca birinin elle
> yazmasına bağlıydı. Artık `quality-gate.yml` içinde koşuyor ve preflight varlığını
> mandallıyor.

Client testlerinin tek canonical koşucusu Vitest'tir; `client/tests` altında ayrı npm/Jest toolchain tutulmaz.

### Mutasyon kampanyası — testler gerçekten koruyor mu?

Geçen test sayısı bir şey kanıtlamaz. Kanıt şudur: ürün kodunu bilerek bozduğumuzda
testler başarısız oluyor mu?

```bash
cd server
npm run test:mutation
```

Her mutasyon GERÇEK bir güvenlik/doğruluk özelliğini tersine çevirir (XFF güveni, 2FA yedek
kodları, WS bağlantı limiti, DB ayrıcalık denetimi, HAM mesaj saklama, yetki iptalinde oda
tahliyesi, AutoMod fail-closed, silinen mesajın geri gelmemesi, push dili, "yazıyor" olayı).
Bir mutasyon HAYATTA KALIRSA o özellik test EDİLMİYOR demektir; aranan metin bulunamazsa
"geçti" sayılmaz, BULUNAMADI olarak raporlanır.

Yeni bir güvenlik düzeltmesi yazarken kampanyaya o düzeltmeyi TERSİNE ÇEVİREN bir mutasyon
ekleyin: kapsam yüzdesi değil, bu kilitler regresyonu durdurur.

### E2E testleri
```bash
cd e2e
npx playwright test         # Tüm E2E
npx playwright test auth    # Tek spec / eşleşen test
npx playwright test --ui    # Playwright UI modu
```

### CI guard'larını yerel çalıştırma
```bash
# TypeScript any kontrolü (ceiling = 0)
node scripts/check-any-count.js

# i18n parity (10 dil eşleşmeli: de en es fr ja ko pt ru tr zh)
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

[Issues](https://github.com/fatihcayiroglu/Bridge/issues) sayfasını kullan.  
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
