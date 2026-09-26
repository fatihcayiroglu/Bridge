/**
 * Strict numeric query parsing for pagination/history endpoints.
 *
 * Express query values are `unknown`: they may be arrays/objects, and
 * `parseInt()` accepts dangerous partial values such as `"10oops"` or
 * fractions such as `"1.5"`. PostgreSQL also rejects negative LIMIT/OFFSET
 * values, turning bad client input into a 500 if it is interpolated downstream.
 */
export function parseBoundedPositiveIntQuery(
  value: unknown,
  defaultValue: number,
  max: number,
): number | null {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}


/** Strict positive integer query parsing that rejects values above `max`
 * instead of silently clamping them. Use this for security/analytics inputs
 * whose documented domain has a hard maximum rather than a pagination
 * compatibility ceiling. */
export function parsePositiveIntWithinBoundQuery(
  value: unknown,
  defaultValue: number,
  max: number,
): number | null {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

/** JSON/body counterpart of parsePositiveIntWithinBoundQuery. */
export function parsePositiveIntWithinBoundValue(
  value: unknown,
  defaultValue: number,
  max: number,
): number | null {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) return null;
  return value;
}

/** Strict positive integer parsing for JSON/body values.
 *
 * Unlike query strings, JSON numbers should already be numbers. Rejecting
 * numeric strings avoids coercion surprises such as `"10oops"`, fractions,
 * exponent overflow and negative SQL LIMIT values.
 */
export function parseBoundedPositiveIntValue(
  value: unknown,
  defaultValue: number,
  max: number,
): number | null {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return Math.min(value, max);
}

export function parseNonNegativeSafeIntQuery(
  value: unknown,
  defaultValue: number,
): number | null {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}


/** Strict non-negative integer parsing for JSON/body values. */
export function parseNonNegativeSafeIntValue(
  value: unknown,
  defaultValue: number,
): number | null {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** Strict non-negative integer parsing for multipart/form text fields. */
export function parseNonNegativeSafeIntText(
  value: unknown,
  defaultValue: number,
): number | null {
  if (value === undefined || value === '') return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}


/** Strict non-negative integer parsing for compatibility surfaces that may
 * legitimately receive either JSON numbers or exact digit strings. */
export function parseNonNegativeSafeIntFlexible(
  value: unknown,
  defaultValue: number,
): number | null {
  if (value === undefined || value === '') return defaultValue;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
