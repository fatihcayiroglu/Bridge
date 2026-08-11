process.env.JWT_SECRET = 'refresh-concurrency-test-jwt-secret-32chars';
process.env.REFRESH_SECRET = 'refresh-concurrency-test-refresh-secret-32chars';
process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';

const db = createMockDb();

jest.mock('../db/loader', () => db);
jest.mock('../db/index', () => db);

describe('refresh token concurrency', () => {
  beforeEach(() => {
    db._reset();
  });

  it('mints at most one successor when the same token is refreshed concurrently', async () => {
    const { makeRefreshToken, rotateRefreshToken } = require('../middleware/auth');
    const { v4: uuidv4 } = require('uuid');
    const bcrypt = require('bcryptjs');

    const user = {
      _id: uuidv4(),
      username: `concurrent_refresh_${Date.now()}`,
      password: await bcrypt.hash('test-password', 8),
      displayName: 'Concurrent Refresh Test',
      tokenVersion: 0,
      createdAt: Date.now(),
    };
    await db.users.insert(user);

    const refreshToken = await makeRefreshToken(user);

    const [first, second] = await Promise.all([
      rotateRefreshToken(refreshToken),
      rotateRefreshToken(refreshToken),
    ]);

    const results = [first, second];
    const successes = results.filter((result) => result && 'newToken' in result);
    const replays = results.filter((result) => result?.error === 'reuse');

    expect(successes).toHaveLength(1);
    expect(replays).toHaveLength(1);

    // Reuse detection revokes the whole family, including the successor
    // minted by the winning request, preventing an attacker from racing
    // a legitimate client and retaining a live session.
    const refreshRows = await db.refreshTokens.find({});
    expect(refreshRows).toHaveLength(0);
  });
});
