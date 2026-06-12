# Bridge — Veritabanı Schema Referansı

**Motor:** PostgreSQL 16+  
**Dosya:** `server/db/postgres/schema.sql`  
**Migration sistemi:** `server/db/migrations_pg/` (Sprint 38+)

Bu belge tüm tabloları, ilişkilerini ve kritik tasarım kararlarını açıklar.

---

## Tablo Özeti (64 tablo)

| # | Tablo | Açıklama |
|---|-------|----------|
| 1 | `users` | Kullanıcı hesapları |
| 2 | `user_ap_keys` | ActivityPub private key (şifreli, ayrı tablo) |
| 3 | `refresh_tokens` | JWT refresh token rotation |
| 4 | `servers` | Sunucular (Discord'daki "guild") |
| 5 | `channels` | Metin/ses/forum kanalları |
| 6 | `messages` | Kanal mesajları |
| 7 | `members` | Sunucu üyelikleri |
| 8 | `invites` | Davet linkleri |
| 9 | `roles` | Sunucu rolleri |
| 10 | `dm_conversations` | DM konuşmaları |
| 11 | `dm_messages` | DM mesajları |
| 12 | `server_gifs` | Sunucuya özel GIF'ler |
| 13 | `scheduled_msgs` | Zamanlanmış mesajlar |
| 14 | `channel_bridges` | Kanal köprüleri (bridge forwarding) |
| 15 | `server_emojis` | Özel emoji |
| 16 | `polls` | Anketler |
| 17 | `soundboard` | Ses panosu klipleri |
| 18 | `friendships` | Arkadaşlık ilişkileri |
| 19 | `channel_categories` | Kanal kategorileri |
| 20 | `notification_prefs` | Bildirim tercihleri |
| 21 | `audit_logs` | Admin audit log |
| 22 | `voice_messages` | Sesli mesaj metadata |
| 23 | `threads` | Thread'ler |
| 24 | `thread_messages` | Thread mesajları |
| 25 | `bots` | Bot hesapları |
| 26 | `webhooks` | Gelen webhook'lar |
| 27 | `channel_overrides` | Kanal bazlı izin override |
| 28 | `unread_counts` | Okunmamış mesaj sayacı |
| 29 | `push_subscriptions` | Web Push abonelikleri |
| 30 | `federation_peers` | Federe peer sunucular |
| 31 | `admin_logs` | Admin işlem logları |
| 32 | `channel_permissions` | Kanal izin setleri |
| 33 | `fcm_tokens` | Firebase Cloud Messaging token'ları |
| 34 | `bot_ratings` | Bot derecelendirmeleri |
| 35 | `server_bots` | Sunucu-bot ilişkileri |
| 36 | `ap_follows` | ActivityPub follow ilişkileri |
| 37 | `ap_activities` | ActivityPub aktivite log'u |
| 38 | `ap_messages` | ActivityPub mesajları (uzak) |
| 39 | `reaction_roles` | Reaksiyon-rol eşleştirmeleri |
| 40 | `blocks` | Kullanıcı engellemeleri |
| 41 | `pins` | Sabitlenmiş mesajlar |
| 42 | `badges` | Kullanıcı rozetleri |
| 43 | `user_badges` | Kullanıcı-rozet ilişkileri |
| 44 | `user_connections` | Sosyal medya bağlantıları |
| 45 | `server_boosts` | Sunucu boost'ları |
| 46 | `channel_follows` | Kanal takipleri |
| 47 | `server_events` | Sunucu etkinlikleri |
| 48 | `bot_marketplace` | Bot marketplace kataloğu |
| 49 | `bot_marketplace_installed` | Kurulu marketplace botları |
| 50 | `client_error_events` | İstemci tarafı hata log'ları |
| 51 | `two_factor_secrets` | TOTP 2FA secret'ları |
| 52 | `webauthn_credentials` | WebAuthn/Passkey kimlik bilgileri |
| 53 | `sso_providers` | SSO konfigürasyonu |
| 54 | `group_dm_conversations` | Grup DM konuşmaları |
| 55 | `group_dm_members` | Grup DM üyelikleri |
| 56 | `group_dm_messages` | Grup DM mesajları |
| 57 | `sticker_packs` | Sticker paketleri |
| 58 | `stickers` | Sticker'lar |
| 59 | `onboarding_progress` | Kullanıcı onboarding durumu |
| 60 | `server_member_profiles` | Sunucu bazlı üye profilleri |
| 61 | `semantic_index` | Semantik arama embedding'leri |
| 62 | `outgoing_webhooks` | Giden webhook konfigürasyonu |
| 63 | `server_templates` | Sunucu şablonları |
| 64 | `canvas_data` | Kanvas çizim verileri |

---

## Temel Tablolar

### `users`
Kullanıcı hesapları. `apPublicKey` ActivityPub için; private key bu tabloda **yoktur** — güvenlik nedeniyle `user_ap_keys`'e taşındı (Migration 006).

```sql
_id           TEXT PRIMARY KEY        -- UUID
username      TEXT UNIQUE NOT NULL
displayName   TEXT NOT NULL
password      TEXT NOT NULL           -- bcrypt hash, asla plaintext
avatarColor   TEXT DEFAULT '#5865f2'
avatarUrl     TEXT                    -- CDN URL (nullable)
status        TEXT DEFAULT 'offline'  -- online|away|busy|offline
tokenVersion  BIGINT DEFAULT 0        -- JWT revoke counter
apPublicKey   TEXT                    -- ActivityPub RSA public key (PEM)
```

**İlişkiler:** `servers.ownerId`, `members.userId`, `dm_conversations` (taraflar), `refresh_tokens.userId`

---

### `refresh_tokens`
JWT refresh token rotation. `family` sütunu token reuse detection için — bir token iki kez kullanılırsa aynı family'nin tüm token'ları iptal edilir.

```sql
token       TEXT PRIMARY KEY          -- crypto.randomBytes(48).hex()
userId      TEXT NOT NULL
expiresAt   BIGINT NOT NULL           -- Unix ms
used        SMALLINT DEFAULT 0        -- 0|1 (bir kez kullanılabilir)
usedAt      BIGINT                    -- kullanım zamanı (LRU cleanup için)
family      TEXT                      -- oturum ailesi UUID (reuse detection)
```

**Index:** `userId`, `expiresAt` — cleanup job her saat çalışır.

---

### `servers`
Sunucu (guild) tablosu. `discoverable=true` olanlar keşif sayfasında görünür.

```sql
_id           TEXT PRIMARY KEY
name          TEXT NOT NULL
ownerId       TEXT NOT NULL           -- users._id FK (soft: app-layer)
discoverable  BOOLEAN DEFAULT FALSE
tags          JSONB DEFAULT '[]'      -- keşif filtreleme için
```

---

### `channels`
Metin (`text`), ses (`voice`), forum (`forum`), duyuru (`announcement`) kanalları.

```sql
_id         TEXT PRIMARY KEY
serverId    TEXT NOT NULL             -- servers._id
type        TEXT DEFAULT 'text'
order       INTEGER DEFAULT 0        -- sıralama
slowmode    INTEGER DEFAULT 0        -- saniye (0 = kapalı)
isNSFW      BOOLEAN DEFAULT FALSE
```

**Index:** `serverId` — kanal listesi sorgusu kritik yol.

---

### `messages`
Kanal mesajları. E2EE tip'inde `content` boş bırakılır; `encryptedContent` + `iv` opak blob olarak saklanır — server içeriği hiç okumaz.

```sql
_id               TEXT PRIMARY KEY
channelId         TEXT NOT NULL
serverId          TEXT NOT NULL
userId            TEXT NOT NULL
content           TEXT DEFAULT ''
type              TEXT DEFAULT 'normal'  -- normal|file|system|e2ee|voice
reactions         JSONB DEFAULT '{}'     -- {emoji: [userId, ...]}
editHistory       JSONB                  -- [{content, editedAt}] max 10 kayıt
pinned            BOOLEAN DEFAULT FALSE
encryptedContent  TEXT                   -- E2EE: AES-GCM ciphertext (base64)
iv                TEXT                   -- E2EE: AES-GCM IV (base64, 12 byte)
embeds            TEXT                   -- JSON: link önizleme embed'leri
threadId          TEXT                   -- threads._id FK
replyTo           JSONB                  -- {_id, displayName, content snippet}
bridgedFrom       JSONB                  -- {channelId, serverId} bridge kaynak
```

**Index:** `channelId + createdAt` — sayfalama sorgusu.  
**Cache:** Adaptive TTL (Sprint 106): aktif <2dk → 5s, orta 2-10dk → 15s, sessiz >10dk → 45s.

---

### `members`
Sunucu üyelikleri. `roles` JSON array; `timeoutUntil` Unix ms timeout bitiş zamanı.

```sql
userId        TEXT NOT NULL
serverId      TEXT NOT NULL
roles         TEXT DEFAULT '[]'      -- JSON [roleId, ...]
nickname      TEXT                   -- sunucu bazlı takma ad
timeoutUntil  BIGINT                 -- null = timeout yok
joinedAt      BIGINT NOT NULL
PRIMARY KEY (userId, serverId)
```

---

### `federation_peers`
Federe Bridge sunucuları. `publicKey` per-peer RSA public key (ADR-0006 — Sprint 108'de aktifleşiyor).

```sql
_id           TEXT PRIMARY KEY
url           TEXT UNIQUE NOT NULL   -- https://bridge-b.com
name          TEXT
status        TEXT DEFAULT 'active'  -- active|suspended
publicKey     TEXT                   -- PEM (ADR-0006, Sprint 108+)
lastPingAt    BIGINT
createdAt     BIGINT NOT NULL
```

---

### `user_ap_keys`
ActivityPub private key — güvenlik gereği ayrı tablo. AES-256-GCM ile şifreli.  
Erişim: `Users.getApPrivateKey()` — asla direkt SELECT yapma.

```sql
userId           TEXT PRIMARY KEY REFERENCES users(_id) ON DELETE CASCADE
apPrivateKeyEnc  TEXT NOT NULL      -- base64(iv:authTag:ciphertext)
keyVersion       INTEGER DEFAULT 1  -- rotation counter
createdAt        BIGINT NOT NULL
updatedAt        BIGINT NOT NULL
```

---

## Tasarım Kararları

### JSONB vs TEXT for JSON
Sık sorgulanan alanlar (`tags`, `reactions`, `roles`) `JSONB`; sadece saklanıp okunan alanlar (`editHistory`, `embeds`, `bridgedFrom`) `TEXT` (JSON string). JSONB, index ve operatör desteği sunar ama yazma maliyeti yüksek.

### Soft Delete yok
Silinen kayıtlar fiziksel olarak kaldırılır. `message:delete` atom transaction içinde çalışır: thread cascade + unread counter güncelleme.

### Timestamp olarak BIGINT
Tüm zaman alanları Unix millisecond (`BIGINT`). Timezone karmaşasını önler; JavaScript ile doğrudan uyumlu.

### İndeks Stratejisi
Her yüksek-trafik tablo için `WHERE` / `ORDER BY` alanlarına index. Kanal listesi, mesaj sayfalaması ve üyelik sorguları kritik yol — bu üçünün index'i zorunlu.

---

## Migration Geçmişi

Detaylar için → [`server/db/migrations_pg/README.md`](../server/db/migrations_pg/README.md)

| Migration | Açıklama |
|-----------|----------|
| 001 | client_error_events tablosu |
| 002 | refresh_token reuse detection (`family`, `usedAt`) |
| 003-004 | DM readAt, Canvas depolama |
| 005 | Rozetler + Keşif güçlendirmesi |
| 006 | `apPrivateKey` → `user_ap_keys` (güvenlik izolasyonu) |
| 007 | `user_badges` tablosu |
| 008 | AP key AES-256-GCM şifreleme |
| 009 | Plaintext AP key kolonu kaldırıldı |
| 010 | Bot marketplace tabloları |
| 011 | Boost, vanity URL, OAuth bağlantıları |
| 012 | Kanal takip sistemi |
| 013 | Sunucu etkinlikleri tablosu |

---

## Yeni Tablo Ekleme Rehberi

1. `server/db/postgres/schema.sql` güncelle
2. `server/db/migrations_pg/NNN_aciklayici_isim.sql` oluştur
3. `server/db/migrations_pg/rollback/NNN_aciklayici_isim.down.sql` rollback yaz
4. Migration README tablosunu güncelle
5. Bu belgeyi güncelle
6. Test DB'de `npm run db:migrate:pg` çalıştır
