// server/db/loader.ts
// PostgreSQL'i yükler.
// import db from './loader' ile kullanılır.

import logger from '../lib/logger';
import { tryRequire } from '../lib/_optional-require';
import type { PgCollection, DbRecord } from './postgres/pgCollection';
import type {
  User, Server, Member, Channel, ChannelCategory, ChannelOverride, Message,
  Invite, Role, DmConversation, DmMessage, GroupDm, GroupDmMessage,
  Thread, ThreadMessage, Bot, RefreshToken, WebAuthnCredential,
  NotificationPref, Friendship, Block, UserConnection, FederationActivity,
  FederationPeer, Poll, ScheduledMessage, AutomodRule, ReactionRole,
  OutgoingWebhook, ChannelWebhook, CustomEmoji, ServerGif, SoundboardSound,
  Podcast, PodcastEpisode, VoiceMessage, ChannelPermission, Bridge
} from './repositories/types/entities';

// Tüm bilinen collection'lar — noUncheckedIndexedAccess için explicit property'ler
export interface DbInstance {
  // Core
  users:                  PgCollection<User>;
  servers:                PgCollection<Server>;
  members:                PgCollection<Member>;
  memberRoles:            PgCollection<DbRecord>;
  channels:               PgCollection<Channel>;
  channelCategories:      PgCollection<ChannelCategory>;
  channelPermissions:     PgCollection<ChannelPermission>;
  channelOverrides:       PgCollection<ChannelOverride>;
  messages:               PgCollection<Message>;
  invites:                PgCollection<Invite>;
  roles:                  PgCollection<Role>;
  // DMs
  dmConversations:        PgCollection<DmConversation>;
  dmMessages:             PgCollection<DmMessage>;
  groupDmConversations:   PgCollection<GroupDm>;
  groupDmMembers:         PgCollection<DbRecord>;
  groupDmMessages:        PgCollection<GroupDmMessage>;
  // Threads
  threads:                PgCollection<Thread>;
  threadMessages:         PgCollection<ThreadMessage>;
  // Bots
  bots:                   PgCollection<Bot>;
  serverBots:             PgCollection<DbRecord>;
  botRatings:             PgCollection<DbRecord>;
  // Auth / security
  refreshTokens:          PgCollection<RefreshToken>;
  webauthnCredentials:    PgCollection<WebAuthnCredential>;
  auditLogs:              PgCollection<DbRecord>;
  adminLogs:              PgCollection<DbRecord>;
  // Notifications
  notifications:          PgCollection<DbRecord>;
  notificationPrefs:      PgCollection<NotificationPref>;
  pushSubscriptions:      PgCollection<DbRecord>;
  nativePushTokens:       PgCollection<DbRecord>;
  fcmTokens:              PgCollection<DbRecord>;
  unreadCounts:           PgCollection<DbRecord>;
  // Social
  friendships:            PgCollection<Friendship>;
  blocks:                 PgCollection<Block>;
  userConnections:        PgCollection<UserConnection>;
  // Federation / ActivityPub
  apActivities:           PgCollection<FederationActivity>;
  apAnnounces:            PgCollection<DbRecord>;
  apDeliveryQueue:        PgCollection<DbRecord>;
  apFollows:              PgCollection<DbRecord>;
  apLikes:                PgCollection<DbRecord>;
  apMessages:             PgCollection<DbRecord>;
  apOutgoingFollows:      PgCollection<DbRecord>;
  userApKeys:             PgCollection<DbRecord>;
  federationPeers:        PgCollection<FederationPeer>;
  federationBlacklist:    PgCollection<DbRecord>;
  federationWhitelist:    PgCollection<DbRecord>;
  // Misc features
  polls:                  PgCollection<Poll>;
  scheduledMsgs:          PgCollection<ScheduledMessage>;
  automodRules:           PgCollection<AutomodRule>;
  reactionRoles:          PgCollection<ReactionRole>;
  outgoingWebhooks:       PgCollection<OutgoingWebhook>;
  webhooks:               PgCollection<ChannelWebhook>;
  serverEmojis:           PgCollection<CustomEmoji>;
  serverGifs:             PgCollection<ServerGif>;
  serverTemplates:        PgCollection<DbRecord>;
  serverOnboarding:       PgCollection<DbRecord>;
  onboardingCompletions:  PgCollection<DbRecord>;
  soundboard:             PgCollection<SoundboardSound>;
  podcastSettings:        PgCollection<Podcast>;
  podcastEpisodes:        PgCollection<PodcastEpisode>;
  voiceMessages:          PgCollection<VoiceMessage>;
  channelBridges:         PgCollection<Bridge>;
  // Boosts / marketplace
  serverAssets?:          PgCollection<DbRecord>;
  boosts?:                PgCollection<DbRecord>;
  serverEvents?:          PgCollection<DbRecord>;
  announcements?:         PgCollection<DbRecord>;
  botMarketplace?:        PgCollection<DbRecord>;
  oauthClients?:          PgCollection<DbRecord>;
  oauthTokens?:           PgCollection<DbRecord>;
  oauthCodes?:            PgCollection<DbRecord>;
  // DB internals
  _pool:                  import('pg').Pool;
  _ftsSearch:             (...args: unknown[]) => unknown;
  _transaction:           (...args: unknown[]) => unknown;
  _initSchema:            () => Promise<void>;
  _sqlite:                null;
  // Allow other collections without undefined
  [key: string]:          PgCollection<object> | unknown;
}

let db: DbInstance;

if (process.env.NODE_ENV === 'test') {
  // Jest/unit tests must never try to connect to a real database.
  const mockFactory = tryRequire<{ createMockDb: () => DbInstance }>('../tests/helpers/mockDb');
  if (!mockFactory) {
    throw new Error('[DB] Test mock DB could not be loaded');
  }
  db = mockFactory.createMockDb();
} else if (process.env.DATABASE_URL) {
  logger.info(
    { event: 'db.mode.postgres' },
    `[DB] PostgreSQL -> ${process.env.DATABASE_URL.replace(/:[^@]+@/, ':***@')}`
  );
  const pg = tryRequire<DbInstance>('./postgres');
  if (!pg) {
    logger.fatal({ event: 'db.postgres.load_failed' }, '[DB] postgres modülü yüklenemedi.');
    process.exit(1);
  }
  db = pg;
} else {
  logger.fatal(
    { event: 'db.missing_url' },
    '[DB] HATA: DATABASE_URL tanımlı değil.\n' +
    '     .env dosyasına ekle: DATABASE_URL=postgresql://user:pass@localhost:5432/bridge\n' +
    '     Docker için: docker-compose.yml içinde otomatik ayarlanır.'
  );
  process.exit(1);
}

export default db;
