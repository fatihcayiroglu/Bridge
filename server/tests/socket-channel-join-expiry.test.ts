// D2 subscription expiry and stale-navigation regressions.
'use strict';
process.env.NODE_ENV = 'test';

import type { SocketListener } from './helpers/socketDoubles';
import { createMockDb } from './helpers/mockDb';
import type { MockDb } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
jest.mock('../db/index', () => require('../db/loader'));

import { setupMemberships } from '../socket/handlers/members';
import { Channels } from '../db/repositories';
import * as availability from '../lib/channelWriteGuard';

const VIEW_CHANNELS = 1 << 0;

const MEMBER = 'uye-S';
const SRV    = 'srv-SJ';
const PUBLIC_CH  = 'sjch-acik';
const PRIVATE_CH = 'sjch-gizli';

function makeSocket(id: string) {
  // Sozluk `SocketListener` tutar: `on()` sozlesmesi JENERIKTIR ve sabit
  // imzali bir dinleyici ona atanamaz.
  const handlers: Record<string, SocketListener> = {};
  const rooms = new Set<string>([id]);
  return {
    id, rooms,
    on(ev: string, fn: SocketListener) { handlers[ev] = fn; },
    emit() {},
    join(r: string) { rooms.add(r); },
    leave(r: string) { rooms.delete(r); },
    to() { return { emit() {} }; },
    _rooms: rooms,
    async _trigger(ev: string, d?: unknown) {
      const fn = handlers[ev];
      if (typeof fn === 'function') await (fn as (payload?: unknown) => unknown)(d);
    },
  };
}
const makeIo = () => ({ to() { return { emit() {} }; } });

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);

  await db.users.insert({ _id: MEMBER, username: MEMBER, displayName: 'Uye' });
  await db.servers.insert({ _id: SRV, name: 'SJ', ownerId: 'sahip-SJ', createdAt: 1 });
  await db.members.insert({ userId: MEMBER, serverId: SRV, roles: [], joinedAt: 1 });

  await db.channels.insert({ _id: PUBLIC_CH,  serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await db.channels.insert({ _id: PRIVATE_CH, serverId: SRV, name: 'gizli', type: 'text', createdAt: 1 });

  await db.channelOverrides.insert({
    _id: 'ovr-sj-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });
});

async function joinAs(userId: string, channelId: string) {
  const socket = makeSocket(`s-${userId}`);
  // Ham koleksiyonda `findById` YOKTUR (o depo katmanindadir); handler'a
  // yalnizca `_id` gereklidir.
  const user = { _id: userId, username: userId, displayName: userId };
  await setupMemberships(socket as never, user as never);
  await socket._trigger('channel:join', channelId);
  return socket;
}

describe('channel join expiry and stale navigation', () => {
  afterEach(() => jest.restoreAllMocks());
  it('refuses an expired channel and preserves an unrelated current room', async () => {
    await db.channels.update({ _id: PUBLIC_CH }, { $set: { expiresAt: Date.now() - 1, expiryVersion: 1 } });
    const socket = makeSocket('expiry-join');
    socket.rooms.add('channel:unrelated-current');
    await setupMemberships(socket as never, { _id: MEMBER });
    await socket._trigger('channel:join', PUBLIC_CH);
    expect(socket.rooms.has(`channel:${PUBLIC_CH}`)).toBe(false);
    expect(socket.rooms.has('channel:unrelated-current')).toBe(true);
  });
  it('removes a now-expired target room on rejoin instead of retaining its subscription', async () => {
    const socket = await joinAs(MEMBER, PUBLIC_CH);
    await db.channels.update({ _id: PUBLIC_CH }, { $set: { expiresAt: Date.now() - 1, expiryVersion: 1 } });
    await socket._trigger('channel:join', PUBLIC_CH);
    expect(socket.rooms.has(`channel:${PUBLIC_CH}`)).toBe(false);
  });
  it('does not let a delayed old join replace a newer channel selection', async () => {
    const nextChannel = 'next-live-channel';
    await db.channels.insert({ _id: nextChannel, serverId: SRV, name: 'next', type: 'text', createdAt: 1 });
    const socket = makeSocket('race-join');
    await setupMemberships(socket as never, { _id: MEMBER });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = Channels.findById.bind(Channels);
    jest.spyOn(Channels, 'findById').mockImplementationOnce(async id => { await blocked; return original(id); });
    const older = socket._trigger('channel:join', PUBLIC_CH);
    await socket._trigger('channel:join', nextChannel);
    release(); await older;
    expect(socket.rooms.has(`channel:${nextChannel}`)).toBe(true);
    expect(socket.rooms.has(`channel:${PUBLIC_CH}`)).toBe(false);
  });
  it('cancels a delayed join when the user explicitly leaves that pending channel', async () => {
    const socket = makeSocket('leave-pending-join');
    await setupMemberships(socket as never, { _id: MEMBER });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = Channels.findById.bind(Channels);
    jest.spyOn(Channels, 'findById').mockImplementationOnce(async id => { await blocked; return original(id); });
    const pending = socket._trigger('channel:join', PUBLIC_CH);
    await socket._trigger('channel:leave', PUBLIC_CH);
    release(); await pending;
    expect(socket.rooms.has(`channel:${PUBLIC_CH}`)).toBe(false);
  });
  it('fails closed when authority is unavailable without leaving an unrelated room', async () => {
    jest.spyOn(availability, 'channelWriteAvailability').mockResolvedValueOnce('unverifiable');
    const socket = makeSocket('authority-failure');
    socket.rooms.add('channel:unrelated-current');
    await setupMemberships(socket as never, { _id: MEMBER });
    await socket._trigger('channel:join', PUBLIC_CH);
    expect(socket.rooms.has(`channel:${PUBLIC_CH}`)).toBe(false);
    expect(socket.rooms.has('channel:unrelated-current')).toBe(true);
  });
  it('checks permission before consulting expiry authority', async () => {
    const authority = jest.spyOn(availability, 'channelWriteAvailability');
    await joinAs(MEMBER, PRIVATE_CH);
    expect(authority).not.toHaveBeenCalled();
  });

  it('removes the target subscription when its channel row has disappeared', async () => {
    const socket = await joinAs(MEMBER, PUBLIC_CH);
    await db.channels.remove({ _id: PUBLIC_CH });
    await socket._trigger('channel:join', PUBLIC_CH);
    expect(socket.rooms.has(`channel:${PUBLIC_CH}`)).toBe(false);
  });

});
