# Sprint 30 Değişiklikleri

## 🔴 KIRMIZI — SQLite Katmanı Tamamen Kaldırıldı

**Durum:** PostgreSQL geçişi Sprint 25'te tamamlanmıştı. SQLite dosyaları yalnızca
test bağımlılığı nedeniyle hayatta kalıyordu. Bu sprint o son engeli kaldırdı.

**Silinen dosyalar:**
- `server/db/sqlite/` — tüm klasör (connection.ts, collection.ts, migrations.ts, migrations/)
- `server/db/index.ts` — eski SQLite entrypoint (deprecated uyarısı Sprint 29'da eklenmişti)
- `server/db/migrate-to-postgres.ts` — tek seferlik migration betiği (tamamlanmış, artık gereksiz)

**Güncellenen testler:**
- `server/tests/auth.test.js` — `better-sqlite3` + `DATA_DIR_OVERRIDE` kaldırıldı,
  `createMockDb()` ile in-memory test DB kullanımına geçildi
- `server/tests/bridge10.test.js` — SQLite Col sınıfı kaldırıldı,
  `createMockDb()` ile in-memory test DB kullanımına geçildi;
  SVG dosya testleri için geçici klasör (`tmpDir`) korundu

**Sonuç:** `better-sqlite3` artık hiçbir test dosyasında kullanılmıyor.
`server/package.json`'dan kaldırılabilir (ayrı PR önerilir).

---


## 🔴 KIRMIZI — `db/loader.ts` SQLite Fallback Kaldırıldı

**Sorun:** `db/index.ts` silindi ama `loader.ts` hâlâ `NODE_ENV === 'test'` durumunda
`require('./index')` çağırıyordu — bu, var olmayan bir dosyayı import etmek demekti.

**Yapılan:**
```ts
// Eski — hatalı
} else if (process.env.NODE_ENV === 'test') {
  db = require('./index');  // ← artık bu dosya yok
}

// Yeni — temiz
// Testler jest.mock('../db/loader', () => mockDb) ile override eder.
// loader.ts artık sadece PostgreSQL bilir.
```

## 🟠 TURUNCU — `lib/fetch.ts` — `AbortSignal.any()` Cast Temizlendi

**Sorun:** Sprint 29'da eklenen `fetchT()` yardımcısı `AbortSignal.any()`'i
çirkin bir double cast ile çağırıyordu:

```ts
// Eski — yanlış
(AbortSignal as unknown as { any(signals: AbortSignal[]): AbortSignal }).any([...])
```

Node 22, `AbortSignal.any()` metodunu native olarak destekler.
TypeScript lib tanımları güncellenmişti ancak cast kaldırılmamıştı.

**Yapılan:**
```ts
// Yeni — temiz
const signal = callerSignal
  ? AbortSignal.any([callerSignal as AbortSignal, timeoutSignal])
  : timeoutSignal;
```

---

## 🟠 TURUNCU — v41/v42/v43/v44 Compat Katmanları Kaldırıldı

**Sorun:** `client/js/core/v41/`, `v42/`, `v43/`, `v44/` klasörleri Sprint 27'de
"teknik borç temizliği" kapsamında `_legacy/` dosyalar silinirken oluşturulmuştu.
Ancak bu klasörler kendileri birer borç birikimi haline geldi:
- Her sprint yeni `v4x/` klasörü ekleniyor, eski kalmaya devam ediyordu
- `index.js` loader'ları `<script>` enjeksiyonu yapıyordu — ESM dışı yük
- 25 modül, 224KB kod ana `core/` yerine parçalı klasörlerde dağılıyordu

**Yapılanlar:**
- `v41/go-live.js`, `v41/onboarding.js`, `v41/outgoing-webhooks.js` → `core/`'a taşındı
- `v42/forum.js`, `v42/stage.js`, `v42/calendar-picker.js`, `v42/automod.js`, `v42/mobile.js` → `core/`'a taşındı
- `v43/virtual-scroll.js`, `v43/skeleton-loading.js`, `v43/search-highlight.js`,
  `v43/drafts.js`, `v43/themes.js`, `v43/ai-streaming.js`, `v43/auth-revoked.js` → `core/`'a taşındı
- `v44/voice-volume.js`, `v44/advanced-search.js`, `v44/slow-mode.js`,
  `v44/audit-log.js`, `v44/styles.js`, `v44/boost.ts` → `core/`'a taşındı
- Taşınan dosyalardaki `../globals.js` importları `./globals.js` olarak güncellendi
- `v41/`, `v42/`, `v43/`, `v44/` klasörleri (25 dosya + 4 index.js loader) silindi
- `scripts/build.js` — `core/v41/go-live.js` → `core/go-live.js` güncellendi
- `MODULARITY.md` — klasör yapısı ve chunk tablosu güncellendi

---

## 🟡 SARI — Client ES Module Giriş Noktası

**Sorun:** `client/js/app.ts` `window.socket` ve `window.bindGroupDmSocketEvents`'i
`typeof` guard ile kontrol ediyordu — gerçek bir modül bağımlılığı ifade edilmiyordu.

**Yapılan:**
- `app.ts` ES module import kullanacak şekilde yeniden yazıldı:
  ```ts
  import { socket }                  from './core/socket.js';
  import { bindGroupDmSocketEvents } from './core/group-dm.ts';
  ```
- `typeof` guard'lar kaldırıldı; modül sistemi bağımlılığı garantileyiyor

**Not:** `globals.ts` zaten `export` kullanıyordu (Sprint 27'den itibaren).
`auth.js` de zaten `import { getAPI } from './globals.js'` ile doğru yapıdaydı.
hCaptcha/Turnstile `window.*` kullanımı kaçınılmaz (external browser SDK).

---

## 🟢 Devam Eden (bu sprintte dokunulmadı)

- `better-sqlite3` `package.json`'dan kaldırma (test geçiş doğrulandıktan sonra)
- A11Y (ARIA labels + klavye navigasyonu)
- OpenTelemetry + Sentry entegrasyonu
- esbuild code splitting → chunk-heavy.js lazy loading
- CDN + WebP (sharp entegrasyonu)
