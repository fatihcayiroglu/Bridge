// server/tests/stats.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => {
  const mock = require('./helpers/mockDb').createMockDb();
  mock._sqlite = {
    prepare: () => ({
      get:  () => ({ n: 5 }),
      all:  () => [],
      run:  () => {},
    }),
  };
  return mock;
});

jest.mock('../db/repositories/StatsRepository.js', () => {
  const db = require('../db/loader');

  return {
    Stats: {
      getServerStats: jest.fn(async (serverId) => {
        const now = Date.now();
        const messages = await db.messages.find({ serverId });
        const recent7 = messages.filter((message: Record<string, unknown>) => Number(message.createdAt || 0) > now - 7 * 86400_000);
        const recent30 = messages.filter((message: Record<string, unknown>) => Number(message.createdAt || 0) > now - 30 * 86400_000);

        const users = new Map();
        const channels = new Map();

        for (const message of recent30) {
          const userId = String(message.userId || '');
          const channelId = String(message.channelId || '');

          const user = users.get(userId) || {
            userId,
            displayName: message.displayName || message.username || userId,
            msgCount: 0,
          };
          user.msgCount += 1;
          users.set(userId, user);

          const channel = channels.get(channelId) || { channelId, msgCount: 0 };
          channel.msgCount += 1;
          channels.set(channelId, channel);
        }

        return {
          memberCount: await db.members.count({ serverId }),
          channelCount: await db.channels.count({ serverId }),
          totalMessages: messages.length,
          activeUsers7d: new Set(recent7.map((message: Record<string, unknown>) => message.userId)).size,
          activeUsers30d: new Set(recent30.map((message: Record<string, unknown>) => message.userId)).size,
          topUsers: [...users.values()].sort((a, b) => b.msgCount - a.msgCount).slice(0, 10),
          channelBreakdown: [...channels.values()].sort((a, b) => b.msgCount - a.msgCount).slice(0, 15),
        };
      }),
    },
  };
});

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import statsRouter from '../routes/stats';
import { PERMS } from '../lib/permissions';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', authMiddleware, statsRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Stats Routes', () => {
  let app: express.Express;
  let ownerId: string;
  let strangerId: string;
  let memberId: string;
  let serverId: string;
  let channelId: string;
  let ownerToken: string;
  let strangerToken: string;
  let memberToken: string;

  beforeEach(async () => {
    db._reset?.();
    app        = buildApp();
    ownerId    = uuidv4();
    strangerId = uuidv4();
    memberId   = uuidv4();
    serverId   = uuidv4();
    channelId  = uuidv4();
    ownerToken    = tok(ownerId);
    strangerToken = tok(strangerId);
    memberToken   = tok(memberId);

    await db.users.insert({ _id: ownerId,    username: 'owner',   displayName: 'Owner',   tokenVersion: 0 });
    await db.users.insert({ _id: strangerId, username: 'stranger', displayName: 'Stranger', tokenVersion: 0 });
    await db.users.insert({ _id: memberId,   username: 'member',  displayName: 'Member',  tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });
  });

  describe('GET /:serverId/stats — access control', () => {
    it('returns 200 + stats for server owner', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('memberCount');
      expect(res.body).toHaveProperty('channelCount');
      expect(res.body).toHaveProperty('totalMessages');
      expect(res.body).toHaveProperty('topUsers');
    });

    it('SIRADAN üye 403 alır — istatistikler MANAGE_SERVER gerektirir', async () => {
      // ── POLİTİKA DEĞİŞTİ ─────────────────────────────────────────────────
      // Bu test eskiden "herhangi bir üye 200 alır" diyordu. `requireStatsAccess`
      // (routes/stats.ts:75-80) artık üyeliğe EK OLARAK MANAGE_SERVER istiyor.
      //
      // Bu bir gizlilik sıkılaştırmasıdır: sunucu istatistikleri en aktif
      // kullanıcıları, mesaj hacmini ve üye büyümesini açığa çıkarır — sıradan
      // bir üyenin görmesi gereken veri değil, moderasyon verisidir.
      //
      // Eski iddia korunsaydı, doğru olan kısıtlama "başarısız test" gibi
      // görünür ve geri alınmaya davet ederdi.
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });

    it('MANAGE_SERVER rolü olan üye 200 alır (sahip olmasa bile)', async () => {
      // Ayrım: yukarıdaki iddia, uç nokta HERKESE kapalı olsa da geçerdi.
      // Bu test yetkinin sahiplikten DEĞİL rolden gelebildiğini kanıtlar.
      await db.roles.insert({
        _id: 'role-mod', serverId, name: 'Moderator',
        permissions: PERMS.MANAGE_SERVER, position: 5, createdAt: Date.now(),
      });
      await db.members.update(
        { userId: memberId, serverId },
        { $set: { roles: ['role-mod'] } },
      );

      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${memberToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('memberCount');
    });

    it('returns 403 for non-member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${strangerToken}`);
      expect(res.status).toBe(403);
    });

    it('returns 403 for nonexistent server', async () => {
      const res = await request(app)
        .get(`/api/servers/${uuidv4()}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });

    it('returns 401 for unauthenticated request', async () => {
      const res = await request(app).get(`/api/servers/${serverId}/stats`);
      expect(res.status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', 'Bearer not.a.real.token');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /:serverId/stats — response shape', () => {
    it('memberCount reflects actual member records', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.memberCount).toBe(2); // owner + member
    });

    it('channelCount reflects actual channel records', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.channelCount).toBe(1);
    });

    it('topUsers is an array', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(Array.isArray(res.body.topUsers)).toBe(true);
    });

    it('topUsers includes users who sent recent messages', async () => {
      await db.messages.insert({
        _id: uuidv4(), channelId, serverId,
        userId: ownerId, username: 'owner', displayName: 'Owner',
        content: 'hi', type: 'normal', reactions: {}, createdAt: Date.now(),
      });

      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.topUsers.length).toBeGreaterThan(0);
      expect(res.body.topUsers[0]).toHaveProperty('msgCount');
      expect(res.body.topUsers[0]).toHaveProperty('userId');
    });

    it('totalMessages is a number', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(typeof res.body.totalMessages).toBe('number');
    });

    it('topUsers capped at 10 even with many active users', async () => {
      for (let i = 0; i < 15; i++) {
        const uid = uuidv4();
        await db.messages.insert({
          _id: uuidv4(), channelId, serverId,
          userId: uid, username: `user${i}`, displayName: `User ${i}`,
          content: 'msg', type: 'normal', reactions: {}, createdAt: Date.now(),
        });
      }
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.topUsers.length).toBeLessThanOrEqual(10);
    });
  });
  describe('strict analytics query parsing', () => {
    it.each(['-1', '0', '1.5', '10oops', '9007199254740992'])('rejects malformed days=%s', async (days) => {
      for (const suffix of ['stats/growth', 'stats/export.csv']) {
        const res = await request(app)
          .get(`/api/servers/${serverId}/${suffix}?days=${encodeURIComponent(days)}`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(res.status).toBe(400);
      }
    });
  });

});

