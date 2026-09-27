// server/tests/group-dm-room-sync-and-fallbacks.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GRUP DM — ODA SENKRONU, SIRALAMA VE EKSİK SATIR YEDEKLERİ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/gdm-route-branches.test.ts` yetki ve doğrulama sınırlarını ölçer. Bu
// tamamlayıcı takım GERÇEK ZAMANLI katmanın ve EKSİK SATIR yedeklerinin
// davranışını ölçer — ikisi de sessizce bozulduğunda kimse fark etmez:
//
//   · ODA SENKRONU. Kalıcı üyelik değişince soket odası da değişmelidir
//     (routes/groupDm.ts:27-41'deki kapatılan açık). Adaptör oda API'sini
//     sunmuyorsa VEYA dağıtımda hiç gerçek zamanlı katman yoksa, istek yine
//     de BAŞARILI olmalı ve kalıcı yazma yapılmalıdır: sunum katmanının
//     eksikliği yetki değişikliğini engellemez.
//   · SIRALAMA. Grup listesi son etkinliğe göre sıralanır; hiç mesajı olmayan
//     bir grup `createdAt`e düşer (127. satır), listeden kaybolmaz.
//   · EKSİK SATIR YEDEKLERİ. Silinmiş bir kullanıcı satırı sistem mesajlarını
//     `undefined grubu oluşturdu` hâline getirmemeli; okunabilir bir yedek
//     kullanılmalıdır.
//   · YARIŞ. Üyelik, yazma isteği uçuştayken iptal edilebilir; anlık görüntü
//     üzerinden geç bir yazmaya izin verilmemelidir (551. satır).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = '12345678901234567890123456789012';
process.env.REFRESH_SECRET = '12345678901234567890123456789012';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../db/postgres/transaction', () => ({
  withTransaction: async (fn: any) => fn({ query: async () => ({ rows: [] }) }),
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    messages: () => (_req: any, _res: any, next: any) => next(),
    dm: () => (_req: any, _res: any, next: any) => next(),
  },
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import db from '../db/loader';
import router from '../routes/groupDm';
import { GroupDms, Users } from '../db/repositories';

const secret = process.env.JWT_SECRET!;
const token = (id: string) => jwt.sign({ id, v: 0 }, secret, { expiresIn: '1h' });
const auth = (r: any, id: string) => r.set('Authorization', `Bearer ${token(id)}`);

function app(io: any = null) {
  const a = express();
  a.set('io', io);
  a.use(express.json());
  a.use('/api/gdm', router);
  return a;
}

/** Bir io ikizi; `in` (oda API'si) küme adaptörlerinde eksik olabilir. */
function ioMock(withRooms = true) {
  const emit = jest.fn();
  const socketsLeave = jest.fn();
  const socketsJoin = jest.fn();
  const io: Record<string, unknown> = { to: jest.fn(() => ({ emit })) };
  if (withRooms) io.in = jest.fn(() => ({ socketsLeave, socketsJoin }));
  return { emit, socketsLeave, socketsJoin, io };
}

async function user(id: string, extra: Record<string, unknown> = {}) {
  await (db as any).users.insert({
    _id: id, username: id, displayName: id, tokenVersion: 0, ...extra,
  });
}
async function group(id = 'g1', owner = 'u1', extra: Record<string, unknown> = {}) {
  await (db as any).groupDmConversations.insert({
    _id: id, name: 'G', ownerId: owner, createdAt: 1, lastMessageAt: 1, ...extra,
  });
}
async function member(g: string, u: string, extra: Record<string, unknown> = {}) {
  await (db as any).groupDmMembers.insert({ _id: `${g}-${u}`, groupId: g, userId: u, joinedAt: 1, ...extra });
}
const systemTexts = async (gid: string) =>
  (await (db as any).groupDmMessages.find({ groupId: gid })).map((m: any) => String(m.content ?? ''));

beforeEach(() => (db as any)._reset());
afterEach(() => jest.restoreAllMocks());

describe('the realtime layer is presentation, never a precondition for the write', () => {
  it('removal pulls the target out of BOTH group rooms before anyone is told', async () => {
    await user('u1'); await user('u2'); await user('u3');
    await group(); await member('g1', 'u1'); await member('g1', 'u2'); await member('g1', 'u3');
    const iom = ioMock();

    const res = await auth(request(app(iom.io)).delete('/api/gdm/g1/members/u2'), 'u1');

    expect(res.status).toBe(200);
    // Metin VE ses odaları: yalnızca metin odasından çıkarmak, çıkarılan üyeyi
    // grup sesli görüşmesinde bırakırdı.
    expect(iom.socketsLeave).toHaveBeenCalledWith('gdm:g1');
    expect(iom.socketsLeave).toHaveBeenCalledWith('gdm:voice:g1');
    expect(iom.emit).toHaveBeenCalledWith('gdm:member:leave',
      expect.objectContaining({ groupId: 'g1', userId: 'u2' }));
  });

  it('an adapter without a room API does not fail or skip the removal', async () => {
    await user('u1'); await user('u2');
    await group(); await member('g1', 'u1'); await member('g1', 'u2');
    const iom = ioMock(false);

    const res = await auth(request(app(iom.io)).delete('/api/gdm/g1/members/u2'), 'u1');

    expect(res.status).toBe(200);
    expect(iom.socketsLeave).not.toHaveBeenCalled();
    expect(await (db as any).groupDmMembers.findOne({ groupId: 'g1', userId: 'u2' })).toBeNull();
    // Kalan üyeler yine haberdar edilir.
    expect(iom.emit).toHaveBeenCalledWith('gdm:member:leave', expect.objectContaining({ userId: 'u2' }));
  });

  it('the last member leaving with a live io deletes the group and tells only them', async () => {
    await user('u1');
    await group(); await member('g1', 'u1');
    const iom = ioMock();

    const res = await auth(request(app(iom.io)).delete('/api/gdm/g1/members/u1'), 'u1');

    expect(res.status).toBe(200);
    expect(await (db as any).groupDmConversations.findOne({ _id: 'g1' })).toBeNull();
    expect(iom.emit).toHaveBeenCalledWith('gdm:deleted', { groupId: 'g1' });
    // Kimse kalmadı: "üye ayrıldı" yayını yapılmamalı.
    expect(iom.emit).not.toHaveBeenCalledWith('gdm:member:leave', expect.anything());
  });

  it('creation without any realtime layer still returns the created group', async () => {
    await user('u1'); await user('u2');
    const res = await auth(request(app(null)).post('/api/gdm').send({ name: 'G', memberIds: ['u2'] }), 'u1');
    expect(res.status).toBe(201);
    expect(res.body.memberCount).toBe(2);
  });

  it('patch without any realtime layer still persists the rename', async () => {
    await user('u1'); await group(); await member('g1', 'u1');
    const res = await auth(request(app(null)).patch('/api/gdm/g1').send({ name: 'Renamed' }), 'u1');
    expect(res.status).toBe(200);
    expect((await (db as any).groupDmConversations.findOne({ _id: 'g1' })).name).toBe('Renamed');
  });

  it('adding a member without any realtime layer still adds them', async () => {
    await user('u1'); await user('u2');
    await group(); await member('g1', 'u1');
    const res = await auth(request(app(null)).post('/api/gdm/g1/members').send({ userId: 'u2' }), 'u1');
    expect(res.status).toBe(200);
    expect(await (db as any).groupDmMembers.findOne({ groupId: 'g1', userId: 'u2' })).toBeTruthy();
  });

  it('membership routes on an unknown group are 404, never a 500 from a null group', async () => {
    await user('u1');
    expect((await auth(request(app()).post('/api/gdm/nope/members').send({ userId: 'u1' }), 'u1')).status).toBe(404);
    expect((await auth(request(app()).delete('/api/gdm/nope/members/u1'), 'u1')).status).toBe(404);
  });
});

describe('creation shapes the row handed to the atomic writer', () => {
  // `createAtomic` HAM SQL kullanır (repository'de gerekçesi belgeli: havuzdan
  // kendi bağlantısını alan repository çağrıları transaction'a katılmaz). Bu
  // yüzden mockDb üzerinden gözlemlenemez. Onun yerine yazıcıya VERİLEN satırı
  // yakalar ve belgelenen değişmezi — üç yazmanın birlikte olması — taklit
  // ederiz; ölçtüğümüz şey rotanın ürettiği satırdır.
  function captureCreate(): Array<Record<string, any>> {
    const calls: Array<Record<string, any>> = [];
    jest.spyOn(GroupDms, 'createAtomic').mockImplementation(async (input: any) => {
      calls.push(input);
      await (db as any).groupDmConversations.insert({ ...input.group });
      for (const uid of input.memberIds) await member(input.group._id, uid);
      await (db as any).groupDmMessages.insert({ ...input.systemMessage, groupId: input.group._id });
      return input.group;
    });
    return calls;
  }

  it('an icon is bounded to four code units', async () => {
    await user('u1'); await user('u2');
    const calls = captureCreate();
    const res = await auth(request(app()).post('/api/gdm')
      .send({ name: 'G', memberIds: ['u2'], icon: 'abcdefgh' }), 'u1');
    expect(res.status).toBe(201);
    expect(calls[0]!.group.icon).toBe('abcd');
  });

  it('a blank icon is written as absent rather than as an empty string', async () => {
    await user('u1'); await user('u2');
    const calls = captureCreate();
    const res = await auth(request(app()).post('/api/gdm')
      .send({ name: 'G', memberIds: ['u2'], icon: '' }), 'u1');
    expect(res.status).toBe(201);
    // Boş dize NOT NULL bir "ikon var" hâli üretirdi; istemci boş kutu çizer.
    expect(calls[0]!.group.icon).toBeNull();
  });

  it('omitting the icon entirely also writes absent', async () => {
    await user('u1'); await user('u2');
    const calls = captureCreate();
    const res = await auth(request(app()).post('/api/gdm').send({ name: 'G', memberIds: ['u2'] }), 'u1');
    expect(res.status).toBe(201);
    expect(calls[0]!.group.icon).toBeNull();
  });

  it('the name is trimmed and bounded to 64 characters', async () => {
    await user('u1'); await user('u2');
    const calls = captureCreate();
    const res = await auth(request(app()).post('/api/gdm')
      .send({ name: `  ${'n'.repeat(100)}  `, memberIds: ['u2'] }), 'u1');
    expect(res.status).toBe(201);
    expect(calls[0]!.group.name).toBe('n'.repeat(64));
  });

  it('a member id that does not exist is named in the refusal', async () => {
    await user('u1');
    const res = await auth(request(app()).post('/api/gdm')
      .send({ name: 'G', memberIds: ['ghost'] }), 'u1');
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toContain('ghost');
  });

  it('an omitted member list is read as empty and refused for being too small', async () => {
    await user('u1');
    const res = await auth(request(app()).post('/api/gdm').send({ name: 'G' }), 'u1');
    // Yalnızca oluşturan kalır -> 2 üye şartı sağlanmaz. `?? []` yedeği burada
    // TypeError yerine anlaşılır bir 400 üretmelidir.
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('2');
  });

  it('the creation system message names the creator', async () => {
    await user('u1', { displayName: 'Ada' }); await user('u2');
    const calls = captureCreate();
    const res = await auth(request(app()).post('/api/gdm').send({ name: 'G', memberIds: ['u2'] }), 'u1');
    expect(res.status).toBe(201);
    expect(String(calls[0]!.systemMessage.content)).toContain('Ada grubu oluşturdu');
  });

  it('the creation system message falls back when the creator profile cannot be read', async () => {
    await user('u1', { displayName: 'Ada' }); await user('u2');
    // Katılımcı doğrulaması `findByIds` ile yapılır; profil okuması AYRI bir
    // çağrıdır ve replika gecikmesinde boş dönebilir. Mesaj yine yazılmalıdır.
    jest.spyOn(Users, 'findById').mockResolvedValue(null as any);
    const calls = captureCreate();
    const res = await auth(request(app()).post('/api/gdm').send({ name: 'G', memberIds: ['u2'] }), 'u1');
    expect(res.status).toBe(201);
    expect(String(calls[0]!.systemMessage.content)).toContain('Biri grubu oluşturdu');
  });

  it('a rolled-back transaction reports failure instead of a half-made group', async () => {
    await user('u1'); await user('u2');
    jest.spyOn(GroupDms, 'createAtomic').mockRejectedValue(new Error('deadlock detected'));
    const res = await auth(request(app()).post('/api/gdm').send({ name: 'G', memberIds: ['u2'] }), 'u1');
    // Yeniden deneme güvenli olmalı: hiçbir yetim satır kalmamalı.
    expect(res.status).toBe(500);
    expect(await (db as any).groupDmConversations.count({})).toBe(0);
    expect(await (db as any).groupDmMembers.count({})).toBe(0);
  });

  it('a presentation failure after commit still reports success with a minimal payload', async () => {
    await user('u1'); await user('u2');
    captureCreate();
    // Zenginleştirme yalnızca OKUMADIR. Commit sonrası patlarsa 500 dönmek
    // kullanıcıyı tekrar denemeye iter ve İKİNCİ bir grup oluşur.
    const canonical = Users.findByIds.bind(Users);
    let lookups = 0;
    jest.spyOn(Users, 'findByIds').mockImplementation(async (ids: any) => {
      lookups += 1;
      // 1. çağrı katılımcı DOĞRULAMASIDIR (commit öncesi, başarılı olmalı);
      // 2. çağrı zenginleştirmedir (commit SONRASI, burada patlatıyoruz).
      if (lookups === 1) return canonical(ids);
      throw new Error('replica unavailable');
    });
    const res = await auth(request(app()).post('/api/gdm').send({ name: 'G', memberIds: ['u2'] }), 'u1');
    expect(res.status).toBe(201);
    expect(res.body.memberCount).toBe(2);
    expect(res.body.members).toEqual([]);
  });
});

describe('system messages name whoever they can', () => {
  it('an add names both the actor and the new member', async () => {
    await user('u1', { displayName: 'Ada' }); await user('u2', { displayName: 'Bob' });
    await group(); await member('g1', 'u1');

    expect((await auth(request(app()).post('/api/gdm/g1/members').send({ userId: 'u2' }), 'u1')).status).toBe(200);

    const texts = await systemTexts('g1');
    expect(texts).toContainEqual(expect.stringContaining('Ada'));
    expect(texts).toContainEqual(expect.stringContaining('Bob'));
  });

  it('an add falls back when the actor row is gone', async () => {
    await user('u1'); await user('u2', { displayName: 'Bob' });
    await group(); await member('g1', 'u1');
    // Üyelik satırı hâlâ duruyor ama profil silinmiş: yetki üyelikten gelir,
    // isim profilden. Yetki kaybolmadığı için işlem sürmeli.
    await (db as any).users.remove({ _id: 'u1' });

    const res = await auth(request(app()).post('/api/gdm/g1/members').send({ userId: 'u2' }), 'u1');

    expect(res.status).toBe(200);
    expect(await systemTexts('g1')).toContainEqual(expect.stringContaining('Biri Bob'));
  });

  it('a removal and a self-leave are worded differently', async () => {
    await user('u1', { displayName: 'Ada' }); await user('u2', { displayName: 'Bob' });
    await user('u3', { displayName: 'Cem' });
    await group(); await member('g1', 'u1'); await member('g1', 'u2'); await member('g1', 'u3');

    await auth(request(app()).delete('/api/gdm/g1/members/u2'), 'u1');
    await auth(request(app()).delete('/api/gdm/g1/members/u3'), 'u3');

    const texts = await systemTexts('g1');
    expect(texts).toContainEqual('Bob gruptan çıkarıldı');
    expect(texts).toContainEqual('Cem gruptan ayrıldı');
  });

  it('both wordings fall back when the departing profile is gone', async () => {
    await user('u1'); await user('u2'); await user('u3');
    await group(); await member('g1', 'u1'); await member('g1', 'u2'); await member('g1', 'u3');
    await (db as any).users.remove({ _id: 'u2' });
    await (db as any).users.remove({ _id: 'u3' });

    await auth(request(app()).delete('/api/gdm/g1/members/u2'), 'u1');
    await auth(request(app()).delete('/api/gdm/g1/members/u3'), 'u3');

    const texts = await systemTexts('g1');
    expect(texts).toContainEqual('Biri gruptan çıkarıldı');
    expect(texts).toContainEqual('Biri gruptan ayrıldı');
  });
});

describe('the group list orders by real activity', () => {
  it('a group that has never been used sorts by its creation time, not out of the list', async () => {
    await user('u1');
    await group('quiet', 'u1', { createdAt: 100, lastMessageAt: 0 });
    await group('chatty', 'u1', { createdAt: 1, lastMessageAt: 50 });
    await member('quiet', 'u1'); await member('chatty', 'u1');

    const res = await auth(request(app()).get('/api/gdm'), 'u1');

    expect(res.status).toBe(200);
    expect(res.body.map((g: any) => g._id)).toEqual(['quiet', 'chatty']);
  });

  it('a member whose profile is gone is omitted instead of rendered as a hole', async () => {
    await user('u1'); await user('u2');
    await group(); await member('g1', 'u1'); await member('g1', 'u2');
    await (db as any).users.remove({ _id: 'u2' });

    const res = await auth(request(app()).get('/api/gdm/g1'), 'u1');

    expect(res.status).toBe(200);
    expect(res.body.members.map((u: any) => u._id)).toEqual(['u1']);
    expect(res.body.memberCount).toBe(1);
  });
});

describe('a message send cannot outlive the membership that authorized it', () => {
  it('a removal that lands mid-request refuses the write and stores nothing', async () => {
    await user('u1'); await user('u2');
    await group(); await member('g1', 'u1'); await member('g1', 'u2');
    const canonical = GroupDms.findMember.bind(GroupDms);
    let checks = 0;
    jest.spyOn(GroupDms, 'findMember').mockImplementation(async (gid: any, uid: any) => {
      checks += 1;
      if (checks === 1) return canonical(gid, uid);
      return null;
    });

    const res = await auth(request(app()).post('/api/gdm/g1/messages').send({ content: 'late' }), 'u1');

    expect(res.status).toBe(403);
    expect(await (db as any).groupDmMessages.count({ groupId: 'g1' })).toBe(0);
  });

  it('a sender whose profile is gone still gets a readable author, not "undefined"', async () => {
    await user('u1'); await group(); await member('g1', 'u1');
    await (db as any).users.remove({ _id: 'u1' });

    const res = await auth(request(app()).post('/api/gdm/g1/messages').send({ content: 'hi' }), 'u1');

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe('User');
    expect(res.body.avatarColor).toBe('#2d9cdb');
  });

  it('a sender with no avatar colour gets the default rather than a null colour', async () => {
    await user('u1', { displayName: 'Ada', avatarColor: '' });
    await group(); await member('g1', 'u1');

    const res = await auth(request(app()).post('/api/gdm/g1/messages').send({ content: 'hi' }), 'u1');

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe('Ada');
    expect(res.body.avatarColor).toBe('#2d9cdb');
  });
});
