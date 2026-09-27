// server/tests/jobs-scheduledMessages.test.ts
// Scheduled-message dispatcher contract tests (timer-free through fake timers).
process.env.NODE_ENV = 'test';

import { v4 as uuidv4 } from 'uuid';
import { requireDoc } from './helpers/mockDb';

let mockDbInstance: any;
let mockCreateFailure: Error | null = null;
let mockMarkFailedFailure: Error | null = null;
let mockPermissionMask = (1 << 0) | (1 << 8); // VIEW_CHANNELS | SEND_MESSAGES

jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1 << 0, SEND_MESSAGES: 1 << 8 },
  hasPermission: (perms: number, flag: number) => (perms & flag) === flag,
  resolvePermissions: jest.fn(async () => mockPermissionMask),
}));

jest.mock('../db/repositories', () => {
  const { createMockDb } = require('./helpers/mockDb');
  mockDbInstance = createMockDb();

  const ScheduledMessages = {
    claimDueBefore: async (ts: number, claimOwner: string, leaseMs: number, limit: number) => {
      const due = await mockDbInstance.scheduledMsgs
        .find({ sent: false, failedAt: null, cancelledAt: null, sendAt: { $lte: ts } })
        .sort({ sendAt: 1 })
        .limit(limit);
      const out: any[] = [];
      for (const row of due) {
        if (Number(row.claimUntil ?? 0) > ts) continue;
        const dispatchAttempts = Number(row.dispatchAttempts ?? 0) + 1;
        await mockDbInstance.scheduledMsgs.update(
          { _id: row._id },
          { $set: { claimOwner, claimUntil: ts + leaseMs, dispatchAttempts, lastError: null } },
        );
        out.push({ ...row, claimOwner, claimUntil: ts + leaseMs, dispatchAttempts });
      }
      return out;
    },
    finalizeSent: async (id: string, claimOwner: string, sentAt: number) => {
      const row = await mockDbInstance.scheduledMsgs.findOne({ _id: id, claimOwner, sent: false, cancelledAt: null });
      if (!row) return false;
      await mockDbInstance.scheduledMsgs.update(
        { _id: id },
        { $set: { sent: true, sentAt, claimOwner: null, claimUntil: null, lastError: null } },
      );
      return true;
    },
    releaseClaim: async (id: string, claimOwner: string, error: string, retryAt: number) => {
      const row = await mockDbInstance.scheduledMsgs.findOne({ _id: id, claimOwner, sent: false });
      if (!row) return false;
      await mockDbInstance.scheduledMsgs.update(
        { _id: id },
        { $set: { claimOwner: null, claimUntil: retryAt, lastError: error } },
      );
      return true;
    },
    markFailed: async (id: string, claimOwner: string, reason: string, failedAt: number) => {
      if (mockMarkFailedFailure) {
        const err = mockMarkFailedFailure;
        mockMarkFailedFailure = null;
        throw err;
      }
      const row = await mockDbInstance.scheduledMsgs.findOne({ _id: id, claimOwner, sent: false });
      if (!row) return false;
      await mockDbInstance.scheduledMsgs.update(
        { _id: id },
        { $set: { claimOwner: null, claimUntil: null, failedAt, failureReason: reason, lastError: reason } },
      );
      return true;
    },
  };
  const Users = {
    findById: (id: string) => mockDbInstance.users.findOne({ _id: id }),
  };
  const Members = {
    findOne: (userId: string, serverId: string) => mockDbInstance.members.findOne({ userId, serverId, banned: false }),
  };
  const Channels = {
    findById: (id: string) => mockDbInstance.channels.findOne({ _id: id }),
  };
  const Messages = {
    findByScheduledId: (scheduledId: string) => mockDbInstance.messages.findOne({ scheduledId }),
    create: async (doc: Record<string, unknown>) => {
      if (mockCreateFailure) throw mockCreateFailure;
      return mockDbInstance.messages.insert(doc);
    },
  };

  return { ScheduledMessages, Users, Members, Channels, Messages, _db: mockDbInstance };
});

import { startScheduledJob, stopScheduledJob } from '../jobs/scheduledMessages';

async function seedAuthority(userId = 'u1', serverId = 's1', channelId = 'ch1') {
  await mockDbInstance.users.insert({
    _id: userId, username: 'tester', displayName: 'Tester', avatarColor: '#2d9cdb',
  });
  await mockDbInstance.members.insert({
    _id: `${userId}:${serverId}`, userId, serverId, banned: false,
  });
  await mockDbInstance.channels.insert({
    _id: channelId, serverId, name: 'general', type: 'text',
  });
}

async function seedScheduledMsg(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: uuidv4(),
    userId: 'u1',
    channelId: 'ch1',
    serverId: 's1',
    username: 'tester',
    displayName: 'Tester',
    avatarColor: '#2d9cdb',
    content: 'hello scheduled world',
    sendAt: Date.now() - 1000,
    createdAt: Date.now() - 5000,
    sent: false,
    dispatchAttempts: 0,
    ...overrides,
  };
  await mockDbInstance.scheduledMsgs.insert(doc);
  return doc;
}

async function tick() {
  await jest.advanceTimersByTimeAsync(31_000);
}

describe('scheduled message dispatcher', () => {
  beforeEach(async () => {
    mockDbInstance._reset();
    mockCreateFailure = null;
    mockMarkFailedFailure = null;
    mockPermissionMask = (1 << 0) | (1 << 8);
    await seedAuthority();
  });

  afterEach(() => {
    stopScheduledJob();
    jest.useRealTimers();
  });

  it('does not throw when called with null io', () => {
    jest.useFakeTimers();
    expect(() => startScheduledJob(null)).not.toThrow();
  });

  it('does not schedule duplicate intervals', () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    startScheduledJob(null);
    startScheduledJob(null);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('dispatches a due message and finalizes only after persistence', async () => {
    jest.useFakeTimers();
    const scheduled = await seedScheduledMsg();
    startScheduledJob(null);
    await tick();

    const msgs = await mockDbInstance.messages.find({ scheduledId: scheduled._id });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('hello scheduled world');

    const row = await mockDbInstance.scheduledMsgs.findOne({ _id: scheduled._id });
    expect(row.sent).toBe(true);
    expect(row.sentAt).toBeGreaterThan(0);
    expect(row.claimOwner).toBeNull();
  });

  it('never dispatches a cancelled scheduled row', async () => {
    jest.useFakeTimers();
    const scheduled = await seedScheduledMsg({ cancelledAt: Date.now() - 1000 });
    startScheduledJob(null);
    await tick();

    expect(await mockDbInstance.messages.find({ scheduledId: scheduled._id })).toHaveLength(0);
    const row = await mockDbInstance.scheduledMsgs.findOne({ _id: scheduled._id });
    expect(row.sent).toBe(false);
    expect(row.cancelledAt).toBeGreaterThan(0);
  });

  it('does not dispatch messages that are not due or already sent', async () => {
    jest.useFakeTimers();
    await seedScheduledMsg({ sendAt: Date.now() + 60_000 });
    await seedScheduledMsg({ sent: true, sentAt: Date.now() - 5000 });
    startScheduledJob(null);
    await tick();
    expect(await mockDbInstance.messages.find({})).toHaveLength(0);
  });

  it('emits only after durable finalization', async () => {
    jest.useFakeTimers();
    await seedScheduledMsg({ channelId: 'ch1' });
    const emitSpy = jest.fn();
    const mockIo = { to: jest.fn().mockReturnValue({ emit: emitSpy }) } as any;
    startScheduledJob(mockIo);
    await tick();
    expect(mockIo.to).toHaveBeenCalledWith('channel:ch1');
    expect(emitSpy).toHaveBeenCalledWith('message:new', expect.objectContaining({ scheduledId: expect.any(String) }));
  });

  it('uses the current user profile rather than stale scheduled display data', async () => {
    jest.useFakeTimers();
    await mockDbInstance.users.update(
      { _id: 'u1' },
      { $set: { username: 'realuser', displayName: 'Real User', avatarColor: '#ff0000' } },
    );
    await seedScheduledMsg({ username: 'old-name', displayName: 'Old Name' });
    startScheduledJob(null);
    await tick();
    const msgs = await mockDbInstance.messages.find({ userId: 'u1' });
    expect(msgs[0].username).toBe('realuser');
    expect(msgs[0].displayName).toBe('Real User');
  });

  it('fails closed when membership was revoked after scheduling', async () => {
    jest.useFakeTimers();
    const scheduled = await seedScheduledMsg();
    await mockDbInstance.members.remove({ userId: 'u1', serverId: 's1' });
    startScheduledJob(null);
    await tick();

    expect(await mockDbInstance.messages.find({ scheduledId: scheduled._id })).toHaveLength(0);
    const row = await mockDbInstance.scheduledMsgs.findOne({ _id: scheduled._id });
    expect(row.sent).toBe(false);
    expect(row.failedAt).toBeGreaterThan(0);
    expect(row.failureReason).toBe('membership_revoked');
  });

  it('fails closed when channel send permission was revoked after scheduling', async () => {
    jest.useFakeTimers();
    const scheduled = await seedScheduledMsg();
    mockPermissionMask = 1 << 0; // VIEW only; SEND_MESSAGES revoked
    startScheduledJob(null);
    await tick();

    expect(await mockDbInstance.messages.find({ scheduledId: scheduled._id })).toHaveLength(0);
    const row = await mockDbInstance.scheduledMsgs.findOne({ _id: scheduled._id });
    expect(row.failureReason).toBe('send_permission_revoked');
  });

  it('recovers a message committed before a worker crash without duplicating it', async () => {
    jest.useFakeTimers();
    const scheduled = await seedScheduledMsg();
    await mockDbInstance.messages.insert({
      _id: uuidv4(), channelId: 'ch1', serverId: 's1', userId: 'u1',
      username: 'tester', displayName: 'Tester', avatarColor: '#2d9cdb',
      content: 'already persisted', type: 'normal', reactions: {},
      createdAt: Date.now() - 100, scheduledId: scheduled._id,
    });

    startScheduledJob(null);
    await tick();

    expect(await mockDbInstance.messages.find({ scheduledId: scheduled._id })).toHaveLength(1);
    const row = await mockDbInstance.scheduledMsgs.findOne({ _id: scheduled._id });
    expect(row.sent).toBe(true);
  });

  it('releases the lease with backoff when persistence fails instead of marking sent', async () => {
    jest.useFakeTimers();
    const scheduled = await seedScheduledMsg();
    mockCreateFailure = new Error('db unavailable');
    const before = Date.now();

    startScheduledJob(null);
    await tick();

    const row = await mockDbInstance.scheduledMsgs.findOne({ _id: scheduled._id });
    expect(row.sent).toBe(false);
    expect(row.claimOwner).toBeNull();
    expect(row.claimUntil).toBeGreaterThan(before);
    expect(row.lastError).toContain('db unavailable');
  });

  it('corrupt dispatchAttempts fails closed instead of creating a NaN endless retry lease', async () => {
    jest.useFakeTimers();
    const scheduled = await seedScheduledMsg({ dispatchAttempts: 'corrupt' });
    mockCreateFailure = new Error('persistent db failure');

    startScheduledJob(null);
    await tick();

    const row = await mockDbInstance.scheduledMsgs.findOne({ _id: scheduled._id });
    expect(row.sent).toBe(false);
    expect(row.failedAt).toBeGreaterThan(0);
    expect(row.failureReason).toContain('dispatch_retry_exhausted:persistent db failure');
    expect(Number.isNaN(Number(row.claimUntil))).toBe(false);
  });

  it('a terminal-failure persistence outage does not abort other claimed rows in the batch', async () => {
    jest.useFakeTimers();
    const poisoned = await seedScheduledMsg({ dispatchAttempts: 7, content: 'poisoned' });
    const healthy = await seedScheduledMsg({ content: 'healthy' });
    mockCreateFailure = new Error('first dispatch fails');
    mockMarkFailedFailure = new Error('failure store unavailable');

    // Fail only the first message create; subsequent create succeeds.
    const repos = require('../db/repositories');
    const create = repos.Messages.create;
    let first = true;
    repos.Messages.create = async (doc: Record<string, unknown>) => {
      if (first) { first = false; throw new Error('first dispatch fails'); }
      mockCreateFailure = null;
      return mockDbInstance.messages.insert(doc);
    };
    try {
      startScheduledJob(null);
      await tick();
    } finally {
      repos.Messages.create = create;
    }

    expect(await mockDbInstance.messages.find({ scheduledId: healthy._id })).toHaveLength(1);
    expect((await requireDoc(mockDbInstance.scheduledMsgs, { _id: healthy._id })).sent).toBe(true);
    expect((await requireDoc(mockDbInstance.scheduledMsgs, { _id: poisoned._id })).sent).toBe(false);
  });

  it('bounded retry limitinde kalıcı hatayı failed durumuna taşır ve tekrar claim edilmesini durdurur', async () => {
    jest.useFakeTimers();
    // claimDueBefore bu değeri 8'e yükseltecek: son izin verilen deneme.
    const scheduled = await seedScheduledMsg({ dispatchAttempts: 7 });
    mockCreateFailure = new Error('persistent db failure');

    startScheduledJob(null);
    await tick();

    const row = await mockDbInstance.scheduledMsgs.findOne({ _id: scheduled._id });
    expect(row.sent).toBe(false);
    expect(row.claimOwner).toBeNull();
    expect(row.claimUntil).toBeNull();
    expect(row.failedAt).toBeGreaterThan(0);
    expect(row.failureReason).toContain('dispatch_retry_exhausted:persistent db failure');

    // failedAt != null rows due-query dışında kalır; sonraki tick mesaj üretmez.
    mockCreateFailure = null;
    await tick();
    expect(await mockDbInstance.messages.find({ scheduledId: scheduled._id })).toHaveLength(0);
  });
});
