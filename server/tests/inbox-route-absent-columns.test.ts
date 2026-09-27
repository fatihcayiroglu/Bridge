// server/tests/inbox-route-absent-columns.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// routes/inbox.ts — SÜTUNU HİÇ OLMAYAN SATIRLAR VE SÜZGEÇLER
// ════════════════════════════════════════════════════════════════════════════
//
// `inbox-route-sparse-rows.test.ts` sütunu BOŞ olan satırları ölçer. Üretimde
// bir başka durum daha vardır ve ayrı dallara girer: sütunun HİÇ OLMAMASI
// (`undefined`). Eski şemalardan gelen satırlar, kısmi göç ve federasyondan
// gelen kayıtlar tam olarak böyledir.
//
// Ölçülen sözleşmeler:
//   · Kimliksiz satır TOPLU SORGUYA girmez — `undefined` bir kimlik olarak
//     veritabanına gönderilirse ya çöker ya da yanlış satır çeker.
//   · Hatırlatıcı işaretçisi çözülemezse kayıt SESSİZCE bırakılmaz; okundu
//     işaretlenir ki kullanıcı sonsuza dek çözülemeyen bir rozet taşımasın.
//   · Süzgeçler (`watches`, `reminders`) yalnız kendi türünü döndürür.
//   · Boşluktan ibaret bildirim kimliği kabul edilmez.

process.env.NODE_ENV = 'test';

const repos = {
  Dms: { findConversationsByUser: jest.fn(), countUnread: jest.fn(), findLatestUnread: jest.fn(), markRead: jest.fn() },
  GroupDms: { findGroupsByUser: jest.fn(), findById: jest.fn(), countUnread: jest.fn(), findLatestUnread: jest.fn(), markRead: jest.fn() },
  Notifications: {
    findUnreadChannelAttention: jest.fn(), findUnreadSavedReminders: jest.fn(),
    markSavedReminderRead: jest.fn(), markAllSavedRemindersRead: jest.fn(),
    markAllChannelAttentionRead: jest.fn(), clearAllUnreadCounts: jest.fn(),
  },
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
  repos.Notifications.markAllChannelAttentionRead.mockResolvedValue(undefined);
  repos.Notifications.clearAllUnreadCounts.mockResolvedValue(undefined);
  repos.SavedMessages.findByIdForUser.mockResolvedValue(null);
  repos.Messages.findWhere.mockResolvedValue([]);
  repos.Channels.findWhere.mockResolvedValue([]);
  repos.Servers.findByIds.mockResolvedValue([]);
  repos.Dms.findConversationsByUser.mockResolvedValue([]);
  repos.Users.findByIds.mockResolvedValue([]);
  repos.GroupDms.findGroupsByUser.mockResolvedValue([]);
  repos.Dms.markRead.mockResolvedValue(undefined);
  repos.GroupDms.markRead.mockResolvedValue(undefined);
  resolvePermissions.mockResolvedValue(3);
});

describe('kimliği hiç olmayan kanal dikkat satırları', () => {
  it('mesaj kimliği olmayan satır toplu sorguya hiç girmez', async () => {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValue([
      { _id: 'n-eksik', channelId: 'c1', serverId: 's1', type: 'mention' },
    ]);

    const res = await get();

    expect(res.body.items).toEqual([]);
    // Kimliksiz satir icin veri tabanina HIC gidilmez.
    expect(repos.Messages.findWhere).not.toHaveBeenCalled();
  });

  it('kanal/sunucu kimliği olmayan kanonik mesaj listeye giremez', async () => {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValue([
      { _id: 'n1', messageId: 'm1', channelId: 'c1', serverId: 's1', type: 'mention' },
    ]);
    repos.Messages.findWhere.mockResolvedValue([{ _id: 'm1', userId: 'u9', createdAt: 5, content: 'x' }]);

    const res = await get();

    expect(res.body.items).toEqual([]);
    // Kanal kimligi cikarilamadigi icin kanal sorgusu da bos kalir.
    expect(repos.Channels.findWhere).not.toHaveBeenCalled();
  });

  it('sunucu kimliği olmayan kanal satırı sunucu sorgusuna girmez', async () => {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValue([
      { _id: 'n1', messageId: 'm1', channelId: 'c1', serverId: 's1', type: 'mention' },
    ]);
    repos.Messages.findWhere.mockResolvedValue([{ _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 5, content: 'x' }]);
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'c1', name: 'genel', type: 'text' }]);

    const res = await get();

    expect(res.body.items).toEqual([]);
    expect(repos.Servers.findByIds).not.toHaveBeenCalled();
  });

  it('yönlendirme kimliği hiç olmayan satır kanonik satırla eşleşmiş sayılmaz', async () => {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValue([
      { _id: 'n1', messageId: 'm1', type: 'mention' },
    ]);
    repos.Messages.findWhere.mockResolvedValue([{ _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 5, content: 'x' }]);
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'c1', serverId: 's1', name: 'genel', type: 'text' }]);
    repos.Servers.findByIds.mockResolvedValue([{ _id: 's1', name: 'Bridge' }]);

    expect((await get()).body.items).toEqual([]);
  });
});

describe('dikkat türü ve gönderen kimliği', () => {
  function seed(row: Record<string, unknown>, message: Record<string, unknown> = {}) {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValue([
      { _id: 'n1', messageId: 'm1', channelId: 'c1', serverId: 's1', createdAt: 100, ...row },
    ]);
    repos.Messages.findWhere.mockResolvedValue([
      { _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 900, content: 'selam', ...message },
    ]);
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'c1', serverId: 's1', name: 'genel', type: 'text' }]);
    repos.Servers.findByIds.mockResolvedValue([{ _id: 's1', name: 'Bridge' }]);
  }

  it('izleme kaydı "watch", yanıt "reply", diğer her şey "mention" olur', async () => {
    seed({ type: 'watch' });
    expect((await get()).body.items[0].kind).toBe('watch');

    seed({ type: 'reply' });
    expect((await get()).body.items[0].kind).toBe('reply');

    seed({ type: 'bilinmeyen-tur' });
    expect((await get()).body.items[0].kind).toBe('mention');
  });

  it('mesajda yazar yoksa dikkat kaydındaki aktöre, o da yoksa boş kimliğe düşer', async () => {
    seed({ actorId: 'aktor-1' }, { userId: undefined });
    expect((await get()).body.items[0].sender._id).toBe('aktor-1');

    seed({ actorId: undefined }, { userId: undefined });
    expect((await get()).body.items[0].sender._id).toBe('');
  });

  it('süzgeçler yalnız kendi türünü döndürür ve sayaçlar ayrı tutulur', async () => {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValue([
      { _id: 'n-mention', messageId: 'm1', channelId: 'c1', serverId: 's1', type: 'mention' },
      { _id: 'n-watch', messageId: 'm2', channelId: 'c1', serverId: 's1', type: 'watch' },
      { _id: 'n-reply', messageId: 'm3', channelId: 'c1', serverId: 's1', type: 'reply' },
    ]);
    repos.Messages.findWhere.mockResolvedValue([
      { _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 3, content: 'a' },
      { _id: 'm2', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 2, content: 'b' },
      { _id: 'm3', channelId: 'c1', serverId: 's1', userId: 'u9', createdAt: 1, content: 'c' },
    ]);
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'c1', serverId: 's1', name: 'genel', type: 'text' }]);
    repos.Servers.findByIds.mockResolvedValue([{ _id: 's1', name: 'Bridge' }]);

    const watches = await get('?filter=watches');
    expect(watches.body.items.map((i: any) => i.id)).toEqual(['n-watch']);
    expect(watches.body.filter).toBe('watches');
    expect(watches.body.counts).toMatchObject({ mentions: 1, watches: 1, replies: 1, all: 3 });

    const mentions = await get('?filter=mentions');
    expect(mentions.body.items.map((i: any) => i.id)).toEqual(['n-mention']);
  });
});

describe('doğrudan mesaj ve grup satırlarında eksik kimlikler', () => {
  it('yalnız kendisinden oluşan konuşma karşı taraf üretmez', async () => {
    repos.Dms.findConversationsByUser.mockResolvedValue([{ _id: 'd1', participants: ['u1'], lastMessageAt: 10 }]);

    const res = await get();

    expect(res.body.items).toEqual([]);
    expect(repos.Dms.countUnread).not.toHaveBeenCalled();
  });

  it('okunmamış mesajı olan ama zaman damgası bulunmayan konuşma sıfır zamanla listelenir', async () => {
    repos.Dms.findConversationsByUser.mockResolvedValue([{ _id: 'd1', participants: ['u1', 'u2'] }]);
    repos.Users.findByIds.mockResolvedValue([{ _id: 'u2', username: 'ada', displayName: 'Ada' }]);
    repos.Dms.countUnread.mockResolvedValue(2);
    repos.Dms.findLatestUnread.mockResolvedValue(null);

    const res = await get();

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: 'dm:d1', kind: 'dm', unreadCount: 2, createdAt: 0, preview: '' });
  });

  it('grup kimliği hiç olmayan üyelik satırı grup sorgusuna girmez', async () => {
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ userId: 'u1', joinedAt: 1 }]);

    const res = await get();

    expect(res.body.items).toEqual([]);
    expect(repos.GroupDms.findById).not.toHaveBeenCalled();
  });

  it('grup zaman damgası yoksa sıfır kullanılır', async () => {
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1', joinedAt: 1, readAt: 1 }]);
    repos.GroupDms.findById.mockResolvedValue({ _id: 'g1', name: 'Ekip', ownerId: 'u2' });
    repos.GroupDms.countUnread.mockResolvedValue(3);
    repos.GroupDms.findLatestUnread.mockResolvedValue(null);

    const res = await get();

    expect(res.body.items[0]).toMatchObject({ id: 'gdm:g1', kind: 'gdm', createdAt: 0, sender: null });
  });
});

describe('kaydedilmiş hatırlatıcılar', () => {
  it('işaretçisi olmayan hatırlatıcı okundu işaretlenir ve listelenmez', async () => {
    repos.Notifications.findUnreadSavedReminders.mockResolvedValue([{ _id: 'r-eksik' }]);

    const res = await get();

    expect(res.body.items).toEqual([]);
    expect(repos.Notifications.markSavedReminderRead).toHaveBeenCalledWith('u1', 'r-eksik');
    expect(repos.SavedMessages.findByIdForUser).not.toHaveBeenCalled();
  });

  it('artık erişilemeyen kayda işaret eden hatırlatıcı da temizlenir', async () => {
    repos.Notifications.findUnreadSavedReminders.mockResolvedValue([{ _id: 'r1', noteId: 'saved-1', createdAt: 7 }]);
    repos.SavedMessages.findByIdForUser.mockResolvedValue(null);

    const res = await get();

    expect(res.body.items).toEqual([]);
    expect(repos.SavedMessages.findByIdForUser).toHaveBeenCalledWith('u1', 'saved-1');
    expect(repos.Notifications.markSavedReminderRead).toHaveBeenCalledWith('u1', 'r1');
  });

  it('kimliği hiç olmayan hatırlatıcı kaydı boş kimlikle temizlenir', async () => {
    repos.Notifications.findUnreadSavedReminders.mockResolvedValue([{ noteId: '' }]);

    await get();

    expect(repos.Notifications.markSavedReminderRead).toHaveBeenCalledWith('u1', '');
  });

  it('geçerli hatırlatıcı zaman damgasız gelse de sıfır zamanla sunulur ve süzülebilir', async () => {
    repos.Notifications.findUnreadSavedReminders.mockResolvedValue([{ _id: 'r1', noteId: 'saved-1' }]);
    repos.SavedMessages.findByIdForUser.mockResolvedValue({ _id: 'saved-1' });

    const all = await get();
    expect(all.body.items[0]).toMatchObject({
      id: 'r1', kind: 'reminder', unreadCount: 1, createdAt: 0, sender: null,
      destination: { type: 'saved', savedId: 'saved-1' },
    });
    expect(all.body.counts).toMatchObject({ reminders: 1, all: 1 });
    // Hatirlatici ONIZLEMESI mesaj icerigi TASIMAZ.
    expect(all.body.items[0].preview).toBe('Sonra bakmak için kaydettiğin bir mesaja dönme zamanı.');

    const filtered = await get('?filter=reminders');
    expect(filtered.body.items.map((i: any) => i.id)).toEqual(['r1']);
  });
});

describe('okundu işaretleme uçları', () => {
  it('yalnız boşluktan oluşan bildirim kimliği reddedilir', async () => {
    const res = await request(app).patch('/api/inbox/%20%20/read');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid notification');
    expect(repos.Notifications.markSavedReminderRead).not.toHaveBeenCalled();
  });

  it('geçerli kimlik kırpılarak kanonik depoya iletilir', async () => {
    const res = await request(app).patch('/api/inbox/%20r1%20/read');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ read: true });
    expect(repos.Notifications.markSavedReminderRead).toHaveBeenCalledWith('u1', 'r1');
  });

  it('toplu okundu, grup kimliği olmayan üyelikte boş kimlikle çağrılır', async () => {
    repos.Dms.findConversationsByUser.mockResolvedValue([{ _id: 'd1', participants: ['u1', 'u2'] }]);
    repos.GroupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1' }, { userId: 'u1' }]);

    const res = await request(app).patch('/api/inbox/read-all');

    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
    expect(repos.Dms.markRead).toHaveBeenCalledWith('d1', 'u1');
    expect(repos.GroupDms.markRead).toHaveBeenCalledWith('g1', 'u1');
    expect(repos.GroupDms.markRead).toHaveBeenCalledWith('', 'u1');
    expect(repos.Notifications.markAllChannelAttentionRead).toHaveBeenCalledWith('u1');
    expect(repos.Notifications.markAllSavedRemindersRead).toHaveBeenCalledWith('u1');
  });
});
