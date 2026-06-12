# SPRINT77_CHANGES.md
_Tarih: 2026-05-23 | Temel: Sprint 76 (8.6/10)_

---

## Özet

Sprint 77 iki teknik borç maddesini kapatır:

1. **77 `console.*` → `createLogger()`** — tüm istemci üretim kodu merkezi logger'a taşındı
2. **Plugin sandbox 5 güçlendirme** — worker izolasyonu gerçek anlamda tamamlandı

Kod incelemesi sonrası beş ek düzeltme uygulandı:

- **`debug()` → `console.debug`** — tarayıcı DevTools log level filtresiyle uyum
- **Mock req/res genişletmesi** — `next()`, `redirect()`, `set()/header()`, `_headersSent` guard
- **`PluginContext.registerRoute` tip düzeltmesi** — handler imzası `next?: (err?) => void` parametresini artık içeriyor; interface, Map tipi ve runtime çağrısı tutarlı
- **Server ESLint `no-console: error`** — client'taki korumanın muadili server'a da getirildi; `lib/env.ts` ve `scripts/` kasıtlı exemption ile belgelendi
- **Zip path yapısı** — orijinalle birebir `bridge_sprint77_full/bridge_sprint77/` (898/898 dosya)

Hiçbir public API değişmedi; tüm değişiklikler geriye uyumludur.

---

## A — `client/js/core/logger.ts` — Yeni merkezi logger

| Özellik | Detay |
|---------|-------|
| API | `createLogger(prefix)` → `{ log, info, warn, error, debug }` |
| Production | `log / info / debug` sessiz; `warn + error` aktif |
| Debug override | `window.BRIDGE_DEBUG = true` (tarayıcıdan açılabilir) |
| Sentry | `error(err: Error)` → `window.errorBoundary.report()` |
| Prefix formatı | `[Modül] mesaj` |

31 istemci dosyasındaki **81 console çağrısı** `log.*` ile değiştirildi.
`client/eslint.config.js` ile `no-console: error` kuralı eklendi — CI koruması aktif.

**19 yeni test** → `client/tests/logger.test.ts`

---

## B — Plugin Sandbox — 5 Güçlendirme

### [1] `resourceLimits` — CPU/memory sınırı

```typescript
const WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 32,
  codeRangeSizeMb: 16,
  stackSizeMb: 4,
};
```

Plugin sonsuz döngüye girerse veya bellek taşarsa worker otomatik sonlandırılır.
Ana process etkilenmez.

### [2] Worker boot timeout — 10 saniye

```typescript
const WORKER_BOOT_TIMEOUT_MS = 10_000;
```

`ready` mesajı gelmezse worker terminate edilir, registry temizlenir.
Önceki davranış: asılı kalırdı.

### [3] `allowlist.ts` — `console.warn` kaldırıldı

`isAllowed()` artık opsiyonel `logger` parametresi alıyor:

```typescript
// Eski
isAllowed(meta)  // içten console.warn çağırırdı

// Yeni
isAllowed(meta, logger)  // caller'ın logger'ı kullanılır
isAllowed(meta)          // sessiz — hata fırlatmaz
```

`loader.ts` güncellendi: `isAllowed(meta, logger)` ile çağrılıyor.

### [4] `require()` → `import()` — ESM uyumlu dinamik yükleme

```typescript
// Eski
const pluginModule = require(loadPath);

// Yeni
const pluginModule = await import(loadPath);
```

TypeScript strict modunda `require()` `@typescript-eslint/no-require-imports` uyarısı üretirdi.

### [5] HTTP route proxy — gerçek Express handler

Önceden `registerRoute()` sadece metadata gönderip `503` döndürüyordu.

Yeni davranış:
- Worker route'u kaydedince Express'e gerçek handler eklenir
- HTTP isteği gelince `MessageChannel` üzerinden worker'a `http:request` gönderilir
- Worker handler'ı çalıştırıp `http:response` ile yanıt verir
- 5 saniye içinde yanıt gelmezse `504 Gateway Timeout` döner

```
GET /api/plugins/word-filter/blocked
  → Express proxy → worker (reqId: abc123)
  ← worker: { status: 200, body: { blockedWords: [...] } }
  ← Express: 200 { blockedWords: [...] }
```

---

## Test Özeti

| Dosya | Yeni Test | Kapsam |
|-------|-----------|--------|
| `client/tests/logger.test.ts` | 16 | createLogger prefix, production sessiz, BRIDGE_DEBUG, Sentry entegrasyonu, **debug→console.debug** |
| `server/tests/plugins-sandbox.test.ts` | 28 | resourceLimits sabitleri, boot timeout, allowlist logger, HTTP proxy mock, timeout temizliği, **redirect/next/double-send/set** |
| **Sprint 77 toplam** | **44** | |

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `client/js/core/logger.ts` | **Yeni** | Merkezi client logger; `debug()` → `console.debug` |
| `client/eslint.config.js` | **Yeni** | `no-console: error` kuralı |
| `client/tests/logger.test.ts` | **Yeni** | 16 test |
| `plugins/lifecycle.ts` | Değiştirildi | resourceLimits + boot timeout + import() + HTTP proxy; mock req/res genişletildi; **`PluginContext.registerRoute` handler tipi `next?` parametresini içeriyor** |
| `plugins/allowlist.ts` | Değiştirildi | console.warn → logger parametre |
| `plugins/loader.ts` | Değiştirildi | isAllowed(meta, logger) çağrısı |
| `server/eslint.config.js` | Değiştirildi | **`no-console: error`** — scripts/ ve lib/env.ts kasıtlı exempt |
| `server/tests/plugins-sandbox.test.ts` | **Yeni** | 28 test |
| `client/js/webrtc-sfu.ts` + 30 diğer | Değiştirildi | 81 console → log.* |

---

## Sprint 77 Sonrası Açık Maddeler

Aşağıdaki maddeler sprint 78+ backlog'una taşındı (bu sprint kapsamı dışında):

| Madde | Öncelik | Not |
|-------|---------|-----|
| `server/lib/` TypeScript migrasyonu (pure functions) | Yüksek | `server/lib/README.md`'de başlangıç noktaları belgelenmiş |
| Canary/blue-green deployment stratejisi | Orta | `deploy-canary.sh` mevcut; otomasyonu eksik |
| Client test coverage artırma (48 → 60+ dosya) | Orta | Vitest ile yeni dosyalar için kolay |
| Mediasoup k6 yük testi | Düşük | `k6/websocket-cluster-test.js` hazır, mediasoup senaryosu yok |
| Plugin HTTP proxy: full Express middleware zinciri | Düşük | Sandbox içinde next() eklendi; tam middleware stack eklenmeyecek (by design) |
