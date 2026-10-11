import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import {
  PortableCommunityValidationError, validatePortableCommunityStructure,
} from '../lib/portableCommunityValidation';

function sample() {
  return buildPortableCommunityStructure(
    { _id: 'source-community', name: 'Test Community', description: 'Description', icon: '🎓' },
    [{ _id: 'category-a', name: 'Group', position: 1, collapsed: false }],
    [{ _id: 'channel-a', name: 'general', type: 'text', topic: 'Topic',
      categoryId: 'category-a', order: 1, slowmode: 0, nsfw: false }],
    [{ _id: 'role-a', name: 'Readers', position: 1, color: '#abcdef', permissions: 0 }],
    '2026-10-11T12:00:00.000Z',
  );
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const invalid = (value: unknown) => expect(() => validatePortableCommunityStructure(value))
  .toThrow(PortableCommunityValidationError);

describe('P7 C3 safe offline portable community validation', () => {
  it('accepts the genuine C2 exporter output and preserves checksum and field values', () => {
    const doc = sample();
    const checked = validatePortableCommunityStructure(clone(doc));
    expect(checked).toEqual(doc);
    expect(checked.portability.importSupported).toBe(false);
  });

  it('rejects changed content even with an original valid checksum', () => {
    const doc = clone(sample());
    doc.channels[0].name = 'tampered';
    invalid(doc);
  });

  it('rejects extra, privacy-sensitive fields and missing mandatory fields', () => {
    invalid({ ...sample(), ownerId: 'should-not-travel' });
    const doc = clone(sample()) as Record<string, unknown>;
    delete doc.roles;
    invalid(doc);
    const embedded = clone(sample());
    (embedded.community as Record<string, unknown>).secret = 'private';
    invalid(embedded);
  });

  it('rejects unknown version/algorithms and fabricated or unsupported import capability', () => {
    invalid({ ...sample(), version: 2 });
    invalid({ ...sample(), integrity: { ...sample().integrity, algorithm: 'none' } });
    invalid({ ...sample(), integrity: { ...sample().integrity, digest: 'deadbeef' } });
    invalid({ ...sample(), portability: { ...sample().portability, importSupported: true } });
    invalid({ ...sample(), portability: { ...sample().portability, excluded: [] } });
  });

  it('rejects duplicate identifiers, dangling categories and changed field types', () => {
    const duplicate = clone(sample());
    duplicate.channels.push({ ...duplicate.channels[0] });
    invalid(duplicate);
    const dangling = clone(sample());
    dangling.channels[0].categorySourceId = 'foreign-category';
    invalid(dangling);
    const boolTamper = clone(sample());
    (boolTamper.channels[0] as Record<string, unknown>).nsfw = 'false';
    invalid(boolTamper);
    const badMask = clone(sample());
    badMask.roles[0].permissions = -1;
    invalid(badMask);
  });

  it('rejects oversized content without attempting an import or mutation', () => {
    const huge = { ...sample(), extra: 'x'.repeat(600 * 1024) };
    invalid(huge);
  });

  it('has no path that declares snapshot data safe to import or carries passwords', () => {
    const result = validatePortableCommunityStructure(sample());
    expect(result.portability.importSupported).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/password|authToken|sessionId/i);
  });
});
