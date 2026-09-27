// Canonical persisted member timeout parsing. PostgreSQL BIGINT values may be
// returned as decimal strings, while mock/in-memory adapters usually expose numbers.
// Any non-null malformed persisted value is treated as corruption and must not
// silently disable moderation. Callers let the error fail the protected action.

export function parseMemberTimeoutUntil(value: unknown): number | null {
  if (value === null || value === undefined || value === 0 || value === '0') return null;

  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    parsed = Number(value);
  } else {
    throw new Error('Invalid persisted member timeout');
  }

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid persisted member timeout');
  }
  return parsed === 0 ? null : parsed;
}

export function isMemberTimedOut(value: unknown, now = Date.now()): boolean {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('now must be a non-negative safe integer');
  const until = parseMemberTimeoutUntil(value);
  return until !== null && until > now;
}
