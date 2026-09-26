// server/tests/bots-router-mount-shadowing.test.ts
//
// Final21 Phase 14, found by the live bot lifecycle probe: routes/bots.ts is mounted at
// /servers, /bot, /bots and /webhooks (app/setupRoutes.ts). Its legacy webhook alias
// `POST /:webhookId` therefore also matched `POST /api/bots/marketplace`, and because the
// marketplace router is mounted AFTER the bots router, listing submission was answered by
// the webhook receiver: 400 "content veya embeds gerekli". Per-router unit tests mount
// each router alone and could not see it. This test reproduces the real mount order.

process.env.NODE_ENV = 'test';

const mockChannelWebhooks = { findById: jest.fn() };
jest.mock('../db/repositories', () => ({ Bots: {}, Channels: {}, ChannelWebhooks: mockChannelWebhooks, Messages: {} }));
jest.mock('../middleware/auth', () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../middleware/botAuth', () => ({ botAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../middleware/rateLimit', () => ({ limits: { bots: () => (_req: unknown, _res: unknown, next: () => void) => next() } }));

import express from 'express';
import request from 'supertest';
import botsRouter from '../routes/bots';

function appWithRealMountOrder() {
  const app = express();
  app.use(express.json());
  // Same order as app/setupRoutes.ts: bots router first, marketplace router later.
  for (const base of ['/api', '/api/v1']) {
    app.use(`${base}/servers`, botsRouter);
    app.use(`${base}/bot`, botsRouter);
    app.use(`${base}/bots`, botsRouter);
    const marketplace = express.Router();
    marketplace.post('/', (_req, res) => { res.status(201).json({ reached: 'marketplace' }); });
    app.use(`${base}/bots/marketplace`, marketplace);
    app.use(`${base}/webhooks`, botsRouter);
  }
  app.use((_req, res) => { res.status(404).json({ reached: 'not-found' }); });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockChannelWebhooks.findById.mockResolvedValue(null);
});

describe('bots router legacy webhook alias does not shadow later routers', () => {
  it.each(['/api', '/api/v1'])('POST %s/bots/marketplace reaches the marketplace router', async (base) => {
    const res = await request(appWithRealMountOrder()).post(`${base}/bots/marketplace`).send({ id: 'x' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ reached: 'marketplace' });
    expect(mockChannelWebhooks.findById).not.toHaveBeenCalled();
  });

  it('POST /api/servers/<single segment> is not answered by the webhook receiver', async () => {
    const res = await request(appWithRealMountOrder()).post('/api/servers/whatever').send({ content: 'hi' });
    expect(res.body).toEqual({ reached: 'not-found' });
    expect(mockChannelWebhooks.findById).not.toHaveBeenCalled();
  });

  it.each(['/api/webhooks/hook-1', '/api/v1/webhooks/hook-1', '/api/bot/webhooks/hook-1', '/api/bots/webhooks/hook-1'])(
    'the webhook receiver still answers POST %s',
    async (path) => {
      const res = await request(appWithRealMountOrder()).post(`${path}?token=t`).send({ content: 'hi' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Webhook bulunamadı' });
      expect(mockChannelWebhooks.findById).toHaveBeenCalledWith('hook-1');
    },
  );
});
