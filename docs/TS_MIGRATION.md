# Client TypeScript Migration Tracker

Sprint 51 güncel durumu.

## Genel Bakış

| Tip  | Sayı | Notlar |
|------|------|--------|
| `.ts` | 132 | Tam TypeScript — tüm `core/` ve `js/` modülleri |
| `.js` | 0   | **Kaynak JS dosyası kalmadı** ✅ |

**Hedef:** Tüm `core/` modülleri → `.ts`, `strict: true` altında temiz.  
**Durum:** JS→TS dönüşümü **tamamlandı**. Kalan iş: strict gate kapsamını genişletmek.

---

## Strict Gate (tsconfig.strict-gate.json)

CI'da `typecheck:strict-client` adımı bu dosyadaki modülleri kontrol eder.  
Bir modül `any`'den temizlenince buraya eklenir.

**Mevcut kapsam: 139 / 139 dosya (%100) ✅**

Tüm kaynak `.ts` dosyaları strict gate kapsamında. Kademeli geçiş tamamlandı.

> **Sprint 51:** `client/tsconfig.json` base config'de `strict: true` aktif edildi. IDE ve CI artık senkron.

### ✅ Sprint 40–44 (İlk Katman)
- `js/core/globals.ts` — `User` interface eklendi, `getMe(): User | null`
- `js/core/activity.ts` — tüm `as any` castler kaldırıldı
- `js/webrtc-base.ts`
- `js/core/bridge-registry.ts`
- `js/core/a11y-aria.ts`
- `js/core/video-quality.ts`
- `js/core/discord-import-parser.ts`
- `js/core/a11y-focus-trap.ts`
- `js/core/a11y-keyboard.ts`
- `js/core/badges.ts`
- `js/core/misc.ts`
- `js/core/dm-read.ts`
- `js/core/skeleton-loading.ts`
- `js/core/api.ts`
- `js/core/messages.ts`
- `js/core/channel-permissions.ts`
- `js/core/auth-revoked.ts`

### ✅ Sprint 44 (Katman 2 — Büyük Modüller)
- `js/core/auth.ts` — 296 satır, 4 interface
- `js/core/socket.ts` — 392 satır, 4 interface
- `js/core/friends.ts` — 290 satır, 2 interface
- `js/core/moderation.ts` — 227 satır
- `js/core/translate-btn.ts` — 158 satır
- `js/core/group-dm.ts` — 1000 satır
- `js/slash.ts` — 803 satır
- `js/webrtc-sfu.ts` — 761 satır
- `js/admin.ts` — 756 satır
- `js/core/settings-modal.ts` — 728 satır
- `js/core/voice-recorder.ts` — 718 satır
- `js/core/server-settings.ts` — 687 satır
- `js/core/e2e.ts` — 660 satır
- `js/webrtc.ts` — 623 satır

### ✅ Sprint 50 (Katman 3)
- `js/core/stage.ts`
- `js/core/mobile-ux.ts`
- `js/core/voice.ts`
- `js/core/web-push.ts`
- `js/core/messages/loader.ts`
- `js/core/i18n.ts`
- `js/core/ip-ban.ts`
- `js/core/virtual-scroll.ts`
- `js/core/group-dm-core.ts`
- `js/core/bot-marketplace.ts`

### ✅ Sprint 51 (Katman 4 — `any` Tam Temizliği: 275 → 0)
- `js/core/servers.ts` — 33 any temizlendi
- `js/core/messages/input.ts` — 32 any
- `js/core/forum.ts` — 29 any, `apiFetch` import edildi
- `js/core/music-player.ts` — 26 any
- `js/core/emoji.ts` — 22 any
- `js/core/profile-ui.ts` — 18 any
- `js/core/onboarding.ts` — 18 any
- `js/core/socket-events.ts` — 14 any
- `js/core/ui.ts` — 12 any
- `js/core/voice-messages.ts` — 10 any
- `js/core/voice-activity-ui.ts` — 7 any
- `js/core/go-live.ts` — 6 any
- `js/core/slow-mode.ts` — 5 any
- `js/core/translate-btn.ts` — 4 any
- `js/core/scheduled-ui.ts` — 4 any
- `js/core/outgoing-webhooks.ts` — 4 any
- `js/core/offline-queue.ts` — 4 any
- `js/core/image-viewer.ts` — 4 any
- `js/core/audit-log.ts` — 4 any
- `js/polls.ts` — 2 any
- `js/core/voice-volume.ts` — 2 any
- `js/core/offlineCache.ts` — 2 any
- `js/core/messages/renderer.ts` — 2 any + `@ts-ignore` kaldırıldı
- `js/profile.ts` — 1 any
- `js/federation-modal.ts` — 1 any
- `js/discover.ts` — 1 any
- `js/core/onboarding-tour.ts` — 1 any
- `js/core/members.ts` — 1 any
- `js/core/drafts.ts` — 1 any
- `js/core/clyde.ts` — 1 any
- `js/core/canvas.ts` — 1 any

### 🔄 Sıradaki Adaylar

Strict gate %100 kapsama ulaştı — tüm modüller dahil. Sıradaki hedef: `client/tsconfig.json` base config'de `strict: true` aktif etmek (mevcut `strict: false` tüm modüller gate'e alındığına göre artık gereksiz).

---

## Bundle Budget

Mevcut limit: **1.2 MB** JS (Sprint 50'de 1.1 MB → 1.2 MB güncellendi).  
CSS limiti: **250 KB**. Tek chunk max: **150 KB**.

Budget scripti `build:ci` zincirinde **aktif** — CI'daki `Build` job'u bunu çalıştırır.

---

## Teknik Notlar

- `strict: false` → `strict: true` geçişi tek adımda yapılmaz; `tsconfig.strict-gate.json` kademeli geçişin kontrol noktasıdır.
- `allowJs: true` + `checkJs: true` artık geçersiz — tüm kaynak `.ts`.
- `(window as any).X` → `window.X` stratejisi: `globals.d.ts` `Window` arayüzünü kapsamlı tanımladığı için cast gereksizdi.
- `catch (e: any)` → `catch (e: unknown)` + `instanceof Error` guard — Sprint 51'de standart hale getirildi.
- Registry cast pattern: `as any` → `as unknown` (BridgeRegistry tip agnostik tasarım gereği).

---

## Sprint D — API Versioning (Tamamlandı)

1. **`setupRoutes.ts`** — `/api` rotalarına `Deprecation: true` + `Link` header eklendi.
2. **`lib/swagger.ts`** — `/api` server açıklaması deprecated olarak işaretlendi.
3. **`bot-sdk/src/index.ts`** — `Deprecation` header tespiti + `console.warn` + event emit.

### Başarı Kriterleri ✅
- [x] `/api/...` istekleri `Deprecation: true` header taşıyor
- [x] Swagger UI'da `/api/v1` canonical olarak gösteriliyor
- [x] Bot SDK `Deprecation` header görünce `console.warn` basıyor
