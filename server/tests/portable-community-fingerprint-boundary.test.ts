// P7 C3: exercise fail-closed fingerprint branches without weakening CI thresholds.
// This hash is a READ-ONLY comparison signal, never a write authorization.
import { fingerprintDestinationTopology, type DestinationTopology } from '../lib/portableCommunityTargetFingerprint';
import { PERMS } from '../lib/permissions';

const SID = 'review-target';
type Row = Record<string, unknown>;
const row = (id: string, extra: Row = {}): Row => ({
  _id: id, serverId: SID, name: id, ...extra,
});
function fixture(): DestinationTopology {
  return {
    serverId: SID,
    categories: [row('cat-a'), row('cat-b')],
    roles: [row('role-a', { permissions: PERMS.VIEW_CHANNELS }),
      row('role-b', { permissions: PERMS.SEND_MESSAGES })],
    channels: [row('chan-a', { type: 'text', categoryId: 'cat-a' }),
      row('chan-b', { type: 'voice' })],
  };
}
function mutated(kind: 'categories' | 'roles' | 'channels', change: (rows: Row[]) => void) {
  const input = fixture();
  const rows = [...input[kind]];
  change(rows);
  return { ...input, [kind]: rows };
}
function invalid(kind: 'categories' | 'roles' | 'channels', change: (rows: Row[]) => void) {
  expect(() => fingerprintDestinationTopology(mutated(kind, change))).toThrow();
}

describe('P7 C3 target fingerprint boundary coverage', () => {
  it('is deterministic across ordering but sensitive to source-independent destination identity', () => {
    const start = fixture();
    const digest = fingerprintDestinationTopology(start);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDestinationTopology({
      ...start,
      categories: [...start.categories].reverse(),
      roles: [...start.roles].reverse(),
      channels: [...start.channels].reverse(),
    })).toBe(digest);
    expect(fingerprintDestinationTopology({ ...start, serverId: 'other' ,
      categories: start.categories.map(x => ({ ...x, serverId: 'other' })),
      roles: start.roles.map(x => ({ ...x, serverId: 'other' })),
      channels: start.channels.map(x => ({ ...x, serverId: 'other' })),
    })).not.toBe(digest);
    expect(fingerprintDestinationTopology({
      ...start, channels: [{ ...start.channels[0]!, categoryId: null }, start.channels[1]!],
    })).not.toBe(digest);
  });

  it('rejects malformed destination IDs and collections before hashing', () => {
    for (const serverId of [null, 7, '', 'x'.repeat(257)]) {
      expect(() => fingerprintDestinationTopology({ ...fixture(), serverId: serverId as string })).toThrow();
    }
    for (const kind of ['categories', 'roles', 'channels'] as const) {
      for (const collection of [null, {}, 'rows']) {
        expect(() => fingerprintDestinationTopology({
          ...fixture(), [kind]: collection as unknown as Row[],
        })).toThrow();
      }
      const limit = kind === 'channels' ? 501 : 2001;
      expect(() => fingerprintDestinationTopology({
        ...fixture(), [kind]: Array.from({ length: limit }, (_, i) => row('id-' + i)),
      })).toThrow();
    }
  });

  it('rejects null, array, foreign, duplicate and incomplete rows in every collection', () => {
    for (const kind of ['categories', 'roles', 'channels'] as const) {
      invalid(kind, a => { a[0] = null as unknown as Row; });
      invalid(kind, a => { a[0] = [] as unknown as Row; });
      invalid(kind, a => { a[0] = { ...a[0], serverId: 'wrong-target' }; });
      invalid(kind, a => { a[0] = { ...a[0], serverId: undefined }; });
      invalid(kind, a => { a.push({ ...a[0]! }); });
      invalid(kind, a => { a[0] = { ...a[0], _id: null }; });
      invalid(kind, a => { a[0] = { ...a[0], _id: '' }; });
      invalid(kind, a => { a[0] = { ...a[0], _id: 'i'.repeat(257) }; });
      invalid(kind, a => { a[0] = { ...a[0], name: null }; });
      invalid(kind, a => { a[0] = { ...a[0], name: 'n'.repeat(201) }; });
    }
  });

  it('rejects unknown channel types, dangling categories and malformed role grants', () => {
    for (const type of [null, '', 'video', 42]) {
      invalid('channels', a => { a[0] = { ...a[0], type }; });
    }
    for (const categoryId of ['', 'deleted-category', false, 17]) {
      invalid('channels', a => { a[0] = { ...a[0], categoryId }; });
    }
    for (const permissions of [undefined, null, -1, NaN, 'elevated']) {
      invalid('roles', a => { a[0] = { ...a[0], permissions }; });
    }
    const allowed = ['text', 'voice', 'forum', 'stage', 'announcement'];
    for (const type of allowed) {
      const input = mutated('channels', a => { a[0] = { ...a[0], type }; });
      expect(fingerprintDestinationTopology(input)).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('excludes private fields and retains stable hashes without a category', () => {
    const base = fixture();
    const digest = fingerprintDestinationTopology(base);
    expect(fingerprintDestinationTopology({
      ...base,
      categories: base.categories.map(c => ({ ...c, memberIds: ['PRIVATE'] })),
      roles: base.roles.map(r => ({ ...r, password: 'DO-NOT-HASH' })),
      channels: base.channels.map(c => ({ ...c, webhookToken: 'SECRET' })),
    })).toBe(digest);
    expect(fingerprintDestinationTopology({
      ...base, channels: base.channels.map(c => ({ ...c, categoryId: null })),
    })).toMatch(/^[a-f0-9]{64}$/);
  });
});
