# Bridge — Sprint İyileştirmeleri (A/B/C1/D)

> Temel: 8.2/10 → Hedef: 9.5/10

---

## ✅ Sprint A — DB Katmanı Refactor

### Değişen Dosyalar
- `server/db/postgres.ts` → barrel redirect'e dönüştürüldü (6 satır)
- `server/db/postgres/pool.ts` → bağlantı yönetimi ayrıldı
- `server/db/postgres/transaction.ts` → `withTransaction` tek yerden
- `server/db/postgres/fts.ts` → full-text search modülü
- `server/db/postgres/index.ts` → TABLE_MAP + db nesnesi + initSchema
- `server/db/postgres/migrations.ts` → inline migration'lar

### Başarı Kriterleri
- [x] `postgres.ts` barrel redirect oldu (silinebilir, geriye dönük uyumluluk için bırakıldı)
- [x] `withTransaction` / `ftsSearch` tek yerden export ediliyor
- [x] Hiçbir alt modül 300 satırı geçmiyor

---

## ✅ Sprint B — Frontend window.* Temizliği

### Değişen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `client/js/core/noise-suppression.ts` | `window.BridgeNS` → `bridgeNS` + export |
| `client/js/core/onboarding-tour.js` | `window.BridgeTour` → BridgeRegistry, döngüsel `getBridgeTour` kaldırıldı |
| `client/js/core/e2e.ts` | 4 adet `onclick="window.BridgeE2E.*"` → `data-bridge-action` attribute |
| `client/js/core/drafts.js` | `window.sendMessage` monkey-patch → `BridgeRegistry.register` intercept |
| `client/js/core/i18n.js` | `window.i18n?.toggleLang()` → `BridgeRegistry.call('i18n:toggleLang')` |

### Başarı Kriterleri
- [x] Tüm `window.Bridge*` referansları BridgeRegistry'ye taşındı
- [x] `getBridgeTour = () => window.BridgeTour` döngüsel referansı kaldırıldı
- [x] Meşru browser API'leri (`window.addEventListener`, `window.scrollX` vb.) korundu

---

## ✅ Sprint C1 — Kritik Client Testleri

### Yeni Test Dosyaları

| Test Dosyası | Kapsam | Test Sayısı |
|---|---|---|
| `client/tests/e2e.test.js` | Web Crypto, IndexedDB, modal HTML, BridgeRegistry | 17 test |
| `client/tests/voice-recorder.test.js` | MediaRecorder, getUserMedia, AudioContext, upload, maxDuration | 18 test |
| `client/tests/group-dm.test.js` | API CRUD, DOM render, socket, XSS koruma | 17 test |

### package.json Güncellemesi
Coverage threshold eklendi:
- `e2e.ts`: lines 85%, functions 80%
- `voice-recorder.ts`: lines 75%, functions 70%
- `group-dm.ts`: lines 70%, functions 65%

Toplam client test dosyası: 12 → **15** (C2/C3 ile 22+ hedefi)

---

## ✅ Sprint D — API Versioning

### Değişen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `server/app/setupRoutes.ts` | `mountApi` → versionless `/api` rotalarına `Deprecation: true` header |
| `server/lib/swagger.ts` | `/api` server açıklaması deprecated olarak güncellendi |
| `bot-sdk/src/index.ts` | `_api()` → `Deprecation` header tespiti + `console.warn` + event emit |

### Başarı Kriterleri
- [x] `/api/...` istekleri `Deprecation: true` + `Link: </api/v1>; rel="successor-version"` header'ı taşıyor
- [x] Swagger UI'da `/api/v1` canonical gösteriliyor
- [x] Bot SDK `Deprecation` header görünce `console.warn` basıyor ve `deprecationWarning` event emit ediyor

---

## Kalan Sprint'ler

| Sprint | Durum | Tahmini Efor |
|---|---|---|
| C2: i18n, search, discord-import testleri | 🔄 Devam ediyor (18/22+ test dosyası) | 1 hafta |
| C3: dm-call, clyde, semantic-search testleri | Bekliyor | 1 hafta |
| E: PostgreSQL replica + CDN | Bekliyor | 1 hafta |
| F: Frontend framework kararı + Preact geçişi | Bekliyor | Uzun vadeli |
