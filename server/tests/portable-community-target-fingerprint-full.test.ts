// P7 C3: source structure v1 field coverage for target fingerprint.
// The fingerprint is a non-authoritative review hint, never a write lock.
import { fingerprintDestinationTopology } from '../lib/portableCommunityTargetFingerprint';
import { PERMS } from '../lib/permissions';

const SERVER = 'target-test-community';
function topology() {
  return {
    serverId: SERVER,
    categories: [
      { _id: 'category-2', serverId: SERVER, name: 'Private', position: 2, collapsed: true },
      { _id: 'category-1', serverId: SERVER, name: 'General', position: 1, collapsed: false },
    ],
    roles: [
      { _id: 'role-2', serverId: SERVER, name: 'Moderator', position: 2,
        permissions: PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES, color: '#ffffff' },
      { _id: 'role-1', serverId: SERVER, name: 'Reader', position: 1,
        permissions: PERMS.VIEW_CHANNELS, color: '#000000' },
    ],
    channels: [
      { _id: 'channel-2', serverId: SERVER, name: 'Voice', type: 'voice',
        categoryId: 'category-2', order: 2, topic: 'Talk', nsfw: false, slowmode: 0 },
      { _id: 'channel-1', serverId: SERVER, name: 'General', type: 'text',
        categoryId: 'category-1', order: 1, topic: 'Hello', nsfw: false, slowmode: 1 },
    ],
  };
}
type Sample = ReturnType<typeof topology>;
function mutated(change: (t: Sample) => void) {
  const t = topology();
  change(t);
  return fingerprintDestinationTopology(t);
}
describe('P7 C3 full portable target topology fingerprint coverage', () => {
  it('is deterministic regardless of repository row order', () => {
    const t = topology();
    const h = fingerprintDestinationTopology(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDestinationTopology({
      ...t,
      categories: [...t.categories].reverse(),
      roles: [...t.roles].reverse(),
      channels: [...t.channels].reverse(),
    })).toBe(h);
    expect(fingerprintDestinationTopology(topology())).toBe(h);
  });

  it('changes for every role/category/channel v1 attribute previously omitted', () => {
    const base = fingerprintDestinationTopology(topology());
    const changes: Array<(t: Sample) => void> = [
      t => { t.categories[0]!.name = 'Renamed'; },
      t => { t.categories[0]!.position = 3; },
      t => { t.categories[0]!.collapsed = false; },
      t => { t.roles[0]!.name = 'Renamed role'; },
      t => { t.roles[0]!.position = 3; },
      t => { t.roles[0]!.color = '#ff0000'; },
      t => { t.roles[0]!.permissions = PERMS.VIEW_CHANNELS; },
      t => { t.channels[0]!.name = 'Renamed channel'; },
      t => { t.channels[0]!.type = 'text'; },
      t => { t.channels[0]!.categoryId = 'category-1'; },
      t => { (t.channels[0] as unknown as Record<string, unknown>).category = 'Legacy category renamed'; },
      t => { t.channels[0]!.order = 3; },
      t => { t.channels[0]!.topic = 'Changed topic'; },
      t => { t.channels[0]!.nsfw = true; },
      t => { t.channels[0]!.slowmode = 5; },
    ];
    changes.forEach(change => expect(mutated(change)).not.toBe(base));
  });

  it('refuses empty and dangling category IDs, duplicate/foreign IDs, bad permissions', () => {
    expect(() => mutated(t => { t.channels[0]!.categoryId = ''; }))
      .toThrow('Invalid destination channel category');
    expect(() => mutated(t => { t.channels[0]!.categoryId = 'missing'; }))
      .toThrow('unknown category');
    expect(() => mutated(t => { t.channels.push({ ...t.channels[0]! }); }))
      .toThrow('Duplicate destination');
    expect(() => mutated(t => { t.roles[0]!.serverId = 'foreign'; }))
      .toThrow('Foreign destination');
    expect(() => mutated(t => { t.roles[0]!.permissions = -1; }))
      .toThrow();
    expect(() => mutated(t => {
      delete (t.roles[0] as unknown as Record<string, unknown>).permissions;
    })).toThrow('Missing destination role permissions');
  });

  it('bounds 500 channels, 2000 roles and 512KiB JSON rather than silently truncating', () => {
    expect(() => fingerprintDestinationTopology({
      ...topology(), channels: Array.from({ length: 501 }, (_, i) => ({
        _id: `c-${i}`, serverId: SERVER, name: 'x', type: 'text',
      })),
    })).toThrow('row count');
    expect(() => fingerprintDestinationTopology({
      ...topology(), roles: Array.from({ length: 2001 }, (_, i) => ({
        _id: `r-${i}`, serverId: SERVER, name: 'x', permissions: 0,
      })),
    })).toThrow('row count');
    expect(() => fingerprintDestinationTopology({
      ...topology(), channels: Array.from({ length: 400 }, (_, i) => ({
        _id: `channel-${i}`, serverId: SERVER, name: 'x', type: 'text',
        topic: 'x'.repeat(2048), order: i,
      })),
    })).toThrow('512 KiB');
  });

  it('ignores user identities, membership assignments and secret fields', () => {
    const t = topology();
    const before = fingerprintDestinationTopology(t);
    (t as unknown as Record<string, unknown>).members = ['secret-member'];
    (t.channels[0] as unknown as Record<string, unknown>).secret = 'secret-value';
    (t.roles[0] as unknown as Record<string, unknown>).memberIds = ['private-user'];
    expect(fingerprintDestinationTopology(t)).toBe(before);
  });
});
