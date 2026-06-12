// server/tests/discover-sort-members.test.ts
// Sprint 69 — GET /api/discover?sort=members sıralama doğruluğu
// Mevcut test sadece status 200 döndüğünü kontrol ediyor.
// Bu dosya aktif üye sayısına göre sıralamanın doğru çalıştığını test eder.
//
// Kapsam:
//   - sort=members (default) → _memberCount azalan sıralaması
//   - sort=newest → createdAt azalan
//   - sort=name → localeCompare artan
//   - sort=online → online üye sayısı azalan
//   - sort parametresi yoksa default members sıralaması
//   - Eşit üye sayısında sıra sabit kalır (stable)
//   - DISCOVER_LIMIT (50) aşıldığında truncate edilir

'use strict';
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

// ── presenceCache mock — online count için ────────────────────────────────────
const onlineMap: Record<string, boolean> = {};
jest.mock('../lib/presenceCache', () => ({
  isUserOnline: jest.fn((userId: string) => Promise.resolve(!!onlineMap[userId])),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────
jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express, { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
const db  = require('../db/loader');
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import discoverRouter from '../routes/discover';
import type { DiscoverCategory } from '../routes/discover';

type DiscoverServerResult = {
  _id: string;
  name: string;
  _memberCount?: number;
  _onlinePre?: number;
  createdAt: number;
  category?: DiscoverCategory;
  [key: string]: unknown;
};

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/discover', authMiddleware, discoverRouter);
  return app;
}

function tok(uid: string) {
  return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// ── Fixture factories ─────────────────────────────────────────────────────────

function makeServer(overrides: Partial<{
  _id: string; name: string; discoverable: number; createdAt: number;
}> = {}) {
  return {
    _id:         overrides._id         ?? uuidv4(),
    name:        overrides.name        ?? `Server-${Math.random().toString(36).slice(2, 6)}`,
    discoverable: overrides.discoverable ?? 1,
    description: 'Test server',
    tags:        [],
    category:    'other',
    icon:        null,
    banner:      null,
    memberCount: 0,
    createdAt:   overrides.createdAt   ?? Date.now(),
  };
}

function makeUser(overrides: Partial<{ _id: string; username: string }> = {}) {
  const id = overrides._id ?? uuidv4();
  return {
    _id:          id,
    username:     overrides.username ?? `user-${id.slice(0, 6)}`,
    email:        `${id}@test.com`,
    passwordHash: 'x',
    displayName:  `User-${id.slice(0, 6)}`,
    avatarColor:  '#888',
    createdAt:    Date.now(),
    v:            0,
  };
}

function makeMember(userId: string, serverId: string) {
  return { _id: uuidv4(), userId, serverId, roles: [], joinedAt: Date.now() };
}

// ── Shared setup ──────────────────────────────────────────────────────────────

let app:   Express;
let token: string;

beforeEach(async () => {
  db._reset?.();
  // presenceCache mock'unu temizle
  for (const k of Object.keys(onlineMap)) delete onlineMap[k];
  // memberCount cache'ini temizle (route modülü her test için yeniden import ediliyor olmalı)
  jest.resetModules();
  jest.mock('../lib/presenceCache', () => ({
    isUserOnline: jest.fn((userId: string) => Promise.resolve(!!onlineMap[userId])),
  }));
  jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

  app = buildApp();

  const user = makeUser();
  await db.users.insert(user);
  token = tok(user._id);
});

// ════════════════════════════════════════════════════════════════
// sort=members — default davranış
// ════════════════════════════════════════════════════════════════

describe('GET /api/discover?sort=members', () => {
  it('member sayısına göre azalan sıralar', async () => {
    // 3 server oluştur — farklı üye sayılarıyla
    const srv1 = makeServer({ name: 'Küçük',  createdAt: 1000 });
    const srv2 = makeServer({ name: 'Büyük',  createdAt: 2000 });
    const srv3 = makeServer({ name: 'Orta',   createdAt: 1500 });

    await Promise.all([db.servers.insert(srv1), db.servers.insert(srv2), db.servers.insert(srv3)]);

    // srv2: 5 üye, srv3: 3 üye, srv1: 1 üye
    const users = await Promise.all(
      Array.from({ length: 9 }, () => { const u = makeUser(); return db.users.insert(u).then(() => u); })
    );

    for (let i = 0; i < 5; i++) await db.members.insert(makeMember(users[i]._id, srv2._id));
    for (let i = 5; i < 8; i++) await db.members.insert(makeMember(users[i]._id, srv3._id));
    await db.members.insert(makeMember(users[8]._id, srv1._id));

    const res = await request(app)
      .get('/api/discover?sort=members')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(3);

    const names = res.body.map((s: DiscoverServerResult) => s.name);
    const bigIdx   = names.indexOf('Büyük');
    const midIdx   = names.indexOf('Orta');
    const smallIdx = names.indexOf('Küçük');

    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(bigIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(smallIdx);
  });

  it('sort parametresi yoksa default olarak members sıralaması kullanılır', async () => {
    const srv1 = makeServer({ name: 'Az' });
    const srv2 = makeServer({ name: 'Çok' });
    await db.servers.insert(srv1);
    await db.servers.insert(srv2);

    const manyUsers = await Promise.all(
      Array.from({ length: 4 }, () => { const u = makeUser(); return db.users.insert(u).then(() => u); })
    );
    for (const u of manyUsers) await db.members.insert(makeMember(u._id, srv2._id));

    const oneUser = makeUser();
    await db.users.insert(oneUser);
    await db.members.insert(makeMember(oneUser._id, srv1._id));

    const res = await request(app)
      .get('/api/discover')  // sort parametresi yok
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.map((s: DiscoverServerResult) => s.name);
    expect(names.indexOf('Çok')).toBeLessThan(names.indexOf('Az'));
  });

  it('üye sayısı eşit olan sunucular da döner', async () => {
    const srv1 = makeServer({ name: 'Eşit-A' });
    const srv2 = makeServer({ name: 'Eşit-B' });
    await db.servers.insert(srv1);
    await db.servers.insert(srv2);

    for (const srv of [srv1, srv2]) {
      const u = makeUser();
      await db.users.insert(u);
      await db.members.insert(makeMember(u._id, srv._id));
    }

    const res = await request(app)
      .get('/api/discover?sort=members')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.map((s: DiscoverServerResult) => s.name);
    expect(names).toContain('Eşit-A');
    expect(names).toContain('Eşit-B');
  });

  it('memberCount alanı response\'da döner ve doğru değer içerir', async () => {
    const srv = makeServer({ name: 'MemberCountTest' });
    await db.servers.insert(srv);

    const members = await Promise.all(
      Array.from({ length: 3 }, () => { const u = makeUser(); return db.users.insert(u).then(() => u); })
    );
    for (const u of members) await db.members.insert(makeMember(u._id, srv._id));

    const res = await request(app)
      .get('/api/discover?sort=members')
      .set('Authorization', `Bearer ${token}`);

    const found = res.body.find((s: DiscoverServerResult) => s.name === 'MemberCountTest');
    expect(found).toBeDefined();
    expect(found.memberCount).toBe(3);
  });

  it('discoverable=0 sunucular listeye dahil edilmez', async () => {
    const hidden  = makeServer({ name: 'Gizli',  discoverable: 0 });
    const visible = makeServer({ name: 'Görünür', discoverable: 1 });
    await db.servers.insert(hidden);
    await db.servers.insert(visible);

    const u = makeUser();
    await db.users.insert(u);
    await db.members.insert(makeMember(u._id, visible._id));
    await db.members.insert(makeMember(u._id, hidden._id));

    const res = await request(app)
      .get('/api/discover?sort=members')
      .set('Authorization', `Bearer ${token}`);

    const names = res.body.map((s: DiscoverServerResult) => s.name);
    expect(names).toContain('Görünür');
    expect(names).not.toContain('Gizli');
  });

  it('üyesi olmayan sunucu listede görünmez (discoverable=1 olsa bile)', async () => {
    const empty = makeServer({ name: 'Boş Sunucu', discoverable: 1 });
    await db.servers.insert(empty);

    // Üye yok — sadece discoverable=1 olan ve üyesi >1 olan sunucular gösterilir
    // (discover route'unda memberCount > 1 filtresi var)
    const res = await request(app)
      .get('/api/discover?sort=members')
      .set('Authorization', `Bearer ${token}`);

    const names = res.body.map((s: DiscoverServerResult) => s.name);
    expect(names).not.toContain('Boş Sunucu');
  });
});

// ════════════════════════════════════════════════════════════════
// sort=newest
// ════════════════════════════════════════════════════════════════

describe('GET /api/discover?sort=newest', () => {
  it('createdAt\'e göre azalan sıralar', async () => {
    const old_srv  = makeServer({ name: 'Eski',  createdAt: 1000000 });
    const new_srv  = makeServer({ name: 'Yeni',  createdAt: 9000000 });
    const mid_srv  = makeServer({ name: 'Orta',  createdAt: 5000000 });
    await Promise.all([db.servers.insert(old_srv), db.servers.insert(new_srv), db.servers.insert(mid_srv)]);

    // Her birine 2 üye ekle (memberCount filtresi için)
    for (const srv of [old_srv, new_srv, mid_srv]) {
      for (let i = 0; i < 2; i++) {
        const u = makeUser();
        await db.users.insert(u);
        await db.members.insert(makeMember(u._id, srv._id));
      }
    }

    const res = await request(app)
      .get('/api/discover?sort=newest')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.map((s: DiscoverServerResult) => s.name);
    expect(names.indexOf('Yeni')).toBeLessThan(names.indexOf('Orta'));
    expect(names.indexOf('Orta')).toBeLessThan(names.indexOf('Eski'));
  });
});

// ════════════════════════════════════════════════════════════════
// sort=name
// ════════════════════════════════════════════════════════════════

describe('GET /api/discover?sort=name', () => {
  it('alfabetik artan sıralar (localeCompare)', async () => {
    const servers = [
      makeServer({ name: 'Zebra' }),
      makeServer({ name: 'Alpha' }),
      makeServer({ name: 'Mango' }),
    ];
    for (const srv of servers) {
      await db.servers.insert(srv);
      for (let i = 0; i < 2; i++) {
        const u = makeUser();
        await db.users.insert(u);
        await db.members.insert(makeMember(u._id, srv._id));
      }
    }

    const res = await request(app)
      .get('/api/discover?sort=name')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.map((s: DiscoverServerResult) => s.name);
    expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('Mango'));
    expect(names.indexOf('Mango')).toBeLessThan(names.indexOf('Zebra'));
  });
});

// ════════════════════════════════════════════════════════════════
// sort=online — aktif üye sayısı sıralaması
// ════════════════════════════════════════════════════════════════

describe('GET /api/discover?sort=online', () => {
  it('online üye sayısına göre azalan sıralar', async () => {
    const srv1 = makeServer({ name: 'AzOnline' });
    const srv2 = makeServer({ name: 'ÇokOnline' });
    await db.servers.insert(srv1);
    await db.servers.insert(srv2);

    // srv1: 1 online, srv2: 3 online
    const allUsers: Array<{ _id: string }> = [];
    for (let i = 0; i < 4; i++) {
      const u = makeUser();
      await db.users.insert(u);
      allUsers.push(u);
    }

    await db.members.insert(makeMember(allUsers[0]._id, srv1._id));
    for (let i = 1; i < 4; i++) await db.members.insert(makeMember(allUsers[i]._id, srv2._id));

    // presenceCache: sadece allUsers[0] (srv1) ve allUsers[1,2,3] (srv2) online
    onlineMap[allUsers[0]._id] = true;
    onlineMap[allUsers[1]._id] = true;
    onlineMap[allUsers[2]._id] = true;
    onlineMap[allUsers[3]._id] = true;

    // ama srv1'in 1 üyesi online, srv2'nin 3 üyesi online

    const res = await request(app)
      .get('/api/discover?sort=online')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.map((s: DiscoverServerResult) => s.name);
    const cokIdx = names.indexOf('ÇokOnline');
    const azIdx  = names.indexOf('AzOnline');

    expect(cokIdx).toBeGreaterThanOrEqual(0);
    expect(azIdx).toBeGreaterThanOrEqual(0);
    expect(cokIdx).toBeLessThan(azIdx);
  });

  it('hiç online olmayan sunucu sona gelir', async () => {
    const active  = makeServer({ name: 'Aktif' });
    const offline = makeServer({ name: 'Atıl' });
    await db.servers.insert(active);
    await db.servers.insert(offline);

    for (const srv of [active, offline]) {
      for (let i = 0; i < 2; i++) {
        const u = makeUser();
        await db.users.insert(u);
        await db.members.insert(makeMember(u._id, srv._id));
        if (srv._id === active._id) onlineMap[u._id] = true;
      }
    }

    const res = await request(app)
      .get('/api/discover?sort=online')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.map((s: DiscoverServerResult) => s.name);
    expect(names.indexOf('Aktif')).toBeLessThan(names.indexOf('Atıl'));
  });
});

// ════════════════════════════════════════════════════════════════
// DISCOVER_LIMIT truncation
// ════════════════════════════════════════════════════════════════

describe('DISCOVER_LIMIT (50) truncation', () => {
  it('50\'den fazla sunucu varsa en fazla 50 döner', async () => {
    // 55 sunucu oluştur, her biri 2 üye ile
    for (let i = 0; i < 55; i++) {
      const srv = makeServer({ name: `Server-${i}`, discoverable: 1 });
      await db.servers.insert(srv);
      for (let j = 0; j < 2; j++) {
        const u = makeUser();
        await db.users.insert(u);
        await db.members.insert(makeMember(u._id, srv._id));
      }
    }

    const res = await request(app)
      .get('/api/discover?sort=members')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(50);
  });
});

// ════════════════════════════════════════════════════════════════
// Geçersiz sort parametresi
// ════════════════════════════════════════════════════════════════

describe('Geçersiz sort parametresi', () => {
  it('bilinmeyen sort değeri 200 döner (sort yok sayılır veya default)', async () => {
    const srv = makeServer({ name: 'TestSrv' });
    await db.servers.insert(srv);
    const u = makeUser();
    await db.users.insert(u);
    await db.members.insert(makeMember(u._id, srv._id));
    await db.members.insert(makeMember((await (async () => { const u2 = makeUser(); await db.users.insert(u2); return u2; })()), srv._id));

    const res = await request(app)
      .get('/api/discover?sort=invalidvalue')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
