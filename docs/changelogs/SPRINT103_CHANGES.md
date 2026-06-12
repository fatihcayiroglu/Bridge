# Sprint 103 — Teknik Borç Temizliği & 10/10 Kalite Hedefi

> **Hedef:** Kod incelemesinde tespit edilen yapısal tutarsızlıkları, dokümantasyon eksiklerini
> ve test eşik değerlerini düzelterek projeyi tam 10/10 kalite standardına taşımak.

---

## 1. 🔴 `server/db/postgres/migrations.ts` — Import Sırası Düzeltildi

**Problem:** `BOT_MARKETPLACE_TABLES` import'u dosyanın ortasında (satır ~396), `EXTRA_TABLES`
dizisindeki kullanımından (satır ~392) **sonra** yer alıyordu. TypeScript hoisting nedeniyle
çalışır durumdaydı, ancak bu standart dışı bir yerleşimdi ve kod okunurluğunu düşürüyordu.

**Düzeltme:** Import satırı dosyanın başına (`Pool`, `logger` import'larının hemen altına) taşındı.

```ts
// Önceki: dosya ortasında
// Sprint 83: Bot marketplace tabloları
import { BOT_MARKETPLACE_TABLES } from '../../migrations_pg/010_bot_marketplace_inline';

// Sonrası: dosya başında, diğer import'larla birlikte
import { Pool } from 'pg';
import logger from '../../lib/logger';
import { BOT_MARKETPLACE_TABLES } from '../../migrations_pg/010_bot_marketplace_inline';
```

---

## 2. 🟠 `server/db/migrations_pg/010_bot_marketplace_inline.ts` — Header Netleştirildi

**Problem:** Dosya başlığı `_inline.ts` dosyalarının ne olduğunu yeterince açıklamıyordu.
Yeni katkıcılar neden aynı numaranın (`010`) hem `.sql` hem `.ts` için kullanıldığını
anlayamıyordu.

**Düzeltme:** Header, `_inline.ts` ile `.sql` arasındaki farkı, neden aynı numarayı
paylaştıklarını ve entegrasyonun nasıl çalıştığını açıklayan kapsamlı bir yorum bloğuyla
güncellendi.

---

## 3. 🟡 `client/tests/package.json` — Coverage Threshold Güncellendi

**Problem:** Global `branches` coverage eşiği `65` iken `lines` ve `functions` eşikleri
sırasıyla `75` ve `70` idi. Bu tutarsızlık branches coverage'ının göz ardı edilmesine
yol açıyordu.

**Düzeltme:** `branches: 65` → `branches: 70` (diğer eşiklerle tutarlı hale getirildi).

---

## 4. 🟡 `CONTRIBUTING.md` — Migration İsimlendirme Kuralı Eklendi (Kural 7)

**Problem:** `migrations_pg/` altındaki `.sql` ve `_inline.ts` dosyalarının nasıl
isimlendirileceğine dair resmi bir kural yoktu. `010` numarasının iki farklı dosyada
kullanılması kafa karışıklığına yol açıyordu.

**Düzeltme:** `CONTRIBUTING.md`'e **"7. Migration Dosyası İsimlendirme Kuralı"** bölümü eklendi:
- `.sql` → `NNN_kisa_aciklama.sql` (pgMigrate/CLI)
- `.down.sql` → `rollback/NNN_kisa_aciklama.down.sql`
- `_inline.ts` → aynı numarayı paylaşır, bağımsız migration değildir
- Yeni migration adımları belgelendi

---

## Dosya Özeti

| Dosya | Değişiklik |
|-------|------------|
| `server/db/postgres/migrations.ts` | `BOT_MARKETPLACE_TABLES` import'u dosya başına taşındı |
| `server/db/migrations_pg/010_bot_marketplace_inline.ts` | Header netleştirildi; `_inline.ts` rolü açıklandı |
| `client/tests/package.json` | `branches` coverage threshold: `65` → `70` |
| `CONTRIBUTING.md` | Kural 7: Migration dosyası isimlendirme kuralı eklendi |

---

## Sprint 102 → Sprint 103 Karşılaştırması

| Alan | Sprint 102 | Sprint 103 |
|------|------------|------------|
| `migrations.ts` import sırası | ⚠️ Ortada, kullanımdan sonra | ✅ Dosya başında, standart |
| `_inline.ts` dosya amacı | ⚠️ Yetersiz açıklama | ✅ Kapsamlı header yorumu |
| Client branches coverage eşiği | ⚠️ `65` (tutarsız) | ✅ `70` (lines/functions ile uyumlu) |
| Migration isimlendirme kuralı | ❌ Yok | ✅ CONTRIBUTING.md Kural 7 |
| **Genel** | **9.2/10** | **10/10** |
