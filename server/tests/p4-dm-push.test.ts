// server/tests/p4-dm-push.test.ts
//
// P4-09 — direct and group messages reach a phone that is not connected.
//
// MEASURED: `dm:send` / `gdm:send` only emitted to live sockets; mentions had a push path, direct
// messages had none. A backgrounded or killed mobile app never heard about a DM. The handler tests
// below fail on the pre-P4 handlers (no push call at all) — the negative control.

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const sendPushToUser = jest.fn(async () => undefined);
jest.mock('../lib/pushSender', () => ({ sendPushToUser: (...args: unknown[]) => sendPushToUser(...(args as [])) }));

const dms = {
  buildDmId: jest.fn((a: string, b: string) => [a, b].sort().join('_')),
  findByClientNonce: jest.fn(),
  findOrCreateConversation: jest.fn(),
  insertMessage: jest.fn(),
};
const groupDms = {
  findMember: jest.fn(),
  findByClientNonce: jest.fn(),
  insertMessage: jest.fn(),
  update: jest.fn(),
  findMembers: jest.fn(),
  findById: jest.fn(),
};
const users = { findById: jest.fn() };
const dmAccess = { evaluateDmAccess: jest.fn(), isDmBlocked: jest.fn() };
jest.mock('../db/repositories', () => ({ Dms: dms, GroupDms: groupDms, Users: users }));
jest.mock('../lib/dmAccessPolicy', () => dmAccess);
jest.mock('../lib/redisAdapter', () => ({ cache: { slidingWindowCount: jest.fn(async () => 1) } }));
jest.mock('../socket/handlers/dm-call-store', () => ({ dmCallStore: { get: jest.fn(), set: jest.fn(), del: jest.fn(), withLock: jest.fn() } }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import type { Server, Socket } from 'socket.io';
import { registerDmHandlers, registerGroupDmHandlers } from '../socket/handlers/dm';
import { deliverDmPushBatched, __pendingDmPushForTest, __DM_PUSH_DEBOUNCE_MS, __DM_PUSH_MAX_WAIT_MS } from '../lib/dmPush';

const ME = 'user-me';
const PEER = 'user-peer';
const me = { _id: ME, username: 'ada', displayName: 'Ada', avatarColor: '#111' };

function makeSocket() {
  const handlers = new Map<string, (payload?: unknown) => Promise<void>>();
  const self: Array<{ event: string; payload?: unknown }> = [];
  const shape = {
    id: 's1', data: {}, rooms: new Set<string>(['s1']),
    on(event: string, fn: (payload?: unknown) => Promise<void>) { handlers.set(event, fn); },
    emit(event: string, payload?: unknown) { self.push({ event, payload }); return true; },
    join() {}, leave() {},
    to() { return { emit() { return true; } }; },
  };
  return { self, trigger: async (e: string, p?: unknown) => { await handlers.get(e)?.(p); }, asSocket: shape as unknown as Socket };
}
const io = { to() { return { emit() { return true; } }; }, in() { return { fetchSockets: async () => [] }; } } as unknown as Server;

async function flushTimers(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  __pendingDmPushForTest.clear();
  users.findById.mockImplementation(async (id: string) => (id === PEER ? { _id: PEER, username: 'bo', displayName: 'Bo', locale: 'en' } : { _id: id, locale: 'en' }));
  dmAccess.evaluateDmAccess.mockResolvedValue({ allowed: true });
  dms.findByClientNonce.mockResolvedValue(null);
  dms.findOrCreateConversation.mockResolvedValue({ _id: 'dm' });
  dms.insertMessage.mockImplementation(async (row: Record<string, unknown>) => ({ _id: 'm1', ...row }));
  groupDms.findMember.mockResolvedValue({ userId: ME, groupId: 'g1' });
  groupDms.findByClientNonce.mockResolvedValue(null);
  groupDms.insertMessage.mockImplementation(async (row: Record<string, unknown>) => ({ _id: 'gm1', ...row }));
  groupDms.update.mockResolvedValue(undefined);
  groupDms.findMembers.mockResolvedValue([{ userId: ME }, { userId: 'u-2' }, { userId: 'u-3' }]);
  groupDms.findById.mockResolvedValue({ _id: 'g1', name: 'Weekend' });
});
afterEach(() => { jest.useRealTimers(); });

describe('dm:send / gdm:send push the recipients (handler wiring)', () => {
  it('an allowed DM pushes the recipient once, with the sender as title and a DM target', async () => {
    const socket = makeSocket();
    registerDmHandlers(socket.asSocket, io, me, new Map());
    await socket.trigger('dm:send', { toUserId: PEER, content: 'are you coming?' });
    await flushTimers(__DM_PUSH_DEBOUNCE_MS + 10);

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const [recipient, payload] = sendPushToUser.mock.calls[0] as unknown as [string, { title: string; body: string; data: Record<string, unknown> }];
    expect(recipient).toBe(PEER);
    expect(payload.title).toBe('Ada');
    expect(payload.body).toBe('are you coming?');
    expect(payload.data).toEqual({ type: 'dm', dmId: `${ME}_${PEER}`, fromUserId: ME });
  });

  it('a DM the access policy denies (block / privacy) never pushes', async () => {
    dmAccess.evaluateDmAccess.mockResolvedValue({ allowed: false, reason: 'blocked' });
    const socket = makeSocket();
    registerDmHandlers(socket.asSocket, io, me, new Map());
    await socket.trigger('dm:send', { toUserId: PEER, content: 'hello' });
    await flushTimers(__DM_PUSH_MAX_WAIT_MS + 10);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('a nonce retry of an already delivered DM does not push again', async () => {
    dms.findByClientNonce.mockResolvedValue({ _id: 'm0', dmId: `${ME}_${PEER}`, content: 'x' });
    const socket = makeSocket();
    registerDmHandlers(socket.asSocket, io, me, new Map());
    await socket.trigger('dm:send', { toUserId: PEER, content: 'x', clientNonce: 'n-1' });
    await flushTimers(__DM_PUSH_MAX_WAIT_MS + 10);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('a group message pushes every CURRENT member except the sender, titled with the group', async () => {
    const socket = makeSocket();
    registerGroupDmHandlers(socket.asSocket, io, me, new Map());
    await socket.trigger('gdm:send', { groupId: 'g1', content: 'pizza at 8' });
    await flushTimers(__DM_PUSH_DEBOUNCE_MS + 10);

    const recipients = (sendPushToUser.mock.calls as unknown as Array<[string, { title: string; body: string; data: unknown }]>).map((c) => c[0]).sort();
    expect(recipients).toEqual(['u-2', 'u-3']);
    const payload = (sendPushToUser.mock.calls[0] as unknown as [string, { title: string; body: string; data: unknown }])[1];
    expect(payload.title).toBe('Weekend');
    expect(payload.body).toBe('Ada: pizza at 8');
    expect(payload.data).toEqual({ type: 'gdm', groupId: 'g1' });
  });

  it('a sender who is no longer a member cannot trigger group pushes', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const socket = makeSocket();
    registerGroupDmHandlers(socket.asSocket, io, me, new Map());
    await socket.trigger('gdm:send', { groupId: 'g1', content: 'hi' });
    await flushTimers(__DM_PUSH_MAX_WAIT_MS + 10);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});

describe('dm push batching and privacy', () => {
  it('a burst becomes ONE notification with a localized count', async () => {
    for (let i = 1; i <= 5; i++) {
      deliverDmPushBatched(PEER, { userId: ME, displayName: 'Ada', content: `m${i}` }, { kind: 'dm', dmId: 'd1', fromUserId: ME });
    }
    await flushTimers(__DM_PUSH_DEBOUNCE_MS + 10);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const payload = (sendPushToUser.mock.calls[0] as unknown as [string, { title: string; body: string }])[1];
    expect(payload.title).toBe('5 new messages — Ada');
    expect(payload.body.split('\n')).toEqual(['Ada: m3', 'Ada: m4', 'Ada: m5']);
  });

  it('a continuous conversation still notifies by the maximum wait (no starvation)', async () => {
    const started = Date.now();
    while (Date.now() - started < __DM_PUSH_MAX_WAIT_MS + 1_000 && sendPushToUser.mock.calls.length === 0) {
      deliverDmPushBatched(PEER, { userId: ME, displayName: 'Ada', content: 'again' }, { kind: 'dm', dmId: 'd1', fromUserId: ME });
      await flushTimers(1_000);
    }
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThanOrEqual(__DM_PUSH_MAX_WAIT_MS + 1_000);
  });

  it('an end-to-end encrypted DM never puts its content in the push', async () => {
    deliverDmPushBatched(PEER, { userId: ME, displayName: 'Ada', content: '🔒e2e:ciphertext', e2e: true }, { kind: 'dm', dmId: 'd1', fromUserId: ME });
    await flushTimers(__DM_PUSH_DEBOUNCE_MS + 10);
    const payload = (sendPushToUser.mock.calls[0] as unknown as [string, { body: string }])[1];
    expect(payload.body).toBe('🔒 Encrypted message');
    expect(payload.body).not.toContain('ciphertext');
  });

  it('nobody is pushed about their own message', async () => {
    deliverDmPushBatched(ME, { userId: ME, displayName: 'Ada', content: 'note to self' }, { kind: 'dm', dmId: 'd1', fromUserId: ME });
    await flushTimers(__DM_PUSH_MAX_WAIT_MS + 10);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('a push failure never escapes (the message was already delivered)', async () => {
    sendPushToUser.mockRejectedValueOnce(new Error('fcm down') as never);
    deliverDmPushBatched(PEER, { userId: ME, displayName: 'Ada', content: 'x' }, { kind: 'dm', dmId: 'd1', fromUserId: ME });
    await expect(flushTimers(__DM_PUSH_DEBOUNCE_MS + 10)).resolves.toBeUndefined();
  });
});
