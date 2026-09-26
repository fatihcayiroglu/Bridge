// server/tests/onboarding-config-validation-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ONBOARDING — YAPILANDIRMA DOĞRULAMASI VE ÇAPRAZ-SUNUCU SINIRI
// ════════════════════════════════════════════════════════════════════════════
//
// Onboarding yapılandırması iki şeyi otomatikleştirir: KANAL'a mesaj yazmak ve
// yeni üyeye ROL vermek. İkisi de başka bir sunucunun kaynağına işaret ederse
// sonuç çapraz-kiracı bir yan etkidir. Ölçülenler:
//
//   · KANAL BAĞI. `rulesChannelId` / `welcomeChannelId` bu sunucuya ait ve
//     METİN kanalı olmalıdır — hem yazarken hem de yıllar sonra karşılama
//     mesajı gönderilirken yeniden doğrulanır (kanal silinmiş/taşınmış olabilir).
//   · ROL BAĞI. `defaultRoles` bu sunucunun rolleri olmalıdır; tamamlama
//     anında hâlâ var olmayan bir rol sessizce ATLANIR, üyelik bozulmaz.
//   · SINIRLAR. Soru sayısı, cevap boyutu, rol sayısı ve mesaj uzunluğu
//     sınırlıdır: bunlar kalıcı ve her yeni üyeye okunan alanlardır.
//   · BOZUK KAYIT. JSON kolonları ayrıştırılamıyorsa boş liste okunur;
//     onboarding tamamen çökmez.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission: jest.fn(),
  PERMS: { MANAGE_SERVER: 8, ADMINISTRATOR: 1 << 30 },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../lib/logger', () => {
  const base = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() };
  // `createLogger` is a named export other modules in this graph depend on;
  // omitting it breaks the whole import chain rather than just the logging.
  return { __esModule: true, default: base, ...base, createLogger: () => base };
});

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../middleware/auth';
import onboardingRouter from '../routes/onboarding';

const db: any = require('../db/loader');
const perms: any = require('../lib/permissions');
const logger: any = require('../lib/logger').default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', authMiddleware, onboardingRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

let app: express.Express;
let ownerId: string;
let memberId: string;
let serverId: string;
let otherServerId: string;
let textChannelId: string;
let voiceChannelId: string;
let roleId: string;
let foreignRoleId: string;

beforeEach(async () => {
  db._reset?.();
  jest.clearAllMocks();
  app = buildApp();
  ownerId = uuidv4();
  memberId = uuidv4();
  serverId = uuidv4();
  otherServerId = uuidv4();
  textChannelId = uuidv4();
  voiceChannelId = uuidv4();
  roleId = uuidv4();
  foreignRoleId = uuidv4();

  await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
  await db.users.insert({ _id: memberId, username: 'member', displayName: 'Member', tokenVersion: 0 });
  await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
  await db.servers.insert({ _id: otherServerId, name: 'OtherServer', ownerId });
  await db.channels.insert({ _id: textChannelId, serverId, name: 'kurallar', type: 'text' });
  await db.channels.insert({ _id: voiceChannelId, serverId, name: 'ses', type: 'voice' });
  await db.roles.insert({ _id: roleId, serverId, name: 'Üye', permissions: 0, position: 1 });
  await db.roles.insert({ _id: foreignRoleId, serverId: otherServerId, name: 'Yabancı', permissions: 0, position: 1 });
  await db.members.insert({ userId: ownerId, serverId, roles: [] });
  await db.members.insert({ userId: memberId, serverId, roles: [] });

  perms.resolvePermissions.mockResolvedValue(8);
  perms.hasPermission.mockImplementation((p: number, flag: number) => (p & flag) !== 0);
});

const put = (body: object, actor = ownerId) =>
  request(app).put(`/api/servers/${serverId}/onboarding`).set('Authorization', `Bearer ${tok(actor)}`).send(body);
const get = (actor = memberId) =>
  request(app).get(`/api/servers/${serverId}/onboarding`).set('Authorization', `Bearer ${tok(actor)}`);
const status = (actor = memberId) =>
  request(app).get(`/api/servers/${serverId}/onboarding/status`).set('Authorization', `Bearer ${tok(actor)}`);
const complete = (body: object = {}, actor = memberId) =>
  request(app).post(`/api/servers/${serverId}/onboarding/complete`).set('Authorization', `Bearer ${tok(actor)}`).send(body);

describe('reading the configuration', () => {
  it('an unconfigured server reports disabled with documented defaults', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      welcomeMessage: 'Sunucuya hoş geldin, {user}! 👋',
      verificationLevel: 0,
      defaultRoles: [],
      questions: [],
    });
  });

  it('lists the server\'s text channels so the operator can pick one', async () => {
    const res = await get();
    expect(res.body.channels).toEqual([{ _id: textChannelId, name: 'kurallar' }]);
  });

  it('a failing channel listing still returns the configuration', async () => {
    const spy = jest.spyOn(require('../db/repositories').Channels, 'findWhere')
      .mockRejectedValue(new Error('channel store offline'));
    try {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.channels).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('a non-member cannot read the configuration', async () => {
    const stranger = uuidv4();
    await db.users.insert({ _id: stranger, username: 's', tokenVersion: 0 });
    expect((await get(stranger)).status).toBe(403);
  });

  const jsonShapes: Array<[string, unknown, unknown[]]> = [
    ['a JSON array string', '["a","b"]', ['a', 'b']],
    ['a real array', ['a'], ['a']],
    ['unparseable text', '{not json', []],
    ['a JSON object', '{"a":1}', []],
    ['null', null, []],
    ['a number', 5, []],
  ];
  for (const [name, stored, expected] of jsonShapes) {
    it(`reads stored questions given as ${name}`, async () => {
      await put({ enabled: true });
      await db.serverOnboarding.update({ serverId }, { $set: { questions: stored, defaultRoles: stored } });
      const res = await get();
      expect(res.body.questions).toEqual(expected);
      expect(res.body.defaultRoles).toEqual(expected);
    });
  }
});

describe('writing the configuration', () => {
  it('requires MANAGE_SERVER', async () => {
    perms.resolvePermissions.mockResolvedValue(0);
    const res = await put({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/MANAGE_SERVER/);
  });

  const invalid: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a non-boolean enabled', { enabled: 'yes' }, /enabled must be boolean/],
    ['a numeric rules channel', { rulesChannelId: 5 }, /rulesChannelId invalid/],
    ['a numeric welcome channel', { welcomeChannelId: 5 }, /welcomeChannelId invalid/],
    ['a non-string welcome message', { welcomeMessage: 5 }, /welcomeMessage invalid/],
    ['an over-long welcome message', { welcomeMessage: 'x'.repeat(501) }, /welcomeMessage invalid/],
    ['a fractional verification level', { verificationLevel: 1.5 }, /verificationLevel invalid/],
    ['a negative verification level', { verificationLevel: -1 }, /verificationLevel invalid/],
    ['a non-array defaultRoles', { defaultRoles: 'role' }, /defaultRoles invalid/],
    ['too many default roles', { defaultRoles: Array.from({ length: 26 }, (_, i) => `r${i}`) }, /defaultRoles invalid/],
    ['a non-string role id', { defaultRoles: [5] }, /defaultRoles invalid/],
    ['an empty role id', { defaultRoles: [''] }, /defaultRoles invalid/],
    ['a non-array questions', { questions: 'q' }, /questions invalid/],
    ['too many questions', { questions: [1, 2, 3, 4, 5, 6] }, /questions invalid/],
    ['an over-large questions payload', { questions: [{ q: 'x'.repeat(40000) }] }, /questions invalid/],
  ];
  for (const [name, body, message] of invalid) {
    it(`refuses ${name}`, async () => {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });
  }

  it('accepts an explicit null for either channel', async () => {
    const res = await put({ enabled: true, rulesChannelId: null, welcomeChannelId: null });
    expect(res.status).toBe(200);
    const row = await db.serverOnboarding.findOne({ serverId });
    expect(row.rulesChannelId).toBeNull();
    expect(row.welcomeChannelId).toBeNull();
  });

  it('refuses a channel that is not a text channel', async () => {
    const res = await put({ enabled: true, rulesChannelId: voiceChannelId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a text channel in this server/);
  });

  it('refuses a channel from another server', async () => {
    const foreignChannel = uuidv4();
    await db.channels.insert({ _id: foreignChannel, serverId: otherServerId, name: 'genel', type: 'text' });
    const res = await put({ enabled: true, welcomeChannelId: foreignChannel });
    expect(res.status).toBe(400);
  });

  it('refuses a default role from another server', async () => {
    const res = await put({ enabled: true, defaultRoles: [foreignRoleId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role outside this server/);
  });

  it('de-duplicates the stored default roles', async () => {
    const res = await put({ enabled: true, defaultRoles: [roleId, roleId] });
    expect(res.status).toBe(200);
    const row = await db.serverOnboarding.findOne({ serverId });
    expect(JSON.parse(row.defaultRoles)).toEqual([roleId]);
  });

  it('normalises omitted fields to their documented defaults', async () => {
    const res = await put({ enabled: true });
    expect(res.status).toBe(200);
    const row = await db.serverOnboarding.findOne({ serverId });
    expect(row).toMatchObject({
      enabled: true, rulesChannelId: null, welcomeChannelId: null,
      welcomeMessage: 'Sunucuya hoş geldin, {user}! 👋',
      verificationLevel: 0, defaultRoles: '[]', questions: '[]',
    });
  });

  it('an empty welcome message falls back to the default rather than being blank', async () => {
    await put({ enabled: true, welcomeMessage: '' });
    const row = await db.serverOnboarding.findOne({ serverId });
    expect(row.welcomeMessage).toBe('Sunucuya hoş geldin, {user}! 👋');
  });

  it('an array body is treated as an empty configuration', async () => {
    const res = await put([]);
    expect(res.status).toBe(200);
    const row = await db.serverOnboarding.findOne({ serverId });
    expect(row.enabled).toBe(false);
  });
});

describe('membership status', () => {
  it('reports "not required" while onboarding is off', async () => {
    const res = await status();
    expect(res.body).toEqual({ required: false });
  });

  it('reports the questions and completion state once enabled', async () => {
    await put({ enabled: true, questions: [{ q: 'Yaşın?' }], rulesChannelId: textChannelId });
    const before = await status();
    expect(before.body).toMatchObject({ required: true, completed: false, completedAt: null });
    expect(before.body.config.questions).toEqual([{ q: 'Yaşın?' }]);

    await complete({ answers: { q1: 'a' } });
    const after = await status();
    expect(after.body.completed).toBe(true);
    expect(after.body.completedAt).toEqual(expect.any(Number));
  });

  it('a non-member cannot read the status', async () => {
    const stranger = uuidv4();
    await db.users.insert({ _id: stranger, username: 's2', tokenVersion: 0 });
    expect((await status(stranger)).status).toBe(403);
  });
});

describe('completing onboarding', () => {
  it('is a no-op while onboarding is disabled', async () => {
    const res = await complete();
    expect(res.body).toEqual({ ok: true, skipped: true });
  });

  it('refuses an answers payload that is too large to store', async () => {
    await put({ enabled: true });
    const res = await complete({ answers: { blob: 'x'.repeat(70000) } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('answers too large');
  });

  it('is idempotent: a second completion reports the first one', async () => {
    await put({ enabled: true });
    expect((await complete()).body).toMatchObject({ ok: true });
    expect((await complete()).body).toEqual({ ok: true, alreadyCompleted: true });
  });

  it('assigns only the configured roles that still exist in this server', async () => {
    await put({ enabled: true, defaultRoles: [roleId] });
    // The role is removed after the configuration was written.
    await db.roles.remove({ _id: roleId });

    const res = await complete();

    expect(res.body.ok).toBe(true);
    const row = await db.members.findOne({ userId: memberId, serverId });
    expect(row.roles ?? []).not.toContain(roleId);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'onboarding.role.stale' }), expect.any(String));
  });

  it('assigns a role that is still valid', async () => {
    await put({ enabled: true, defaultRoles: [roleId] });
    const res = await complete();
    expect(res.body.ok).toBe(true);
    const row = await db.members.findOne({ userId: memberId, serverId });
    expect(row.roles).toContain(roleId);
  });

  it('a role lookup failure is logged and skipped, not fatal', async () => {
    await put({ enabled: true, defaultRoles: [roleId] });
    const spy = jest.spyOn(require('../db/repositories').Roles, 'findByIdAndServer')
      .mockRejectedValue(new Error('role store offline'));
    try {
      const res = await complete();
      expect(res.body.ok).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'onboarding.role.resolve_error' }), expect.any(String));
    } finally { spy.mockRestore(); }
  });

  it('a welcome channel that is no longer a text channel is skipped, not written to', async () => {
    await put({ enabled: true, welcomeChannelId: textChannelId });
    await db.channels.update({ _id: textChannelId }, { $set: { type: 'voice' } });

    const res = await complete();

    expect(res.body).toMatchObject({ ok: true, welcomeSkipped: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'onboarding.welcome.stale' }), expect.any(String));
  });

  it('a non-member cannot complete onboarding', async () => {
    const stranger = uuidv4();
    await db.users.insert({ _id: stranger, username: 's3', tokenVersion: 0 });
    expect((await complete({}, stranger)).status).toBe(403);
  });
});
