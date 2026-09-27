// server/tests/outgoingWebhooks.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission:      jest.fn(),
  PERMS: { MANAGE_SERVER: 8, ADMINISTRATOR: 1 << 30 },
}));
// Route-contract tests must not depend on external DNS. SSRF/DNS-rebinding behavior
// is covered separately by url-safety/ssrf suites.
// Donus tipi URUNDEN alinir (`UrlCheck`): cikarim `{ ok: boolean }` veriyordu
// ve `reason` alani olan RED yanitlari kurulamiyordu — yani testler urunun
// ret gerekcesini hic olcemiyordu.
const checkOutboundUrl = jest.fn<Promise<UrlCheck>, [raw: unknown]>(async () => ({ ok: true }));
const fetchT = jest.fn(async (..._args: unknown[]) => ({ ok: true, status: 204 }));
jest.mock('../lib/urlSafety', () => ({
  checkOutboundUrl: (raw: unknown) => checkOutboundUrl(raw),
}));
jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));

import type { UrlCheck } from '../lib/urlSafety';
import type { RequestBody } from './helpers/httpDoubles';
import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const repositories = require('../db/repositories');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import { router as owRouter } from '../routes/outgoingWebhooks';
const perms   = require('../lib/permissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', owRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Outgoing Webhooks Routes', () => {
  let app: express.Express;
  let ownerId: string;
  let serverId: string;
  let ownerToken: string;

  beforeEach(async () => {
    db._reset?.();
    app      = buildApp();
    ownerId  = uuidv4();
    serverId = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.members.insert({ userId: ownerId, serverId, roles: [] });

    perms.resolvePermissions.mockResolvedValue(8);
    perms.hasPermission.mockReturnValue(true);
    checkOutboundUrl.mockReset();
    checkOutboundUrl.mockResolvedValue({ ok: true });
    fetchT.mockReset();
    fetchT.mockResolvedValue({ ok: true, status: 204 });
  });

  describe('GET /api/servers/:sid/outgoing-webhooks', () => {
    it('returns empty list initially', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 403 without MANAGE_SERVER', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .get(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get(`/api/servers/${serverId}/outgoing-webhooks`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/servers/:sid/outgoing-webhooks', () => {
    it('creates an outgoing webhook', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Slack Relay', url: 'https://hooks.slack.com/services/test', events: ['message:new'] });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('_id');
    });

    it('returns 400 for missing name', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ url: 'https://example.com', events: ['message:new'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing url', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Hook', events: ['message:new'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 for unsupported event type', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Hook', url: 'https://example.com', events: ['invalid:event'] });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/servers/:sid/outgoing-webhooks/:id', () => {
    let hookId: string;
    beforeEach(async () => {
      const hook = await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'ToDelete', url: 'https://example.com',
        events: '["message:new"]', enabled: true, createdBy: ownerId, createdAt: Date.now()
      });
      hookId = hook._id;
    });

    it('deletes a webhook', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/outgoing-webhooks/${hookId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 204]).toContain(res.status);
      const hook = await db.outgoingWebhooks.findOne({ _id: hookId });
      expect(hook).toBeNull();
    });

    it('returns 404 for nonexistent webhook', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/outgoing-webhooks/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('extended outgoing-webhook authority and validation', () => {
    it('masks secrets and normalizes stored event/default status fields on GET', async () => {
      await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Stored', url: 'https://example.com/h',
        events: '["message:new"]', enabled: 1, secret: 'super-secret', createdBy: ownerId, createdAt: 1,
      });
      const res = await request(app)
        .get(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([expect.objectContaining({
        name: 'Stored', events: ['message:new'], enabled: true, secret: '••••••••',
        consecutiveFailures: 0, lastFailedAt: null, lastError: null,
      })]);
    });

    it('fails create closed on permission denial and unsafe targets', async () => {
      perms.hasPermission.mockReturnValueOnce(false);
      let res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'x', url: 'https://example.com', events: ['message:new'] });
      expect(res.status).toBe(403);

      perms.hasPermission.mockReturnValue(true);
      checkOutboundUrl.mockResolvedValueOnce({ ok: false, reason: 'private address' });
      res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'x', url: 'http://127.0.0.1', events: ['message:new'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('private address');
    });

    it('enforces the 20-webhook server cap', async () => {
      for (let i = 0; i < 20; i += 1) {
        await db.outgoingWebhooks.insert({
          _id: uuidv4(), serverId, name: `h${i}`, url: `https://example.com/${i}`,
          events: '["message:new"]', enabled: true, createdBy: ownerId, createdAt: i,
        });
      }
      const res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'overflow', url: 'https://example.com/overflow', events: ['message:new'] });
      expect(res.status).toBe(429);
    });

    it('PATCH validates target and event domain just like create, then persists canonical updates', async () => {
      const hook = await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Before', url: 'https://example.com/before',
        events: '["message:new"]', enabled: true, secret: 'old', createdBy: ownerId, createdAt: 1,
      });

      checkOutboundUrl.mockResolvedValueOnce({ ok: false, reason: 'blocked' });
      let res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}`)
        .set('Authorization', `Bearer ${ownerToken}`).send({ url: 'http://127.0.0.1' });
      expect(res.status).toBe(400);

      checkOutboundUrl.mockResolvedValue({ ok: true });
      res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}`)
        .set('Authorization', `Bearer ${ownerToken}`).send({ events: ['totally:unsupported'] });
      expect(res.status).toBe(400);

      res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: ' Updated ', url: 'https://example.com/after', events: ['*'], secret: ' ', enabled: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({
        name: 'Updated', url: 'https://example.com/after', events: ['*'], secret: null, enabled: false,
      }));
    });

    it.each([
      [{ enabled: 'false' }, 'enabled'],
      [{ enabled: 0 }, 'enabled'],
      [{ name: '   ' }, 'name'],
      [{ url: 123 }, 'url'],
      [{ events: 'message:new' }, 'events'],
      [{ events: [] }, 'events'],
      [{ secret: { value: 'x' } }, 'secret'],
      [{ unknown: true }, 'supported'],
    ] as Array<[RequestBody, string]>)('PATCH rejects malformed/coerced fields: %p', async (payload) => {
      const hook = await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Strict', url: 'https://example.com/strict',
        events: '["message:new"]', enabled: true, secret: 'stored-secret', createdBy: ownerId, createdAt: 1,
      });

      const res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}`)
        .set('Authorization', `Bearer ${ownerToken}`).send(payload);

      expect(res.status).toBe(400);
    });

    it('PATCH never returns the stored signing secret in plaintext', async () => {
      const hook = await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Secret', url: 'https://example.com/secret',
        events: '["message:new"]', enabled: true, secret: 'do-not-leak', createdBy: ownerId, createdAt: 1,
      });

      const res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}`)
        .set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Still Secret' });

      expect(res.status).toBe(200);
      expect(res.body.secret).toBe('••••••••');
      expect(JSON.stringify(res.body)).not.toContain('do-not-leak');
    });

    it.each([
      { name: 123, url: 'https://example.com', events: ['message:new'] },
      { name: 'x', url: 123, events: ['message:new'] },
      { name: 'x', url: 'https://example.com', events: 'message:new' },
      { name: 'x', url: 'https://example.com', events: [], secret: false },
    ])('POST rejects malformed field types instead of coercing or throwing: %p', async (payload) => {
      const res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`).send(payload);
      expect(res.status).toBe(400);
    });

    it('PATCH and DELETE reject cross-scope/nonexistent ids and permission denial', async () => {
      perms.hasPermission.mockReturnValueOnce(false);
      let res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`).send({ name: 'x' });
      expect(res.status).toBe(403);

      perms.hasPermission.mockReturnValue(true);
      res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`).send({ name: 'x' });
      expect(res.status).toBe(404);

      perms.hasPermission.mockReturnValueOnce(false);
      res = await request(app).delete(`/api/servers/${serverId}/outgoing-webhooks/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });

    it('test endpoint sends a signed deterministic test payload and returns transport result', async () => {
      const hook = await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Tester', url: 'https://example.com/test',
        events: '["message:new"]', enabled: true, secret: 'sign-me', createdBy: ownerId, createdAt: 1,
      });
      const res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}/test`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ ok: true, status: 204 }));
      const opts = fetchT.mock.calls[0][1] as { headers: Record<string,string>; body: string };
      expect(opts.headers['X-Bridge-Signature']).toMatch(/^sha256=/);
      expect(JSON.parse(opts.body)).toEqual(expect.objectContaining({ event: 'test', serverId }));
    });

    it('test endpoint handles denial, missing id, and unsafe target without network I/O', async () => {
      perms.hasPermission.mockReturnValueOnce(false);
      let res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks/${uuidv4()}/test`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);

      perms.hasPermission.mockReturnValue(true);
      res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks/${uuidv4()}/test`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);

      const hook = await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Unsafe', url: 'http://127.0.0.1',
        events: '["message:new"]', enabled: true, secret: null, createdBy: ownerId, createdAt: 1,
      });
      checkOutboundUrl.mockResolvedValueOnce({ ok: false, reason: 'private address' });
      res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}/test`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ ok: false, permanent: true, error: 'private address' }));
      expect(fetchT).not.toHaveBeenCalled();
    });

    it('returns the supported event catalogue to authenticated callers', async () => {
      const res = await request(app).get('/api/servers/outgoing-webhooks/events')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.events).toEqual(expect.arrayContaining(['message:new', 'member:join', 'channel:deleted']));
    });

    it('rejects top-level arrays, mixed event types, and unsafe targets without a reason', async () => {
      let res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`).send([]);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/object body/i);

      res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'mixed', url: 'https://example.com/h', events: ['message:new', 7] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/non-empty strings/i);

      checkOutboundUrl.mockResolvedValueOnce({ ok: false });
      res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'unsafe', url: 'http://127.0.0.1', events: ['message:new'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid URL');
    });

    it('applies canonical defaults, trims and deduplicates events, and never returns a raw secret', async () => {
      const res = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: ' Defaults ', url: ' https://example.com/default ', secret: ' signing-key ' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual(expect.objectContaining({
        name: 'Defaults', url: 'https://example.com/default', events: ['message:new'], secret: '••••••••',
      }));

      const duplicate = await request(app).post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'dedupe', url: 'https://example.com/dedupe', events: [' message:new ', 'message:new'] });
      expect(duplicate.status).toBe(201);
      expect(duplicate.body.events).toEqual(['message:new']);
    });

    it('normalizes malformed persisted event shapes without throwing or disclosing data', async () => {
      await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Numeric', url: 'https://example.com/numeric',
        events: 42, enabled: true, secret: null, createdBy: ownerId, createdAt: 1,
      });
      await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Json scalar', url: 'https://example.com/scalar',
        events: '42', enabled: true, secret: null, createdBy: ownerId, createdAt: 2,
      });
      const res = await request(app).get(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((entry: { events: unknown }) => entry.events)).toEqual([[], []]);
    });

    it('rejects array PATCH bodies and returns 404 if the webhook vanishes during update', async () => {
      const hook = await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'Race', url: 'https://example.com/race',
        events: '["message:new"]', enabled: true, secret: null, createdBy: ownerId, createdAt: 1,
      });
      let res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}`)
        .set('Authorization', `Bearer ${ownerToken}`).send([]);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/object body/i);

      const lookup = jest.spyOn(repositories.OutgoingWebhooks, 'findByIdAndServer')
        .mockResolvedValueOnce(hook)
        .mockResolvedValueOnce(null);
      try {
        res = await request(app).patch(`/api/servers/${serverId}/outgoing-webhooks/${hook._id}`)
          .set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Updated before delete' });
        expect(res.status).toBe(404);
      } finally {
        lookup.mockRestore();
      }
    });
  });


  // ══════════════════════════════════════════════════════════════════════
  // Final21 Phase 17 — "imzalı" görünen ama imzasız webhook
  // ══════════════════════════════════════════════════════════════════════
  // Bir webhook’un sırrı, alıcının isteğin GERÇEKTEN Bridge’den geldiğini
  // doğrulamasını sağlar. Yalnız boşluktan oluşan bir sır saklanırsa, arayüz
  // "imzalı" göstermesine rağmen hiçbir imza üretilmez. Bu dal test edilmiyordu.
  describe('Final21 Phase 17 — secret and event edges', () => {
    it('boşluktan ibaret bir sır SAKLANMAZ; webhook imzasız işaretlenir', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Bosluk', url: 'https://example.test/hook', events: ['message:new'], secret: '   ' });

      expect([200, 201]).toContain(res.status);
      expect(res.body.secret).toBeNull();
      const stored = await db.outgoingWebhooks.findOne({ _id: res.body._id });
      expect(stored?.secret).toBeNull();
    });

    it('PATCH ile boşluk gönderilince var olan sır TEMİZLENİR', async () => {
      const created = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Imzali', url: 'https://example.test/hook', events: ['message:new'], secret: 'gercek-sir' });
      expect(created.body.secret).toBe('••••••••');

      const patched = await request(app)
        .patch(`/api/servers/${serverId}/outgoing-webhooks/${created.body._id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ secret: '  ' });

      expect(patched.status).toBe(200);
      expect(patched.body.secret).toBeNull();
      expect((await db.outgoingWebhooks.findOne({ _id: created.body._id }))?.secret).toBeNull();
    });

    it('JSON olmayan eski bir events değeri TEK olay olarak okunur, düşmez', async () => {
      // Eski sürümlerin yazdığı satırlar düz metin taşıyor. `JSON.parse` burada
      // atar; liste ucu bu yüzden 500 vermemeli, olayı tek eleman saymalıdır.
      const id = uuidv4();
      await db.outgoingWebhooks.insert({
        _id: id, serverId, name: 'Legacy', url: 'https://example.test/legacy',
        events: 'message:new', secret: null, enabled: true, createdBy: ownerId, createdAt: Date.now(),
      });

      const res = await request(app)
        .get(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const row = (res.body as Array<{ _id: string; events: string[] }>).find((w) => w._id === id);
      expect(row?.events).toEqual(['message:new']);
    });

    it('gerekçesiz reddedilen bir hedef için yine de anlaşılır bir 400 döner', async () => {
      // `checkOutboundUrl` bazı yollarda gerekçe DÖNMEZ; mesaj boş kalmamalıdır.
      checkOutboundUrl.mockResolvedValueOnce({ ok: false });
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Gerekcesiz', url: 'https://blocked.test/hook', events: ['message:new'] });

      expect(res.status).toBe(400);
      expect(String(res.body.error).trim().length).toBeGreaterThan(0);
    });
  });
});
