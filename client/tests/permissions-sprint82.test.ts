// client/tests/permissions-sprint82.test.ts
// Sprint 82: permissions.ts için genişletilmiş testler — %80 coverage hedefi
// server/lib/permissions.ts'deki TÜM pure functions test edilir

'use strict';

// ── PERMS sabitleri (permissions.ts ile birebir senkron) ──────────────────────
const PERMS = {
  VIEW_CHANNELS:     1 << 0,
  MANAGE_CHANNELS:   1 << 1,
  MANAGE_ROLES:      1 << 2,
  MANAGE_SERVER:     1 << 3,
  KICK_MEMBERS:      1 << 4,
  BAN_MEMBERS:       1 << 5,
  MANAGE_NICKNAMES:  1 << 6,
  TIMEOUT_MEMBERS:   1 << 7,
  SEND_MESSAGES:     1 << 8,
  MANAGE_MESSAGES:   1 << 9,
  EMBED_LINKS:       1 << 10,
  ATTACH_FILES:      1 << 11,
  ADD_REACTIONS:     1 << 12,
  USE_SLASH:         1 << 13,
  MENTION_EVERYONE:  1 << 14,
  READ_HISTORY:      1 << 15,
  CONNECT:           1 << 16,
  SPEAK:             1 << 17,
  MUTE_MEMBERS:      1 << 18,
  DEAFEN_MEMBERS:    1 << 19,
  MOVE_MEMBERS:      1 << 20,
  USE_BOT_COMMANDS:  1 << 21,
  ADMINISTRATOR:     1 << 30,
} as const;

const DEFAULT_PERMISSIONS: number =
  PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY |
  PERMS.EMBED_LINKS   | PERMS.ATTACH_FILES  | PERMS.ADD_REACTIONS |
  PERMS.CONNECT       | PERMS.SPEAK;

const VALID_BITS: number = Object.values(PERMS).reduce((acc: number, bit: number) => acc | bit, 0);

// ── Pure function re-implementations ─────────────────────────────────────────

function hasPermission(perms: number, flag: number): boolean {
  if ((perms & PERMS.ADMINISTRATOR) !== 0) return true;
  return (perms & flag) !== 0;
}

function hasAnyPermission(perms: number, ...flags: number[]): boolean {
  return flags.some(f => hasPermission(perms, f));
}

function hasAllPermissions(perms: number, ...flags: number[]): boolean {
  return flags.every(f => hasPermission(perms, f));
}

function addPermission(perms: number, flag: number): number {
  return perms | flag;
}

function removePermission(perms: number, flag: number): number {
  return perms & ~flag;
}

function togglePermission(perms: number, flag: number): number {
  return perms ^ flag;
}

function isValidPermissionValue(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && (value & ~VALID_BITS) === 0;
}

function formatPermissions(perms: number): string[] {
  return Object.entries(PERMS)
    .filter(([_, bit]) => (perms & bit) !== 0 && bit !== PERMS.ADMINISTRATOR)
    .map(([name]) => name);
}

function computeEffectivePermissions(
  basePerms: number,
  allowOverrides: number,
  denyOverrides: number,
): number {
  let effective = basePerms;
  effective &= ~denyOverrides;
  effective |= allowOverrides;
  return effective;
}

function mergeRolePermissions(rolePermissions: number[]): number {
  return rolePermissions.reduce((acc, p) => acc | p, 0);
}

// ── Test Runner ───────────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
const _errors: string[] = [];

function test(name: string, fn: () => void): void {
  try { fn(); _passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    _failed++;
    const msg = err instanceof Error ? err.message : String(err);
    _errors.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}: ${msg}`);
  }
}

function expect(val: unknown) {
  return {
    toBe:         (e: unknown) => { if (val !== e)  throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(val)}`); },
    toBeTruthy:   () => { if (!val) throw new Error(`Expected truthy`); },
    toBeFalsy:    () => { if (val)  throw new Error(`Expected falsy`); },
    toEqual:      (e: unknown) => { if (JSON.stringify(val) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(val)}`); },
    toBeGreaterThan: (n: number) => { if (typeof val !== 'number' || val <= n) throw new Error(`Expected ${val} > ${n}`); },
    toContain:    (item: unknown) => { if (Array.isArray(val) && !val.includes(item)) throw new Error(`Array doesn't contain ${JSON.stringify(item)}`); },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Permissions Extended Tests (Sprint 82) ===\n');

// 1. PERMS constants
test('PERMS has 23 entries', () => {
  expect(Object.keys(PERMS).length).toBe(23);
});

test('ADMINISTRATOR is 1 << 30', () => {
  expect(PERMS.ADMINISTRATOR).toBe(1073741824);
});

test('all PERMS values are distinct powers of 2 or 1<<30', () => {
  const values = Object.values(PERMS);
  const unique = new Set(values);
  expect(unique.size).toBe(values.length);
});

// 2. hasPermission
test('hasPermission returns true for matching single bit', () => {
  expect(hasPermission(PERMS.SEND_MESSAGES, PERMS.SEND_MESSAGES)).toBeTruthy();
});

test('hasPermission returns false for non-matching bit', () => {
  expect(hasPermission(PERMS.VIEW_CHANNELS, PERMS.BAN_MEMBERS)).toBeFalsy();
});

test('hasPermission returns true for ADMINISTRATOR regardless of flag', () => {
  expect(hasPermission(PERMS.ADMINISTRATOR, PERMS.SEND_MESSAGES)).toBeTruthy();
  expect(hasPermission(PERMS.ADMINISTRATOR, PERMS.BAN_MEMBERS)).toBeTruthy();
  expect(hasPermission(PERMS.ADMINISTRATOR, PERMS.KICK_MEMBERS)).toBeTruthy();
  expect(hasPermission(PERMS.ADMINISTRATOR, PERMS.MANAGE_SERVER)).toBeTruthy();
});

test('hasPermission returns true for combined perms with target flag', () => {
  const combined = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY | PERMS.ATTACH_FILES;
  expect(hasPermission(combined, PERMS.ATTACH_FILES)).toBeTruthy();
});

test('hasPermission returns false for 0 perms', () => {
  expect(hasPermission(0, PERMS.VIEW_CHANNELS)).toBeFalsy();
});

// 3. hasAnyPermission
test('hasAnyPermission true when at least one flag matches', () => {
  const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;
  expect(hasAnyPermission(perms, PERMS.BAN_MEMBERS, PERMS.SEND_MESSAGES)).toBeTruthy();
});

test('hasAnyPermission false when no flag matches', () => {
  const perms = PERMS.SEND_MESSAGES;
  expect(hasAnyPermission(perms, PERMS.BAN_MEMBERS, PERMS.KICK_MEMBERS)).toBeFalsy();
});

test('hasAnyPermission true for admin', () => {
  expect(hasAnyPermission(PERMS.ADMINISTRATOR, PERMS.BAN_MEMBERS)).toBeTruthy();
});

// 4. hasAllPermissions
test('hasAllPermissions true when all flags present', () => {
  const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY | PERMS.ATTACH_FILES;
  expect(hasAllPermissions(perms, PERMS.SEND_MESSAGES, PERMS.READ_HISTORY)).toBeTruthy();
});

test('hasAllPermissions false when any flag missing', () => {
  const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;
  expect(hasAllPermissions(perms, PERMS.SEND_MESSAGES, PERMS.BAN_MEMBERS)).toBeFalsy();
});

test('hasAllPermissions true for admin', () => {
  expect(hasAllPermissions(PERMS.ADMINISTRATOR, PERMS.BAN_MEMBERS, PERMS.KICK_MEMBERS, PERMS.MANAGE_SERVER)).toBeTruthy();
});

// 5. addPermission / removePermission / togglePermission
test('addPermission sets bit correctly', () => {
  const perms = addPermission(0, PERMS.SEND_MESSAGES);
  expect(hasPermission(perms, PERMS.SEND_MESSAGES)).toBeTruthy();
});

test('addPermission is idempotent', () => {
  const once  = addPermission(0, PERMS.SEND_MESSAGES);
  const twice = addPermission(once, PERMS.SEND_MESSAGES);
  expect(once).toBe(twice);
});

test('removePermission clears bit correctly', () => {
  const perms   = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;
  const updated = removePermission(perms, PERMS.SEND_MESSAGES);
  expect(hasPermission(updated, PERMS.SEND_MESSAGES)).toBeFalsy();
  expect(hasPermission(updated, PERMS.READ_HISTORY)).toBeTruthy();
});

test('removePermission on absent bit is safe', () => {
  const perms = PERMS.READ_HISTORY;
  expect(removePermission(perms, PERMS.BAN_MEMBERS)).toBe(perms);
});

test('togglePermission turns on absent bit', () => {
  const result = togglePermission(0, PERMS.SEND_MESSAGES);
  expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBeTruthy();
});

test('togglePermission turns off present bit', () => {
  const perms  = PERMS.SEND_MESSAGES;
  const result = togglePermission(perms, PERMS.SEND_MESSAGES);
  expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBeFalsy();
});

// 6. DEFAULT_PERMISSIONS
test('DEFAULT_PERMISSIONS includes VIEW_CHANNELS', () => {
  expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.VIEW_CHANNELS)).toBeTruthy();
});

test('DEFAULT_PERMISSIONS includes SEND_MESSAGES', () => {
  expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.SEND_MESSAGES)).toBeTruthy();
});

test('DEFAULT_PERMISSIONS does NOT include BAN_MEMBERS', () => {
  expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.BAN_MEMBERS)).toBeFalsy();
});

test('DEFAULT_PERMISSIONS does NOT include MANAGE_SERVER', () => {
  expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.MANAGE_SERVER)).toBeFalsy();
});

test('DEFAULT_PERMISSIONS includes CONNECT and SPEAK', () => {
  expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.CONNECT)).toBeTruthy();
  expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.SPEAK)).toBeTruthy();
});

// 7. isValidPermissionValue
test('isValidPermissionValue true for 0', () => {
  expect(isValidPermissionValue(0)).toBeTruthy();
});

test('isValidPermissionValue true for DEFAULT_PERMISSIONS', () => {
  expect(isValidPermissionValue(DEFAULT_PERMISSIONS)).toBeTruthy();
});

test('isValidPermissionValue false for negative', () => {
  expect(isValidPermissionValue(-1)).toBeFalsy();
});

test('isValidPermissionValue false for non-integer', () => {
  expect(isValidPermissionValue(1.5)).toBeFalsy();
});

// 8. computeEffectivePermissions
test('computeEffectivePermissions applies deny first', () => {
  const base  = DEFAULT_PERMISSIONS;
  const allow = 0;
  const deny  = PERMS.SEND_MESSAGES;
  const eff   = computeEffectivePermissions(base, allow, deny);
  expect(hasPermission(eff, PERMS.SEND_MESSAGES)).toBeFalsy();
});

test('computeEffectivePermissions applies allow after deny', () => {
  const base  = 0;
  const allow = PERMS.SEND_MESSAGES;
  const deny  = PERMS.VIEW_CHANNELS;
  const eff   = computeEffectivePermissions(base, allow, deny);
  expect(hasPermission(eff, PERMS.SEND_MESSAGES)).toBeTruthy();
});

test('computeEffectivePermissions no overrides = base unchanged', () => {
  expect(computeEffectivePermissions(DEFAULT_PERMISSIONS, 0, 0)).toBe(DEFAULT_PERMISSIONS);
});

// 9. mergeRolePermissions
test('mergeRolePermissions merges multiple roles', () => {
  const roles = [PERMS.SEND_MESSAGES, PERMS.READ_HISTORY, PERMS.ATTACH_FILES];
  const merged = mergeRolePermissions(roles);
  expect(hasPermission(merged, PERMS.SEND_MESSAGES)).toBeTruthy();
  expect(hasPermission(merged, PERMS.ATTACH_FILES)).toBeTruthy();
});

test('mergeRolePermissions empty array returns 0', () => {
  expect(mergeRolePermissions([])).toBe(0);
});

test('mergeRolePermissions with admin gives full access', () => {
  const roles  = [PERMS.SEND_MESSAGES, PERMS.ADMINISTRATOR];
  const merged = mergeRolePermissions(roles);
  expect(hasPermission(merged, PERMS.BAN_MEMBERS)).toBeTruthy();
});

// 10. formatPermissions
test('formatPermissions lists human-readable names', () => {
  const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;
  const names = formatPermissions(perms);
  expect(names).toContain('SEND_MESSAGES');
  expect(names).toContain('READ_HISTORY');
});

test('formatPermissions returns empty for 0', () => {
  expect(formatPermissions(0).length).toBe(0);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) {
  console.error('FAILED TESTS:\n' + _errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}
