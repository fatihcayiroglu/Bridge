# Sprint 66 — Eksiklik Giderme (v2)

**Tarih:** 2026-05-20  
**Kapsam:** Sprint 66 değerlendirmesinde tespit edilen 3 eksiklik kapatıldı

---

## 🔴 1. `_resetWorkersForTest` Production Guard

**Sorun:** `workers.ts`'teki `_resetWorkersForTest` fonksiyonu `NODE_ENV !== 'test'`
ortamında da çalışıyordu — production'da yanlışlıkla çağrılırsa tüm SFU worker havuzunu sıfırlar.

**Değişiklik (`server/socket/handlers/mediasoup/workers.ts`):**

```diff
-export function _resetWorkersForTest(): void {
-  sfuWorkers.length = 0;
+export function _resetWorkersForTest(): void {
+  if (process.env.NODE_ENV !== 'test') return;   // ← production guard
+  sfuWorkers.length = 0;
```

- JSDoc güncellendi: "NODE_ENV !== 'test' ortamında no-op olarak çalışır" notu eklendi
- Davranış değişikliği yok — test ortamında tamamen aynı çalışır

---

## 🔴 2. `mediasoup-scaling.test.ts` — `jest.resetModules()` Kaldırıldı

**Sorun:** 5 test içinde `jest.resetModules()` + `require()` kombinasyonu kullanılıyordu.
TypeScript projelerinde bu pattern kırılgan: `ts-jest` modül önbelleğiyle çakışır,
tip bilgisi kaybolur, ESM import'larla uyumsuz.

**Değişiklik (`server/tests/mediasoup-scaling.test.ts`):**

Tüm `jest.resetModules()` + `require(...)` blokları `jest.isolateModulesAsync()` ile değiştirildi:

```diff
- jest.resetModules();
- const { initMediasoup: init, ... } = require('../socket/handlers/mediasoup/workers');
+ let init: typeof initMediasoup;
+ await jest.isolateModulesAsync(async () => {
+   const mod = await import('../socket/handlers/mediasoup/workers');
+   init = mod.initMediasoup;
+   ...
+ });
```

**Etkilenen testler (5 adet):**
- Scale-up THRESHOLD testi
- Scale-up MAX_WORKERS testi
- Scale-down MIN sınır testi (2 adet)
- stopScalingMonitor timer testi

---

## 🟡 3. Plugin Testleri + Coverage Eşikleri

**Sorun:** Sprint 65'te yazılan `allowlist.ts`, `word-filter/index.ts` ve
`welcome-bot/index.ts` için hiç test yoktu. `collectCoverageFrom` ve
`coverageThreshold`'da da bu dosyalar yer almıyordu.

### Yeni dosya: `server/tests/plugins.test.ts`

| Test Grubu | Test Sayısı | Kapsam |
|------------|-------------|--------|
| `validateManifest` — alan doğrulama | 8 | Zorunlu alanlar, id format, version |
| `validateManifest` — izin doğrulama | 6 | allowed/restricted/banned permissions |
| `validateManifest` — kategori | 3 | banned categories, type check |
| `validateManifest` — edge case | 2 | çoklu hata, tüm banned perm/cat seti |
| `isAllowed` | 2 | true/false + console.warn |
| Set kontrolleri | 3 | size, örtüşme yok |
| `word-filter setup` | 8 | config, route, hook, emit senaryoları |
| `welcome-bot setup` | 7 | config, route, hook, template, hata senaryoları |
| **Toplam** | **39** | |

### `server/package.json` güncellemeleri

**`collectCoverageFrom` — eklenenler:**
```json
"../plugins/allowlist.ts",
"../plugins/word-filter/index.ts",
"../plugins/welcome-bot/index.ts"
```

**`coverageThreshold` — eklenenler:**

| Modül | lines | functions | branches |
|-------|-------|-----------|---------|
| `../plugins/allowlist.ts` | 80% | 75% | 70% |
| `../plugins/word-filter/index.ts` | 75% | 70% | 65% |
| `../plugins/welcome-bot/index.ts` | 75% | 70% | 65% |

---

## Değişen Dosyalar (Özet)

| Dosya | Tip | Açıklama |
|-------|-----|---------|
| `server/socket/handlers/mediasoup/workers.ts` | Güncelleme | `_resetWorkersForTest` — NODE_ENV guard |
| `server/tests/mediasoup-scaling.test.ts` | Güncelleme | 5 test: `resetModules` → `isolateModulesAsync` |
| `server/tests/plugins.test.ts` | **YENİ** | 39 test — word-filter, welcome-bot, allowlist |
| `server/package.json` | Güncelleme | 3 plugin dosyası coverage'a eklendi |
