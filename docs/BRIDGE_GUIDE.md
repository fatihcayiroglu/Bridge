# Bridge Sprint 15 — Teknik Rehber

## 1. Duruma Genel Bakış

### Mevcut Sorun

55 route dosyasının tamamı `.ts` uzantılı ama içerik hâlâ CommonJS `require()`.
`tsconfig.json`'da `strictNullChecks: true` aktif, `strict: false`.
Sonuç: `req.user` tipi `JwtPayload | undefined` → her `.id` erişimi hata.

**Hata kategorileri (tahmini 50-100 hata):**

| Kategori | Örnek | Tahmini Adet |
|----------|-------|--------------|
| `req.user` optional | `req.user.id` → `Object is possibly 'undefined'` | ~360 erişim, 55 dosya |
| `req.query` string\|string[] | `parseInt(req.query.limit)` → `string[]` verilmez | ~22 |
| `req.query` optional | `req.query.cursor` doğrudan geçirilir | ~40 |

---

## 2. strictNullChecks Route Hatalarını Düzeltme Stratejisi

### Strateji A — `castAuthed()` (Hızlı, Minimally Invasive) ✅ ÖNERİLEN

`auth.ts`'de zaten `castAuthed(req)` helper'ı mevcut.
Her route handler'ın ilk satırına eklemek yeterli — dosyanın geri kalanı değişmez.

```typescript
// ÖNCE (hata veriyor):
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  const user = await Users.findById(req.user.id); // ❌ user possibly undefined
}));

// SONRA (tek satır ekle):
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  const { user } = castAuthed(req);              // ✅ user: JwtPayload (kesin)
  const dbUser = await Users.findById(user.id);
}));
```

**Gerekli import (her route dosyasına):**
```typescript
import { castAuthed } from '../middleware/auth';
```

### Strateji B — Handler parametresini `AuthedRequest` olarak tiplemek

```typescript
import { AuthedRequest } from '../middleware/auth';

router.get('/me', authMiddleware, asyncHandler(async (req: AuthedRequest, res) => {
  const user = await Users.findById(req.user.id); // ✅
}));
```

> **Not:** `asyncHandler`'ın `AsyncRequestHandler` tipi `Request` bekler.
> `AuthedRequest extends Request` olduğu için uyumlu — ama TypeScript bazı sürümlerde
> implicit any şikayeti edebilir. Bu durumda Strateji A daha güvenlidir.

### req.query Hataları

`req.query.X` tipi `string | string[] | ParsedQs | undefined`.

```typescript
// ❌ Hatalı:
const limit = parseInt(req.query.limit);

// ✅ Doğru:
const limit = parseInt(String(req.query.limit ?? '50'));
// veya:
const limit = parseInt(req.query.limit as string) || 50;

// ❌ Hatalı (cursor'ı doğrudan Buffer'a ver):
Buffer.from(req.query.cursor, 'base64')

// ✅ Doğru:
const cursorRaw = Array.isArray(req.query.cursor)
  ? req.query.cursor[0]
  : req.query.cursor;
if (cursorRaw) Buffer.from(cursorRaw, 'base64')
```

---

## 3. Dosya Bazlı Öncelik Sırası

Aşağıdaki sırayla çalış — bağımlılık derinliğine göre sıralanmıştır:

```
Önce bunları düzelt (diğerleri import eder):
  1. middleware/auth.ts         ← zaten iyi durumda ✅
  2. routes/roles.ts            ← getMemberPerms, hasPermission export'ları
  3. routes/auth.ts             ← sanitizeUser export'u

Sonra bunları (en çok kullanılan):
  4. routes/servers.ts
  5. routes/messages.ts
  6. routes/channels.ts
  7. routes/dm.ts
  8. routes/users.ts

Son olarak (bağımsız / az kullanılan):
  Geri kalan 47 dosya — hepsinde aynı pattern
```

---

## 4. Toplu Düzeltme Script'i

`server/scripts/fix-strict-nulls.ts` — her route dosyasında otomatik:
1. `castAuthed` import ekler (zaten varsa atlar)
2. `req.user.` → `castAuthed(req).user.` değiştirir
3. `parseInt(req.query.X)` → `parseInt(String(req.query.X ?? ''))` düzeltir

**Çalıştırma:**
```bash
cd server
npx ts-node scripts/fix-strict-nulls.ts --dry-run   # önce kontrol
npx ts-node scripts/fix-strict-nulls.ts              # uygula
npx tsc --noEmit                                      # doğrula
```

---

## 5. PostgreSQL Migration

### Ön Koşullar
- PostgreSQL 14+ çalışıyor olmalı
- `pg` paketi zaten mevcut (`package.json`'da var)

### Adım 1 — Veritabanı Oluştur

```bash
psql -U postgres << 'EOF'
CREATE DATABASE bridge;
CREATE USER bridge_user WITH PASSWORD 'güçlü_şifre_buraya';
GRANT ALL PRIVILEGES ON DATABASE bridge TO bridge_user;

-- PostgreSQL 15+ için gerekli:
\c bridge
GRANT ALL ON SCHEMA public TO bridge_user;
EOF
```

### Adım 2 — .env Güncelle

```env
DATABASE_URL=postgresql://bridge_user:güçlü_şifre_buraya@localhost:5432/bridge
# DATABASE_SSL=true   ← sadece Railway/Supabase/Neon için
# PG_POOL_MAX=20      ← opsiyonel, varsayılan 20
```

### Adım 3 — Dry Run ile Kontrol

```bash
cd server
DRY_RUN=1 DATABASE_URL=postgresql://bridge_user:şifre@localhost:5432/bridge \
  node db/migrate-to-postgres.js
```

Beklenen çıktı:
```
🌉 Bridge SQLite → PostgreSQL Migration
   ⚠️  DRY RUN modu — veritabanına yazılmaz

📂 Kaynak : /path/to/server/data/bridge.db
🐘 Hedef  : postgresql://bridge_user:***@localhost:5432/bridge

✅ PostgreSQL bağlantısı başarılı

📋 [DRY RUN] Schema kurulumu atlandı

📦 Tablolar aktarılıyor...
  ✅ users: N eklendi (dry), 0 hata
  ...
```

### Adım 4 — Gerçek Migration

```bash
DATABASE_URL=postgresql://bridge_user:şifre@localhost:5432/bridge \
  node db/migrate-to-postgres.js
```

### Adım 5 — Doğrulama

```bash
psql -U bridge_user -d bridge -c "
SELECT
  schemaname,
  tablename,
  n_live_tup AS row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC
LIMIT 20;
"
```

### Adım 6 — Sunucuyu Başlat

```bash
# .env'de DATABASE_URL set edilmişse otomatik PG kullanır
npm start
# Konsol: [DB] PostgreSQL modu aktif → postgresql://...
```

---

## 6. Bilinen Sorunlar & Çözümler

### `better-sqlite3` native binary sorunu

Migration script `better-sqlite3` kullanır. Node.js sürümü değiştiyse:
```bash
cd server
npm rebuild better-sqlite3
```

### PostgreSQL `JSONB` vs SQLite `TEXT`

`migrate-to-postgres.js` tüm JSON alanları `parseJson()` ile dönüştürür.
`reactions`, `roles`, `options` gibi alanlar SQLite'ta string, PG'de JSONB olarak gider.
Dönüşüm otomatiktir — ek müdahale gerekmez.

### Sequence/Auto-increment Sorunları

Bridge `_id` için UUID kullandığından PostgreSQL sequence sorunu yoktur.
`BIGSERIAL` alanlar (`createdAt` gibi) SQLite'taki integer değerleriyle dolar.

### NULL Constraint Hataları

Migration `ON CONFLICT DO NOTHING` kullanır.
Hatalı satır sayısı > 0 ise log'a bak:
```bash
DATABASE_URL=... node db/migrate-to-postgres.js 2>&1 | grep "Satır hatası"
```

Genellikle `NOT NULL` kısıtı ihlali — transform fonksiyonuna fallback değer ekle.

---

## 7. CI Entegrasyonu

`tsconfig.session4.json` (`strict: true`) zaten var.
Route'lar düzeltildikten sonra CI'a ekle:

```yaml
# .github/workflows/ci.yml
- name: Session 15 typecheck (strict routes)
  run: |
    cd server
    npx tsc --noEmit --project tsconfig.session15.json
```

`tsconfig.session15.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noEmit": true
  },
  "include": ["routes/**/*.ts", "middleware/**/*.ts"]
}
```

---

## 8. Kontrol Listesi

### TypeScript (strictNullChecks)
- [x] `castAuthed` import eklendi: `routes/servers.ts`
- [x] `castAuthed` import eklendi: `routes/messages.ts`
- [x] `castAuthed` import eklendi: `routes/channels.ts`
- [x] `castAuthed` import eklendi: `routes/dm.ts`
- [x] `castAuthed` import eklendi: `routes/auth.ts`
- [x] `castAuthed` import eklendi: tüm 52 route (otomatik migration — Sprint 16)
- [ ] `req.query` string cast'leri eklendi
- [ ] `npx tsc --noEmit` sıfır hata veriyor
- [x] `tsconfig.session15.json` oluşturuldu
- [x] CI'a yeni typecheck adımı eklendi (Sprint 16)

### PostgreSQL Migration
- [ ] PostgreSQL 14+ kurulu ve çalışıyor
- [ ] `bridge` DB ve `bridge_user` oluşturuldu
- [ ] `.env`'e `DATABASE_URL` eklendi
- [ ] Dry run başarılı (sıfır hata)
- [ ] Gerçek migration çalıştırıldı
- [ ] `pg_stat_user_tables` ile satır sayıları doğrulandı
- [ ] Sunucu `[DB] PostgreSQL modu aktif` loguyla başlıyor
- [ ] Temel API testleri çalışıyor (login, mesaj gönder, sunucu listesi)
- [ ] `.env`'de `DATABASE_URL` olmadan SQLite'a fallback hâlâ çalışıyor
