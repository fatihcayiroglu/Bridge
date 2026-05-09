// @ts-nocheck
// server/db/repositories/index.js
// Tüm repository'leri tek noktadan export eder.
//
// Kullanım:
//   const { Users, Servers, Messages } = require('./db/repositories');
//   const { Channels, Members, Invites } = require('./db/repositories');
//
// Repository'ler db/loader üzerinden çalışır — SQLite veya PostgreSQL
// farketmeksizin aynı Collection API'si kullanılır.

const Users             = require('./UserRepository');
const Servers           = require('./ServerRepository');
const Messages          = require('./MessageRepository');
const Channels          = require('./ChannelRepository');
const Members           = require('./MemberRepository');
const Invites           = require('./InviteRepository');
const Roles             = require('./RoleRepository');
const Dms               = require('./DmRepository');
const GroupDms          = require('./GroupDmRepository');
const Bots              = require('./BotRepository');
const Threads           = require('./ThreadRepository');
const Automod           = require('./AutomodRepository');
const ReactionRoles     = require('./ReactionRoleRepository');
const ScheduledMessages = require('./ScheduledMessageRepository');
const Notifications     = require('./NotificationRepository');
const Social            = require('./SocialRepository');
const ServerAssets      = require('./ServerAssetRepository');
const Auth              = require('./AuthRepository');
const OutgoingWebhooks  = require('./OutgoingWebhookRepository');
const Polls             = require('./PollRepository');
const Federation        = require('./FederationRepository');
const Bridges           = require('./BridgeRepository');
const ChannelWebhooks   = require('./WebhookRepository');
const ChannelPermissions = require('./ChannelPermissionRepository');
const Podcasts          = require('./PodcastRepository');
const VoiceMessages     = require('./VoiceRepository');

module.exports = {
  // Temel varlıklar
  Users,
  Servers,
  Messages,
  Channels,
  Members,
  Invites,
  Roles,

  // Mesajlaşma
  Dms,
  GroupDms,
  Threads,
  ScheduledMessages,
  Polls,

  // Sunucu özellikleri
  Automod,
  ReactionRoles,
  ServerAssets,
  OutgoingWebhooks,
  Bots,

  // Kullanıcı & sosyal
  Social,
  Notifications,
  Auth,

  Federation,

  Bridges,
  ChannelWebhooks,
  ChannelPermissions,
  Podcasts,
  VoiceMessages,
};
