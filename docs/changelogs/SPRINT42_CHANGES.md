# Sprint 42 — window.* Tamamlama + Client Test Coverage + API v1 Geçişi (2026-05-14)

## ✅ A — Frontend window.* Son Temizlik

### Değişen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `client/js/discover.ts` | `import { currentServer } from './core/globals.js'` eklendi; `window.currentServer` guard → ESM import |

### Kalan Kaçınılmaz window.* Kullanımları
- `window.open(...)` — tarayıcı sekmesi açma (DOM API, değiştirilemez)
- `window.Capacitor` — native mobil runtime SDK
- `window.AudioContext / window.webkitAudioContext` — Web Audio API vendor prefix
- `window.visualViewport` — mobile viewport API
- `window.BRIDGE_API / window.BRIDGE_ENV / window.BRIDGE_APP_VERSION` — sunucu tarafı enjeksiyon (HTML'de `<script>window.BRIDGE_API=...`)
- `window.__SENTRY_INITIALIZED__` — Sentry singleton guard (üçüncü taraf SDK gereği)

**Sonuç:** Tüm uygulama `window.*` köprüleri temizlendi. Kalan 15 kullanım tamamen kaçınılmaz browser/native SDK kullanımlarıdır.

---

## ✅ B — Client Test Coverage: 15 → 18 Dosya

### Yeni Test Dosyaları

| Test Dosyası | Kapsam | Test Sayısı |
|---|---|---|
| `client/tests/discover.test.js` | renderDiscoverCard XSS, tab state, settings modal DOM, window.currentServer fix, apiFetch | 20 test |
| `client/tests/semantic-search.test.js` | panel aç/kapat, input, result render XSS, status, debounce, API, klavye nav | 22 test |
| `client/tests/server-settings.test.js` | modal DOM, slug preview, emoji cache, role yönetimi, audit log, form validasyon, API | 24 test |

### Toplam
- Client test dosyası: 15 → **18** (C2/C3 sprint hedefine yaklaşıldı)
- Yeni test sayısı: +66

### Coverage threshold güncellemesi (`client/tests/package.json`)
Yeni dosyalar için threshold eklenecek sonraki sprintte (coverage baseline alındıktan sonra).

---

## ✅ C — Bot SDK API v1 Geçişi (URL Versiyonlama Tamamlama)

### Değişen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `bot-sdk/src/index.ts` | Tüm 14 `_api()` çağrısı `/api/` → `/api/v1/` güncellendi |

### Güncellenen Endpoint'ler

```
/api/bots/me/context-commands  → /api/v1/bots/me/context-commands
/api/bots/me                   → /api/v1/bots/me
/api/messages/:channelId       → /api/v1/messages/:channelId  (4 endpoint)
/api/servers/:serverId/...     → /api/v1/servers/:serverId/... (7 endpoint)
```

### Önem
Bot SDK artık canonical `/api/v1` endpoint'lerini kullanıyor. `Deprecation: true` header artık bot isteklerinde görünmeyecek → `console.warn` ve `deprecationWarning` event emit edilmeyecek.

Eski botlar (`/api` kullananlar) hâlâ çalışır — `setupRoutes.ts`'deki `mountApi()` her iki path'e de mount ediyor. Ancak yeni geliştirme `/api/v1` üzerinden yapılmalı.

---

## Sayısal Özet

| Metrik | Değer |
|---|---|
| Kaldırılan `window.*` referansı | 1 (discover.ts) |
| Toplam kalan kaçınılmaz window.* | ~15 (hepsi browser/native SDK) |
| Yeni client test dosyası | 3 |
| Yeni test vakası | ~66 |
| Bot SDK endpoint güncellemesi | 14 |
| Kalan `window.*` uygulama referansı | **0** ✅ |

---

## Sprint 43 için Hazırlık

| Görev | Öncelik |
|---|---|
| Client test threshold güncelleme (discover/semantic/server-settings) | 🔴 Yüksek |
| C2/C3: i18n, search, discord-import testleri | 🟠 Orta |
| E: PostgreSQL replica + CDN | 🟠 Orta |
| F: Preact geçiş PoC | 🟢 Düşük |
