const query = jest.fn();
const connect = jest.fn();

jest.mock('../db/postgres/pool', () => ({
  pool: { query: (...args: unknown[]) => query(...args), connect: (...args: unknown[]) => connect(...args) },
}));

import { OAuth } from '../db/repositories/OAuthRepository';

function clientWith(handler?: (sql: string, params?: unknown[]) => unknown) {
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => handler ? handler(sql, params) : { rows: [], rowCount: 1 }),
    release: jest.fn(),
  };
  connect.mockResolvedValue(client);
  return client;
}

describe('OAuthRepository transactional lifecycle', () => {
  beforeEach(() => { jest.clearAllMocks(); query.mockResolvedValue({ rows: [], rowCount: 1 }); });

  test('basic token helpers preserve canonical user/platform scope', async () => {
    query.mockResolvedValueOnce({ rows: [{ accessToken: 'a', refreshToken: 'r', expiresAt: 123 }] });
    await expect(OAuth.getToken('u1', 'spotify')).resolves.toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/WHERE "userId"=\$1 AND platform=\$2/), ['u1', 'spotify']);

    query.mockResolvedValueOnce({ rows: [] });
    await expect(OAuth.getToken('u2', 'spotify')).resolves.toBeNull();
    await OAuth.updateAccessToken('u1', 'spotify', 'new', 456);
    expect(query).toHaveBeenLastCalledWith(expect.stringMatching(/UPDATE oauth_tokens/), ['new', 456, 'u1', 'spotify']);
    await OAuth.deleteToken('u1', 'spotify');
    expect(query).toHaveBeenLastCalledWith(expect.stringMatching(/DELETE FROM oauth_tokens/), ['u1', 'spotify']);
  });

  test('connect writes token and visible connection in one transaction', async () => {
    const c = clientWith();
    await OAuth.upsertTokenAndConnectionAtomic({
      userId: 'u1', platform: 'spotify', accessToken: 'a', refreshToken: 'r', expiresAt: 1000,
      username: 'spotify-user', url: 'https://open.spotify.com/user/spotify-user',
    });
    expect(c.query.mock.calls.map(x => x[0])).toEqual([
      'BEGIN', expect.stringContaining('INSERT INTO oauth_tokens'), expect.stringContaining('INSERT INTO user_connections'), 'COMMIT',
    ]);
    expect(c.query).toHaveBeenNthCalledWith(2, expect.any(String), ['u1', 'spotify', 'a', 'r', 1000]);
    expect(c.query).toHaveBeenNthCalledWith(3, expect.any(String), ['u1', 'spotify', 'spotify-user', 'https://open.spotify.com/user/spotify-user']);
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  test('connect rolls back and preserves the original failure', async () => {
    const original = new Error('connection row failed');
    const c = clientWith((sql) => {
      if (sql.includes('INSERT INTO user_connections')) throw original;
      if (sql === 'ROLLBACK') throw new Error('rollback also failed');
      return { rows: [] };
    });
    await expect(OAuth.upsertTokenAndConnectionAtomic({
      userId: 'u1', platform: 'spotify', accessToken: 'a', refreshToken: null, expiresAt: 1000,
      username: 'name', url: 'url',
    })).rejects.toBe(original);
    expect(c.query).toHaveBeenCalledWith('ROLLBACK');
    expect(c.query).not.toHaveBeenCalledWith('COMMIT');
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  test('disconnect deletes token and public connection atomically', async () => {
    const c = clientWith();
    await OAuth.deleteTokenAndConnectionAtomic('u1', 'spotify');
    expect(c.query.mock.calls.map(x => x[0])).toEqual([
      'BEGIN', expect.stringContaining('DELETE FROM oauth_tokens'), expect.stringContaining('DELETE FROM user_connections'), 'COMMIT',
    ]);
    expect(c.query).toHaveBeenNthCalledWith(2, expect.any(String), ['u1', 'spotify']);
    expect(c.query).toHaveBeenNthCalledWith(3, expect.any(String), ['u1', 'spotify']);
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  test('disconnect rolls back on the second delete and releases', async () => {
    const original = new Error('connection delete failed');
    const c = clientWith((sql) => {
      if (sql.includes('DELETE FROM user_connections')) throw original;
      return { rows: [] };
    });
    await expect(OAuth.deleteTokenAndConnectionAtomic('u1', 'spotify')).rejects.toBe(original);
    expect(c.query).toHaveBeenCalledWith('ROLLBACK');
    expect(c.query).not.toHaveBeenCalledWith('COMMIT');
    expect(c.release).toHaveBeenCalledTimes(1);
  });
});
