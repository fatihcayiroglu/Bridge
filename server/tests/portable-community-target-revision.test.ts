import { computePortableCommunityTargetRevision } from '../lib/portableCommunityTargetRevision';
import { PERMS } from '../lib/permissions';

const SID = 'destination-server';
function topology() {
  return {
    serverId: SID,
    categories: [
      { _id: 'cat-2', serverId: SID, name: 'Private', position: 1, collapsed: true },
      { _id: 'cat-1', serverId: SID, name: 'General', position: 0 },
    ],
    roles: [
      { _id: 'role-2', serverId: SID, name: 'Moderator', position: 1,
        permissions: PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES, color: '#fff' },
      { _id: 'role-1', serverId: SID, name: 'Reader', position: 0,
        permissions: PERMS.VIEW_CHANNELS },
    ],
    channels: [
      { _id: 'channel-2', serverId: SID, name: 'voice', type: 'voice',
        categoryId: 'cat-2', order: 1 },
      { _id: 'channel-1', serverId: SID, name: 'general', type: 'text',
        categoryId: 'cat-1', order: 0 },
    ],
  };
}
function changed(fn: (t: ReturnType<typeof topology>) => void): string {
  const value = topology(); fn(value);
  return computePortableCommunityTargetRevision(value);
}

describe('P7 C3 destination topology revision', () => {
  it('computes a deterministic hex digest independent of repository array ordering', () => {
    const input = topology();
    const first = computePortableCommunityTargetRevision(input);
    const second = computePortableCommunityTargetRevision({
      ...input,
      categories: [...input.categories].reverse(),
      roles: [...input.roles].reverse(),
      channels: [...input.channels].reverse(),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(computePortableCommunityTargetRevision(topology())).toBe(first);
  });

  it('changes when category names, category order, role permission bits, channel names or type change', () => {
    const base = computePortableCommunityTargetRevision(topology());
    const changes: Array<(t: ReturnType<typeof topology>) => void> = [
      t => { t.categories[0]!.name = 'Renamed'; },
      t => { t.categories[0]!.position = 3; },
      t => { t.roles[0]!.permissions = PERMS.VIEW_CHANNELS; },
      t => { t.roles[0]!.name = 'Renamed role'; },
      t => { t.channels[0]!.name = 'renamed-voice'; },
      t => { t.channels[0]!.type = 'text'; },
      t => { t.channels[0]!.categoryId = 'cat-1'; },
    ];
    for (const mutate of changes) expect(changed(mutate)).not.toBe(base);
  });

  it('does not include members or secrets that are outside the structural allowlist', () => {
    const input = topology();
    const old = computePortableCommunityTargetRevision(input);
    const exposed = input as unknown as Record<string, unknown>;
    exposed.userId = 'SENSITIVE_USER';
    (input.channels[0] as unknown as Record<string, unknown>).secret = 'DO_NOT_DIGEST';
    expect(computePortableCommunityTargetRevision(input)).toBe(old);
  });

  it('fails closed on duplicate, foreign, malformed and orphan categories', () => {
    expect(() => changed(t => { t.channels.push({ ...t.channels[0]! }); }))
      .toThrow('Duplicate target identifier');
    expect(() => changed(t => { t.roles[0]!.serverId = 'foreign-server'; }))
      .toThrow('Incomplete destination topology');
    expect(() => changed(t => { t.channels[0]!.categoryId = 'missing-category'; }))
      .toThrow('unknown category');
    expect(() => changed(t => {
      (t.categories[0] as unknown as Record<string, unknown>)._id = '';
    })).toThrow('Invalid target identifier');
  });

  it('rejects invalid destination role masks, including missing permission fields', () => {
    expect(() => changed(t => {
      delete (t.roles[0] as unknown as Record<string, unknown>).permissions;
    })).toThrow('Missing target role permissions');
    expect(() => changed(t => { t.roles[0]!.permissions = -1; }))
      .toThrow('Invalid');
    expect(() => changed(t => {
      (t.roles[0] as unknown as Record<string, unknown>).permissions = 'NaN';
    })).toThrow('Invalid');
  });

  it('rejects excessive topology rather than producing a partial checksum', () => {
    expect(() => computePortableCommunityTargetRevision({
      ...topology(),
      channels: Array.from({ length: 501 }, (_, i) =>
        ({ _id: `new-${i}`, serverId: SID, name: 'general', type: 'text' })),
    })).toThrow('Unsupported destination topology');
    expect(() => computePortableCommunityTargetRevision({
      ...topology(), roles: Array.from({ length: 2001 }, (_, i) =>
        ({ _id: `role-${i}`, serverId: SID, name: 'reader', permissions: 0 })),
    })).toThrow('Unsupported destination topology');
  });
});
