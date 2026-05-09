import { Application, Request, Response, NextFunction } from 'express';

export function setupRoutes(app: Application): void {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { router: authRouter }               = require('../routes/auth');
  const serversRouter                        = require('../routes/servers');
  const messagesRouter                       = require('../routes/messages');
  const uploadRouter                         = require('../routes/upload');
  const { router: rolesRouter }              = require('../routes/roles');
  const channelsRouter                       = require('../routes/channels');
  const { router: dmRouter }                 = require('../routes/dm');
  const serverGifsRouter                     = require('../routes/serverGifs');
  const scheduledRouter                      = require('../routes/scheduled');
  const bridgeRouter                         = require('../routes/bridge');
  const healthRouter                         = require('../routes/health');
  const { swaggerRouter }                    = require('../lib/swagger');
  const mediaRouter                          = require('../routes/media');
  const customEmojiRouter                    = require('../routes/customEmoji');
  const serverAssetsRouter                   = require('../routes/serverAssets');
  const friendsRouter                        = require('../routes/friends');
  const categoriesRouter                     = require('../routes/categories');
  const moderationRouter                     = require('../routes/moderation');
  const voiceMsgRouter                       = require('../routes/voicemsg');
  const searchRouter                         = require('../routes/search');
  const pinsRouter                           = require('../routes/pins');
  const statsRouter                          = require('../routes/stats');
  const threadsRouter                        = require('../routes/threads');
  const usersRouter                          = require('../routes/users');
  const { router: botsRouter }               = require('../routes/bots');
  const webhooksRouter                       = require('../routes/webhooks');
  const pollsRouter                          = require('../routes/polls');
  const soundboardRouter                     = require('../routes/soundboard');
  const discoverRouter                       = require('../routes/discover');
  const { pushRouter }                       = require('../lib/notifications');
  const aiRouter                             = require('../routes/ai');
  const { router: activityRouter }           = require('../routes/activity');
  const { router: e2eRouter }                = require('../lib/e2e');
  const federationRouter                     = require('../routes/federation/index');
  const twoFactorRouter                      = require('../routes/twoFactor');
  const webauthnRouter                       = require('../routes/webauthn');
  const emailRouter                          = require('../routes/email');
  const adminRouter                          = require('../routes/admin');
  const ssoRouter                            = require('../routes/sso');
  const invitePreviewRouter                  = require('../routes/invitePreview');
  const mobilePushRouter                     = require('../routes/mobilePush');
  const webpushRouter                        = require('../routes/webpush');
  const interactionsRouter                   = require('../routes/interactions');
  const channelPermsRouter                   = require('../routes/channelPerms');
  const groupDmRouter                        = require('../routes/groupDm');
  const automodRouter                        = require('../routes/automod');
  const userConnectionsRouter                = require('../routes/userConnections');
  const { router: outgoingWebhooksRouter }   = require('../routes/outgoingWebhooks');
  const onboardingRouter                     = require('../routes/onboarding');
  const reactionRolesRouter                  = require('../routes/reactionRoles');
  const semanticRouter                       = require('../routes/semantic');
  const serverProfileRouter                  = require('../routes/serverProfile');
  const serverTemplatesRouter                = require('../routes/serverTemplates');
  const clientErrorRouter                    = require('../routes/client-error');
  const podcastRouter                        = require('../routes/podcast');
  const linkPreviewRouter                    = require('../routes/linkPreview');
  const { metricsEndpoint }                  = require('../middleware/metrics');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const mountApi = (suffix: string, router: Application): void => {
    app.use(`/api${suffix}`, router);
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
  mountApi('/bridges', bridgeRouter);
  mountApi('/health', healthRouter);
  mountApi('/rtc', healthRouter);
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
  mountApi('/push', pushRouter);
  mountApi('/channels', pollsRouter);
  mountApi('/polls', pollsRouter);
  mountApi('/servers/:sid/soundboard', soundboardRouter);
  mountApi('/discover', discoverRouter);
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
  mountApi('/servers/:sid/reaction-roles', reactionRolesRouter);
  mountApi('/semantic', semanticRouter);
  mountApi('/servers', serverProfileRouter);
  app.use('/s', serverProfileRouter);
  mountApi('/server-templates', serverTemplatesRouter);
  mountApi('/client-error', clientErrorRouter);
  mountApi('/podcast', podcastRouter);
  mountApi('/link-preview', linkPreviewRouter);
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

  app.get('/nodeinfo/2.1', async (_req: Request, res: Response) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Users, Federation } = require('../db/repositories');
      const userCount = await Users.count({}).catch(() => 0);
      const postCount = await Federation.countActivities({ type: 'Create' }).catch(() => 0);
      res.json({
        version: '2.1',
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        software: { name: 'bridge', version: require('../../package.json').version },
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
      const message = e instanceof Error ? e.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });
}
