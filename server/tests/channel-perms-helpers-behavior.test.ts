process.env.NODE_ENV = 'test';
jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

import {
  assertChannelInServer,
  assertRoleInServer,
  emitPermsUpdated,
  getIo,
  sendPermLogMessage,
  writePermAudit,
} from '../routes/channelPerms/helpers';
import { Auth, Channels, Messages, Roles, Servers } from '../db/repositories';

const db = require('../db/loader');

describe('channel permission shared helpers', () => {
  beforeEach(async () => {
    db._reset?.();
    jest.restoreAllMocks();
    await db.servers.insert({ _id: 's1', name: 'Server', ownerId: 'owner' });
    await db.channels.insert({ _id: 'c1', serverId: 's1', name: 'general', type: 'text' });
    await db.channels.insert({ _id: 'log1', serverId: 's1', name: 'audit', type: 'text' });
    await db.roles.insert({ _id: 'r1', serverId: 's1', name: 'Role', permissions: 0 });
  });

  it('getIo and emitPermsUpdated support absent and configured Socket.IO', () => {
    const noIoReq = { app: { get: jest.fn().mockReturnValue(undefined) } } as any;
    expect(getIo(noIoReq)).toBeNull();
    expect(() => emitPermsUpdated(noIoReq, 's1', 'c1')).not.toThrow();

    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const io = { to } as any;
    const req = { app: { get: jest.fn().mockReturnValue(io) } } as any;
    expect(getIo(req)).toBe(io);
    emitPermsUpdated(req, 's1', 'c1');
    expect(to).toHaveBeenCalledWith('server:s1');
    expect(emit).toHaveBeenCalledWith('permissions:updated', { serverId: 's1', channelId: 'c1' });
  });

  it('writePermAudit serializes optional old/new values and actor/target fallbacks', async () => {
    const spy = jest.spyOn(Auth, 'insertAuditLog').mockResolvedValue(undefined as any);
    await writePermAudit('s1', 'actor', 'c1', 'r1', 'PERM_UPDATE', { allow: 0 }, { allow: 1 }, {
      actorName: 'Actor Name', targetName: 'Role Name', reason: 'test',
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 's1', channelId: 'c1', actorId: 'actor', actorName: 'Actor Name',
      targetId: 'r1', targetName: 'Role Name', old: JSON.stringify({ allow: 0 }),
      new: JSON.stringify({ allow: 1 }),
    }));

    await writePermAudit('s1', 'actor2', 'c1', null, 'PERM_DELETE', null, null);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      actorName: 'actor2', targetName: '', old: null, new: null,
    }));
  });

  it('writePermAudit treats audit storage failure as advisory', async () => {
    jest.spyOn(Auth, 'insertAuditLog').mockRejectedValue(new Error('audit down'));
    await expect(writePermAudit('s1', 'actor', 'c1', 'r1', 'PERM_UPDATE', null, null)).resolves.toBeUndefined();
  });

  it('sendPermLogMessage exits when no log channel is configured', async () => {
    const create = jest.spyOn(Messages, 'create');
    await sendPermLogMessage({ app: { get: () => null } } as any, 's1', 'c1', 'PERM_UPDATE', 'Actor', 'Role', null, null);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['PERM_UPDATE', { allow: 1, deny: 2 }, { allow: 4, deny: 8 }, /allow: 1→4, deny: 2→8/],
    ['PERM_DELETE', { allow: 1, deny: 2 }, null, /önceki: allow=1, deny=2/],
    ['PERM_BULK_SYNC', null, { overrideCount: 3 }, /3 override kopyalandı/],
    ['PERM_UNDO', null, null, /İzin değişikliği geri alındı/],
    ['CUSTOM_ACTION', null, null, /CUSTOM_ACTION/],
  ])('sends a system log message for %s with the relevant summary', async (action, oldVals, newVals, pattern) => {
    await db.servers.update({ _id: 's1' }, { $set: { logChannelId: 'log1' } });
    // The stored row is what gets broadcast (Final21 Phase 15), so the double returns it.
    const create = jest.spyOn(Messages, 'create').mockImplementation(async (row: any) => row);
    const emit = jest.fn();
    const io = { to: jest.fn().mockReturnValue({ emit }) } as any;
    await sendPermLogMessage({ app: { get: () => io } } as any, 's1', 'c1', action, 'Actor', 'Role', oldVals as any, newVals as any);
    expect(create).toHaveBeenCalledTimes(1);
    const row = create.mock.calls[0][0] as any;
    expect(row.channelId).toBe('log1');
    expect(row.content).toMatch(pattern);
    expect(row.content).toMatch(/#general/);
    expect(emit).toHaveBeenCalledWith('message:new', expect.objectContaining({ channelId: 'log1', serverId: 's1' }));
  });

  it('uses channel id/target fallback and does not emit when Socket.IO is absent', async () => {
    await db.servers.update({ _id: 's1' }, { $set: { logChannelId: 'log1' } });
    const create = jest.spyOn(Messages, 'create').mockResolvedValue({} as any);
    await sendPermLogMessage({ app: { get: () => null } } as any, 's1', 'missing-channel', 'PERM_BULK_SYNC', 'Actor', '', null, {});
    const content = (create.mock.calls[0][0] as any).content;
    expect(content).toMatch(/#missing-channel/);
    expect(content).toMatch(/Hedef: \*\*\?\*\*/);
    expect(content).not.toMatch(/override kopyalandı/);
  });

  it('treats message/log lookup failures as advisory rather than breaking permission mutation', async () => {
    jest.spyOn(Servers, 'findById').mockRejectedValue(new Error('server lookup failed'));
    await expect(sendPermLogMessage({ app: { get: () => null } } as any, 's1', 'c1', 'PERM_UPDATE', 'Actor', 'Role', null, null)).resolves.toBeUndefined();
  });

  it('assertChannelInServer fails closed for empty, missing and cross-tenant channels', async () => {
    expect(await assertChannelInServer('', 's1')).toBe(false);
    expect(await assertChannelInServer('c1', '')).toBe(false);
    expect(await assertChannelInServer('missing', 's1')).toBe(false);
    expect(await assertChannelInServer('c1', 'other')).toBe(false);
    expect(await assertChannelInServer('c1', 's1')).toBe(true);
  });

  it('assertRoleInServer recognizes canonical everyone aliases and rejects foreign/missing roles', async () => {
    expect(await assertRoleInServer('', 's1')).toBe(false);
    expect(await assertRoleInServer('r1', '')).toBe(false);
    expect(await assertRoleInServer('__everyone__', 's1')).toBe(true);
    expect(await assertRoleInServer('s1', 's1')).toBe(true);
    expect(await assertRoleInServer('missing', 's1')).toBe(false);
    expect(await assertRoleInServer('r1', 's1')).toBe(true);
    await db.servers.insert({ _id: 's2', name: 'Two', ownerId: 'two' });
    await db.roles.insert({ _id: 'r2', serverId: 's2', name: 'Foreign', permissions: 0 });
    expect(await assertRoleInServer('r2', 's1')).toBe(false);
  });
});
