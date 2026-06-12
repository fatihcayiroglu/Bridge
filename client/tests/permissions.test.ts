// client/tests/permissions.test.ts — Sprint 39
// server/lib/permissions.ts'deki pure functions için izole unit testler
// resolvePermissions DB'ye bağlı olduğundan sadece pure helpers test edilir

'use strict';

// ─── PERMS sabitleri (permissions.ts ile senkron tutulmalı) ───────────────────
const PERMS = {
  VIEW_CHANNELS:    1 << 0,
  MANAGE_CHANNELS:  1 << 1,
  MANAGE_ROLES:     1 << 2,
  MANAGE_SERVER:    1 << 3,
  KICK_MEMBERS:     1 << 4,
  BAN_MEMBERS:      1 << 5,
  SEND_MESSAGES:    1 << 8,
  MANAGE_MESSAGES:  1 << 9,
  EMBED_LINKS:      1 << 10,
  ATTACH_FILES:     1 << 11,
  ADD_REACTIONS:    1 << 12,
  READ_HISTORY:     1 << 15,
  CONNECT:          1 << 16,
  SPEAK:            1 << 17,
  ADMINISTRATOR:    1 << 30,
};

const DEFAULT_PERMISSIONS =
  PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY |
  PERMS.EMBED_LINKS   | PERMS.ATTACH_FILES  | PERMS.ADD_REACTIONS |
  PERMS.CONNECT       | PERMS.SPEAK;

// ─── Pure functions (permissions.ts'den kopyalanmış mantık) ──────────────────
function hasPermission(perms, flag) {
  if ((perms & PERMS.ADMINISTRATOR) !== 0) return true;
  return (perms & flag) !== 0;
}
function hasAnyPermission(perms, ...flags) { return flags.some(f => hasPermission(perms, f)); }
function hasAllPermissions(perms, ...flags) { return flags.every(f => hasPermission(perms, f)); }

function applyOverrides(basePerms, overrides, userId, roleIds = []) {
  let allow = 0, deny = 0;
  const everyoneOverride = overrides.find(o => o.targetType === 'everyone');
  if (everyoneOverride) { allow |= everyoneOverride.allow; deny |= everyoneOverride.deny; }
  for (const override of overrides.filter(o => o.targetType === 'role' && roleIds.includes(o.targetId))) {
    allow |= override.allow; deny |= override.deny;
  }
  const userOverride = overrides.find(o => o.targetType === 'user' && o.targetId === userId);
  if (userOverride) { allow |= userOverride.allow; deny |= userOverride.deny; }
  return (basePerms & ~deny) | allow;
}

// ══════════════════════════════════════════════════════════════════════════════
// hasPermission
// ══════════════════════════════════════════════════════════════════════════════
describe('hasPermission()', () => {
  test('flag set olduğunda true döner', () => {
    expect(hasPermission(PERMS.SEND_MESSAGES, PERMS.SEND_MESSAGES)).toBe(true);
  });

  test('flag set olmadığında false döner', () => {
    expect(hasPermission(PERMS.VIEW_CHANNELS, PERMS.BAN_MEMBERS)).toBe(false);
  });

  test('ADMINISTRATOR her flag için true döner', () => {
    const adminPerms = PERMS.ADMINISTRATOR;
    expect(hasPermission(adminPerms, PERMS.BAN_MEMBERS)).toBe(true);
    expect(hasPermission(adminPerms, PERMS.MANAGE_ROLES)).toBe(true);
    expect(hasPermission(adminPerms, PERMS.MANAGE_SERVER)).toBe(true);
  });

  test('sıfır permission her flag için false döner', () => {
    expect(hasPermission(0, PERMS.VIEW_CHANNELS)).toBe(false);
    expect(hasPermission(0, PERMS.SEND_MESSAGES)).toBe(false);
  });

  test('birden fazla flag birleştirilince doğru sonuç verir', () => {
    const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY | PERMS.ATTACH_FILES;
    expect(hasPermission(perms, PERMS.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(perms, PERMS.ATTACH_FILES)).toBe(true);
    expect(hasPermission(perms, PERMS.BAN_MEMBERS)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// hasAnyPermission
// ══════════════════════════════════════════════════════════════════════════════
describe('hasAnyPermission()', () => {
  test('flaglerden biri set olduğunda true döner', () => {
    const perms = PERMS.KICK_MEMBERS;
    expect(hasAnyPermission(perms, PERMS.BAN_MEMBERS, PERMS.KICK_MEMBERS)).toBe(true);
  });

  test('hiçbiri set olmadığında false döner', () => {
    expect(hasAnyPermission(PERMS.VIEW_CHANNELS, PERMS.BAN_MEMBERS, PERMS.MANAGE_ROLES)).toBe(false);
  });

  test('admin tüm kombinasyonlar için true döner', () => {
    expect(hasAnyPermission(PERMS.ADMINISTRATOR, PERMS.BAN_MEMBERS, PERMS.KICK_MEMBERS)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// hasAllPermissions
// ══════════════════════════════════════════════════════════════════════════════
describe('hasAllPermissions()', () => {
  test('hepsi set olduğunda true döner', () => {
    const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;
    expect(hasAllPermissions(perms, PERMS.SEND_MESSAGES, PERMS.READ_HISTORY)).toBe(true);
  });

  test('biri eksikse false döner', () => {
    const perms = PERMS.SEND_MESSAGES;
    expect(hasAllPermissions(perms, PERMS.SEND_MESSAGES, PERMS.READ_HISTORY)).toBe(false);
  });

  test('admin hepsi için true döner', () => {
    expect(hasAllPermissions(PERMS.ADMINISTRATOR, PERMS.BAN_MEMBERS, PERMS.MANAGE_ROLES)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEFAULT_PERMISSIONS
// ══════════════════════════════════════════════════════════════════════════════
describe('DEFAULT_PERMISSIONS', () => {
  test('VIEW_CHANNELS içerir', () => {
    expect((DEFAULT_PERMISSIONS & PERMS.VIEW_CHANNELS) !== 0).toBe(true);
  });
  test('SEND_MESSAGES içerir', () => {
    expect((DEFAULT_PERMISSIONS & PERMS.SEND_MESSAGES) !== 0).toBe(true);
  });
  test('BAN_MEMBERS içermez', () => {
    expect((DEFAULT_PERMISSIONS & PERMS.BAN_MEMBERS)).toBe(0);
  });
  test('MANAGE_ROLES içermez', () => {
    expect((DEFAULT_PERMISSIONS & PERMS.MANAGE_ROLES)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// applyOverrides
// ══════════════════════════════════════════════════════════════════════════════
describe('applyOverrides()', () => {
  test('@everyone deny SEND_MESSAGES uygulanır', () => {
    const overrides = [{ targetType: 'everyone', targetId: 'everyone', allow: 0, deny: PERMS.SEND_MESSAGES }];
    const result = applyOverrides(DEFAULT_PERMISSIONS, overrides, 'u1');
    expect((result & PERMS.SEND_MESSAGES)).toBe(0);
  });

  test('@everyone deny sonrası user allow override izin verir', () => {
    const overrides = [
      { targetType: 'everyone', targetId: 'everyone', allow: 0, deny: PERMS.SEND_MESSAGES },
      { targetType: 'user',     targetId: 'u1',       allow: PERMS.SEND_MESSAGES, deny: 0 },
    ];
    const result = applyOverrides(DEFAULT_PERMISSIONS, overrides, 'u1');
    expect((result & PERMS.SEND_MESSAGES) !== 0).toBe(true);
  });

  test('role override deny uygulanır', () => {
    const overrides = [{ targetType: 'role', targetId: 'role-mod', allow: 0, deny: PERMS.ATTACH_FILES }];
    const result = applyOverrides(DEFAULT_PERMISSIONS, overrides, 'u2', ['role-mod']);
    expect((result & PERMS.ATTACH_FILES)).toBe(0);
  });

  test('override yoksa base perms değişmez', () => {
    const result = applyOverrides(DEFAULT_PERMISSIONS, [], 'u1');
    expect(result).toBe(DEFAULT_PERMISSIONS);
  });

  test('@everyone allow ek permission ekler', () => {
    const overrides = [{ targetType: 'everyone', targetId: 'everyone', allow: PERMS.KICK_MEMBERS, deny: 0 }];
    const result = applyOverrides(DEFAULT_PERMISSIONS, overrides, 'u1');
    expect((result & PERMS.KICK_MEMBERS) !== 0).toBe(true);
  });

  test('user deny override tek basina VIEW_CHANNELS kisitiyor', () => {
    // Sadece user deny; role override yok
    // VIEW_CHANNELS DEFAULT_PERMISSIONS da var; user deny kaldirmali
    const overrides = [
      { targetType: 'user', targetId: 'u1', allow: 0, deny: PERMS.VIEW_CHANNELS },
    ];
    const result = applyOverrides(DEFAULT_PERMISSIONS, overrides, 'u1', []);
    expect((result & PERMS.VIEW_CHANNELS)).toBe(0);
  });

  test('üyesi olmadığı role override uygulanmaz', () => {
    const overrides = [{ targetType: 'role', targetId: 'role-other', allow: 0, deny: PERMS.VIEW_CHANNELS }];
    const result = applyOverrides(DEFAULT_PERMISSIONS, overrides, 'u1', ['role-mine']);
    expect((result & PERMS.VIEW_CHANNELS) !== 0).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PERMS bit collision kontrolü
// ══════════════════════════════════════════════════════════════════════════════
describe('PERMS flag uniqueness', () => {
  test('hiçbir iki flag aynı bit değerine sahip değil', () => {
    const values = Object.values(PERMS);
    const unique  = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test('her flag 2\'nin kuvveti (tek bit set)', () => {
    for (const [name, val] of Object.entries(PERMS)) {
      expect((val & (val - 1))).toBe(0); // power of 2 check
    }
  });
});
