process.env.NODE_ENV = 'test';

/**
 * tokenVersion is the immediate access/media-token revocation boundary. In a
 * Redis-configured multi-node deployment a worker-local 30s LRU cannot be
 * invalidated by another node, so cluster mode must always re-read canonical
 * storage. This contract test deliberately checks the production owner rather
 * than weakening tokenVersion semantics to make a cache test pass.
 */
import fs from 'fs';
import path from 'path';

describe('auth tokenVersion cluster revocation contract', () => {
  test('Redis-configured deployments bypass the process-local tokenVersion LRU', () => {
    const src = fs.readFileSync(path.join(__dirname, '../middleware/auth.ts'), 'utf8');
    expect(src).toContain('if (!process.env.REDIS_URL) {');
    expect(src).toContain('const cached = _cache.get(userId);');
    expect(src).toContain('if (!process.env.REDIS_URL) _setTokenCache(userId, version);');
    expect(src.indexOf('if (!process.env.REDIS_URL) {')).toBeLessThan(src.indexOf('const cached = _cache.get(userId);'));
  });
});
