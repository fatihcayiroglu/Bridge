# Bridge 🌉

![CI](https://github.com/bridge-app/bridge/actions/workflows/ci.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

**Self-host, federasyon destekli iletişim platformu** — sohbet, ses ve topluluklar senin altyapında.

Bridge bir Discord kopyası değildir. Köprü metaforu (Hub → Space → Flow), köprü mavisi kimlik ve ActivityPub federasyonu ile kendi yolunda ilerler. Tüm özellikler ücretsiz; Nitro yok.

Tasarım yönü: [docs/DESIGN_DIRECTION.md](docs/DESIGN_DIRECTION.md)

## Demo

| | |
|---|---|
| **Tanıtım sitesi** | [bridge-app.github.io/bridge](https://bridge-app.github.io/bridge/) |
| **5 dk yerel demo** | `./scripts/demo.sh` → http://localhost:3001 |
| **Rehber** | [docs/DEMO.md](docs/DEMO.md) |

![Bridge arayüz konsepti — Hub, Space ve Flow](docs/assets/bridge-hero.svg)

Arayüz düzeni: Ayarlar → Görünüm → **Odak / Kompakt / Klasik**

---

## Bridge ne sunar?

| Özellik | Açıklama |
|---------|----------|
| Self-host | Docker veya bare metal — verin sende |
| Federasyon | ActivityPub ile diğer instance'lara bağlan |
| E2EE | Uçtan uca şifreli kanallar |
| Ses & video | WebRTC + Mediasoup SFU |
| AI | Özet, çeviri, moderasyon (opsiyonel) |
| Açık kaynak | MIT lisansı |
| RTL | Arapça, İbranice, Farsça desteği |

### Kapalı platformlarla kıyas (opsiyonel)

| | Tipik kapalı platform | Bridge |
|---|---|---|
| Animasyonlu avatar / banner | Ücretli plan | ✅ Ücretsiz |
| Yüksek kalite ses | Ücretli plan | ✅ Ücretsiz |
| Self-host | ❌ | ✅ |
| Federasyon | ❌ | ✅ ActivityPub |
| Kaynak kodu | ❌ | ✅ MIT |

---

## Hızlı Kurulum

### Docker (önerilen)

```bash
git clone https://github.com/bridge-app/bridge.git
cd bridge
cp .env.docker .env
# .env'i düzenle: JWT_SECRET, REFRESH_SECRET, POSTGRES_PASSWORD
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
docker compose up -d --build
# → http://localhost:3001
```

> İlk kayıt olan kullanıcı otomatik admin olur.

### Manuel (geliştirme)

**Gereksinimler:** Node.js 22+, PostgreSQL 14+

```bash
# 1. PostgreSQL veritabanı oluştur
createdb bridge

# 2. Kurulum (kök dizinde)
cp server/.env.example server/.env
# server/.env → JWT_SECRET, REFRESH_SECRET, DATABASE_URL doldur
npm run setup          # install + build
npm start              # İlk çalışmada schema otomatik oluşur
# → http://localhost:3001

# Geliştirme (hot reload):
npm run dev
```

Türkçe özet: [KURULUM.md](KURULUM.md) · Zip paketi: [DISTRIBUTION.md](DISTRIBUTION.md)

---

## Ortam Değişkenleri

### Zorunlu

```env
JWT_SECRET=cok_uzun_rastgele_string
REFRESH_SECRET=baska_cok_uzun_rastgele_string
```

### Veritabanı (zorunlu — PostgreSQL)

```env
DATABASE_URL=postgresql://bridge:sifre@localhost:5432/bridge
REDIS_URL=redis://localhost:6379   # Multi-instance için zorunlu
```

### AI (birini seç — hepsi ücretsiz plan sunar)

```env
GROQ_API_KEY=gsk_xxxx             # groq.com
GEMINI_API_KEY=AIzaxxxx           # aistudio.google.com
OPENROUTER_API_KEY=sk-or-xxxx     # openrouter.ai
OLLAMA_URL=http://localhost:11434  # tamamen local
```

> AI key olmadan da çalışır — fallback keyword arama kullanılır.

### Diğer (hepsi opsiyonel)

```env
PORT=3001
ALLOWED_ORIGINS=https://bridge.senindomain.com
INSTANCE_NAME=Bridge
INSTANCE_URL=https://bridge.senindomain.com
MAX_FILE_SIZE_MB=2048
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=senin@gmail.com
SMTP_PASS=uygulama_sifresi
VAPID_PUBLIC_KEY=...    # npm run vapid:generate ile üret
VAPID_PRIVATE_KEY=...
```

---

## Özellikler

### Mesajlaşma
- Real-time mesajlaşma, düzenleme, geçmiş
- Emoji, GIF, reaksiyonlar, thread, mention
- Slash komutları, zamanlanmış mesajlar, pinler
- Mesaj çevirisi (AI veya LibreTranslate)
- Büyük dosya yükleme (chunked)

### Sesli & Video
- WebRTC P2P ses + adaptif bitrate (VP9)
- Sesli mesajlar + AI transkripsiyon (Groq Whisper)
- Soundboard, müzik botu desteği
- SFU group voice (Mediasoup)

### Sunucu Yönetimi
- Sınırsız sunucu & kanal, kategoriler, forum kanallar
- Rol & izin sistemi (kanal bazlı granüler)
- Moderasyon (ban, kick, timeout, auto-mod AI)
- Admin dashboard, özel emoji, QR davet + sosyal paylaşım
- Audit log, sunucu şablonları

### Güvenlik & Gizlilik
- Uçtan uca şifreleme — DM ve kanallar (opsiyonel)
- İki faktörlü doğrulama (TOTP)
- WebAuthn / Passkey desteği (FIDO2)
- JWT + refresh token rotasyonu, rate limiting
- IP ban, içerik tarama, HTTP Signature (federasyon)

### AI
- Konuşma özeti, çeviri, moderasyon, yanıt önerisi
- Semantik arama ("bu haftaki önemli kararlar?")
- Haftalık topluluk digest, bağlılık analizi
- Sesli mesaj transkripsiyonu

### Platform
- PWA, Electron masaüstü, Capacitor iOS/Android
- Bot API + Marketplace + SDK (örnek botlar dahil)
- ActivityPub federasyon (Fediverse uyumlu)
- Swagger/OpenAPI → `/api/docs`
- Docker + PostgreSQL + Redis + GitHub Actions CI/CD
- Plugin sistemi (sandbox izolasyonu)
- Prometheus metrikleri + Grafana dashboard

### Uluslararasılaştırma (i18n)
- 15 dil desteği: Türkçe, İngilizce, Almanca, Fransızca, İspanyolca, Japonca, Portekizce, Korece, Rusça, İtalyanca, Çince, Arapça, Flemenkçe, **İbranice**, **Farsça**
- RTL (sağdan sola) düzeni: Arapça (`ar`), İbranice (`he`), Farsça (`fa`) — `<html dir="rtl">` otomatik atanır
- Lazy-load dil paketleri — varsayılan Türkçe, diğerleri talep üzerine yüklenir

---


---

## Federasyon

Bridge, iki farklı federasyon protokolü destekler: **Bridge-to-Bridge** (tam özellik) ve **ActivityPub** (Fediverse uyumu).

### Bridge-to-Bridge Federasyonu

Farklı sunuculardaki kullanıcılar birbirlerinin sunucularına katılabilir ve mesajlaşabilir. Tüm istekler HTTP Signature (RFC draft-cavage) ile imzalanır.

#### 1. Sunucunu yapılandır

```env
# server/.env
INSTANCE_NAME=Bridge Türkiye
INSTANCE_DESC=Türkçe Bridge topluluğu
INSTANCE_URL=https://bridge.senindomain.com
FEDERATION_SECRET=guclu-gizli-bir-anahtar
```

#### 2. Peer ekle (Admin → Federasyon → Peer Ekle)

```
https://bridge.baskasunucu.com
```

Bridge karşı sunucuya `/api/federation/info` isteği atar, yanıtı doğrular ve peer olarak kaydeder. Artık iki sunucu birbirinin keşfedilebilir sunucularını görür.

#### 3. Uzak sunuculara katıl

Sol panelde **🌐 Federasyon** butonuna tıkla → **Keşfet** sekmesinde peer URL'si gir → uzak sunucular listelenir → **Katıl** butonu ile üye ol.

```
Kullanıcı akışı:
  bridge-a.com kullanıcısı
    → bridge-b.com sunucusunu keşfeder
    → Katıl butonuna tıklar
    → bridge-b.com'a üyelik isteği gider
    → Onaylanınca bridge-b.com kanalları görünür
```

#### API Uç Noktaları

| Uç Nokta | Açıklama |
|---|---|
| `GET /api/federation/info` | Bu sunucunun bilgileri (ad, sürüm, URL) |
| `GET /api/federation/servers` | Keşfe açık sunucuların listesi |
| `GET /api/federation/peers` | Kayıtlı peer sunucular (auth gerekli) |
| `POST /api/federation/peers` | Yeni peer ekle (admin) |
| `DELETE /api/federation/peers/:id` | Peer kaldır (admin) |
| `GET /api/federation/discover` | Tüm peer'lardan sunucu topla |
| `POST /api/federation/ping` | Canlılık bildirimi (peer → bu sunucu) |

#### Güvenlik

- Her istek `X-Bridge-Signature` başlığıyla HMAC-SHA256 imzalanır.
- `FEDERATION_SECRET` iki sunucuda da aynı olmalıdır — ya da Admin panelinde per-peer secret tanımlanır.
- **Whitelist / Blacklist**: Admin → Federasyon → ACL sekmesinden hangi domain'lerin bağlanabileceği kontrol edilir.
- Replay saldırısına karşı istek zaman damgası 5 dakika toleransla doğrulanır.

---

### ActivityPub (Fediverse)

Bridge, ActivityPub protokolünü kısmen uygular. Mastodon, Pleroma ve diğer Fediverse yazılımlarıyla temel düzeyde birlikte çalışabilirlik sağlar.

#### NodeInfo

```
GET https://bridge.senindomain.com/.well-known/nodeinfo
GET https://bridge.senindomain.com/nodeinfo/2.1
```

Mastodon ve benzeri araçlar bu endpoint'ten sunucu bilgilerini okur.

#### Kullanıcı Profilleri

```
GET /ap/users/:username
```

Her Bridge kullanıcısı, ActivityPub `Person` nesnesi olarak yayımlanır:

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Person",
  "id": "https://bridge.senindomain.com/ap/users/alice",
  "preferredUsername": "alice",
  "inbox": "https://bridge.senindomain.com/ap/users/alice/inbox",
  "outbox": "https://bridge.senindomain.com/ap/users/alice/outbox"
}
```

#### Mesajlar

```
GET /ap/notes/:messageId
```

Bridge mesajları ActivityPub `Note` nesnesi olarak sunulur.

#### Mevcut Durum ve Sınırlar

| Özellik | Durum |
|---|---|
| NodeInfo | ✅ Tam |
| Kullanıcı Actor (`Person`) | ✅ Tam |
| Note yayımlama | ✅ Okuma (GET) |
| Inbox (gelen aktivite) | ✅ Tam |
| Follow / Accept / Reject / Undo | ✅ Tam |
| Mastodon'dan takip et | ✅ Destekleniyor |
| Bridge'den uzak aktör takip et | ✅ Destekleniyor |
| DM (Direct Message) | ✅ E2EE ile destekleniyor |

> Bridge-to-Bridge federasyonu tam özellikli ve production kullanımına hazırdır. ActivityPub (Fediverse) desteği de Follow/Accept/Reject/Undo akışları ve E2EE DM ile production kalitesine ulaşmıştır.

---

### Örnek: İki Bridge Sunucusu Bağlama

```bash
# Sunucu A: bridge-a.com
INSTANCE_URL=https://bridge-a.com
FEDERATION_SECRET=paylasilan-gizli-anahtar

# Sunucu B: bridge-b.com
INSTANCE_URL=https://bridge-b.com
FEDERATION_SECRET=paylasilan-gizli-anahtar
```

1. Sunucu A'da Admin olarak giriş yap
2. Sol panel → 🌐 Federasyon → Peerlar → **Peer Ekle**
3. `https://bridge-b.com` URL'sini gir → **Bağlan**
4. Bridge-A, Bridge-B'ye `/api/federation/info` isteği atar ve bağlantıyı doğrular
5. Bridge-B yöneticisi de aynı adımla A'yı ekler (ya da ping ile otomatik tanır)
6. Her iki sunucudaki kullanıcılar artık karşılıklı sunucuları **Keşfet** sekmesinde görür

## Proje Yapısı

```
bridge/
├── client/               # Frontend (vanilla JS)
│   ├── index.html
│   ├── css/              # tokens.css + style.css
│   └── js/
│       ├── app.js        # Giriş noktası
│       └── core/         # Modüler çekirdek
├── server/               # Backend (Node.js + Express)
│   ├── index.js
│   ├── routes/           # REST API
│   ├── socket/           # Socket.IO handlers
│   ├── middleware/        # auth, rateLimit, validate
│   ├── lib/              # Yardımcı modüller
│   ├── db/               # PostgreSQL katmanı
│   ├── jobs/             # Arka plan görevler
│   └── tests/            # Jest
├── bot-sdk/              # Bot geliştirme SDK + örnekler
├── plugins/              # Plugin sistemi
├── electron/             # Masaüstü uygulaması
├── mobile/               # Capacitor iOS/Android
├── monitoring/           # Prometheus + Grafana
├── k6/                   # Yük testleri
├── e2e/                  # Playwright E2E testleri
├── docker-compose.yml
└── Dockerfile
```

---

## Bot Geliştirme

```bash
cd bot-sdk && npm install && npm run build
cd examples/welcomebot
BRIDGE_BOT_TOKEN=brg_xxx BRIDGE_SERVER_URL=http://localhost:3001 node index.js
```

Bot SDK olayları: `message`, `memberJoin`, `memberLeave`, `reaction`, `voiceJoin`

Detaylar: [`bot-sdk/README.md`](bot-sdk/README.md) · API: `/api/docs`

---

## Testler

```bash
cd server
npm test                 # Tüm testler
npm run test:coverage    # Coverage raporu (sunucu: %85 satır eşiği)
```

E2E testler (Playwright):

```bash
cd e2e
npm install
npx playwright test
```

---

## Production

```bash
# .env'i production değerleriyle güncelle
docker compose up -d

# Güncelleme
git pull && docker compose build bridge && docker compose up -d bridge
```

---

## Katkı

Fork → Branch → `npm test` geçmeli → PR

Detaylar: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Lisans

[MIT](LICENSE) — [Roadmap](ROADMAP.md) · [Güvenlik](SECURITY.md)

---

## Bot uyumluluk katmanı (opsiyonel)

`discord-shim/` — mevcut Discord.js v14 botlarını Bridge API'sine uyarlar. Ana ürün kimliği Bridge'dir; bu katman geçiş kolaylığı içindir.

### Tek Satır Geçiş

```diff
- const { Client, GatewayIntentBits } = require('discord.js');
+ const { Client, GatewayIntentBits } = require('./discord-shim');
```

Env değişkeni güncellemesi:
```env
BRIDGE_TOKEN=brg_bot_xxxxxxxxxxxx
BRIDGE_URL=https://your-bridge-server.com
```

Detaylar için → [`discord-shim/README.md`](./discord-shim/README.md)
