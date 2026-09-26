/**
 * Canonical persisted/request permission-mask validation.
 *
 * Bridge deliberately uses only bits <= 30 because JavaScript bitwise
 * operators are signed 32-bit. Keep this constant in sync with PERMS in
 * permissions.ts; tests assert the relationship so schema/repository/runtime
 * cannot drift independently.
 */
export const VALID_PERMISSION_BITS = 0x413fffff; // bits 0..21, 24 and 30

export function parsePermissionMask(value: unknown, label = 'permission mask'): number {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    parsed = Number(value);
  } else {
    throw new TypeError(`Invalid ${label}`);
  }

  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > VALID_PERMISSION_BITS) {
    throw new TypeError(`Invalid ${label}`);
  }
  if ((parsed & ~VALID_PERMISSION_BITS) !== 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return parsed;
}

export function parsePermissionPair(
  allowValue: unknown,
  denyValue: unknown,
  label = 'permission override',
): { allow: number; deny: number } {
  const allow = parsePermissionMask(allowValue, `${label} allow`);
  const deny = parsePermissionMask(denyValue, `${label} deny`);
  if ((allow & deny) !== 0) throw new TypeError(`Invalid ${label}: allow/deny overlap`);
  return { allow, deny };
}
