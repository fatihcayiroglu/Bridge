/**
 * Production repository methods that promise PostgreSQL atomicity must never
 * silently degrade to an in-process/read-modify-write fallback.
 *
 * Unit tests intentionally use the in-memory adapter and may exercise the
 * compatibility fallback. Every non-test runtime is PostgreSQL-only according
 * to db/loader.ts, so a missing pool there is a broken durability invariant.
 */
export function postgresPoolOrTestFallback<T>(pool: T | null | undefined, operation: string): T | null {
  if (pool) return pool;
  if (process.env.NODE_ENV === 'test') return null;
  throw new Error(`PostgreSQL pool unavailable for ${operation}`);
}
