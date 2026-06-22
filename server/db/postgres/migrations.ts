// @ts-nocheck
// server/db/postgres/migrations.ts
// Inline migration runner — schema kurulduktan sonra çalışır.
// Her migration IF NOT EXISTS / ADD COLUMN IF NOT EXISTS ile idempotent.
// Üretim DB'lere eski sürümlerden gelen eksik sütunları güvenle ekler.
//
// YENİ MIGRATION EKLEMEK:
//   1. SQL'i COLUMN_MIGRATIONS veya EXTRA_TABLES dizisine ekle.
//   2. Her zaman idempotent (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) yaz.
//   3. Yapısal değişiklik için migrations_pg/ altına numaralı dosya aç.
//   4. Ek TypeScript sabitleri gerekiyorsa migrations_pg/NNN_..._inline.ts yaz
//      ve import'u bu dosyanın BAŞINA ekle (diğer import'larla birlikte).

import { Pool } from 'pg';
import logger from '../../lib/logger';
import { BOT_MARKETPLACE_TABLES } from '../../migrations_pg/010_bot_marketplace_inline';

// ── KOLON / INDEX MIGRASYONLARI ─────────────────────────────
// Mevcut production DB'lere eksik sütunları ekler.
const COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "apPublicKey" TEXT`,
  // Extension'lar
  `CREATE EXTENSION IF NOT EXISTS unaccent`,
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,

  // FTS index'leri (unaccent ile)
  `CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN(
    to_tsvector('simple', coalesce(content,'') || ' ' || coalesce("displayName",''))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_trgm ON messages USING GIN(content gin_trgm_ops)`,

  // dm_messages — reactions, e2e alanları
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'`,
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS e2e BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "isEncrypted" BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "e2eData" JSONB`,

  // push_subscriptions — subscription JSONB → endpoint + keys ayrı sütunlar
  `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS endpoint TEXT`,
  `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS keys JSONB DEFAULT '{}'`,
  `UPDATE push_subscriptions SET endpoint = subscription->>'endpoint', keys = subscription->'keys' WHERE endpoint IS NULL AND subscription IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint)`,
  `CREATE INDEX IF NOT EXISTS idx_nativepush_user ON native_push_tokens("userId")`,
  `CREATE INDEX IF NOT EXISTS idx_dm_messages_ts ON dm_messages("dmId", "createdAt" DESC)`,

  // audit_logs ek kolonlar
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "channelId" TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "old" JSONB`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "new" JSONB`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'`,
  `CREATE INDEX IF NOT EXISTS idx_audit_server_channel ON audit_logs("serverId", "channelId")`,

  // messages ek kolonlar
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS components JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "botId" TEXT`,

  // bots ek kolonlar
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'utility'`,
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS icon TEXT`,
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS "contextCommands" JSONB NOT NULL DEFAULT '[]'`,

  // ap_follows ek kolonlar
  `ALTER TABLE ap_follows ADD COLUMN IF NOT EXISTS accepted BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE ap_follows ADD COLUMN IF NOT EXISTS "actorInbox" TEXT`,

  // ap_messages ek kolonlar
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "targetUserId" TEXT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS summary TEXT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS sensitive BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "inReplyTo" TEXT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS published BIGINT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "updatedAt" BIGINT`,
  `CREATE INDEX IF NOT EXISTS idx_ap_messages_actor ON ap_messages("actorUrl")`,
  `CREATE INDEX IF NOT EXISTS idx_ap_messages_published ON ap_messages(published DESC NULLS LAST)`,

  // ap_activities ek kolonlar
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "actorUserId" TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS type TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "activityId" TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "noteId" TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "publishedAt" BIGINT`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_actor ON ap_activities("actorUserId")`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON ap_activities(type)`,
];

// ── EK TABLOLAR (v40-v78+ arasında eklenenler) ──────────────
const EXTRA_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS user_ap_keys (
    "userId" TEXT PRIMARY KEY REFERENCES users(_id) ON DELETE CASCADE,
    "apPrivateKeyEnc" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_permissions (
    _id TEXT PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    allow INTEGER NOT NULL DEFAULT 0,
    deny INTEGER NOT NULL DEFAULT 0,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT,
    UNIQUE("channelId", "roleId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chperms_channel ON channel_permissions("channelId")`,

  `CREATE TABLE IF NOT EXISTS group_dm_conversations (
    _id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    "ownerId" TEXT NOT NULL,
    icon TEXT,
    "createdAt" BIGINT NOT NULL,
    "lastMessageAt" BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_dm_members (
    _id TEXT PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" BIGINT NOT NULL,
    UNIQUE("groupId", "userId")
  )`,
  `CREATE TABLE IF NOT EXISTS group_dm_messages (
    _id TEXT PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
    content TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'normal',
    "fileUrl" TEXT,
    "fileName" TEXT,
    reactions JSONB NOT NULL DEFAULT '{}',
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gdm_messages_group ON group_dm_messages("groupId", "createdAt" DESC)`,

  `CREATE TABLE IF NOT EXISTS reaction_roles (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    emoji TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    UNIQUE("messageId", emoji, "roleId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rr_message ON reaction_roles("messageId")`,

  `CREATE TABLE IF NOT EXISTS blocks (
    _id TEXT PRIMARY KEY,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    UNIQUE("blockerId", "blockedId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks("blockerId")`,

  `CREATE TABLE IF NOT EXISTS user_connections (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL,
    UNIQUE("userId", platform)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_connections_user ON user_connections("userId")`,

  `CREATE TABLE IF NOT EXISTS fcm_tokens (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    platform TEXT NOT NULL DEFAULT 'android',
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fcmtokens_user ON fcm_tokens("userId")`,

  `CREATE TABLE IF NOT EXISTS bot_ratings (
    _id TEXT PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    rating INTEGER NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT,
    UNIQUE("botId", "userId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_botratings_bot ON bot_ratings("botId")`,

  `CREATE TABLE IF NOT EXISTS server_bots (
    _id TEXT PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "addedAt" BIGINT NOT NULL,
    UNIQUE("botId", "serverId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_serverbots_server ON server_bots("serverId")`,

  `CREATE TABLE IF NOT EXISTS outgoing_webhooks (
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
    "lastStatus" INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ogwh_server ON outgoing_webhooks("serverId")`,

  `CREATE TABLE IF NOT EXISTS server_onboarding (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    "rulesChannelId" TEXT,
    "welcomeChannelId" TEXT,
    "welcomeMessage" TEXT NOT NULL DEFAULT 'Sunucuya hoş geldin, {user}! 👋',
    "verificationLevel" INTEGER NOT NULL DEFAULT 0,
    "defaultRoles" JSONB NOT NULL DEFAULT '[]',
    questions JSONB NOT NULL DEFAULT '[]',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS onboarding_completions (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "completedAt" BIGINT NOT NULL,
    answers JSONB NOT NULL DEFAULT '{}',
    UNIQUE("serverId", "userId")
  )`,

  `CREATE TABLE IF NOT EXISTS automod_rules (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    type TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_automod_server ON automod_rules("serverId")`,

  `CREATE TABLE IF NOT EXISTS ap_follows (
    _id TEXT PRIMARY KEY,
    "actorUrl" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "activityId" TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_apfollows_target ON ap_follows("targetUserId")`,

  `CREATE TABLE IF NOT EXISTS ap_activities (
    _id TEXT PRIMARY KEY,
    "targetUserId" TEXT NOT NULL,
    activity JSONB NOT NULL DEFAULT '{}',
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ap_messages (
    _id TEXT PRIMARY KEY,
    "actorUrl" TEXT NOT NULL,
    "channelId" TEXT,
    content TEXT NOT NULL DEFAULT '',
    "apId" TEXT UNIQUE,
    "createdAt" BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ap_outgoing_follows (
    _id TEXT PRIMARY KEY,
    "fromUserId" TEXT NOT NULL,
    "targetActorUrl" TEXT NOT NULL,
    "activityId" TEXT,
    accepted BOOLEAN NOT NULL DEFAULT FALSE,
    "acceptedAt" BIGINT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_outfollows_user ON ap_outgoing_follows("fromUserId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_outfollows_unique ON ap_outgoing_follows("fromUserId", "targetActorUrl")`,

  `CREATE TABLE IF NOT EXISTS ap_likes (
    _id TEXT PRIMARY KEY,
    "actorUrl" TEXT,
    "fromUserId" TEXT,
    "objectUrl" TEXT NOT NULL,
    "targetUserId" TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_likes_object ON ap_likes("objectUrl")`,

  `CREATE TABLE IF NOT EXISTS ap_announces (
    _id TEXT PRIMARY KEY,
    "actorUrl" TEXT,
    "fromUserId" TEXT,
    "objectUrl" TEXT NOT NULL,
    "targetUserId" TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_announces_object ON ap_announces("objectUrl")`,

  `CREATE TABLE IF NOT EXISTS notifications (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    type TEXT NOT NULL,
    "actorUrl" TEXT,
    "noteId" TEXT,
    "noteUrl" TEXT,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications("userId", "createdAt" DESC)`,

  `CREATE TABLE IF NOT EXISTS webauthn_credentials (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL UNIQUE,
    "publicKey" TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    "deviceType" TEXT NOT NULL DEFAULT 'unknown',
    transports JSONB NOT NULL DEFAULT '[]',
    name TEXT NOT NULL DEFAULT 'Passkey',
    "lastUsedAt" BIGINT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials("userId")`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_cred ON webauthn_credentials("credentialId")`,

  `CREATE TABLE IF NOT EXISTS link_preview_cache (
    url TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    "fetchedAt" BIGINT NOT NULL,
    "expiresAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lpcache_expires ON link_preview_cache("expiresAt")`,

  `CREATE TABLE IF NOT EXISTS federation_whitelist (
    _id TEXT PRIMARY KEY,
    domain TEXT UNIQUE NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS federation_blacklist (
    _id TEXT PRIMARY KEY,
    domain TEXT UNIQUE NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    "createdAt" BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ap_delivery_queue (
    _id TEXT PRIMARY KEY,
    payload JSONB NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0,
    "nextAt" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_apqueue_nextat ON ap_delivery_queue("nextAt")`,

  `CREATE TABLE IF NOT EXISTS podcast_settings (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    "coverUrl" TEXT,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS podcast_episodes (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    "audioUrl" TEXT NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0,
    "publishedAt" BIGINT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_podcast_episodes_server ON podcast_episodes("serverId", "createdAt" DESC)`,

  `CREATE TABLE IF NOT EXISTS server_templates (
    _id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "isBuiltin" BOOLEAN NOT NULL DEFAULT FALSE,
    config JSONB NOT NULL DEFAULT '{}',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT
  )`,
  // Sprint 83: Bot Marketplace tabloları
  ...BOT_MARKETPLACE_TABLES,
];

// ── RUNNER ───────────────────────────────────────────────────
async function runMigrationList(pool: Pool, sqls: string[], label: string): Promise<void> {
  for (const sql of sqls) {
    try {
      await pool.query(sql);
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes('already exists') && !msg.includes('does not exist')) {
        logger.warn({ event: 'db.migration.warn', label }, `[DB] ${label} uyarısı: ${msg.slice(0, 120)}`);
      }
    }
  }
}

export async function runInlineMigrations(pool: Pool): Promise<void> {
  await runMigrationList(pool, COLUMN_MIGRATIONS, 'column-migration');
  await runMigrationList(pool, EXTRA_TABLES, 'extra-table');
}
