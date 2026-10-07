// server/db/postgres/schema.ts
// PostgreSQL CREATE TABLE ve CREATE INDEX ifadeleri
// _initSchema() tarafından kullanılır

// ── SCHEMA ───────────────────────────────────────────────────
// Tüm tablolar IF NOT EXISTS → güvenle tekrar çalıştırılabilir
const SCHEMA = `
CREATE OR REPLACE FUNCTION bridge_valid_totp_secret(value text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT char_length(value) BETWEEN 16 AND 134
     AND value ~ '^[A-Za-z2-7]{16,128}={0,6}$'
$$;
CREATE OR REPLACE FUNCTION bridge_valid_two_factor_backup(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item jsonb; code text;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 32 THEN RETURN FALSE; END IF;
  FOR item IN
    SELECT value_item
    FROM jsonb_array_elements(value) AS items(value_item)
  LOOP
    IF jsonb_typeof(item) <> 'string' THEN RETURN FALSE; END IF;
    code := item #>> '{}';
    IF char_length(code) NOT BETWEEN 8 AND 128 THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
END $$;

CREATE TABLE IF NOT EXISTS users (
  _id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  "displayName" TEXT NOT NULL,
  password TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
  "avatarUrl" TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  "presenceStatus" TEXT NOT NULL DEFAULT 'online'
    CONSTRAINT "users_presenceStatus_check"
    CHECK ("presenceStatus" IN ('online', 'idle', 'dnd', 'offline')),
  -- migrations_pg/026 ile AYNI alan kisiti. Kisit BURADA da olmali:
  -- sutunu bu dosya olusturdugu icin 026'nin ADD COLUMN IF NOT EXISTS
  -- ifadesi hicbir zaman calismiyor ve kisit HIC olusmuyordu. Canli
  -- PostgreSQL'de olculdu: presenceVisibility='Hidden' KABUL EDILIYORDU.
  "presenceVisibility" TEXT NOT NULL DEFAULT 'visible'
    CONSTRAINT "users_presenceVisibility_check"
    CHECK ("presenceVisibility" IN ('visible', 'hidden')),
  bio TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  pronouns TEXT NOT NULL DEFAULT '',
  "bannerColor" TEXT NOT NULL DEFAULT '',
  "bannerUrl" TEXT,
  "statusText" TEXT NOT NULL DEFAULT '',
  "statusEmoji" TEXT NOT NULL DEFAULT '',
  "tokenVersion" INTEGER NOT NULL DEFAULT 0
    CONSTRAINT users_token_version_nonnegative CHECK ("tokenVersion" >= 0),
  "apPublicKey" TEXT,
  email TEXT,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  "emailToken" TEXT,
  "emailTokenExp" BIGINT,
  "twoFactorSecret" TEXT,
  "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "twoFactorBackup" JSONB NOT NULL DEFAULT '[]',
  "twoFactorLastUsedStep" BIGINT,
  "isAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
  -- Migration 055: server-side E2EE public/X3DH bundle material. Private keys
  -- never belong here. JSONB is required for structured signed/one-time keys.
  "e2ePublicKey" TEXT,
  "e2eKeyVersion" INTEGER NOT NULL DEFAULT 1 CONSTRAINT users_e2e_key_version_check CHECK ("e2eKeyVersion" >= 1),
  "e2eAlgorithm" TEXT NOT NULL DEFAULT 'X25519'
    CONSTRAINT users_e2e_algorithm_check CHECK ("e2eAlgorithm" IN ('X25519', 'P-256')),
  "e2eKeyUpdatedAt" BIGINT,
  "x3dhIdentityKey" TEXT,
  "x3dhSignedPreKey" JSONB,
  "x3dhOneTimePreKeys" JSONB NOT NULL DEFAULT '[]'
    CONSTRAINT users_x3dh_otpks_array_check CHECK (jsonb_typeof("x3dhOneTimePreKeys") = 'array'),
  "x3dhUpdatedAt" BIGINT,
  -- migrations_pg/017 ile AYNI (DM gizlilik politikasi) -- KISIT DAHIL.
  -- Yorum eskiden "ayni" diyordu ama CHECK'i atliyordu; 017 de sutun zaten
  -- var oldugu icin hic calismiyordu. Sonuc: alan kisiti HIC yoktu.
  -- NOT: bu bir TS sablon dizesi icinde SQL'dir -- ters tirnak KULLANILAMAZ.
  "dmPrivacy" TEXT NOT NULL DEFAULT 'everyone'
    CONSTRAINT "users_dmPrivacy_check"
    CHECK ("dmPrivacy" IN ('everyone', 'friends', 'none')),
  activity JSONB,
  "activityUpdatedAt" BIGINT,
  "ssoProvider" TEXT,
  "ssoIssuer" TEXT,
  "ssoId" TEXT,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT users_two_factor_state_valid CHECK (
    ("twoFactorLastUsedStep" IS NULL OR "twoFactorLastUsedStep" >= 0)
    AND bridge_valid_two_factor_backup("twoFactorBackup") IS TRUE
    AND (NOT "twoFactorEnabled" OR bridge_valid_totp_secret("twoFactorSecret") IS TRUE)
  ),
  CONSTRAINT users_sso_binding_valid CHECK (
    (("ssoProvider" IS NULL) = ("ssoIssuer" IS NULL))
    AND (("ssoProvider" IS NULL) = ("ssoId" IS NULL))
    AND ("ssoProvider" IS NULL OR "ssoProvider" IN ('oidc', 'saml'))
    AND ("ssoIssuer" IS NULL OR char_length("ssoIssuer") BETWEEN 1 AND 2048)
    AND ("ssoId" IS NULL OR char_length("ssoId") BETWEEN 1 AND 1024)
  )
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_identity_unique
  ON users("ssoProvider", "ssoIssuer", "ssoId") WHERE "ssoProvider" IS NOT NULL;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  "usedAt" BIGINT,
  family TEXT,
  "tokenVersion" INTEGER NOT NULL
    CONSTRAINT refresh_tokens_token_version_nonnegative CHECK ("tokenVersion" >= 0)
);
CREATE INDEX IF NOT EXISTS idx_rt_userId  ON refresh_tokens("userId");
CREATE INDEX IF NOT EXISTS idx_rt_expires ON refresh_tokens("expiresAt");
-- Sprint 10: revokeByFamily. KISMI indeks -- migrations_pg/002 ve 016 ile AYNI.
-- Burasi onceden KOSULSUZ bir indeks olusturuyordu. Bu dosya once kostugu icin
-- 002 ve 016'nin kismi tanimlari IF NOT EXISTS yuzunden HIC uygulanmiyordu:
-- uc kaynaktan IKISININ istedigi bicim uretimde hic olusmuyordu.
-- revokeByFamily daima NOT NULL bir family ile sorgular; kismi bicim hem
-- daha kucuk hem de amaclanan tanimdir.
-- (Bu dosya bir TS sablon dizesidir: ters tirnak KULLANILAMAZ.)
CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family) WHERE family IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_ap_keys (
  "userId" TEXT PRIMARY KEY REFERENCES users(_id) ON DELETE CASCADE,
  "apPrivateKeyEnc" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  _id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🌐',
  "iconUrl" TEXT,
  "bannerUrl" TEXT,
  "ownerId" TEXT NOT NULL,
  discoverable BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]',
  "verificationEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "verificationChannelId" TEXT,
  "verificationRoleId" TEXT,
  "logChannelId" TEXT,
  -- migrations_pg/016 ile aynı
  "mfaLevel" INTEGER NOT NULL DEFAULT 0 CONSTRAINT servers_mfa_level_check CHECK ("mfaLevel" IN (0, 1, 2)),
  -- P7 B1: bounded, reversible anti-raid policy. No per-user trust score.
  "raidMitigationLevel" TEXT NOT NULL DEFAULT 'balanced'
    CONSTRAINT servers_raid_mitigation_level_check CHECK ("raidMitigationLevel" IN ('off', 'balanced', 'strict')),
  "raidLockdownUntil" BIGINT
    CONSTRAINT servers_raid_lockdown_until_nonnegative CHECK ("raidLockdownUntil" IS NULL OR "raidLockdownUntil" >= 0),
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  "featuredAt" BIGINT,
  "vanityUrl" TEXT,
  "ssoConfig" JSONB,
  "createdAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  topic TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'GENERAL',
  "categoryId" TEXT,
  -- BIGINT: sıralama anahtarı Date.now() ile yazılıyor (migrations_pg/020)
  "order" BIGINT NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  -- migrations_pg/018 + 019 ile aynı: kanal oluşturma bu alanları yazıyor
  nsfw INTEGER NOT NULL DEFAULT 0,
  bitrate INTEGER NOT NULL DEFAULT 64000,
  slowmode INTEGER NOT NULL DEFAULT 0 CHECK (slowmode IN (0,5,10,15,30,60,120,300,600,900,1800,3600,7200,21600)),
  "forumTags" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "modOnly" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels("serverId");

CREATE TABLE IF NOT EXISTS messages (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  -- Durable client idempotency key. Per-user unique index prevents duplicate
  -- persistence across ACK loss, reconnect, and backend restart.
  "ackId" TEXT,
  username TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
  -- Sprint 122 FIX: uygulama bu alanı yazıyordu (messages-send.ts) ama şemada yoktu;
  -- yalnızca migrations_pg/016 ekliyordu → temiz kurulumda insert çöküyordu.
  "avatarUrl" TEXT,
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'normal',
  "fileUrl" TEXT,
  "fileName" TEXT,
  "fileType" TEXT,
  sticker JSONB,
  reactions JSONB NOT NULL DEFAULT '{}',
  "superReactions" JSONB NOT NULL DEFAULT '{}',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  "editedAt" BIGINT,
  "editHistory" JSONB NOT NULL DEFAULT '[]',
  "replyTo" JSONB,
  "bridgedFrom" JSONB,
  "scheduledId" TEXT,
  "threadId" TEXT,
  "threadCount" INTEGER NOT NULL DEFAULT 0,
  -- migrations_pg/016 ile aynı alanlar (E2EE + soft delete + embed)
  embeds JSONB,
  "encryptedContent" TEXT,
  iv TEXT,
  "deletedAt" BIGINT,
  "deletedBy" TEXT,
  -- migrations_pg/018 ile aynı: jobs/autoModeration.ts yazıyor ve sorguluyor
  "autoModAlert" BOOLEAN NOT NULL DEFAULT FALSE,
  transcript TEXT,
  "webhookId" TEXT,
  "isWebhook" BOOLEAN NOT NULL DEFAULT FALSE,
  "flaggedMsgId" TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages("channelId");
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages("createdAt");
CREATE INDEX IF NOT EXISTS idx_messages_server  ON messages("serverId");
CREATE INDEX IF NOT EXISTS idx_messages_channel_cursor
  ON messages("channelId", "createdAt" DESC, _id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_file_url_authz ON messages("fileUrl") WHERE "fileUrl" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_ack ON messages("userId", "ackId") WHERE "ackId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_scheduled_id
  ON messages("scheduledId") WHERE "scheduledId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_automod_alert_flagged_msg
  ON messages("flaggedMsgId")
  WHERE "autoModAlert" = TRUE AND "flaggedMsgId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS members (
  "userId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  roles JSONB NOT NULL DEFAULT '[]',
  "joinedAt" BIGINT NOT NULL,
  "timeoutUntil" BIGINT,
  verified BOOLEAN NOT NULL DEFAULT TRUE,
  -- Yasaklama: repository bu alani kullaniyordu ama sutun HIC YOKTU
  -- (bkz. migrations_pg/029). Yasak listesi 500 doneryordu.
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  -- migrations_pg/031: per-server member profile (nickname/bio/avatar/banner)
  "serverProfile" JSONB NOT NULL DEFAULT '{}',
  nickname TEXT,
  PRIMARY KEY("userId", "serverId")
);
CREATE INDEX IF NOT EXISTS idx_members_user   ON members("userId");
CREATE INDEX IF NOT EXISTS idx_members_server ON members("serverId");
CREATE INDEX IF NOT EXISTS idx_members_server_page
  ON members("serverId", "joinedAt" ASC, "userId" ASC);

CREATE TABLE IF NOT EXISTS invites (
  _id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  "serverId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "maxUses" INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

CREATE TABLE IF NOT EXISTS roles (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#99aab5',
  permissions INTEGER NOT NULL DEFAULT 16 CHECK (permissions >= 0 AND permissions <= 1094713343 AND (permissions::bigint & 1094713343::bigint) = permissions::bigint),
  position INTEGER NOT NULL DEFAULT 0,
  -- SUNUM AYARI (yetki DEGILDIR): rolun uye profilinde gosterilip
  -- gosterilmeyecegi. Yalnizca MANAGE_ROLES degistirebilir; izinleri,
  -- hiyerarsiyi veya kanal yetkilendirmesini ETKILEMEZ.
  "displayOnProfile" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles("serverId");

CREATE TABLE IF NOT EXISTS dm_conversations (
  _id TEXT PRIMARY KEY,
  participants JSONB NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "lastMessageAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_messages (
  _id TEXT PRIMARY KEY,
  "dmId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
  content TEXT NOT NULL DEFAULT '',
  "fileUrl" TEXT,
  "fileName" TEXT,
  "fileType" TEXT,
  reactions JSONB NOT NULL DEFAULT '{}',
  e2e BOOLEAN NOT NULL DEFAULT FALSE,
  "clientNonce" TEXT,
  "isEncrypted" BOOLEAN NOT NULL DEFAULT FALSE,
  "e2eData" JSONB,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages("dmId");
CREATE INDEX IF NOT EXISTS idx_dm_messages_ts   ON dm_messages("dmId", "createdAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_messages_client_nonce ON dm_messages("userId", "clientNonce") WHERE "clientNonce" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dm_messages_file_url_authz ON dm_messages("fileUrl") WHERE "fileUrl" IS NOT NULL;

CREATE TABLE IF NOT EXISTS server_gifs (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  "fileType" TEXT NOT NULL DEFAULT 'image/gif',
  "uploadedBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gifs_server ON server_gifs("serverId");

CREATE TABLE IF NOT EXISTS scheduled_msgs (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  username TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
  content TEXT NOT NULL,
  "sendAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  sent BOOLEAN NOT NULL DEFAULT FALSE,
  "sentAt" BIGINT,
  "claimOwner" TEXT,
  "claimUntil" BIGINT,
  "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "failedAt" BIGINT,
  "failureReason" TEXT,
  "cancelledAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sched_sendAt ON scheduled_msgs("sendAt");
CREATE INDEX IF NOT EXISTS idx_sched_dispatch_due
  ON scheduled_msgs(sent, "sendAt", "claimUntil") WHERE sent = FALSE AND "failedAt" IS NULL AND "cancelledAt" IS NULL;

CREATE TABLE IF NOT EXISTS channel_bridges (
  _id TEXT PRIMARY KEY,
  "sourceChannelId" TEXT NOT NULL,
  "targetChannelId" TEXT NOT NULL,
  "sourceServerId" TEXT NOT NULL,
  "targetServerId" TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE ("sourceChannelId", "targetChannelId")
);
CREATE INDEX IF NOT EXISTS idx_bridge_src ON channel_bridges("sourceChannelId");

CREATE TABLE IF NOT EXISTS server_emojis (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emojis_server ON server_emojis("serverId");

CREATE TABLE IF NOT EXISTS polls (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]',
  "multiSelect" BOOLEAN NOT NULL DEFAULT FALSE,
  "allowVoteChange" BOOLEAN NOT NULL DEFAULT TRUE,
  "expiresAt" BIGINT,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_channel ON polls("channelId");

CREATE TABLE IF NOT EXISTS soundboard (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL CONSTRAINT fk_soundboard_server REFERENCES servers(_id) ON DELETE CASCADE,
  name TEXT NOT NULL CONSTRAINT soundboard_name_length CHECK (char_length(name) BETWEEN 1 AND 32),
  emoji TEXT NOT NULL DEFAULT '🔊' CONSTRAINT soundboard_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 32),
  category TEXT NOT NULL DEFAULT 'Server' CONSTRAINT soundboard_category_length CHECK (char_length(category) BETWEEN 1 AND 32),
  url TEXT NOT NULL,
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
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "friendId" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  "createdAt" BIGINT NOT NULL,
  UNIQUE("userId", "friendId")
);
CREATE INDEX IF NOT EXISTS idx_friends_user   ON friendships("userId");
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friendships("friendId");

CREATE TABLE IF NOT EXISTS channel_categories (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cats_server ON channel_categories("serverId");

CREATE TABLE IF NOT EXISTS notification_prefs (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'all' CONSTRAINT notification_prefs_level_check CHECK (level IN ('all', 'mentions', 'mute', 'default')),
  "muteUntil" BIGINT,
  "updatedAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifprefs_user ON notification_prefs("userId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_user_channel_unique
  ON notification_prefs("userId", "channelId");

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
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_logs("serverId");

CREATE TABLE IF NOT EXISTS voice_messages (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  url TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  transcript TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vm_channel ON voice_messages("channelId");

CREATE TABLE IF NOT EXISTS threads (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  -- Forum konularinda ust mesaj YOKTUR (kanal kokli); bu yuzden nullable.
  "parentMessageId" TEXT,
  name TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "lastMessageAt" BIGINT NOT NULL,
  "messageCount" INTEGER NOT NULL DEFAULT 0,
  "firstMessage" TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]',
  "participantCount" INTEGER NOT NULL DEFAULT 1,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  locked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads("channelId");
CREATE INDEX IF NOT EXISTS idx_threads_parent  ON threads("parentMessageId");

CREATE TABLE IF NOT EXISTS thread_messages (
  _id TEXT PRIMARY KEY,
  "threadId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientNonce" TEXT,
  username TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'normal',
  reactions JSONB NOT NULL DEFAULT '{}',
  "editedAt" BIGINT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tmsg_thread  ON thread_messages("threadId");
CREATE INDEX IF NOT EXISTS idx_tmsg_created ON thread_messages("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS uq_thread_messages_delivery_nonce ON thread_messages("threadId", "userId", "clientNonce") WHERE "clientNonce" IS NOT NULL;

CREATE TABLE IF NOT EXISTS bots (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  username TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  "tokenHash" TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  permissions INTEGER NOT NULL DEFAULT 256,
  "webhookUrl" TEXT,
  events JSONB NOT NULL DEFAULT '[]',
  "isPublic" BOOLEAN NOT NULL DEFAULT FALSE,
  category TEXT NOT NULL DEFAULT 'utility',
  icon TEXT,
  "contextCommands" JSONB NOT NULL DEFAULT '[]',
  "slashCommands" JSONB NOT NULL DEFAULT '[]',
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_server ON bots("serverId");

CREATE TABLE IF NOT EXISTS webhooks (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  name TEXT NOT NULL,
  secret TEXT,
  token TEXT,
  "avatarUrl" TEXT,
  "createdBy" TEXT,
  "createdAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_overrides (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT channel_overrides_masks_valid CHECK (allow >= 0 AND deny >= 0 AND allow <= 1094713343 AND deny <= 1094713343 AND (allow::bigint & 1094713343::bigint) = allow::bigint AND (deny::bigint & 1094713343::bigint) = deny::bigint AND (allow::bigint & deny::bigint) = 0)
);
CREATE INDEX IF NOT EXISTS idx_ovr_channel ON channel_overrides("channelId");

CREATE TABLE IF NOT EXISTS unread_counts (
  "userId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  PRIMARY KEY ("userId", "channelId")
);

-- P1 chat read-position owner. Kept separate from unread_counts because the
-- latter is an attention/notification counter, not a chronological read cursor.
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
-- Migration 071: the PK leads with "userId", so ON DELETE CASCADE from channels
-- scanned this table once per deleted channel (measured, F21-11-02).
CREATE INDEX IF NOT EXISTS idx_channel_read_positions_channel
  ON channel_read_positions("channelId");

CREATE TABLE IF NOT EXISTS push_subscriptions (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  keys JSONB NOT NULL DEFAULT '{}',
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions("userId");

CREATE TABLE IF NOT EXISTS native_push_tokens (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  token TEXT UNIQUE NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_nativepush_user ON native_push_tokens("userId");

CREATE TABLE IF NOT EXISTS federation_peers (
  _id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  "desc" TEXT NOT NULL DEFAULT '',
  "addedAt" BIGINT NOT NULL,
  "lastSeen" BIGINT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS admin_logs (
  _id TEXT PRIMARY KEY,
  "adminId" TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adminlogs_admin ON admin_logs("adminId");

-- Full-Text Search (PostgreSQL native)
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- idx_messages_fts: superseded by migrations_pg/027 (idx_messages_fts_unaccent);
-- not created here any more (P5 SH-04, see migration 076).
CREATE INDEX IF NOT EXISTS idx_messages_trgm ON messages USING GIN(content gin_trgm_ops);
CREATE TABLE IF NOT EXISTS uploads (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  "originalName" TEXT NOT NULL DEFAULT '',
  "mimeType" TEXT NOT NULL DEFAULT '',
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_userId ON uploads("userId");
CREATE INDEX IF NOT EXISTS idx_uploads_key    ON uploads(key);

-- ── Announcement follows / durable crossposts ───────────────────
-- migrations_pg/012 + 033 ile aynı. Crosspost mesajı socket-only değil;
-- messages tablosuna transaction içinde persist edilir ve bu log idempotency
-- anahtarı olarak kullanılır.
CREATE TABLE IF NOT EXISTS channel_follows (
  _id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceChannelId" TEXT NOT NULL,
  "sourceServerId" TEXT NOT NULL,
  "targetChannelId" TEXT NOT NULL,
  "targetServerId" TEXT NOT NULL,
  "followedAt" BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  "followedByUserId" TEXT NOT NULL,
  UNIQUE("sourceChannelId","targetChannelId")
);
CREATE INDEX IF NOT EXISTS idx_channel_follows_source ON channel_follows("sourceChannelId");
CREATE INDEX IF NOT EXISTS idx_channel_follows_target ON channel_follows("targetChannelId");

CREATE TABLE IF NOT EXISTS crosspost_log (
  _id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "messageId" TEXT NOT NULL,
  "sourceChannelId" TEXT NOT NULL,
  "sourceServerId" TEXT NOT NULL,
  "targetChannelId" TEXT NOT NULL,
  "targetServerId" TEXT NOT NULL,
  "bridgeMessageId" TEXT NOT NULL UNIQUE,
  "crosspostedAt" BIGINT NOT NULL,
  UNIQUE("messageId","targetChannelId")
);
CREATE INDEX IF NOT EXISTS idx_crosspost_log_source ON crosspost_log("messageId","sourceChannelId");
CREATE INDEX IF NOT EXISTS idx_crosspost_log_target ON crosspost_log("targetChannelId","crosspostedAt" DESC);

-- ── Podcast (migrations_pg/032 ile aynı) ───────────────────────
-- Runtime owner PodcastRepository kanal-scoped çalışır. Eski inline şema
-- server-scoped kaldığı için temiz PostgreSQL kurulumunda özellik kırılıyordu.
CREATE TABLE IF NOT EXISTS podcast_settings (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT,
  "serverId" TEXT,
  title TEXT,
  description TEXT,
  author TEXT,
  "imageUrl" TEXT,
  "coverUrl" TEXT,
  language TEXT NOT NULL DEFAULT 'tr',
  category TEXT NOT NULL DEFAULT 'Technology',
  explicit BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_podcast_settings_channel ON podcast_settings("channelId") WHERE "channelId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS podcast_episodes (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT,
  "serverId" TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  filename TEXT,
  "audioUrl" TEXT,
  "mimeType" TEXT NOT NULL DEFAULT 'audio/mpeg',
  "fileSize" BIGINT NOT NULL DEFAULT 0,
  "durationSeconds" INTEGER,
  season INTEGER,
  episode INTEGER,
  published BOOLEAN NOT NULL DEFAULT TRUE,
  "publishedAt" BIGINT,
  "createdBy" TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_channel ON podcast_episodes("channelId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_published ON podcast_episodes("channelId", published, "publishedAt" DESC);

-- ── Sticker paketleri (migrations_pg/021 ile aynı) ────────────
-- Paketler süreç-içi bir Map'te tutuluyordu; yeniden başlatmada kayboluyordu.
-- seq: DAHİLİ, ekleme sırasını belirlenimci kılar. createdAt tek başına
-- yeterli değildir — aynı milisaniyede iki paket oluşturulabilir. API'ye
-- SIZDIRILMAZ. (Not: bu blok bir JS template literal içindedir; ters tırnak
-- kullanılamaz.)
CREATE TABLE IF NOT EXISTS sticker_packs (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  "authorId" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  seq BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_sticker_packs_server ON sticker_packs("serverId", seq);

-- position: DAHİLİ, yükleme sırasını korur. API'ye SIZDIRILMAZ.
-- serverId sütunu YOKTUR: her sticker işlemi önce (packId + serverId) ile
-- çözülen bir pakete bağlanır, dolayısıyla sorguda hiç kullanılmazdı.
CREATE TABLE IF NOT EXISTS sticker_pack_items (
  _id TEXT PRIMARY KEY,
  "packId" TEXT NOT NULL REFERENCES sticker_packs(_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  width INTEGER NOT NULL DEFAULT 160,
  height INTEGER NOT NULL DEFAULT 160,
  position INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_pack_items("packId", position);

-- ── Server Events (migrations_pg/013 + canonical closure 037) ─────────────
-- Channel-bound event visibility is enforced by the route/repository contract;
-- the DB ownership here exists on clean installs as well as upgraded databases.
CREATE TABLE IF NOT EXISTS server_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  server_id TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  creator_id TEXT REFERENCES users(_id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description TEXT CHECK (char_length(description) <= 1000),
  location TEXT CHECK (char_length(location) <= 200),
  channel_id TEXT REFERENCES channels(_id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','ended','cancelled')),
  cover_image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT server_events_ends_after_starts CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_server_events_server_id ON server_events(server_id);
CREATE INDEX IF NOT EXISTS idx_server_events_starts_at ON server_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_server_events_status ON server_events(status);

CREATE TABLE IF NOT EXISTS server_event_rsvp (
  event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('interested','going','not_going')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_server_event_rsvp_event ON server_event_rsvp(event_id);
CREATE INDEX IF NOT EXISTS idx_server_event_rsvp_user ON server_event_rsvp(user_id);

-- ── Personal Saved / Follow-up (migrations_pg/025) ───────────
-- Yalnız kanonik kimlikler saklanır; metadata API okumasında yeniden
-- yetkilendirilir.
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

-- ── Outgoing webhooks ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outgoing_webhooks (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '["message:new"]',
  secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "lastFiredAt" BIGINT,
  "lastStatus" INTEGER,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastFailedAt" BIGINT,
  "lastError" TEXT
);
CREATE INDEX IF NOT EXISTS idx_ogwh_server ON outgoing_webhooks("serverId");

-- ── Outgoing webhook durable delivery queue ──────────────────
CREATE TABLE IF NOT EXISTS outgoing_webhook_deliveries (
  _id TEXT PRIMARY KEY,
  "webhookId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "claimOwner" TEXT,
  "claimUntil" BIGINT,
  "lastError" TEXT
);
CREATE INDEX IF NOT EXISTS idx_ogwh_delivery_due
  ON outgoing_webhook_deliveries("nextAt", "claimUntil");
CREATE INDEX IF NOT EXISTS idx_ogwh_delivery_webhook
  ON outgoing_webhook_deliveries("webhookId", "createdAt");


-- ── Instance federation key material ───────────────────────────
CREATE TABLE IF NOT EXISTS server_federation_keys (
  _id TEXT PRIMARY KEY DEFAULT 'instance',
  "publicKeyPem" TEXT NOT NULL,
  "privateKeyEnc" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" BIGINT NOT NULL,
  "rotatedAt" BIGINT
);

-- ── User badges ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_badges (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  badge TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  "awardedAt" BIGINT NOT NULL,
  "awardedBy" TEXT,
  UNIQUE ("userId", badge)
);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges("userId");

-- ── ActivityPub activity journal ───────────────────────────────
-- Inbound rows use targetUserId; outbound/C2S rows use actorUserId. Those
-- identities are intentionally nullable alternatives, not simultaneous NOT NULLs.
CREATE TABLE IF NOT EXISTS ap_activities (
  _id TEXT PRIMARY KEY,
  "targetUserId" TEXT,
  "actorUserId" TEXT,
  "actorUrl" TEXT,
  type TEXT,
  "activityId" TEXT,
  "noteId" TEXT,
  activity JSONB NOT NULL DEFAULT '{}',
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  "processedAt" BIGINT,
  "claimOwner" TEXT,
  "claimUntil" BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "publishedAt" BIGINT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_activities_actor ON ap_activities("actorUserId");
CREATE INDEX IF NOT EXISTS idx_ap_activities_target ON ap_activities("targetUserId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON ap_activities(type);
CREATE INDEX IF NOT EXISTS idx_ap_activities_activity_id ON ap_activities("activityId") WHERE "activityId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_activities_inbound_unique
  ON ap_activities("targetUserId", "actorUrl", "activityId")
  WHERE "targetUserId" IS NOT NULL AND "actorUrl" IS NOT NULL AND "activityId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ap_activities_claim
  ON ap_activities(processed, "claimUntil") WHERE processed = FALSE;

-- ── ActivityPub received messages ─────────────────────────────
-- Must exist in the canonical fresh schema BEFORE inline ALTER migrations run.
-- visibility is an audience boundary, not a presentation hint.
CREATE TABLE IF NOT EXISTS ap_messages (
  _id TEXT PRIMARY KEY,
  "actorUrl" TEXT NOT NULL,
  "channelId" TEXT,
  content TEXT NOT NULL DEFAULT '',
  "apId" TEXT UNIQUE,
  "targetUserId" TEXT,
  summary TEXT,
  sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  "inReplyTo" TEXT,
  attachments JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  published BIGINT,
  "updatedAt" BIGINT,
  visibility TEXT NOT NULL DEFAULT 'public'
    CONSTRAINT ap_messages_visibility_check CHECK (visibility IN ('public', 'direct')),
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_messages_actor ON ap_messages("actorUrl");
CREATE INDEX IF NOT EXISTS idx_ap_messages_published ON ap_messages(published DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_ap_messages_visibility_actor ON ap_messages(visibility, "actorUrl", published DESC NULLS LAST);

-- ── ActivityPub follow/like/announce side effects ─────────────
CREATE TABLE IF NOT EXISTS ap_outgoing_follows (
  _id TEXT PRIMARY KEY,
  "fromUserId" TEXT NOT NULL,
  "targetActorUrl" TEXT NOT NULL,
  "activityId" TEXT,
  accepted BOOLEAN NOT NULL DEFAULT FALSE,
  "acceptedAt" BIGINT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_outfollows_user ON ap_outgoing_follows("fromUserId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_outfollows_unique ON ap_outgoing_follows("fromUserId", "targetActorUrl");

CREATE TABLE IF NOT EXISTS ap_likes (
  _id TEXT PRIMARY KEY,
  "actorUrl" TEXT,
  "fromUserId" TEXT,
  "activityId" TEXT,
  "objectUrl" TEXT NOT NULL,
  "targetUserId" TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_likes_object ON ap_likes("objectUrl");
CREATE INDEX IF NOT EXISTS idx_ap_likes_activity_actor_target ON ap_likes("actorUrl", "activityId", "targetUserId") WHERE "activityId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS ap_announces (
  _id TEXT PRIMARY KEY,
  "actorUrl" TEXT,
  "fromUserId" TEXT,
  "activityId" TEXT,
  "objectUrl" TEXT NOT NULL,
  "targetUserId" TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_announces_object ON ap_announces("objectUrl");
CREATE INDEX IF NOT EXISTS idx_ap_announces_activity_actor_target ON ap_announces("actorUrl", "activityId", "targetUserId") WHERE "activityId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  type TEXT NOT NULL,
  "actorUrl" TEXT,
  "activityId" TEXT,
  "noteId" TEXT,
  "noteUrl" TEXT,
  "dmId" TEXT,
  "serverId" TEXT,
  "channelId" TEXT,
  "messageId" TEXT,
  "actorId" TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_activity ON notifications("activityId") WHERE "activityId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_inbox_message ON notifications("userId", "messageId") WHERE "messageId" IS NOT NULL AND type IN ('mention', 'reply', 'watch');
CREATE INDEX IF NOT EXISTS idx_notifications_inbox_unread ON notifications("userId", read, "createdAt" DESC) WHERE type IN ('mention', 'reply', 'watch');
CREATE INDEX IF NOT EXISTS idx_notifications_inbox_channel ON notifications("userId", "channelId", read) WHERE "channelId" IS NOT NULL AND type IN ('mention', 'reply', 'watch');

-- ── ActivityPub durable delivery queue ───────────────────────
CREATE TABLE IF NOT EXISTS ap_delivery_queue (
  _id TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "claimOwner" TEXT,
  "claimUntil" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_apqueue_nextat ON ap_delivery_queue("nextAt");
CREATE INDEX IF NOT EXISTS idx_apqueue_claim_due
  ON ap_delivery_queue("nextAt", "claimUntil");

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
-- Migration 071: ON DELETE CASCADE from messages scanned this table once per
-- deleted message (measured: 100 000 messages x 20 000 reports ~104 s -> ~2.4 s).
CREATE INDEX IF NOT EXISTS idx_message_reports_message
  ON message_reports("messageId");


-- P1 Saved follow-up reminders. Delivery state is separate from the saved item
-- so a reminder can be scheduled, delivered and later rescheduled safely.
ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS "remindAt" BIGINT;
ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS "remindedAt" BIGINT;
CREATE INDEX IF NOT EXISTS idx_saved_messages_due_reminder
  ON saved_messages("remindAt", _id)
  WHERE "remindAt" IS NOT NULL AND "remindedAt" IS NULL;

`;

export { SCHEMA };
