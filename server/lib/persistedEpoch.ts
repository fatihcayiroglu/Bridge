/**
 * Canonical parser for persisted millisecond epoch values.
 *
 * PostgreSQL BIGINT values are commonly returned by `pg` as decimal strings,
 * while mock/in-memory adapters usually expose numbers. Persisted security
 * timestamps must therefore accept both canonical representations without
 * falling back to permissive JavaScript coercion.
 */
export function parsePersistedEpochMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    parsed = Number(value);
  } else {
    throw new TypeError('Invalid persisted epoch timestamp');
  }

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('Invalid persisted epoch timestamp');
  }
  return parsed;
}

export function isPersistedEpochExpired(value: unknown, now = Date.now()): boolean {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('now must be a non-negative safe integer');
  const expiresAt = parsePersistedEpochMillis(value);
  return expiresAt === null || expiresAt <= now;
}
