// Hostile-client regression coverage for the stage socket authorization boundary.
import type { EmittedLog, SocketDouble } from './helpers/socketDoubles';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import { registerStageHandlers, stageRooms, isStageParticipant, canManageStage } from '../socket/handlers/stage';

const db = require('../db/loader');

function socketFor(id: string) {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
  const rooms = new Set<string>();
  const socket = {
    id,
    rooms,
    on(event, handler) { handlers[event] = handler; },
    emit(event, ...args) { emitted.push({ event, data: args[0] }); },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room) {
      return { emit(event, ...args) { emitted.push({ event, data: args[0], _room: room }); } };
    },
    async trigger(event: string, payload?: unknown) {
      const handler = handlers[event];
      if (typeof handler === 'function') await handler(payload);
    },
    emitted,
  } satisfies SocketDouble;
  return socket;
}

function ioFor() {
  const emitted: Array<{ room: string; event: string; data: unknown }> = [];
  return {
    emitted,
    to(room: string) { return { emit(event: string, data: unknown) { emitted.push({ room, event, data }); } }; },
  };
}

async function seedStage(channelId: string, userIds: string[], type = 'stage') {
  await db.servers.insert({ _id: 'security-server', ownerId: userIds[0] });
  await db.channels.insert({ _id: channelId, serverId: 'security-server', type, name: channelId });
  for (const userId of userIds) {
    await db.members.insert({ _id: `member-${channelId}-${userId}`, userId, serverId: 'security-server' });
  }
}

beforeEach(() => {
  db._reset?.();
  stageRooms.clear();
});

afterEach(() => stageRooms.clear());

describe('stage socket authorization', () => {
  it('rejects nonexistent channels and never creates a fabricated room', async () => {
    const socket = socketFor('attacker');
    registerStageHandlers(socket as never, ioFor() as never, { _id: 'attacker' });

    await socket.trigger('stage:join', { channelId: 'missing-channel' });

    expect(socket.rooms.has('stage:missing-channel')).toBe(false);
    expect(stageRooms.has('missing-channel')).toBe(false);
  });

  it('rejects a non-stage channel even when the user is a member', async () => {
    await seedStage('text-channel', ['member'], 'text');
    const socket = socketFor('member');
    registerStageHandlers(socket as never, ioFor() as never, { _id: 'member' });

    await socket.trigger('stage:join', { channelId: 'text-channel' });

    expect(socket.rooms.has('stage:text-channel')).toBe(false);
    expect(stageRooms.has('text-channel')).toBe(false);
  });

  it('rejects a non-member from every stage mutation, not just join', async () => {
    await seedStage('private-stage', ['owner']);
    const owner = socketFor('owner');
    const stranger = socketFor('stranger');
    const io = ioFor();
    registerStageHandlers(owner as never, io as never, { _id: 'owner' });
    registerStageHandlers(stranger as never, io as never, { _id: 'stranger' });
    await owner.trigger('stage:join', { channelId: 'private-stage' });
    await owner.trigger('stage:setRole', { channelId: 'private-stage', role: 'speaker' });

    await stranger.trigger('stage:setRole', { channelId: 'private-stage', role: 'speaker' });
    await stranger.trigger('stage:setTopic', { channelId: 'private-stage', topic: 'forged' });
    await stranger.trigger('stage:setLive', { channelId: 'private-stage', live: true });

    expect(stageRooms.get('private-stage')?.speakers).toHaveLength(1);
    expect(stageRooms.get('private-stage')?.topic).toBe('');
    expect(stageRooms.get('private-stage')?.live).toBe(false);
  });

  it('GÜVENLİK: SPEAK izni olmayan listener promote edilemez', async () => {
    await seedStage('no-speak-stage', ['owner', 'listener']);
    await db.channelPermissions.insert({
      _id: 'deny-speak-everyone',
      channelId: 'no-speak-stage',
      roleId: 'security-server',
      allow: 0,
      deny: 1 << 17,
    });
    const owner = socketFor('owner');
    const listener = socketFor('listener');
    const io = ioFor();
    registerStageHandlers(owner as never, io as never, { _id: 'owner' });
    registerStageHandlers(listener as never, io as never, { _id: 'listener' });

    await owner.trigger('stage:join', { channelId: 'no-speak-stage' });
    await owner.trigger('stage:setRole', { channelId: 'no-speak-stage', role: 'speaker' });
    await listener.trigger('stage:join', { channelId: 'no-speak-stage' });
    await listener.trigger('stage:setRole', { channelId: 'no-speak-stage', role: 'listener' });
    await owner.trigger('stage:promote', { channelId: 'no-speak-stage', targetUserId: 'listener' });

    expect(stageRooms.get('no-speak-stage')?.listeners.some(u => u.userId === 'listener')).toBe(true);
    expect(stageRooms.get('no-speak-stage')?.speakers.some(u => u.userId === 'listener')).toBe(false);
    expect(io.emitted.find(event => event.event === 'stage:promoted' && (event.data as { userId?: string }).userId === 'listener')).toBeUndefined();
  });

  it('requires a validated target membership before promote/demote', async () => {
    await seedStage('target-stage', ['owner']);
    const owner = socketFor('owner');
    const io = ioFor();
    registerStageHandlers(owner as never, io as never, { _id: 'owner' });
    await owner.trigger('stage:join', { channelId: 'target-stage' });
    await owner.trigger('stage:setRole', { channelId: 'target-stage', role: 'speaker' });

    await owner.trigger('stage:promote', { channelId: 'target-stage', targetUserId: 'forged-user' });
    await owner.trigger('stage:demote', { channelId: 'target-stage', targetUserId: 'forged-user' });

    expect(io.emitted.filter(event => event.event === 'stage:promoted' || event.event === 'stage:demoted')).toHaveLength(0);
  });
  it('stale stage state does not preserve participant/host authority after membership revocation', async () => {
    await seedStage('revoked-stage', ['owner']);
    const owner = socketFor('owner');
    registerStageHandlers(owner as never, ioFor() as never, { _id: 'owner' });
    await owner.trigger('stage:join', { channelId: 'revoked-stage' });
    await owner.trigger('stage:setRole', { channelId: 'revoked-stage', role: 'speaker' });

    expect(await isStageParticipant('revoked-stage', 'owner')).toBe(true);
    expect(await canManageStage('revoked-stage', 'owner')).toBe(true);

    await db.members.remove({ userId: 'owner', serverId: 'security-server' });

    expect(stageRooms.get('revoked-stage')?.speakers.some(u => u.userId === 'owner')).toBe(true); // stale state exists
    expect(await isStageParticipant('revoked-stage', 'owner')).toBe(false);
    expect(await canManageStage('revoked-stage', 'owner')).toBe(false);
  });

});
