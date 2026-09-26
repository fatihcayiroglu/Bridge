// server/tests/servers-core-member-listing-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SUNUCU ÇEKİRDEĞİ — ÜYE LİSTESİ, TAKMA AD VE SUNUCU KİMLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/servers.test.ts` CRUD mutlu yollarını ölçer. Bu tamamlayıcı takım,
// listeleme ve kimlik alanlarının KENAR şekillerini ölçer:
//
//   · ÜYE LİSTESİ. Üyelik satırı var ama kullanıcı satırı silinmişse liste
//     ÇÖKMEMELİ, o satır atlanmalıdır. Takma ad yalnızca VARSA eklenir; boş
//     bir takma ad gerçek adı gölgelememelidir.
//   · SIRALAMA. Sunucu listesi katılım/oluşturma zamanına göre kararlıdır;
//     zaman damgası olmayan bir sunucu sıralamayı bozmamalıdır.
//   · TAKMA AD YETKİSİ. Kendi takma adını herkes değiştirebilir; BAŞKASININ
//     takma adı MANAGE_MEMBERS ister. Boş bir değer takma adı KALDIRIR.
//   · SUNUCU KİMLİĞİ. İkon tek bir emoji ya da boştur; boşa düşen bir değer
//     varsayılana döner ve HTML asla kabul edilmez.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createMockDb, makeUser, makeServer } from './helpers/mockDb';

let mockDb: ReturnType<typeof createMockDb>;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

const memberPerms = jest.fn();
jest.mock('../routes/roles', () => ({
  getMemberPerms: (...a: unknown[]) => memberPerms(...a),
  hasPermission: (perms: number, flag: number) => (perms & flag) !== 0,
  PERMS: {
    MANAGE_CHANNELS: 32, ADMINISTRATOR: 64, SEND_MESSAGES: 2,
    KICK_MEMBERS: 8, BAN_MEMBERS: 16, MANAGE_MEMBERS: 128,
  },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import serversRouter from '../routes/servers';
import { requireDoc } from './helpers/mockDb';

const token = (userId: string, username = 'tester') =>
  jwt.sign({ id: userId, username, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

function buildApp(withIo = true) {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const app = express();
  app.set('io', withIo
    ? { to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }) }
    : null);
  app.use(express.json());
  app.use('/api/servers', serversRouter);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
  return { app, emitted };
}

let db: ReturnType<typeof createMockDb>;
let owner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;

beforeEach(async () => {
  db = createMockDb();
  mockDb = db;
  Object.assign(require('../db/index'), db);
  Object.assign(require('../db/loader'), db);
  jest.clearAllMocks();
  memberPerms.mockResolvedValue(0xFFFFFFFF);

  owner = makeUser({ username: 'owner', displayName: 'Owner' });
  member = makeUser({ username: 'member', displayName: 'Member' });
  server = makeServer(owner._id, { name: 'Core' });

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.servers.insert(server);
  await db.members.insert({ userId: owner._id, serverId: server._id, roles: '[]', joinedAt: 1 });
  await db.members.insert({ userId: member._id, serverId: server._id, roles: '[]', joinedAt: 2 });
});

const listMembers = (query = '', actor = owner) => request(buildApp().app)
  .get(`/api/servers/${server._id}/members${query}`).set('Authorization', `Bearer ${token(actor._id)}`);

describe('the compatibility member list', () => {
  it('adds a nickname only for the members that have one', async () => {
    await db.members.update({ userId: member._id, serverId: server._id }, { $set: { nickname: 'Takma' } });

    const res = await listMembers();

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((u: any) => [u._id, u]));
    expect(byId[member._id].nickname).toBe('Takma');
    expect(byId[owner._id]).not.toHaveProperty('nickname');
  });

  it('an empty nickname does not shadow the real display name', async () => {
    await db.members.update({ userId: member._id, serverId: server._id }, { $set: { nickname: '' } });
    const res = await listMembers();
    const row = res.body.find((u: any) => u._id === member._id);
    expect(row).not.toHaveProperty('nickname');
    expect(row.displayName).toBe('Member');
  });

  it('never exposes the password hash', async () => {
    const res = await listMembers();
    expect(res.body.every((u: any) => !('password' in u))).toBe(true);
  });

  it('a non-member cannot read the list', async () => {
    const stranger = makeUser({ username: 'stranger' });
    await db.users.insert(stranger);
    const res = await listMembers('', stranger);
    expect(res.status).toBe(403);
  });
});

describe('the paginated member list', () => {
  it('skips a membership whose user row is gone rather than emitting a hole', async () => {
    await db.members.insert({ userId: 'ghost-user', serverId: server._id, roles: '[]', joinedAt: 3 });

    const res = await listMembers('?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m._id).sort())
      .toEqual([member._id, owner._id].sort());
  });

  it('carries a nickname through the paginated shape too', async () => {
    await db.members.update({ userId: member._id, serverId: server._id }, { $set: { nickname: 'Takma' } });
    const res = await listMembers('?limit=10');
    const row = res.body.members.find((m: any) => m._id === member._id);
    expect(row.nickname).toBe('Takma');
  });

  it('an empty nickname is not carried through', async () => {
    await db.members.update({ userId: member._id, serverId: server._id }, { $set: { nickname: '' } });
    const res = await listMembers('?limit=10');
    const row = res.body.members.find((m: any) => m._id === member._id);
    expect(row).not.toHaveProperty('nickname');
  });

  const badLimits = ['?limit=abc', '?limit=0', '?limit=101', '?limit=1.5', '?limit=-1'];
  for (const query of badLimits) {
    it(`refuses "${query}"`, async () => {
      const res = await listMembers(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit must be an integer between 1 and 100/);
    });
  }

  const badCursors = [
    '?cursor=',
    `?cursor=${'x'.repeat(513)}`,
    '?cursor=not-base64!!',
    `?cursor=${Buffer.from('null').toString('base64')}`,
    `?cursor=${Buffer.from(JSON.stringify({ joinedAt: 'soon', userId: 'u' })).toString('base64')}`,
    `?cursor=${Buffer.from(JSON.stringify({ joinedAt: -1, userId: 'u' })).toString('base64')}`,
    `?cursor=${Buffer.from(JSON.stringify({ joinedAt: 1, userId: '' })).toString('base64')}`,
    `?cursor=${Buffer.from(JSON.stringify({ joinedAt: 1, userId: 'x'.repeat(201) })).toString('base64')}`,
  ];
  for (const query of badCursors) {
    it(`refuses a malformed cursor: ${query.slice(0, 28)}…`, async () => {
      const res = await listMembers(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid cursor');
    });
  }

  it('pages through the members with a usable cursor', async () => {
    const first = await listMembers('?limit=1');
    expect(first.status).toBe(200);
    expect(first.body.members).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await listMembers(`?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.status).toBe(200);
    expect(second.body.members[0]._id).not.toBe(first.body.members[0]._id);
  });

  it('the last page advertises no further cursor', async () => {
    const res = await listMembers('?limit=100');
    expect(res.body.members).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();
  });
});

describe('the server list', () => {
  it('orders by creation time and tolerates servers with none recorded', async () => {
    const older = makeServer(owner._id, { name: 'Older' });
    const undated = makeServer(owner._id, { name: 'Undated' });
    await db.servers.insert({ ...older, createdAt: 1 });
    await db.servers.insert({ ...undated, createdAt: undefined });
    await db.servers.update({ _id: server._id }, { $set: { createdAt: 9_000 } });
    for (const s of [older, undated]) {
      await db.members.insert({ userId: owner._id, serverId: s._id, roles: '[]', joinedAt: 1 });
    }

    const res = await request(buildApp().app).get('/api/servers')
      .set('Authorization', `Bearer ${token(owner._id)}`);

    expect(res.status).toBe(200);
    const names = res.body.map((s: any) => s.name);
    expect(names).toHaveLength(3);
    expect(names.indexOf('Older')).toBeLessThan(names.indexOf('Core'));
    expect(names).toContain('Undated');
  });
});

describe('renaming a server', () => {
  const patch = (body: object, actor = owner) => request(buildApp().app)
    .patch(`/api/servers/${server._id}`).set('Authorization', `Bearer ${token(actor._id)}`).send(body);

  it('refuses a name longer than the stored column allows', async () => {
    const res = await patch({ name: 'n'.repeat(51) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long \(max 50\)/);
  });

  it('accepts a name at the boundary and trims it', async () => {
    const res = await patch({ name: `  ${'n'.repeat(50)}  ` });
    expect(res.status).toBe(200);
    const row = await requireDoc(db.servers, { _id: server._id });
    expect(row.name).toBe('n'.repeat(50));
  });

  it('a blank name changes nothing and says so', async () => {
    const res = await patch({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing to update');
    const row = await requireDoc(db.servers, { _id: server._id });
    expect(row.name).toBe('Core');
  });

  it('an array body is read as an empty patch', async () => {
    const res = await patch([]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing to update');
  });

  const badTypes: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a numeric name', { name: 5 }, /Server name must be a string/],
    ['a numeric icon', { icon: 5 }, /Server icon must be a string/],
  ];
  for (const [name, body, message] of badTypes) {
    it(`refuses ${name}`, async () => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });
  }

  it('refuses an icon containing markup', async () => {
    const res = await patch({ icon: '<img src=x onerror=alert(1)>' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid icon value');
  });

  it('a non-owner cannot rename', async () => {
    const res = await patch({ name: 'Hijack' }, member);
    expect(res.status).toBe(403);
  });
});

describe('creating a server', () => {
  const create = (body: object) => request(buildApp().app)
    .post('/api/servers').set('Authorization', `Bearer ${token(owner._id)}`).send(body);

  it('an icon that trims away falls back to the default globe', async () => {
    const res = await create({ name: 'Iconless', icon: '   ' });
    expect(res.status).toBe(200);
    const row = await requireDoc(db.servers, { name: 'Iconless' });
    expect(row.icon).toBe('🌐');
  });

  it('an icon containing markup is refused outright', async () => {
    const res = await create({ name: 'Evil', icon: '<script>' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid icon value');
  });
});

describe('nicknames', () => {
  const setNickname = (targetId: string, body: object, actor = owner, withIo = true) => {
    const built = buildApp(withIo);
    return {
      emitted: built.emitted,
      send: request(built.app)
        .patch(`/api/servers/${server._id}/members/${targetId}/nickname`)
        .set('Authorization', `Bearer ${token(actor._id)}`).send(body),
    };
  };

  it('a member may set their own nickname without any permission', async () => {
    memberPerms.mockResolvedValue(0);
    const { send } = setNickname(member._id, { nickname: '  Yeni Ad  ' }, member);
    const res = await send;
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe('Yeni Ad');
    expect(memberPerms).not.toHaveBeenCalled();
  });

  it('changing someone else\'s nickname requires MANAGE_MEMBERS', async () => {
    memberPerms.mockResolvedValue(0);
    const { send } = setNickname(member._id, { nickname: 'Zorla' }, owner);
    const res = await send;
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/MANAGE_MEMBERS/);
  });

  it('a moderator with MANAGE_MEMBERS may change someone else\'s nickname', async () => {
    memberPerms.mockResolvedValue(128);
    const { send } = setNickname(member._id, { nickname: 'Moderatör Adı' }, owner);
    const res = await send;
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe('Moderatör Adı');
  });

  it('an empty nickname clears it rather than storing an empty string', async () => {
    const { send } = setNickname(member._id, { nickname: '' }, member);
    const res = await send;
    expect(res.body.nickname).toBeNull();
    const row = await requireDoc(db.members, { userId: member._id, serverId: server._id });
    expect(row.nickname).toBeNull();
  });

  it('a nickname is bounded to the stored column width', async () => {
    const { send } = setNickname(member._id, { nickname: 'x'.repeat(50) }, member);
    const res = await send;
    expect(res.body.nickname).toHaveLength(32);
  });

  it('the change is announced to the server room', async () => {
    const { emitted, send } = setNickname(member._id, { nickname: 'Duyuru' }, member);
    await send;
    expect(emitted).toEqual([{
      room: `server:${server._id}`,
      event: 'member:nicknameUpdate',
      payload: { userId: member._id, serverId: server._id, nickname: 'Duyuru' },
    }]);
  });

  it('a deployment with no realtime layer still stores the change', async () => {
    const { send } = setNickname(member._id, { nickname: 'Sessiz' }, member, false);
    const res = await send;
    expect(res.status).toBe(200);
    const row = await requireDoc(db.members, { userId: member._id, serverId: server._id });
    expect(row.nickname).toBe('Sessiz');
  });
});

describe('deleting a server', () => {
  it('reports a server that vanished during the atomic delete', async () => {
    const spy = jest.spyOn(require('../db/repositories').Servers, 'deleteGraphAtomic')
      .mockResolvedValue('not_found' as never);
    try {
      const res = await request(buildApp().app).delete(`/api/servers/${server._id}`)
        .set('Authorization', `Bearer ${token(owner._id)}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Server not found');
    } finally { spy.mockRestore(); }
  });

  it('reports ownership lost during the atomic delete', async () => {
    const spy = jest.spyOn(require('../db/repositories').Servers, 'deleteGraphAtomic')
      .mockResolvedValue('owner_mismatch' as never);
    try {
      const res = await request(buildApp().app).delete(`/api/servers/${server._id}`)
        .set('Authorization', `Bearer ${token(owner._id)}`);
      expect(res.status).toBe(403);
    } finally { spy.mockRestore(); }
  });

  it('a non-owner cannot delete', async () => {
    const res = await request(buildApp().app).delete(`/api/servers/${server._id}`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(403);
  });
});

