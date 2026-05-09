// @ts-nocheck
// server/db/postgres/index.js
// PostgreSQL adapter — bağlantı havuzu, FTS, schema init, db export
// SQLite db/index.js ile birebir aynı API → drop-in replacement

'use strict';

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const { SCHEMA } = require('./schema');
const { buildWhere, JSONB_COLS, PgCollection: Collection } = require('./collection');

// ── BAĞLANTI ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:              process.env.PG_POOL_MAX   ? parseInt(process.env.PG_POOL_MAX)   : 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[DB] PostgreSQL pool hatası:', err.message);
});



// ── FTS (Full-Text Search) — Gelişmiş ────────────────────────
//
// Strateji (en iyiden fallback'e):
//   1. websearch_to_tsquery  → "merhaba dünya" -hariç +zorunlu gibi Discord-benzeri syntax
//   2. to_tsquery prefix     → kısmi kelime (merhab:* → merhaba eşleşir)
//   3. pg_trgm similarity    → typo toleransı (meraba → merhaba)
//   4. ILIKE                 → son çare fallback
//
// Skor hesabı:
//   ts_rank_cd: konum ağırlıklı rank (başta geçen → yüksek skor)
//   similarity bonus: trigram benzerliği skora eklenir
//   recency bonus: son 7 günlük mesajlara +0.1 bonus
//
async function ftsSearch(queryText, serverIds, limit = 50) {
  if (!queryText?.trim() || !serverIds?.length) return [];

  const q = queryText.trim();

  // ── 1. websearch_to_tsquery (tam özellikli arama) ─────────
  try {
    const { rows } = await pool.query(`
      SELECT m.*,
        ts_rank_cd(
          to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",''))),
          websearch_to_tsquery('simple', unaccent($2)),
          32  -- normalizasyon: belge uzunluğuna göre böl
        )
        + CASE WHEN m."createdAt" > (extract(epoch from now()-interval '7 days')*1000)::bigint
               THEN 0.1 ELSE 0 END
        AS _score
      FROM messages m
      WHERE m."serverId" = ANY($1)
        AND to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
            @@ websearch_to_tsquery('simple', unaccent($2))
      ORDER BY _score DESC, m."createdAt" DESC
      LIMIT $3
    `, [serverIds, q, limit]);

    if (rows.length > 0) return rows;
  } catch (_) { /* syntax hatası → fallback */ }

  // ── 2. Prefix arama (kısmi kelime desteği) ────────────────
  // "merha" → merhaba eşleşir
  try {
    const prefixQ = q
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.replace(/[^\w\u00C0-\u024F]/g, '') + ':*')
      .join(' & ');

    if (prefixQ) {
      const { rows } = await pool.query(`
        SELECT m.*,
          ts_rank_cd(
            to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",''))),
            to_tsquery('simple', unaccent($2)),
            32
          ) AS _score
        FROM messages m
        WHERE m."serverId" = ANY($1)
          AND to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
              @@ to_tsquery('simple', unaccent($2))
        ORDER BY _score DESC, m."createdAt" DESC
        LIMIT $3
      `, [serverIds, prefixQ, limit]);

      if (rows.length > 0) return rows;
    }
  } catch (_) { /* fallback */ }

  // ── 3. Trigram similarity (typo toleransı) ────────────────
  // "meraba" → "merhaba" bulur, pg_trgm kullanır
  try {
    const { rows } = await pool.query(`
      SELECT m.*, similarity(m.content, $2) AS _score
      FROM messages m
      WHERE m."serverId" = ANY($1)
        AND m.content % $2
      ORDER BY _score DESC, m."createdAt" DESC
      LIMIT $3
    `, [serverIds, q, limit]);

    if (rows.length > 0) return rows;
  } catch (_) { /* pg_trgm yüklü değilse fallback */ }

  // ── 4. ILIKE fallback (son çare) ──────────────────────────
  const escaped = q.replace(/[%_\\]/g, c => `\\${c}`);
  const { rows } = await pool.query(`
    SELECT m.*
    FROM messages m
    WHERE m."serverId" = ANY($1)
      AND m.content ILIKE $2
    ORDER BY m."createdAt" DESC
    LIMIT $3
  `, [serverIds, `%${escaped}%`, limit]);

  return rows;
}

// ── TRANSACTION HELPER ────────────────────────────────────────
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── SCHEMA BAŞLAT ─────────────────────────────────────────────
async function initSchema() {
  console.log('[DB] PostgreSQL schema başlatılıyor...');
  await pool.query(SCHEMA);

  // ── v78-fix: Mevcut production DB'lere eksik sütunları ekle ──
  const migrations = [
    // Extension'lar — IF NOT EXISTS ile güvenli
    `CREATE EXTENSION IF NOT EXISTS unaccent`,
    `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
    // FTS index'lerini yeniden oluştur (unaccent ile)
    `CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN(
      to_tsvector('simple', unaccent(coalesce(content,'') || ' ' || coalesce("displayName",'')))
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
    // Eski subscription JSONB sütununu taşı (endpoint henüz boşsa)
    `UPDATE push_subscriptions SET endpoint = subscription->>'endpoint', keys = subscription->'keys' WHERE endpoint IS NULL AND subscription IS NOT NULL`,
    // Index'ler
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint)`,
    `CREATE INDEX IF NOT EXISTS idx_nativepush_user ON native_push_tokens("userId")`,
    `CREATE INDEX IF NOT EXISTS idx_dm_messages_ts ON dm_messages("dmId", "createdAt" DESC)`,
  ];

  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) {
      if (!e.message.includes('already exists') && !e.message.includes('does not exist')) {
        console.warn('[DB] Migration uyarısı:', e.message.slice(0, 120));
      }
    }
  }

  // ── Eksik tablolar (v40-v78 arası eklenenler) ────────────────
  const extraTables = [
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
      "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
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

    // ActivityPub genişletilmiş tablolar
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

    // ap_follows — eksik kolonları ekle
    `ALTER TABLE ap_follows ADD COLUMN IF NOT EXISTS accepted BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE ap_follows ADD COLUMN IF NOT EXISTS "actorInbox" TEXT`,

    // ap_messages — zengin alan desteği
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

    // ap_activities — zengin alan desteği
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "actorUserId" TEXT`,
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS type TEXT`,
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "activityId" TEXT`,
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "noteId" TEXT`,
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "publishedAt" BIGINT`,
    `CREATE INDEX IF NOT EXISTS idx_ap_activities_actor ON ap_activities("actorUserId")`,
    `CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON ap_activities(type)`,

    // notifications tablosu (AP + normal)
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

    // WebAuthn passkey kimlik bilgileri
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

    // Sprint 11 — link_preview_cache (TTL-bazlı embed önbellekleme)
    `CREATE TABLE IF NOT EXISTS link_preview_cache (
      url TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      "fetchedAt" BIGINT NOT NULL,
      "expiresAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lpcache_expires ON link_preview_cache("expiresAt")`,

    // Federasyon whitelist / blacklist
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

    // ActivityPub delivery queue (federation retry)
    `CREATE TABLE IF NOT EXISTS ap_delivery_queue (
      _id TEXT PRIMARY KEY,
      payload JSONB NOT NULL DEFAULT '{}',
      attempts INTEGER NOT NULL DEFAULT 0,
      "nextAt" BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_apqueue_nextat ON ap_delivery_queue("nextAt")`,

    // Podcast (Stage -> Podcast Yayınlama)
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

    // Sunucu şablonları (v57+)
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
  ];

  for (const sql of extraTables) {
    try { await pool.query(sql); } catch (e) {
      if (!e.message.includes('already exists') && !e.message.includes('does not exist')) {
        console.warn('[DB] Extra table migration uyarısı:', e.message.slice(0, 120));
      }
    }
  }

  console.log('[DB] ✅ Schema hazır.');
}

// ── DB NESNESI (SQLite db/index.js ile aynı API) ─────────────
const TABLE_MAP = {
  users:              'users',
  servers:            'servers',
  channels:           'channels',
  messages:           'messages',
  members:            'members',
  invites:            'invites',
  roles:              'roles',
  dmConversations:    'dm_conversations',
  dmMessages:         'dm_messages',
  serverGifs:         'server_gifs',
  scheduledMsgs:      'scheduled_msgs',
  channelBridges:     'channel_bridges',
  refreshTokens:      'refresh_tokens',
  serverEmojis:       'server_emojis',
  polls:              'polls',
  soundboard:         'soundboard',
  friendships:        'friendships',
  channelCategories:  'channel_categories',
  notificationPrefs:  'notification_prefs',
  auditLogs:          'audit_logs',
  voiceMessages:      'voice_messages',
  threads:            'threads',
  threadMessages:     'thread_messages',
  bots:               'bots',
  webhooks:           'webhooks',
  channelOverrides:   'channel_overrides',
  unreadCounts:       'unread_counts',
  pushSubscriptions:  'push_subscriptions',
  federationPeers:    'federation_peers',
  adminLogs:          'admin_logs',
  // WebAuthn passkey credentials
  webauthnCredentials: 'webauthn_credentials',
  // Additional collections missing from earlier versions
  botRatings:         'bot_ratings',
  serverBots:         'server_bots',
  apFollows:          'ap_follows',
  apActivities:       'ap_activities',
  apMessages:         'ap_messages',
  apOutgoingFollows:  'ap_outgoing_follows',
  apLikes:            'ap_likes',
  apAnnounces:        'ap_announces',
  notifications:      'notifications',
  reactionRoles:      'reaction_roles',
  blocks:             'blocks',
  userConnections:    'user_connections',
  groupDmConversations: 'group_dm_conversations',
  groupDmMembers:     'group_dm_members',
  groupDmMessages:    'group_dm_messages',
  automodRules:       'automod_rules',
  outgoingWebhooks:   'outgoing_webhooks',
  serverOnboarding:   'server_onboarding',
  onboardingCompletions: 'onboarding_completions',
  podcastSettings:    'podcast_settings',
  podcastEpisodes:    'podcast_episodes',
  federationWhitelist: 'federation_whitelist',
  federationBlacklist: 'federation_blacklist',
  fcmTokens:          'fcm_tokens',
  nativePushTokens:   'native_push_tokens',
  channelPermissions: 'channel_permissions',
  apDeliveryQueue:    'ap_delivery_queue',
  serverTemplates:    'server_templates',
};

const db = {};
for (const [key, table] of Object.entries(TABLE_MAP)) {
  db[key] = new Collection(table);
}

// Özel metodlar
db._pool        = pool;
db._ftsSearch   = ftsSearch;
db._transaction = withTransaction;
db._initSchema  = initSchema;

// SQLite uyumluluk takma adları
db._sqlite = null; // PostgreSQL'de yok — kullanan yerlerde kontrol et

module.exports = db;

// ── İLK ÇALIŞMA: schema kur ───────────────────────────────────
// server/index.js'de `await db._initSchema()` çağır
// YA DA bu dosyayı doğrudan çalıştır: node db/postgres.js
if (require.main === module) {
  initSchema()
    .then(() => { console.log('Schema kuruldu.'); process.exit(0); })
    .catch(err => { console.error('Schema hatası:', err); process.exit(1); });
}
export {};
