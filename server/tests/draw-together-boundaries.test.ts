import { findEmitted } from './helpers/socketDoubles';
'use strict';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const mockFindChannel = jest.fn();
const mockCanViewChannel = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../db/repositories', () => ({
  Channels: { findById: (...args: unknown[]) => mockFindChannel(...args) },
}));
jest.mock('../lib/permissions', () => ({
  canViewChannel: (...args: unknown[]) => mockCanViewChannel(...args),
}));
jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => false,
  cache: {
    withKeyLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
    getAuthoritative: jest.fn(), setAuthoritative: jest.fn(), delAuthoritative: jest.fn(),
  },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLogger }));

import { drawSessions, drawStore } from '../socket/handlers/activities/draw-store';
import { registerDrawTogetherHandlers } from '../socket/handlers/activities/draw-together';

function socketHarness(id: string, voiceChannels: string[] = []) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const emitted: Array<{ room?: string; event: string; data: unknown }> = [];
  const rooms = new Set<string>(voiceChannels.map(channelId => `voice:${channelId}`));
  const socket = {
    id,
    rooms,
    on: jest.fn((event: string, fn: (...args: any[]) => unknown) => handlers.set(event, fn)),
    join: jest.fn((room: string) => { rooms.add(room); }),
    leave: jest.fn((room: string) => { rooms.delete(room); }),
    emit: jest.fn((event: string, data: unknown) => { emitted.push({ event, data }); }),
    to: jest.fn((room: string) => ({
      emit: (event: string, data: unknown) => { emitted.push({ room, event, data }); },
    })),
    fire: async (event: string, data?: unknown) => handlers.get(event)?.(data),
    emitted,
  };
  return socket;
}

function ioHarness() {
  const emitted: Array<{ room: string; event: string; data: unknown }> = [];
  return {
    to: jest.fn((room: string) => ({ emit: (event: string, data: unknown) => emitted.push({ room, event, data }) })),
    emitted,
  };
}

const user = { _id: 'draw-user', displayName: 'Draw User', avatarColor: '#123456' };
const validStroke = {
  id: 'stroke-1', tool: 'pen', color: '#123456', size: 4, opacity: 1,
  points: [{ x: 1, y: 2 }],
};

async function join(socket: ReturnType<typeof socketHarness>, io: ReturnType<typeof ioHarness>, channelId: string, sessionId = 'session-1') {
  registerDrawTogetherHandlers(socket as never, io as never, user);
  await socket.fire('draw:join', { channelId, sessionId });
}

describe('draw-together runtime boundaries and cleanup', () => {
  beforeEach(() => {
    drawSessions.clear();
    jest.clearAllMocks();
    mockFindChannel.mockResolvedValue({ _id: 'draw-channel', serverId: 'draw-server' });
    mockCanViewChannel.mockResolvedValue(true);
  });

  afterEach(() => drawSessions.clear());

  it.each([
    [{ nested: true }],
    ['x'.repeat(129)],
  ])('rejects malformed session identity %p before creating shared state', async (sessionId) => {
    const socket = socketHarness('draw-malformed-session', ['draw-channel']);
    await join(socket, ioHarness(), 'draw-channel', sessionId as never);
    expect(drawSessions.has('draw-channel')).toBe(false);
    expect(socket.rooms.has('draw:draw-channel')).toBe(false);
  });

  it('fails join closed for missing voice presence, missing channel, and permission lookup failure', async () => {
    const noVoice = socketHarness('draw-no-voice');
    await join(noVoice, ioHarness(), 'draw-channel');
    expect(mockFindChannel).not.toHaveBeenCalled();

    const missing = socketHarness('draw-missing-channel', ['draw-channel']);
    mockFindChannel.mockResolvedValueOnce(null);
    await join(missing, ioHarness(), 'draw-channel');

    const denied = socketHarness('draw-permission-failure', ['draw-channel']);
    mockCanViewChannel.mockRejectedValueOnce(new Error('permission store down'));
    await join(denied, ioHarness(), 'draw-channel');
    expect(drawSessions.size).toBe(0);
  });

  it('rejects a stale session id without joining or mutating the live participant set', async () => {
    const io = ioHarness();
    const host = socketHarness('draw-host-mismatch', ['draw-channel']);
    await join(host, io, 'draw-channel', 'canonical-session');
    const stale = socketHarness('draw-stale', ['draw-channel']);
    await join(stale, io, 'draw-channel', 'stale-session');
    expect(drawSessions.get('draw-channel')?.participants.has('draw-stale')).toBe(false);
    expect(stale.rooms.has('draw:draw-channel')).toBe(false);
    expect(findEmitted(stale.emitted, 'error:message')).toBeDefined();
  });

  it('invalid point updates and stroke-end payloads never mutate or broadcast shared strokes', async () => {
    const socket = socketHarness('draw-invalid-stroke', ['draw-channel']);
    const io = ioHarness();
    await join(socket, io, 'draw-channel');
    await socket.fire('draw:stroke', { channelId: 'draw-channel', ...validStroke });
    await socket.fire('draw:stroke', { channelId: 'draw-channel', strokeId: 'stroke-1', points: [] });
    await socket.fire('draw:stroke-end', { channelId: 'draw-channel', strokeId: 'stroke-1', points: [{ x: Number.POSITIVE_INFINITY, y: 0 }] });
    const session = drawSessions.get('draw-channel')!;
    expect(session.activeStrokes.get(socket.id)?.points).toEqual(validStroke.points);
    expect(session.strokes).toHaveLength(0);
    expect(socket.emitted.filter(event => event.event === 'draw:error')).toHaveLength(2);
  });

  it('host disconnect drops its active stroke, transfers authority, and last disconnect retires the session', async () => {
    const io = ioHarness();
    const host = socketHarness('draw-host-disconnect', ['draw-channel']);
    const guest = socketHarness('draw-guest-disconnect', ['draw-channel']);
    await join(host, io, 'draw-channel');
    await join(guest, io, 'draw-channel');
    await host.fire('draw:stroke', { channelId: 'draw-channel', ...validStroke });
    expect(drawSessions.get('draw-channel')?.activeStrokes.has(host.id)).toBe(true);
    await host.fire('disconnect');
    const session = drawSessions.get('draw-channel')!;
    expect(session.activeStrokes.has(host.id)).toBe(false);
    expect(session.hostSocketId).toBe(guest.id);
    expect(findEmitted(io.emitted, 'draw:host-changed')?.data).toMatchObject({ newHostSocketId: guest.id });
    expect(findEmitted(io.emitted, 'draw:participant-left')).toBeDefined();
    await guest.fire('disconnect');
    expect(drawSessions.has('draw-channel')).toBe(false);
  });

  it('disconnect storage failure is isolated and reported to the socket', async () => {
    const socket = socketHarness('draw-disconnect-provider-failure', ['draw-channel']);
    await join(socket, ioHarness(), 'draw-channel');
    jest.spyOn(drawStore, 'del').mockRejectedValueOnce(new Error('draw store down'));
    await socket.fire('disconnect');
    expect(findEmitted(socket.emitted, 'error:message')).toBeDefined();
  });
});
