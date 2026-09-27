import { parsePermissionMask, parsePermissionPair, VALID_PERMISSION_BITS } from '../lib/permissionMaskInvariant';
import { PERMS, VALID_BITS } from '../lib/permissions';

describe('authorization permission-mask invariant', () => {
  it('keeps the persisted schema mask exactly aligned with runtime permission flags', () => {
    expect(VALID_BITS).toBe(VALID_PERMISSION_BITS);
    expect(VALID_BITS).toBe(Object.values(PERMS).reduce((acc, bit) => acc | bit, 0));
  });

  it.each(['01', ' 1', '1 ', '1e3', '0x100', '-1', '1.0', '', '00'])(
    'rejects non-canonical request/persisted spelling %p', (value) => {
      expect(() => parsePermissionMask(value)).toThrow(TypeError);
    },
  );

  it('accepts canonical numeric/string masks including administrator', () => {
    expect(parsePermissionMask(0)).toBe(0);
    expect(parsePermissionMask(String(PERMS.ADMINISTRATOR))).toBe(PERMS.ADMINISTRATOR);
    expect(parsePermissionMask(VALID_BITS)).toBe(VALID_BITS);
  });

  it('rejects unknown bits and allow/deny overlap', () => {
    expect(() => parsePermissionMask(1 << 25)).toThrow(TypeError);
    expect(() => parsePermissionPair(PERMS.SEND_MESSAGES, PERMS.SEND_MESSAGES)).toThrow(TypeError);
  });
});

// Repository write boundaries are additionally covered by their own suites;
// this pure contract test intentionally keeps the invariant executable without
// a database dependency.
