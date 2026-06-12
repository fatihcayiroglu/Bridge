// server/tests/jobs-scheduledMessages.test.ts
// scheduledMessages job — unit tests (timer-free)
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';
import { v4 as uuidv4 } from 'uuid';

let _dbInstance;

jest.mock('../db/repositories', () => {
  const { createMockDb } = require('./helpers/mockDb');
  _dbInstance = createMockDb();

  const ScheduledMessages = {
    findDueBefore: (ts) => _dbInstance.scheduled_msgs.find({ sent: false, sendAt: { $lte: ts } }),
    markSent:      (id, ts) => _dbInstance.scheduled_msgs.update({ _id: id }, { $set: { sent: true, sentAt: ts } }),
  };
  const Users = {
    findById: (id) => _dbInstance.users.findOne({ _id: id }),
  };
  const Messages = {
    create: (doc) => _dbInstance.messages.insert(doc),
  };

  return { ScheduledMessages, Users, Messages, _db: _dbInstance };
});

import repos from '../db/repositories';
import { startScheduledJob } from '../jobs/scheduledMessages';

// Expose dispatchDue by monkey-patching module internals via re-require trick:
// Instead, we test through the exported startScheduledJob by using fake timers.

// ── helpers ──────────────────────────────────────────────────────
async function seedScheduledMsg(overrides = {}) {
  const doc = {
    _id:         uuidv4(),
    userId:      'u1',
    channelId:   'ch1',
    serverId:    's1',
    username:    'tester',
    displayName: 'Tester',
    avatarColor: '#2d9cdb',
    content:     'hello scheduled world',
    sendAt:      Date.now() - 1000, // already due
    sent:        false,
    ...overrides,
  };
  await repos._db.scheduled_msgs.insert(doc);
  return doc;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('startScheduledJob', () => {
  beforeEach(() => repos._db._reset());

  it('does not throw when called with null io', () => {
    jest.useFakeTimers();
    expect(() => startScheduledJob(null)).not.toThrow();
    jest.useRealTimers();
  });

  it('dispatches due scheduled messages on interval tick', async () => {
    jest.useFakeTimers();
    await seedScheduledMsg();

    const mockIo = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
    startScheduledJob(mockIo);

    // Advance past the 30s interval
    await jest.advanceTimersByTimeAsync(31_000);

    const msgs = await repos._db.messages.find({ channelId: 'ch1' });
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].content).toBe('hello scheduled world');

    jest.useRealTimers();
  });

  it('marks message as sent after dispatch', async () => {
    jest.useFakeTimers();
    const sched = await seedScheduledMsg();

    startScheduledJob(null);
    await jest.advanceTimersByTimeAsync(31_000);

    const updated = await repos._db.scheduled_msgs.findOne({ _id: sched._id });
    expect(updated.sent).toBe(true);
    expect(updated.sentAt).toBeGreaterThan(0);

    jest.useRealTimers();
  });

  it('does not dispatch messages not yet due', async () => {
    jest.useFakeTimers();
    await seedScheduledMsg({ sendAt: Date.now() + 60_000 }); // 1 min in future

    startScheduledJob(null);
    await jest.advanceTimersByTimeAsync(31_000);

    const msgs = await repos._db.messages.find({ channelId: 'ch1' });
    expect(msgs).toHaveLength(0);

    jest.useRealTimers();
  });

  it('does not dispatch already-sent messages', async () => {
    jest.useFakeTimers();
    await seedScheduledMsg({ sent: true, sentAt: Date.now() - 5000 });

    startScheduledJob(null);
    await jest.advanceTimersByTimeAsync(31_000);

    const msgs = await repos._db.messages.find({ channelId: 'ch1' });
    expect(msgs).toHaveLength(0);

    jest.useRealTimers();
  });

  it('emits message:new socket event with correct channelId', async () => {
    jest.useFakeTimers();
    await seedScheduledMsg({ channelId: 'my-special-channel' });

    const emitSpy = jest.fn();
    const mockIo  = { to: jest.fn().mockReturnValue({ emit: emitSpy }) };
    startScheduledJob(mockIo);
    await jest.advanceTimersByTimeAsync(31_000);

    expect(mockIo.to).toHaveBeenCalledWith('channel:my-special-channel');
    expect(emitSpy).toHaveBeenCalledWith('message:new', expect.any(Object));

    jest.useRealTimers();
  });

  it('uses user profile data when user exists in DB', async () => {
    jest.useFakeTimers();
    const userId = uuidv4();
    await repos._db.users.insert({
      _id: userId, username: 'realuser', displayName: 'Real User', avatarColor: '#ff0000',
    });
    await seedScheduledMsg({ userId, username: 'old-name', displayName: 'Old Name' });

    startScheduledJob(null);
    await jest.advanceTimersByTimeAsync(31_000);

    const msgs = await repos._db.messages.find({ userId });
    expect(msgs[0].username).toBe('realuser');
    expect(msgs[0].displayName).toBe('Real User');

    jest.useRealTimers();
  });

  it('falls back to scheduled doc fields when user not found', async () => {
    jest.useFakeTimers();
    await seedScheduledMsg({ userId: 'ghost-id', username: 'ghost', displayName: 'Ghost User' });

    startScheduledJob(null);
    await jest.advanceTimersByTimeAsync(31_000);

    const msgs = await repos._db.messages.find({});
    expect(msgs[0].username).toBe('ghost');
    expect(msgs[0].displayName).toBe('Ghost User');

    jest.useRealTimers();
  });

  it('attaches scheduledId to dispatched message', async () => {
    jest.useFakeTimers();
    const sched = await seedScheduledMsg();

    startScheduledJob(null);
    await jest.advanceTimersByTimeAsync(31_000);

    const msgs = await repos._db.messages.find({});
    expect(msgs[0].scheduledId).toBe(sched._id);

    jest.useRealTimers();
  });
});
