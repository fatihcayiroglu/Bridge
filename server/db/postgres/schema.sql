-- ⚠️  BU DOSYA ÇALIŞTIRILMIYOR — SOURCE OF TRUTH DEĞİLDİR.
--
-- Çalışma zamanında şemayı kuran yol:
--   db/postgres/schema.ts  (SCHEMA sabiti)  → initSchema()
--   db/postgres/migrations.ts (inline ALTER'lar)
--   db/migrations_pg/*.sql (numaralı migration'lar)
--
-- Bu dosya ayrı/eski bir soydan geliyor ve 27 ortak tabloda çalışan şemayla
-- ÇELİŞİYOR (örn. dm_messages.conversationId↔dmId, friendships.requesterId↔userId,
-- channels.categoryId burada yok). Yeni kurulum için referans alınmamalıdır.
-- Şema değişikliği yaparken schema.ts + migrations_pg güncellenir.
--
-- server/db/postgres/schema.sql
-- SQLite'daki tüm tabloların PostgreSQL karşılığı.
-- TEXT PRIMARY KEY → TEXT, INTEGER → BIGINT, JSON sütunlar → JSONB

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  _id          TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  "displayName" TEXT NOT NULL,
  password     TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  "avatarUrl"  TEXT,
  status       TEXT NOT NULL DEFAULT 'offline',
  "presenceVisibility" TEXT NOT NULL DEFAULT 'visible',
  bio          TEXT NOT NULL DEFAULT '',
  website      TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  pronouns     TEXT NOT NULL DEFAULT '',
  "bannerColor" TEXT NOT NULL DEFAULT '',
  "bannerUrl"  TEXT,
  "tokenVersion" BIGINT NOT NULL DEFAULT 0,
  "createdAt"  BIGINT NOT NULL,
  "apPublicKey"  TEXT
  -- apPrivateKey bu tabloda YOK: migration 006 ile user_ap_keys tablosuna taşındı.
  -- Şifreli olarak saklanır; erişim için Users.getApPrivateKey() kullanın.
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ActivityPub private key — ayrı tablo, uygulama katmanında AES-256-GCM ile şifreli
-- Anahtar: AP_ENCRYPTION_KEY env değişkeni (32-byte hex, zorunlu FEDERATION_ENABLED=true ise)
CREATE TABLE IF NOT EXISTS user_ap_keys (
  "userId"           TEXT PRIMARY KEY REFERENCES users(_id) ON DELETE CASCADE,
  "apPrivateKeyEnc"  TEXT NOT NULL,  -- AES-256-GCM şifreli: base64(iv:authTag:ciphertext)
  "keyVersion"       INTEGER NOT NULL DEFAULT 1,
  "createdAt"        BIGINT NOT NULL,
  "updatedAt"        BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token      TEXT PRIMARY KEY,
  "userId"   TEXT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  used       SMALLINT NOT NULL DEFAULT 0,
  "usedAt"   BIGINT,
  family     TEXT,
  "tokenVersion" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rt_userId   ON refresh_tokens("userId");
CREATE INDEX IF NOT EXISTS idx_rt_expires  ON refresh_tokens("expiresAt");
-- Sprint 121 FIX: family bazlı iptal (revokeByFamily) için bileşik index
CREATE INDEX IF NOT EXISTS idx_rt_family   ON refresh_tokens(family) WHERE family IS NOT NULL;
-- Sprint 121 FIX: süresi dolmuş + kullanılmış cleanup job için bileşik index
CREATE INDEX IF NOT EXISTS idx_rt_cleanup  ON refresh_tokens(used, "usedAt") WHERE used = 1;

CREATE TABLE IF NOT EXISTS servers (
  _id          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  icon         TEXT NOT NULL DEFAULT '🌐',
  "bannerUrl"  TEXT,
  "iconUrl"    TEXT,
  "ownerId"    TEXT NOT NULL,
  discoverable BOOLEAN NOT NULL DEFAULT FALSE,
  description  TEXT NOT NULL DEFAULT '',
  tags         JSONB NOT NULL DEFAULT '[]',
  -- Sprint 121 FIX 15: Sunucu bazında 2FA zorunluluğu (0=kapalı, 1=moderatörler, 2=herkes)
  "mfaLevel"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  _id          TEXT PRIMARY KEY,
  "serverId"   TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'text',
  topic        TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'GENERAL',
  "order"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"  BIGINT NOT NULL,
  "slowmode"   INTEGER NOT NULL DEFAULT 0,
  "isNSFW"     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels("serverId");

CREATE TABLE IF NOT EXISTS messages (
  _id          TEXT PRIMARY KEY,
  "channelId"  TEXT NOT NULL,
  "serverId"   TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "ackId"      TEXT,
  username     TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  "avatarUrl"  TEXT,
  content      TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'normal',
  "fileUrl"    TEXT,
  "fileName"   TEXT,
  "fileSize"   BIGINT,
  "fileMime"   TEXT,
  reactions    JSONB NOT NULL DEFAULT '{}',
  "replyTo"    JSONB,
  pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  "editHistory" JSONB NOT NULL DEFAULT '[]',
  "editedAt"   BIGINT,
  "bridgedFrom" JSONB,
  embeds       JSONB,
  -- Sprint 89: E2EE mesajları için şifreli içerik alanları
  "encryptedContent" TEXT,
  iv           TEXT,
  -- Sprint 121 FIX 17: Soft delete için audit alanları
  "deletedAt"  BIGINT,
  "deletedBy"  TEXT,
  "createdAt"  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_channel   ON messages("channelId");
CREATE INDEX IF NOT EXISTS idx_msg_channel_ts ON messages("channelId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_msg_user      ON messages("userId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_ack ON messages("userId", "ackId") WHERE "ackId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_content_fts ON messages USING gin(to_tsvector('simple', content));

CREATE TABLE IF NOT EXISTS members (
  _id        TEXT PRIMARY KEY,
  "userId"   TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "joinedAt" BIGINT NOT NULL,
  nickname   TEXT,
  roles      JSONB NOT NULL DEFAULT '[]',
  UNIQUE("userId", "serverId")
);
CREATE INDEX IF NOT EXISTS idx_members_server ON members("serverId");
CREATE INDEX IF NOT EXISTS idx_members_user   ON members("userId");

CREATE TABLE IF NOT EXISTS invites (
  _id        TEXT PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  "serverId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  "maxUses"  INTEGER,
  "expiresAt" BIGINT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

CREATE TABLE IF NOT EXISTS roles (
  _id        TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#99aab5',
  permissions BIGINT NOT NULL DEFAULT 0,
  hoist      BOOLEAN NOT NULL DEFAULT FALSE,
  "displayOnProfile" BOOLEAN NOT NULL DEFAULT TRUE,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles("serverId");

CREATE TABLE IF NOT EXISTS dm_conversations (
  _id          TEXT PRIMARY KEY,
  participants JSONB NOT NULL DEFAULT '[]',
  "createdAt"  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_messages (
  _id           TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL,
  "senderId"    TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  "fileUrl"     TEXT,
  "fileName"    TEXT,
  reactions     JSONB NOT NULL DEFAULT '{}',
  "createdAt"   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages("conversationId");
CREATE INDEX IF NOT EXISTS idx_dm_messages_ts   ON dm_messages("conversationId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS server_gifs (
  _id        TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  "addedBy"  TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sgifs_server ON server_gifs("serverId");

CREATE TABLE IF NOT EXISTS scheduled_msgs (
  _id         TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId"  TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  content     TEXT NOT NULL,
  "fileUrl"   TEXT,
  "scheduledAt" BIGINT NOT NULL,
  sent        BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_channel ON scheduled_msgs("channelId");
CREATE INDEX IF NOT EXISTS idx_sched_time    ON scheduled_msgs("scheduledAt") WHERE sent = FALSE;

CREATE TABLE IF NOT EXISTS channel_bridges (
  _id           TEXT PRIMARY KEY,
  "channelId"   TEXT NOT NULL,
  "targetServer" TEXT NOT NULL,
  "targetChannel" TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_emojis (
  _id        TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  "addedBy"  TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  UNIQUE("serverId", name)
);
CREATE INDEX IF NOT EXISTS idx_emojis_server ON server_emojis("serverId");

CREATE TABLE IF NOT EXISTS polls (
  _id         TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId"  TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  question    TEXT NOT NULL,
  options     JSONB NOT NULL DEFAULT '[]',
  "multiSelect" BOOLEAN NOT NULL DEFAULT FALSE,
  "expiresAt" BIGINT,
  closed      BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_channel ON polls("channelId");

CREATE TABLE IF NOT EXISTS soundboard (
  _id        TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL CONSTRAINT fk_soundboard_server REFERENCES servers(_id) ON DELETE CASCADE,
  name       TEXT NOT NULL CONSTRAINT soundboard_name_length CHECK (char_length(name) BETWEEN 1 AND 32),
  emoji      TEXT NOT NULL DEFAULT '🔊' CONSTRAINT soundboard_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 32),
  category   TEXT NOT NULL DEFAULT 'Server' CONSTRAINT soundboard_category_length CHECK (char_length(category) BETWEEN 1 AND 32),
  url        TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "durationSeconds" DOUBLE PRECISION CONSTRAINT soundboard_duration_bounds CHECK ("durationSeconds" > 0 AND "durationSeconds" <= 5),
  "mimeType" TEXT,
  "fileSize" BIGINT CONSTRAINT soundboard_file_size_bounds CHECK ("fileSize" IS NULL OR ("fileSize" > 0 AND "fileSize" <= 5242880)),
  "updatedAt" BIGINT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_soundboard_server ON soundboard("serverId");
CREATE INDEX IF NOT EXISTS idx_soundboard_server_page ON soundboard("serverId", "createdAt" DESC, _id DESC);
CREATE INDEX IF NOT EXISTS idx_soundboard_server_name ON soundboard("serverId", lower(name));

CREATE TABLE IF NOT EXISTS soundboard_user_stats (
  "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  "soundId" TEXT NOT NULL,
  "serverId" TEXT REFERENCES servers(_id) ON DELETE CASCADE,
  favorite BOOLEAN NOT NULL DEFAULT FALSE,
  "favoritedAt" BIGINT,
  "playCount" BIGINT NOT NULL DEFAULT 0 CHECK ("playCount" >= 0),
  "lastPlayedAt" BIGINT,
  PRIMARY KEY ("userId", "soundId"),
  CONSTRAINT soundboard_stats_favorite_time CHECK (favorite = ("favoritedAt" IS NOT NULL)),
  CONSTRAINT soundboard_stats_play_time CHECK (("playCount" = 0) = ("lastPlayedAt" IS NULL)),
  CONSTRAINT soundboard_stats_scope CHECK (("serverId" IS NULL AND "soundId" LIKE 'global:%') OR ("serverId" IS NOT NULL AND "soundId" NOT LIKE 'global:%'))
);
CREATE INDEX IF NOT EXISTS idx_soundboard_stats_favorites ON soundboard_user_stats("userId", "favoritedAt" DESC, "soundId" DESC) WHERE favorite = TRUE;
CREATE INDEX IF NOT EXISTS idx_soundboard_stats_recent ON soundboard_user_stats("userId", "lastPlayedAt" DESC, "soundId" DESC) WHERE "playCount" > 0;
CREATE INDEX IF NOT EXISTS idx_soundboard_stats_frequent ON soundboard_user_stats("userId", "playCount" DESC, "lastPlayedAt" DESC, "soundId" DESC) WHERE "playCount" > 0;

CREATE TABLE IF NOT EXISTS friendships (
  _id         TEXT PRIMARY KEY,
  "requesterId" TEXT NOT NULL,
  "addresseeId" TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  "createdAt" BIGINT NOT NULL,
  UNIQUE("requesterId", "addresseeId")
);
CREATE INDEX IF NOT EXISTS idx_friends_requester ON friendships("requesterId");
CREATE INDEX IF NOT EXISTS idx_friends_addressee ON friendships("addresseeId");

CREATE TABLE IF NOT EXISTS channel_categories (
  _id        TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name       TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cat_server ON channel_categories("serverId");

CREATE TABLE IF NOT EXISTS notification_prefs (
  _id        TEXT PRIMARY KEY,
  "userId"   TEXT NOT NULL,
  "serverId" TEXT,
  "channelId" TEXT,
  muted      BOOLEAN NOT NULL DEFAULT FALSE,
  level      TEXT NOT NULL DEFAULT 'all',
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notification_prefs("userId");

CREATE TABLE IF NOT EXISTS notification_keywords (
  "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  "serverId" TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  PRIMARY KEY ("userId", "serverId", keyword),
  CONSTRAINT notification_keywords_length CHECK (char_length(keyword) BETWEEN 2 AND 32)
);
CREATE INDEX IF NOT EXISTS idx_notification_keywords_match
  ON notification_keywords("serverId", keyword);

CREATE TABLE IF NOT EXISTS audit_logs (
  _id          TEXT PRIMARY KEY,
  "serverId"   TEXT NOT NULL,
  "channelId"  TEXT,
  "actorId"    TEXT NOT NULL DEFAULT '',
  "actorName"  TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL,
  "targetId"   TEXT,
  "targetName" TEXT,
  "old"        JSONB,
  "new"        JSONB,
  extra        JSONB NOT NULL DEFAULT '{}',
  detail       TEXT NOT NULL DEFAULT '',
  "createdAt"  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_server  ON audit_logs("serverId");
CREATE INDEX IF NOT EXISTS idx_audit_ts      ON audit_logs("serverId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_audit_channel ON audit_logs("serverId", "channelId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS voice_messages (
  _id         TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId"  TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  url         TEXT NOT NULL,
  duration    FLOAT,
  waveform    TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vmsg_channel ON voice_messages("channelId");

CREATE TABLE IF NOT EXISTS threads (
  _id               TEXT PRIMARY KEY,
  "channelId"       TEXT NOT NULL,
  "serverId"        TEXT NOT NULL,
  "createdBy"       TEXT NOT NULL,
  title             TEXT NOT NULL,
  "firstMessage"    TEXT NOT NULL DEFAULT '',
  "participantCount" INTEGER NOT NULL DEFAULT 1,
  tags              JSONB NOT NULL DEFAULT '[]',
  pinned            BOOLEAN NOT NULL DEFAULT FALSE,
  locked            BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads("channelId");

CREATE TABLE IF NOT EXISTS thread_messages (
  _id          TEXT PRIMARY KEY,
  "threadId"   TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "clientNonce" TEXT,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  content      TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'normal',
  "fileUrl"    TEXT,
  reactions    JSONB NOT NULL DEFAULT '{}',
  "createdAt"  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tmsg_thread ON thread_messages("threadId");
CREATE INDEX IF NOT EXISTS idx_tmsg_ts     ON thread_messages("threadId", "createdAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_thread_messages_delivery_nonce ON thread_messages("threadId", "userId", "clientNonce") WHERE "clientNonce" IS NOT NULL;

CREATE TABLE IF NOT EXISTS bots (
  _id         TEXT PRIMARY KEY,
  "ownerId"   TEXT NOT NULL,
  username    TEXT UNIQUE NOT NULL,
  "displayName" TEXT NOT NULL,
  token       TEXT UNIQUE NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  "avatarUrl" TEXT,
  bio         TEXT NOT NULL DEFAULT '',
  "isPublic"  BOOLEAN NOT NULL DEFAULT FALSE,
  permissions BIGINT NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots("ownerId");

CREATE TABLE IF NOT EXISTS webhooks (
  _id        TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId"  TEXT NOT NULL,
  name        TEXT NOT NULL,
  token       TEXT UNIQUE NOT NULL,
  "avatarUrl" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks("channelId");

CREATE TABLE IF NOT EXISTS channel_overrides (
  _id         TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "roleId"    TEXT,
  "userId"    TEXT,
  allow       BIGINT NOT NULL DEFAULT 0,
  deny        BIGINT NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_overrides_channel ON channel_overrides("channelId");

CREATE TABLE IF NOT EXISTS unread_counts (
  _id         TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  "lastRead"  BIGINT NOT NULL DEFAULT 0,
  UNIQUE("userId", "channelId")
);
CREATE INDEX IF NOT EXISTS idx_unread_user ON unread_counts("userId");

CREATE TABLE IF NOT EXISTS channel_read_positions (
  "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  "channelId" TEXT NOT NULL REFERENCES channels(_id) ON DELETE CASCADE,
  "lastReadAt" BIGINT NOT NULL,
  "lastReadMessageId" TEXT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  PRIMARY KEY ("userId", "channelId")
);
CREATE INDEX IF NOT EXISTS idx_channel_read_positions_user
  ON channel_read_positions("userId", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  _id        TEXT PRIMARY KEY,
  "userId"   TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  keys       JSONB NOT NULL DEFAULT '{}',
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions("userId");

CREATE TABLE IF NOT EXISTS federation_peers (
  _id          TEXT PRIMARY KEY,
  url          TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  "lastSeen"   BIGINT,
  "createdAt"  BIGINT NOT NULL,
  -- ADR-0006 Faz 1 (Sprint 107): per-peer RSA-2048 public key (PEM)
  -- Nullable — mevcut peer'lar etkilenmez; Sprint 108'de imza doğrulamasında kullanılacak.
  "publicKey"  TEXT
);

CREATE TABLE IF NOT EXISTS server_federation_keys (
  _id             TEXT PRIMARY KEY DEFAULT 'instance',
  "publicKeyPem"  TEXT NOT NULL,
  "privateKeyEnc" TEXT NOT NULL,
  "keyVersion"    INTEGER NOT NULL DEFAULT 1,
  "createdAt"     BIGINT NOT NULL,
  "rotatedAt"     BIGINT
);

CREATE TABLE IF NOT EXISTS admin_logs (
  _id        TEXT PRIMARY KEY,
  "adminId"  TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  meta       JSONB NOT NULL DEFAULT '{}',
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_ts ON admin_logs("createdAt" DESC);

CREATE TABLE IF NOT EXISTS channel_permissions (
  _id         TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "roleId"    TEXT,
  "userId"    TEXT,
  allow       BIGINT NOT NULL DEFAULT 0,
  deny        BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cperm_channel ON channel_permissions("channelId");

CREATE TABLE IF NOT EXISTS fcm_tokens (
  _id        TEXT PRIMARY KEY,
  "userId"   TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fcm_user ON fcm_tokens("userId");

CREATE TABLE IF NOT EXISTS bot_ratings (
  _id        TEXT PRIMARY KEY,
  "botId"    TEXT NOT NULL,
  "userId"   TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 5,
  "createdAt" BIGINT NOT NULL,
  UNIQUE("botId", "userId")
);

CREATE TABLE IF NOT EXISTS server_bots (
  _id        TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "botId"    TEXT NOT NULL,
  "addedBy"  TEXT NOT NULL,
  "addedAt"  BIGINT NOT NULL,
  UNIQUE("serverId", "botId")
);
CREATE INDEX IF NOT EXISTS idx_sbots_server ON server_bots("serverId");

CREATE TABLE IF NOT EXISTS ap_follows (
  _id           TEXT PRIMARY KEY,
  "actorUrl"    TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "activityId"  TEXT UNIQUE NOT NULL,
  "createdAt"   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apf_target ON ap_follows("targetUserId");

CREATE TABLE IF NOT EXISTS ap_activities (
  _id           TEXT PRIMARY KEY,
  "actorUserId" TEXT,
  "targetUserId" TEXT,
  type          TEXT NOT NULL,
  "activityId"  TEXT UNIQUE,
  activity      JSONB NOT NULL DEFAULT '{}',
  "publishedAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apa_actor  ON ap_activities("actorUserId");
CREATE INDEX IF NOT EXISTS idx_apa_target ON ap_activities("targetUserId");
CREATE INDEX IF NOT EXISTS idx_apa_type   ON ap_activities(type);

CREATE TABLE IF NOT EXISTS ap_messages (
  _id           TEXT PRIMARY KEY,
  "fromUserId"  TEXT,
  "toUserId"    TEXT,
  "channelId"   TEXT,
  "activityId"  TEXT UNIQUE,
  content       TEXT NOT NULL DEFAULT '',
  "remoteAuthor" TEXT,
  "createdAt"   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apm_channel ON ap_messages("channelId");

CREATE TABLE IF NOT EXISTS reaction_roles (
  _id        TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  "roleId"   TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rr_server ON reaction_roles("serverId");

CREATE TABLE IF NOT EXISTS blocks (
  _id          TEXT PRIMARY KEY,
  "blockerId"  TEXT NOT NULL,
  "blockedId"  TEXT NOT NULL,
  "createdAt"  BIGINT NOT NULL,
  UNIQUE("blockerId", "blockedId")
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks("blockerId");

CREATE TABLE IF NOT EXISTS user_connections (
  _id        TEXT PRIMARY KEY,
  "userId"   TEXT NOT NULL,
  platform   TEXT NOT NULL,
  handle     TEXT NOT NULL,
  verified   BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL,
  UNIQUE("userId", platform)
);
CREATE INDEX IF NOT EXISTS idx_uc_user ON user_connections("userId");

CREATE TABLE IF NOT EXISTS group_dm_conversations (
  _id        TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  "ownerId"  TEXT NOT NULL,
  "iconUrl"  TEXT,
  "createdAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_dm_members (
  _id       TEXT PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "userId"  TEXT NOT NULL,
  "joinedAt" BIGINT NOT NULL,
  "readAt" BIGINT,
  UNIQUE("groupId", "userId")
);
CREATE INDEX IF NOT EXISTS idx_gdm_members_group ON group_dm_members("groupId");
CREATE INDEX IF NOT EXISTS idx_gdm_members_user  ON group_dm_members("userId");
CREATE INDEX IF NOT EXISTS idx_gdm_members_unread_cursor ON group_dm_members("userId", "groupId", "readAt");

CREATE TABLE IF NOT EXISTS group_dm_messages (
  _id          TEXT PRIMARY KEY,
  "groupId"    TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  content      TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'normal',
  "fileUrl"    TEXT,
  "fileName"   TEXT,
  reactions    JSONB NOT NULL DEFAULT '{}',
  "clientNonce" TEXT,
  "createdAt"  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gdm_messages_group ON group_dm_messages("groupId");
CREATE INDEX IF NOT EXISTS idx_gdm_messages_ts    ON group_dm_messages("groupId", "createdAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gdm_messages_client_nonce ON group_dm_messages("userId", "clientNonce") WHERE "clientNonce" IS NOT NULL;

CREATE TABLE IF NOT EXISTS automod_rules (
  _id        TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  type       TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  config     JSONB NOT NULL DEFAULT '{}',
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_automod_server ON automod_rules("serverId");

CREATE TABLE IF NOT EXISTS outgoing_webhooks (
  _id          TEXT PRIMARY KEY,
  "serverId"   TEXT NOT NULL,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  events       JSONB NOT NULL DEFAULT '["message:new"]',
  secret       TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  "createdBy"  TEXT NOT NULL,
  "createdAt"  BIGINT NOT NULL,
  "lastFiredAt" BIGINT,
  "lastStatus" INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ogwh_server ON outgoing_webhooks("serverId");

CREATE TABLE IF NOT EXISTS server_onboarding (
  _id                TEXT PRIMARY KEY,
  "serverId"         TEXT NOT NULL UNIQUE,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  "rulesChannelId"   TEXT,
  "welcomeChannelId" TEXT,
  "welcomeMessage"   TEXT NOT NULL DEFAULT 'Sunucuya hoş geldin, {user}! 👋',
  "verificationLevel" INTEGER NOT NULL DEFAULT 0,
  "defaultRoles"     JSONB NOT NULL DEFAULT '[]',
  questions          JSONB NOT NULL DEFAULT '[]',
  "createdAt"        BIGINT NOT NULL,
  "updatedAt"        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_onboarding_server ON server_onboarding("serverId");

CREATE TABLE IF NOT EXISTS onboarding_completions (
  _id          TEXT PRIMARY KEY,
  "serverId"   TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "completedAt" BIGINT NOT NULL,
  answers      JSONB NOT NULL DEFAULT '{}',
  UNIQUE("serverId", "userId")
);


-- ══════════════════════════════════════════════════════════════════
-- v65: Podcast / Stage Yayınlama
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS podcast_settings (
  _id           TEXT PRIMARY KEY,
  "channelId"   TEXT NOT NULL UNIQUE,
  title         TEXT,
  description   TEXT,
  author        TEXT,
  "imageUrl"    TEXT,
  language      TEXT NOT NULL DEFAULT 'tr',
  category      TEXT NOT NULL DEFAULT 'Technology',
  explicit      BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_podcast_settings_channel ON podcast_settings("channelId");

CREATE TABLE IF NOT EXISTS podcast_episodes (
  _id               TEXT PRIMARY KEY,
  "channelId"       TEXT NOT NULL,
  "serverId"        TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  filename          TEXT,
  "audioUrl"        TEXT,
  "mimeType"        TEXT NOT NULL DEFAULT 'audio/mpeg',
  "fileSize"        BIGINT NOT NULL DEFAULT 0,
  "durationSeconds" INTEGER,
  season            INTEGER,
  episode           INTEGER,
  published         BOOLEAN NOT NULL DEFAULT TRUE,
  "publishedAt"     BIGINT NOT NULL,
  "createdBy"       TEXT NOT NULL,
  "createdAt"       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_podcast_eps_channel   ON podcast_episodes("channelId");
CREATE INDEX IF NOT EXISTS idx_podcast_eps_published ON podcast_episodes("channelId", published);

-- ══════════════════════════════════════════════════════════════════
-- v65: Federation ACL (Whitelist / Blacklist)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS federation_whitelist (
  _id         TEXT PRIMARY KEY,
  domain      TEXT NOT NULL UNIQUE,
  reason      TEXT,
  "addedAt"   BIGINT NOT NULL,
  "addedBy"   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fed_whitelist_domain ON federation_whitelist(domain);

CREATE TABLE IF NOT EXISTS federation_blacklist (
  _id         TEXT PRIMARY KEY,
  domain      TEXT NOT NULL UNIQUE,
  reason      TEXT,
  "addedAt"   BIGINT NOT NULL,
  "addedBy"   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fed_blacklist_domain ON federation_blacklist(domain);

COMMIT;

-- ══════════════════════════════════════════════════════════════════
-- v67: WebAuthn Credentials
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  _id            TEXT PRIMARY KEY,
  "userId"       TEXT NOT NULL,
  "credentialId" TEXT NOT NULL UNIQUE,
  "publicKey"    TEXT NOT NULL,
  counter        BIGINT NOT NULL DEFAULT 0,
  "deviceType"   TEXT NOT NULL DEFAULT 'unknown',
  "transports"   JSONB NOT NULL DEFAULT '[]',
  name           TEXT NOT NULL DEFAULT 'Passkey',
  "lastUsedAt"   BIGINT,
  "createdAt"    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials("userId");
CREATE INDEX IF NOT EXISTS idx_webauthn_cred ON webauthn_credentials("credentialId");

-- ══════════════════════════════════════════════════════════════════
-- v67: E2EE fields on users & dm_messages
-- ══════════════════════════════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2ePublicKey"   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eKeyVersion"  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eAlgorithm"   TEXT NOT NULL DEFAULT 'X25519';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eKeyUpdatedAt" BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhIdentityKey" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhSignedPreKey" JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhOneTimePreKeys" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhUpdatedAt" BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_e2e_key_version_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_e2e_key_version_check CHECK ("e2eKeyVersion" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_e2e_algorithm_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_e2e_algorithm_check CHECK ("e2eAlgorithm" IN ('X25519', 'P-256'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_x3dh_otpks_array_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_x3dh_otpks_array_check CHECK (jsonb_typeof("x3dhOneTimePreKeys") = 'array');
  END IF;
END $$;

ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "isEncrypted" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "e2eData"     JSONB;

-- ══════════════════════════════════════════════════════════════════
-- v70: SSO & Plugin
-- ══════════════════════════════════════════════════════════════════
ALTER TABLE users    ADD COLUMN IF NOT EXISTS "ssoProvider" TEXT;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS "ssoIssuer"   TEXT;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS "ssoId"       TEXT;
UPDATE users
   SET "ssoIssuer" = 'legacy:' || "ssoProvider"
 WHERE "ssoProvider" IS NOT NULL AND "ssoId" IS NOT NULL AND "ssoIssuer" IS NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_sso_binding_valid;
ALTER TABLE users ADD CONSTRAINT users_sso_binding_valid CHECK (
  (("ssoProvider" IS NULL) = ("ssoIssuer" IS NULL))
  AND (("ssoProvider" IS NULL) = ("ssoId" IS NULL))
  AND ("ssoProvider" IS NULL OR "ssoProvider" IN ('oidc', 'saml'))
  AND ("ssoIssuer" IS NULL OR char_length("ssoIssuer") BETWEEN 1 AND 2048)
  AND ("ssoId" IS NULL OR char_length("ssoId") BETWEEN 1 AND 1024)
);
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname = 'idx_users_sso_identity_unique'
       AND indexdef NOT LIKE '%"ssoIssuer"%'
  ) THEN
    DROP INDEX idx_users_sso_identity_unique;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_identity_unique
  ON users("ssoProvider", "ssoIssuer", "ssoId") WHERE "ssoProvider" IS NOT NULL;
ALTER TABLE servers  ADD COLUMN IF NOT EXISTS "ssoConfig"   JSONB;

-- ══════════════════════════════════════════════════════════════════
-- Tables present only in migrations — added here for clean installs
-- (ap_outgoing_follows, ap_likes, ap_announces, ap_delivery_queue,
--  notifications, native_push_tokens, server_templates, user_badges)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ap_outgoing_follows (
  _id              TEXT PRIMARY KEY,
  "fromUserId"     TEXT NOT NULL,
  "targetActorUrl" TEXT NOT NULL,
  "activityId"     TEXT,
  accepted         BOOLEAN NOT NULL DEFAULT FALSE,
  "acceptedAt"     BIGINT,
  "createdAt"      BIGINT NOT NULL
);
CREATE INDEX        IF NOT EXISTS idx_ap_outfollows_user   ON ap_outgoing_follows("fromUserId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_outfollows_unique ON ap_outgoing_follows("fromUserId", "targetActorUrl");

CREATE TABLE IF NOT EXISTS ap_likes (
  _id            TEXT PRIMARY KEY,
  "actorUrl"     TEXT,
  "fromUserId"   TEXT,
  "activityId"   TEXT,
  "objectUrl"    TEXT NOT NULL,
  "targetUserId" TEXT,
  "createdAt"    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_likes_object ON ap_likes("objectUrl");
CREATE INDEX IF NOT EXISTS idx_ap_likes_activity_actor_target ON ap_likes("actorUrl", "activityId", "targetUserId") WHERE "activityId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS ap_announces (
  _id            TEXT PRIMARY KEY,
  "actorUrl"     TEXT,
  "fromUserId"   TEXT,
  "activityId"   TEXT,
  "objectUrl"    TEXT NOT NULL,
  "targetUserId" TEXT,
  "createdAt"    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_announces_object ON ap_announces("objectUrl");
CREATE INDEX IF NOT EXISTS idx_ap_announces_activity_actor_target ON ap_announces("actorUrl", "activityId", "targetUserId") WHERE "activityId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS ap_delivery_queue (
  _id        TEXT PRIMARY KEY,
  payload    JSONB   NOT NULL DEFAULT '{}',
  attempts   INTEGER NOT NULL DEFAULT 0,
  "nextAt"   BIGINT  NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apqueue_nextat ON ap_delivery_queue("nextAt");

CREATE TABLE IF NOT EXISTS notifications (
  _id        TEXT PRIMARY KEY,
  "userId"   TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  "actorUrl" TEXT,
  "activityId" TEXT,
  "noteId"   TEXT,
  "noteUrl"  TEXT,
  "dmId"     TEXT,
  "serverId" TEXT,
  "channelId" TEXT,
  "messageId" TEXT,
  "actorId" TEXT,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_activity ON notifications("activityId") WHERE "activityId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_inbox_message ON notifications("userId", "messageId") WHERE "messageId" IS NOT NULL AND type IN ('mention', 'reply', 'watch');
CREATE INDEX IF NOT EXISTS idx_notifications_inbox_unread ON notifications("userId", read, "createdAt" DESC) WHERE type IN ('mention', 'reply', 'watch');
CREATE INDEX IF NOT EXISTS idx_notifications_inbox_channel ON notifications("userId", "channelId", read) WHERE "channelId" IS NOT NULL AND type IN ('mention', 'reply', 'watch');

CREATE TABLE IF NOT EXISTS native_push_tokens (
  _id        TEXT PRIMARY KEY,
  "userId"   TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT 'unknown',
  token      TEXT UNIQUE NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_nativepush_user ON native_push_tokens("userId");

CREATE TABLE IF NOT EXISTS server_templates (
  _id          TEXT PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  "createdBy"  TEXT    NOT NULL,
  "isBuiltin"  BOOLEAN NOT NULL DEFAULT FALSE,
  config       JSONB   NOT NULL DEFAULT '{}',
  "createdAt"  BIGINT  NOT NULL,
  "updatedAt"  BIGINT
);

CREATE TABLE IF NOT EXISTS user_badges (
  _id         TEXT PRIMARY KEY,
  "userId"    TEXT   NOT NULL,
  badge       TEXT   NOT NULL,
  label       TEXT   NOT NULL DEFAULT '',
  icon        TEXT   NOT NULL DEFAULT '',
  "awardedAt" BIGINT NOT NULL,
  "awardedBy" TEXT   DEFAULT NULL,
  UNIQUE ("userId", badge)
);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges("userId");

-- ── Sprint 93: Boost Ekonomisi ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS server_boosts (
  _id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "serverId"   TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  "userId"     TEXT NOT NULL,
  "boostedAt"  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  "expiresAt"  BIGINT,
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_boosts_server ON server_boosts("serverId", active);
CREATE INDEX IF NOT EXISTS idx_boosts_user   ON server_boosts("userId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_boosts_user_server ON server_boosts("userId","serverId") WHERE active = TRUE;

-- ── Sprint 93: Vanity URL ────────────────────────────────────────────────────
ALTER TABLE servers ADD COLUMN IF NOT EXISTS "vanityUrl"  TEXT UNIQUE;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS "boostCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS "boostTier"  INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_vanity ON servers("vanityUrl") WHERE "vanityUrl" IS NOT NULL;

-- ── Sprint 93: Spotify OAuth ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_tokens (
  _id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"      TEXT NOT NULL,
  platform      TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "refreshToken" TEXT,
  "expiresAt"   BIGINT,
  scope         TEXT,
  "createdAt"   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  UNIQUE("userId", platform)
);
CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_tokens("userId");

-- ── Sprint 94: Announcement Channel Follow/Crosspost ─────────────────────────
CREATE TABLE IF NOT EXISTS channel_follows (
  _id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceChannelId" TEXT NOT NULL,   -- announcement kanalı (kaynak)
  "sourceServerId"  TEXT NOT NULL,
  "targetChannelId" TEXT NOT NULL,   -- hedef sunucudaki kanal
  "targetServerId"  TEXT NOT NULL,
  "followedAt"      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  "followedByUserId" TEXT NOT NULL,
  UNIQUE("sourceChannelId","targetChannelId")
);
CREATE INDEX IF NOT EXISTS idx_channel_follows_source ON channel_follows("sourceChannelId");
CREATE INDEX IF NOT EXISTS idx_channel_follows_target ON channel_follows("targetChannelId");

-- ── Personal Saved / Follow-up (migrations_pg/025) ──────────────────────────
CREATE TABLE IF NOT EXISTS saved_messages (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "destinationType" TEXT NOT NULL CHECK ("destinationType" IN ('channel', 'dm', 'gdm')),
  "destinationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_messages_owner_target ON saved_messages("userId", "destinationType", "messageId");
CREATE INDEX IF NOT EXISTS idx_saved_messages_owner_created ON saved_messages("userId", "createdAt" DESC, _id DESC);

-- P1 moderation: durable, duplicate-safe user message reports.
CREATE TABLE IF NOT EXISTS message_reports (
  _id          TEXT PRIMARY KEY,
  "serverId"  TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  "channelId" TEXT NOT NULL REFERENCES channels(_id) ON DELETE CASCADE,
  "messageId" TEXT NOT NULL REFERENCES messages(_id) ON DELETE CASCADE,
  "reporterId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  "createdAt" BIGINT NOT NULL,
  "resolvedAt" BIGINT,
  "resolvedBy" TEXT REFERENCES users(_id) ON DELETE SET NULL,
  resolution   TEXT,
  CHECK (reason IN ('spam','harassment','hate','sexual','violence','other')),
  CHECK (status IN ('open','resolved','dismissed')),
  CHECK (resolution IS NULL OR resolution IN ('resolved','dismissed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reports_open_unique
  ON message_reports("reporterId", "messageId") WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_message_reports_server_open
  ON message_reports("serverId", status, "createdAt" DESC, _id DESC);
CREATE INDEX IF NOT EXISTS idx_message_reports_channel_open
  ON message_reports("channelId", status, "createdAt" DESC, _id DESC);

-- P1 Saved follow-up reminders. Delivery state is separate from the saved item
-- so a reminder can be scheduled, delivered and later rescheduled safely.
ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS "remindAt" BIGINT;
ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS "remindedAt" BIGINT;
CREATE INDEX IF NOT EXISTS idx_saved_messages_due_reminder
  ON saved_messages("remindAt", _id)
  WHERE "remindAt" IS NOT NULL AND "remindedAt" IS NULL;
