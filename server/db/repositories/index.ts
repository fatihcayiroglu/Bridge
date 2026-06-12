// server/db/repositories/index.ts
// Tüm repository'leri tek noktadan export eder.
//
// Kullanım:
//   import { Users, Servers, Messages } from './db/repositories';
//   import { Channels, Members, Invites } from './db/repositories';
//
// Repository'ler db/loader üzerinden çalışır — SQLite veya PostgreSQL
// farketmeksizin aynı Collection API'si kullanılır.

import Users             from './UserRepository';
import Servers           from './ServerRepository';
import Messages          from './MessageRepository';
import Channels          from './ChannelRepository';
import Members           from './MemberRepository';
import Invites           from './InviteRepository';
import Roles             from './RoleRepository';
import Dms               from './DmRepository';
import GroupDms          from './GroupDmRepository';
import Bots              from './BotRepository';
import Threads           from './ThreadRepository';
import Automod           from './AutomodRepository';
import ReactionRoles     from './ReactionRoleRepository';
import ScheduledMessages from './ScheduledMessageRepository';
import Notifications     from './NotificationRepository';
import Social            from './SocialRepository';
import ServerAssets      from './ServerAssetRepository';
import Auth              from './AuthRepository';
import OutgoingWebhooks  from './OutgoingWebhookRepository';
import Polls             from './PollRepository';
import Federation        from './FederationRepository';
import Bridges           from './BridgeRepository';
import ChannelWebhooks   from './WebhookRepository';
import ChannelPermissions from './ChannelPermissionRepository';
import Podcasts          from './PodcastRepository';
import VoiceMessages     from './VoiceRepository';
import { ServerEvents }  from './ServerEventRepository';
import { Stats }         from './StatsRepository';
import { Boosts }        from './BoostRepository';
import { Announcements } from './AnnouncementRepository';
import { BotMarketplace } from './BotMarketplaceRepository';
import { OAuth }         from './OAuthRepository';
const Reactions = ReactionRoles;

export {
  Users,
  Servers,
  Messages,
  Channels,
  Members,
  Invites,
  Roles,
  Dms,
  GroupDms,
  Threads,
  ScheduledMessages,
  Polls,
  Automod,
  ReactionRoles,
  ServerAssets,
  OutgoingWebhooks,
  Bots,
  Social,
  Notifications,
  Auth,
  Federation,
  Bridges,
  ChannelWebhooks,
  ChannelPermissions,
  Podcasts,
  VoiceMessages,
  ServerEvents,
  Stats,
  Boosts,
  Announcements,
  BotMarketplace,
  OAuth,
  Reactions,
};
