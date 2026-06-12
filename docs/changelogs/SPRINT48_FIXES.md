# Sprint 48 — pgCollection Geçişi + JS/TS Temizliği + Test Coverage (2026-05-16)

## Özet
4 teknik borç kalemi kapatıldı.

---

## Post-Mortem: pgCollection Güvenlik Açığı Sprint 46'dan Bu Yana Neden Canlıdaydı?

**Zaman çizelgesi:**
- **Sprint 46:** `pgCollection.ts` yazıldı, `ALLOWED_COLUMNS` + `assertValidColumn()` implement edildi, birim testleri geçti.
- **Sprint 46:** `index.ts` güncellenmedi — ihmal, PR review'da atlandı.
- **Sprint 47:** `pgCollection-injection.test.js` pakete eklendi, implementasyon doğrulandı ✅ — ama `index.ts` importu hâlâ kontrol edilmedi.
- **Sprint 48:** Fark edildi ve düzeltildi.

**Kök neden:** `pgCollection.ts`'i yazan geliştirici `index.ts`'i ayrı bir PR'da güncellemeyi planladı, ancak bu aksiyon hiçbir yerde izlenmedi (ne issue, ne TODO, ne CI guard). Sprint 47 review'unda implementasyon doğrulanırken "import edilip edilmediği" değil "fonksiyonun doğru çalışıp çalışmadığı" kontrol edildi.

**Neden PR review'da atlandı:** `index.ts` değişmemişti; diff'te görünmüyordu. Reviewer dosyayı aktif olarak açıp import satırını kontrol etmedi.

**Alınan önlemler:**
1. CI'a `collection.ts` import guard eklendi (Sprint 48) — artık yeni hiçbir dosya deprecated modülü import edemez.
2. Güvenlik açığı olan `@deprecated` geçişlerinde CI guard **aynı sprint'te** yazılacak (Sprint 49+ için kural).

---

## 1. pgCollection.ts Tam Geçiş — Whitelist Koruması Production'da

**Sorun:**
`server/db/postgres/index.ts` whitelist korumasız `collection.ts`'i import ediyordu.
Sprint 46'da `pgCollection.ts` yazılmış ve test edilmişti, ancak `index.ts` güncellenmemişti.
Production kodu SQL injection whitelist'ini bypass ediyordu.

**Düzeltme:**
```typescript
// ÖNCE
import { PgCollection as Collection } from './collection';

// SONRA
import { PgCollection as Collection } from './pgCollection';
```

`collection.ts` `@deprecated` olarak işaretlendi; yalnızca geriye-dönük uyumluluk için korunuyor.

---

## 2. JS/TS Çift Dosya Temizliği — 38 Legacy .js Silindi

**Sorun:**
`client/js/core/` altında 38 modülde `.ts` canonical kaynak ve `.js` legacy kaynak birlikte bulunuyordu.
esbuild `.ts` dosyalarını bundle'a alıyor; `.js` dosyaları artık eski kalıp kodlar.

**Silinen dosyalar (38 adet):**
`a11y-focus-trap.js`, `a11y-keyboard.js`, `api.js`, `audit-log.js`, `auth-revoked.js`,
`auth.js`, `badges.js`, `channel-permissions.js`, `dm-read.js`, `drafts.js`, `emoji.js`,
`forum.js`, `friends.js`, `go-live.js`, `image-viewer.js`, `members.js`, `messages.js`,
`messages/input.js`, `misc.js`, `moderation.js`, `music-player.js`, `offline-queue.js`,
`offlineCache.js`, `onboarding.js`, `outgoing-webhooks.js`, `profile-ui.js`,
`scheduled-ui.js`, `servers.js`, `skeleton-loading.js`, `slow-mode.js`,
`socket-events.js`, `socket.js`, `themes.js`, `translate-btn.js`, `ui.js`,
`voice-activity-ui.js`, `voice-messages.js`, `voice-volume.js`

**build.js güncellendi:**
`entry('core/go-live.js')` → `entry('core/go-live.ts')` ve 4 channel-perms modal entry.

---

## 3. Client Test Coverage Genişletmesi

### voice.test.js (23 → 36 test, +13)
Yeni kapsam:
- `sfuHandleNewProducer` — video/audio kind ayrımı
- `sfuHandlePeerLeft` — tile temizleme, olmayan peer
- `stopMyScreenShare` — badge gizleme
- `toggleSSFullscreen` / `toggleSSMiniMode` — class toggle
- `updatePeerState` — deafened, videoOn durumları

### settings-modal.test.js (10 → 22 test, +12)
Yeni kapsam:
- `openSettings` modal görünürlüğü
- Ses cihazı seçimi (mic/speaker/camera)
- Tema değişimi (dark/light)
- Ses kalitesi codec seçimi
- `_updateProfilePreview` renk ve boş displayName

### bot-marketplace.test.js (32 → 44 test, +12)
Yeni kapsam:
- `showCategory('all')` ve geçersiz kategori
- Boş/uzun arama string'i edge case
- `toggleBotInstall` sunucu yokken
- `makeCard` — minimal bot, uzun description, null description
- `getCatalog` önbellekleme ve array tipi
- `fetchLoadedPlugins` network error

**Toplam yeni test: +37**

---

## 4. node-fetch Shim Referansı Temizlendi

`server/lib/fetch.ts` header'ındaki eski yorum güncellendi:
`"node-fetch yerine"` → `"node-fetch bağımlılığı kaldırıldı (Sprint 48)"`

`package.json`'da zaten yoktu — doğrulandı ✅

---

## Değişen Dosyalar

```
server/db/postgres/index.ts              (GÜNCELLENDİ — pgCollection import)
server/db/postgres/collection.ts         (GÜNCELLENDİ — @deprecated işareti)
server/lib/fetch.ts                      (GÜNCELLENDİ — yorum temizliği)
scripts/build.js                         (GÜNCELLENDİ — .js → .ts entry'ler)
client/js/core/*.js (38 dosya)           (SİLİNDİ — legacy JS kaynaklar)
client/tests/voice.test.js               (GÜNCELLENDİ — +13 test)
client/tests/settings-modal.test.js      (GÜNCELLENDİ — +12 test)
client/tests/bot-marketplace.test.js     (GÜNCELLENDİ — +12 test)
SPRINT48_FIXES.md                        (YENİ)
```

## Sayısal Özet

| Metrik | Değer |
|---|---|
| Production whitelist koruması aktifleştirildi | ✅ |
| Silinen legacy .js dosyası | 38 |
| Güncellenen build entry | 5 |
| Yeni test vakası | 37 |
| Kalan `.js`-only (TypeScript'e geçilmemiş) | 28 (core/: 24 + core/messages/: 4 — i18n, voice.js, bot-marketplace.js vb.) |
| node-fetch bağımlılığı | ✅ Mevcut değil |
