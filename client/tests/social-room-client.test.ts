import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSocial3DSnapshot } from '../js/core/activities/social-room-wire.ts';
import { joinSocialRoomPreview, type SocialClientStatus, type SocialSocket } from '../js/core/activities/social-room-client.ts';

function makeSocket() {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  const socket: SocialSocket = {
    connected: true,
    id: 'socket-owner',
    on(event, listener) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(listener);
      listeners.set(event, handlers);
    },
    off(event, listener) { listeners.get(event)?.delete(listener); },
    emit(event, payload) { sent.push({ event, payload }); },
  };
  function deliver(event: string, payload?: unknown) {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
  }
  return { socket, sent, deliver, listeners };
}
const frame = (overrides: Record<string, unknown> = {}) => ({
  serverId: 'server-1',
  peers: [{ socketId: 'socket-owner', userId: 'user-owner', x: 0, z: 2.5 }],
  ...overrides,
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('3D Social Space client — explicitly opted-in, server-frame only', () => {
  it('rejects fabricated tenant, NaN/infinite coordinates and over-capacity frames', () => {
    expect(readSocial3DSnapshot(frame({ serverId: 'other' }), 'server-1')).toBeNull();
    expect(readSocial3DSnapshot(frame({ peers: [ { socketId: 'x', userId: 'u', x: NaN, z: 0 } ] }), 'server-1')).toBeNull();
    expect(readSocial3DSnapshot(frame({ peers: [ { socketId: 'x', userId: 'u', x: 0, z: Infinity } ] }), 'server-1')).toBeNull();
    expect(readSocial3DSnapshot(frame({ peers: [ { socketId: 'x', userId: 'u', x: 5.7, z: 0 } ] }), 'server-1')).toBeNull();
    const peers = Array.from({length:17},(_,i) => ({socketId:'sock-'+i,userId:'u',x:0,z:0}));
    expect(readSocial3DSnapshot(frame({peers}), 'server-1')).toBeNull();
  });

  it('rejects duplicate IDs and does not copy arbitrary server fields into rendering data', () => {
    const dup = { socketId: 'socket-owner', userId:'user-owner', x:0, z:0 };
    expect(readSocial3DSnapshot(frame({ peers: [dup,dup] }), 'server-1')).toBeNull();
    const value = readSocial3DSnapshot(frame({ peers: [ { ...dup, html: '<img onerror=bad()>' } ], admin: true }), 'server-1');
    expect(value).toEqual({serverId:'server-1',peers:[dup]});
  });

  it('rejects use when disconnected or server ID absent before adding listeners', () => {
    const { socket, sent, listeners } = makeSocket();
    const status: SocialClientStatus[] = [];
    socket.connected = false;
    const client = joinSocialRoomPreview(socket, 'server-1', () => true, s=>status.push(s));
    expect(client.active).toBe(false);
    expect(status).toEqual(['unavailable']);
    expect(sent).toHaveLength(0);
    expect(listeners.size).toBe(0);
    socket.connected = true;
    const other = joinSocialRoomPreview(socket, '..', () => true, s=>status.push(s));
    expect(other.active).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('does not emit movement until the real server acknowledges own membership', () => {
    const { socket, sent, deliver } = makeSocket();
    const snapshots: unknown[] = [], status: SocialClientStatus[] = [];
    const client = joinSocialRoomPreview(socket, 'server-1',
      (s, id) => { snapshots.push([s,id]); return true; }, s=>status.push(s));
    expect(sent).toEqual([{event:'social:join',payload:{serverId:'server-1'}}]);
    client.step('right');
    expect(sent).toHaveLength(1);
    deliver('social:peers', frame());
    expect(snapshots).toHaveLength(0);
    deliver('social:joined', frame());
    client.step('right');
    expect(status).toEqual(['connecting','online']);
    expect(sent.at(-1)).toEqual({event:'social:step',payload:{serverId:'server-1', direction:'right'}});
    expect(snapshots).toHaveLength(1);
    deliver('social:peers', frame({ peers: [
      { socketId: 'socket-owner', userId:'u1', x:0.35, z:2.5 },
      { socketId: 'socket-friend', userId:'u2', x:1.2, z:2.0 },
    ] }));
    expect(snapshots).toHaveLength(2);
    client.dispose();
    expect(sent.at(-1)).toEqual({event:'social:leave',payload:{serverId:'server-1'}});
    client.step('left');
    expect(sent.filter(x=>x.event==='social:step')).toHaveLength(1);
    expect(client.active).toBe(false);
  });

  it('fails closed on stale or malformed peer snapshots after join', () => {
    const { socket, deliver, sent } = makeSocket();
    const status: SocialClientStatus[] = [];
    joinSocialRoomPreview(socket, 'server-1', () => true, s=>status.push(s));
    deliver('social:joined', frame());
    deliver('social:peers', frame({ peers: [] }));
    expect(status).toEqual(['connecting','online','invalid']);
    expect(sent.at(-1)?.event).toBe('social:leave');
  });

  it('times out an unregistered server feature without claiming success, zero retries', () => {
    const { socket, sent } = makeSocket();
    const status: SocialClientStatus[] = [];
    const client = joinSocialRoomPreview(socket, 'server-1', () => true, s=>status.push(s));
    vi.advanceTimersByTime(7001);
    expect(status).toEqual(['connecting','unavailable']);
    expect(sent.filter(s=>s.event==='social:join')).toHaveLength(1);
    expect(sent.filter(s=>s.event==='social:leave')).toHaveLength(1);
    expect(client.active).toBe(false);
  });

  it('never auto-rejoins after a real socket disconnect or close', () => {
    const { socket, sent, deliver, listeners } = makeSocket();
    const status: SocialClientStatus[] = [];
    const client = joinSocialRoomPreview(socket, 'server-1', () => true, s=>status.push(s));
    deliver('social:joined', frame());
    socket.connected = false;
    deliver('disconnect');
    expect(client.active).toBe(false);
    expect(status).toEqual(['connecting','online','disconnected']);
    deliver('connect');
    deliver('social:peers', frame());
    expect(sent.filter(s=>s.event==='social:join')).toHaveLength(1);
    expect([...listeners.values()].every(group => group.size===0)).toBe(true);
  });
});
