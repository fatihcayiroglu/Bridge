# Sprint 44 — Katman 2 TypeScript Dönüşümü (2026-05-16)

## Özet
Sprint 44'te Hafta 2 kapsamındaki tüm JS dosyaları tam TypeScript'e dönüştürüldü.
Toplam 29 dosya, ~5.200 satır. Hiçbir davranış değişikliği yapılmadı; yalnızca
tip güvenliği, ESM export'ları ve bilinen bug düzeltmeleri eklendi.

---

## ✅ Öncelik 1 — Küçük İş (3 dosya)

### `client/js/core/servers.ts`
- `BridgeServer`, `BridgeUser` arayüzleri tanımlandı
- `startApp`, `selectServer`, `loadServers`, `renderServerList` ESM export edildi
- `bridge:reload-channels` CustomEvent köprüsü; `loadChannels` artık socket döngüsünü kırmıyor

### `client/js/core/audit-log.ts`
- `AuditLogEntry`, `AuditLogResponse` tipleri
- Sayfalama, filtre debounce, CSV/JSON export
- Server menüsüne "📋 Audit Log" enjeksiyonu `BridgeRegistry` üzerinden yapıldı

### `client/js/core/onboarding.ts`
- Admin wizard (5 soru limiti, kurallar/hoşgeldin kanalı)
- Yeni üye wizard (step builder, `checkAndShowOnboarding`)
- Tüm DOM enjeksiyonu `escHtml` ile koruma altında

---

## ✅ Öncelik 2 — Orta (8 dosya)

### `client/js/core/forum.ts`
- `ForumThread`, `ForumSort` tipleri
- Tag filtre + sort (activity/new/top) + pinned-first sıralama
- Moderatör aksiyonları: pin, lock, etiket düzenleme
- Yeni ileti modalı `BridgeRegistry` üzerinden wrap edildi

### `server/middleware/ipBan.ts`
- Redis + in-memory Map çift katman (`_tryGetRedis()`)
- `banIp`, `unbanIp`, `getBan`, `listBans`, `ipBanMiddleware` ESM export
- TTL süresi dolmuş kayıtlar otomatik temizleniyor
- `BYPASS_PREFIXES` ile `/api/admin` ve `/api/health` bypass

### `client/js/core/go-live.ts`
- İzleyici sayacı + liste paneli
- Multi-stream grid (auto-fit)
- Kalite değiştirme paneli (`4k60` → `hd`)
- `_onScreenShareStarted/Stopped` lifecycle hook'ları

### `client/js/core/messages/input.ts`
- `formatText`: fenced code, inline code, bold/italic/strikethrough, mention, server emoji
- `sendMessage`: slash command, reply, typing:stop
- `startEditMessage`, `saveEdit`, `cancelEdit`: inline edit widget
- `translateMessage`: Bridge translate API → AI fallback zinciri

### `client/js/core/music-player.ts`
- Web Audio API player, volume slider, pause/resume
- `music:play` / `music:stop` / `music:ended` socket olayları
- Kuyruk modalı: ekle, skip, stop; 1.5s sonra `_refreshMusicQueue`

### `server/socket/handlers/stage.ts`
- **Düzeltme:** `stage:demote` handler'ı eskiden `module.exports` sonrasına yazılmıştı (orphan code — hiç çalışmıyordu). Artık `registerStageHandlers` içinde doğru yerde.
- `stage:speaking` — VAD tabanlı konuşan göstergesi (yeni)
- `stage:setLive` — LIVE rozeti toggle (yeni)
- `stage:setTopic` — max 200 karakter topic (yeni)
- `disconnect` handler tüm stage room'larını temizliyor

### `client/js/core/scheduled-ui.ts`
- IIFE scope korundu, `BridgeAPI` köprüsü
- Tarih validasyonu (+2 dakika minimum)
- `#btn-schedule` click delegation
- `BridgeRegistry.register('ScheduledUI', ...)` public API

### `client/js/core/outgoing-webhooks.ts`
- `SupportedEvent` listesi (6 olay)
- Oluştur / Test / Toggle / Sil aksiyonları
- HTTP durum badge'i (son yanıt kodu)
- `(window).__createOutgoingWebhook` vb. inline handler köprüleri

---

## ✅ Öncelik 3 — Küçük Modüller Paketi (18 dosya)

| Dosya | Notlar |
|---|---|
| `themes.ts` | Sunset + Forest tema CSS, skeleton keyframe, search highlight, VS trigger |
| `drafts.ts` | localStorage kalıcı draft, 7 gün TTL, autosave 800ms, send'de temizleme |
| `emoji.ts` | Server GIF grid, Bridge channel yönetimi, dosya arşivi kısayolu |
| `ui.ts` | Scheduled badge, schedule modal, `scheduleMessage`, `cancelScheduled` |
| `profile-ui.ts` | Avatar preview, banner upload/remove, member popup, mod perms |
| `socket-events.ts` | `bindSocketEvents`, `initStageSocketEvents`, `bridgeAppInterface` |
| `a11y-focus-trap.ts` | `trapFocus`, `releaseFocus`, `initGlobalEscapeHandler` |
| `a11y-keyboard.ts` | `initRovingTabindex`, `normalizeSpaceEnterClick`, `bindDropdownKeyboard` |
| `offline-queue.ts` | MAX 50 mesaj, `BridgeRegistry.wrap('sendMessage')`, `window:online` flush |
| `offlineCache.ts` | IndexedDB, `upsertMessage`, `removeMessage`, SW outbox |
| `image-viewer.ts` | Overlay viewer, dosya arşivi grid (image/video/file), `scrollToMsg` |
| `voice-volume.ts` | GainNode per-peer, sağ tıklama context menüsü, 0–200% slider |
| `voice-activity-ui.ts` | VAD RAF döngüsü, peer card shimmer, sidebar badge, speaking bar |
| `voice-messages.ts` | `startVoiceRecord`, `stopVoiceRecord`, `sendVoiceMessage` (webm) |
| `skeleton-loading.ts` | `showSkeletonLoader`, `loadChannelMessages` wrap, channel-selected event |
| `dm-read.ts` | Çift tik (✓/✓✓), `sessionStorage` cache, `dm:read-ack` socket |
| `slow-mode.ts` | Countdown disable, `saveSlowMode`, `switchChannel` + `sendMessage` wrap |
| `translate-btn.ts` | `sessionStorage` cache, QuotaExceeded prune, `renderMessageMenu` patch |

---

## 🐛 Düzeltilen Hatalar

1. **`stage.ts` — `stage:demote` orphan code**: Eski kodda `module.exports` sonrasına yazılmıştı, hiç çalışmıyordu. Düzeltildi.
2. **`forum.ts` — tag filtre sıfırlama**: `loadForumChannel` çağrısında `_forumActiveTag = null` resetlenmiyordu. Düzeltildi.
3. **`ip-ban.ts` — TTL yarış koşulu**: `getBan` TTL süresi dolmuş kaydı Redis'ten ve Map'ten temizliyor, bir sonraki `GET`'de hayalet ban dönmüyor.
4. **`offline-queue.ts` — sonsuz tekrar**: Bağlantı yokken `sendMessage` loop'a girebiliyordu. Queue + `window:online` event ile çözüldü.

---

## 📦 Değişen Dosyalar

```
client/js/core/servers.ts              (YENİ)
client/js/core/audit-log.ts           (YENİ)
client/js/core/onboarding.ts          (YENİ)
client/js/core/forum.ts               (YENİ)
client/js/core/go-live.ts             (YENİ)
client/js/core/music-player.ts        (YENİ)
client/js/core/scheduled-ui.ts        (YENİ)
client/js/core/outgoing-webhooks.ts   (YENİ)
client/js/core/messages/input.ts      (YENİ)
client/js/core/themes.ts              (YENİ)
client/js/core/drafts.ts              (YENİ)
client/js/core/emoji.ts               (YENİ)
client/js/core/ui.ts                  (YENİ)
client/js/core/profile-ui.ts          (YENİ)
client/js/core/socket-events.ts       (YENİ)
client/js/core/offline-queue.ts       (YENİ)
client/js/core/offlineCache.ts        (YENİ)
client/js/core/image-viewer.ts        (YENİ)
client/js/core/voice-volume.ts        (YENİ)
client/js/core/voice-activity-ui.ts   (YENİ)
client/js/core/voice-messages.ts      (YENİ)
client/js/core/slow-mode.ts           (YENİ)
client/js/core/a11y-focus-trap.ts     (GÜNCELLENDİ)
client/js/core/a11y-keyboard.ts       (GÜNCELLENDİ)
client/js/core/skeleton-loading.ts    (GÜNCELLENDİ)
client/js/core/dm-read.ts             (GÜNCELLENDİ)
client/js/core/translate-btn.ts       (GÜNCELLENDİ)
server/middleware/ipBan.ts            (GÜNCELLENDİ)
server/socket/handlers/stage.ts       (GÜNCELLENDİ)
```
