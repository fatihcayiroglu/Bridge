// Production canvas socket handler contracts.
// The first-party client currently has no whiteboard entry point; these tests
// protect the authenticated socket protocol that remains reachable to clients.

process.env.NODE_ENV = 'test';
const previousRedisUrl = process.env.REDIS_URL;
delete process.env.REDIS_URL;

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import { registerCanvasHandlers, canvasState } from '../socket/handlers/canvas';

const db = require('../db/loader');

type Handler = (payload?: unknown) => unknown;

function makeSocket(id: string = 'canvas-socket') {
  const handlers: Record<string, Handler> = {};
  const emitted: Array<{ event: string; data: unknown }> = [];
  const roomEmitted: Array<{ room: string; event: string; data: unknown }> = [];
  const rooms = new Set<string>();

  return {
    id,
    handlers,
    emitted,
    roomEmitted,
    rooms,
    on(event: string, handler: Handler) { handlers[event] = handler; },
    emit(event: string, data: unknown) { emitted.push({ event, data }); },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room: string) {
      return {
        emit(event: string, data: unknown) { roomEmitted.push({ room, event, data }); },
      };
    },
    async trigger(event: string, payload?: unknown) {
      await handlers[event]?.(payload);
    },
  };
}

function makeIo(roomSize = 0) {
  const emitted: Array<{ room: string; event: string; data: unknown }> = [];
  return {
    emitted,
    in(_room: string) {
      return { fetchSockets: async () => Array.from({ length: roomSize }, (_, index) => ({ id: `room-${index}` })) };
    },
    to(room: string) {
      return {
        emit(event: string, data: unknown) { emitted.push({ room, event, data }); },
      };
    },
  };
}

async function seedMembership(userId = 'user-1', channelId = 'channel-1') {
  // EKSİK FIXTURE: kanal izin çözümü `Servers.findById` ile başlar; satır
  // yoksa `missing_server` → 0 izin ve `canvas:join` sessizce reddedilir.
  if (!(await db.servers.findOne({ _id: 'server-1' }))) {
    await db.servers.insert({ _id: 'server-1', name: 'Canvas Server', ownerId: 'canvas-owner', createdAt: Date.now() });
  }
  await db.channels.insert({ _id: channelId, serverId: 'server-1', name: 'general', type: 'text' });
  await db.members.insert({ _id: `member-${userId}`, userId, serverId: 'server-1' });
}

beforeEach(() => {
  db._reset?.();
  canvasState.clear();
});

afterEach(() => {
  canvasState.clear();
});

afterAll(() => {
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('production canvas socket handler', () => {
  it('rejects mutations before a validated canvas join', async () => {
    await seedMembership();
    const socket = makeSocket();
    const io = makeIo();
    registerCanvasHandlers(socket as never, io as never, { _id: 'user-1', displayName: 'Alice' });

    await socket.trigger('canvas:draw', {
      channelId: 'channel-1',
      stroke: { id: 'pre-join', tool: 'pen', color: '#fff', width: 2, points: [{ x: 1, y: 1 }] },
    });
    await socket.trigger('canvas:clear', { channelId: 'channel-1' });
    await socket.trigger('canvas:state-request', { channelId: 'channel-1' });

    expect(canvasState.has('channel-1')).toBe(false);
    expect(socket.emitted.some(({ event }) => event === 'canvas:state-sync')).toBe(false);
  });

  it('loses mutation authority immediately after leaving the room', async () => {
    await seedMembership();
    const socket = makeSocket();
    const io = makeIo();
    registerCanvasHandlers(socket as never, io as never, { _id: 'user-1', displayName: 'Alice' });
    await socket.trigger('canvas:join', { channelId: 'channel-1' });
    await socket.trigger('canvas:leave', { channelId: 'channel-1' });

    await socket.trigger('canvas:draw', {
      channelId: 'channel-1',
      stroke: { id: 'after-leave', tool: 'pen', color: '#fff', width: 2, points: [{ x: 1, y: 1 }] },
    });

    expect(canvasState.get('channel-1')?.strokes ?? []).toHaveLength(0);
  });

  it('lets a channel member join and receives the current state', async () => {
    await seedMembership();
    const socket = makeSocket();
    const io = makeIo();
    registerCanvasHandlers(socket as never, io as never, { _id: 'user-1', displayName: 'Alice' });

    await socket.trigger('canvas:join', { channelId: 'channel-1' });

    expect(socket.rooms.has('canvas:channel-1')).toBe(true);
    expect(socket.emitted).toContainEqual({
      event: 'canvas:state-sync',
      data: { channelId: 'channel-1', strokes: [], clearedAt: null },
    });
  });

  it('rejects canvas join when the authenticated user is not a channel member', async () => {
    if (!(await db.servers.findOne({ _id: 'server-1' }))) {
      await db.servers.insert({ _id: 'server-1', name: 'Canvas Server', ownerId: 'canvas-owner', createdAt: Date.now() });
    }
    await db.channels.insert({ _id: 'channel-1', serverId: 'server-1', name: 'general', type: 'text' });
    const socket = makeSocket();
    const io = makeIo();
    registerCanvasHandlers(socket as never, io as never, { _id: 'stranger', displayName: 'Mallory' });

    await socket.trigger('canvas:join', { channelId: 'channel-1' });

    expect(socket.rooms.has('canvas:channel-1')).toBe(false);
    expect(socket.emitted).toContainEqual({
      event: 'error',
      data: { event: 'canvas:join', message: 'Bu kanala erişim yetkiniz yok.' },
    });
  });


  it('rejects missing channels, enforces the room cap and ignores malformed protocol payloads', async () => {
    await seedMembership();

    const missing = makeSocket('missing-channel-socket');
    registerCanvasHandlers(missing as never, makeIo() as never, { _id: 'user-1', displayName: 'Alice' });
    await missing.trigger('canvas:join', { channelId: 'does-not-exist' });
    expect(missing.emitted).toContainEqual({
      event: 'error', data: { event: 'canvas:join', message: 'Kanal bulunamadı.' },
    });

    const full = makeSocket('full-room-socket');
    registerCanvasHandlers(full as never, makeIo(20) as never, { _id: 'user-1', displayName: 'Alice' });
    await full.trigger('canvas:join', { channelId: 'channel-1' });
    expect(full.rooms.size).toBe(0);
    expect(full.emitted).toContainEqual({
      event: 'error:ratelimit',
      data: expect.objectContaining({ event: 'canvas:join', message: expect.stringContaining('CANVAS_ROOM_FULL') }),
    });

    const malformed = makeSocket('malformed-socket');
    registerCanvasHandlers(malformed as never, makeIo() as never, { _id: 'user-1', displayName: 'Alice' });
    for (const [event, payload] of [
      ['canvas:join', null], ['canvas:leave', {}], ['canvas:draw', { channelId: '', stroke: {} }],
      ['canvas:stroke-delete', { channelId: 'channel-1' }], ['canvas:clear', { channelId: 7 }],
      ['canvas:state-request', { channelId: '' }],
    ] as const) await malformed.trigger(event, payload);
    expect(malformed.rooms.size).toBe(0);
    expect(malformed.emitted).toEqual([]);
  });

  it('normalizes hostile or malformed stroke internals before persistence and state resync', async () => {
    await seedMembership();
    const socket = makeSocket('sanitizer-socket');
    const io = makeIo();
    registerCanvasHandlers(socket as never, io as never, { _id: 'user-1', displayName: 'Alice' });
    await socket.trigger('canvas:join', { channelId: 'channel-1' });

    const manyPoints = Array.from({ length: 520 }, (_, index) =>
      index === 0 ? null : index === 1 ? { x: Number.POSITIVE_INFINITY, y: -2_000_000 } : { x: 2_000_000, y: index });
    await socket.trigger('canvas:draw', {
      channelId: 'channel-1',
      stroke: {
        id: 'x'.repeat(100), tool: 'not-a-tool', color: 'url(javascript:1)', width: Number.NaN,
        points: manyPoints, text: 'ignored-for-pen', userId: 'spoofed', displayName: 'spoofed',
      },
    });
    const first = canvasState.get('channel-1')?.strokes.at(-1)!;
    expect(first).toEqual(expect.objectContaining({
      id: 'x'.repeat(64), tool: 'pen', color: '#ffffff', width: 2,
      userId: 'user-1', displayName: 'Alice', text: undefined,
    }));
    expect(first.points).toHaveLength(512);
    expect(first.points[0]).toEqual({ x: 0, y: 0 });
    expect(first.points[1]).toEqual({ x: 0, y: -1_000_000 });
    expect(first.points[2].x).toBe(1_000_000);

    await socket.trigger('canvas:draw', {
      channelId: 'channel-1',
      stroke: { tool: 'text', color: '#abc', width: 0, points: 'not-an-array', text: 't'.repeat(250) },
    });
    const textStroke = canvasState.get('channel-1')?.strokes.at(-1)!;
    expect(textStroke.id).toMatch(/^\d+$/);
    expect(textStroke.tool).toBe('text');
    expect(textStroke.color).toBe('#abc');
    expect(textStroke.width).toBe(1);
    expect(textStroke.points).toEqual([]);
    expect(textStroke.text).toHaveLength(200);

    socket.emitted.length = 0;
    await socket.trigger('canvas:state-request', { channelId: 'channel-1' });
    expect(socket.emitted).toContainEqual({
      event: 'canvas:state-sync',
      data: expect.objectContaining({ channelId: 'channel-1', strokes: expect.any(Array), clearedAt: null }),
    });
  });

  it('revokes joined authority when membership disappears or disconnect fires', async () => {
    await seedMembership();
    const socket = makeSocket('revocation-socket');
    const io = makeIo();
    registerCanvasHandlers(socket as never, io as never, { _id: 'user-1', displayName: 'Alice' });
    await socket.trigger('canvas:join', { channelId: 'channel-1' });

    // Membership is rechecked on every mutation; a stale joined room is not authority.
    await db.members.remove({ userId: 'user-1', serverId: 'server-1' });
    await socket.trigger('canvas:draw', {
      channelId: 'channel-1', stroke: { id: 'revoked', tool: 'pen', color: '#fff', width: 2, points: [] },
    });
    expect(canvasState.get('channel-1')?.strokes ?? []).toHaveLength(0);

    await socket.trigger('disconnect');
    await db.members.insert({ _id: 'member-user-1-returned', userId: 'user-1', serverId: 'server-1' });
    await socket.trigger('canvas:clear', { channelId: 'channel-1' });
    expect(io.emitted.some(({ event }) => event === 'canvas:clear')).toBe(false);
  });

  it('sanitizes and broadcasts a member stroke using the authenticated identity', async () => {
    await seedMembership();
    const socket = makeSocket();
    const io = makeIo();
    registerCanvasHandlers(socket as never, io as never, { _id: 'user-1', displayName: 'Alice' });
    await socket.trigger('canvas:join', { channelId: 'channel-1' });

    await socket.trigger('canvas:draw', {
      channelId: 'channel-1',
      stroke: {
        id: 'stroke-1',
        tool: 'pen',
        color: '#ff0000',
        width: 999,
        points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
        userId: 'spoofed-user',
      },
    });

    const broadcast = socket.roomEmitted.find(({ event }) => event === 'canvas:draw');
    expect(broadcast?.room).toBe('canvas:channel-1');
    expect(broadcast?.data).toEqual(expect.objectContaining({
      channelId: 'channel-1',
      stroke: expect.objectContaining({
        id: 'stroke-1',
        tool: 'pen',
        width: 40,
        userId: 'user-1',
        displayName: 'Alice',
      }),
    }));
    expect(canvasState.get('channel-1')?.strokes).toHaveLength(1);
  });

  it('only deletes the authenticated user\'s stroke and clears shared state', async () => {
    await seedMembership('user-1');
    await db.members.insert({ _id: 'member-user-2', userId: 'user-2', serverId: 'server-1' });
    const io = makeIo();
    const owner = makeSocket('owner-socket');
    const other = makeSocket('other-socket');
    registerCanvasHandlers(owner as never, io as never, { _id: 'user-1', displayName: 'Alice' });
    registerCanvasHandlers(other as never, io as never, { _id: 'user-2', displayName: 'Bob' });
    await owner.trigger('canvas:join', { channelId: 'channel-1' });
    await other.trigger('canvas:join', { channelId: 'channel-1' });

    await owner.trigger('canvas:draw', {
      channelId: 'channel-1',
      stroke: { id: 'stroke-1', tool: 'line', color: '#fff', width: 2, points: [{ x: 0, y: 0 }] },
    });
    await other.trigger('canvas:stroke-delete', { channelId: 'channel-1', strokeId: 'stroke-1' });
    expect(canvasState.get('channel-1')?.strokes).toHaveLength(1);
    expect(io.emitted.some(({ event }) => event === 'canvas:stroke-delete')).toBe(false);

    await owner.trigger('canvas:stroke-delete', { channelId: 'channel-1', strokeId: 'stroke-1' });
    expect(canvasState.get('channel-1')?.strokes).toHaveLength(0);
    expect(io.emitted.some(({ event }) => event === 'canvas:stroke-delete')).toBe(true);

    await owner.trigger('canvas:clear', { channelId: 'channel-1' });
    expect(io.emitted.at(-1)).toEqual(expect.objectContaining({
      room: 'canvas:channel-1',
      event: 'canvas:clear',
      data: expect.objectContaining({ channelId: 'channel-1' }),
    }));
  });
});
