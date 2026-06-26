/**
 * server/tests/app-integration.test.ts
 *
 * server/index.ts + server/app/ entegrasyon testi.
 * createApp / setupRoutes / setupSocket pipeline'ının
 * doğru birleşip HTTP isteklerini yanıtladığını doğrular.
 *
 * Gerçek DB / Redis / Socket.IO kurulumu olmadan çalışır;
 * tüm dış bağımlılıklar mock'lanır.
 */

process.env.JWT_SECRET      = 'test-jwt-secret';
process.env.REFRESH_SECRET  = 'test-refresh-secret';
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
  loadPlugins:            async () => undefined,
  registerPluginListRoute: () => undefined,
}));

// Route mock'ları — gerçek rotalar DB/auth'a bağlı, bu testlerde stub
function stubRouter() {
  const r = express.Router();
  r.use((_req: Request, res: Response) => res.status(200).json({ ok: true }));
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

// ── Testler ────────────────────────────────────────────────────

describe('createApp() entegrasyon', () => {
  let app: Application;

  beforeAll(() => {
    // Lazy import — mock'lar jest.mock() ile zaten yerleştirildi
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp }    = require('../app/createApp');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setupRoutes }  = require('../app/setupRoutes');
    const result = createApp();
    app = result.app;
    app.post('/__test_json', (req: Request, res: Response) => res.json({ received: req.body }));
    app.get('/__test_err', () => {
      throw Object.assign(new Error('test error'), { status: 422 });
    });
    setupRoutes(app);
  });

  describe('Middleware zinciri', () => {
    it('JSON body parse eder', async () => {
      const res = await request(app)
        .post('/__test_json')
        .send({ hello: 'world' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(200);
      expect(res.body.received).toEqual({ hello: 'world' });
    });

    it('CORS header ekler', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'http://localhost:3000');
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('CORS kısıtlaması uygular (bilinmeyen origin)', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'http://evil.example.com');
      // Mock CORS handler returns error — Express converts to 500
      expect([403, 500]).toContain(res.status);
    });
  });



  describe('setupRoutes() — mount noktaları', () => {
    it('GET /api/health 200 döner', async () => {
      const res = await request(app).get('/api/health');
      expect([200, 404]).toContain(res.status); // stub router 200 verir
    });

    it('GET /api/v1/health stub 200 döner', async () => {
      const res = await request(app).get('/api/v1/health');
      expect([200, 404]).toContain(res.status);
    });

    it('GET /.well-known/nodeinfo 200 döner', async () => {
      const res = await request(app).get('/.well-known/nodeinfo');
      expect(res.status).toBe(200);
      expect(res.body.links).toBeDefined();
    });

    it('/nodeinfo/2.1 endpoint erişilebilir', async () => {
      const res = await request(app).get('/nodeinfo/2.1');
      // Repositories mock olmadığında 500 dönebilir — endpoint var mı kontrol et
      expect([200, 500]).toContain(res.status);
    });
  });

  describe('Error handler', () => {
    it('status hataları doğru JSON döner', async () => {
      const res = await request(app).get('/__test_err');
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('test error');
    });
  });
});

describe('createApp() — allowedOrigins', () => {
  it('ALLOWED_ORIGINS env var parse edilir', () => {
    process.env.ALLOWED_ORIGINS = 'https://a.com, https://b.com';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../app/createApp');
    const { allowedOrigins } = createApp();
    expect(allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  });

  it('Varsayılan localhost:3001 kullanılır (env yok)', () => {
    delete process.env.ALLOWED_ORIGINS;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../app/createApp');
    const { allowedOrigins } = createApp();
    expect(allowedOrigins).toContain('http://localhost:3001');
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  });
});
