process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import db from '../db/loader';
import BridgeRepository from '../db/repositories/BridgeRepository';
import ReactionRoleRepository from '../db/repositories/ReactionRoleRepository';

const bridgeInput = (overrides: Partial<Parameters<typeof BridgeRepository.createOrReactivateAtomic>[0]> = {}) => ({
  id: 'bridge-1', sourceChannelId: 'c-source', targetChannelId: 'c-target',
  sourceServerId: 's-source', targetServerId: 's-target', label: 'mirror',
  createdBy: 'u-owner', createdAt: 1_000, ...overrides,
});

const reactionInput = (overrides: Partial<Parameters<typeof ReactionRoleRepository.createIfAbsent>[0]> = {}) => ({
  serverId: 's-1', channelId: 'c-1', messageId: 'm-1', emoji: '✅', roleId: 'r-1', createdBy: 'u-1', ...overrides,
});

beforeEach(() => {
  (db as any)._reset?.();
  delete (db as any)._pool;
});

describe('BridgeRepository pair authority', () => {
  it('serializes concurrent same-pair creation in the in-memory compatibility path', async () => {
    const [a, b] = await Promise.all([
      BridgeRepository.createOrReactivateAtomic(bridgeInput()),
      BridgeRepository.createOrReactivateAtomic(bridgeInput({ id: 'bridge-2' })),
    ]);
    expect([a.status, b.status].sort()).toEqual(['created', 'exists']);
    expect(await (db as any).channelBridges.find({ sourceChannelId: 'c-source', targetChannelId: 'c-target' })).toHaveLength(1);
  });

  it('reactivates a disabled pair without creating a duplicate and updates ownership metadata', async () => {
    await (db as any).channelBridges.insert({ ...bridgeInput(), _id: 'old', active: false, label: 'old' });
    const out = await BridgeRepository.createOrReactivateAtomic(bridgeInput({ id: 'new', label: 'new-label', createdAt: 2_000 }));
    expect(out.status).toBe('reactivated');
    if (out.status === 'reactivated') expect(out.bridge).toEqual(expect.objectContaining({ _id: 'old', active: true, label: 'new-label', createdAt: 2_000 }));
    expect(await BridgeRepository.findActiveFromSourceChannel('c-source')).toHaveLength(1);
  });

  it.each([
    ['sourceChannelId', ''], ['targetChannelId', '   '], ['sourceServerId', null], ['createdBy', 7],
  ] as const)('rejects malformed %s before touching storage', async (field, value) => {
    await expect(BridgeRepository.createOrReactivateAtomic(bridgeInput({ [field]: value } as any))).rejects.toThrow();
    expect(await (db as any).channelBridges.find({})).toHaveLength(0);
  });

  it.each([0, -1, 1.25, Number.NaN])('rejects non-canonical createdAt %p', async (createdAt) => {
    await expect(BridgeRepository.createOrReactivateAtomic(bridgeInput({ createdAt }))).rejects.toThrow(RangeError);
  });
});

describe('ReactionRoleRepository duplicate authority', () => {
  it('serializes concurrent identical rules so exactly one caller creates the mapping', async () => {
    const [a, b] = await Promise.all([
      ReactionRoleRepository.createIfAbsent(reactionInput()),
      ReactionRoleRepository.createIfAbsent(reactionInput()),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await (db as any).reactionRoles.find({ messageId: 'm-1', emoji: '✅', roleId: 'r-1' })).toHaveLength(1);
  });

  it('returns the existing mapping and tenant-scoped lookup helpers cannot cross servers', async () => {
    const first = await ReactionRoleRepository.createIfAbsent(reactionInput());
    expect(first.created).toBe(true);
    const id = String(first.rule._id);
    expect(await ReactionRoleRepository.findByIdAndServer(id, 's-1')).not.toBeNull();
    expect(await ReactionRoleRepository.findByIdAndServer(id, 'other')).toBeNull();
    expect(await ReactionRoleRepository.findByMessageAndEmoji('m-1', '✅')).toHaveLength(1);
    expect(await ReactionRoleRepository.findDuplicate('m-1', '✅', 'r-1')).not.toBeNull();
    await ReactionRoleRepository.delete(id);
    expect(await ReactionRoleRepository.findByIdAndServer(id, 's-1')).toBeNull();
  });

  it.each(['serverId', 'channelId', 'messageId', 'emoji', 'roleId', 'createdBy'] as const)('rejects empty %s before mutation', async (field) => {
    await expect(ReactionRoleRepository.createIfAbsent(reactionInput({ [field]: ' ' }))).rejects.toThrow(TypeError);
  });
});
