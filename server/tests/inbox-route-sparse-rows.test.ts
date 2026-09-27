// server/tests/inbox-route-sparse-rows.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// routes/inbox.ts — EKSİK SÜTUNLU KANONİK SATIRLARDAN GÜVENLİ CEVAP ÜRETİMİ
// ════════════════════════════════════════════════════════════════════════════
// Inbox, "dikkatimi bekleyen ne var?" sorusuna TEK kanonik cevaptır ve her
// satır istemcide TIKLANABİLİR bir gezinme hedefine dönüşür. Bu yüzden yanıt
// iki şeyi aynı anda garanti etmelidir:
//
//   1. YETKİ ŞİMDİ ÇÖZÜLÜR — saklanmış dikkat kaydı yalnızca KİMLİK taşır;
//      kanal/sunucu/mesaj satırları taze okunur ve VIEW_CHANNELS+READ_HISTORY
//      yeniden doğrulanır. Saklanmış yönlendirme kimlikleri kanonik satırla
//      ÇELİŞİYORSA satır düşürülür (bayat/kurcalanmış yönlendirme).
//   2. EKSİK SÜTUN ÇÖKME ÜRETMEZ — silinmiş kullanıcı, adsız kanal, adsız
//      sunucu, zaman damgasız mesaj hepsi gerçek üretim durumlarıdır ve
//      `undefined` metni olarak sızmamalıdır.
process.env.NODE_ENV = 'test';

const repos = {
  Dms: { findConversationsByUser: jest.fn(), countUnread: jest.fn(), findLatestUnread: jest.fn(), markRead: jest.fn() },
  GroupDms: { findGroupsByUser: jest.fn(), findById: jest.fn(), countUnread: jest.fn(), findLatestUnread: jest.fn(), markRead: jest.fn() },
  Notifications: { findUnreadChannelAttention: jest.fn(), findUnreadSavedReminders: jest.fn(), markSavedReminderRead: jest.fn(), markAllSavedRemindersRead: jest.fn(), markAllChannelAttentionRead: jest.fn(), clearAllUnreadCounts: jest.fn() },
  SavedMessages: { findByIdForUser: jest.fn() },
  Messages: { findWhere: jest.fn() },
  Channels: { findWhere: jest.fn() },
  Servers: { findByIds: jest.fn() },
  Users: { findByIds: jest.fn() },
};
const resolvePermissions = jest.fn();

jest.mock('../db/repositories', () => repos);
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'u1' }; next(); },
}));
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1, READ_HISTORY: 2 },
  resolvePermissions: (...args: unknown[]) => resolvePermissions(...args),
  hasPermission: (value: number, wanted: number) => (value & wanted) === wanted,
}));
jest.mock('../lib/userUtils', () => ({
  sanitizeUser: (u: any) => ({ _id: u._id, username: u.username, displayName: u.displayName }),
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/inbox';

const app = express();
app.use(express.json());
app.use('/api/inbox', router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));

const get = (query = '') => request(app).get(`/api/inbox${query}`);

beforeEach(() => {
  jest.clearAllMocks();
  repos.Notifications.findUnreadChannelAttention.mockResolvedValue([]);
  repos.Notifications.findUnreadSavedReminders.mockResolvedValue([]);
  repos.Notifications.markSavedReminderRead.mockResolvedValue(undefined);
  repos.Notifications.markAllSavedRemindersRead.mockResolvedValue(undefined);
  repos.SavedMessages.findByIdForUser.mockResolvedValue(null);
  repos.Messages.findWhere.mockResolvedValue([]);
  repos.Channels.findWhere.mockResolvedValue([]);
  repos.Servers.findByIds.mockResolvedValue([]);
  repos.Dms.findConversationsByUser.mockResolvedValue([]);
  repos.Users.findByIds.mockResolvedValue([]);
  repos.GroupDms.findGroupsByUser.mockResolvedValue([]);
  repos.Notifications.markAllChannelAttentionRead.mockResolvedValue(undefined);
  repos.Notifications.clearAllUnreadCounts.mockResolvedValue(undefined);
  repos.Dms.markRead.mockResolvedValue(undefined);
  repos.GroupDms.markRead.mockResolvedValue(undefined);
  resolvePermissions.mockResolvedValue(3);
});

/** Kanal dikkat kaydı + kanonik satırlar. */
function seedChannelAttention(overrides: {
  row?: Record<string, unknown>; message?: Record<string, unknown>;
  channel?: Record<string, unknown>; server?: Record<string, unknown>;
} = {}) {
  const row = { _id: 'n1', messageId: 'm1', channelId: 'c1', serverId: 's1', type: 'mention', createdAt: 500, actorId: 'actor', ...overrides.row };
  const message = { _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 900, content: 'hey  there', ...overrides.message };
  const channel = { _id: 'c1', serverId: 's1', name: 'general', type: 'text', ...overrides.channel };
  const server = { _id: 's1', name: 'Bridge', ...overrides.server };
  repos.Notifications.findUnreadChannelAttention.mockResolvedValue([row]);
  repos.Messages.findWhere.mockResolvedValue([message]);
  repos.Channels.findWhere.mockResolvedValue([channel]);
  repos.Servers.findByIds.mockResolvedValue([server]);
}

describe('channel attention re-authorization', () => {
  it('drops a row whose stored routing identifiers disagree with the canonical message', async () => {
    seedChannelAttention({ row: { channelId: 'other-channel' } });
    expect((await get()).body.items).toEqual([]);

    seedChannelAttention({ row: { serverId: 'other-server' } });
    expect((await get()).body.items).toEqual([]);
  });

  it('drops a row whose channel or server row can no longer be read', async () => {
    seedChannelAttention();
    repos.Channels.findWhere.mockResolvedValue([]);
    expect((await get()).body.items).toEqual([]);

    seedChannelAttention();
    repos.Servers.findByIds.mockResolvedValue([]);
    expect((await get()).body.items).toEqual([]);
  });

  it('drops a deleted message and de-duplicates repeated attention rows', async () => {
    seedChannelAttention({ message: { deletedAt: 123 } });
    expect((await get()).body.items).toEqual([]);

    repos.Notifications.findUnreadChannelAttention.mockResolvedValue([
      { _id: 'n1', messageId: 'm1', channelId: 'c1', serverId: 's1', type: 'mention' },
      { _id: 'n2', messageId: 'm1', channelId: 'c1', serverId: 's1', type: 'reply' },
      { _id: 'n3', messageId: '', channelId: 'c1', serverId: 's1' },
    ]);
    repos.Messages.findWhere.mockResolvedValue([{ _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 9, content: 'x' }]);
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'c1', serverId: 's1', name: 'general', type: 'text' }]);
    repos.Servers.findByIds.mockResolvedValue([{ _id: 's1', name: 'Bridge' }]);
    const response = await get();
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].kind).toBe('mention');
  });

  it('drops a row the caller may no longer view or read history for', async () => {
    seedChannelAttention();
    resolvePermissions.mockResolvedValue(1); // VIEW only
    expect((await get()).body.items).toEqual([]);

    seedChannelAttention();
    resolvePermissions.mockRejectedValue(new Error('permission store down'));
    expect((await get()).body.items).toEqual([]);
  });

  it('fills every absent column with a safe label instead of leaking undefined', async () => {
    seedChannelAttention({
      message: { userId: undefined, createdAt: undefined, displayName: undefined, username: undefined, avatarColor: undefined, avatarUrl: undefined },
      channel: { name: undefined, type: undefined },
      server: { name: undefined, iconUrl: undefined },
    });
    const item = (await get()).body.items[0];
    expect(item.sender).toEqual({ _id: 'actor', displayName: 'Bridge user', avatarColor: '#2d9cdb', avatarUrl: null });
    expect(item.createdAt).toBe(500); // mesajda yoksa dikkat kaydından alınır
    expect(item.destination.channel).toEqual({ _id: 'c1', name: 'channel', type: 'text' });
    expect(item.destination.server).toEqual({ _id: 's1', name: 'Bridge', iconUrl: null });
    expect(JSON.stringify(item)).not.toContain('undefined');
  });

  it('reports zero for a row with neither message nor attention timestamp', async () => {
    seedChannelAttention({ row: { createdAt: undefined }, message: { createdAt: undefined } });
    expect((await get()).body.items[0].createdAt).toBe(0);
  });

  it.each([
    [{ type: 'e2ee' }, 'Şifreli mesaj'],
    [{ e2e: true }, 'Şifreli mesaj'],
    [{ isEncrypted: true }, 'Şifreli mesaj'],
    [{ type: 'file' }, 'Dosya mesajı'],
    [{ fileUrl: '/u/a.png' }, 'Dosya mesajı'],
    [{ content: undefined }, ''],
  ])('never previews protected content for %j', async (message, expected) => {
    seedChannelAttention({ message });
    expect((await get()).body.items[0].preview).toBe(expected);
  });

  it('collapses whitespace and truncates a long preview', async () => {
    seedChannelAttention({ message: { content: `  a\n\nb  ${'x'.repeat(300)}` } });
    const preview = (await get()).body.items[0].preview as string;
    expect(preview.startsWith('a b ')).toBe(true);
    expect(preview.length).toBe(140);
  });
});

describe('direct and group attention', () => {
  it('skips a conversation the caller does not participate in and one whose partner row is gone', async () => {
    repos.Dms.findConversationsByUser.mockResolvedValue([
      { _id: 'd1', participants: ['other-a', 'other-b'] },
      { _id: 'd2', participants: ['u1', 'ghost'] },
      { _id: 'd3', participants: 'not-an-array' },
    ]);
    repos.Users.findByIds.mockResolvedValue([]);
    repos.Dms.countUnread.mockResolvedValue(3);
    expect((await get()).body.items).toEqual([]);
  });

  it('reports a direct conversation with a corrupt read cursor as fully unread-safe', async () => {
    repos.Dms.findConversationsByUser.mockResolvedValue([
      { _id: 'd1', participants: ['u1', 'u2'], readAt: { u1: 'corrupt' }, lastMessageAt: 700 },
    ]);
    repos.Users.findByIds.mockResolvedValue([{ _id: 'u2', username: 'ada', displayName: 'Ada' }]);
    repos.Dms.countUnread.mockResolvedValue(2);
    repos.Dms.findLatestUnread.mockResolvedValue(null);

    const response = await get();
    // Bozuk imleç GEÇMİŞİ AÇMAZ: fail-closed olarak en büyük değere gider.
    expect(repos.Dms.countUnread).toHaveBeenCalledWith('d1', 'u1', Number.MAX_SAFE_INTEGER);
    expect(response.body.items[0]).toEqual(expect.objectContaining({ kind: 'dm', unreadCount: 2, createdAt: 700 }));
  });

  it('treats a conversation with no read cursor object as never read', async () => {
    repos.Dms.findConversationsByUser.mockResolvedValue([{ _id: 'd1', participants: ['u1', 'u2'] }]);
    repos.Users.findByIds.mockResolvedValue([{ _id: 'u2', username: 'ada', displayName: 'Ada' }]);
    repos.Dms.countUnread.mockResolvedValue(0);
    expect((await get()).body.items).toEqual([]);
    expect(repos.Dms.countUnread).toHaveBeenCalledWith('d1', 'u1', 0);
  });

  it('skips a group membership whose group row no longer exists', async () => {
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1' }, { groupId: '' }]);
    repos.GroupDms.findById.mockResolvedValue(null);
    repos.GroupDms.countUnread.mockResolvedValue(5);
    expect((await get()).body.items).toEqual([]);
  });

  it('derives the group cursor from the later of joinedAt and readAt', async () => {
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1', joinedAt: 100, readAt: 400 }]);
    repos.GroupDms.findById.mockResolvedValue({ _id: 'g1', name: 'Crew', lastMessageAt: 800 });
    repos.GroupDms.countUnread.mockResolvedValue(1);
    repos.GroupDms.findLatestUnread.mockResolvedValue(null);
    await get();
    expect(repos.GroupDms.countUnread).toHaveBeenCalledWith('g1', 'u1', 400);
  });

  it('treats a membership with no join cursor as joined at the end of time', async () => {
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1', readAt: 10 }]);
    repos.GroupDms.findById.mockResolvedValue({ _id: 'g1', name: 'Crew' });
    repos.GroupDms.countUnread.mockResolvedValue(0);
    await get();
    // Katılım tarihi bilinmiyorsa üye, katılmadan ÖNCEKİ mesajları görmemelidir.
    expect(repos.GroupDms.countUnread).toHaveBeenCalledWith('g1', 'u1', Number.MAX_SAFE_INTEGER);
  });

  it('labels a group row and its latest sender when both lack names', async () => {
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1', joinedAt: 1, readAt: 1 }]);
    repos.GroupDms.findById.mockResolvedValue({ _id: 'g1', ownerId: 'owner' });
    repos.GroupDms.countUnread.mockResolvedValue(2);
    repos.GroupDms.findLatestUnread.mockResolvedValue({ userId: undefined, content: 'hi' });

    const item = (await get()).body.items[0];
    expect(item.destination.group).toEqual(expect.objectContaining({ name: 'Grup DM', icon: null }));
    expect(item.sender).toEqual({ _id: '', displayName: 'Bridge user', avatarColor: '#2d9cdb' });
    expect(item.createdAt).toBe(0);
  });

  it('reports no sender at all when the group has unread messages but none can be read back', async () => {
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1', joinedAt: 1, readAt: 1 }]);
    repos.GroupDms.findById.mockResolvedValue({ _id: 'g1', name: 'Crew', lastMessageAt: 42 });
    repos.GroupDms.countUnread.mockResolvedValue(2);
    repos.GroupDms.findLatestUnread.mockResolvedValue(null);
    const item = (await get()).body.items[0];
    expect(item.sender).toBeNull();
    expect(item.createdAt).toBe(42);
  });
});

describe('counts and filters', () => {
  async function mixedInbox() {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValue([
      { _id: 'n1', messageId: 'm1', channelId: 'c1', serverId: 's1', type: 'mention' },
      { _id: 'n2', messageId: 'm2', channelId: 'c1', serverId: 's1', type: 'reply' },
    ]);
    repos.Messages.findWhere.mockResolvedValue([
      { _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 300, content: 'mention' },
      { _id: 'm2', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 200, content: 'reply' },
    ]);
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'c1', serverId: 's1', name: 'general', type: 'text' }]);
    repos.Servers.findByIds.mockResolvedValue([{ _id: 's1', name: 'Bridge' }]);
    repos.Dms.findConversationsByUser.mockResolvedValue([{ _id: 'd1', participants: ['u1', 'u2'], lastMessageAt: 400 }]);
    repos.Users.findByIds.mockResolvedValue([{ _id: 'u2', username: 'ada', displayName: 'Ada' }]);
    repos.Dms.countUnread.mockResolvedValue(4);
    repos.Dms.findLatestUnread.mockResolvedValue({ createdAt: 400, content: 'dm' });
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1', joinedAt: 1, readAt: 1 }]);
    repos.GroupDms.findById.mockResolvedValue({ _id: 'g1', name: 'Crew', lastMessageAt: 100 });
    repos.GroupDms.countUnread.mockResolvedValue(3);
    repos.GroupDms.findLatestUnread.mockResolvedValue({ userId: 'u3', displayName: 'Cem', createdAt: 100, content: 'gdm' });
  }

  it('sorts newest first and counts each kind separately', async () => {
    await mixedInbox();
    const body = (await get()).body;
    expect(body.items.map((item: { kind: string }) => item.kind)).toEqual(['dm', 'mention', 'reply', 'gdm']);
    expect(body.counts).toEqual(expect.objectContaining({ mentions: 1, replies: 1, dms: 7 }));
  });

  it.each([
    ['mentions', ['mention']],
    ['replies', ['reply']],
    ['dms', ['dm', 'gdm']],
    ['unknown-filter', ['dm', 'mention', 'reply', 'gdm']],
  ])('applies the %s filter without changing the counts', async (filter, kinds) => {
    await mixedInbox();
    const body = (await get(`?filter=${filter}`)).body;
    expect(body.items.map((item: { kind: string }) => item.kind)).toEqual(kinds);
    expect(body.counts).toEqual(expect.objectContaining({ mentions: 1, replies: 1, dms: 7 }));
  });
});
