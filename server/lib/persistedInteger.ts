/**
 * Parse an integer that came from durable storage without JavaScript's
 * permissive numeric coercion. PostgreSQL INTEGER/BIGINT fields can surface as
 * numbers or canonical decimal strings depending on the driver/type parser.
 * Alternate spellings (whitespace, exponent, hex, leading zeroes, decimals)
 * are treated as corrupted persisted state rather than silently reinterpreted.
 */
export function parsePersistedNonNegativeInteger(
  value: unknown,
  label = 'persisted integer',
  options: { defaultWhenMissing?: number; max?: number } = {},
): number {
  const { defaultWhenMissing, max = Number.MAX_SAFE_INTEGER } = options;
  if (!Number.isSafeInteger(max) || max < 0) throw new TypeError(`Invalid ${label} maximum`);

  if (value === null || value === undefined) {
    if (defaultWhenMissing === undefined) throw new TypeError(`Invalid ${label}`);
    value = defaultWhenMissing;
  }

  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    parsed = Number(value);
  } else {
    throw new TypeError(`Invalid ${label}`);
  }

  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new TypeError(`Invalid ${label}`);
  }
  return parsed;
}
