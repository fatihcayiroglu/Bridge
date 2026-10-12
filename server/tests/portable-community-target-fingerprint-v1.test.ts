import { fingerprintDestinationTopology } from '../lib/portableCommunityTargetFingerprint';
import { PERMS } from '../lib/permissions';

const SID = 'target-community';
function target() {
  return {
    serverId: SID,
    categories: [
      { _id: 'cat2', serverId: SID, name: 'Private', position: 1, collapsed: true },
      { _id: 'cat1', serverId: SID, name: 'General', position: 0, collapsed: false },
    ],
    roles: [
      { _id: 'role2', serverId: SID, name: 'Moderators', permissions: PERMS.SEND_MESSAGES,
        position: 1, color: '#fff' },
      { _id: 'role1', serverId: SID, name: 'Readers', permissions: PERMS.VIEW_CHANNELS,
        position: 0, color: '#000' },
    ],
    channels: [
      { _id: 'ch2', serverId: SID, name: 'staff', type: 'text', topic: 'staff only',
        categoryId: 'cat2', order: 1, nsfw: false, slowmode: 5 },
      { _id: 'ch1', serverId: SID, name: 'general', type: 'text', topic: 'hello',
        categoryId: 'cat1', order: 0, nsfw: false, slowmode: 0 },
    ],
  };
}
function changed(mutate: (t: ReturnType<typeof target>) => void) {
  const value = target();
  mutate(value);
  return fingerprintDestinationTopology(value);
}

describe('P7 C3 complete portable v1 target topology fingerprint', () => {
  it('is deterministic across independent fetch ordering and bounded to lowercase SHA-256', () => {
    const value = target();
    const original = fingerprintDestinationTopology(value);
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDestinationTopology({
      ...value, categories: [...value.categories].reverse(),
      roles: [...value.roles].reverse(), channels: [...value.channels].reverse(),
    })).toBe(original);
  });

  it('detects changes in all previously omitted portable topology fields', () => {
    const old = fingerprintDestinationTopology(target());
    const changes: Array<(value: ReturnType<typeof target>) => void> = [
      v => { v.categories[0]!.position = 2; },
      v => { v.categories[0]!.collapsed = false; },
      v => { v.roles[0]!.position = 3; },
      v => { v.roles[0]!.color = '#abc'; },
      v => { v.roles[0]!.permissions = PERMS.VIEW_CHANNELS; },
      v => { v.channels[0]!.order = 3; },
      v => { v.channels[0]!.topic = 'new topic'; },
      v => { v.channels[0]!.nsfw = true; },
      v => { v.channels[0]!.slowmode = 10; },
      v => { v.channels[0]!.categoryId = 'cat1'; },
    ];
    for (const mutate of changes) expect(changed(mutate)).not.toBe(old);
  });

  it('never hashes a member, secret or unrelated channel metadata field', () => {
    const value = target(), old = fingerprintDestinationTopology(value);
    (value as unknown as Record<string, unknown>).memberId = 'PRIVATE_USER';
    (value.channels[0] as unknown as Record<string, unknown>).webhookToken = 'SECRET';
    (value.roles[0] as unknown as Record<string, unknown>).memberAssignments = ['PRIVATE_USER'];
    expect(fingerprintDestinationTopology(value)).toBe(old);
  });

  it('refuses foreign, duplicate, invalid or dangling destination rows', () => {
    expect(() => changed(v => { v.channels.push({ ...v.channels[0]! }); }))
      .toThrow('Duplicate destination topology identifier');
    expect(() => changed(v => { v.roles[0]!.serverId = 'foreign'; }))
      .toThrow('Foreign destination topology row');
    expect(() => changed(v => { v.channels[0]!.categoryId = 'ghost'; }))
      .toThrow('unknown category');
    expect(() => changed(v => {
      (v.categories[0] as unknown as Record<string, unknown>)._id = '';
    })).toThrow('Invalid destination topology identifier');
  });

  it('refuses invalid and missing role grants rather than treating them as zero', () => {
    expect(() => changed(v => { v.roles[0]!.permissions = -1; })).toThrow('Invalid');
    expect(() => changed(v => {
      delete (v.roles[0] as unknown as Record<string, unknown>).permissions;
    })).toThrow('Missing destination role permissions');
  });

  it('rejects an oversized destination topology instead of computing an incomplete digest', () => {
    const value = target();
    (value as unknown as Record<string, unknown>).channels =
      Array.from({ length: 501 }, (_, i) =>
        ({ _id: `ch-${i}`, serverId: SID, name: 'c', type: 'text' }));
    expect(() => fingerprintDestinationTopology(value)).toThrow('Invalid destination topology row count');
  });
});
