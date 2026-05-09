# Bridge 🌉

![CI](https://github.com/your-org/bridge/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

**Discord'un açık kaynak, ücretsiz, gizlilik öncelikli alternatifi.**

Tüm özellikler herkese ücretsiz — animasyonlu avatar, profil banner, yüksek kalite ses, AI asistanı. Ücretli plan yok.

---

## Neden Bridge?

| | Discord | Bridge |
|---|---|---|
| Animasyonlu avatar | Nitro ($10/ay) | ✅ Ücretsiz |
| Profil banner | Nitro | ✅ Ücretsiz |
| Yüksek kalite ses | Nitro | ✅ Ücretsiz |
| AI asistanı | 3. taraf bot | ✅ Native entegre |
| Mesaj şifreleme | ❌ | ✅ E2EE |
| Açık kaynak | ❌ | ✅ MIT |
| Self-host | ❌ | ✅ Docker ile 1 komut |
| Federasyon | ❌ | ✅ ActivityPub |

---

## Hızlı Kurulum

### Docker (önerilen)

```bash
git clone https://github.com/your-org/bridge.git
cd bridge
cp .env.docker .env
# .env'i düzenle: JWT_SECRET ve REFRESH_SECRET doldur
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
docker compose up -d
# → http://localhost:3001
```

> İlk kayıt olan kullanıcı otomatik admin olur.

### Manuel (geliştirme)

**Gereksinimler:** Node.js 22+, PostgreSQL 14+

```bash
# 1. PostgreSQL veritabanı oluştur
createdb bridge

# 2. Sunucuyu kur ve başlat
cd server
npm install
cp .env.example .env
# .env'i düzenle: JWT_SECRET, REFRESH_SECRET ve DATABASE_URL doldur
npm start              # İlk çalışmada schema otomatik oluşur
# → http://localhost:3001
```

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
| Inbox (gelen aktivite) | 🔄 Temel |
| Follow / Accept | 🔄 Temel |
| Mastodon'dan takip et | ⚠️ Deneysel |
| DM (Direct Message) | ❌ Planlanmıyor |

> ActivityPub desteği aktif geliştirilmektedir. Bridge-to-Bridge federasyonu tam özellikli ve production kullanımına hazırdır.

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
cd bot-sdk/examples/welcomebot
cp .env.example .env   # BOT_TOKEN ekle (Admin → Botlar → Yeni Bot)
npm install && node index.js
```

Bot SDK olayları: `message`, `memberJoin`, `memberLeave`, `reaction`, `voiceJoin`

Detaylar: [`bot-sdk/README.md`](bot-sdk/README.md) · API: `/api/docs`

---

## Testler

```bash
cd server
npm test                 # Tüm testler
npm run test:coverage    # Coverage raporu (%70 eşik)
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

MIT — [Roadmap](ROADMAP.md)

---

## Discord Bot Uyumluluk Katmanı

`discord-shim/` klasörü, mevcut Discord.js v14 botlarının Bridge'de çalışmasını sağlar.

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
