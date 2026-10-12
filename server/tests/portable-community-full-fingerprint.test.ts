import { fingerprintDestinationTopology } from '../lib/portableCommunityTargetFingerprint';
import { PERMS } from '../lib/permissions';

const SID = 'reviewed-destination';
type Row = Record<string, unknown>;
function topology() {
  return {
    serverId: SID,
    categories: [
      { _id: 'c1', serverId: SID, name: 'General', position: 0, collapsed: false },
      { _id: 'c2', serverId: SID, name: 'Private', position: 1, collapsed: true },
    ] as Row[],
    roles: [
      { _id: 'r1', serverId: SID, name: 'Readers', position: 0,
        permissions: PERMS.VIEW_CHANNELS, color: '#eeeeee' },
      { _id: 'r2', serverId: SID, name: 'Posters', position: 1,
        permissions: PERMS.SEND_MESSAGES, color: '#111111' },
    ] as Row[],
    channels: [
      { _id: 'ch1', serverId: SID, name: 'Announcements', type: 'text', topic: 'First',
        categoryId: 'c1', order: 0, nsfw: false, slowmode: 0, category: '' },
      { _id: 'ch2', serverId: SID, name: 'Voice', type: 'voice', topic: '',
        categoryId: 'c2', order: 1, nsfw: false, slowmode: 0, category: '' },
    ] as Row[],
  };
}
function altered(change: (value: ReturnType<typeof topology>) => void): string {
  const value = topology();
  change(value);
  return fingerprintDestinationTopology(value);
}

describe('P7 C3 full destination topology fingerprint coverage', () => {
  it('is canonical across array ordering and repeated calls', () => {
    const value = topology();
    const original = fingerprintDestinationTopology(value);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(original).toBe(fingerprintDestinationTopology(value));
    expect(original).toBe(fingerprintDestinationTopology({
      ...value,
      categories: [...value.categories].reverse(),
      roles: [...value.roles].reverse(),
      channels: [...value.channels].reverse(),
    }));
  });

  it('changes on every transported category, role and channel metadata field', () => {
    const original = fingerprintDestinationTopology(topology());
    const changes: Array<(value: ReturnType<typeof topology>) => void> = [
      v => { v.categories[0]!.name = 'Renamed category'; },
      v => { v.categories[0]!.position = 12; },
      v => { v.categories[0]!.collapsed = true; },
      v => { v.roles[0]!.name = 'New role name'; },
      v => { v.roles[0]!.position = 4; },
      v => { v.roles[0]!.permissions = 0; },
      v => { v.roles[0]!.color = '#ff0033'; },
      v => { v.channels[0]!.name = 'Updated title'; },
      v => { v.channels[0]!.type = 'announcement'; },
      v => { v.channels[0]!.topic = 'Updated topic'; },
      v => { v.channels[0]!.categoryId = 'c2'; },
      v => { v.channels[0]!.category = 'Legacy renamed category'; },
      v => { v.channels[0]!.order = 5; },
      v => { v.channels[0]!.nsfw = true; },
      v => { v.channels[0]!.slowmode = 60; },
    ];
    for (const mutate of changes) {
      expect(altered(mutate)).not.toBe(original);
    }
  });

  it('does not include private account data or unrelated database fields', () => {
    const original = fingerprintDestinationTopology(topology());
    const data = topology();
    data.channels[0]!.memberId = 'PRIVATE_USER_IDENTIFIER';
    data.channels[0]!.secret = 'PRIVATE_WEBHOOK_SECRET';
    data.roles[0]!.lastReadUser = 'PRIVATE_ACCOUNT';
    expect(fingerprintDestinationTopology(data)).toBe(original);
  });

  it('rejects incomplete, foreign, duplicate, orphaned or oversized rows', () => {
    expect(() => altered(v => { delete v.roles[0]!.permissions; })).toThrow();
    expect(() => altered(v => { v.roles[0]!.permissions = -1; })).toThrow();
    expect(() => altered(v => { v.categories.push({ ...v.categories[0]! }); })).toThrow();
    expect(() => altered(v => { v.channels[0]!.serverId = 'foreign-server'; })).toThrow();
    expect(() => altered(v => { v.channels[0]!.categoryId = 'nonexistent'; })).toThrow();
    expect(() => altered(v => { v.channels[0]!.type = 'unknown-type'; })).toThrow();
    expect(() => fingerprintDestinationTopology({
      ...topology(),
      channels: Array.from({ length: 501 }, (_, i) => ({
        _id: `channel-${i}`, serverId: SID, type: 'text', name: 'a',
      })),
    })).toThrow();
  });
});
