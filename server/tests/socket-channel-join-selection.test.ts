import type { HandlerSocket } from '../socket/handler-contracts';
import type { SocketListener } from './helpers/socketDoubles';
import { deferred } from './helpers/deferred';
import type { ChannelContentAvailability } from '../lib/channelContentAvailability';

const mockAvailability = jest.fn<Promise<ChannelContentAvailability>, [string, string]>();
jest.mock('../lib/channelWriteGuard', () => ({
  channelWriteAvailability: async (_db: unknown, channel: { _id: string; serverId: string }) => {
    const state = await mockAvailability(channel._id, channel.serverId);
    return state === 'missing' ? 'gone' : state === 'unavailable' ? 'unverifiable' : state;
  },
}));
jest.mock('../db/repositories', () => ({
  Channels: { findById: async (id: string) => ({ _id: id, serverId: 'server' }) },
  Members: { findOne: async () => ({ userId: 'member', serverId: 'server' }) },
}));
jest.mock('../lib/permissions', () => ({ canViewChannel: async () => true }));
jest.mock('../lib/presenceCache', () => ({ getMembershipsCached: async () => [] }));
jest.mock('../lib/channelActivity', () => ({ watchServerChannels: async () => [] }));

import { setupMemberships } from '../socket/handlers/members';

function makeSocket() {
  const handlers: Record<string, SocketListener> = {};
  const rooms = new Set(['socket', 'channel:existing']);
  return {
    id: 'socket', rooms, currentChannel: 'existing' as string | undefined,
    on(event: string, handler: SocketListener) { handlers[event] = handler; },
    emit() {},
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to() { return { emit() {} }; },
    async trigger(event: string, channelId: string) {
      const handler = handlers[event];
      if (handler) await (handler as (id: string) => unknown)(channelId);
    },
  } satisfies HandlerSocket & {
    currentChannel?: string;
    trigger(event: string, channelId: string): Promise<void>;
  };
}

function holdAvailability(channelId: string, other: ChannelContentAvailability = 'live') {
  const reached = deferred<void>();
  const result = deferred<ChannelContentAvailability>();
  mockAvailability.mockImplementation(async id => {
    if (id !== channelId) return other;
    reached.resolve();
    return result.promise;
  });
  return { reached: reached.promise, release: () => result.resolve('live') };
}

beforeEach(() => { mockAvailability.mockReset().mockResolvedValue('live'); });

it('leaving a pending target prevents its availability result from joining it later', async () => {
  const socket = makeSocket();
  await setupMemberships(socket, { _id: 'member' });
  const held = holdAvailability('pending');
  const joining = socket.trigger('channel:join', 'pending');
  await held.reached;
  await socket.trigger('channel:leave', 'pending');
  held.release();
  await joining;

  expect(socket.rooms.has('channel:pending')).toBe(false);
  expect(socket.rooms.has('channel:existing')).toBe(true);
  expect(socket.currentChannel).toBe('existing');
});

it('an older availability result cannot replace a newer completed channel selection', async () => {
  const socket = makeSocket();
  await setupMemberships(socket, { _id: 'member' });
  const held = holdAvailability('older');
  const joining = socket.trigger('channel:join', 'older');
  await held.reached;
  await socket.trigger('channel:join', 'newer');
  held.release();
  await joining;

  expect(socket.rooms.has('channel:older')).toBe(false);
  expect(socket.rooms.has('channel:newer')).toBe(true);
  expect(socket.currentChannel).toBe('newer');
});

it('leaving the previous room does not cancel a pending different selection', async () => {
  const socket = makeSocket();
  await setupMemberships(socket, { _id: 'member' });
  const held = holdAvailability('newer');
  const joining = socket.trigger('channel:join', 'newer');
  await held.reached;
  await socket.trigger('channel:leave', 'existing');
  held.release();
  await joining;

  expect(socket.rooms.has('channel:existing')).toBe(false);
  expect(socket.rooms.has('channel:newer')).toBe(true);
  expect(socket.currentChannel).toBe('newer');
});

it.each(['missing', 'unavailable'] as const)('a newer %s selection preserves the current room and cancels an older pending join', async availability => {
  const socket = makeSocket();
  await setupMemberships(socket, { _id: 'member' });
  const held = holdAvailability('older', availability);
  const joining = socket.trigger('channel:join', 'older');
  await held.reached;
  await socket.trigger('channel:join', 'denied');
  held.release();
  await joining;

  expect(socket.rooms.has('channel:older')).toBe(false);
  expect(socket.rooms.has('channel:denied')).toBe(false);
  expect(socket.rooms.has('channel:existing')).toBe(true);
  expect(socket.currentChannel).toBe('existing');
});
