import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinSocialRoomPreview, type SocialClientStatus, type SocialSocket } from '../js/core/activities/social-room-client.ts';
import { readSocial3DSnapshot } from '../js/core/activities/social-room-wire.ts';

function harness() {
  const listeners = new Map<string, Set<(data?: unknown) => void>>();
  const emitted: Array<{ name: string; value: unknown }> = [];
  const socket: SocialSocket = {
    connected: true, id: 'self',
    on(name, fn) { const group = listeners.get(name) ?? new Set(); group.add(fn); listeners.set(name, group); },
    off(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, value) { emitted.push({ name, value }); },
  };
  const status: SocialClientStatus[] = [];
  const render = vi.fn((_snapshot: unknown, _id: string) => true);
  function send(name: string, data?: unknown) {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(data);
  }
  return { socket, status, render, emitted, send,
    count(name: string) { return emitted.filter(e => e.name === name).length; },
    listeners() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
    connect() { return joinSocialRoomPreview(socket, 'roomA', render, s => status.push(s)); },
  };
}
const good = () => ({ serverId: 'roomA', peers: [
  { socketId: 'self', userId: 'alice', x: 0, z: 0 },
  { socketId: 'friend', userId: 'bob', x: 2, z: 1 },
] });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('3D social fail-closed session branches: real adapter contract, zero retry', () => {
  it('denies absent self ID and does not attach a listener or produce a join', () => {
    const h = harness(); h.socket.id = '';
    const dead = h.connect();
    dead.dispose();
    dead.step('left');
    expect(dead.active).toBe(false);
    expect(h.status).toEqual(['unavailable']);
    expect(h.listeners()).toBe(0);
    expect(h.emitted).toEqual([]);
  });
  it('disregards a different tenant join, peers, errors, left and membership revocations', () => {
    const h = harness(), session = h.connect();
    const other = { ...good(), serverId: 'roomB' };
    h.send('social:joined', other);
    h.send('social:peers', other);
    h.send('social:error', { serverId: 'roomB', code: 'NOT_MEMBER' });
    h.send('social:left', { serverId: 'roomB' });
    h.send('membership:revoked', { serverId: 'roomB' });
    expect(h.status).toEqual(['connecting']);
    expect(h.render).not.toHaveBeenCalled();
    expect(session.active).toBe(true);
    h.send('social:joined', good());
    expect(h.status).toEqual(['connecting','online']);
    h.send('social:peers', other);
    h.send('social:error', { serverId: 'roomB', code: 'REVOKED' });
    h.send('membership:revoked', { serverId: 'roomB' });
    h.send('social:left', { serverId: 'roomB' });
    expect(session.active).toBe(true);
    expect(h.render).toHaveBeenCalledOnce();
    session.dispose();
    expect(h.count('social:leave')).toBe(1);
  });
  it('denies malformed admit, missing self, duplicate self and render rejection', () => {
    const invalid = [
      undefined, {}, { ...good(), peers: good().peers.slice(1) },
      { ...good(), peers: [good().peers[0], good().peers[0]] },
    ];
    for (const snapshot of invalid) {
      const h = harness(), session = h.connect();
      h.send('social:joined', snapshot);
      expect(session.active).toBe(false);
      expect(h.status).toEqual(['connecting','invalid']);
      expect(h.count('social:leave')).toBe(1);
      expect(h.listeners()).toBe(0);
    }
    const h = harness(), session = h.connect();
    h.render.mockReturnValue(false);
    h.send('social:joined', good());
    expect(h.status).toEqual(['connecting','online','invalid']);
    expect(session.active).toBe(false);
    expect(h.count('social:leave')).toBe(1);
  });
  it('rejects an invalid update even after previously valid admission', () => {
    const h = harness(), session = h.connect();
    h.send('social:joined', good());
    h.send('social:peers', good());
    expect(h.render).toHaveBeenCalledTimes(2);
    h.send('social:peers', { ...good(), peers: [{ ...good().peers[0], x: NaN }] });
    expect(h.status).toEqual(['connecting','online','invalid']);
    expect(session.active).toBe(false);
    h.send('social:peers', good());
    expect(h.render).toHaveBeenCalledTimes(2);
  });
  it('honors scoped admission rejection without redundant leave, but leaves after admission', () => {
    const a = harness(), pending = a.connect();
    a.send('social:error', { serverId: 'roomA', code: 'DENIED' });
    expect(a.status).toEqual(['connecting','unavailable']);
    expect(a.count('social:leave')).toBe(0);
    expect(pending.active).toBe(false);
    const b = harness(), online = b.connect();
    b.send('social:joined', good());
    b.send('social:error', { serverId: 'roomA', code: 'UNAVAILABLE' });
    expect(b.status).toEqual(['connecting','online','unavailable']);
    expect(b.count('social:leave')).toBe(1);
    expect(online.active).toBe(false);
  });
  it('ignores anonymous and structurally malformed errors while preserving a scoped session', () => {
    const h = harness(), session = h.connect();
    for (const item of [undefined, null, '', 99, [], {}, { code: 42, serverId:'roomA' },
      { code: 'x' }, { serverId:'roomA' }, { serverId:'roomB', code:'x' }]) {
      h.send('social:error', item);
    }
    expect(session.active).toBe(true);
    expect(h.status).toEqual(['connecting']);
    h.send('social:joined', good());
    expect(session.active).toBe(true);
    session.dispose();
  });
  it('accepts scoped leave and membership revocation without stale client leave', () => {
    for (const event of ['social:left', 'membership:revoked']) {
      const h = harness(), session = h.connect();
      h.send('social:joined', good());
      h.send(event, { serverId:'roomA' });
      expect(h.status).toEqual(['connecting','online','disconnected']);
      expect(h.count('social:leave')).toBe(0);
      expect(session.active).toBe(false);
      expect(h.listeners()).toBe(0);
      h.send('social:joined', good());
      expect(h.render).toHaveBeenCalledOnce();
    }
  });
  it('does not emit leave after an actual socket disconnect and never auto reconnects', () => {
    const h = harness(), session = h.connect();
    h.send('social:joined', good());
    h.socket.connected = false;
    h.send('disconnect');
    expect(h.status).toEqual(['connecting','online','disconnected']);
    expect(h.count('social:leave')).toBe(0);
    expect(session.active).toBe(false);
    h.socket.connected = true;
    h.send('connect');
    session.step('right');
    expect(h.count('social:join')).toBe(1);
    expect(h.count('social:step')).toBe(0);
  });
  it('suppresses movement before join, after dispose and while transport is disconnected', () => {
    const h = harness(), session = h.connect();
    session.step('left');
    expect(h.count('social:step')).toBe(0);
    h.send('social:joined', good());
    session.step('left');
    expect(h.count('social:step')).toBe(1);
    h.socket.connected = false;
    session.step('right');
    expect(h.count('social:step')).toBe(1);
    h.socket.connected = true;
    session.dispose();
    session.dispose();
    session.step('right');
    expect(h.count('social:leave')).toBe(1);
    expect(h.count('social:step')).toBe(1);
  });
  it('does not fire an expired admission deadline after legitimate join or dispose', () => {
    const h = harness(), session = h.connect();
    h.send('social:joined', good());
    vi.advanceTimersByTime(9_000);
    expect(h.status).toEqual(['connecting','online']);
    expect(session.active).toBe(true);
    session.dispose();
    vi.advanceTimersByTime(30_000);
    expect(h.status).toEqual(['connecting','online','disconnected']);
  });
});

describe('3D social wire validation: trust nothing beyond the strict protocol', () => {
  it('rejects malformed caller server identifiers and non-array tenant responses', () => {
    for (const id of ['', '.', 'a'.repeat(65), 'bad/tenant']) {
      expect(readSocial3DSnapshot(good(), id)).toBeNull();
    }
    for (const input of [null, [], 2, 'value', { serverId:'roomA' },
      { serverId:'roomA', peers:{} }]) {
      expect(readSocial3DSnapshot(input,'roomA')).toBeNull();
    }
  });
  it('rejects missing, malformed and untrusted peer identity, bounds and coordinates', () => {
    const invalid = [
      null, [], {}, {socketId:'bad space',userId:'u',x:0,z:0},
      {socketId:'s',userId:'bad/route',x:0,z:0},
      {socketId:'s',userId:'u',x:'0',z:0},
      {socketId:'s',userId:'u',x:0,z:null},
      {socketId:'s',userId:'u',x:0,z:6},
      {socketId:'s',userId:'u',x:0,z:-6},
      {socketId:'s',userId:'u',x:-6,z:0},
      {socketId:'s',userId:'u',x:6,z:0},
      {socketId:'s',userId:'u',x:0,z:Infinity},
      {socketId:'s',userId:'u',x:NaN,z:0},
    ];
    for (const peer of invalid) {
      expect(readSocial3DSnapshot({serverId:'roomA',peers:[peer]},'roomA')).toBeNull();
    }
  });
  it('accepts valid boundary positions but not duplicate socket IDs or 17 peers', () => {
    const a={socketId:'s1',userId:'u1',x:5.6,z:-5.2};
    const b={socketId:'s2',userId:'u2',x:-5.6,z:5.2};
    expect(readSocial3DSnapshot({serverId:'roomA',peers:[a,b]},'roomA'))
      .toEqual({serverId:'roomA',peers:[a,b]});
    expect(readSocial3DSnapshot({serverId:'roomA',peers:[a,a]},'roomA')).toBeNull();
    expect(readSocial3DSnapshot({serverId:'roomA',peers:Array.from({length:17},(_,i)=>({
      socketId:'sock'+i,userId:'u',x:0,z:0
    }))},'roomA')).toBeNull();
  });
});
