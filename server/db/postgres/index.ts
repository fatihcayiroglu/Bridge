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
import { ftsSearch, unifiedFtsSearch } from './fts';
import { searchContext } from './search-context';
import { withTransaction } from './transaction';
import { runInlineMigrations } from './migrations';
import { applyPendingMigrations, autoMigrateEnabled, pendingMigrations } from './versionedMigrations';
import { PGVECTOR_ENABLED, ensurePgvectorSchema } from '../../lib/pgvector';

// ── SCHEMA BAŞLAT ─────────────────────────────────────────────
// Bu isin TAMAMI tek bir PostgreSQL danismanlik kilidi (advisory lock)
// altinda calisir.
//
// ── NEDEN (v1.124'te OLCULDU) ───────────────────────────────────────────────
// Iki Bridge ornegi AYNI ANDA baslatildiginda ikincisi acilista COKUYORDU:
//
//   event=server.boot_error
//   DatabaseError: tuple concurrently updated
//     at initSchema (db/postgres/index.js)
//
// Sebep: `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... IF NOT EXISTS`
// deyimleri tek baslarina "varsa atla" anlaminda guvenlidir, ama AYNI ANDA
// calisan iki oturum ayni katalog satirini (pg_class/pg_attribute)
// guncellemeye calisirsa PostgreSQL bu hatayi verir. Bu bir Bridge mantik
// hatasi degil, KOORDINASYON eksikligiydi.
//
// Bu tam olarak yatay olceklemenin ve kademeli (rolling) dagitimin yaptigi
// seydir: birden fazla ornek ayni anda ayaga kalkar. Yani kusur, cok-ornekli
// calismanin ONUNDEKI gercek bir engeldi.
//
// Danismanlik kilidi dogru aractir: PostgreSQL'in kendisinde tutulur (ek
// altyapi yok), oturum kopunca KENDILIGINDEN birakilir (olu ornek kilidi
// sonsuza dek tutamaz) ve semayi degistirmez.
//
// Kilidi ALAMAYAN ornek beklemez-gecmez; SIRAYA girer. Once bitiren semayi
// kurar, sonraki ise zaten hazir bir sema uzerinde ayni `IF NOT EXISTS`
// deyimlerini calistirir ve hizlica gecer.
const SCHEMA_LOCK_KEY = 0x6272_6467;   // 'brdg' — Bridge sema kilidi

async function initSchema(): Promise<void> {
  logger.info({ event: 'db.schema.init' }, '[DB] PostgreSQL schema başlatılıyor...');

  // Kilit OTURUM kapsamlidir; bu yuzden tek bir istemci uzerinde alinir ve
  // ne olursa olsun ayni istemci uzerinde birakilir.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    try {
      await pool.query(SCHEMA);
      await runInlineMigrations(pool);
      // P5 SH-01: the versioned chain belongs to boot too — before this, a fresh
      // install ran without it and still reported ready. Same lock, same session.
      if (autoMigrateEnabled()) {
        const applied = await applyPendingMigrations(client, {
          onApplied: (file) => logger.info({ event: 'db.migration.applied', migration: file }, `[DB] Migration uygulandı: ${file}`),
        });
        if (applied.length) {
          logger.info({ event: 'db.migrations.applied', count: applied.length }, `[DB] ${applied.length} versioned migration uygulandı.`);
        }
      } else {
        const pending = await pendingMigrations(client);
        if (pending.length) {
          logger.error(
            { event: 'db.migrations.pending', count: pending.length, first: pending[0] },
            '[DB] BRIDGE_AUTO_MIGRATE=false and versioned migrations are pending: run `node server/dist/db/migrate-postgres.js up`. The node stays NOT READY until they are applied.',
          );
        }
      }
      if (PGVECTOR_ENABLED) {
        const pgvectorReady = await ensurePgvectorSchema(pool);
        logger.info({ event: 'db.pgvector.schema', ready: pgvectorReady }, pgvectorReady ? '[DB] pgvector şeması hazır.' : '[DB] pgvector opsiyonel şeması kullanılamıyor; fallback aktif.');
      }
    } finally {
      // Birakma BASARISIZ olursa bile surec devam etmelidir: oturum
      // kapandiginda PostgreSQL kilidi zaten serbest birakir.
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY])
        .catch(() => { /* oturum kapaninca otomatik birakilir */ });
    }
  } finally {
    client.release();
  }

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
  soundboardUserStats:    'soundboard_user_stats',
  friendships:            'friendships',
  channelCategories:      'channel_categories',
  notificationPrefs:      'notification_prefs',
  notificationKeywords:   'notification_keywords',
  auditLogs:              'audit_logs',
  voiceMessages:          'voice_messages',
  threads:                'threads',
  threadMessages:         'thread_messages',
  bots:                   'bots',
  webhooks:               'webhooks',
  channelOverrides:       'channel_overrides',
  unreadCounts:           'unread_counts',
  channelReadPositions:   'channel_read_positions',
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
  savedMessages:          'saved_messages',
  messageReports:         'message_reports',
  reactionRoles:          'reaction_roles',
  blocks:                 'blocks',
  userConnections:        'user_connections',
  groupDmConversations:   'group_dm_conversations',
  groupDmMembers:         'group_dm_members',
  groupDmMessages:        'group_dm_messages',
  automodRules:           'automod_rules',
  outgoingWebhooks:       'outgoing_webhooks',
  outgoingWebhookDeliveries: 'outgoing_webhook_deliveries',
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
  stickerPacks:           'sticker_packs',
  stickerPackItems:       'sticker_pack_items',
};

// ── DB NESNESİ ────────────────────────────────────────────────
type DbInstance = Record<string, Collection> & {
  uploads: Collection;
  _pool: typeof pool;
  _ftsSearch: typeof ftsSearch;
  _unifiedSearch: typeof unifiedFtsSearch;
  _searchContext: typeof searchContext;
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
db._unifiedSearch = unifiedFtsSearch;
db._searchContext = searchContext;
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
