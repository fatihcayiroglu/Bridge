// server/tests/notifications-sparse-rows.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/notifications.ts — EKSİK SÜTUNLARDA MENTION HEDEFLEME VE PUSH METNİ
// ════════════════════════════════════════════════════════════════════════════
// Mention dağıtımı iki kritik karar verir: KİME gidecek ve NE yazacak.
//
// KİME kararı `mentions` listesiyle kullanıcı adının karşılaştırılmasına
// dayanır. Kullanıcı satırında `username` yoksa (silinmiş/eksik kayıt) bu
// karşılaştırma `undefined` üzerinden yapılamaz: `'mentions'` düzeyindeki bir
// üye, ADI OLMADIĞI için mention edilmiş SAYILMAMALIDIR. Aksi hâlde tercihi
// "yalnızca mention" olan bir kullanıcıya her mesaj bildirimi giderdi.
//
// NE kararı push başlığı/gövdesidir. Gönderenin adı yoksa kullanıcı adına,
// içerik yoksa boş metne düşülür — `undefined` bir bildirimde asla görünmez.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = '12345678901234567890123456789012';

import type { PushPayload } from '../lib/pushSender';
import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
// ══════════════════════════════════════════════════════════════════════════
// IKIZLER URUN IMZALARIYLA TIPLENIR
// ══════════════════════════════════════════════════════════════════════════
// Eskiden `jest.fn()` tipsizdi ve sarmalayicilar `(...a as [])` yaziyordu.
// Iki bedeli vardi:
//   · `push.mock.calls[0][1]` "Tuple type '[]' has no element at index '1'"
//     veriyordu — cagri kaydi BOS TUPLE olarak tiplenmisti.
//   · `as []` bir CAST'tir: yukun gercekten `PushPayload` oldugunu hicbir sey
//     dogrulamiyordu.
// Ikizler urun imzasindan tiplenince kayit da doğru tiplenir: iddia degil,
// derleyici garantisi.
const push     = jest.fn<Promise<void>, [userId: string, payload: PushPayload]>(async () => {});
const cacheGet = jest.fn<Promise<unknown>, [key: string]>();
const cacheSet = jest.fn<Promise<void>, [key: string, value: unknown, ttlSeconds?: number]>();
const canView  = jest.fn<Promise<boolean>, [userId: string, channelId: string]>(async () => true);

jest.mock('../db/loader', () => mockDb);
jest.mock('../lib/pushSender', () => ({
  sendPushToUser: (userId: string, payload: PushPayload) => push(userId, payload),
}));
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get: (key: string) => cacheGet(key),
    set: (key: string, value: unknown, ttlSeconds?: number) => cacheSet(key, value, ttlSeconds),
    invalidatePattern: jest.fn(), delete: jest.fn(),
  },
}));
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, canViewChannel: (userId: string, channelId: string) => canView(userId, channelId) };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Notifications } from '../db/repositories';
import {
  processNotifications, deliverPushBatched, getUnreadCounts,
  __pendingPushForTest, __PUSH_DEBOUNCE_MS, pushRouter,
} from '../lib/notifications';

function io() {
  const emitted: Array<{ target: string; event: string; data: unknown }> = [];
  return { emitted, to: (target: string) => ({ emit: (event: string, data: unknown) => emitted.push({ target, event, data }) }) };
}

const msg = (overrides: Record<string, unknown> = {}) => ({
  _id: 'm1', content: '@alice hello', channelId: 'c1', serverId: 'spoofed',
  userId: 'sender', displayName: 'Sender', createdAt: 10, ...overrides,
});

async function seed() {
  await mockDb.users.insert({ _id: 'sender', username: 'sender' });
  await mockDb.users.insert({ _id: 'u1', username: 'alice', tokenVersion: 0 });
  await mockDb.users.insert({ _id: 'u-nameless' });
  await mockDb.servers.insert({ _id: 's1', ownerId: 'sender' });
  await mockDb.channels.insert({ _id: 'c1', serverId: 's1', name: 'general' });
  for (const userId of ['sender', 'u1', 'u-nameless']) {
    await mockDb.members.insert({ userId, serverId: 's1', roles: [] });
  }
}

beforeEach(async () => {
  mockDb._reset();
  jest.clearAllMocks();
  __pendingPushForTest.clear();
  canView.mockResolvedValue(true);
  cacheGet.mockResolvedValue(null);
  cacheSet.mockResolvedValue(undefined);
  await seed();
});

afterEach(() => {
  for (const pending of __pendingPushForTest.values()) if (pending.timer) clearTimeout(pending.timer);
  __pendingPushForTest.clear();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('mention targeting with incomplete user rows', () => {
  it('never treats a nameless member as mentioned when their level is mentions-only', async () => {
    await Notifications.upsertPref('u-nameless', 'c1', { level: 'mentions' });
    await processNotifications(msg({ content: '@alice hi' }), io(), new Map());
    expect(await mockDb.notifications.find({ userId: 'u-nameless' })).toHaveLength(0);
    expect(await mockDb.notifications.find({ userId: 'u1' })).toHaveLength(1);
  });

  it('still delivers an @everyone mention to a nameless member on mentions-only', async () => {
    await Notifications.upsertPref('u-nameless', 'c1', { level: 'mentions' });
    await processNotifications(msg({ content: '@everyone', _id: 'm2' }), io(), new Map());
    // `@everyone` kullanıcı adına DAYANMAZ; adı olmayan üye de kapsanır.
    expect(await mockDb.notifications.find({ userId: 'u-nameless' })).toHaveLength(1);
  });

  it('treats a message with no content column as having no mentions', async () => {
    const events = io();
    await processNotifications(msg({ content: undefined }), events, new Map());
    expect(events.emitted).toHaveLength(0);
    expect(await mockDb.notifications.find({})).toHaveLength(0);
  });

  it('stamps a message with no timestamp using the delivery time', async () => {
    await processNotifications(msg({ createdAt: undefined }), io(), new Map());
    const row = await mockDb.notifications.findOne({ userId: 'u1' });
    expect(row!.createdAt).toEqual(expect.any(Number));
    expect(row!.createdAt).toBeGreaterThan(0);
  });

  it('logs a per-target delivery failure with a non-Error reason without aborting the rest', async () => {
    jest.spyOn(Notifications, 'insertChannelAttention').mockRejectedValueOnce('db offline');
    await mockDb.users.insert({ _id: 'u2', username: 'bob' });
    await mockDb.members.insert({ userId: 'u2', serverId: 's1', roles: [] });
    await expect(processNotifications(msg({ content: '@alice @bob' }), io(), new Map())).resolves.toBeUndefined();
    expect(await mockDb.notifications.find({ userId: 'u2' })).toHaveLength(1);
  });

  it('suppresses delivery when the preference store rejects with a non-Error value', async () => {
    jest.spyOn(Notifications, 'prefsFind').mockImplementationOnce(() => Promise.reject('prefs offline') as never);
    const events = io();
    await processNotifications(msg(), events, new Map());
    expect(events.emitted).toHaveLength(0);
    expect(await mockDb.notifications.find({})).toHaveLength(0);
  });

  it('treats an absent preference result set as no stored preferences', async () => {
    jest.spyOn(Notifications, 'prefsFind').mockResolvedValueOnce(null as never);
    await processNotifications(msg(), io(), new Map());
    // Satır yoksa varsayılan teslim uygulanır; STORE erişilemiyorsa değil.
    expect(await mockDb.notifications.find({ userId: 'u1' })).toHaveLength(1);
  });
});

describe('push payload text with incomplete sender rows', () => {
  it('falls back to the username and an empty body for a single mention', async () => {
    jest.useFakeTimers();
    deliverPushBatched('u1', msg({ displayName: undefined, username: 'sender', content: undefined }));
    await jest.advanceTimersByTimeAsync(__PUSH_DEBOUNCE_MS);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1].title).toBe('sender seni mention etti');
    expect(push.mock.calls[0][1].body).toBe('');
  });

  it('falls back per message in a batched payload and never prints undefined', async () => {
    jest.useFakeTimers();
    deliverPushBatched('u1', msg({ _id: 'a', displayName: undefined, username: 'sender', content: 'one' }));
    await jest.advanceTimersByTimeAsync(50);
    deliverPushBatched('u1', msg({ _id: 'b', displayName: 'Named', content: undefined }));
    await jest.advanceTimersByTimeAsync(__PUSH_DEBOUNCE_MS * 3);
    expect(push).toHaveBeenCalledTimes(1);
    const payload = push.mock.calls[0][1];
    expect(payload.title).toContain('2 yeni mention');
    expect(payload.body).toContain('sender: one');
    expect(payload.body).toContain('Named: ');
    expect(payload.body).not.toContain('undefined');
  });

  it('names the channel by id when the channel row cannot be read', async () => {
    jest.useFakeTimers();
    await mockDb.channels.remove({ _id: 'c1' });
    deliverPushBatched('u1', msg({ _id: 'a', content: 'one' }));
    await jest.advanceTimersByTimeAsync(50);
    deliverPushBatched('u1', msg({ _id: 'b', content: 'two' }));
    await jest.advanceTimersByTimeAsync(__PUSH_DEBOUNCE_MS * 3);
    expect(push.mock.calls[0][1].title).toContain('c1');
  });
});

describe('unread state reads', () => {
  it('treats an absent unread result set as an empty map', async () => {
    jest.spyOn(Notifications, 'unreadFind').mockReturnValueOnce(Promise.resolve(null) as never);
    expect(await getUnreadCounts('u1')).toEqual({});
  });

  it('treats a rejected unread query as an empty map rather than a crash', async () => {
    jest.spyOn(Notifications, 'unreadFind').mockReturnValueOnce(Promise.reject(new Error('db')) as never);
    expect(await getUnreadCounts('u1')).toEqual({});
  });
});

describe('VAPID key endpoint', () => {
  it('reports null when no public key is configured and the value when it is', async () => {
    const app = express();
    app.use(express.json());
    app.use('/push', pushRouter);

    const previous = process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    expect((await request(app).get('/push/vapid-key')).body.publicKey).toBeNull();
    process.env.VAPID_PUBLIC_KEY = 'configured-key';
    expect((await request(app).get('/push/vapid-key')).body.publicKey).toBe('configured-key');
    if (previous === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = previous;
  });

  it.each(['ios', 'android'])('records a native %s token under its declared platform', async (platform) => {
    const app = express();
    app.use(express.json());
    app.use('/push', pushRouter);
    const bearer = `Bearer ${jwt.sign({ id: 'u1', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
    const response = await request(app).post('/push/register-native')
      .set('Authorization', bearer).send({ token: `t-${platform}`, platform });
    expect(response.status).toBe(200);
    expect((await mockDb.nativePushTokens.findOne({ token: `t-${platform}` }))?.platform).toBe(platform);
  });

  it('records a token with no declared platform as unknown', async () => {
    const app = express();
    app.use(express.json());
    app.use('/push', pushRouter);
    const bearer = `Bearer ${jwt.sign({ id: 'u1', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
    await request(app).post('/push/register-native').set('Authorization', bearer).send({ token: 't-none' });
    expect((await mockDb.nativePushTokens.findOne({ token: 't-none' }))?.platform).toBe('unknown');
  });
});
