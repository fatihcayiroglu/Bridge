'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb({ withPgPool: true }));

import ServerAssets from '../db/repositories/ServerAssetRepository';
const db = require('../db/loader');

describe('ServerAssetRepository PostgreSQL durability contracts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes one sticker pack with one server-scoped DELETE and relies on FK cascade', async () => {
    db._pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ _id: 'pack-1' }] });
    await expect(ServerAssets.deleteStickerPack('pack-1', 'server-1')).resolves.toEqual({ changes: 1 });
    expect(db._pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db._pool.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM sticker_packs');
    expect(sql).toContain('_id = $1');
    expect(sql).toContain('"serverId" = $2');
    expect(sql).toContain('RETURNING _id');
    expect(params).toEqual(['pack-1', 'server-1']);
  });

  it('deletes all server sticker packs with one scoped statement', async () => {
    db._pool.query.mockResolvedValueOnce({ rowCount: 3, rows: [] });
    await expect(ServerAssets.deleteStickerPacksByServer('server-1')).resolves.toEqual({ changes: 3 });
    expect(db._pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db._pool.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM sticker_packs');
    expect(sql).toContain('"serverId" = $1');
    expect(params).toEqual(['server-1']);
  });

  it('uses one atomic ON CONFLICT upsert for first-write onboarding races', async () => {
    db._pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ _id: 'cfg-1', serverId: 'server-1' }] });
    await ServerAssets.upsertOnboarding('server-1', {
      enabled: true,
      rulesChannelId: 'rules',
      welcomeChannelId: 'welcome',
      welcomeMessage: 'hello',
      verificationLevel: 2,
      defaultRoles: ['role-1'],
      questions: [{ id: 'q1' }],
      updatedAt: 123,
    });
    expect(db._pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db._pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO server_onboarding');
    expect(sql).toContain('ON CONFLICT ("serverId") DO UPDATE');
    expect(sql).toContain('RETURNING *');
    expect(params[1]).toBe('server-1');
    expect(params[2]).toBe(true);
    expect(params[7]).toBe('["role-1"]');
    expect(params[8]).toBe('[{"id":"q1"}]');
    expect(params[10]).toBe(123);
  });
});
