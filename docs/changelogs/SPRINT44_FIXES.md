# Sprint 44 — Kod Kalitesi Düzeltmeleri (2026-05-16)

## Düzeltilen Sorunlar

### 1. `escHtml` Duplikasyonu → `utils.ts` İmport (19 dosya)

**Sorun:** `utils.ts`'de export edilmiş `escHtml` varken 19 farklı dosyada yerel kopyası tanımlıydı.
Bir dosyada hata düzeltilse diğerlerine yayılmazdı.

**Düzeltme:** Yerel `function escHtml(...)` tanımları kaldırıldı, `import { escHtml } from './utils.js'` eklendi.

Etkilenen dosyalar:
| Dosya | Değişiklik |
|---|---|
| `client/js/core/badges.ts` + `.js` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/channel-perms-sync.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/emoji.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/forum.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/go-live.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/image-viewer.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/music-player.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/onboarding.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/outgoing-webhooks.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/profile-ui.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/scheduled-ui.ts` + `.js` | IIFE içi kaldırıldı, utils import eklendi |
| `client/js/core/semantic-search.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/translate-btn.ts` + `.js` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/voice-volume.ts` | `_esc` alias kaldırıldı, utils import eklendi |
| `client/js/core/channel-perms/modal-actions.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/channel-perms/modal-audit-sync.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/channel-perms/modal-audit.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/channel-perms/modal-core.ts` | Yerel kaldırıldı, utils import eklendi |
| `client/js/core/channel-perms/modal-state.ts` | Yerel kaldırıldı, utils import eklendi |

---

### 2. `voice-volume.ts` — `window.__bvvSet` Global Sızıntısı

**Sorun:** `openVolumePanel()` fonksiyonu HTML `onclick="(window).__bvvSet(val)"` attribute'u
kullanıyordu ve `(window as any).__bvvSet` global atıyordu. window.* temizliği yapılan bir
sprintte yeni global eklenmişti. Birden fazla panel açılırsa closure çakışması da oluşurdu.

**Düzeltme:**
- `window.__bvvSet` kaldırıldı
- Preset butonlar `data-vol="N"` attribute taşıyor, event delegation ile panel içi listener'dan yakalanıyor
- Close butonu `data-action="close"` ile işaretlendi, `onclick` string'i yok
- Context menu'deki `onclick` string'i de `addEventListener('click', ...)` ile değiştirildi
- `_esc` alias kaldırıldı, `escHtml` from utils kullanılıyor

---

### 3. `server/middleware/ipBan.ts` — Redis Race Condition

**Sorun:** `banIp()` fonksiyonu `redis.set()` promise'ini `const cmd` değişkenine atıyor,
ardından `redis.expire()` çağırıyordu `await` olmadan. `expire` tamamlanmadan key henüz
Redis'te olmayabilir, TTL set edilemeyebilir.

```typescript
// ÖNCE (race condition)
const cmd = redis.set(`${REDIS_KEY_PREFIX}${ip}`, JSON.stringify(entry));
if (ttlSeconds > 0) await redis.expire(`${REDIS_KEY_PREFIX}${ip}`, ttlSeconds);
await cmd;

// SONRA (doğru sıra)
await redis.set(`${REDIS_KEY_PREFIX}${ip}`, JSON.stringify(entry));
if (ttlSeconds > 0) await redis.expire(`${REDIS_KEY_PREFIX}${ip}`, ttlSeconds);
```

**Not:** İdeal olan `SET key value EX ttl` atomik komutu. Mevcut `ioredis` interface'i
`set(key, value)` imzasına sahip olduğundan atomik form için interface güncellemesi gerekir.
Sıra düzeltmesi race condition'ı pratikte ortadan kaldırır; atomik geçiş teknik borç listesine eklendi.

---

## Sayısal Özet

| Metrik | Değer |
|---|---|
| Kaldırılan yerel `escHtml` tanımı | 19 |
| Kaldırılan `window.*` global (`__bvvSet`) | 1 |
| Düzeltilen Redis race condition | 1 |
| Değişen dosya sayısı | 22 |

---

## 2. Tur Düzeltmeleri (Değerlendirme Sonrası)

### 4. Federation `fetch()` → `fetchT` Migrasyonu (4 dosya)

**Sorun:** `server/lib/fetch.ts`'de timeout + User-Agent ekleyen `fetchT` wrapper varken
4 federation dosyası doğrudan global `fetch()` çağırıyordu. Timeout'lar inline
`AbortSignal.timeout()` ile tutarsız biçimde eklenmiş ya da hiç yoktu.

**Düzeltme:** `server/routes/federation/delivery.ts`, `helpers.ts`, `peers.ts`, `social.ts`
dosyalarındaki tüm `fetch()` çağrıları `fetchT()` ile değiştirildi. `signal: AbortSignal.timeout(N)` → `timeoutMs: N`.

| Dosya | Değiştirilen çağrı |
|---|---|
| `delivery.ts` | `resolveInbox` GET + `_doDeliver` POST |
| `helpers.ts` | inbox resolve GET + POST delivery |
| `peers.ts` | 4 farklı endpoint çağrısı |
| `social.ts` | actor URL resolve GET |

---

### 5. `outgoing-webhooks.ts` — `window.event` + `window.*` Globals

**Sorun:** `testOutgoingWebhook()` deprecated `window.event` API kullanıyordu (Firefox'ta `undefined`).
Ayrıca 4 fonksiyon `(window as any).__createOutgoingWebhook` vb. olarak global atılıyordu.

**Düzeltme:**
- `testOutgoingWebhook(id, triggerEl?)` — opsiyonel `triggerEl` parametresi eklendi
- HTML butonlar `data-action="wh-test|wh-toggle|wh-delete|wh-create"` + `data-id` + `data-enabled` attribute'larına geçildi
- Modal'a tek event delegation listener eklendi — tüm `window.__*` global atamaları kaldırıldı

---

### 6. `console.log` → Structured Logger (4 dosya, 9 satır)

**Sorun:** `captcha.ts`, `cdnStorage.ts`, `redisAdapter.ts`, `e2e.ts` — production server kodunda
`console.log` kullanıyordu. `server/lib/logger.ts`'de `pino` tabanlı structured logger varken
kullanılmıyordu.

**Düzeltme:** 9 `console.log` çağrısı `logger.info/warn/debug` ile değiştirildi.
`captcha.ts`, `cdnStorage.ts`, `redisAdapter.ts`'e `import logger from './logger'` eklendi.

---

### 7. Coverage Threshold Genişletme (11 yeni dosya)

**Sorun:** Sprint44 Katman2'de yazılan 11 dosya için coverage threshold yoktu.

**Düzeltme:** `client/tests/package.json`'a 11 yeni threshold eklendi:
`servers.ts`, `audit-log.ts`, `onboarding.ts`, `forum.ts`, `go-live.ts`,
`messages/input.ts`, `music-player.ts`, `scheduled-ui.ts`, `outgoing-webhooks.ts`,
`offline-queue.ts`, `voice-volume.ts`. Toplam: 13 → **24** threshold entry.

---

## 2. Tur Sayısal Özet

| Metrik | Değer |
|---|---|
| Federation `fetch()` → `fetchT` | 9 çağrı, 4 dosya |
| Kaldırılan `window.event` | 1 |
| Kaldırılan `window.__*` global | 4 |
| `console.log` → `logger` | 9 satır, 4 dosya |
| Yeni coverage threshold | 11 |
| **Toplam değişen dosya** | **10** |
