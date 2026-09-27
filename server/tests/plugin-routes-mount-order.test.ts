// server/tests/plugin-routes-mount-order.test.ts
//
// Final21 Phase 14. runtime.ts registered GET /api/plugins and every plugin route
// (ctx.registerRoute → /api/plugins/<id>/*) on `app` AFTER setupRoutes() had installed
// notFoundHandler, so in production all of them answered 404: the marketplace showed
// "plugin list could not be loaded" on every open, the server-settings Plugins tab and the
// plugin page were empty. Unit tests mounted the loader on a bare app and could not see it.
//
// This suite runs the REAL setupRoutes (route modules replaced by EMPTY routers, so the
// real 404 handler is reachable) and the REAL plugin list route.

process.env.JWT_SECRET      = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET  = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV        = 'test';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';

import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import express, { Application } from 'express';

// ── Ortak mock'lar ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});
jest.mock('../db/seed', () => async () => undefined);

jest.mock('../middleware/rateLimit', () => {
  const bypass = () => (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    rateLimit: bypass,
    limits: new Proxy({}, { get: () => bypass }),
  };
});

jest.mock('../middleware/csrf', () => ({
  enforceApiCsrf: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.mock('../middleware/metrics', () => ({
  metricsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  metricsEndpoint:   (_req: Request, res: Response) => res.status(200).send(''),
}));
jest.mock('../middleware/ipBan', () => ({
  ipBanMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.mock('../middleware/ipReputation', () => ({
  ipReputationMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.mock('../lib/security', () => ({
  securityHeaders: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.mock('../lib/swagger', () => ({
  swaggerRouter: express.Router(),
}));
jest.mock('../lib/notifications', () => ({
  pushRouter: express.Router(),
}));
jest.mock('../lib/e2e', () => ({
  router: express.Router(),
}));
jest.mock('../lib/redisAdapter', () => ({
  applyAdapter: async () => undefined,
}));
jest.mock('../socket', () => ({
  socketUsers: new Map(),
  voiceRooms:  {},
  setupSocket: () => undefined,
}));
jest.mock('../socket/handlers/mediasoup', () => ({
  initMediasoup: async () => false,
}));
jest.mock('../plugins/loader', () => ({
  loadPlugins:             async () => undefined,
  registerPluginListRoute: () => undefined,
  bindPluginSocketEvents:  () => undefined,
}));

// Route mock'ları — gerçek rotalar DB/auth'a bağlı, bu testlerde stub
function stubRouter() {
  const r = express.Router();
  return r;
}
const stubRouterWithExport = () => {
  const router = stubRouter();
  return { __esModule: true, default: router, router, getMemberPerms: async () => 0 };
};

jest.mock('../routes/auth',              () => stubRouterWithExport());
jest.mock('../routes/servers',           stubRouter);
jest.mock('../routes/messages',          stubRouter);
jest.mock('../routes/upload',            stubRouter);
jest.mock('../routes/roles',             () => ({ ...stubRouterWithExport(), hasPermission: () => true, PERMS: {} }));
jest.mock('../routes/channels',          stubRouter);
jest.mock('../routes/dm',                () => stubRouterWithExport());
jest.mock('../routes/serverGifs',        stubRouter);
jest.mock('../routes/scheduled',         stubRouter);
jest.mock('../routes/bridge',            stubRouter);
jest.mock('../routes/health', () => {
  const router = stubRouter();
  return Object.assign(router, {
    iceConfigHandler: (_req: Request, res: Response) => res.status(200).json({}),
  });
});
jest.mock('../routes/media',             stubRouter);
jest.mock('../routes/customEmoji',       stubRouter);
jest.mock('../routes/serverAssets',      stubRouter);
jest.mock('../routes/friends',           stubRouter);
jest.mock('../routes/categories',        stubRouter);
jest.mock('../routes/moderation',        stubRouter);
jest.mock('../routes/voicemsg',          stubRouter);
jest.mock('../routes/search',            stubRouter);
jest.mock('../routes/pins',              stubRouter);
jest.mock('../routes/stats',             stubRouter);
jest.mock('../routes/threads',           stubRouter);
jest.mock('../routes/users',             stubRouter);
jest.mock('../routes/bots',              () => stubRouterWithExport());
jest.mock('../routes/bot-marketplace',    stubRouter);
jest.mock('../routes/webhooks',          stubRouter);
jest.mock('../routes/polls',             stubRouter);
jest.mock('../routes/soundboard',        stubRouter);
jest.mock('../routes/discover', () => ({
  __esModule: true,
  default: stubRouter(),
  adminDiscoverRouter: stubRouter(),
}));
jest.mock('../routes/ai',                stubRouter);
jest.mock('../routes/activity',          () => stubRouterWithExport());
jest.mock('../routes/federation/index',  stubRouter);
jest.mock('../routes/twoFactor',         stubRouter);
jest.mock('../routes/webauthn',          stubRouter);
jest.mock('../routes/email',             stubRouter);
jest.mock('../routes/admin',             stubRouter);
jest.mock('../routes/sso',               stubRouter);
jest.mock('../routes/invitePreview',     stubRouter);
jest.mock('../routes/mobilePush',        stubRouter);
jest.mock('../routes/webpush',           stubRouter);
jest.mock('../routes/interactions',      stubRouter);
jest.mock('../routes/channelPerms',      stubRouter);
jest.mock('../routes/groupDm',           stubRouter);
jest.mock('../routes/automod',           stubRouter);
jest.mock('../routes/userConnections',   stubRouter);
jest.mock('../routes/outgoingWebhooks',  () => stubRouterWithExport());
jest.mock('../routes/onboarding',        stubRouter);
jest.mock('../routes/reactionRoles',     stubRouter);
jest.mock('../routes/semantic',          stubRouter);
jest.mock('../routes/serverProfile',     stubRouter);
jest.mock('../routes/serverTemplates',   stubRouter);
jest.mock('../routes/client-error',      stubRouter);
jest.mock('../routes/podcast',           stubRouter);
jest.mock('../routes/linkPreview',       stubRouter);
jest.mock('../routes/boosts',            () => stubRouterWithExport());
jest.mock('../routes/spotify-oauth',     () => stubRouterWithExport());
jest.mock('../routes/announcement',      () => ({ ...stubRouterWithExport(), setIo: () => undefined }));
jest.mock('../routes/serverEvents',      stubRouter);
jest.mock('../routes/notificationPrefs', stubRouter);
jest.mock('../routes/serverMemberProfile', stubRouter);
jest.mock('../routes/sticker-packs',     stubRouter);


jest.unmock('../plugins/loader');

import { pluginRouterOf, setupRoutes } from '../app/setupRoutes';
import { registerPluginListRoute } from '../plugins/loader';

function preparedApp(): Application {
  const app = express();
  setupRoutes(app);
  return app;
}
const allowAll = (_req: Request, _res: Response, next: NextFunction) => next();

describe('plugin HTTP surface mount order', () => {
  it('GET /api/plugins registered through pluginRouterOf(app) answers 200 with the loaded list', async () => {
    const app = preparedApp();
    registerPluginListRoute(pluginRouterOf(app), allowAll);
    const res = await request(app).get('/api/plugins');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('a plugin sub-route registered after setup is reachable too', async () => {
    const app = preparedApp();
    pluginRouterOf(app).get('/api/plugins/word-filter/blocked', (_req: Request, res: Response) => { res.json({ words: [] }); });
    const res = await request(app).get('/api/plugins/word-filter/blocked');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ words: [] });
  });

  it('negative control: the pre-fix wiring (registering on the app after setup) is shadowed by the 404 handler', async () => {
    const app = preparedApp();
    registerPluginListRoute(app, allowAll);
    const res = await request(app).get('/api/plugins');
    expect(res.status).toBe(404);
  });

  it('pluginRouterOf refuses an app setupRoutes has not prepared', () => {
    expect(() => pluginRouterOf(express())).toThrow(/setupRoutes/);
  });

  it('runtime.ts registers the plugin list and plugin loading on the prepared router', () => {
    const runtime = require('fs').readFileSync(require('path').join(__dirname, '../runtime.ts'), 'utf8') as string;
    expect(runtime).toMatch(/const pluginRouter = pluginRouterOf\(app\);/);
    expect(runtime).toMatch(/registerPluginListRoute\(pluginRouter, authMiddleware\)/);
    expect(runtime).toMatch(/loadPlugins\(pluginRouter, db, io, authMiddleware\)/);
    expect(runtime).not.toMatch(/registerPluginListRoute\(app\b/);
    expect(runtime).not.toMatch(/loadPlugins\(app\b/);
  });
});
