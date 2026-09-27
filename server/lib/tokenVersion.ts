/**
 * Canonical parser for the revocation generation stored on a user/session.
 *
 * PostgreSQL INTEGER normally arrives as a number. Legacy adapters and direct
 * SQL fixtures may expose the same value as canonical decimal text, which is
 * accepted deliberately. Any other persisted representation is security state
 * corruption and must fail closed rather than silently becoming generation 0.
 */
export function parseTokenVersion(value: unknown, defaultWhenMissing = 0): number {
  if (value === undefined || value === null) return defaultWhenMissing;
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    n = Number(value);
  } else {
    throw new TypeError('Invalid tokenVersion');
  }
  if (!Number.isSafeInteger(n) || n < 0 || n > 2_147_483_647) {
    throw new TypeError('Invalid tokenVersion');
  }
  return n;
}
