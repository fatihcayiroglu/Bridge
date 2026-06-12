// server/db/postgres/index.ts
// PostgreSQL DB katmanı ana giriş noktası.
//
// Sorumluluk dağılımı:
//   pool.ts        → bağlantı havuzu
//   schema.ts      → CREATE TABLE tanımları
//   pgCollection.ts → CRUD motoru (buildWhere, PgCollection, column whitelist)
//   fts.ts         → Full-text search
//   transaction.ts → withTransaction helper
//   migrations.ts  → inline ALTER TABLE / CREATE TABLE migration'ları
//   index.ts (bu)  → TABLE_MAP, db nesnesi, initSchema orkestrasyonu

import logger from '../../lib/logger';
import { pool } from './pool';
import { SCHEMA } from './schema';
import { PgCollection as Collection } from './pgCollection';
import { ftsSearch } from './fts';
import { withTransaction } from './transaction';
import { runInlineMigrations } from './migrations';

// ── SCHEMA BAŞLAT ─────────────────────────────────────────────
async function initSchema(): Promise<void> {
  logger.info({ event: 'db.schema.init' }, '[DB] PostgreSQL schema başlatılıyor...');
  await pool.query(SCHEMA);
  await runInlineMigrations(pool);
  logger.info({ event: 'db.schema.ready' }, '[DB] ✅ Schema hazır.');
}

// ── TABLO HARİTASI ────────────────────────────────────────────
// JS anahtarı → PostgreSQL tablo adı
const TABLE_MAP: Record<string, string> = {
  users:                  'users',
  servers:                'servers',
  channels:               'channels',
  messages:               'messages',
  members:                'members',
  invites:                'invites',
  roles:                  'roles',
  dmConversations:        'dm_conversations',
  dmMessages:             'dm_messages',
  serverGifs:             'server_gifs',
  scheduledMsgs:          'scheduled_msgs',
  channelBridges:         'channel_bridges',
  refreshTokens:          'refresh_tokens',
  serverEmojis:           'server_emojis',
  polls:                  'polls',
  soundboard:             'soundboard',
  friendships:            'friendships',
  channelCategories:      'channel_categories',
  notificationPrefs:      'notification_prefs',
  auditLogs:              'audit_logs',
  voiceMessages:          'voice_messages',
  threads:                'threads',
  threadMessages:         'thread_messages',
  bots:                   'bots',
  webhooks:               'webhooks',
  channelOverrides:       'channel_overrides',
  unreadCounts:           'unread_counts',
  pushSubscriptions:      'push_subscriptions',
  federationPeers:        'federation_peers',
  serverFederationKeys:   'server_federation_keys',
  adminLogs:              'admin_logs',
  webauthnCredentials:    'webauthn_credentials',
  botRatings:             'bot_ratings',
  serverBots:             'server_bots',
  apFollows:              'ap_follows',
  apActivities:           'ap_activities',
  apMessages:             'ap_messages',
  apOutgoingFollows:      'ap_outgoing_follows',
  apLikes:                'ap_likes',
  apAnnounces:            'ap_announces',
  notifications:          'notifications',
  reactionRoles:          'reaction_roles',
  blocks:                 'blocks',
  userConnections:        'user_connections',
  groupDmConversations:   'group_dm_conversations',
  groupDmMembers:         'group_dm_members',
  groupDmMessages:        'group_dm_messages',
  automodRules:           'automod_rules',
  outgoingWebhooks:       'outgoing_webhooks',
  serverOnboarding:       'server_onboarding',
  onboardingCompletions:  'onboarding_completions',
  podcastSettings:        'podcast_settings',
  podcastEpisodes:        'podcast_episodes',
  federationWhitelist:    'federation_whitelist',
  federationBlacklist:    'federation_blacklist',
  fcmTokens:              'fcm_tokens',
  nativePushTokens:       'native_push_tokens',
  channelPermissions:     'channel_permissions',
  apDeliveryQueue:        'ap_delivery_queue',
  serverTemplates:        'server_templates',
  // SECURITY: ActivityPub özel anahtarları users tablosundan ayrı tutulur
  userApKeys:             'user_ap_keys',
  // Rozet sistemi
  userBadges:             'user_badges',
  // Upload sahipliği (Sprint 75: userId+key kaydı; DELETE /cdn bu tabloyu kullanır)
  uploads:                'uploads',
};

// ── DB NESNESİ ────────────────────────────────────────────────
type DbInstance = Record<string, Collection> & {
  uploads: Collection;
  _pool: typeof pool;
  _ftsSearch: typeof ftsSearch;
  _transaction: typeof withTransaction;
  _initSchema: typeof initSchema;
  _sqlite: null;
};

const db = {} as DbInstance;

for (const [key, table] of Object.entries(TABLE_MAP)) {
  (db as Record<string, Collection>)[key] = new Collection(pool, table);
}

db._pool        = pool;
db._ftsSearch   = ftsSearch;
db._transaction = withTransaction;
db._initSchema  = initSchema;
db._sqlite      = null; // SQLite uyumluluk — PostgreSQL'de yok

export default db;

// ── KLİ KULLANIMI: schema kur ─────────────────────────────────
// node db/postgres/index.js
if (require.main === module) {
  initSchema()
    .then(() => { logger.info('Schema kuruldu.'); process.exit(0); })
    .catch(err => { logger.error({ detail: err }, 'Schema hatası:'); process.exit(1); });
}
