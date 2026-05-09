# Bridge — Session 9 Delivery

## Scope

Session 9 tamamlandı. Bu paket Session 7, 8 ve 9 düzeltmelerini + yeni özellikleri içerir.

## Session 9 — Hata Düzeltmeleri

| # | Önem | Açıklama | Dosya |
|---|------|----------|-------|
| 1 | 🔴 | `ecosystem.config.js` yanlış giriş noktası (`server.js` → `index.js`) | `ecosystem.config.js` |
| 2 | 🔴 | SQLite migration `003` — `ALTER` önce `CREATE`'den geliyordu | `server/db/sqlite/migrations/003_session9_features.sql` |
| 3 | 🔴 | PostgreSQL Session 9 migration eksikti (`dm_messages.readAt`) | `server/db/migrations_pg/004_session9_features.sql` |
| 4 | 🟠 | `socket/index.js` IP rate store bellek sızıntısı (cleanup yorum satırıydı) | `server/socket/index.js`, `index.ts` |
| 5 | 🟠 | `scripts/build.js` Session 8/9 dosyaları chunk'a eklenmemişti | `scripts/build.js` |
| 6 | 🟡 | HAProxy hata dosyaları eksikti (config parse hatası) | `haproxy/errors/*.http` |
| 7 | 🟡 | `voice-activity-ui.js` VAD rAF döngüsü durdurulamıyordu (kaynak sızıntısı) | `client/js/core/voice-activity-ui.js` |
| 8 | 🟡 | `.github/workflows/ci.yml` eksikti (Session 7'de tanımlanan strict typecheck adımları) | `.github/workflows/ci.yml` |

## Session 9 — Yeni Özellikler

| Özellik | Server | Client |
|---------|--------|--------|
| 🎨 Shared Canvas / Whiteboard | `server/socket/handlers/canvas.ts` | `client/js/core/canvas.js` |
| ✓✓ DM Okundu Bilgisi | `server/socket/handlers/dm-read.js` | `client/js/core/dm-read.js` |
| 🔊 Ses Aktivitesi UI | — | `client/js/core/voice-activity-ui.js` |
| 📅 Zamanlanmış Mesaj UI | — | `client/js/core/scheduled-ui.js` |
| 🌐 Mesaj Çeviri Butonu | — | `client/js/core/translate-btn.js` |

## Entegrasyon Gereksinimleri

Canvas, DM-read ve VoiceActivityUI `server/socket/index.js`'e kayıtlıdır.
Client tarafı `client/index.html`'de script listesine eklenmiştir.

VoiceActivityUI için voice.js'e şu çağrılar eklenmelidir:
```js
// Kanal join sonrasında:
VoiceActivityUI.init(socket);
window._bridgeStartLocalVAD(localStream, channelId);

// Kanal leave sırasında:
window._bridgeStopLocalVAD?.();
```

## Değişen Dosyalar (Session 9)

`ecosystem.config.js`, `server/db/sqlite/migrations/003_session9_features.sql`,
`server/db/migrations_pg/004_session9_features.sql`, `server/socket/index.js`,
`server/socket/index.ts`, `server/socket/handlers/canvas.ts`,
`server/socket/handlers/dm-read.js`, `server/socket/contracts.ts`,
`client/js/core/canvas.js`, `client/js/core/dm-read.js`,
`client/js/core/voice-activity-ui.js`, `scripts/build.js`,
`haproxy/errors/*.http`, `.github/workflows/ci.yml`
