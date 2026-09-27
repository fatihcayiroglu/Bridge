/** Strict numeric environment parsing for security/availability limits.
 *
 * `parseInt("10junk") === 10` and `parseInt("-1") === -1`; both are dangerous
 * for limits because malformed operator input can silently weaken a boundary.
 * An explicitly configured invalid value is therefore a startup/config error.
 */
export function envSafeInt(
  name: string,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}


/** Strict finite decimal environment parsing for bounded fractional settings. */
export function envSafeNumber(
  name: string,
  fallback: number,
  { min = 0, max = Number.MAX_VALUE }: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) throw new Error(`${name} must be a finite decimal number`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}
