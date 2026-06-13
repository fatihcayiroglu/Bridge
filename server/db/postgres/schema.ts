// server/db/postgres/schema.ts
// PostgreSQL CREATE TABLE ve CREATE INDEX ifadeleri
// _initSchema() tarafından kullanılır

// ── SCHEMA ───────────────────────────────────────────────────
// Tüm tablolar IF NOT EXISTS → güvenle tekrar çalıştırılabilir
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  _id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  "displayName" TEXT NOT NULL,
  password TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
  "avatarUrl" TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  bio TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  pronouns TEXT NOT NULL DEFAULT '',
  "bannerColor" TEXT NOT NULL DEFAULT '',
  "bannerUrl" TEXT,
  "statusText" TEXT NOT NULL DEFAULT '',
  "statusEmoji" TEXT NOT NULL DEFAULT '',
  "tokenVersion" INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  "emailToken" TEXT,
  "emailTokenExp" BIGINT,
  "twoFactorSecret" TEXT,
  "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "twoFactorBackup" JSONB NOT NULL DEFAULT '[]',
  "isAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  "usedAt" BIGINT,
  family TEXT
);
CREATE INDEX IF NOT EXISTS idx_rt_userId  ON refresh_tokens("userId");
CREATE INDEX IF NOT EXISTS idx_rt_expires ON refresh_tokens("expiresAt");
CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family);  -- Sprint 10: revokeByFamily

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
  "createdAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  topic TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'GENERAL',
  "categoryId" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels("serverId");

CREATE TABLE IF NOT EXISTS messages (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  username TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'normal',
  "fileUrl" TEXT,
  "fileName" TEXT,
  "fileType" TEXT,
  reactions JSONB NOT NULL DEFAULT '{}',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  "editedAt" BIGINT,
  "editHistory" JSONB NOT NULL DEFAULT '[]',
  "replyTo" JSONB,
  "bridgedFrom" JSONB,
  "scheduledId" TEXT,
  "threadId" TEXT,
  "threadCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages("channelId");
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages("createdAt");
CREATE INDEX IF NOT EXISTS idx_messages_server  ON messages("serverId");

CREATE TABLE IF NOT EXISTS members (
  "userId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  roles JSONB NOT NULL DEFAULT '[]',
  "joinedAt" BIGINT NOT NULL,
  "timeoutUntil" BIGINT,
  verified BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY("userId", "serverId")
);
CREATE INDEX IF NOT EXISTS idx_members_user   ON members("userId");
CREATE INDEX IF NOT EXISTS idx_members_server ON members("serverId");

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
  permissions INTEGER NOT NULL DEFAULT 16,
  position INTEGER NOT NULL DEFAULT 0,
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
  "isEncrypted" BOOLEAN NOT NULL DEFAULT FALSE,
  "e2eData" JSONB,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages("dmId");
CREATE INDEX IF NOT EXISTS idx_dm_messages_ts   ON dm_messages("dmId", "createdAt" DESC);

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
  "sentAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sched_sendAt ON scheduled_msgs("sendAt");

CREATE TABLE IF NOT EXISTS channel_bridges (
  _id TEXT PRIMARY KEY,
  "sourceChannelId" TEXT NOT NULL,
  "targetChannelId" TEXT NOT NULL,
  "sourceServerId" TEXT NOT NULL,
  "targetServerId" TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
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
  "expiresAt" BIGINT,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_channel ON polls("channelId");

CREATE TABLE IF NOT EXISTS soundboard (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🔊',
  url TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_soundboard_server ON soundboard("serverId");

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
  level TEXT NOT NULL DEFAULT 'all',
  "updatedAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifprefs_user ON notification_prefs("userId");

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
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vm_channel ON voice_messages("channelId");

CREATE TABLE IF NOT EXISTS threads (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "parentMessageId" TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "lastMessageAt" BIGINT NOT NULL,
  "messageCount" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads("channelId");
CREATE INDEX IF NOT EXISTS idx_threads_parent  ON threads("parentMessageId");

CREATE TABLE IF NOT EXISTS thread_messages (
  _id TEXT PRIMARY KEY,
  "threadId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
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
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_server ON bots("serverId");

CREATE TABLE IF NOT EXISTS webhooks (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_overrides (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN(
  to_tsvector('simple', coalesce(content,'') || ' ' || coalesce("displayName",''))
);
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
`;

export { SCHEMA };
