process.env.NODE_ENV = 'test';
process.env.BRIDGE_E2EE_ENABLED = 'true';

import type { DbInstance } from '../db/loader';

let db: DbInstance;
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

const cacheStore = new Map<string, unknown>();
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
    getAuthoritative: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => { cacheStore.set(key, value); }),
    setAuthoritative: jest.fn(async (key: string, value: unknown) => { cacheStore.set(key, value); }),
    del: jest.fn(async (key: string) => { cacheStore.delete(key); }),
    delAuthoritative: jest.fn(async (key: string) => { cacheStore.delete(key); }),
    withKeyLock: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    invalidatePattern: jest.fn(async () => {}),
  },
}));

const mockResolvePermissions = jest.fn(async (..._args: unknown[]) => 1);
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1 },
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
  hasPermission: (permissions: number, bit: number) => (permissions & bit) === bit,
}));

import { registerChannelE2EEHandlers } from '../socket/handlers/channelE2EEHandlers';
import type { Socket, Server as IOServer } from 'socket.io';

function socketHarness() {
  const handlers: Record<string, (payload: unknown) => unknown> = {};
  const emitted: Array<{ event: string; data: unknown }> = [];
  return {
    handlers,
    emitted,
    on: (event: string, fn: (payload: unknown) => unknown) => { handlers[event] = fn; },
    emit: (event: string, data: unknown) => { emitted.push({ event, data }); },
  } as unknown as Socket & { handlers: typeof handlers; emitted: typeof emitted };
}

const io = {} as IOServer;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('channel E2EE canonical channel authority', () => {
  beforeEach(async () => {
    const { createMockDb } = require('./helpers/mockDb');
    db = createMockDb();
    Object.assign(require('../db/loader'), db);
    cacheStore.clear();
    mockResolvePermissions.mockReset().mockResolvedValue(1);
    await db.members.insert({ userId: 'caller', serverId: 'srv-a', joinedAt: Date.now() });
    await db.members.insert({ userId: 'target', serverId: 'srv-a', joinedAt: Date.now() });
    await db.channels.insert({ _id: 'ch-a', serverId: 'srv-a', name: 'A', type: 'text', createdAt: Date.now() });
    await db.channels.insert({ _id: 'ch-b', serverId: 'srv-b', name: 'B', type: 'text', createdAt: Date.now() });
  });

  it('does not read keys/status through a mismatched serverId + channelId pair', async () => {
    cacheStore.set('e2ee:channel:keys:ch-b', {
      channelId: 'ch-b', wrappedKeys: { caller: 'secret-wrapped-key' }, epoch: 3, updatedAt: Date.now(),
    });
    const socket = socketHarness();
    registerChannelE2EEHandlers(socket, io, { _id: 'caller', username: 'caller' });

    socket.handlers['channel:e2ee:keys:get']?.({ channelId: 'ch-b', serverId: 'srv-a' });
    socket.handlers['channel:e2ee:status']?.({ channelId: 'ch-b', serverId: 'srv-a' });
    await tick(); await tick();

    expect(socket.emitted.some(e => e.event === 'channel:e2ee:keys:result')).toBe(false);
    expect(socket.emitted).toContainEqual({ event: 'channel:e2ee:keys:err', data: { error: 'Yetkisiz.' } });
    expect(socket.emitted).toContainEqual({ event: 'channel:e2ee:status:result', data: { channelId: 'ch-b', enabled: false } });
  });

  it('requires current VIEW_CHANNELS before returning a wrapped key', async () => {
    cacheStore.set('e2ee:channel:keys:ch-a', {
      channelId: 'ch-a', wrappedKeys: { caller: 'secret-wrapped-key' }, epoch: 1, updatedAt: Date.now(),
    });
    mockResolvePermissions.mockResolvedValue(0);
    const socket = socketHarness();
    registerChannelE2EEHandlers(socket, io, { _id: 'caller', username: 'caller' });

    socket.handlers['channel:e2ee:keys:get']?.({ channelId: 'ch-a', serverId: 'srv-a' });
    await tick(); await tick();

    expect(socket.emitted.some(e => e.event === 'channel:e2ee:keys:result')).toBe(false);
    expect(socket.emitted).toContainEqual({ event: 'channel:e2ee:keys:err', data: { error: 'Yetkisiz.' } });
  });

  it('does not add a wrapped key for a target that cannot currently view the channel', async () => {
    cacheStore.set('e2ee:channel:keys:ch-a', {
      channelId: 'ch-a', wrappedKeys: { caller: 'caller-key' }, epoch: 1, updatedAt: Date.now(),
    });
    mockResolvePermissions.mockImplementation(async (...args: unknown[]) => args[0] === 'caller' ? 1 : 0);
    const socket = socketHarness();
    registerChannelE2EEHandlers(socket, io, { _id: 'caller', username: 'caller' });

    socket.handlers['channel:e2ee:keys:add']?.({ channelId: 'ch-a', serverId: 'srv-a', userId: 'target', wrappedKey: 'target-key' });
    await tick(); await tick();

    const pkg = cacheStore.get('e2ee:channel:keys:ch-a') as { wrappedKeys: Record<string, string> };
    expect(pkg.wrappedKeys.target).toBeUndefined();
    expect(socket.emitted).toContainEqual({
      event: 'channel:e2ee:keys:err', data: { error: 'Hedef kullanıcının bu kanala erişimi yok.' },
    });
  });


  it('setup rejects malformed payload and malformed wrapped-key values', async () => {
    const socket = socketHarness();
    registerChannelE2EEHandlers(socket, io, { _id: 'caller', username: 'caller' });
    socket.handlers['channel:e2ee:setup']?.({ channelId:'', serverId:'srv-a', wrappedKeys:{} });
    socket.handlers['channel:e2ee:setup']?.({ channelId:'ch-a', serverId:'srv-a', wrappedKeys:{ caller:'' } });
    await tick(); await tick();
    expect(socket.emitted.filter(e => e.event === 'channel:e2ee:setup:err')).toEqual(expect.arrayContaining([
      expect.objectContaining({ data:{ error:'Geçersiz payload.' } }),
      expect.objectContaining({ data:{ error:'Geçersiz wrappedKey formatı.' } }),
    ]));
  });

  it('setup requires current visibility and persists a valid key package', async () => {
    const denied = socketHarness();
    mockResolvePermissions.mockResolvedValueOnce(0);
    registerChannelE2EEHandlers(denied, io, { _id:'caller', username:'caller' });
    denied.handlers['channel:e2ee:setup']?.({ channelId:'ch-a', serverId:'srv-a', wrappedKeys:{ caller:'wrapped' } });
    await tick(); await tick();
    expect(denied.emitted).toContainEqual({ event:'channel:e2ee:setup:err', data:{ error:'Yetkisiz.' } });

    mockResolvePermissions.mockResolvedValue(1);
    const ok = socketHarness();
    registerChannelE2EEHandlers(ok, io, { _id:'caller', username:'caller' });
    ok.handlers['channel:e2ee:setup']?.({ channelId:'ch-a', serverId:'srv-a', wrappedKeys:{ caller:'wrapped', target:'target-wrapped' } });
    await tick(); await tick();
    expect(ok.emitted.some(e => e.event === 'channel:e2ee:setup:ok')).toBe(true);
    const pkg = cacheStore.get('e2ee:channel:keys:ch-a') as { wrappedKeys:Record<string,string>; epoch:number };
    expect(pkg.wrappedKeys).toEqual({ caller:'wrapped', target:'target-wrapped' });
    expect(pkg.epoch).toBeGreaterThan(0);
  });

  it('keys:get returns only the caller key and reports missing key cleanly', async () => {
    const socket = socketHarness();
    registerChannelE2EEHandlers(socket, io, { _id:'caller', username:'caller' });
    socket.handlers['channel:e2ee:keys:get']?.({ channelId:'ch-a', serverId:'srv-a' });
    await tick(); await tick();
    expect(socket.emitted).toContainEqual({ event:'channel:e2ee:keys:err', data:{ error:'Bu kanal için E2EE anahtarı bulunamadı.' } });

    cacheStore.set('e2ee:channel:keys:ch-a', { channelId:'ch-a', wrappedKeys:{ caller:'caller-secret', target:'target-secret' }, epoch:7, updatedAt:Date.now() });
    socket.emitted.length = 0;
    socket.handlers['channel:e2ee:keys:get']?.({ channelId:'ch-a', serverId:'srv-a' });
    await tick(); await tick();
    expect(socket.emitted).toContainEqual({ event:'channel:e2ee:keys:result', data:{ channelId:'ch-a', wrappedKey:'caller-secret', epoch:7 } });
    expect(JSON.stringify(socket.emitted)).not.toContain('target-secret');
  });

  it('keys:add rejects a non-member target and succeeds for an authorized target', async () => {
    cacheStore.set('e2ee:channel:keys:ch-a', { channelId:'ch-a', wrappedKeys:{ caller:'c' }, epoch:1, updatedAt:Date.now() });
    const socket = socketHarness();
    registerChannelE2EEHandlers(socket, io, { _id:'caller', username:'caller' });
    socket.handlers['channel:e2ee:keys:add']?.({ channelId:'ch-a', serverId:'srv-a', userId:'missing', wrappedKey:'m' });
    await tick(); await tick();
    expect(socket.emitted).toContainEqual({ event:'channel:e2ee:keys:err', data:{ error:'Hedef kullanıcı sunucu üyesi değil.' } });

    socket.emitted.length = 0;
    socket.handlers['channel:e2ee:keys:add']?.({ channelId:'ch-a', serverId:'srv-a', userId:'target', wrappedKey:'target-key' });
    await tick(); await tick();
    expect(socket.emitted.some(e => e.event === 'channel:e2ee:keys:result')).toBe(true);
    const pkg = cacheStore.get('e2ee:channel:keys:ch-a') as { wrappedKeys:Record<string,string> };
    expect(pkg.wrappedKeys.target).toBe('target-key');
  });

  it('status is fail-closed for unauthorized users and returns epoch only when enabled', async () => {
    const socket = socketHarness();
    registerChannelE2EEHandlers(socket, io, { _id:'caller', username:'caller' });
    mockResolvePermissions.mockResolvedValueOnce(0);
    socket.handlers['channel:e2ee:status']?.({ channelId:'ch-a', serverId:'srv-a' });
    await tick(); await tick();
    expect(socket.emitted).toContainEqual({ event:'channel:e2ee:status:result', data:{ channelId:'ch-a', enabled:false } });

    mockResolvePermissions.mockResolvedValue(1);
    socket.emitted.length = 0;
    socket.handlers['channel:e2ee:status']?.({ channelId:'ch-a', serverId:'srv-a' });
    await tick(); await tick();
    expect(socket.emitted).toContainEqual({ event:'channel:e2ee:status:result', data:{ channelId:'ch-a', enabled:false, epoch:null } });

    cacheStore.set('e2ee:channel:keys:ch-a', { channelId:'ch-a', wrappedKeys:{ caller:'c' }, epoch:9, updatedAt:Date.now() });
    socket.emitted.length = 0;
    socket.handlers['channel:e2ee:status']?.({ channelId:'ch-a', serverId:'srv-a' });
    await tick(); await tick();
    expect(socket.emitted).toContainEqual({ event:'channel:e2ee:status:result', data:{ channelId:'ch-a', enabled:true, epoch:9 } });
  });

  it('cache/backend failures are contained and return fail-closed E2EE errors', async () => {
    const cache = require('../lib/redisAdapter').cache;
    const socket = socketHarness();
    registerChannelE2EEHandlers(socket, io, { _id:'caller', username:'caller' });
    cache.setAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    socket.handlers['channel:e2ee:setup']?.({ channelId:'ch-a', serverId:'srv-a', wrappedKeys:{ caller:'x' } });
    await tick(); await tick();
    expect(socket.emitted).toContainEqual({ event:'channel:e2ee:setup:err', data:{ error:'Sunucu hatası.' } });

    socket.emitted.length = 0;
    cache.getAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    socket.handlers['channel:e2ee:keys:get']?.({ channelId:'ch-a', serverId:'srv-a' });
    await tick(); await tick();
    expect(socket.emitted).toContainEqual({ event:'channel:e2ee:keys:err', data:{ error:'Sunucu hatası.' } });
  });
});
