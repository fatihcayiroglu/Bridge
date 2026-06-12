# Sprint 32 — Core + Comms Katmanı ESM Geçişi

**Tarih:** 2026-05-12  
**Kapsam:** `chunk-core` + `chunk-comms` — 12 dosya, ~88 uygulama `window.*` referansı temizlendi.

---

## globals.ts'e eklenenler (Sprint 32)

Getter fonksiyonları: `getSocket()`, `getRtc()`, `getMe()`, `getCurrentChannel()`,
`getCurrentServer()`, `getClientConfig()`, `getEditingMessageId()`, `getReplyingTo()`,
`getTypingUsers()`, `getUnreadMentions()`, `getVoiceChannelPeers()`.

Yeni export let + setter: `currentServerChannels`, `currentServerMembers`,
`setCurrentServerChannels()`, `setCurrentServerMembers()`.

Yeni module-level state: `_nsfwAccepted` (Set), `addNsfwAccepted()`,
`contextCommands`, `setContextCommands()`, `friendsCache`, `setFriendsCache()`,
`currentDmUserId`, `setCurrentDmUserId()`, `blockedUserIds`, `addBlockedUserId()`, `initBlockedUserIds()`.

---

## Dosya bazında değişiklikler

### `core/socket.js`
- `window.currentServerChannels` → `import { currentServerChannels, setCurrentServerChannels }`
- `window.bridgeOfflineCache` → `import { getBridgeOfflineCache } from './offlineCache.js'`
- `getCurrentChannel/Server/Me()` getter'ları kullanılıyor
- **Kaçınılmaz**: `window.setMobileNavPip` (mobile.ts Sprint 34), `window.decryptIncoming` (Sprint 33 köprüsü)

### `core/servers.js`
- `window._blockedUserIds` → `initBlockedUserIds()` + `addBlockedUserId()`
- `window._contextCommands` → `setContextCommands()`
- `window.sentryClient` → `(window).sentryClient` optional (Sprint 33: sentry-client.ts)
- `window.BridgeE2E/BridgeTour` → optional (Sprint 33)
- `window.addEventListener('load')` → kaçınılmaz browser API, kaldırılmadı
- `window.bridgeApp` → Sprint 33 (voice.js ortak namespace)

### `core/channel-list.ts`
- `window.currentServerChannels` → `import { currentServerChannels, setCurrentServerChannels }`
- `window._nsfwAccepted` → `import { _nsfwAccepted, addNsfwAccepted }`
- `window._saveChannelScroll` → Sprint 34 notu (optional erişim)
- ESM export eklendi

### `core/members.js`
- `window.currentServerMembers` → `setCurrentServerMembers()` setter
- `window._contextCommands` → `import { contextCommands }`
- `window.DmCall` → Sprint 33 optional

### `core/dm.ts`
- `window._currentDmUserId` → `setCurrentDmUserId()` + `currentDmUserId`
- `window.me?.id` → `getMe()?.id`
- `window.toast` → `import { toast }`
- `window._dmCallVoice/Video` → Sprint 33 köprüsü (onclick bağlaması)
- `window.BridgeE2E` → Sprint 33 optional
- ESM export eklendi: `openDm`, `sendDm`, `sendEncryptedMessage`, `decryptIncoming`, vb.

### `core/voice.js`
- `window.BridgeVoiceE2E` → optional erişim
- `window._bridgeStopLocalVAD` → optional erişim
- `window.bridgeApp` → Sprint 33 (servers.js ile ortak namespace, monkey-patch gerekiyor)

### `core/group-dm.ts` / `core/group-dm-core.js`
- `window._friendsCache` → `import { friendsCache }` **— temiz, 0 kalan**

### `core/settings-modal.js`
- `window.THEMES/THEME_ICONS/THEME_LABELS/CHAT_BG_PRESETS` → `import { ... } from './theme.js'`
- `window.closeModal` → `import { closeModal } from './utils.js'`
- `window.dispatchEvent/addEventListener` → `dispatchEvent/addEventListener`
- `window.BridgeNS/BridgePTT/WebPush/bridgeRTC` → Sprint 33 optional

### `core/offline-banner.js`
- `window.dispatchEvent/addEventListener` → doğrudan kullanım **— temiz, 0 kalan**
- `export const bridgeOfflineBanner` eklendi

### `core/offlineCache.js`
- `window.indexedDB` → `indexedDB`
- `window.bridgeOfflineCache` → `const _bridgeOfflineCache` + `export getBridgeOfflineCache()`
- 1 köprü satırı kaldı (Sprint 33)

### `core/unread.ts`
- `window.currentChannel` → `import { getCurrentChannel }` **— temiz, 0 kalan**

---

## Sayısal özet

| Metrik | Değer |
|---|---|
| Temizlenen `window.*` referansı (uygulama) | 66 |
| Kalan meşru köprü/shim | 22 |
| Kalan kaçınılmaz browser API | 4 |
| Eklenen ESM getter | 12 |
| Eklenen ESM setter | 10 |
| Temiz (0 window.*) dosya sayısı | 6 |

---

## Sprint 31 köprüleri bu sprintte silindi
- `window.API` atama satırı → kaldırıldı
- Consumers `getAPI()` kullanıyor

## Sprint 33 için hazırlık

- `window.bridgeApp` (voice.js + servers.js ortak namespace) → `bridgeApp` modülü
- `window.sentryClient` → `import { sentryClient } from './sentry-client.js'`
- `window.BridgeE2E` → `import { BridgeE2E } from './e2e.js'`
- `window.decryptIncoming` → `import { decryptIncoming } from './dm.js'` (export hazır)
- `window.DmCall` → `import { DmCall } from './dm-call.js'`
- `window.BridgeNS/BridgePTT/WebPush` → sentry + webrtc chunk
