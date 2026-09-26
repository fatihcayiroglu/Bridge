process.env.NODE_ENV = 'test';

import { createMockDb, requireDoc } from './helpers/mockDb';
const mockDb = createMockDb();
const sendPush = jest.fn().mockResolvedValue(undefined);

jest.mock('../db/loader', () => mockDb);
jest.mock('../lib/pushSender', () => ({ sendPushToUser: (...args: unknown[]) => sendPush(...args) }));
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

import { incrementUnread, processNotifications } from '../lib/notifications';

function makeIo() {
  const emitted: Array<{ target: string; event: string; data: unknown }> = [];
  return {
    emitted,
    to(target: string) {
      return { emit(event: string, data: unknown) { emitted.push({ target, event, data }); } };
    },
  };
}

describe('mention → unified inbox persistence', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockDb._reset();
    jest.clearAllMocks();
    await mockDb.users.insert({ _id: 'sender', username: 'sender', displayName: 'Sender' });
    await mockDb.servers.insert({ _id: 'server', name: 'Server', ownerId: 'owner', createdAt: 1 });
    await mockDb.users.insert({ _id: 'recipient-id', username: 'recipient', displayName: 'Recipient' });
    await mockDb.channels.insert({ _id: 'channel', serverId: 'server', name: 'general', type: 'text' });
    await mockDb.members.insert({ userId: 'sender', serverId: 'server', roles: [], joinedAt: 1 });
    await mockDb.members.insert({ userId: 'recipient-id', serverId: 'server', roles: [], joinedAt: 1 });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('supports canonical <@id> mentions and sequential retries remain one item/count/event', async () => {
    const io = makeIo();
    const sockets = new Map([['recipient-socket', { id: 'recipient-id' }]]);
    const message = {
      _id: 'message-1', channelId: 'channel', serverId: 'server', userId: 'sender',
      displayName: 'Sender', content: 'hello <@recipient-id>', createdAt: 123,
    };

    await processNotifications(message, io, sockets);
    await processNotifications(message, io, sockets);

    const rows = await mockDb.notifications.find({ userId: 'recipient-id', messageId: 'message-1' });
    const unread = await mockDb.unreadCounts.findOne({ userId: 'recipient-id', channelId: 'channel' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ type: 'mention', actorId: 'sender', read: false }));
    expect(JSON.stringify(rows[0])).not.toContain('hello');
    expect(unread?.count).toBe(1);
    expect(io.emitted.filter(item => item.event === 'inbox:changed')).toHaveLength(1);
  });


  it('[PRIVACY] does not persist or emit a mention after VIEW_CHANNELS is revoked', async () => {
    await mockDb.channelOverrides.insert({
      _id: 'deny-recipient', channelId: 'channel', targetType: 'user', targetId: 'recipient-id',
      allow: 0, deny: 1 << 0, position: 0,
    });
    const io = makeIo();
    const sockets = new Map([['recipient-socket', { id: 'recipient-id' }]]);

    await processNotifications({
      _id: 'message-hidden', channelId: 'channel', serverId: 'server', userId: 'sender',
      displayName: 'Sender', content: 'secret <@recipient-id>', createdAt: 125,
    }, io, sockets);

    expect(await mockDb.notifications.find({ userId: 'recipient-id', messageId: 'message-hidden' })).toHaveLength(0);
    expect(await mockDb.unreadCounts.findOne({ userId: 'recipient-id', channelId: 'channel' })).toBeNull();
    expect(io.emitted.some(item => item.target === 'recipient-socket')).toBe(false);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('[CONCURRENCY] parallel unread increments do not lose updates in the fallback adapter', async () => {
    await Promise.all(Array.from({ length: 40 }, () => incrementUnread('recipient-id', 'channel')));

    const unread = await mockDb.unreadCounts.findOne({ userId: 'recipient-id', channelId: 'channel' });
    expect(unread?.count).toBe(40);
    expect(await mockDb.unreadCounts.find({ userId: 'recipient-id', channelId: 'channel' })).toHaveLength(1);
  });
  it('excludes a reply recipient so one message cannot appear twice in All', async () => {
    const io = makeIo();
    await processNotifications({
      _id: 'message-2', channelId: 'channel', serverId: 'server', userId: 'sender',
      displayName: 'Sender', content: '@recipient reply mention', createdAt: 124,
    }, io, new Map(), new Set(['recipient-id']));

    expect(await mockDb.notifications.find({ userId: 'recipient-id', messageId: 'message-2' })).toHaveLength(0);
    expect(await mockDb.unreadCounts.findOne({ userId: 'recipient-id', channelId: 'channel' })).toBeNull();
  });
});

