import { at } from './helpers/narrow';
// server/tests/saved-surface-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KİŞİSEL "SONRA OKU" YÜZEYİ — ERİŞİM VE BOZULMA DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// Kaydedilen öğeler ZAMAN İÇİNDE geçersizleşir: mesaj silinir, kanaldan
// atılırsın, DM konuşmasından çıkarılırsın, grup dağılır. Liste bu durumları
// tek tek ele almak zorundadır; ölçülmemiş olan da tam bu dallardı.
//
//   · SIZINTI — kaydedilen öğe, kullanıcı artık göremiyorsa İÇERİĞİ ile
//     dönmemelidir. `unavailable: true` ile dönmek doğru davranıştır;
//     "kaydettiğin an yetkin vardı" bir yetki kaynağı DEĞİLDİR.
//   · ORACLE — kaydetme ucunda "bulunamadı" ile "yetkin yok" AYNI yanıtı
//     vermelidir; aksi hâlde uç, mesaj varlığı sorgulanabilen bir kehanet olur.
//   · ÖNİZLEME — şifreli ve dosya mesajlarının İÇERİĞİ önizlemeye sızmamalıdır.
//   · HATIRLATICI — geçmişe/30 günden öteye kurulamamalı, yarışta 409 vermeli.
//   · Depo çökerse liste 503 vermeli, yarım liste değil.

process.env.NODE_ENV = 'test';

const repos = {
  Channels: { findById: jest.fn() },
  Dms: { findConversation: jest.fn(), findMessage: jest.fn() },
  GroupDms: { findMember: jest.fn(), findById: jest.fn(), findMessage: jest.fn() },
  Messages: { findById: jest.fn() },
  SavedMessages: {
    save: jest.fn(), findForUser: jest.fn(), findByIdForUser: jest.fn(),
    clearReminder: jest.fn(), setReminder: jest.fn(), removeForUser: jest.fn(),
  },
  Servers: { findById: jest.fn() },
  Users: { findById: jest.fn() },
};
const resolvePerms = jest.fn();

jest.mock('../db/repositories', () => repos);
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: unknown },
    _res: unknown,
    next: () => void,
  ) => { req.user = { id: 'user-1', _id: 'user-1', username: 'alice' }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: { api: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));
// İzin biti mantığı GERÇEK; yalnız veriye giden çözümleme taklit edilir.
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, resolvePermissions: (...args: unknown[]) => resolvePerms(...args) };
});

import express from 'express';
import request from 'supertest';
import { PERMS } from '../lib/permissions';
import router from '../routes/saved';

const app = express();
app.use(express.json());
app.use('/api/saved', router);

const READABLE = PERMS.VIEW_CHANNELS | PERMS.READ_HISTORY;
const MSG = 'msg-1';
const CH = 'ch-1';
const SRV = 'srv-1';

const channelMessage = (over: Record<string, unknown> = {}) => ({
  _id: MSG, channelId: CH, serverId: SRV, userId: 'yazar',
  displayName: 'Yazar', username: 'yazar', avatarColor: '#abc',
  content: 'kaydedilecek içerik', type: 'normal', ...over,
});

const savedRow = (over: Record<string, unknown> = {}) => ({
  _id: 'saved-1', destinationType: 'channel', destinationId: CH, messageId: MSG,
  createdAt: 1700, remindAt: 0, remindedAt: 0, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  resolvePerms.mockResolvedValue(READABLE);
  repos.Messages.findById.mockResolvedValue(channelMessage());
  repos.Channels.findById.mockResolvedValue({ _id: CH, name: 'genel', type: 'text' });
  repos.Servers.findById.mockResolvedValue({ _id: SRV, name: 'Sunucu', iconUrl: null });
  repos.Dms.findConversation.mockResolvedValue({ _id: 'dm-1', participants: ['user-1', 'user-2'] });
  repos.Dms.findMessage.mockResolvedValue({ _id: MSG, userId: 'user-2', displayName: 'Öteki', content: 'dm içeriği' });
  repos.GroupDms.findMember.mockResolvedValue({ userId: 'user-1' });
  repos.GroupDms.findById.mockResolvedValue({ _id: 'gdm-1', name: 'Grup', icon: null, ownerId: 'user-2' });
  repos.GroupDms.findMessage.mockResolvedValue({ _id: MSG, userId: 'user-2', displayName: 'Öteki', content: 'grup içeriği' });
  repos.SavedMessages.save.mockResolvedValue({ created: true, row: { _id: 'saved-1' } });
  repos.SavedMessages.findForUser.mockResolvedValue([]);
  repos.SavedMessages.findByIdForUser.mockResolvedValue(savedRow());
  repos.SavedMessages.clearReminder.mockResolvedValue(undefined);
  repos.SavedMessages.setReminder.mockResolvedValue({ updated: 1 });
  repos.SavedMessages.removeForUser.mockResolvedValue(undefined);
  repos.Users.findById.mockResolvedValue({ _id: 'user-2', username: 'bob', displayName: 'Bob' });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /saved — hedef doğrulama', () => {
  const save = (body: unknown) => request(app).post('/api/saved').send(body as object);

  it.each([
    ['tür eksik', { destinationId: CH, messageId: MSG }],
    ['tür tanınmıyor', { destinationType: 'thread', destinationId: CH, messageId: MSG }],
    ['hedef boş', { destinationType: 'channel', destinationId: '   ', messageId: MSG }],
    ['mesaj boş', { destinationType: 'channel', destinationId: CH, messageId: '' }],
    ['hedef çok uzun', { destinationType: 'channel', destinationId: 'x'.repeat(161), messageId: MSG }],
    ['mesaj çok uzun', { destinationType: 'channel', destinationId: CH, messageId: 'x'.repeat(161) }],
    ['gövde yok', undefined],
  ])('%s ise 400 verir', async (_label, body) => {
    const res = await save(body ?? {});
    expect(res.status).toBe(400);
    expect(repos.SavedMessages.save).not.toHaveBeenCalled();
  });

  it('kanal mesajı okunabiliyorsa kaydedilir', async () => {
    const res = await save({ destinationType: 'channel', destinationId: CH, messageId: MSG });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'saved-1', saved: true, created: true });
  });

  it('zaten kayıtlı öğe 200 ile döner (yeniden oluşturmaz)', async () => {
    repos.SavedMessages.save.mockResolvedValue({ created: false, row: { _id: 'saved-1' } });
    expect((await save({ destinationType: 'channel', destinationId: CH, messageId: MSG })).status).toBe(200);
  });

  it.each([
    ['mesaj yoksa', null],
    ['mesaj silinmişse', channelMessage({ deletedAt: 1 })],
    ['mesaj BAŞKA kanaldaysa', channelMessage({ channelId: 'baska-kanal' })],
  ])('%s aynı 404 döner (varlık kehaneti yok)', async (_label, message) => {
    repos.Messages.findById.mockResolvedValue(message);

    const res = await save({ destinationType: 'channel', destinationId: CH, messageId: MSG });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not available');
    expect(repos.SavedMessages.save).not.toHaveBeenCalled();
  });

  it.each([
    ['okuma yetkisi yoksa', PERMS.VIEW_CHANNELS],
    ['görme yetkisi yoksa', PERMS.READ_HISTORY],
    ['hiç yetki yoksa', 0],
  ])('%s kaydedilemez', async (_label, perms) => {
    resolvePerms.mockResolvedValue(perms);
    expect((await save({ destinationType: 'channel', destinationId: CH, messageId: MSG })).status).toBe(404);
  });

  it('yetki çözümü PATLARSA kaydedilemez (fail-closed)', async () => {
    resolvePerms.mockRejectedValue(new Error('permission store down'));
    expect((await save({ destinationType: 'channel', destinationId: CH, messageId: MSG })).status).toBe(404);
  });

  it('DM: katılımcı olmayan kaydedemez', async () => {
    repos.Dms.findConversation.mockResolvedValue({ participants: ['user-2', 'user-3'] });
    expect((await save({ destinationType: 'dm', destinationId: 'dm-1', messageId: MSG })).status).toBe(404);
    expect(repos.Dms.findMessage).not.toHaveBeenCalled();
  });

  it('DM: konuşma yoksa veya katılımcı listesi bozuksa kaydedilemez', async () => {
    repos.Dms.findConversation.mockResolvedValue(null);
    expect((await save({ destinationType: 'dm', destinationId: 'dm-1', messageId: MSG })).status).toBe(404);

    repos.Dms.findConversation.mockResolvedValue({ participants: 'bozuk' });
    expect((await save({ destinationType: 'dm', destinationId: 'dm-1', messageId: MSG })).status).toBe(404);
  });

  it('DM: mesaj yoksa kaydedilemez, varsa kaydedilir', async () => {
    repos.Dms.findMessage.mockResolvedValue(null);
    expect((await save({ destinationType: 'dm', destinationId: 'dm-1', messageId: MSG })).status).toBe(404);

    repos.Dms.findMessage.mockResolvedValue({ _id: MSG });
    expect((await save({ destinationType: 'dm', destinationId: 'dm-1', messageId: MSG })).status).toBe(201);
  });

  it('GDM: üye olmayan kaydedemez; mesaj yoksa kaydedemez', async () => {
    repos.GroupDms.findMember.mockResolvedValue(null);
    expect((await save({ destinationType: 'gdm', destinationId: 'gdm-1', messageId: MSG })).status).toBe(404);

    repos.GroupDms.findMember.mockResolvedValue({ userId: 'user-1' });
    repos.GroupDms.findMessage.mockResolvedValue(null);
    expect((await save({ destinationType: 'gdm', destinationId: 'gdm-1', messageId: MSG })).status).toBe(404);

    repos.GroupDms.findMessage.mockResolvedValue({ _id: MSG });
    expect((await save({ destinationType: 'gdm', destinationId: 'gdm-1', messageId: MSG })).status).toBe(201);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /saved — erişilemez öğeler İÇERİKSİZ döner', () => {
  const list = () => request(app).get('/api/saved');

  it('bozuk satır (tür/hedef/mesaj eksik) içerik taşımaz', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([
      savedRow({ _id: 's1', destinationType: 'thread' }),
      savedRow({ _id: 's2', destinationId: '' }),
      savedRow({ _id: 's3', messageId: '' }),
    ]);

    const res = await list();

    expect(res.body.count).toBe(3);
    for (const item of res.body.items) {
      expect(item).toEqual({ id: item.id, savedAt: 1700, unavailable: true, remindAt: null, remindedAt: null });
    }
    expect(repos.Messages.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['mesaj silinmiş', () => repos.Messages.findById.mockResolvedValue(channelMessage({ deletedAt: 5 }))],
    ['mesaj yok', () => repos.Messages.findById.mockResolvedValue(null)],
    ['mesaj taşınmış', () => repos.Messages.findById.mockResolvedValue(channelMessage({ channelId: 'baska' }))],
    ['yetki kaybedilmiş', () => resolvePerms.mockResolvedValue(0)],
    ['geçmiş okuma yetkisi yok', () => resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS)],
    ['kanal silinmiş', () => repos.Channels.findById.mockResolvedValue(null)],
    ['sunucu silinmiş', () => repos.Servers.findById.mockResolvedValue(null)],
  ])('kanal öğesi %s ise ÖNİZLEME sızdırmaz', async (_label, arrange) => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow()]);
    arrange();

    const res = await list();

    expect(res.body.items[0].unavailable).toBe(true);
    expect(res.body.items[0].preview).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('kaydedilecek içerik');
  });

  it('erişilebilir kanal öğesi tam gövdeyle döner', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow({ remindAt: 9_000, remindedAt: 8_000 })]);

    const res = await list();

    expect(res.body.items[0]).toMatchObject({
      id: 'saved-1', savedAt: 1700, unavailable: false,
      remindAt: 9_000, remindedAt: 8_000,
      preview: 'kaydedilecek içerik',
      sender: { _id: 'yazar', displayName: 'Yazar', avatarColor: '#abc' },
      destination: {
        type: 'channel', messageId: MSG, channelId: CH, serverId: SRV,
        channel: { _id: CH, name: 'genel', type: 'text' },
        server: { _id: SRV, name: 'Sunucu', iconUrl: null },
      },
    });
  });

  it('geçersiz hatırlatıcı damgaları NULL olur', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([
      savedRow({ remindAt: -5, remindedAt: 1.5 }),
    ]);

    const res = await list();

    expect(res.body.items[0].remindAt).toBeNull();
    expect(res.body.items[0].remindedAt).toBeNull();
  });

  it.each([
    ['şifreli mesaj', { type: 'e2ee', content: 'GİZLİ' }, 'Şifreli mesaj'],
    ['e2e bayraklı', { e2e: true, content: 'GİZLİ' }, 'Şifreli mesaj'],
    ['isEncrypted bayraklı', { isEncrypted: true, content: 'GİZLİ' }, 'Şifreli mesaj'],
    ['dosya türü', { type: 'file', content: 'GİZLİ' }, 'Dosya mesajı'],
    ['dosya bağlantısı', { fileUrl: 'https://x/y.png', content: 'GİZLİ' }, 'Dosya mesajı'],
  ])('%s önizlemede İÇERİK göstermez', async (_label, over, expected) => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow()]);
    repos.Messages.findById.mockResolvedValue(channelMessage(over));

    const res = await list();

    expect(res.body.items[0].preview).toBe(expected);
    expect(JSON.stringify(res.body)).not.toContain('GİZLİ');
  });

  it('önizleme boşlukları sadeleştirir ve 160 karakterle sınırlıdır', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow()]);
    repos.Messages.findById.mockResolvedValue(channelMessage({ content: `  a\n\n b  ${'x'.repeat(300)}` }));

    const preview = (await list()).body.items[0].preview as string;

    expect(preview.startsWith('a b ')).toBe(true);
    expect(preview.length).toBe(160);
  });

  it('adı olmayan gönderen kullanıcı adına, o da yoksa sabit ada düşer', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow()]);
    repos.Messages.findById.mockResolvedValue(channelMessage({ displayName: undefined }));
    expect((await list()).body.items[0].sender.displayName).toBe('yazar');

    repos.Messages.findById.mockResolvedValue(channelMessage({ displayName: undefined, username: undefined }));
    expect((await list()).body.items[0].sender.displayName).toBe('Bridge user');
  });

  it('DM öğesi: konuşmadan çıkarılmışsa içerik göstermez', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow({ destinationType: 'dm', destinationId: 'dm-1' })]);
    repos.Dms.findConversation.mockResolvedValue({ participants: ['user-2', 'user-3'] });

    const res = await list();

    expect(res.body.items[0].unavailable).toBe(true);
    expect(repos.Dms.findMessage).not.toHaveBeenCalled();
  });

  it('DM öğesi: karşı taraf silinmişse içerik göstermez', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow({ destinationType: 'dm', destinationId: 'dm-1' })]);
    repos.Users.findById.mockResolvedValue(null);

    expect((await list()).body.items[0].unavailable).toBe(true);
  });

  it('DM öğesi: tek katılımcılı konuşmada karşı taraf ARANMAZ', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow({ destinationType: 'dm', destinationId: 'dm-1' })]);
    repos.Dms.findConversation.mockResolvedValue({ participants: ['user-1'] });

    expect((await list()).body.items[0].unavailable).toBe(true);
    expect(repos.Users.findById).not.toHaveBeenCalled();
  });

  it('DM öğesi erişilebilirse karşı tarafın ARINDIRILMIŞ kaydıyla döner', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow({ destinationType: 'dm', destinationId: 'dm-1' })]);
    repos.Users.findById.mockResolvedValue({
      _id: 'user-2', username: 'bob', displayName: 'Bob', password: 'GİZLİ-PAROLA', email: 'bob@x.test',
    });

    const res = await list();

    expect(res.body.items[0]).toMatchObject({
      unavailable: false, preview: 'dm içeriği',
      destination: { type: 'dm', dmId: 'dm-1', user: { _id: 'user-2', username: 'bob' } },
    });
    expect(JSON.stringify(res.body)).not.toContain('GİZLİ-PAROLA');
  });

  it('DM öğesi: adı olmayan gönderen sabit ada düşer', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow({ destinationType: 'dm', destinationId: 'dm-1' })]);
    repos.Dms.findMessage.mockResolvedValue({ _id: MSG, userId: undefined, content: 'x' });

    const res = await list();

    expect(res.body.items[0].sender).toEqual({ _id: '', displayName: 'Bridge user', avatarColor: '#2d9cdb' });
  });

  it.each([
    ['üyelik bitmişse', () => repos.GroupDms.findMember.mockResolvedValue(null)],
    ['grup silinmişse', () => repos.GroupDms.findById.mockResolvedValue(null)],
    ['mesaj silinmişse', () => repos.GroupDms.findMessage.mockResolvedValue(null)],
  ])('GDM öğesi %s içerik göstermez', async (_label, arrange) => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow({ destinationType: 'gdm', destinationId: 'gdm-1' })]);
    arrange();

    const res = await list();

    expect(res.body.items[0].unavailable).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('grup içeriği');
  });

  it('GDM öğesi erişilebilirse grup bilgisiyle döner', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow({ destinationType: 'gdm', destinationId: 'gdm-1' })]);
    repos.GroupDms.findById.mockResolvedValue({ _id: 'gdm-1', name: 'Grup', ownerId: 'user-2' });

    const res = await list();

    expect(res.body.items[0]).toMatchObject({
      unavailable: false, preview: 'grup içeriği',
      destination: { type: 'gdm', groupId: 'gdm-1', group: { _id: 'gdm-1', name: 'Grup', icon: null, ownerId: 'user-2' } },
    });
  });

  it('depo çökerse YARIM liste değil 503 döner', async () => {
    repos.SavedMessages.findForUser.mockRejectedValue(new Error('db down'));

    const res = await list();

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Saved messages temporarily unavailable', items: [], count: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Depo satırları ZAMAN İÇİNDE eksilir (eski şema, kısmi göç, silinmiş sütun).
// Alanın BOŞ olması ile HİÇ OLMAMASI aynı yol değildir; ikincisi yedeklerin
// gerçekten çalıştığı yoldur.
describe('GET /saved — alanı HİÇ OLMAYAN satırlar', () => {
  const list = () => request(app).get('/api/saved');

  it('kayıt zamanı olmayan erişilemez satır 0 ile sunulur', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([
      { _id: 's1', destinationType: 'channel' },
    ]);

    const res = await list();

    expect(res.body.items[0]).toEqual({
      id: 's1', savedAt: 0, unavailable: true, remindAt: null, remindedAt: null,
    });
  });

  it('hatırlatıcı sütunları hiç yoksa NULL sunulur', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([
      { _id: 's1', destinationType: 'channel', destinationId: CH, messageId: MSG },
    ]);

    const res = await list();

    expect(res.body.items[0]).toMatchObject({ savedAt: 0, remindAt: null, remindedAt: null, unavailable: false });
  });

  it('kanalı/sunucusu OLMAYAN mesaj erişilemez sayılır', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow()]);
    repos.Messages.findById.mockResolvedValue({ _id: MSG, content: 'x' });

    expect((await list()).body.items[0].unavailable).toBe(true);
  });

  it('DM satırında kayıt zamanı ve gönderen kimliği eksikse yedekler kullanılır', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([
      { _id: 's-dm', destinationType: 'dm', destinationId: 'dm-1', messageId: MSG },
    ]);
    repos.Dms.findMessage.mockResolvedValue({ _id: MSG, content: 'dm içeriği' });

    const res = await list();

    expect(res.body.items[0]).toMatchObject({
      savedAt: 0, unavailable: false,
      sender: { _id: '', displayName: 'Bridge user', avatarColor: '#2d9cdb' },
    });
  });

  it('GDM satırında kayıt zamanı ve gönderen alanları eksikse yedekler kullanılır', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([
      { _id: 's-gdm', destinationType: 'gdm', destinationId: 'gdm-1', messageId: MSG },
    ]);
    repos.GroupDms.findMessage.mockResolvedValue({ _id: MSG, content: 'grup içeriği' });

    const res = await list();

    expect(res.body.items[0]).toMatchObject({
      savedAt: 0, unavailable: false,
      sender: { _id: '', displayName: 'Bridge user', avatarColor: '#2d9cdb' },
    });
  });

  it('içeriği hiç olmayan mesajın önizlemesi BOŞ dizedir', async () => {
    repos.SavedMessages.findForUser.mockResolvedValue([savedRow()]);
    repos.Messages.findById.mockResolvedValue({ _id: MSG, channelId: CH, serverId: SRV, userId: 'yazar', displayName: 'Yazar' });

    expect((await list()).body.items[0].preview).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PUT /saved/:id/reminder', () => {
  const put = (body: unknown, id = 'saved-1') =>
    request(app).put(`/api/saved/${id}/reminder`).send(body as object);

  it('yalnız BOŞLUKTAN ibaret kimlik 400 verir ve depoya sorulmaz', async () => {
    const res = await request(app).put('/api/saved/%20%20/reminder').send({ remindAt: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid saved item');
    expect(repos.SavedMessages.findByIdForUser).not.toHaveBeenCalled();
  });

  it('kayıtta hedef alanları HİÇ YOKSA hatırlatıcı kurulamaz', async () => {
    repos.SavedMessages.findByIdForUser.mockResolvedValue({ _id: 'saved-1', destinationType: 'channel' });

    const res = await put({ remindAt: Date.now() + 60_000 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Saved item not available');
  });

  it('bilinmeyen öğe 404 verir', async () => {
    repos.SavedMessages.findByIdForUser.mockResolvedValue(null);
    expect((await put({ remindAt: Date.now() + 60_000 })).status).toBe(404);
  });

  it('null hatırlatıcı TEMİZLER ve hedef yetkisi sorulmaz', async () => {
    const res = await put({ remindAt: null });

    expect(res.body).toEqual({ reminder: null });
    expect(repos.SavedMessages.clearReminder).toHaveBeenCalledWith('user-1', 'saved-1');
    expect(repos.Messages.findById).not.toHaveBeenCalled();
  });

  it('ARTIK erişilemeyen öğeye hatırlatıcı kurulamaz', async () => {
    repos.Messages.findById.mockResolvedValue(null);

    const res = await put({ remindAt: Date.now() + 60_000 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Saved item not available');
    expect(repos.SavedMessages.setReminder).not.toHaveBeenCalled();
  });

  it('bozuk kayıt (tür/hedef/mesaj eksik) için hatırlatıcı kurulamaz', async () => {
    repos.SavedMessages.findByIdForUser.mockResolvedValue(savedRow({ destinationType: 'thread' }));
    expect((await put({ remindAt: Date.now() + 60_000 })).status).toBe(404);

    repos.SavedMessages.findByIdForUser.mockResolvedValue(savedRow({ destinationId: '' }));
    expect((await put({ remindAt: Date.now() + 60_000 })).status).toBe(404);

    repos.SavedMessages.findByIdForUser.mockResolvedValue(savedRow({ messageId: '' }));
    expect((await put({ remindAt: Date.now() + 60_000 })).status).toBe(404);
  });

  it.each([
    ['geçmiş zaman', () => Date.now() - 1000],
    ['çok yakın zaman', () => Date.now() + 1000],
    ['30 günden öte', () => Date.now() + 31 * 24 * 60 * 60_000],
    ['kesirli değer', () => Date.now() + 60_000.5],
    ['sayı olmayan', () => 'yarın' as unknown as number],
  ])('%s reddedilir', async (_label, at) => {
    const res = await put({ remindAt: at() });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reminder must be between 5 seconds and 30 days from now');
    expect(repos.SavedMessages.setReminder).not.toHaveBeenCalled();
  });

  it('geçerli hatırlatıcı yazılır', async () => {
    const remindAt = Date.now() + 3_600_000;

    const res = await put({ remindAt });

    expect(res.body).toEqual({ reminder: { remindAt, remindedAt: null } });
    expect(repos.SavedMessages.setReminder).toHaveBeenCalledWith('user-1', 'saved-1', remindAt);
  });

  it('YARIŞTA öğe değiştiyse 409 verir', async () => {
    repos.SavedMessages.setReminder.mockResolvedValue({ updated: 0 });
    expect((await put({ remindAt: Date.now() + 3_600_000 })).status).toBe(409);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /saved/:id', () => {
  it('silme KULLANICIYA bağlıdır ve gövdesiz 204 döner', async () => {
    const res = await request(app).delete('/api/saved/saved-1');

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(repos.SavedMessages.removeForUser).toHaveBeenCalledWith('user-1', 'saved-1');
  });
});
