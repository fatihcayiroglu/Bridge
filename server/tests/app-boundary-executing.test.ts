// server/tests/app-boundary-executing.test.ts
//
// ============================================================================
// UYGULAMA SINIRI - KAYNAK TARAMASI DEGIL, GERCEK ISTEK
// ============================================================================
// `null-byte-rejection.test.ts` bu korumanin KAYNAKTA yazili oldugunu kanitlar.
// Bu dosya onu YURUTUR: `createApp()` ile gercek zincir kurulur ve istekler
// gercekten gecirilir. Ikisi ayni sey degildir - dogru yazilmis ama yanlis
// SIRAYA takilmis bir middleware kaynak taramasindan gecer, istekten gecmez.
//
// Olculen iki sinir:
//
// 1. NULL BAYT. PostgreSQL `text` alanlari 0x00 kabul etmez ve hata rota
//    icinde yakalanmiyordu: anonim `/api/login` bile 500 uretebiliyordu.
//    Koruma `/api` sinirindadir ve AYRISTIRILMIS govdeyi gezer - ham metinde
//    NULL bir KACIS DIZISIDIR, gercek bayt yalnizca `JSON.parse` sonrasi
//    olusur. Ozyineleme SINIRLIDIR (derinlik + dongusel referans), aksi halde
//    korumanin kendisi bir DoS yuzeyi olurdu.
//
// 2. YUKLEME SERVISI. `/uploads` altindaki dosyalar KULLANICI icerigidir.
//    Tarayicinin onlari sayfa gibi calistirmasi saklanan XSS demektir. Bu
//    yuzden goruntu olmayan her dosya `attachment` olarak iner, calistirilabilir
//    uzantilar ayrica bos bir icerik politikasi alir ve SVG sandbox'lanir.
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

// `/uploads` iki KATMANLIDIR: once yetkilendirme (`uploadAuthz`), sonra statik
// servis. Bu dosya IKINCI katmanin basliklarini olcer; yetkilendirme katmaninin
// KENDI testleri vardir (`upload-authz*.test.ts`). Burada gecis serbest
// birakilir, cunku aksi halde 403 yuzunden baslik katmanina hic ULASILAMAZ.
jest.mock('../middleware/uploadAuthz', () => ({
  uploadAuthz: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  _resetUploadAuthzCache: () => undefined,
}));


// -- Testler ---------------------------------------------------

const NUL = String.fromCharCode(0);

describe('the /api boundary executes its null-byte guard', () => {
  let app: Application;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../app/createApp');
    app = createApp().app;
    app.post('/api/__echo', (req: Request, res: Response) => res.json({ received: req.body }));
    app.get('/api/__ok', (_req: Request, res: Response) => res.json({ ok: true }));
  });

  it('accepts an ordinary body untouched', async () => {
    const res = await request(app).post('/api/__echo').send({ name: 'merhaba', nested: { list: [1, 'iki'] } });
    expect(res.status).toBe(200);
    expect(res.body.received.name).toBe('merhaba');
  });

  it.each([
    ['a top-level string', { name: 'kotu' + NUL + 'ad' }],
    ['a nested object value', { profile: { bio: 'x' + NUL } }],
    ['a value inside an array', { tags: ['iyi', 'kotu' + NUL] }],
    ['a deeply nested value within the scan depth', { a: { b: { c: { d: { e: 'x' + NUL } } } } }],
  ])('rejects %s with 400', async (_label, payload) => {
    const res = await request(app).post('/api/__echo').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/null bytes/i);
  });

  it('rejects a percent-encoded null byte in the URL', async () => {
    const res = await request(app).get('/api/__ok?q=%00');
    expect(res.status).toBe(400);
  });

  it('stops descending past the depth limit instead of recursing forever', async () => {
    // 20 kat derin: tarayici 12'de durur ve istegi GECIRIR. Bu bilincli bir
    // takastir - sinirsiz ozyineleme korumanin kendisini DoS yuzeyi yapardi.
    let deep: Record<string, unknown> = { value: 'x' + NUL };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    const res = await request(app).post('/api/__echo').send(deep);
    expect(res.status).toBe(200);
  });

  it('survives a body whose object graph repeats the same node', async () => {
    // Ayni nesne birden cok kez gecerse tarayici onu ikinci kez GEZMEZ.
    const shared = { note: 'temiz' };
    const res = await request(app).post('/api/__echo').send({ a: shared, b: shared, c: shared });
    expect(res.status).toBe(200);
  });

  it('leaves a body-less request alone', async () => {
    const res = await request(app).get('/api/__ok');
    expect(res.status).toBe(200);
  });
});

describe('user uploads are never served as executable page content', () => {
  let app: Application;
  let root: string;
  const PROBES = ['boundary-probe.png', 'boundary-probe.pdf', 'boundary-probe.js', 'boundary-probe.svg'];

  beforeAll(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fs = require('fs');
    const path = require('path');
    const { uploadRoot } = require('../lib/runtimePaths');
    root = uploadRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'boundary-probe.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(root, 'boundary-probe.pdf'), Buffer.from('%PDF-1.7'));
    fs.writeFileSync(path.join(root, 'boundary-probe.js'), Buffer.from('alert(1)'));
    fs.writeFileSync(path.join(root, 'boundary-probe.svg'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));

    const { createApp } = require('../app/createApp');
    app = createApp().app;
    /* eslint-enable @typescript-eslint/no-var-requires */
  });

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs'); const path = require('path');
    for (const name of PROBES) {
      try { fs.unlinkSync(path.join(root, name)); } catch { /* zaten yok */ }
    }
  });

  const fetchUpload = (name: string) => request(app).get('/uploads/' + name);

  it('always sets nosniff and denies framing', async () => {
    const res = await fetchUpload('boundary-probe.png');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('serves an image inline but forces every other type to download', async () => {
    const image = await fetchUpload('boundary-probe.png');
    const pdf = await fetchUpload('boundary-probe.pdf');
    expect(image.headers['content-disposition']).toBeUndefined();
    expect(pdf.headers['content-disposition']).toBe('attachment');
  });

  it('adds a null content policy to executable extensions', async () => {
    const res = await fetchUpload('boundary-probe.js');
    expect(res.headers['content-disposition']).toBe('attachment');
    // Indirilse bile calistirilamaz.
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('sandboxes SVG, which can carry script', async () => {
    const res = await fetchUpload('boundary-probe.svg');
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['content-security-policy']).toContain("style-src 'none'");
  });
});
