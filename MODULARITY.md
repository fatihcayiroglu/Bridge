# Bridge — Client Modüler Mimarisi

Bu belge, Bridge istemcisinin modüler yapısını, build sistemini ve
yeni özellik ekleme kurallarını açıklar.

---

## Dizin Yapısı

```
client/
├── index.html              # Tek giriş noktası (dev + prod)
├── sw.js                   # Service Worker (PWA)
├── manifest.json
│
├── js/
│   ├── app.js              # Koordinatör — sadece geç-bağlama kodu
│   │
│   ├── core/               # Temel modüller
│   │   ├── error-boundary.js   # Global hata yakalama
│   │   ├── utils.js            # escHtml, toast, formatDate vb.
│   │   ├── theme.js            # Tema yükleme/değiştirme
│   │   ├── i18n.js             # Çok dil desteği
│   │   ├── state.js            # Reaktif state store (BridgeState)
│   │   ├── globals.js          # Global değişkenler + klavye kısayolları
│   │   ├── auth.js             # apiFetch, token refresh, login/register
│   │   │
│   │   ├── servers.js          # Sunucu listesi, sunucu seçme
│   │   ├── channel-list.js     # Kanal listesi, kanal seçme, CRUD
│   │   ├── messages.js         # Mesaj render, gönderme, düzenleme
│   │   ├── upload.js           # Dosya yükleme (chunked)
│   │   ├── members.js          # Üye listesi kenar çubuğu
│   │   ├── socket.js           # Socket.io bağlantı yönetimi
│   │   ├── socket-events.js    # Socket.io olay bağlamaları
│   │   ├── ui.js               # Modal, reply bar, pin
│   │   ├── settings.js         # Ayarlar modalı koordinatörü
│   │   ├── emoji.js            # Emoji/GIF picker
│   │   ├── unread.js           # Okunmamış sayaçları
│   │   │
│   │   ├── server-settings.js  # Emoji yönetimi, sunucu ayarları,
│   │   │                       # webhook, audit log, SSO, plugin UI
│   │   │                       # (önceki adı: api.js — yanlış isim)
│   │   │
│   │   ├── dm.js               # Direkt mesajlar + switchDmTab
│   │   ├── dm-call.js          # DM sesli/görüntülü arama
│   │   ├── group-dm*.js        # Grup DM (core / voice / ui)
│   │   ├── voice.js            # WebRTC ses kontrolü
│   │   ├── voice-messages.js   # Sesli mesaj kaydı/oynatma
│   │   ├── voice-recorder.js   # Ham ses kaydedici
│   │   ├── noise-suppression.js # RNNoise entegrasyonu
│   │   ├── video-quality.js    # Video kalite ayarları
│   │   │
│   │   ├── channel-permissions.js  # İzin sistemi koordinatörü
│   │   ├── channel-perms-*.js      # İzin bileşenleri (data/modal/sync...)
│   │   ├── channel-perms/          # İzin modal parçaları
│   │   ├── channel-stage.js        # Stage kanal UI
│   │   │
│   │   ├── e2e.js              # Uçtan uca şifreleme
│   │   ├── ai.js               # AI asistan entegrasyonu
│   │   ├── clyde.js            # Clyde AI asistan UI
│   │   ├── search.js           # Mesaj arama
│   │   ├── semantic.js         # Anlam tabanlı arama (temel)
│   │   ├── semantic-search.js  # Anlam tabanlı arama (UI)
│   │   ├── friends.js          # Arkadaş listesi, istek yönetimi
│   │   ├── moderation.js       # Moderasyon araçları
│   │   ├── activity.js         # Kullanıcı aktivite göstergesi
│   │   ├── profile-ui.js       # Profil görüntüleme modalı
│   │   ├── server-ui.js        # Sunucu UI bileşenleri
│   │   ├── discord-ui-kit.js   # UI bileşen kütüphanesi
│   │   ├── automod-ui.js       # Otomatik moderasyon UI
│   │   ├── user-connections.js # Bağlantılı hesaplar
│   │   ├── onboarding-tour.js  # Kullanıcı karşılama turu
│   │   ├── mobile-ux.js        # Mobil UX iyileştirmeleri
│   │   ├── offlineCache.js     # Çevrimdışı mesaj önbelleği
│   │   ├── offline-banner.js   # Ağ durumu banner
│   │   ├── image-viewer.js     # Lightbox görüntü izleyici
│   │   ├── music-player.js     # Müzik çalar
│   │   ├── misc.js             # Küçük yardımcılar
│   │   ├── analytics.js        # Kullanım analitiği
│   │   ├── discord-import.js   # Discord sunucu içe aktarma
│   │   ├── bot-marketplace.js  # Bot pazaryeri
│   │   ├── ip-ban.js           # IP ban UI
│   │   ├── partials.js         # HTML parçacıkları
│   │   │
│   │   │   # Sprint 30: v41–v44 klasörleri kaldırıldı.
│   │   │   # Tüm modüller core/ altına taşındı (go-live.js, stage.js, vb.)
│   │
│   ├── admin.js            # Admin paneli
│   ├── discover.js         # Sunucu keşfetme
│   ├── federation-modal.js # ActivityPub federasyon modalı
│   ├── federation-integrations.js
│   ├── federation-ui.js
│   ├── threads.js          # Thread paneli
│   ├── slash.js            # Slash komutları
│   ├── profile.js          # Profil sayfası
│   ├── polls.js            # Anket sistemi
│   ├── soundboard.js       # Ses panosu
│   ├── marketplace.js      # Eklenti pazaryeri
│   ├── plugin-marketplace-page.js
│   ├── twoFactor.js        # 2FA kurulum
│   ├── webauthn.js         # WebAuthn/Passkey
│   ├── webrtc.js           # P2P WebRTC
│   ├── webrtc-sfu.js       # SFU WebRTC (mediasoup)
│   └── mobile.js           # Capacitor mobil köprüsü
│
└── css/
    ├── tokens.css          # CSS değişkenleri
    ├── style.css           # Ana stil (modülleri import eder)
    └── modules/            # Bileşen bazlı stiller
```

---

## Build Sistemi

### Komutlar

```bash
# Geliştirme (build olmadan, kaynak dosyalar doğrudan)
npm start                   # dist/ yoksa kaynak dosyaları serve eder
                            # window.BRIDGE_DEV = true otomatik enjekte edilir

# Üretim build
npm run build               # client/dist/ oluşturur
npm run build:watch         # Değişiklikleri izler, sadece değişen chunk'ı yeniden derler
npm run build:analyze       # Chunk boyut raporu
npm run build:ci            # build + bütçe kontrolü
```

### Chunk Stratejisi

| Chunk | İçerik | Neden ayrı? |
|-------|--------|-------------|
| `chunk-boot` | error-boundary, utils, theme, i18n, state, globals, auth | Kritik yol — hemen yüklenmeli |
| `chunk-core` | servers, channel-list, messages, socket, ui, settings | Ana uygulama döngüsü |
| `chunk-comms` | dm, group-dm, voice, emoji-picker | İletişim özellikleri |
| `chunk-webrtc` | webrtc, webrtc-sfu, noise-suppression | Büyük bağımlılık — ayrı tutulur |
| `chunk-features` | server-settings, channel-perms, e2e, ai, search | İsteğe bağlı özellikler |
| `chunk-pages` | app, federation, threads, slash, polls, webauthn | Sayfa seviyesi kodlar |
| `chunk-heavy` | discord-import, bot-marketplace, admin | Nadiren kullanılan, büyük modüller |
| `chunk-compat` | ~~v41–v44~~ kaldırıldı (Sprint 30) | Modüller core/ altına taşındı |

---

## Geliştirme Modu

`npm run build` **çalıştırmadan** sunucuyu başlatırsanız:

1. Sunucu `client/dist/` olmadığını fark eder
2. `window.BRIDGE_DEV = true` enjekte eder
3. `index.html` kaynak `.js` dosyalarını **tek tek** `<script defer>` olarak yükler
4. Değişiklik → sayfa yenileme → anında görürsünüz

Üretimde `npm run build` sonrası `client/dist/` oluşur ve 8 chunk dosyası kullanılır.

---

## Yeni Özellik Ekleme Kuralları

### 1. Doğru dosyayı seçin

| Özellik tipi | Nereye ekleyin |
|---|---|
| Yeni API çağrısı | `core/auth.js` (`apiFetch`) veya ilgili modül |
| Sunucu ayarları UI | `core/server-settings.js` |
| Kanal işlemleri | `core/channel-list.js` |
| Mesaj formatı | `core/messages.js` |
| Ses/video | `core/voice.js` veya `core/webrtc.js` |
| Global değişken | `core/globals.js` |
| Yeni sayfa/modal | `js/` altında yeni dosya |

### 2. Global değişken eklemek

`core/globals.js` içine ekleyin ve build.js'de `chunk-boot`'ta olduğunu kontrol edin:

```js
// core/globals.js içine
let myNewFeatureData = null;
```

### 3. Yeni modül eklemek

1. `client/js/core/yeni-modul.js` oluşturun
2. `scripts/build.js` içinde uygun chunk'a ekleyin:
   ```js
   { out: 'chunk-features', files: [..., 'core/yeni-modul.js'] }
   ```
3. `index.html` içindeki `DEV_SCRIPTS` dizisine de ekleyin (sıra önemli)

### 4. BridgeState kullanımı

Global değişkenler yerine state store'u tercih edin:

```js
// Okuma
const ch = BridgeState.state.currentChannel;

// Yazma (aboneleri otomatik tetikler)
BridgeState.setState({ currentChannel: channel });

// İzleme
const unsub = BridgeState.subscribe('currentChannel', (newVal, oldVal) => {
  // kanal değişti
});
// unsub() ile aboneliği iptal edin
```

---

## Değiştirilen Dosyalar (Bu PR)

| Dosya | Değişiklik |
|---|---|
| `core/globals.js` | **YENİ** — global değişkenler + keyboard shortcuts (`core/api.js`'den taşındı) |
| `core/server-settings.js` | **YENİ** — emoji mgr, server settings, webhook, audit, SSO, plugin UI (`core/api.js`'den taşındı) |
| `core/api.js` | Boşaltıldı, yönlendirme yorumu bırakıldı |
| `core/dm.js` | `switchDmTab` eklendi (`app.js`'den taşındı) |
| `app.js` | Sadece `bridge:socket-ready` bağlama kodu kaldı |
| `core/servers.js` | Duplikat `bindSocketEvents()` çağrısı kaldırıldı (bug fix) |
| `scripts/build.js` | `channels.js` → `channel-list.js` düzeltildi; `globals.js` ve `server-settings.js` eklendi; chunk-features'ta duplicate kaldırıldı |
| `server/app/createApp.js` | Dev modunda `window.BRIDGE_DEV = true` enjeksiyonu |
| `index.html` | Dev/prod koşullu script yükleme (build gerektirmeden çalışır) |
| `MODULARITY.md` | **YENİ** — bu belge |

---

## Bilinen Kısıtlamalar

- Tüm modüller `window.*` global kapsamını paylaşır (ES module değil).  
  Bu, mevcut tarayıcı uyumluluğunu korumak için bilinçli bir tercih.
- `BridgeState` geçiş sürecindedir — yeni kod state.js kullanmalı, eski kod window.* ile uyumluluk sürdürür.
- ~~`v41`–`v44` klasörleri~~ Sprint 30'da kaldırıldı. Tüm modüller `core/` altındadır.
