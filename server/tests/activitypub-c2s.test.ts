// server/tests/activitypub-c2s.test.ts
// Sprint 112 — ActivityPub C2S (Client-to-Server) outbox POST endpoint testleri
// Kapsam:
//   POST /federation/users/:username/outbox
//   - 201: geçerli içerik, public/unlisted/followers görünürlük
//   - 400: içerik eksik, içerik çok uzun (>5000 karakter)
//   - 401: token yok, geçersiz token
//   - 403: başka kullanıcı adına yayın
//   - 404: kullanıcı bulunamadı
//   - deliverToFollowers çağrısı (public)
//   - insertActivity çağrısı

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.INSTANCE_URL = 'http://localhost:3001';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockUser = { _id: 'user-001', username: 'alice', displayName: 'Alice', apPublicKey: 'pk', apPrivateKey: null };
const mockUser2 = { _id: 'user-002', username: 'bob', displayName: 'Bob' };

jest.mock('../db/repositories', () => ({
  Users: {
    findByUsername: jest.fn(),
    getApPrivateKey: jest.fn().mockResolvedValue(null),
  },
  Federation: {
    insertActivity:          jest.fn().mockResolvedValue({ ok: true }),
    findApFollows:           jest.fn().mockResolvedValue([]),
    apActivitiesFind:        jest.fn().mockResolvedValue([]),
    countActivities:         jest.fn().mockResolvedValue(0),
    findApOutgoingFollows:   jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), fatal: jest.fn() },
}));

jest.mock('../routes/admin', () => ({
  checkFederationACL: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock('../lib/httpSignature', () => ({
  verifyHttpSignature: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockDeliverToFollowers = jest.fn().mockResolvedValue(undefined);
const mockDeliverApActivity  = jest.fn().mockResolvedValue(undefined);

jest.mock('../routes/federation/helpers', () => ({
  handleApFollow:       jest.fn(),
  handleApUnfollow:     jest.fn(),
  handleApAccept:       jest.fn(),
  handleApReject:       jest.fn(),
  handleApCreate:       jest.fn(),
  handleApDelete:       jest.fn(),
  deliverApActivity:    mockDeliverApActivity,
  deliverToFollowers:   mockDeliverToFollowers,
}));

import { Users, Federation } from '../db/repositories';
import apRouter from '../routes/federation/activitypub';

// ── Test App ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/federation', apRouter);

// ── Yardımcılar ──────────────────────────────────────────────────────────────

function makeToken(userId: string) {
  return jwt.sign({ id: userId }, 'test-secret', { expiresIn: '1h' });
}

// ════════════════════════════════════════════════════════════════════════════
// POST /federation/users/:username/outbox
// ════════════════════════════════════════════════════════════════════════════

describe('POST /federation/users/:username/outbox — C2S Note yayınlama', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    (Federation.insertActivity as jest.Mock).mockResolvedValue({ ok: true });
    (Federation.findApFollows   as jest.Mock).mockResolvedValue([]);
  });

  // ── 401 ─────────────────────────────────────────────────────────────────

  describe('401 — Kimlik doğrulama', () => {
    it('Authorization header yoksa 401 döner', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .send({ content: 'Merhaba!' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Authentication required/i);
    });

    it('Geçersiz JWT ile 401 döner', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', 'Bearer tamamen-gecersiz-token')
        .send({ content: 'Merhaba!' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid token/i);
    });
  });

  // ── 404 ─────────────────────────────────────────────────────────────────

  it('404 — kullanıcı bulunamadı', async () => {
    (Users.findByUsername as jest.Mock).mockResolvedValue(null);
    const token = makeToken('user-001');
    const res = await request(app)
      .post('/federation/users/nonexistent/outbox')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Merhaba!' });
    expect(res.status).toBe(404);
  });

  // ── 403 ─────────────────────────────────────────────────────────────────

  it('403 — başka kullanıcı adına yayın yapılamaz', async () => {
    (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser); // alice
    const token = makeToken('user-002'); // bob'un tokenı ile alice adına yayın
    const res = await request(app)
      .post('/federation/users/alice/outbox')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Merhaba!' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/another user/i);
  });

  // ── 400 ─────────────────────────────────────────────────────────────────

  describe('400 — Geçersiz içerik', () => {
    it('içerik eksikse 400 döner', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/content is required/i);
    });

    it('boş string içerik 400 döner', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: '   ' });
      expect(res.status).toBe(400);
    });

    it('5001 karakter içerik 400 döner', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'a'.repeat(5001) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/5000/);
    });

    it('tam 5000 karakter içerik kabul edilir', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'a'.repeat(5000) });
      expect(res.status).toBe(201);
    });
  });

  // ── 201 public ───────────────────────────────────────────────────────────

  describe('201 — Başarılı yayın', () => {
    it('public Note yayınlayınca 201 ve noteId döner', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Merhaba, federated dünya!', visibility: 'public' });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.noteId).toMatch(/\/notes\//);
      expect(res.body.id).toMatch(/\/activities\//);
      expect(res.body.published).toBeDefined();
    });

    it('insertActivity çağrılır', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Test notu' });

      expect(Federation.insertActivity).toHaveBeenCalledTimes(1);
      const call = (Federation.insertActivity as jest.Mock).mock.calls[0][0];
      expect(call.type).toBe('Create');
      expect(call.activity.object.type).toBe('Note');
      expect(call.activity.object.content).toBe('Test notu');
    });

    it('public visibility → deliverToFollowers çağrılır', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Herkese açık not', visibility: 'public' });

      expect(mockDeliverToFollowers).toHaveBeenCalledTimes(1);
      expect(mockDeliverToFollowers.mock.calls[0][0]._id).toBe('user-001');
    });

    it('unlisted visibility → deliverToFollowers çağrılır', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Listede yok ama iletiliyor', visibility: 'unlisted' });

      expect(mockDeliverToFollowers).toHaveBeenCalledTimes(1);
    });

    it('followers-only visibility → deliverApActivity per-follow çağrılır (takipçi varsa)', async () => {
      const mockFollows = [
        { actorUrl: 'https://mastodon.social/users/follower1' },
        { actorUrl: 'https://fosstodon.org/users/follower2' },
      ];
      (Federation.findApFollows as jest.Mock).mockResolvedValue(mockFollows);
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');

      await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Sadece takipçiler', visibility: 'followers' });

      expect(mockDeliverToFollowers).not.toHaveBeenCalled();
      expect(mockDeliverApActivity).toHaveBeenCalledTimes(2);
    });

    it('followers-only, hiç takipçi yoksa deliverApActivity çağrılmaz', async () => {
      (Federation.findApFollows as jest.Mock).mockResolvedValue([]);
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');

      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Sadece takipçiler ama yok', visibility: 'followers' });

      expect(res.status).toBe(201);
      expect(mockDeliverApActivity).not.toHaveBeenCalled();
    });

    it('sensitive + summary alanları Note nesnesine eklenir', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hassas içerik', sensitive: true, summary: 'CW: spoiler' });

      const call = (Federation.insertActivity as jest.Mock).mock.calls[0][0];
      expect(call.activity.object.sensitive).toBe(true);
      expect(call.activity.object.summary).toBe('CW: spoiler');
    });

    it('inReplyTo alanı Note nesnesine eklenir', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      const replyTo = 'https://mastodon.social/users/alice/statuses/12345';
      await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Yanıt veriyorum', inReplyTo: replyTo });

      const call = (Federation.insertActivity as jest.Mock).mock.calls[0][0];
      expect(call.activity.object.inReplyTo).toBe(replyTo);
    });

    it('Note to/cc dizileri public için doğru', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Public not', visibility: 'public' });

      const call = (Federation.insertActivity as jest.Mock).mock.calls[0][0];
      expect(call.activity.object.to).toContain('https://www.w3.org/ns/activitystreams#Public');
      expect(call.activity.object.cc[0]).toContain('/followers');
    });

    it('visibility belirtilmemişse varsayılan public davranışı geçerli', async () => {
      (Users.findByUsername as jest.Mock).mockResolvedValue(mockUser);
      const token = makeToken('user-001');
      const res = await request(app)
        .post('/federation/users/alice/outbox')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Varsayılan visibility' });

      expect(res.status).toBe(201);
      expect(mockDeliverToFollowers).toHaveBeenCalledTimes(1);
    });
  });
});
