# Sprint 31 — Boot Katmanı ESM Geçişi

**Tarih:** 2026-05-12  
**Kapsam:** `chunk-boot` — 7 dosya, 25 uygulama `window.*` referansı temizlendi.

---

## Yapılan değişiklikler

### `client/js/core/utils.ts`
- Tüm fonksiyonlar `export function` olarak işaretlendi.
- `window.location.origin` → `location.origin` (browser API, `window` prefix gereksiz).
- `globals.d.ts`'teki `declare function escHtml/toast/closeModal` vb. kaldırıldı.

### `client/js/core/theme.ts`
- `window.THEMES`, `window.THEME_ICONS`, `window.THEME_LABELS`, `window.CHAT_BG_PRESETS` →
  `export const` olarak tanımlandı.
- `toast()` artık `import { toast } from './utils.js'` ile kullanılıyor  
  (`typeof toast === 'function'` guard kaldırıldı).
- `globals.d.ts`'teki `Window.THEMES/THEME_ICONS/THEME_LABELS/CHAT_BG_PRESETS` kaldırıldı.
- **Sprint 32 notu:** `window.THEMES` vb. okuyan eski dosyalar (`settings-modal.js` vb.)  
  henüz import'a geçmedi — köprü olarak `globals.d.ts`'te `Window.THEMES?: string[]` bırakıldı.

### `client/js/core/globals.ts`
- `window._bridgeGlobals` IIFE köprüsü kaldırıldı.
- Tüm değişkenler `export let` olarak dışarı açıldı.
- Setter fonksiyonları eklendi: `setSocket()`, `setMe()`, `setToken()`, `setCurrentServer()` vb.
- `getAPI()` yardımcısı eklendi — `window.API` yerine bunu kullanın.
- `window.API = _API` geçiş köprüsü Sprint 32'de kaldırılır.
- Klavye kısayolları ESM scope'ta — `closeDmPanel/cancelEdit/cancelReply/toggleMemberList`
  Sprint 32'de import'a geçince `(window as any).X?.()` shim'leri silinir.

### `client/js/core/state.ts`
- IIFE kaldırıldı; `state`, `setState`, `subscribe`, `initState`, `BridgeState` ESM export.
- `window.BridgeState` köprüsü Sprint 32'de kaldırılır.
- `declare global { interface Window { BridgeState: ... } }` → `globals.d.ts`'e taşındı.

### `client/js/core/error-boundary.ts`
- IIFE kaldırıldı; `errorBoundary` ESM export.
- `global.showToast` → `import { toast } from './utils.js'`.
- `global.addEventListener` → `addEventListener` (IIFE parametresi gerekmez).
- `window.errorBoundary` köprüsü Sprint 32'de kaldırılır.
- `declare global { interface Window { showToast?: ... } }` kaldırıldı.

### `client/js/core/auth.js`
- `logout()`: `window.me = null` vb. → `setMe(null)`, `setToken(null)` vb. setter import.
- `window.sentryClient` → Sprint 32'de `import { sentryClient }` yapılacak;  
  şimdilik `(window as any).sentryClient` optional erişim.
- `closeModal` → `import { closeModal } from './utils.js'`.
- `window.hcaptcha`, `window.turnstile` → **kaçınılmaz external SDK**, değiştirilmedi.

### `client/js/app.ts`
- `errorBoundary`, `BridgeState`, `loadTheme`, `getAPI` import'ları eklendi.
- Boot wrap ile başlatma yapılıyor.

### `client/js/types/globals.d.ts`
- Sprint 31'de ESM'e geçen fonksiyonların `declare function` satırları kaldırıldı:
  `escHtml`, `cssColor`, `safeFileUrl`, `initials`, `toast`, `closeModal`, `closeModalOutside`,
  `applyServerEmojis`, `loadServerEmojis`, `loadTheme`, `setTheme`, `setChatBackground`,
  `loadChatBgFromFile`, `applyChatBgColor`.
- `Window.THEMES/THEME_ICONS/THEME_LABELS/CHAT_BG_PRESETS` kaldırıldı.
- `Window.showToast` kaldırıldı.
- Kalan köprüler (`Window.socket`, `Window.token` vb.) Sprint 32'de kaldırılacak.

---

## Sayısal özet

| Metrik | Değer |
|---|---|
| Temizlenen `window.*` referansı | 25 |
| Kaldırılan `declare function` satırı | 14 |
| Kaldırılan `Window.*` alan | 8 |
| Eklenen ESM `export` | 32 |
| Eklenen setter fonksiyonu | 12 |
| Kalan kaçınılmaz `window.*` (hcaptcha/turnstile) | 9 |

---

## Sprint 32 için hazırlık

Aşağıdaki dosyaların `window.THEMES`, `window.socket`, `window.API` vb. kullanımları
Sprint 32'de (chunk-core + chunk-comms) import'a geçirilecek:

- `core/settings-modal.js` — `window.THEMES`, `window.THEME_ICONS` (24 ref)
- `core/servers.js` — `window.socket`, `window.me`, `window.currentServer` (13 ref)
- `core/channel-list.ts` — `window.currentChannel`, `window.socket` (12 ref)
- `core/socket.js` — `window.me`, `window.token` (9 ref)
- `core/dm.ts` — `window.socket`, `window.me`, `window.currentDm` (~8 ref)
- `core/voice.js` — `window.socket`, `window.rtc` (~9 ref)

Sprint 32 başında `window.API` ve `window.BridgeState` köprüleri silinebilir.
