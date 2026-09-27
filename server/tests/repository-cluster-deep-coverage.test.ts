process.env.NODE_ENV = 'test';
process.env.AP_ENCRYPTION_KEY = process.env.AP_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { createMockDb, requireDoc } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

import Users from '../db/repositories/UserRepository';
import Members from '../db/repositories/MemberRepository';
import Servers from '../db/repositories/ServerRepository';
import Threads from '../db/repositories/ThreadRepository';

type QueryResult = { rows?: Array<Record<string, unknown>>; rowCount?: number };

function pgClient(handler: (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>) {
  return {
    query: jest.fn((sql: string, params?: unknown[]) => Promise.resolve(handler(sql, params))),
    release: jest.fn(),
  };
}

describe('repository core deep behavior', () => {
  beforeEach(() => {
    mockDb._reset();
    delete (mockDb as unknown as { _pool?: unknown })._pool;
    jest.restoreAllMocks();
  });

  describe('UserRepository', () => {
    const registration = {
      _id: 'registration-user', username: 'registered', displayName: 'Registered',
      password: 'hash', avatarColor: '#123456', createdAt: 123,
    };

    it('rejects every incomplete SSO identity operation without touching storage', async () => {
      await expect(Users.findBySsoIdentity('', 'issuer', 'id')).resolves.toBeNull();
      await expect(Users.findBySsoIdentity('oidc', '', 'id')).resolves.toBeNull();
      await expect(Users.findBySsoIdentity('oidc', 'issuer', '')).resolves.toBeNull();
      await expect(Users.findLegacySsoIdentity('', 'id')).resolves.toBeNull();
      await expect(Users.findLegacySsoIdentity('oidc', '')).resolves.toBeNull();
      await expect(Users.claimSsoIdentity('', 'oidc', 'issuer', 'id')).resolves.toBe(false);
      await expect(Users.claimSsoIdentity('u', '', 'issuer', 'id')).resolves.toBe(false);
      await expect(Users.claimSsoIdentity('u', 'oidc', '', 'id')).resolves.toBe(false);
      await expect(Users.claimSsoIdentity('u', 'oidc', 'issuer', '')).resolves.toBe(false);
      await expect(Users.upgradeLegacySsoIdentity('', 'oidc', 'issuer', 'id')).resolves.toBe(false);
      await expect(Users.upgradeLegacySsoIdentity('u', '', 'issuer', 'id')).resolves.toBe(false);
      await expect(Users.upgradeLegacySsoIdentity('u', 'oidc', '', 'id')).resolves.toBe(false);
      await expect(Users.upgradeLegacySsoIdentity('u', 'oidc', 'issuer', '')).resolves.toBe(false);
      await expect(mockDb.users.count()).resolves.toBe(0);
    });

    it.each([
      ['id', { _id: '' }],
      ['username', { username: '' }],
      ['displayName', { displayName: '' }],
      ['password', { password: '' }],
      ['avatarColor', { avatarColor: '' }],
      ['status', { status: '' }],
      ['bio', { bio: 1 }],
      ['tokenVersion type', { tokenVersion: '0' }],
      ['tokenVersion fractional', { tokenVersion: 0.5 }],
      ['tokenVersion negative', { tokenVersion: -1 }],
      ['createdAt type', { createdAt: '123' }],
      ['createdAt fractional', { createdAt: 1.5 }],
      ['createdAt non-positive', { createdAt: 0 }],
    ])('rejects invalid registration field: %s', async (_name, patch) => {
      await expect(Users.createWithApKeys({ ...registration, ...patch }, 'public', 'private'))
        .rejects.toThrow('invalid registration identity data');
    });

    it('rejects missing AP registration keys and applies all safe registration defaults', async () => {
      await expect(Users.createWithApKeys(registration, '', 'private')).rejects.toThrow(TypeError);
      await expect(Users.createWithApKeys(registration, 'public', '')).rejects.toThrow(TypeError);
      const created = await Users.createWithApKeys(registration, 'public', 'private');
      expect(created).toMatchObject({ _id: registration._id, apPublicKey: 'public' });
      expect(await Users.getApPrivateKey(registration._id)).toBe('private');
    });

    it('rolls back registration when PostgreSQL returns no inserted user, preserving rollback failures', async () => {
      const original = new Error('registration user insert returned no row');
      const client = pgClient((sql) => {
        if (/INSERT INTO users/.test(sql)) return { rows: [] };
        if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback failed'));
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Users.createWithApKeys(registration, 'public', 'private')).rejects.toThrow(original.message);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query).not.toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('compensates a fallback registration even when cleanup itself fails', async () => {
      const keyAuthority = mockDb.userApKeys;
      const remove = jest.spyOn(mockDb.users, 'remove').mockRejectedValueOnce(new Error('cleanup failed'));
      (mockDb as unknown as { userApKeys?: unknown }).userApKeys = undefined;
      try {
        await expect(Users.createWithApKeys(registration, 'public', 'private')).rejects.toThrow();
        expect(remove).toHaveBeenCalledWith({ _id: registration._id });
      } finally {
        (mockDb as unknown as { userApKeys: unknown }).userApKeys = keyAuthority;
      }
    });

    it('does not compensate when the initial fallback user insert itself fails', async () => {
      const insert = jest.spyOn(mockDb.users, 'insert').mockRejectedValueOnce(new Error('user insert failed'));
      const remove = jest.spyOn(mockDb.users, 'remove');
      await expect(Users.createWithApKeys(registration, 'public', 'private')).rejects.toThrow('user insert failed');
      expect(remove).not.toHaveBeenCalled();
      insert.mockRestore();
    });

    it('validates every persisted X3DH key component and flags corrupt material', async () => {
      const signedCases: unknown[] = [
        [], { keyId: 0.5, publicKey: 'p', signature: 's' },
        { keyId: -1, publicKey: 'p', signature: 's' },
        { keyId: 2_147_483_648, publicKey: 'p', signature: 's' },
        { keyId: 1, publicKey: 1, signature: 's' },
        { keyId: 1, publicKey: '', signature: 's' },
        { keyId: 1, publicKey: 'p'.repeat(257), signature: 's' },
        { keyId: 1, publicKey: 'p', signature: 1 },
        { keyId: 1, publicKey: 'p', signature: '' },
        { keyId: 1, publicKey: 'p', signature: 's'.repeat(513) },
        { keyId: 1, publicKey: 'p', signature: 's', extra: true },
      ];
      const oneTimeCases: unknown[] = [
        [], { keyId: 0.5, publicKey: 'p' }, { keyId: -1, publicKey: 'p' },
        { keyId: 2_147_483_648, publicKey: 'p' }, { keyId: 1, publicKey: 1 },
        { keyId: 1, publicKey: '' }, { keyId: 1, publicKey: 'p'.repeat(257) },
        { keyId: 1, publicKey: 'p', extra: true },
      ];
      const query = jest.fn();
      (mockDb as unknown as { _pool: { query: jest.Mock } })._pool = { query };
      for (const signed_pre_key of signedCases) {
        query.mockResolvedValueOnce({ rows: [{
          _id: 'u', identity_key: 'identity', signed_pre_key,
          one_time_pre_key: null, remaining_count: 0,
        }] });
        await expect(Users.consumeX3dhPreKeyBundle('u')).resolves.toMatchObject({
          signedPreKey: null, invalidState: true,
        });
      }
      for (const one_time_pre_key of oneTimeCases) {
        query.mockResolvedValueOnce({ rows: [{
          _id: 'u', identity_key: 'identity', signed_pre_key: null,
          one_time_pre_key, remaining_count: 0,
        }] });
        await expect(Users.consumeX3dhPreKeyBundle('u')).resolves.toMatchObject({
          oneTimePreKey: null, invalidState: true,
        });
      }
      query.mockResolvedValueOnce({ rows: [{
        _id: 7, identity_key: 99, signed_pre_key: null,
        one_time_pre_key: null, remaining_count: 0,
      }] });
      await expect(Users.consumeX3dhPreKeyBundle('u')).resolves.toMatchObject({
        _id: '7', identityKey: null, invalidState: true,
      });
    });

    it('handles missing, empty and corrupt X3DH fallback rows and releases its lock after failure', async () => {
      await expect(Users.consumeX3dhPreKeyBundle('missing')).resolves.toBeNull();
      await mockDb.users.insert({
        _id: 'u', x3dhIdentityKey: 9, x3dhSignedPreKey: 'bad', x3dhOneTimePreKeys: 'bad',
      });
      await expect(Users.consumeX3dhPreKeyBundle('u')).resolves.toMatchObject({
        identityKey: null, signedPreKey: null, oneTimePreKey: null,
        remainingOneTimeKeys: 0, invalidState: true,
      });

      await mockDb.users.update({ _id: 'u' }, { $set: {
        x3dhIdentityKey: 'identity',
        x3dhSignedPreKey: { keyId: 1, publicKey: 'signed', signature: 'sig' },
        x3dhOneTimePreKeys: [{ keyId: 2, publicKey: 'once' }],
      } });
      const update = jest.spyOn(mockDb.users, 'update').mockRejectedValueOnce(new Error('write failed'));
      await expect(Users.consumeX3dhPreKeyBundle('u')).rejects.toThrow('write failed');
      update.mockRestore();
      await expect(Users.consumeX3dhPreKeyBundle('u')).resolves.toMatchObject({
        oneTimePreKey: { keyId: 2, publicKey: 'once' }, remainingOneTimeKeys: 0,
      });
    });

    it.each([
      ['', 'secret', 1, []], ['u', '', 1, []], ['u', 'secret', -1, []],
      ['u', 'secret', 0.5, []], ['u', 'secret', 1, 'bad'],
      ['u', 'secret', 1, ['not-a-sha256']],
    ])('rejects invalid two-factor activation state %#', async (userId, secret, step, backupHashes) => {
      await expect(Users.enableTwoFactorWithStep(
        userId as string, secret as string, step as number, backupHashes as string[],
      )).rejects.toThrow('invalid two-factor activation state');
    });

    it('enables two-factor atomically in PostgreSQL and serializes the fallback winner', async () => {
      const hash = 'a'.repeat(64);
      const query = jest.fn()
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 0 });
      (mockDb as unknown as { _pool: { query: jest.Mock } })._pool = { query };
      await expect(Users.enableTwoFactorWithStep('u', 'secret', 8, [hash])).resolves.toBe(true);
      await expect(Users.enableTwoFactorWithStep('u', 'secret', 8, [hash])).resolves.toBe(false);

      delete (mockDb as unknown as { _pool?: unknown })._pool;
      await mockDb.users.insert({ _id: 'u', twoFactorSecret: 'secret', twoFactorEnabled: false });
      const results = await Promise.all([
        Users.enableTwoFactorWithStep('u', 'secret', 9, [hash]),
        Users.enableTwoFactorWithStep('u', 'secret', 9, [hash]),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await expect(Users.enableTwoFactorWithStep('missing', 'secret', 9, [hash])).resolves.toBe(false);
      await expect(Users.enableTwoFactorWithStep('u', 'wrong', 9, [hash])).resolves.toBe(false);
    });

    it.each([['', 1], ['u', -1], ['u', 0.5]])('rejects invalid TOTP consumption %#', async (userId, step) => {
      await expect(Users.consumeTotpStep(userId as string, step as number)).rejects.toThrow('invalid TOTP step');
    });

    it('consumes TOTP steps once across PostgreSQL and fallback concurrency, failing closed on corruption', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 0 });
      (mockDb as unknown as { _pool: { query: jest.Mock } })._pool = { query };
      await expect(Users.consumeTotpStep('u', 10)).resolves.toBe(true);
      await expect(Users.consumeTotpStep('u', 10)).resolves.toBe(false);

      delete (mockDb as unknown as { _pool?: unknown })._pool;
      await mockDb.users.insert({ _id: 'disabled', twoFactorEnabled: false });
      await expect(Users.consumeTotpStep('disabled', 10)).resolves.toBe(false);
      await mockDb.users.insert({ _id: 'enabled', twoFactorEnabled: true, twoFactorLastUsedStep: null });
      const winners = await Promise.all([
        Users.consumeTotpStep('enabled', 11), Users.consumeTotpStep('enabled', 11),
      ]);
      expect(winners.filter(Boolean)).toHaveLength(1);
      await expect(Users.consumeTotpStep('enabled', 10)).resolves.toBe(false);
      await mockDb.users.insert({ _id: 'corrupt', twoFactorEnabled: true, twoFactorLastUsedStep: '01' });
      await expect(Users.consumeTotpStep('corrupt', 12)).resolves.toBe(false);
    });

    it('filters invalid backup-code entries without accepting malformed persisted state', async () => {
      await mockDb.users.insert({ _id: 'array', twoFactorBackup: [1, '', 'short', 'valid-code-a'] });
      await expect(Users.consumeBackupCode('array', 'valid-code-a')).resolves.toBe(true);
      await mockDb.users.insert({ _id: 'json', twoFactorBackup: JSON.stringify([null, 'valid-code-b']) });
      await expect(Users.consumeBackupCode('json', 'valid-code-b')).resolves.toBe(true);
      await mockDb.users.insert({ _id: 'object', twoFactorBackup: '{}' });
      await expect(Users.consumeBackupCode('object', 'valid-code-c')).resolves.toBe(false);
      await mockDb.users.insert({ _id: 'missing-field' });
      await expect(Users.consumeBackupCode('missing-field', 'valid-code-d')).resolves.toBe(false);
      (mockDb as unknown as { _pool: { query: jest.Mock } })._pool = {
        query: jest.fn().mockResolvedValue({}),
      };
      await expect(Users.consumeBackupCode('missing-field', 'valid-code-d')).resolves.toBe(false);
    });

    it.each([
      ['', 'public', 'private'], ['u', '', 'private'], ['u', 'public', ''],
    ])('rejects invalid ActivityPub key material %#', async (userId, publicKey, privateKey) => {
      await expect(Users.saveApKeys(userId, publicKey, privateKey)).rejects.toThrow(TypeError);
    });

    it('runs AP key save/delete as transactions and preserves the original database failure', async () => {
      let client = pgClient((sql) => /UPDATE users SET "apPublicKey"/.test(sql)
        ? { rows: [], rowCount: 1 }
        : { rows: [] });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Users.saveApKeys('u', 'public', 'private')).resolves.toBeUndefined();
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      await expect(Users.deleteApKeys('u')).resolves.toBeUndefined();
      expect(client.query).toHaveBeenCalledWith('UPDATE users SET "apPublicKey"=NULL WHERE _id=$1', ['u']);

      client = pgClient((sql) => {
        if (/UPDATE users SET "apPublicKey"/.test(sql)) return { rows: [], rowCount: 0 };
        if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback failed'));
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Users.saveApKeys('missing', 'public', 'private')).rejects.toThrow('owner not found');
      expect(client.release).toHaveBeenCalledTimes(1);

      client = pgClient((sql) => {
        if (/DELETE FROM user_ap_keys/.test(sql)) throw new Error('delete failed');
        if (sql === 'ROLLBACK') throw new Error('rollback failed');
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Users.deleteApKeys('u')).rejects.toThrow('delete failed');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('fails closed on invalid AP key versions and recovers its serialized fallback lock', async () => {
      await mockDb.users.insert({ _id: 'u' });
      await mockDb.userApKeys.insert({ userId: 'u', apPrivateKeyEnc: 'not-used', keyVersion: 0 });
      await expect(Users.saveApKeys('u', 'public', 'private')).rejects.toThrow('Invalid ActivityPub keyVersion');
      await mockDb.userApKeys.update({ userId: 'u' }, { $set: { keyVersion: 'bad' } });
      await expect(Users.saveApKeys('u', 'public', 'private')).rejects.toThrow('ActivityPub keyVersion');
      await mockDb.userApKeys.remove({ userId: 'u' });
      await expect(Users.saveApKeys('u', 'public', 'private')).resolves.toBeUndefined();
      await expect(Users.deleteApKeys('')).rejects.toThrow('userId required');
    });

    it('covers default collection helper arguments', async () => {
      await Users.create({ _id: 'a', username: 'alpha', createdAt: 1 });
      await Users.create({ _id: 'b', username: 'beta', createdAt: 2 });
      await expect(Users.count()).resolves.toBe(2);
      await expect(Users.searchPaginated({})).resolves.toHaveLength(2);
      await expect(Users.findByIds([])).resolves.toEqual([]);
      await expect(Users.findByUsernames([])).resolves.toEqual([]);
    });
  });

  describe('MemberRepository', () => {
    it('honors explicit ban queries while filtering authorization lookups and malformed list results', async () => {
      await mockDb.members.insert({ _id: 'active', userId: 'u1', serverId: 's', banned: false });
      await mockDb.members.insert({ _id: 'banned', userId: 'u2', serverId: 's', banned: true });
      await expect(Members.findOne('u2', 's')).resolves.toBeNull();
      await expect(Members.findOne({ userId: 'u2', serverId: 's', banned: true })).resolves.toMatchObject({ _id: 'banned' });
      await expect(Members.findIncludingBanned('u2', 's')).resolves.toMatchObject({ _id: 'banned' });
      const find = jest.spyOn(mockDb.members, 'find').mockReturnValueOnce(null as never);
      await expect(Members.findByServer('s')).resolves.toEqual([]);
      find.mockReturnValueOnce(null as never);
      await expect(Members.findByUser('u1')).resolves.toEqual([]);
    });

    it.each([
      ['', {}], ['   ', {}], ['s', { cursor: { joinedAt: -1, userId: 'u' } }],
      ['s', { cursor: { joinedAt: 0.5, userId: 'u' } }],
      ['s', { cursor: { joinedAt: 1, userId: '' } }],
      ['s', { cursor: { joinedAt: 1, userId: 'x'.repeat(201) } }],
    ])('rejects invalid page scope %#', async (serverId, options) => {
      await expect(Members.findPageByServer(serverId as string, options as never)).rejects.toThrow();
    });

    it('covers page defaults, PostgreSQL no-cursor SQL and corrupt persisted timestamps', async () => {
      await mockDb.members.insert({ _id: 'a', userId: 'a', serverId: 's', joinedAt: 1, banned: false });
      await expect(Members.findPageByServer('s')).resolves.toHaveLength(1);
      const query = jest.fn().mockResolvedValueOnce({ rows: [{ userId: 'a', joinedAt: '2' }] });
      (mockDb as unknown as { _pool: { query: jest.Mock } })._pool = { query };
      await expect(Members.findPageByServer('s', { limit: 2 })).resolves.toEqual([{ userId: 'a', joinedAt: 2 }]);
      expect(query).toHaveBeenCalledWith(expect.not.stringContaining('> ($2::bigint'), ['s', 2]);
      query.mockResolvedValueOnce({ rows: [{ userId: 'a', joinedAt: '9007199254740992' }] });
      await expect(Members.findPageByServer('s')).rejects.toThrow('outside the supported cursor range');
      query.mockResolvedValueOnce({ rows: [{ userId: 'a', joinedAt: -1 }] });
      await expect(Members.findPageByServer('s')).rejects.toThrow('outside the supported cursor range');
    });

    it('handles malformed fallback page/list results and all deterministic tie directions', async () => {
      const find = jest.spyOn(mockDb.members, 'find');
      find.mockReturnValueOnce(null as never);
      await expect(Members.findPageByServer('s')).resolves.toEqual([]);
      find.mockReturnValueOnce([
        { userId: 'same', serverId: 's', joinedAt: 1 },
        { userId: 'same', serverId: 's', joinedAt: 1 },
        { userId: 'z', serverId: 's', joinedAt: 1 },
        { userId: 'a', serverId: 's', joinedAt: 1 },
      ] as never);
      await expect(Members.findPageByServer('s')).resolves.toHaveLength(4);
      find.mockReturnValueOnce([{ userId: 'active', serverId: 's' }] as never);
      await expect(Members.findByUser('active')).resolves.toHaveLength(1);
      find.mockReturnValueOnce(null as never);
      await expect(Members.findByServerIds(['s'])).resolves.toEqual([]);
    });

    it('performs CRUD, ban management, projections, timeout and count helpers', async () => {
      await Members.insert('u1', 's');
      await Members.insert('u2', 's', { roles: ['r'], joinedAt: 5 });
      await expect(Members.countByServer('s')).resolves.toBe(2);
      await Members.update('u1', 's', { nick: 'One' });
      await expect(Members.findWhere({ serverId: 's' })).resolves.toHaveLength(2);
      await expect(Members.countWhere()).resolves.toBe(2);
      await Members.banMember('s', 'u1', 'reason');
      await expect(Members.getBans('s')).resolves.toHaveLength(1);
      await Members.banMember('s', 'new-ban', { banReason: 'fields' });
      await expect(Members.getBans('s')).resolves.toHaveLength(2);
      await Members.banMember('s', 'default-ban');
      await expect(Members.getBans('s')).resolves.toHaveLength(3);
      await Members.unbanMember('s', 'new-ban');
      await expect(Members.findByServerIds([])).resolves.toEqual([]);
      await expect(Members.findByServerIds(['s'], { userId: 1 })).resolves.toHaveLength(1);
      await Members.setTimeout('s', 'u2', new Date(Date.now() + 60_000));
      await expect(Members.isTimedOut('u2', 's')).resolves.toBe(true);
      await Members.setTimeout('s', 'u2', null);
      await expect(Members.isTimedOut('u2', 's')).resolves.toBe(false);
      await expect(Members.isTimedOut('missing', 's')).resolves.toBe(false);
      await Members.removeMember('u2', 's');
      await Members.insert('u3', 'other');
      await Members.removeAllFromServer('s');
      await Members.removeAllForUser('u3');
      await expect(Members.countWhere({})).resolves.toBe(0);
    });

    it.each([
      ['', 's', []], ['u', '', []], [' ', 's', []], ['u', ' ', []],
      ['u', 's', 'bad'], ['u', 's', ['']], ['u', 's', [1]],
    ])('rejects invalid insert-if-absent input %#', async (userId, serverId, roles) => {
      await expect(Members.insertIfAbsent(userId as string, serverId as string, roles as string[])).rejects.toThrow();
    });

    it('gives exactly one insert-if-absent winner and exposes PostgreSQL ownership', async () => {
      const winners = await Promise.all([
        Members.insertIfAbsent('u', 's', ['r']), Members.insertIfAbsent('u', 's', ['r']),
      ]);
      expect(winners.filter(Boolean)).toHaveLength(1);
      const query = jest.fn()
        .mockResolvedValueOnce({ rows: [{ userId: 'pg' }] })
        .mockResolvedValueOnce({ rows: [] });
      (mockDb as unknown as { _pool: { query: jest.Mock } })._pool = { query };
      await expect(Members.insertIfAbsent('pg', 's')).resolves.toBe(true);
      await expect(Members.insertIfAbsent('pg', 's')).resolves.toBe(false);
    });

    it('normalizes stored roles and serializes fallback add/remove mutations', async () => {
      await mockDb.members.insert({
        _id: 'm', userId: 'u', serverId: 's', banned: false,
        roles: [' r1 ', 'r1', 9, '', 'r2'],
      });
      const [first, second] = await Promise.all([
        Members.addRole('u', 's', 'r3'), Members.addRole('u', 's', 'r4'),
      ]);
      expect(first).toContain('r3');
      expect(second).toEqual(expect.arrayContaining(['r1', 'r2', 'r3', 'r4']));
      await expect(Members.addRole('u', 's', 'r4')).resolves.toEqual(expect.arrayContaining(['r4']));
      await expect(Members.removeRole('u', 's', 'r2')).resolves.not.toContain('r2');
      await expect(Members.addRole('missing', 's', 'r')).resolves.toBeNull();
      await expect(Members.removeRole('missing', 's', 'r')).resolves.toBeNull();

      await mockDb.members.update({ userId: 'u', serverId: 's' }, { $set: { roles: 'legacy-role' } });
      await expect(Members.addRole('u', 's', 'new')).resolves.toEqual(['legacy-role', 'new']);
      await mockDb.members.update({ userId: 'u', serverId: 's' }, { $set: { roles: '[bad' } });
      await expect(Members.addRole('u', 's', 'new')).resolves.toEqual(['new']);
      await mockDb.members.update({ userId: 'u', serverId: 's' }, { $set: { roles: '{}' } });
      await expect(Members.addRole('u', 's', 'new')).resolves.toEqual(['new']);
      await mockDb.members.update({ userId: 'u', serverId: 's' }, { $set: { roles: 7 } });
      await expect(Members.addRole('u', 's', 'new')).resolves.toEqual(['new']);
      await mockDb.members.update({ userId: 'u', serverId: 's' }, { $set: { roles: '' } });
      await expect(Members.addRole('u', 's', 'new')).resolves.toEqual(['new']);
    });

    it('normalizes PostgreSQL role results and returns null for inactive memberships', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce({ rows: [{ roles: '["r1"," r2 ","r1"]' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ roles: [] }] })
        .mockResolvedValueOnce({ rows: [] });
      (mockDb as unknown as { _pool: { query: jest.Mock } })._pool = { query };
      await expect(Members.addRole('u', 's', 'r2')).resolves.toEqual(['r1', 'r2']);
      await expect(Members.addRole('missing', 's', 'r')).resolves.toBeNull();
      await expect(Members.removeRole('u', 's', 'r')).resolves.toEqual([]);
      await expect(Members.removeRole('missing', 's', 'r')).resolves.toBeNull();
    });

    it('releases the fallback role lock after a failed write', async () => {
      await mockDb.members.insert({ _id: 'm', userId: 'u', serverId: 's', roles: [] });
      const update = jest.spyOn(mockDb.members, 'update').mockRejectedValueOnce(new Error('roles write failed'));
      await expect(Members.addRole('u', 's', 'r1')).rejects.toThrow('roles write failed');
      update.mockRestore();
      await expect(Members.addRole('u', 's', 'r2')).resolves.toEqual(['r2']);
    });

    it('sets roles as canonical JSON and supports direct remove', async () => {
      await mockDb.members.insert({ _id: 'm', userId: 'u', serverId: 's' });
      await Members.setRoles('u', 's', ['r']);
      await expect(Members.findOne('u', 's')).resolves.toMatchObject({ roles: ['r'] });
      await Members.remove('u', 's');
      await expect(Members.findOne('u', 's')).resolves.toBeNull();
    });
  });

  describe('ServerRepository', () => {
    const atomicInput = {
      serverId: 'server-new', ownerId: 'owner', name: 'Server', icon: 'icon',
      textChannelId: 'text', voiceChannelId: 'voice', createdAt: 123,
      maxOwnedServers: 2,
    };

    it('covers finder, CRUD, member, count and sort helpers', async () => {
      await Servers.create({ _id: 's1', ownerId: 'u', name: 'one', createdAt: 1 });
      await Servers.create({ _id: 's2', ownerId: 'u', name: 'two', createdAt: 2 });
      await expect(Servers.findById('s1')).resolves.toMatchObject({ name: 'one' });
      await expect(Servers.findByOwner('u')).resolves.toHaveLength(2);
      await expect(Servers.findByIds([])).resolves.toEqual([]);
      await expect(Servers.findByIds(['s2'])).resolves.toHaveLength(1);
      await expect(Servers.find({ ownerId: 'u' })).resolves.toHaveLength(2);
      await expect(Servers.findOne({ name: 'one' })).resolves.toMatchObject({ _id: 's1' });
      await expect(Servers.findJoinedByUser('missing')).resolves.toEqual([]);
      await Servers.addMember('u', 's1', ['r']);
      await Servers.addMember('default-roles', 's1');
      await expect(Servers.findJoinedByUser('u')).resolves.toHaveLength(1);
      await expect(Servers.getMember('u', 's1')).resolves.toMatchObject({ roles: ['r'] });
      await expect(Servers.getMembers('s1')).resolves.toHaveLength(2);
      await Servers.removeMember('u', 's1');
      await Servers.removeMember('default-roles', 's1');
      await Servers.update('s1', { name: 'updated' });
      await expect(Servers.count()).resolves.toBe(2);
      await expect(Servers.findRecentSorted()).resolves.toMatchObject([{ _id: 's2' }, { _id: 's1' }]);
      await expect(Servers.findRecentSorted(1)).resolves.toHaveLength(1);
      await Servers.delete('s2');
      await expect(Servers.count({ ownerId: 'u' })).resolves.toBe(1);
    });

    it.each([
      ['serverId', { serverId: '' }], ['ownerId', { ownerId: '' }],
      ['name', { name: '' }], ['icon', { icon: '' }],
      ['textChannelId', { textChannelId: '' }], ['voiceChannelId', { voiceChannelId: '' }],
      ['createdAt type', { createdAt: '1' }], ['createdAt fractional', { createdAt: 1.5 }],
      ['createdAt non-positive', { createdAt: 0 }], ['limit type', { maxOwnedServers: '2' }],
      ['limit fractional', { maxOwnedServers: 1.5 }], ['limit non-positive', { maxOwnedServers: 0 }],
    ])('rejects invalid atomic server creation field: %s', async (_name, patch) => {
      await expect(Servers.createWithDefaultsAtomic({ ...atomicInput, ...patch } as never)).rejects.toThrow();
    });

    it('serializes fallback creation, enforces the owner limit and compensates child failure', async () => {
      const [a, b] = await Promise.all([
        Servers.createWithDefaultsAtomic({ ...atomicInput, serverId: 'a', textChannelId: 'at', voiceChannelId: 'av', maxOwnedServers: 1 }),
        Servers.createWithDefaultsAtomic({ ...atomicInput, serverId: 'b', textChannelId: 'bt', voiceChannelId: 'bv', maxOwnedServers: 1 }),
      ]);
      expect([a.status, b.status].sort()).toEqual(['created', 'limit']);

      mockDb._reset();
      const insert = jest.spyOn(mockDb.channels, 'insert')
        .mockResolvedValueOnce({ _id: 'text' } as never)
        .mockRejectedValueOnce(new Error('voice channel failed'));
      await expect(Servers.createWithDefaultsAtomic(atomicInput)).rejects.toThrow('voice channel failed');
      expect(await mockDb.servers.findOne({ _id: atomicInput.serverId })).toBeNull();
      expect(await mockDb.channels.find({ serverId: atomicInput.serverId })).toEqual([]);
      insert.mockRestore();

      mockDb._reset();
      const child = jest.spyOn(mockDb.channels, 'insert').mockRejectedValueOnce(new Error('original child failure'));
      jest.spyOn(mockDb.members, 'remove').mockRejectedValueOnce(new Error('member cleanup failure'));
      jest.spyOn(mockDb.channels, 'remove').mockRejectedValueOnce(new Error('channel cleanup failure'));
      jest.spyOn(mockDb.servers, 'remove').mockRejectedValueOnce(new Error('server cleanup failure'));
      await expect(Servers.createWithDefaultsAtomic(atomicInput)).rejects.toThrow('original child failure');
      child.mockRestore();
    });

    it('fails before commit for corrupt PostgreSQL count and missing RETURNING row', async () => {
      let client = pgClient((sql) => {
        if (/COUNT\(\*\)/.test(sql)) return { rows: [] };
        if (/INSERT INTO servers/.test(sql)) return { rows: [{ _id: atomicInput.serverId }] };
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.createWithDefaultsAtomic(atomicInput)).resolves.toMatchObject({ status: 'created' });

      client = pgClient((sql) => /COUNT\(\*\)/.test(sql)
        ? { rows: [{ count: 'not-a-count' }] }
        : { rows: [] });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.createWithDefaultsAtomic(atomicInput)).rejects.toThrow('Invalid owned-server count');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');

      client = pgClient((sql) => {
        if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: '0' }] };
        if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback failed'));
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.createWithDefaultsAtomic(atomicInput)).rejects.toThrow('Server insert returned no row');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query).not.toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    function graphClient(options: { channels?: string[]; bots?: string[]; locked?: boolean } = {}) {
      const channels = options.channels ?? ['channel'];
      const bots = options.bots ?? ['bot'];
      const tables = [
        'servers', 'channels', 'channel_bridges', 'channel_follows', 'crosspost_log',
        'bots', 'bot_ratings', 'server_bots', 'channel_overrides', 'channel_permissions',
        'unread_counts', 'canvas_strokes', 'ap_messages', 'notification_prefs',
        'saved_messages', 'podcast_settings', 'podcast_episodes', 'server_events',
        'server_boosts', 'members', 'messages', 'invites', 'roles', 'soundboard',
      ];
      const columns: Record<string, string[]> = {
        channels: ['serverId'], channel_bridges: ['sourceServerId', 'targetServerId'],
        channel_follows: ['sourceServerId', 'targetServerId'],
        crosspost_log: ['sourceServerId', 'targetServerId'], bots: ['serverId'],
        bot_ratings: ['botId'], server_bots: ['serverId', 'botId'],
        channel_overrides: ['channelId'], channel_permissions: ['channelId', 'serverId'],
        unread_counts: ['channelId'], canvas_strokes: ['channelId'], ap_messages: ['channelId'],
        notification_prefs: ['channelId'], saved_messages: ['destinationType', 'destinationId'],
        podcast_settings: ['channelId', 'serverId'], podcast_episodes: ['channelId', 'serverId'],
        server_events: ['server_id'], server_boosts: ['serverId'], members: ['serverId'],
        messages: ['serverId'], invites: ['serverId'], roles: ['serverId'], soundboard: ['serverId'],
      };
      return pgClient((sql) => {
        if (/SELECT _id, "ownerId" FROM servers/.test(sql)) {
          return { rows: options.locked === false ? [] : [{ _id: 's', ownerId: 'owner' }] };
        }
        if (/information_schema\.tables/.test(sql)) return { rows: tables.map(table_name => ({ table_name })) };
        if (/information_schema\.columns/.test(sql)) {
          return { rows: Object.entries(columns).flatMap(([table_name, names]) =>
            names.map(column_name => ({ table_name, column_name }))) };
        }
        if (/SELECT _id FROM channels/.test(sql)) return { rows: channels.map(_id => ({ _id })) };
        if (/SELECT _id FROM bots/.test(sql)) return { rows: bots.map(_id => ({ _id })) };
        return { rows: [] };
      });
    }

    it('covers complete, empty and missing PostgreSQL deletion graphs', async () => {
      let client = graphClient();
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.deleteGraphAtomic('s', 'owner')).resolves.toBe('deleted');
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.query.mock.calls.some(([sql]) => /sourceServerId/.test(String(sql)))).toBe(true);

      client = graphClient({ channels: [], bots: [] });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.deleteGraphAtomic('s')).resolves.toBe('deleted');
      expect(client.query.mock.calls.some(([sql]) =>
        /DELETE FROM notification_prefs WHERE "channelId"=\$1/.test(String(sql)))).toBe(true);
      expect(client.query.mock.calls.some(([sql]) =>
        /DELETE FROM server_bots WHERE "serverId"=\$1/.test(String(sql)))).toBe(true);

      client = graphClient({ locked: false });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.deleteGraphAtomic('missing')).resolves.toBe('not_found');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('skips unavailable optional tables in sparse PostgreSQL schemas', async () => {
      let client = pgClient((sql) => {
        if (/SELECT _id, "ownerId" FROM servers/.test(sql)) return { rows: [{ _id: 's', ownerId: 'owner' }] };
        if (/information_schema\.tables/.test(sql)) return { rows: [{ table_name: 'servers' }] };
        if (/information_schema\.columns/.test(sql)) return { rows: [{ table_name: 'servers', column_name: '_id' }] };
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.deleteGraphAtomic('s')).resolves.toBe('deleted');
      expect(client.query.mock.calls.some(([sql]) => /SELECT _id FROM channels/.test(String(sql)))).toBe(false);
      expect(client.query.mock.calls.some(([sql]) => /SELECT _id FROM bots/.test(String(sql)))).toBe(false);

      const tables = ['servers', 'channels', 'bots'];
      client = pgClient((sql) => {
        if (/SELECT _id, "ownerId" FROM servers/.test(sql)) return { rows: [{ _id: 's', ownerId: 'owner' }] };
        if (/information_schema\.tables/.test(sql)) return { rows: tables.map(table_name => ({ table_name })) };
        if (/information_schema\.columns/.test(sql)) return { rows: [
          { table_name: 'servers', column_name: '_id' },
          { table_name: 'channels', column_name: 'serverId' },
          { table_name: 'bots', column_name: 'serverId' },
        ] };
        if (/SELECT _id FROM channels/.test(sql)) return { rows: [{ _id: 'channel' }] };
        if (/SELECT _id FROM bots/.test(sql)) return { rows: [{ _id: 'bot' }] };
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.deleteGraphAtomic('s')).resolves.toBe('deleted');
      expect(client.query.mock.calls.some(([sql]) => /bot_ratings|notification_prefs/.test(String(sql)))).toBe(false);
    });

    it('preserves a PostgreSQL graph failure when rollback also fails', async () => {
      const client = pgClient((sql) => {
        if (/SELECT _id, "ownerId" FROM servers/.test(sql)) return { rows: [{ _id: 's', ownerId: 'owner' }] };
        if (/information_schema\.tables/.test(sql)) throw new Error('catalog failed');
        if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback failed'));
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Servers.deleteGraphAtomic('s')).rejects.toThrow('catalog failed');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('deletes a complete fallback graph, handles empty ids and protects owner changes', async () => {
      await mockDb.servers.insert({ _id: 's', ownerId: 'owner' });
      await mockDb.channels.insert({ _id: 'c', serverId: 's' });
      await mockDb.bots.insert({ _id: 'b', serverId: 's' });
      await mockDb.channelBridges.insert({ _id: 'bridge', sourceServerId: 's', targetServerId: 'other' });
      await mockDb.serverBots.insert({ _id: 'sb', serverId: 'other', botId: 'b' });
      await mockDb.notificationPrefs.insert({ _id: 'pref', channelId: 'c' });
      await mockDb.messages.insert({ _id: 'message', serverId: 's' });
      await expect(Servers.deleteGraphAtomic('s', 'other')).resolves.toBe('owner_mismatch');
      await expect(Servers.deleteGraphAtomic('s', 'owner')).resolves.toBe('deleted');
      await expect(mockDb.servers.findOne({ _id: 's' })).resolves.toBeNull();
      await expect(mockDb.channelBridges.findOne({ _id: 'bridge' })).resolves.toBeNull();
      await expect(mockDb.serverBots.findOne({ _id: 'sb' })).resolves.toBeNull();

      await mockDb.servers.insert({ _id: 'empty', ownerId: 'owner' });
      await expect(Servers.deleteGraphAtomic('empty')).resolves.toBe('deleted');
      await expect(Servers.deleteGraphAtomic('missing')).resolves.toBe('not_found');
    });
  });

  describe('ThreadRepository', () => {
    const scope = {
      parentMessageId: 'parent', channelId: 'channel', serverId: 'server',
      name: 'Thread', createdBy: 'creator', createdAt: 10, lastMessageAt: 11,
      firstMessage: 'first', tags: ['tag'],
    };

    async function seedParent() {
      await mockDb.messages.insert({ _id: 'parent', channelId: 'channel', serverId: 'server' });
    }

    it('covers thread/message CRUD, bounded history and reply counters', async () => {
      const thread = await Threads.insert({
        _id: 'thread', parentMessageId: 'parent', channelId: 'channel', createdAt: 1,
      });
      await expect(Threads.findById(String(thread._id))).resolves.toMatchObject({ messageCount: 0 });
      await expect(Threads.findByParentMessage('parent')).resolves.toMatchObject({ _id: 'thread' });
      await expect(Threads.findByChannel('channel')).resolves.toHaveLength(1);
      await Threads.update('thread', { name: 'updated' });
      await Threads.setPinned('thread', true);
      await Threads.setPinned('thread', false);
      await Threads.setLocked('thread', true);
      await Threads.setLocked('thread', false);
      for (let i = 1; i <= 3; i += 1) {
        await Threads.insertMessage({ _id: `tm${i}`, threadId: 'thread', createdAt: i });
      }
      await expect(Threads.findMessages('thread')).resolves.toHaveLength(3);
      await expect(Threads.findMessages('thread', { limit: 500, before: 3 })).resolves.toHaveLength(2);
      await expect(Threads.listAllMessages('thread')).resolves.toHaveLength(3);
      await seedParent();
      await Threads.recordReply('thread', 'parent');
      await Threads.recordReply('thread');
      await expect(Threads.findById('thread')).resolves.toMatchObject({ messageCount: 2 });
      await expect(mockDb.messages.findOne({ _id: 'parent' })).resolves.toMatchObject({ threadCount: 1 });
      await Threads.deleteThread('thread');
      await expect(Threads.findById('thread')).resolves.toBeNull();
      await expect(Threads.listAllMessages('thread')).resolves.toEqual([]);
      await Threads.delete('missing');
    });

    it.each([
      [{ ...scope, parentMessageId: '' }], [{ ...scope, channelId: '' }],
      [{ ...scope, serverId: '' }], [{ ...scope, parentMessageId: 1 }],
      [{ ...scope, channelId: 1 }], [{ ...scope, serverId: 1 }],
    ])('rejects invalid parent scope %#', async (input) => {
      await expect(Threads.createForParentAtomic(input as never)).rejects.toThrow('invalid parent thread scope');
    });

    it('serializes fallback creation and rejects missing or changed-scope parents', async () => {
      await expect(Threads.createForParentAtomic(scope)).rejects.toThrow('Parent message disappeared');
      await mockDb.messages.insert({ _id: 'parent', channelId: 'other', serverId: 'server' });
      await expect(Threads.createForParentAtomic(scope)).rejects.toThrow('Parent message disappeared');
      mockDb._reset();
      await seedParent();
      const outcomes = await Promise.all([
        Threads.createForParentAtomic(scope), Threads.createForParentAtomic(scope),
      ]);
      expect(outcomes.filter(outcome => outcome.created)).toHaveLength(1);
      expect(outcomes[0].thread._id).toBe(outcomes[1].thread._id);
      await expect(mockDb.threads.count({ parentMessageId: 'parent' })).resolves.toBe(1);
    });

    it('compensates a fallback thread when parent tagging loses its scope or throws', async () => {
      await seedParent();
      const update = jest.spyOn(mockDb.messages, 'update').mockResolvedValueOnce({ updated: 0 });
      await expect(Threads.createForParentAtomic(scope)).rejects.toThrow('Parent message disappeared');
      await expect(mockDb.threads.count()).resolves.toBe(0);
      update.mockRejectedValueOnce(new Error('tag write failed'));
      await expect(Threads.createForParentAtomic(scope)).rejects.toThrow('tag write failed');
      await expect(mockDb.threads.count()).resolves.toBe(0);
      const remove = jest.spyOn(mockDb.threads, 'remove').mockRejectedValueOnce(new Error('cleanup failed'));
      update.mockResolvedValueOnce({ updated: 0 });
      await expect(Threads.createForParentAtomic(scope)).rejects.toThrow('Parent message disappeared');
      expect(remove).toHaveBeenCalled();
    });

    it('rejects a malformed fallback insert and releases the creation lock', async () => {
      await seedParent();
      const insert = jest.spyOn(Threads, 'insert').mockResolvedValueOnce({} as never);
      await expect(Threads.createForParentAtomic(scope)).rejects.toThrow('thread insert returned no id');
      insert.mockRestore();
      await expect(Threads.createForParentAtomic(scope)).resolves.toMatchObject({ created: true });
    });

    it('covers PostgreSQL missing parent, existing thread, defaults and custom creation', async () => {
      let client = pgClient((sql) => /SELECT _id,"channelId","serverId"/.test(sql)
        ? { rows: [] }
        : { rows: [] });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Threads.createForParentAtomic(scope)).rejects.toThrow('Parent message disappeared');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');

      client = pgClient((sql) => {
        if (/SELECT _id,"channelId","serverId"/.test(sql)) return { rows: [{ _id: 'parent' }] };
        if (/SELECT \* FROM threads/.test(sql)) return { rows: [{ _id: 'existing' }] };
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Threads.createForParentAtomic(scope)).resolves.toEqual({
        thread: { _id: 'existing' }, created: false,
      });

      client = pgClient((sql) => {
        if (/SELECT _id,"channelId","serverId"/.test(sql)) return { rows: [{ _id: 'parent' }] };
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Threads.createForParentAtomic({
        parentMessageId: 'parent', channelId: 'channel', serverId: 'server', createdBy: 'creator',
      })).resolves.toMatchObject({ created: true, thread: {
        name: '', firstMessage: '', tags: [], participantCount: 1, pinned: false, locked: false,
      } });

      client = pgClient((sql) => {
        if (/SELECT _id,"channelId","serverId"/.test(sql)) return { rows: [{ _id: 'parent' }] };
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Threads.createForParentAtomic(scope)).resolves.toMatchObject({
        created: true, thread: { name: 'Thread', firstMessage: 'first', tags: ['tag'] },
      });
    });

    it.each([
      [{ ...scope, createdBy: '' }], [{ ...scope, createdAt: 1.5 }],
      [{ ...scope, lastMessageAt: 1.5 }], [{ ...scope, createdBy: undefined }],
    ])('rolls back invalid PostgreSQL thread fields %#', async (input) => {
      const client = pgClient((sql) => /SELECT _id,"channelId","serverId"/.test(sql)
        ? { rows: [{ _id: 'parent' }] }
        : { rows: [] });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Threads.createForParentAtomic(input)).rejects.toThrow('invalid parent thread fields');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query).not.toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('preserves the original PostgreSQL error when rollback also fails', async () => {
      const client = pgClient((sql) => {
        if (/SELECT _id,"channelId","serverId"/.test(sql)) return { rows: [{ _id: 'parent' }] };
        if (/INSERT INTO threads/.test(sql)) throw new Error('thread insert failed');
        if (sql === 'ROLLBACK') throw new Error('rollback failed');
        return { rows: [] };
      });
      (mockDb as unknown as { _pool: { connect: jest.Mock } })._pool = {
        connect: jest.fn().mockResolvedValue(client),
      };
      await expect(Threads.createForParentAtomic(scope)).rejects.toThrow('thread insert failed');
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });
});
