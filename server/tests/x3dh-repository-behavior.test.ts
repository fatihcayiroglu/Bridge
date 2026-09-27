process.env.NODE_ENV = 'test';

import db from '../db/loader';
import { Users } from '../db/repositories';

describe('X3DH repository atomic prekey consumption', () => {
  const originalPool = (db as any)._pool;
  beforeEach(() => {
    db._reset?.();
    (db as any)._pool = originalPool;
  });
  afterAll(() => { (db as any)._pool = originalPool; });

  it('uses one PostgreSQL row-locking statement and returns a consistent bundle', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{
      _id: 'u1',
      identity_key: 'identity',
      signed_pre_key: { keyId: 9, publicKey: 'signed', signature: 'sig' },
      one_time_pre_key: { keyId: 1, publicKey: 'one' },
      remaining_count: '1',
    }] });
    (db as any)._pool = { query };

    await expect(Users.consumeX3dhPreKeyBundle('u1')).resolves.toEqual({
      _id: 'u1',
      identityKey: 'identity',
      signedPreKey: { keyId: 9, publicKey: 'signed', signature: 'sig' },
      oneTimePreKey: { keyId: 1, publicKey: 'one' },
      remainingOneTimeKeys: 1,
      invalidState: false,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/FOR UPDATE[\s\S]*UPDATE users[\s\S]*"x3dhOneTimePreKeys"[\s\S]*RETURNING/s), ['u1']);
  });

  it('returns null when the target user row does not exist', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (db as any)._pool = { query };
    await expect(Users.consumeX3dhPreKeyBundle('missing')).resolves.toBeNull();
  });

  it.each([' 1', '01', '1e0', '1.0', '-1'])('fails closed on malformed persisted remaining count %p', async (remaining_count) => {
    (db as any)._pool = { query: jest.fn().mockResolvedValue({ rows: [{
      _id: 'u1', identity_key: 'identity', signed_pre_key: null,
      one_time_pre_key: null, remaining_count,
    }] }) };
    await expect(Users.consumeX3dhPreKeyBundle('u1')).rejects.toThrow(/X3DH remaining prekey count/);
  });

  it('marks structurally invalid persisted prekeys instead of returning attacker-shaped key material', async () => {
    (db as any)._pool = { query: jest.fn().mockResolvedValue({ rows: [{
      _id: 'u1', identity_key: 'identity',
      signed_pre_key: { keyId: 9, publicKey: 'signed', signature: 'sig', extra: 'unexpected' },
      one_time_pre_key: { keyId: 1, publicKey: 'one' }, remaining_count: '0',
    }] }) };
    await expect(Users.consumeX3dhPreKeyBundle('u1')).resolves.toEqual(expect.objectContaining({
      invalidState: true,
      signedPreKey: null,
    }));
  });

  it('serializes the test fallback so one OTPK cannot be returned twice', async () => {
    (db as any)._pool = undefined;
    await db.users.insert({
      _id: 'u1',
      x3dhIdentityKey: 'identity',
      x3dhSignedPreKey: { keyId: 9, publicKey: 'signed', signature: 'sig' },
      x3dhOneTimePreKeys: [{ keyId: 1, publicKey: 'only' }],
    });

    const [a, b] = await Promise.all([
      Users.consumeX3dhPreKeyBundle('u1'),
      Users.consumeX3dhPreKeyBundle('u1'),
    ]);
    const consumed = [a?.oneTimePreKey, b?.oneTimePreKey].filter(Boolean);
    expect(consumed).toEqual([{ keyId: 1, publicKey: 'only' }]);
    expect([a?.remainingOneTimeKeys, b?.remainingOneTimeKeys]).toEqual([0, 0]);
  });

  it('requires a target user id', async () => {
    await expect(Users.consumeX3dhPreKeyBundle('')).rejects.toThrow('userId is required');
  });
});
