# SPRINT74_CHANGES.md
_Tarih: 2026-05-21 | Temel: Sprint 73 (8.4/10)_

---

## Özet

Sprint 74, kod inceleme raporunun belirlediği **5 teknik borç maddesini** kapatır.
Hiçbir public API değişmedi; tüm değişiklikler geriye uyumludur.

---

## 1. `server/routes/upload.ts` — 4 düzeltme

### Fix 1 — `DELETE /upload/cdn`: Dosya sahipliği kontrolü eklendi

**Sorun:** Endpoint yalnızca `authMiddleware` içeriyordu. Giriş yapmış herhangi
bir kullanıcı, başkasının yüklediği dosyayı `key` parametresiyle silebiliyordu.

**Yapılan:**

| Durum | Davranış |
|-------|----------|
| `isAdmin: true` | DB sorgusu atlanır, doğrudan siler (admin bypass) |
| Dosya sahibi | `db.messages` + `db.dmMessages` ILIKE araması — eşleşirse siler |
| Başka kullanıcı | `403 Forbidden` |
| Mesaj bulunamadı | `404 Not Found` (sessiz başarı değil) |

Sahiplik araması `$regex` operatörü ile yapılır (pgCollection tarafından
`ILIKE '%filename%'` SQL'e dönüştürülür). Hem channel mesajları hem DM
mesajları paralel sorgulanır (`Promise.all`).

**Path traversal koruması korundu:** `..` strip + `uploads/` prefix zorunluluğu
aynen kaldı.

---

### Fix 2 — `sharp` dynamic `require()` → ESM `import()`

**Sorun:** `require('sharp')` ve `require('../lib/logger')` kullanımı
`eslint-disable @typescript-eslint/no-require-imports` satırları gerektiriyordu
— TS geçiş sürecini yavaşlatan bir antipattern.

**Yapılan:**

```typescript
// Eskisi
if (WEBP_CONVERT) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _sharp = require('sharp');
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../lib/logger').warn(...);
  }
}

// Yenisi
async function getSharp(): Promise<SharpFn | null> {
  if (_sharpLoaded) return _sharp;
  _sharpLoaded = true;
  try {
    const mod = await import('sharp');
    _sharp = (mod.default ?? mod) as unknown as SharpFn;
  } catch {
    const { default: logger } = await import('../lib/logger');
    logger.warn({ event: 'upload.webp.sharp_missing' }, '...');
  }
  return _sharp;
}
```

`maybeConvertToWebP` artık `async getSharp()` çağırır — lazy load korundu,
`eslint-disable` yorumları kaldırıldı.

---

### Fix 3 — `storage` değişken adı çakışması giderildi

**Sorun:** `upload.ts`'de `const storage = multer.diskStorage(...)` ile
handler içindeki `const storage = getStorageAdapter()` aynı ismi kullanıyordu.
Okuyucuyu yanıltıcıydı; IDE "shadowing" uyarısı veriyordu.

**Yapılan:**

| Eski | Yeni |
|------|------|
| `const storage = multer.diskStorage(...)` | `const diskStorage = multer.diskStorage(...)` |
| `multer({ storage, ... })` | `multer({ storage: diskStorage, ... })` |
| Handler içi `const storage = getStorageAdapter()` | `const cdnAdapter = getStorageAdapter()` |

---

## 2. `server/lib/storageAdapter.ts` — Credential validation (Fix 4)

**Sorun:** S3/R2/MinIO/B2 provider'larında zorunlu env değişkenleri eksik veya
boş string olduğunda `getStorageAdapter()` hatasız geçiyor, hata yalnızca ilk
gerçek upload anında ortaya çıkıyordu.

**Yapılan:** `_validateRemoteCredentials(provider)` iç fonksiyonu eklendi.
`getStorageAdapter()` switch bloğunda her remote provider için validation
önce çalışır; eksik/boş değişken varsa açık hata mesajıyla hemen fırlatır.

```typescript
// Örnek hata mesajı:
// [storageAdapter] CDN_PROVIDER=s3 için zorunlu env değişkenleri eksik veya boş:
//   S3_BUCKET, S3_SECRET_ACCESS_KEY. Lütfen .env dosyasını kontrol edin.
```

Zorunlu değişken tablosu:

| Provider | Zorunlu env'ler |
|----------|----------------|
| `s3`     | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| `r2`     | `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL` |
| `minio`  | `MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` |
| `b2`     | `B2_BUCKET_NAME`, `B2_KEY_ID`, `B2_APP_KEY` |
| `local`  | — (validation çalışmaz) |

**Not:** `local` provider için validation yoktur — geliştirme ortamı etkilenmez.

---

## 3. Test Güncellemeleri

### `server/tests/storageAdapter.test.ts` — 7 yeni test

| Test grubu | Yeni testler |
|-----------|-------------|
| S3 bucket eksikse hata | 1 |
| S3 access key eksikse hata | 1 |
| S3 boş string eksik sayılır | 1 |
| R2 account_id eksikse hata | 1 |
| MinIO tüm değerler varsa validation geçer | 1 |
| B2 bucket adı eksikse hata | 1 |
| Local provider validation çalışmaz | 1 |
| **Sprint 74 toplam yeni test** | **7** |

### `server/tests/upload.test.ts` — 8 yeni test

| Test grubu | Adet |
|-----------|------|
| Unauthenticated → 401 | 1 |
| Geçersiz key (uploads/ prefix yok) → 400 | 1 |
| Path traversal denemesi → 400 | 1 |
| Mesaj bulunamadı → 404 | 1 |
| Başka kullanıcı → 403 | 1 |
| Dosya sahibi → 200 | 1 |
| DM mesajı üzerinden sahiplik → 200 | 1 |
| `[SECURITY]` Admin bypass, findOne çağrılmaz | 1 |
| **Sprint 74 toplam yeni test** | **8** |

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `server/routes/upload.ts` | Değiştirildi | Sahiplik kontrolü, dynamic import, isim düzeltmesi |
| `server/lib/storageAdapter.ts` | Değiştirildi | `_validateRemoteCredentials` eklendi |
| `server/tests/storageAdapter.test.ts` | Değiştirildi | 7 yeni credential validation testi |
| `server/tests/upload.test.ts` | Değiştirildi | 8 yeni DELETE /cdn ownership testi |

---

## Sprint 74 Sonrası Açık Maddeler

- Canary/blue-green deployment stratejisi
- Swagger `/docs` route aktiflik doğrulaması (CI'da `GET /api/docs → 200` kontrolü)
- Monorepo tooling (Turborepo/Nx)
- TypeScript migration (`server/lib/` pure functions)
