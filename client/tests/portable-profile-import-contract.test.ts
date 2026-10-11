import { describe, expect, it } from 'vitest';
import {
  expectedFromPortablePreview, portableAccountId, verifiedPortablePreview,
  PORTABLE_PROFILE_FIELDS,
} from '../js/core/settings/portable-profile-import.ts';

const fields = PORTABLE_PROFILE_FIELDS.map(field => ({
  field, current: field === 'displayName' ? 'Alice' : '',
  proposed: field === 'displayName' ? 'Bob' : '', changed: field === 'displayName',
}));
const valid = () => ({
  dryRun: true, applied: false, checksumVerified: true,
  mapping: { sourceUserId: 'other-instance-account', targetUserId: 'me', strategy: 'map-to-authenticated-account' },
  fields: fields.map(f => ({ ...f })),
});

describe('P7 C3 profile-only import boundary', () => {
  it('accepts only a six-field server-confirmed authenticated preview, snapshots exact expected values', () => {
    const v = verifiedPortablePreview(valid(), 'me');
    expect(v).not.toBeNull();
    expect(expectedFromPortablePreview(v!)).toEqual({
      displayName: 'Alice', bio: '', website: '', pronouns: '', avatarColor: '', bannerColor: '',
    });
    expect(Object.keys(expectedFromPortablePreview(v!))).toEqual([...PORTABLE_PROFILE_FIELDS]);
  });

  it('rejects wrong identity, fake-write response, checksum failure or unsupported mapping', () => {
    for (const altered of [
      { ...valid(), dryRun: false },
      { ...valid(), applied: true },
      { ...valid(), checksumVerified: false },
      { ...valid(), mapping: { ...valid().mapping, targetUserId: 'another-account' } },
      { ...valid(), mapping: { ...valid().mapping, strategy: 'overwrite-foreign-id' } },
      { ...valid(), mapping: { ...valid().mapping, sourceUserId: '' } },
    ]) expect(verifiedPortablePreview(altered, 'me')).toBeNull();
  });

  it('rejects fields missing, duplicated, unexpected, or inconsistent with proposed values', () => {
    for (const altered of [
      { ...valid(), fields: fields.slice(0, 5) },
      { ...valid(), fields: [...fields.slice(0, 5), fields[0]] },
      { ...valid(), fields: [...fields.slice(0, 5), { field: 'password', current: 'x', proposed: 'y', changed: true }] },
      { ...valid(), fields: fields.map(f => ({ ...f, changed: false })) },
      { ...valid(), fields: fields.map(f => ({ ...f, current: 7 })) },
      { ...valid(), fields: 'invalid' },
    ]) expect(verifiedPortablePreview(altered, 'me')).toBeNull();
  });

  it('never infers an owner from an unauthenticated username', () => {
    expect(portableAccountId(null)).toBeNull();
    expect(portableAccountId({ username: 'alice' })).toBeNull();
    expect(portableAccountId({ _id: 'me', username: 'alice' })).toBe('me');
    expect(portableAccountId({ id: 'me' })).toBe('me');
  });
});
