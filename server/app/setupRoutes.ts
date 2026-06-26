import { Application, Router, Request, Response, NextFunction } from 'express';
import { errorHandler, notFoundHandler } from '../middleware/errorHandler';

import { router as authRouter }             from '../routes/auth';
import serversRouter                        from '../routes/servers';
import messagesRouter                       from '../routes/messages';
import uploadRouter                         from '../routes/upload';
import { router as rolesRouter }            from '../routes/roles';
import channelsRouter                       from '../routes/channels/index';
import { router as dmRouter }               from '../routes/dm';
import serverGifsRouter                     from '../routes/serverGifs';
import scheduledRouter                      from '../routes/scheduled';
import healthRouter, { iceConfigHandler }  from '../routes/health';
import { swaggerRouter }                    from '../lib/swagger';
import mediaRouter                          from '../routes/media';
import customEmojiRouter                    from '../routes/customEmoji';
import serverAssetsRouter                   from '../routes/serverAssets';
import friendsRouter                        from '../routes/friends';
import categoriesRouter                     from '../routes/categories';
import moderationRouter                     from '../routes/moderation';
import voiceMsgRouter                       from '../routes/voicemsg';
import searchRouter                         from '../routes/search';
import pinsRouter                           from '../routes/pins';
import statsRouter                          from '../routes/stats';
import threadsRouter                        from '../routes/threads';
import usersRouter                          from '../routes/users';
import botsRouter                           from '../routes/bots';
import bridgeRouter                         from '../routes/bridge';
import botMarketplaceRouter                 from '../routes/bot-marketplace'; // Sprint 83
import webhooksRouter                       from '../routes/webhooks';
import pollsRouter                          from '../routes/polls';
import soundboardRouter                     from '../routes/soundboard';
import discoverRouter, { adminDiscoverRouter } from '../routes/discover';
import badgesRouter                         from '../routes/badges';
import { pushRouter }                       from '../lib/notifications';
import aiRouter                             from '../routes/ai';
import { router as activityRouter }         from '../routes/activity';
import { router as e2eRouter }              from '../lib/e2e';
import federationRouter                     from '../routes/federation/index';
import twoFactorRouter                      from '../routes/twoFactor';
import webauthnRouter                       from '../routes/webauthn';
import emailRouter                          from '../routes/email';
import adminRouter                          from '../routes/admin';
import ssoRouter                            from '../routes/sso';
import invitePreviewRouter                  from '../routes/invitePreview';
import mobilePushRouter                     from '../routes/mobilePush';
import webpushRouter                        from '../routes/webpush';
import interactionsRouter                   from '../routes/interactions';
import channelPermsRouter                   from '../routes/channelPerms';
import groupDmRouter                        from '../routes/groupDm';
import automodRouter                        from '../routes/automod';
import userConnectionsRouter                from '../routes/userConnections';
import { router as outgoingWebhooksRouter } from '../routes/outgoingWebhooks';
import { router as boostsRouter }           from '../routes/boosts'; // Sprint 93
import { router as spotifyOAuthRouter }     from '../routes/spotify-oauth'; // Sprint 93
import { router as announcementRouter, setIo as setAnnouncementIo } from '../routes/announcement'; // Sprint 94
import serverEventsRouter                   from '../routes/serverEvents';    // Sprint 95
import notificationPrefsRouter              from '../routes/notificationPrefs'; // Sprint 91
import serverMemberProfileRouter            from '../routes/serverMemberProfile'; // Sprint 91
import onboardingRouter                     from '../routes/onboarding';
import reactionRolesRouter                  from '../routes/reactionRoles';
import semanticRouter                       from '../routes/semantic';
import serverProfileRouter                  from '../routes/serverProfile';
import serverTemplatesRouter                from '../routes/serverTemplates';
import clientErrorRouter                    from '../routes/client-error';
import podcastRouter                        from '../routes/podcast';
import linkPreviewRouter                    from '../routes/linkPreview';
import stickerPacksRouter                   from '../routes/sticker-packs'; // Sprint 82
import { metricsEndpoint }                  from '../middleware/metrics';
import { Users, Federation }               from '../db/repositories';
import pkg                                 from '../../package.json';

export function setupRoutes(app: Application): void {
  // Sprint D: /api/v1 canonical, /api versionless deprecated
  const deprecationMiddleware = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/v1>; rel="successor-version"');
    next();
  };

  const mountApi = (suffix: string, router: Router): void => {
    // Versionless route: deprecated — Deprecation: true header ekle
    app.use(`/api${suffix}`, deprecationMiddleware, router);
    // Canonical versioned route
    app.use(`/api/v1${suffix}`, router);
  };

  mountApi('', authRouter);
  mountApi('/servers', serversRouter);
  mountApi('/channels', messagesRouter);
  mountApi('/upload', uploadRouter);
  mountApi('/servers', rolesRouter);
  mountApi('/servers/:sid/emojis', customEmojiRouter);
  mountApi('/servers/:sid', serverAssetsRouter);
  mountApi('/servers', channelsRouter);
  mountApi('/servers', categoriesRouter);
  mountApi('/dm', dmRouter);
  mountApi('/servers', serverGifsRouter);
  mountApi('/scheduled', scheduledRouter);
  mountApi('/health', healthRouter);
  // Sprint 120: I7 — /api/rtc/ice-config yalnızca bu endpoint'i açar.
  // Önceden tüm healthRouter /api/rtc'ye mount ediliyordu; bu /api/rtc/stats,
  // /api/rtc/ready gibi istenmeyen path'leri açıyordu.
  app.get('/api/rtc/ice-config', iceConfigHandler);
  app.get('/api/v1/rtc/ice-config', iceConfigHandler);
  mountApi('/docs', swaggerRouter);
  mountApi('/media', mediaRouter);
  mountApi('/friends', friendsRouter);
  mountApi('/servers', moderationRouter);
  mountApi('/voice-messages', voiceMsgRouter);
  mountApi('/search', searchRouter);
  mountApi('/servers', searchRouter);
  mountApi('/channels', pinsRouter);
  mountApi('/servers', statsRouter);
  mountApi('/threads', threadsRouter);
  mountApi('/threads/channel', threadsRouter);
  mountApi('/users', usersRouter);
  mountApi('/servers', botsRouter);
  mountApi('/bot', botsRouter);
  mountApi('/bots', botsRouter);
  mountApi('/bridges', bridgeRouter);
  mountApi('/bots/marketplace', botMarketplaceRouter); // Sprint 83: marketplace catalog
  mountApi('/push', pushRouter);
  mountApi('/channels', pollsRouter);
  mountApi('/polls', pollsRouter);
  mountApi('/servers/:sid/soundboard', soundboardRouter);
  mountApi('/discover', discoverRouter);
  mountApi('/admin/discover', adminDiscoverRouter);
  mountApi('', badgesRouter);

  mountApi('/ai', aiRouter);
  mountApi('/activity', activityRouter);
  mountApi('/e2e', e2eRouter);
  mountApi('/federation', federationRouter);
  mountApi('/2fa', twoFactorRouter);
  mountApi('/webauthn', webauthnRouter);
  mountApi('/email', emailRouter);
  mountApi('/admin', adminRouter);
  mountApi('/sso', ssoRouter);
  app.use('/invite', invitePreviewRouter);
  mountApi('/mobile', mobilePushRouter);
  mountApi('/webpush', webpushRouter);
  mountApi('/interactions', interactionsRouter);
  mountApi('/servers/:sid/channels/:cid/permissions', channelPermsRouter);
  mountApi('/webhooks', botsRouter);
  mountApi('/channels', webhooksRouter);
  mountApi('/gdm', groupDmRouter);
  mountApi('/servers/:sid/automod', automodRouter);
  mountApi('', userConnectionsRouter);
  mountApi('/servers', outgoingWebhooksRouter);
  mountApi('/servers', onboardingRouter);
  mountApi('/servers', boostsRouter);        // Sprint 93: Boost ekonomisi + vanity URL
  mountApi('/oauth',   spotifyOAuthRouter);   // Sprint 93: Spotify OAuth
  mountApi('/channels', announcementRouter);    // Sprint 94: Announcement crosspost/follow

  mountApi('/servers', serverEventsRouter);           // Sprint 95: Sunucu Etkinlikleri
  mountApi('/notification-prefs', notificationPrefsRouter); // Sprint 91: Bildirim tercihleri
  mountApi('/servers', serverMemberProfileRouter);    // Sprint 91: Per-server member profil
  mountApi('/servers/:sid/reaction-roles', reactionRolesRouter);
  mountApi('/semantic', semanticRouter);
  mountApi('/servers', serverProfileRouter);
  app.use('/s', serverProfileRouter);
  mountApi('/server-templates', serverTemplatesRouter);
  mountApi('/client-error', clientErrorRouter);
  mountApi('/podcast', podcastRouter);
  mountApi('/link-preview', linkPreviewRouter);
  mountApi('/servers', stickerPacksRouter); // Sprint 82: sticker packs
  app.get('/metrics', metricsEndpoint);

  app.get(
    '/.well-known/webfinger',
    (req: Request, res: Response, next: NextFunction) => {
      const parsedUrl = (req as Request & { _parsedUrl?: { search?: string } })._parsedUrl;
      req.url = '/webfinger' + (parsedUrl?.search || '');
      federationRouter(req, res, next);
    }
  );

  app.get('/.well-known/nodeinfo', async (_req: Request, res: Response) => {
    const instanceUrl =
      process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
    res.json({
      links: [
        {
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
          href: `${instanceUrl}/nodeinfo/2.1`,
        },
      ],
    });
  });

  app.get('/nodeinfo/2.1', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const userCount = await Users.count({}).catch(() => 0);
      const postCount = await Federation.countActivities({ type: 'Create' }).catch(() => 0);
      res.json({
        version: '2.1',
        software: { name: 'bridge', version: (pkg as { version: string }).version },
        protocols: ['activitypub'],
        usage: {
          users:      { total: userCount || 0, activeMonth: 0, activeHalfyear: 0 },
          localPosts: postCount || 0,
        },
        openRegistrations: !(process.env.DISABLE_REGISTRATION === 'true'),
        metadata: {
          nodeName:        process.env.INSTANCE_NAME || 'Bridge Instance',
          nodeDescription: process.env.INSTANCE_DESC || 'A Bridge chat server',
        },
      });
    } catch (e: unknown) {
      next(e);
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
}
