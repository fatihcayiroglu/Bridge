const mockDb: any = {};
function store() { return { find: jest.fn(), findOne: jest.fn(), insert: jest.fn(), update: jest.fn(), remove: jest.fn() }; }
function reset() { mockDb.channelPermissions = store(); delete mockDb._pool; }
reset();
jest.mock('../db/loader', () => mockDb);

import ChannelPermissions from '../db/repositories/ChannelPermissionRepository';

function poolClient(handler: (sql: string, params?: unknown[]) => any) {
  const client = { query: jest.fn(async (sql: string, params?: unknown[]) => handler(sql, params)), release: jest.fn() };
  mockDb._pool = { connect: jest.fn(async () => client) };
  return client;
}

const rows = [
  { roleId: 'r1', allow: 1, deny: 0 },
  { roleId: 'r2', allow: 0, deny: 2 },
];

describe('ChannelPermissionRepository transactional permission ownership', () => {
  beforeEach(() => { jest.clearAllMocks(); reset(); });

  it('keeps the permission store required and normalizes missing list results', async () => {
    mockDb.channelPermissions.find.mockResolvedValue(undefined);
    await expect(ChannelPermissions.findByChannel('c1')).resolves.toEqual([]);
    await expect(ChannelPermissions.find({ serverId: 's1' })).resolves.toEqual([]);
    await ChannelPermissions.findOne({ channelId: 'c1', roleId: 'r1' });
    await ChannelPermissions.removeByChannel('c1');
    expect(mockDb.channelPermissions.remove).toHaveBeenCalledWith({ channelId: 'c1' });
    const saved = mockDb.channelPermissions;
    mockDb.channelPermissions = undefined;
    await expect(ChannelPermissions.findByChannel('c1')).rejects.toThrow(/store unavailable/);
    mockDb.channelPermissions = saved;
  });

  it('basic insert/update/remove forward exact canonical filters', async () => {
    mockDb.channelPermissions.insert.mockImplementation(async (row: any) => row);
    const generated: any = await ChannelPermissions.insert({ channelId: 'c1', roleId: 'r1' });
    expect(generated._id).toEqual(expect.any(String));
    const explicit: any = await ChannelPermissions.insert({ _id: 'p1', channelId: 'c1', roleId: 'r1' });
    expect(explicit._id).toBe('p1');
    await ChannelPermissions.update({ channelId: 'c1', roleId: 'r1' }, { $set: { allow: 1 } });
    await ChannelPermissions.remove({ channelId: 'c1', roleId: 'r1' });
    expect(mockDb.channelPermissions.update).toHaveBeenCalledWith({ channelId: 'c1', roleId: 'r1' }, { $set: { allow: 1 } });
  });

  it('rejects duplicate/malformed atomic replacement and batch inputs before storage', async () => {
    await expect(ChannelPermissions.replaceManyChannelsAtomic('', ['c1'], rows)).rejects.toThrow(/replacement scope/);
    await expect(ChannelPermissions.replaceManyChannelsAtomic('s1', ['c1', 'c1'], rows)).rejects.toThrow(/replacement scope/);
    await expect(ChannelPermissions.replaceManyChannelsAtomic('s1', ['c1'], [...rows, rows[0]])).rejects.toThrow(/duplicate/);
    await expect(ChannelPermissions.replaceManyChannelsAtomic('s1', ['c1'], [{ roleId: 'r1', allow: 1.5, deny: 0 }])).rejects.toThrow(/invalid/i);
    await expect(ChannelPermissions.applyChannelBatchAtomic('s1', 'c1', rows, ['r1'])).rejects.toThrow(/updated and deleted/);
    await expect(ChannelPermissions.applyChannelBatchAtomic('s1', 'c1', [], ['r1', 'r1'])).rejects.toThrow(/batch scope/);
    expect(mockDb.channelPermissions.remove).not.toHaveBeenCalled();
  });

  it('fallback replacement serially replaces every target with canonical server/channel ownership', async () => {
    mockDb.channelPermissions.remove.mockResolvedValue(undefined);
    mockDb.channelPermissions.insert.mockImplementation(async (row: any) => row);
    await expect(ChannelPermissions.replaceManyChannelsAtomic('s1', ['c1', 'c2'], rows)).resolves.toBe(true);
    expect(mockDb.channelPermissions.remove.mock.calls).toEqual([[{ channelId: 'c1' }], [{ channelId: 'c2' }]]);
    expect(mockDb.channelPermissions.insert).toHaveBeenCalledTimes(4);
    for (const [row] of mockDb.channelPermissions.insert.mock.calls) {
      expect(row.serverId).toBe('s1'); expect(['c1', 'c2']).toContain(row.channelId);
    }
  });

  it('fallback batch deletes, updates existing and inserts missing rows', async () => {
    mockDb.channelPermissions.findOne
      .mockResolvedValueOnce({ _id: 'existing' })
      .mockResolvedValueOnce(null);
    await expect(ChannelPermissions.applyChannelBatchAtomic('s1', 'c1', rows, ['r3'])).resolves.toBe(true);
    expect(mockDb.channelPermissions.remove).toHaveBeenCalledWith({ channelId: 'c1', roleId: 'r3' });
    expect(mockDb.channelPermissions.update).toHaveBeenCalledWith({ channelId: 'c1', roleId: 'r1' }, expect.objectContaining({ $set: expect.objectContaining({ allow: 1, deny: 0 }) }));
    expect(mockDb.channelPermissions.insert).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'c1', serverId: 's1', roleId: 'r2', allow: 0, deny: 2 }));
  });

  it('PostgreSQL replacement verifies every channel under lock and refuses partial tenant sets', async () => {
    const missing = poolClient((sql) => sql.includes('SELECT _id FROM channels') ? { rows: [{ _id: 'c1' }] } : { rows: [] });
    await expect(ChannelPermissions.replaceManyChannelsAtomic('s1', ['c1', 'c2'], rows)).resolves.toBe(false);
    expect(missing.query).toHaveBeenCalledWith('ROLLBACK');
    expect(missing.query.mock.calls.some(c => String(c[0]).startsWith('DELETE FROM channel_permissions'))).toBe(false);
    expect(missing.release).toHaveBeenCalledTimes(1);
  });

  it('PostgreSQL replacement commits delete+all inserts in one transaction', async () => {
    const client = poolClient((sql) => sql.includes('SELECT _id FROM channels') ? { rows: [{ _id: 'c1' }, { _id: 'c2' }] } : { rows: [] });
    await expect(ChannelPermissions.replaceManyChannelsAtomic('s1', ['c1', 'c2'], rows)).resolves.toBe(true);
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[1][1]).toEqual(['s1', ['c1', 'c2']]);
    expect(client.query.mock.calls.filter(c => String(c[0]).startsWith('INSERT INTO channel_permissions'))).toHaveLength(4);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('PostgreSQL replacement preserves the original error and rolls back', async () => {
    const original = new Error('insert failed');
    const client = poolClient((sql) => {
      if (sql.includes('SELECT _id FROM channels')) return { rows: [{ _id: 'c1' }] };
      if (sql.startsWith('INSERT INTO channel_permissions')) throw original;
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [] };
    });
    await expect(ChannelPermissions.replaceManyChannelsAtomic('s1', ['c1'], rows)).rejects.toBe(original);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK'); expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('PostgreSQL batch scopes channel ownership and atomically deletes/upserts roles', async () => {
    const client = poolClient((sql) => sql.includes('SELECT _id FROM channels') ? { rows: [{ _id: 'c1' }] } : { rows: [] });
    await expect(ChannelPermissions.applyChannelBatchAtomic('s1', 'c1', rows, ['r3'])).resolves.toBe(true);
    expect(client.query.mock.calls[1][1]).toEqual(['c1', 's1']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('"roleId"=ANY'), ['c1', ['r3']]);
    const upserts = client.query.mock.calls.filter(c => String(c[0]).includes('ON CONFLICT ("channelId","roleId")'));
    expect(upserts).toHaveLength(2);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('PostgreSQL batch returns false for a missing scoped channel and rolls back write failures', async () => {
    const missing = poolClient((sql) => sql.includes('SELECT _id FROM channels') ? { rows: [] } : { rows: [] });
    await expect(ChannelPermissions.applyChannelBatchAtomic('s1', 'c1', rows, [])).resolves.toBe(false);
    expect(missing.query).toHaveBeenCalledWith('ROLLBACK');

    const original = new Error('upsert failed');
    const failing = poolClient((sql) => {
      if (sql.includes('SELECT _id FROM channels')) return { rows: [{ _id: 'c1' }] };
      if (sql.startsWith('INSERT INTO channel_permissions')) throw original;
      return { rows: [] };
    });
    await expect(ChannelPermissions.applyChannelBatchAtomic('s1', 'c1', rows, [])).rejects.toBe(original);
    expect(failing.query).toHaveBeenCalledWith('ROLLBACK'); expect(failing.release).toHaveBeenCalledTimes(1);
  });
});
