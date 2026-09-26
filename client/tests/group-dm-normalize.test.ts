import {
  normalizeGdmGroup,
  normalizeGdmGroups,
  normalizeGdmMessages,
} from '../js/core/group-dm-normalize.ts';

const color = (value: string) => /^#[0-9a-f]{6}$/i.test(value) ? value : '#2d9cdb';

describe('Group DM normalization boundary', () => {
  it('rejects malformed groups and de-duplicates valid group ids', () => {
    expect(normalizeGdmGroups(null, color)).toEqual([]);
    const groups = normalizeGdmGroups([
      { _id: 'g1', name: ' Team ', memberCount: 3 },
      { _id: 'g1', name: 'duplicate' },
      { name: 'missing id' },
    ], color);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ _id: 'g1', name: 'Team', memberCount: 3 });
  });

  it('normalizes members, colors and bounded counters', () => {
    const group = normalizeGdmGroup({
      _id: 'g1',
      name: '',
      unreadCount: Number.MAX_SAFE_INTEGER,
      members: [
        { _id: 'u1', displayName: '', username: 'alice', avatarColor: 'bad' },
        { id: 'u1', displayName: 'duplicate' },
      ],
    }, color);
    expect(group?.name).toBe('Group DM');
    expect(group?.unreadCount).toBe(2_147_483_647);
    expect(group?.members).toHaveLength(1);
    expect(group?.members?.[0]).toMatchObject({ _id: 'u1', displayName: 'alice', avatarColor: '#2d9cdb' });
  });

  it('drops malformed messages and de-duplicates persistent ids', () => {
    const messages = normalizeGdmMessages([
      { _id: 'm1', groupId: 'g1', content: 'hello', displayName: 'A', avatarColor: '#123456', createdAt: 1 },
      { _id: 'm1', groupId: 'g1', content: 'duplicate', createdAt: 2 },
      { _id: 'm2', content: 123 },
    ], 'g1', color);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ _id: 'm1', groupId: 'g1', content: 'hello' });
  });
});
