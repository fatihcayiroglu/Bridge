// server/tests/serverTemplates.test.ts
// Kapsamlı testler: DB tabanlı şablon sistemi, sistem mesajı, CRUD, apply
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';

// Her testten önce seed durumunu sıfırla
let templatesRouter: typeof import('../routes/serverTemplates');
function loadRouter() {
  jest.resetModules();
  jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
  templatesRouter = require('../routes/serverTemplates');
  return templatesRouter;
}

// `require()` bir MODUL dondurur; router `default` altinda ya da modulun
// kendisi olabilir. Imza bu gercegi yazar.
function buildApp(router: express.Router | { default?: express.Router }) {
  const app = express();
  app.use(express.json());
  // `require()` CommonJS modulu dondurur: router ya modulun kendisidir ya da
  // `default` altindadir (routes/serverTemplates.ts ikisini de yazar).
  const mounted = 'default' in router && router.default ? router.default : (router as express.Router);
  app.use('/api/server-templates', mounted);
  return app;
}
function tok(uid: string, v = 0) {
  return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('Server Templates — DB Tabanlı (v57)', () => {
  let app: express.Express;
  let userId: string;
  let userToken: string;
  let otherUserId: string;
  let otherToken: string;

  beforeEach(async () => {
    db._reset?.();
    // router'ı her testte taze yükle (seed state sıfırlansın)
    jest.isolateModules(() => {
      templatesRouter = require('../routes/serverTemplates');
    });
    app         = buildApp(templatesRouter);
    userId      = uuidv4();
    otherUserId = uuidv4();
    userToken   = tok(userId);
    otherToken  = tok(otherUserId);

    await db.users.insert({ _id: userId,      username: 'alice', displayName: 'Alice', tokenVersion: 0 });
    await db.users.insert({ _id: otherUserId, username: 'bob',   displayName: 'Bob',   tokenVersion: 0 });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/server-templates — Liste
  // ─────────────────────────────────────────────────────────────
  describe('GET /api/server-templates', () => {
    it('seed sonrası yerleşik şablonları döner', async () => {
      const res = await request(app)
        .get('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(5); // 5 seed şablonu
    });

    it('her şablonda gerekli alanlar vardır', async () => {
      const res = await request(app)
        .get('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`);
      for (const t of res.body) {
        expect(t).toHaveProperty('id');
        expect(t).toHaveProperty('name');
        expect(t).toHaveProperty('icon');
        expect(t).toHaveProperty('description');
        expect(Array.isArray(t.tags)).toBe(true);
      }
    });

    it('liste yanıtında categories alanı bulunmaz (hafif yanıt)', async () => {
      const res = await request(app)
        .get('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      for (const t of res.body) {
        expect(t).not.toHaveProperty('categories');
      }
    });

    it('kimlik doğrulaması olmadan 401 döner', async () => {
      const res = await request(app).get('/api/server-templates');
      expect(res.status).toBe(401);
    });

    it('seed iki kez çalıştırılmaz (tekrarsız kayıt)', async () => {
      await request(app)
        .get('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`);
      const rows1 = await db.serverTemplates.find({});

      await request(app)
        .get('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`);
      const rows2 = await db.serverTemplates.find({});

      expect(rows1.length).toBe(rows2.length);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/server-templates/:id — Detay
  // ─────────────────────────────────────────────────────────────
  describe('GET /api/server-templates/:id', () => {
    it('bilinen şablon için categories de döner', async () => {
      const res = await request(app)
        .get('/api/server-templates/gaming')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('categories');
      expect(Array.isArray(res.body.categories)).toBe(true);
      expect(res.body.categories.length).toBeGreaterThan(0);
    });

    it('bilinmeyen id için 404 döner', async () => {
      const res = await request(app)
        .get('/api/server-templates/yok-boyle-bir-sablon')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(404);
    });

    it('kimlik doğrulaması olmadan 401 döner', async () => {
      const res = await request(app).get('/api/server-templates/gaming');
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /api/server-templates — Şablon oluştur
  // ─────────────────────────────────────────────────────────────
  describe('POST /api/server-templates', () => {
    const validPayload = {
      name:        'Özel Şablonum',
      icon:        '🦊',
      description: 'Test şablonu',
      tags:        ['test'],
      categories:  [{ name: 'GENEL', channels: [{ name: 'genel', type: 'text' }] }],
    };

    it('geçerli verilerle şablon oluşturur', async () => {
      const res = await request(app)
        .post('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`)
        .send(validPayload);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.name).toBe('Özel Şablonum');
      expect(res.body.createdBy).toBe(userId);
      expect(Array.isArray(res.body.categories)).toBe(true);
    });

    it('oluşturulan şablon DB\'ye kaydedilir', async () => {
      const res = await request(app)
        .post('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`)
        .send(validPayload);
      const saved = await db.serverTemplates.findOne({ _id: res.body.id });
      expect(saved).not.toBeNull();
      expect(saved.name).toBe('Özel Şablonum');
    });

    it('isim olmadan 400 döner', async () => {
      const res = await request(app)
        .post('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ categories: [{ name: 'X', channels: [] }] });
      expect(res.status).toBe(400);
    });

    it('kategorisiz 400 döner', async () => {
      const res = await request(app)
        .post('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Test', categories: [] });
      expect(res.status).toBe(400);
    });

    it('kimlik doğrulaması olmadan 401 döner', async () => {
      const res = await request(app)
        .post('/api/server-templates')
        .send(validPayload);
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PUT /api/server-templates/:id — Güncelle
  // ─────────────────────────────────────────────────────────────
  describe('PUT /api/server-templates/:id', () => {
    let templateId: string;

    beforeEach(async () => {
      const inserted = await db.serverTemplates.insert({
        _id:        uuidv4(),
        name:       'Eski Ad',
        icon:       '🌀',
        description: 'Eski açıklama',
        tags:       '[]',
        categories: JSON.stringify([{ name: 'X', channels: [] }]),
        createdBy:  userId,
        createdAt:  Date.now(),
      });
      templateId = inserted._id;
    });

    it('oluşturan kişi güncelleyebilir', async () => {
      const res = await request(app)
        .put(`/api/server-templates/${templateId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Yeni Ad' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Yeni Ad');
    });

    it('başka kullanıcı 403 alır', async () => {
      const res = await request(app)
        .put(`/api/server-templates/${templateId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ name: 'Hack' });
      expect(res.status).toBe(403);
    });

    it('mevcut olmayan şablon için 404 döner', async () => {
      const res = await request(app)
        .put(`/api/server-templates/${uuidv4()}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Test' });
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // DELETE /api/server-templates/:id
  // ─────────────────────────────────────────────────────────────
  describe('DELETE /api/server-templates/:id', () => {
    let templateId: string;

    beforeEach(async () => {
      const inserted = await db.serverTemplates.insert({
        _id:        uuidv4(),
        name:       'Silinecek',
        icon:       '🗑️',
        description: '',
        tags:       '[]',
        categories: '[]',
        createdBy:  userId,
        createdAt:  Date.now(),
      });
      templateId = inserted._id;
    });

    it('oluşturan kişi silebilir', async () => {
      const res = await request(app)
        .delete(`/api/server-templates/${templateId}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const check = await db.serverTemplates.findOne({ _id: templateId });
      expect(check).toBeNull();
    });

    it('başka kullanıcı 403 alır', async () => {
      const res = await request(app)
        .delete(`/api/server-templates/${templateId}`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(res.status).toBe(403);
    });

    it('mevcut olmayan şablon için 404 döner', async () => {
      const res = await request(app)
        .delete(`/api/server-templates/${uuidv4()}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /api/server-templates/:id/apply — Uygula
  // ─────────────────────────────────────────────────────────────
  describe('POST /api/server-templates/:id/apply', () => {
    it('gaming şablonundan sunucu oluşturur', async () => {
      const res = await request(app)
        .post('/api/server-templates/gaming/apply')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Benim Gaming Sunucum' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('server');
      expect(res.body.server.name).toBe('Benim Gaming Sunucum');
      expect(res.body.template.id).toBe('gaming');
    });

    it('apply sonrası kanallar oluşturulur', async () => {
      const res = await request(app)
        .post('/api/server-templates/gaming/apply')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Gaming' });
      const channels = await db.channels.find({ serverId: res.body.server._id });
      expect(channels.length).toBeGreaterThan(0);
    });

    it('apply sonrası kullanıcı üye olarak eklenir', async () => {
      const res = await request(app)
        .post('/api/server-templates/gaming/apply')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Gaming' });
      const member = await db.members.findOne({ serverId: res.body.server._id, userId });
      expect(member).not.toBeNull();
    });

    it('apply sonrası sistem mesajı ilk text kanalına yazılır', async () => {
      const res = await request(app)
        .post('/api/server-templates/education/apply')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Çalışma Sunucusu' });

      expect(res.status).toBe(200);
      const serverId = res.body.server._id;

      // İlk text kanalını bul
      const channels = await db.channels.find({ serverId, type: 'text' });
      expect(channels.length).toBeGreaterThan(0);
      const firstChannel = channels[0];

      // Sistem mesajı kontrolü
      const sysMsg = await db.messages.findOne({ channelId: firstChannel._id, type: 'system' });
      expect(sysMsg).not.toBeNull();
      expect(sysMsg.userId).toBe('system');
      expect(sysMsg.displayName).toBe('Bridge');
      expect(sysMsg.content).toContain('Çalışma Sunucusu');
      expect(sysMsg.content).toContain('📚'); // education ikonu
    });

    it('sistem mesajı sunucu adını ve şablon ikonunu içerir', async () => {
      const res = await request(app)
        .post('/api/server-templates/tech/apply')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Dev Hub' });

      const serverId = res.body.server._id;
      const channels = await db.channels.find({ serverId, type: 'text' });
      const sysMsg   = await db.messages.findOne({ channelId: channels[0]._id, type: 'system' });

      expect(sysMsg.content).toContain('Dev Hub');
      expect(sysMsg.content).toContain('💻'); // tech ikonu
    });

    it('sunucu adı olmadan da şablon adını kullanır', async () => {
      const res = await request(app)
        .post('/api/server-templates/art/apply')
        .set('Authorization', `Bearer ${userToken}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.server.name).toBeTruthy();
    });

    it('bilinmeyen şablon id için 404 döner', async () => {
      const res = await request(app)
        .post('/api/server-templates/yok/apply')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Test' });
      expect(res.status).toBe(404);
    });

    it('kimlik doğrulaması olmadan 401 döner', async () => {
      const res = await request(app)
        .post('/api/server-templates/gaming/apply')
        .send({ name: 'Test' });
      expect(res.status).toBe(401);
    });

    it('custom (kullanıcı tarafından oluşturulan) şablon uygulanabilir', async () => {
      // Önce custom şablon oluştur
      const createRes = await request(app)
        .post('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name:       'Özel Şablonum',
          icon:       '🦊',
          description: 'Test',
          categories: [{ name: 'GENEL', channels: [{ name: 'genel', type: 'text' }] }],
        });
      expect(createRes.status).toBe(201);

      // Sonra uygula
      const applyRes = await request(app)
        .post(`/api/server-templates/${createRes.body.id}/apply`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ name: 'Foxland' });
      expect(applyRes.status).toBe(200);
      expect(applyRes.body.server.name).toBe('Foxland');
    });
  });

  describe('runtime input and persisted-state boundaries', () => {
    const validCategories = [{ name: 'GENEL', channels: [{ name: 'genel', type: 'text' }] }];

    it.each([
      [{ name: 7, categories: validCategories }, /ad|required/i],
      [{ name: 'safe', icon: { value: 'x' }, categories: validCategories }, /icon/i],
      [{ name: 'safe', description: ['x'], categories: validCategories }, /description/i],
      [{ name: 'safe', tags: 'tag', categories: validCategories }, /tags/i],
      [{ name: 'safe', tags: ['ok', 7], categories: validCategories }, /tags/i],
    ])('rejects malformed create metadata %# instead of coercing it', async (body, pattern) => {
      const res = await request(app).post('/api/server-templates')
        .set('Authorization', `Bearer ${userToken}`).send(body);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(pattern);
    });

    it('rejects malformed update metadata rather than persisting object stringification', async () => {
      const inserted = await db.serverTemplates.insert({
        _id: uuidv4(), name: 'Safe', icon: '🌐', description: '', tags: '[]',
        categories: JSON.stringify(validCategories), createdBy: userId, createdAt: Date.now(),
      });
      for (const body of [{ name: 7 }, { icon: {} }, { description: [] }, { tags: 'tag' }, { categories: 'bad' }]) {
        const res = await request(app).put(`/api/server-templates/${inserted._id}`)
          .set('Authorization', `Bearer ${userToken}`).send(body);
        expect(res.status).toBe(400);
      }
    });

    it('fails safe on corrupt stored tags/categories instead of taking down list/detail', async () => {
      const inserted = await db.serverTemplates.insert({
        _id: uuidv4(), name: 'Corrupt legacy', icon: '🌐', description: '',
        tags: '{broken', categories: '{broken', createdBy: userId, createdAt: Date.now(),
      });
      const list = await request(app).get('/api/server-templates').set('Authorization', `Bearer ${userToken}`);
      expect(list.status).toBe(200);
      const row = list.body.find((x: any) => x.id === inserted._id);
      expect(row?.tags).toEqual([]);

      const detail = await request(app).get(`/api/server-templates/${inserted._id}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.tags).toEqual([]);
      expect(detail.body.categories).toEqual([]);
    });
  });

});
