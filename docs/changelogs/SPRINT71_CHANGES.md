# Sprint 71 — window.* Temizliği + Bug Fix'ler

## ✅ window.* → BridgeRegistry / ESM Geçişi

Önceki sprint incelemelerinde raporlanan tüm `window.*` bridge-specific kullanımları
BridgeRegistry veya doğrudan ESM import'larıyla değiştirildi.

### Değiştirilen Dosyalar

| Dosya | Değişiklik |
|-------|------------|
| `client/js/core/voice-messages.ts` | `window.toast` → `toast()`, `window.API` → `getAPI()` |
| `client/js/core/ui.ts` | `window.toast` → `toast()`, `window.API` → `getAPI()` |
| `client/js/core/offlineCache.ts` | `window.toast` → `toast()` (import eklendi) |
| `client/js/core/outgoing-webhooks.ts` | Yerel toast wrapper silindi, `toast` import edildi |
| `client/js/core/forum.ts` | `window.toast`, `window.API`, `window.openForumThread`, `window.timeAgo`, `window._destroyTempModal` → BridgeRegistry |
| `client/js/core/onboarding.ts` | `window.toast`, `window.API`, `window.__obNext/Prev/Complete` → BridgeRegistry.register |
| `client/js/core/profile-ui.ts` | `window.me` → `getMe()`, `window.toast` → `toast()`, `window.API` → `getAPI()` |
| `client/js/core/image-viewer.ts` | `window.API` → `getAPI()` |
| `client/js/core/messages/input.ts` | `window.executeSlashCommand`, `window.handleSlashKey`, `window.handleMentionKey`, `window.handleSlashInput`, `window.handleMentionAutocomplete`, `window.saveDraft`, `window.replyingTo`, `window.cancelReply`, `window.editingMessageId`, `window.showConfirmModal`, `window.clientConfig` → BridgeRegistry |
| `client/js/core/members.ts` | `window.DmCall.startCall` → `BridgeRegistry.call('DmCall:startCall')` |
| `client/js/core/servers.ts` | `window.adminInjectButton`, `window.selectChannel` (wrap), `window.saveDraft`, `window.BridgeE2E`, `window.handleUserActivity`, `window.me`, `window.BridgeTour`, `window.sentryClient`, `window.loadCaptchaConfig`, `window.openAddServerModal`, `window.checkAndShowOnboarding` → BridgeRegistry |
| `client/js/core/emoji.ts` | `window.toast`, `window.API`, `window.sendServerGif`, `window.loadBridgeInfo`, `window.loadChannelFiles` → BridgeRegistry |
| `client/js/core/slow-mode.ts` | `window.toast`, `window.API` → doğrudan import |
| `client/js/core/audit-log.ts` | `window.toast`, `window.API` → doğrudan import |
| `client/js/core/music-player.ts` | `window.__musicAddToQueue/Skip/Stop` → BridgeRegistry.register |
| `client/js/core/go-live.ts` | `window.__changeScreenQuality` → BridgeRegistry.register |
| `client/js/core/dm-call.ts` | `BridgeRegistry.register('DmCall:startCall', ...)` ek registration eklendi |

### Kalan Meşru window.* Kullanımları (değiştirilmedi)

Aşağıdakiler standart tarayıcı/native SDK API'leridir, değiştirilmesi gerekmez:
- `window.open(...)` — tarayıcı sekme açma
- `window.Capacitor` — native mobil runtime
- `window.AudioContext / window.webkitAudioContext` — Web Audio API vendor prefix
- `window.visualViewport`, `window.innerWidth/Height` — viewport API
- `window.BRIDGE_API / window.BRIDGE_ENV / window.BRIDGE_APP_VERSION` — sunucu enjeksiyonu
- `window.__SENTRY_INITIALIZED__` — Sentry singleton guard
- `window.location`, `window.addEventListener` — standart DOM

---

## 🐛 Bug Fix

### `dm-call.ts` — `sendImage` boyut limiti (5GB → 5MB)
- **Sorun:** `sendImage()` içindeki max boyut kontrolü `5120 * 1024 * 1024` (5GB) olarak yazılmıştı. Kullanıcı 5GB'a kadar görsel yükleyebiliyordu; bu hem sunucu limitini aşıyor hem de chunked upload pipeline'ını gereksiz zorluyordu.
- **Düzeltme:** `5 * 1024 * 1024` (5MB) olarak düzeltildi. Hata mesajı da güncellendi.

---

## ⚙️ CI/CD

### E2E testleri artık PR'larda da çalışıyor (`.github/workflows/ci.yml`)
- **Sorun:** `e2e` job'ı yalnızca `main` ve `develop` branch'lerinde çalışıyordu. PR'lar E2E olmadan merge edilebiliyordu.
- **Düzeltme:** `github.event_name == 'pull_request'` koşulu eklendi.

```yaml
# Önce:
if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop'
# Sonra:
if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop' || github.event_name == 'pull_request'
```

---

## Özet

| Kategori | Sayı |
|----------|------|
| Düzeltilen window.* kullanımı | 85 |
| Etkilenen dosya | 17 |
| Bug fix | 1 (5GB→5MB) |
| CI iyileştirmesi | 1 (E2E PR'larda) |
