# SPRINT 82 — Eksiklik Giderme Paketi

**Tarih:** 2026-05-24
**Kapsam:** Discord karşılaştırma analizinde tespit edilen kritik eksiklikler

---

## 1. Yeni Özellikler

### 🎮 Activities Sistemi
Discord Activities muadili — sesli kanal üzerinde iframe tabanlı mini uygulamalar.

**Dosyalar:**
- `client/js/core/activities/index.ts` — client tarafı (picker UI, socket bağlama)
- `server/socket/handlers/activities.ts` — sunucu handler (oturum yönetimi)

**Built-in aktiviteler:**
| ID | Ad | Maks Kullanıcı |
|---|---|---|
| `watch-together` | Watch Together (YouTube) | 20 |
| `chess` | Satranç | 2 |
| `draw-together` | Birlikte Çiz | 10 |
| `word-snack` | Kelime Oyunu | 8 |
| `trivia` | Trivia | 16 |

**API:**
```ts
import { initActivities, openActivityPicker, launchActivity, joinActivity, leaveActivity } from './activities/index.js';

initActivities();  // app başlangıcında çağır

// Picker aç (sesli kanal toolbar'ından)
openActivityPicker(channelId, serverId);

// Doğrudan başlat
await launchActivity('chess', channelId, serverId);
```

**Socket olayları:**
- `activity:start` → `activity:started` (kanal geneli yayın)
- `activity:join` → `activity:join_ok`
- `activity:leave` → `activity:ended` veya `activity:participants_updated`
- `activity:list` → `activity:list_result`

**Entegrasyon (voice toolbar):**
```ts
// client/js/core/voice-toolbar.ts içinde ekle:
import { openActivityPicker } from './activities/index.js';

const actBtn = voiceToolbar.querySelector('.activity-btn');
actBtn?.addEventListener('click', () => openActivityPicker(currentChannelId, currentServerId));
```

---

### ✨ Super Reactions
Emoji'ye uzun basınca tetiklenen burst animasyonu.

**Dosyalar:**
- `client/js/core/super-reactions/index.ts`
- `server/socket/handlers/super-reactions.ts`

**API:**
```ts
import { initSuperReactions, attachLongPressToReaction, sendSuperReaction } from './super-reactions/index.js';

initSuperReactions();  // app başlangıcında

// Reaksiyon butonlarına otomatik long-press ekle:
document.querySelectorAll('.reaction-btn').forEach(btn => {
  const cleanup = attachLongPressToReaction(
    btn,
    btn.dataset.messageId!,
    btn.dataset.channelId!,
    btn.dataset.emoji!,
  );
  // cleanup() component unmount edilince çağır
});
```

**Cooldown:** Aynı mesaj + kullanıcı için 5 saniye
**Long press süresi:** 600ms

---

### ✂️ Clips Sistemi
Sesli/video kanalda son 30 saniyeyi klip olarak kaydetme.

**Dosyalar:**
- `client/js/core/clips/index.ts`
- `server/socket/handlers/clips.ts`

**API:**
```ts
import { initClips, startClipBuffer, stopClipBuffer, quickClip, openClipDurationPicker } from './clips/index.js';

initClips();

// Sesli kanala girilince:
startClipBuffer(mediaStream, channelId);

// Kanaldan çıkınca:
stopClipBuffer();

// Klip kaydet (son 30s):
await quickClip();

// Picker ile özel süre:
openClipDurationPicker();
```

**Buffer:** Rolling 30 saniye (500ms chunk'lar)
**Maks klip:** 60 saniye
**Desteklenen format:** WebM (VP9+Opus tercihli)

---

### 🎭 Sticker Sistemi
Sunucu bazlı ve global sticker paketleri.

**Dosyalar:**
- `client/js/core/stickers/index.ts`
- `server/routes/sticker-packs.ts`

**Global paketler:**
- Bridge Klasik (8 sticker)
- Meme Koleksiyonu (4 sticker)

**API:**
```ts
import { initStickers, openStickerPicker, sendSticker } from './stickers/index.js';

initStickers();

// Picker aç (emoji picker yanına butonu ekle):
const stickerBtn = document.querySelector('.sticker-btn');
stickerBtn?.addEventListener('click', () => {
  openStickerPicker(channelId, serverId, stickerBtn);
});
```

**REST Endpoint'leri:**
```
GET    /api/servers/:serverId/sticker-packs          → Paket listesi
POST   /api/servers/:serverId/sticker-packs          → Yeni paket (MANAGE_SERVER)
DELETE /api/servers/:serverId/sticker-packs/:packId  → Paket sil (MANAGE_SERVER)
PATCH  /api/servers/:serverId/sticker-packs/:packId/stickers/:stickerId → Meta güncelle
```

**Router bağlantısı (`server/routes/index.ts`):**
```ts
import stickerPacksRouter from './sticker-packs.js';
serverRouter.use('/:serverId/sticker-packs', stickerPacksRouter);
```

---

## 2. i18n — Yeni Diller

| Dil | Kod | Dosya | Anahtar Sayısı |
|---|---|---|---|
| İspanyolca | `es` | `client/js/core/i18n/es.ts` | 138 |
| Japonca | `ja` | `client/js/core/i18n/ja.ts` | 138 |
| Portekizce (BR) | `pt` | `client/js/core/i18n/pt.ts` | 138 |
| Korece | `ko` | `client/js/core/i18n/ko.ts` | 138 |
| Rusça | `ru` | `client/js/core/i18n/ru.ts` | 132 |

**i18n.ts güncelleme:**
```ts
// client/js/core/i18n.ts içinde SUPPORTED_LOCALES'i güncelle:
export const SUPPORTED_LOCALES = ['en', 'de', 'fr', 'tr', 'es', 'ja', 'pt', 'ko', 'ru'];

// Lazy loader map'e ekle:
const LOCALE_LOADERS: Record<string, () => Promise<Record<string, string>>> = {
  en:  () => import('./i18n/en.js').then(m => m.default),
  de:  () => import('./i18n/de.js').then(m => m.default),
  fr:  () => import('./i18n/fr.js').then(m => m.default),
  tr:  () => import('./i18n/tr.js').then(m => m.default),
  // Sprint 82:
  es:  () => import('./i18n/es.js').then(m => m.default),
  ja:  () => import('./i18n/ja.js').then(m => m.default),
  pt:  () => import('./i18n/pt.js').then(m => m.default),
  ko:  () => import('./i18n/ko.js').then(m => m.default),
  ru:  () => import('./i18n/ru.js').then(m => m.default),
};
```

---

## 3. Test Eklentileri

| Dosya | Test Sayısı | Konu |
|---|---|---|
| `client/tests/activities.test.ts` | 17 | Activities client logic |
| `client/tests/super-reactions.test.ts` | 17 | Super reactions logic |
| `client/tests/clips.test.ts` | 20 | Clips buffer logic |
| `client/tests/stickers.test.ts` | 18 | Sticker search & management |
| `client/tests/i18n-sprint82.test.ts` | 19 | i18n completeness |
| `client/tests/permissions-sprint82.test.ts` | 38 | Permissions extended (tüm pure fns) |
| `server/tests/activities.server.test.ts` | 18 | Activities server handler |

**Toplam yeni test:** 147

**Coverage etkisi (tahmin):**
- `permissions.ts` pure functions: +%22 coverage
- Yeni modüller: activities, clips, stickers, super-reactions başlangıç coverage'ı sağlandı

---

## 4. Kalan Eksiklikler (Sprint 83+)

Bu sprint'te başlanamayan konular:

| Konu | Öncelik | Tahmini Süre |
|---|---|---|
| Activities: gerçek Watch Together (YouTube iframe) | Yüksek | 2 gün |
| Activities: Chess engine entegrasyonu (chess.js) | Orta | 3 gün |
| Sticker görselleri (SVG/WebP asset'ler) | Yüksek | 1 gün (tasarım) |
| Mobile (Capacitor) native deneyim iyileştirmesi | Orta | 1 hafta |
| Kubernetes manifest'leri | Düşük | 1 gün |
| İtalyanca, Çince, Arapça, Flemenkçe i18n | Düşük | 2 gün |
| Bot marketplace server-side catalog API | Orta | 1 gün |
| Stage channel video grid layout | Düşük | 2 gün |

---

## 5. Puan Güncellemesi (Tahmini)

| Kategori | Sprint 81 | Sprint 82 |
|---|---|---|
| Özellik Kapsamı | 8/10 | 8.7/10 |
| i18n | 6/10 | 8.5/10 |
| Test Coverage | 8.5/10 | 9.1/10 |
| **Genel** | **8.3/10** | **8.8/10** |
