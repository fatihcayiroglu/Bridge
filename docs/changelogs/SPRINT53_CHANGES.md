# Sprint 53 Değişiklikleri

## Genel Bakış

Sprint 52'den devredilen 5 teknik borç kapatıldı:

1. **HTTP Signature kenar durum testleri** — 3 yeni güvenlik senaryosu
2. **asyncHandler toplu kaldırma scripti** — Express 5 temizliği için hazırlık
3. **Svelte Faz 0 kurulumu** — ADR-0002 pilot başlangıcı (13 sprint gecikme kapatıldı)
4. **Swagger annotation genişletme** — users, servers endpoint'leri
5. **cleanupUploads CDN adapter** — R2/MinIO/S3 desteği

---

## PHASE 1 — HTTP Signature Kenar Durum Testleri

### Dosya: `server/tests/httpSignature.test.js`

Mevcut test sayısı: **42** → Yeni toplam: **~65**

#### 6a. Blocked Host (SSRF Koruması)

| Test | Beklenen |
|---|---|
| `keyId=https://169.254.169.254/...` (AWS metadata) | 401, fetch çağrılmaz |
| `keyId=https://192.168.1.1/...` (RFC-1918) | 401 |
| `keyId=https://10.0.0.1/...` (RFC-1918) | 401 |
| `keyId=https://127.0.0.1/...` (localhost) | 401 |
| `keyId=https://localhost/...` (hostname) | 401 |
| `keyId=http://...` (non-HTTPS) | 401, fetch çağrılmaz |
| 3xx redirect yanıtı | 401 |

#### 6b. Desteklenmeyen Algoritma

| Test | Beklenen |
|---|---|
| `algorithm=hmac-sha1` | 401 |
| `algorithm=hmac-sha256` | 401 |
| `algorithm=rsa-md5` | 401 |
| `algorithm=ecdsa-sha256` | 401 |
| `algorithm=none` | 401 |
| algorithm parametresi yok (hs2019 fallback) | 5xx değil (crash yok) |

#### 6c. Missing `(request-target)`

| Test | Beklenen |
|---|---|
| header listesinde `(request-target)` yok | 401 (early-return) |
| `(request-target)` olmadan replay girişimi | 401 |

---

## PHASE 2 — asyncHandler Toplu Kaldırma Scripti

### Yeni Dosya: `server/scripts/remove-async-handler.ts`

Express 5 geçişi tamamlandı (Sprint 52). Bu script `asyncHandler` wrapper'larını toplu olarak kaldırır.

**Kullanım:**
```bash
# Önce dry-run — değişiklik yok, rapor göster
npx ts-node server/scripts/remove-async-handler.ts --dry-run

# Gerçek kaldırma
npx ts-node server/scripts/remove-async-handler.ts

# Sonrası doğrulama
npx tsc -p server/tsconfig.json --noEmit
npm test
```

**Kapsam:**
- `asyncHandler(async ... =>)` → `async ... =>` (wrapper kaldır)
- `import asyncHandler from '...asyncHandler'` satırlarını sil
- Kapanış parantezi dengesini düzelt: `}));` → `});`

**Önemli notlar:**
- Regex tabanlı — karmaşık iç-içe callback yapılarını atlayabilir
- `tsc` ve `npm test` çalıştırarak doğrulama zorunlu
- ~319 kullanım → 73 dosya etkilenecek
- Sprint 54 başında çalıştırılması öneriliyor

---

## PHASE 3 — Svelte Faz 0 Kurulumu (ADR-0002)

ADR-0002 Sprint 39'da başlamasını öngörüyordu. Sprint 53'te Faz 0 tamamlandı.

### Yeni bağımlılıklar (`package.json`)

```json
"devDependencies": {
  "esbuild-svelte":         "^0.8.1",
  "svelte":                 "^5.0.0",
  "svelte-check":           "^4.0.0",
  "@testing-library/svelte":"^5.0.0"
}
```

### Build entegrasyonu (`scripts/build.js`)

`esbuild-svelte` plugin eklendi — `require('esbuild-svelte')` başarısız olursa (kurulu değilse) build gracefully devam eder:

```js
plugins: esbuildSvelte
  ? [esbuildSvelte({ compilerOptions: { css: 'injected', runes: true } })]
  : [],
```

`.svelte` uzantısı `resolveExtensions`'a eklendi.

### CI adımı (`.github/workflows/ci.yml`)

```yaml
- name: Svelte typecheck
  run: npm run typecheck:svelte
```

### `client/tsconfig.json`

`include`'e `js/**/*.svelte` eklendi. `moduleResolution: bundler` (svelte-check uyumu).

### SettingsModal Pilot (`client/js/core/settings/`)

ADR-0002 Faz 1'in ilk adası:

| Dosya | Açıklama |
|---|---|
| `SettingsModal.svelte` | Ana modal — sidebar + tab panel, a11y (ARIA, Escape) |
| `tabs/ProfileTab.svelte` | displayName, statusText, statusEmoji düzenleme |
| `tabs/AppearanceTab.svelte` | Tema seçici (koyu/açık/AMOLED) |
| `tabs/NotificationsTab.svelte` | Web Push toggle (mevcut web-push.ts'e köprü) |
| `stores/settingsStore.ts` | Svelte 5 `$state` rune — API save mantığı |

`settings-modal.ts`'e **Svelte köprüsü** eklendi. Etkinleştirmek için:

```js
// index.html veya app.ts içinde:
window.BRIDGE_SVELTE_SETTINGS = true;
```

Flag yoksa eski Vanilla JS modal çalışmaya devam eder (geriye dönük uyumluluk). Sprint 55'te flag kaldırılarak tam geçiş yapılacak.

**Kalan Faz 1 işi (Sprint 54):**
- `PrivacyTab.svelte`, `DevicesTab.svelte`
- `@testing-library/svelte` ile bileşen testleri
- `settings-modal.ts` 726 satır → <50 satır (tam geçiş)

---

## PHASE 4 — Swagger Annotation Genişletme

### Önce/Sonra

| Durum | Annotationlu dosya | Toplam route | Kapsam |
|---|---|---|---|
| Sprint 52 | 28 | 78 | %36 |
| Sprint 53 | 30 | 78 | %38 |

### Eklenen annotationlar

**`server/routes/servers/core.ts`** (önceden: 0 annotation):
- `GET /servers` — üye olunan sunucular
- `POST /servers` — yeni sunucu oluştur
- `PATCH /servers/{serverId}` — sunucu güncelle
- `DELETE /servers/{serverId}` — sunucu sil
- `GET /servers/{serverId}/members` — üye listesi
- `POST /servers/{serverId}/leave` — ayrıl
- `POST /servers/{serverId}/join` — katıl

**`server/routes/users.ts`** (önceden: 0 annotation):
- `GET /users/{userId}` — profil
- `GET /users/{userId}/mutual-servers` — ortak sunucular
- `GET /users/{userId}/presence` — çevrimiçi durum

> **Not:** Kalan ~48 annotation-sız route dosyası için Sprint 54'te `channels.ts`, `dm.ts`, `messages.ts` önceliklendirilecek. Tam kapsam için otomasyon scripti (`scripts/check-swagger-coverage.ts`) Sprint 55'te eklenecek.

---

## PHASE 5 — cleanupUploads CDN Adapter

### Yeni dosya: `server/lib/storageAdapter.ts`

`StorageAdapter` interface + 3 implementasyon:

| Provider | Açıklama |
|---|---|
| `local` (varsayılan) | Disk — eski davranış korundu |
| `r2` | Cloudflare R2 (`@aws-sdk/client-s3`) |
| `minio` | Self-hosted MinIO (`@aws-sdk/client-s3`, path-style) |
| `s3` | AWS S3 (`@aws-sdk/client-s3`) |

**Interface:**
```typescript
interface StorageAdapter {
  listFiles():             Promise<string[]>;
  deleteFile(key: string): Promise<void>;
  keyFromUrl(url: string): string;
  healthCheck():           Promise<boolean>;
}
```

### Güncellenen dosya: `server/jobs/cleanupUploads.ts`

- `fs.readdirSync` / `fs.unlinkSync` → `adapter.listFiles()` / `adapter.deleteFile()`
- `CDN_PROVIDER` env okunarak doğru adapter seçilir
- Yerel modda mtime grace period korundu
- Remote modda yalnızca DB referans kontrolü (mtime metadata Sprint 54'e ertelendi)

### Kurulum (R2/MinIO/S3)

```bash
cd server && npm install @aws-sdk/client-s3
```

```env
# .env
CDN_PROVIDER=r2
R2_ACCOUNT_ID=your_account_id
S3_BUCKET=bridge-uploads
S3_ACCESS_KEY_ID=your_key
S3_SECRET_ACCESS_KEY=your_secret
S3_REGION=auto
```

---

## Özet

| Kategori | Değişiklik |
|---|---|
| Yeni test | ~23 (HTTP Signature kenar durumlar) |
| Yeni script | `remove-async-handler.ts` |
| Yeni Svelte dosyası | 5 (SettingsModal + 3 tab + store) |
| Swagger annotation | +10 (users + servers) |
| Yeni lib | `storageAdapter.ts` |
| Güncellenen dosya | `cleanupUploads.ts`, `settings-modal.ts`, `build.js`, `package.json`, `client/tsconfig.json`, `.github/workflows/ci.yml`, `.env.example` |

## Sprint 54 Backlog

| Öncelik | İş |
|---|---|
| 🔴 | asyncHandler kaldırma scriptini çalıştır + doğrula |
| 🔴 | PrivacyTab.svelte + DevicesTab.svelte tamamla |
| 🔴 | `@testing-library/svelte` ile SettingsModal testleri |
| 🟡 | Swagger: channels.ts, dm.ts, messages.ts |
| 🟡 | storageAdapter için jest testleri (mock S3 client) |
| 🟡 | `BRIDGE_SVELTE_SETTINGS=true` flag'i staging'de aç |
| 🟢 | Remote cleanup için mtime metadata (S3 LastModified) |
| 🟢 | check-swagger-coverage.ts otomasyon scripti |
