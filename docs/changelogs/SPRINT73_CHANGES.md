# SPRINT73_CHANGES.md
_Tarih: 2026-05-21 | Temel: Sprint 72 (medya depolama açığı kapatıldı)_

---

## Özet

Sprint 73, Sprint 72 changelog'unda "ayrı sprint gerektirir" olarak işaretlenen
**medya depolama (S3/R2/MinIO/B2)** açığını kapatır.

`cdnStorage.ts` kaldırıldı ve `storageAdapter.ts` tek, provider-agnostic
depolama katmanına dönüştürüldü. `upload.ts` artık yalnızca bu katmanı kullanır.
Hiçbir public API değişmedi; `CDN_PROVIDER` env değişkeni aynı şekilde çalışır.

---

## 1. `server/lib/storageAdapter.ts` — Refactor + uploadFile eklendi

### Sorun
`cdnStorage.ts` ve `storageAdapter.ts` iki ayrı dosya olarak yaşıyordu:
- `cdnStorage.ts` upload + delete yapıyordu ama `listFiles` yoktu
- `storageAdapter.ts` list + delete yapıyordu ama `uploadFile` yoktu
- `cdnStorage.ts`'de birden fazla syntax hatası vardı (eksik kapanış parantezi)
- `upload.ts` yalnızca `cdnStorage.ts`'i import ediyordu — `storageAdapter.ts` hiç kullanılmıyordu
- Backblaze B2 yalnızca `cdnStorage.ts`'te vardı; `storageAdapter.ts`'te eksikti

### Yapılan

| Değişiklik | Açıklama |
|-----------|----------|
| `uploadFile(localPath, key, opts?)` eklendi | `StorageAdapter` interface'ine eklendi |
| `UploadOpts` interface eklendi | `deleteLocal`, `contentType`, `cacheControl` |
| `UploadResult` interface eklendi | `{ url, key, provider }` |
| B2 provider eklendi | `_b2Config()` factory + env mapping |
| Provider config builders ayrıştırıldı | `_s3Config()`, `_r2Config()`, `_minioConfig()`, `_b2Config()` |
| `S3AdapterConfig` interface export edildi | test + custom kurulum için |
| `PROVIDER` const export edildi | `upload.ts` için `CDN_PROVIDER` yansıması |
| `mimeFromPath()` yardımcısı eklendi | Content-Type tahmini |

### Yeni `StorageAdapter` interface

```typescript
interface StorageAdapter {
  listFiles(): Promise<StorageObject[]>;
  uploadFile(localPath: string, key: string, opts?: UploadOpts): Promise<UploadResult>;
  deleteFile(key: string): Promise<void>;
  keyFromUrl(url: string): string;
  healthCheck(): Promise<boolean>;
}
```

### Desteklenen backend'ler

| `CDN_PROVIDER` | Backend | Gerekli env |
|----------------|---------|-------------|
| `local` (varsayılan) | Sunucu diski (`server/uploads/`) | — |
| `s3` | AWS S3 | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| `r2` | Cloudflare R2 | `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL` |
| `minio` | MinIO (self-hosted) | `MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` |
| `b2` | Backblaze B2 | `B2_BUCKET_NAME`, `B2_KEY_ID`, `B2_APP_KEY` |

---

## 2. `server/lib/cdnStorage.ts` — Kaldırıldı

`cdnStorage.ts` silinir. `storageAdapter.ts` tüm işlevselliği karşılar.

**Migration:** `cdnStorage.ts`'den import yapan varsa:

```typescript
// Eskisi (cdnStorage.ts)
import { uploadToCDN, deleteFromCDN, PROVIDER } from '../lib/cdnStorage';

// Yenisi (storageAdapter.ts)
import { getStorageAdapter, PROVIDER } from '../lib/storageAdapter';
const storage = getStorageAdapter();
await storage.uploadFile(localPath, key);
await storage.deleteFile(key);
```

---

## 3. `server/routes/upload.ts` — cdnStorage → storageAdapter

`upload.ts` artık `getStorageAdapter()` kullanır. Tüm endpointler güncellendi:

| Endpoint | Değişiklik |
|----------|-----------|
| `POST /upload` | `uploadToCDN()` → `storage.uploadFile()` |
| `POST /upload/chunk` | aynı |
| `POST /upload/server-gif` | aynı |
| `DELETE /upload/cdn` | `deleteFromCDN()` → `storage.deleteFile()` |

Response formatı değişmedi — `{ url, cdn, key }` alanları aynı.

---

## 4. `server/tests/storageAdapter.test.ts` — Genişletildi

Sprint 73'te eklenen test senaryoları:

| Test grubu | Yeni testler |
|-----------|-------------|
| `localAdapter.uploadFile()` | 2 |
| `buildS3Adapter.keyFromUrl()` | 3 |
| `buildS3Adapter.uploadFile()` | 1 |
| `getStorageAdapter()` singleton | 2 |
| `getStorageAdapter()` bilinmeyen provider | 1 |
| `getStorageAdapter()` remote providers (s3/r2/minio/b2) | 4 |
| `PROVIDER` export | 1 |
| **Sprint 73 toplam yeni test** | **14** |

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `server/lib/storageAdapter.ts` | Değiştirildi | `uploadFile`, `UploadOpts`, `UploadResult`, B2 provider, `PROVIDER` export |
| `server/lib/cdnStorage.ts` | **Kaldırıldı** | `storageAdapter.ts` ile birleştirildi |
| `server/routes/upload.ts` | Değiştirildi | `cdnStorage` → `storageAdapter` import |
| `server/tests/storageAdapter.test.ts` | Değiştirildi | 14 yeni test senaryosu |

---

## Kurulum Adımları

Local modda ek kurulum gerekmez.

S3/R2/MinIO/B2 için:

```bash
cd server
npm install @aws-sdk/client-s3
```

Ardından `.env`'e uygun değişkenleri ekle — bkz. `MIGRATION_GUIDE_S3.md`.

---

## Sprint 73 Sonrası Açık Maddeler

- Canary/blue-green deployment stratejisi
- Swagger `/docs` route aktiflik doğrulaması
- Monorepo tooling (Turborepo/Nx)
- TypeScript migration (`server/lib/` pure functions)
