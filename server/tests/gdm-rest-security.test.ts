// server/tests/gdm-rest-security.test.ts
// Faz 10.6A — Group DM REST BOLA/IDOR matrisi.
//
// Mevcut groupDm.test.ts yalnız `GET /:gid` (403) ve `DELETE /:gid` (non-owner)
// vakalarını kapsıyordu. Bu dosya kalan özel uçlar için üye olmayan erişimini
// kilitler: geçmiş, gönderim, yeniden adlandırma, üye ekleme/çıkarma.
//
// İlke: istemci arayüzünün kontrolü gizlemesi YETKİLENDİRME DEĞİLDİR.
// Kimlik daima authMiddleware'in doğruladığı kullanıcıdır.

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/rateLimit', () => ({
  limits: { messages: () => (_req: unknown, _res: unknown, next: () => void) => next(), dm: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));
jest.mock('../routes/auth', () => ({
  sanitizeUser: (u: Record<string, unknown>) => ({ _id: u._id, username: u.username, displayName: u.displayName }),
  router: { use: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db  = require('../db/loader');
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import gdmRouter from '../routes/groupDm';
import { requireDoc } from './helpers/mockDb';

function buildApp() {
  const app = express();
  app.set('io', null);
  app.use(express.json());
  app.use('/api/gdm', authMiddleware, gdmRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

let app: express.Express;
let memberId: string, strangerId: string, gid: string;
let memberTok: string, strangerTok: string;

beforeEach(async () => {
  db._reset?.();
  app = buildApp();
  memberId = uuidv4(); strangerId = uuidv4();
  memberTok = tok(memberId); strangerTok = tok(strangerId);

  await db.users.insert({ _id: memberId,   username: 'uye',     displayName: 'Uye',     tokenVersion: 0 });
  await db.users.insert({ _id: strangerId, username: 'yabanci', displayName: 'Yabanci', tokenVersion: 0 });

  gid = uuidv4();
  await db.groupDmConversations.insert({ _id: gid, name: 'Ozel Grup', createdBy: memberId, ownerId: memberId, createdAt: 1, lastMessageAt: 1 });
  await db.groupDmMembers.insert({ _id: uuidv4(), groupId: gid, userId: memberId, joinedAt: 1 });
  await db.groupDmMessages.insert({ _id: 'gm1', groupId: gid, userId: memberId, content: 'gizli mesaj', createdAt: 1000 });
});

/** Üye olmayanın erişimi güvenle reddedilmeli: 403/404, asla 200 veya 500. */
function expectDenied(status: number): void {
  expect([403, 404]).toContain(status);
}

describe('Group DM REST — üye olmayan erişimi (BOLA)', () => {
  it('ÜYE geçmişi okuyabilir (pozitif kontrol)', async () => {
    const res = await request(app).get(`/api/gdm/${gid}/messages`).set('Authorization', `Bearer ${memberTok}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('üye olmayan GEÇMİŞİ okuyamaz', async () => {
    const res = await request(app).get(`/api/gdm/${gid}/messages`).set('Authorization', `Bearer ${strangerTok}`);

    expectDenied(res.status);
    expect(JSON.stringify(res.body)).not.toContain('gizli mesaj');
  });

  it('üye olmayan MESAJ GÖNDEREMEZ', async () => {
    const res = await request(app).post(`/api/gdm/${gid}/messages`)
      .set('Authorization', `Bearer ${strangerTok}`).send({ content: 'sizinti' });

    expectDenied(res.status);
    const stored = await db.groupDmMessages.find({ groupId: gid });
    expect(stored).toHaveLength(1);   // yeni mesaj yazılmadı
  });

  it('üye olmayan grubu YENİDEN ADLANDIRAMAZ', async () => {
    const res = await request(app).patch(`/api/gdm/${gid}`)
      .set('Authorization', `Bearer ${strangerTok}`).send({ name: 'ele gecirildi' });

    expectDenied(res.status);
    const group = await db.groupDmConversations.findOne({ _id: gid });
    expect(group.name).toBe('Ozel Grup');
  });

  it('üye olmayan ÜYE EKLEYEMEZ', async () => {
    const res = await request(app).post(`/api/gdm/${gid}/members`)
      .set('Authorization', `Bearer ${strangerTok}`).send({ userId: strangerId });

    expectDenied(res.status);
    const members = await db.groupDmMembers.find({ groupId: gid });
    expect(members).toHaveLength(1);
  });

  it('üye olmayan ÜYE ÇIKARAMAZ', async () => {
    const res = await request(app).delete(`/api/gdm/${gid}/members/${memberId}`)
      .set('Authorization', `Bearer ${strangerTok}`);

    expectDenied(res.status);
    const members = await db.groupDmMembers.find({ groupId: gid });
    expect(members).toHaveLength(1);   // üye hâlâ grupta
  });

  it('üye olmayan grubu SİLEMEZ', async () => {
    const res = await request(app).delete(`/api/gdm/${gid}`).set('Authorization', `Bearer ${strangerTok}`);

    expectDenied(res.status);
    expect(await db.groupDmConversations.findOne({ _id: gid })).toBeTruthy();
  });

  it('üye olmayan grubu LİSTESİNDE GÖRMEZ', async () => {
    const res = await request(app).get('/api/gdm').set('Authorization', `Bearer ${strangerTok}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(gid);
  });
});

describe('Group DM REST — bozuk / var olmayan kimlikler', () => {
  it('var olmayan grup güvenle reddedilir (500 DEĞİL)', async () => {
    const res = await request(app).get(`/api/gdm/${uuidv4()}/messages`).set('Authorization', `Bearer ${memberTok}`);

    expect(res.status).toBe(404);
  });

  it('bozuk grup kimliği güvenle reddedilir (500 DEĞİL)', async () => {
    for (const bad of ['../etc', '%00', 'x'.repeat(300), 'null']) {
      const res = await request(app).get(`/api/gdm/${encodeURIComponent(bad)}/messages`)
        .set('Authorization', `Bearer ${memberTok}`);

      expect(res.status).toBeLessThan(500);
    }
  });

  it('kimliksiz istek reddedilir', async () => {
    const res = await request(app).get(`/api/gdm/${gid}/messages`);

    expect(res.status).toBe(401);
  });
});

describe('Group DM REST — gruplar arası izolasyon', () => {
  it('B grubundaki üyelik A grubuna erişim VERMEZ', async () => {
    const otherGid = uuidv4();
    await db.groupDmConversations.insert({ _id: otherGid, name: 'B', createdBy: strangerId, ownerId: strangerId, createdAt: 1, lastMessageAt: 1 });
    await db.groupDmMembers.insert({ _id: uuidv4(), groupId: otherGid, userId: strangerId, joinedAt: 1 });

    const res = await request(app).get(`/api/gdm/${gid}/messages`).set('Authorization', `Bearer ${strangerTok}`);

    expectDenied(res.status);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ C4 — SOKET ODASI ÜYELİĞİ VERİTABANI ÜYELİĞİNİ TAKİP ETMELİ
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN GERÇEK AÇIK ──────────────────────────────────────────────────
// Soket, bağlanırken kullanıcının tüm gruplarına katılır
// (socket/handlers/dm.ts:400). Üye gruptan ÇIKARILDIĞINDA yalnız veritabanı
// satırı siliniyor, `gdm:<groupId>` ODASINDAN çıkarılmıyordu. Çıkarılan
// kullanıcı mesaj gönderemese ve REST geçmişini okuyamasa bile
//     io.to(`gdm:${groupId}`).emit('gdm:message', ...)
// yayınlarını CANLI almaya devam ediyordu. İstemciye giden `gdm:deleted`
// yalnız arayüzü gizler — bu güvenlik değildir.
describe('C4 — GÜVENLİK: çıkarılan üye soket odasında KALMAZ', () => {
  /** socketsLeave/socketsJoin çağrılarını kaydeden io taklidi. */
  function mockIo() {
    const left: Array<{ from: string; room: string }>   = [];
    const joined: Array<{ from: string; room: string }> = [];
    const emitted: Array<{ to: string; event: string }> = [];
    const io = {
      to: (r: string) => ({ emit: (event: string) => { emitted.push({ to: r, event }); } }),
      in: (r: string) => ({
        socketsLeave: (room: string) => { left.push({ from: r, room }); },
        socketsJoin:  (room: string) => { joined.push({ from: r, room }); },
      }),
    };
    return { io, left, joined, emitted };
  }

  let otherId: string, otherTok: string;

  beforeEach(async () => {
    otherId  = uuidv4();
    otherTok = tok(otherId);
    await db.users.insert({ _id: otherId, username: 'diger', displayName: 'Diger', tokenVersion: 0 });
    await db.groupDmMembers.insert({ _id: uuidv4(), groupId: gid, userId: otherId, joinedAt: 1 });
  });

  it('GÜVENLİK: sahip bir üyeyi çıkarınca o üye grup odasından ÇIKARILIR', async () => {
    const { io, left } = mockIo();
    app.set('io', io);

    const res = await request(app)
      .delete(`/api/gdm/${gid}/members/${otherId}`)
      .set('Authorization', `Bearer ${memberTok}`);

    expect(res.status).toBe(200);
    expect(left).toContainEqual({ from: `user:${otherId}`, room: `gdm:${gid}` });
    expect(left).toContainEqual({ from: `user:${otherId}`, room: `gdm:voice:${gid}` });
  });

  it('GÜVENLİK: odadan çıkarma, bilgilendirme yayınından ÖNCE yapılır', async () => {
    // Sıra yanlışsa aradaki bir mesaj çıkarılan üyeye ulaşabilirdi.
    const order: string[] = [];
    const io = {
      to: (r: string) => ({ emit: () => { order.push(`emit:${r}`); } }),
      in: (r: string) => ({
        socketsLeave: (room: string) => { order.push(`leave:${r}:${room}`); },
        socketsJoin:  () => {},
      }),
    };
    app.set('io', io);

    await request(app)
      .delete(`/api/gdm/${gid}/members/${otherId}`)
      .set('Authorization', `Bearer ${memberTok}`);

    const leaveIdx = order.findIndex(o => o.startsWith(`leave:user:${otherId}`));
    const emitIdx  = order.findIndex(o => o === `emit:user:${otherId}`);
    expect(leaveIdx).toBeGreaterThanOrEqual(0);
    expect(emitIdx).toBeGreaterThanOrEqual(0);
    expect(leaveIdx).toBeLessThan(emitIdx);
  });

  it('kendi isteğiyle AYRILAN üye de odadan çıkarılır', async () => {
    const { io, left } = mockIo();
    app.set('io', io);

    const res = await request(app)
      .delete(`/api/gdm/${gid}/members/${otherId}`)
      .set('Authorization', `Bearer ${otherTok}`);        // isSelf

    expect(res.status).toBe(200);
    expect(left).toContainEqual({ from: `user:${otherId}`, room: `gdm:${gid}` });
  });

  it('GÜVENLİK: çıkarma REDDEDİLİRSE oda üyeliği DEĞİŞTİRİLMEZ', async () => {
    const { io, left } = mockIo();
    app.set('io', io);

    // Yabancı, başkasını çıkarmayı dener → reddedilir.
    const res = await request(app)
      .delete(`/api/gdm/${gid}/members/${otherId}`)
      .set('Authorization', `Bearer ${strangerTok}`);

    expectDenied(res.status);
    expect(left).toHaveLength(0);
  });

  it('yeni eklenen üye odaya ALINIR (yeniden bağlanmayı beklemez)', async () => {
    const { io, joined } = mockIo();
    app.set('io', io);
    const yeniId = uuidv4();
    await db.users.insert({ _id: yeniId, username: 'yeni', displayName: 'Yeni', tokenVersion: 0 });

    const res = await request(app)
      .post(`/api/gdm/${gid}/members`)
      .set('Authorization', `Bearer ${memberTok}`)
      .send({ userId: yeniId });

    expect(res.status).toBe(200);
    expect(joined).toContainEqual({ from: `user:${yeniId}`, room: `gdm:${gid}` });
  });

  it('io yoksa rota ÇÖKMEZ (soket katmanı isteğe bağlıdır)', async () => {
    app.set('io', null);

    const res = await request(app)
      .delete(`/api/gdm/${gid}/members/${otherId}`)
      .set('Authorization', `Bearer ${memberTok}`);

    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ C4.1 — ÇAPRAZ GDM MESAJ KİMLİĞİ İZOLASYONU
// ════════════════════════════════════════════════════════════════════════════
//
// GDM mesaj yüzeyi YALNIZCA oluşturma + okumadır. Düzenleme, silme, tepki,
// yanıt ve sabitleme uçları YOKTUR (routes/groupDm.ts ve socket şemaları
// mesaj kimliği kabul etmez). Bu yüzden "yabancı mesaj kimliğiyle mutasyon"
// saldırı yüzeyi BULUNMAMAKTADIR — bu yetenekler ABSENT'tir ve uydurulmaz.
//
// Tek mesaj-kimliği GİRDİSİ sayfalama imlecidir (`beforeId`). Bu imleç
// yabancı bir mesaj kimliğiyle beslenebilir; sorgu DAİMA `groupId` ile
// kapsandığı ve `beforeId` yalnız sıralama ayırıcısı olarak kullanıldığı için
// yabancı mesaj DEREFERANS EDİLMEZ. Aşağıdaki testler bunu kilitler.
describe('C4.1 — GÜVENLİK: yabancı mesaj kimliği imleç olarak sızıntı yapmaz', () => {
  let otherGid: string;

  beforeEach(async () => {
    // Aynı kullanıcının üye OLDUĞU ikinci bir grup: saldırgan buradan meşru
    // biçimde bir mesaj kimliği elde edip A grubuna sokmayı dener.
    otherGid = uuidv4();
    await db.groupDmConversations.insert({ _id: otherGid, name: 'Ikinci Grup', createdBy: memberId, ownerId: memberId, createdAt: 1, lastMessageAt: 1 });
    await db.groupDmMembers.insert({ _id: uuidv4(), groupId: otherGid, userId: memberId, joinedAt: 1 });
    await db.groupDmMessages.insert({ _id: 'gm-diger', groupId: otherGid, userId: memberId, content: 'DIGER GRUBUN GIZLI MESAJI', createdAt: 1000 });
  });

  it('GÜVENLİK: yabancı beforeId imleci BAŞKA grubun mesajını DÖNDÜRMEZ', async () => {
    const res = await request(app)
      .get(`/api/gdm/${gid}/messages?before=2000&beforeId=gm-diger`)
      .set('Authorization', `Bearer ${memberTok}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ _id: string }>).map(m => m._id);
    expect(ids).not.toContain('gm-diger');
    expect(JSON.stringify(res.body)).not.toContain('DIGER GRUBUN GIZLI MESAJI');
  });

  it('GÜVENLİK: sonuçların tamamı YALNIZCA istenen gruba aittir', async () => {
    const res = await request(app)
      .get(`/api/gdm/${gid}/messages?before=2000&beforeId=gm-diger`)
      .set('Authorization', `Bearer ${memberTok}`);

    for (const m of res.body as Array<{ groupId: string }>) {
      expect(m.groupId).toBe(gid);
    }
  });

  it('uydurma/bozuk beforeId güvenle ele alınır (500 DEĞİL)', async () => {
    const res = await request(app)
      .get(`/api/gdm/${gid}/messages?before=2000&beforeId=${'x'.repeat(200)}`)
      .set('Authorization', `Bearer ${memberTok}`);

    expect(res.status).toBe(200);
  });

  it('üye olmayan, yabancı imleçle de geçmişe ERİŞEMEZ', async () => {
    const res = await request(app)
      .get(`/api/gdm/${gid}/messages?before=2000&beforeId=gm-diger`)
      .set('Authorization', `Bearer ${strangerTok}`);

    expectDenied(res.status);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ C4.5 — ÜYELİK MUTASYONU YETKİLENDİRMESİ
// ════════════════════════════════════════════════════════════════════════════
describe('C4.5 — GÜVENLİK: üyelik mutasyonu arka uç yetkisine bağlıdır', () => {
  let ucuncuId: string, ucuncuTok: string;
  let sahipsizId: string;

  beforeEach(async () => {
    // `memberId` grubun SAHİBİdir (ownerId). `ucuncu` sıradan bir üyedir.
    ucuncuId  = uuidv4();
    ucuncuTok = tok(ucuncuId);
    await db.users.insert({ _id: ucuncuId, username: 'ucuncu', displayName: 'Ucuncu', tokenVersion: 0 });
    await db.groupDmMembers.insert({ _id: uuidv4(), groupId: gid, userId: ucuncuId, joinedAt: 1 });

    sahipsizId = uuidv4();
    await db.users.insert({ _id: sahipsizId, username: 'dorduncu', displayName: 'Dorduncu', tokenVersion: 0 });
    await db.groupDmMembers.insert({ _id: uuidv4(), groupId: gid, userId: sahipsizId, joinedAt: 1 });
  });

  it('GÜVENLİK: sıradan üye BAŞKA bir üyeyi çıkaramaz', async () => {
    const res = await request(app)
      .delete(`/api/gdm/${gid}/members/${sahipsizId}`)
      .set('Authorization', `Bearer ${ucuncuTok}`);

    expect(res.status).toBe(403);
    expect(await db.groupDmMembers.findOne({ groupId: gid, userId: sahipsizId })).not.toBeNull();
  });

  it('sıradan üye KENDİSİ ayrılabilir (self-leave)', async () => {
    const res = await request(app)
      .delete(`/api/gdm/${gid}/members/${ucuncuId}`)
      .set('Authorization', `Bearer ${ucuncuTok}`);

    expect(res.status).toBe(200);
    expect(await db.groupDmMembers.findOne({ groupId: gid, userId: ucuncuId })).toBeNull();
  });

  it('GÜVENLİK: sıradan üye ÜYE EKLEYEMEZ (sahip-only)', async () => {
    const yeniId = uuidv4();
    await db.users.insert({ _id: yeniId, username: 'yeni', displayName: 'Yeni', tokenVersion: 0 });

    const res = await request(app)
      .post(`/api/gdm/${gid}/members`)
      .set('Authorization', `Bearer ${ucuncuTok}`)
      .send({ userId: yeniId });

    expect(res.status).toBe(403);
    expect(await db.groupDmMembers.findOne({ groupId: gid, userId: yeniId })).toBeNull();
  });

  it('GÜVENLİK: sahip bile SAHİBİ çıkaramaz (kendisi hariç)', async () => {
    // Sahip başkasının isteğiyle değil; burada üçüncü kişi sahibi çıkarmayı dener.
    const res = await request(app)
      .delete(`/api/gdm/${gid}/members/${memberId}`)
      .set('Authorization', `Bearer ${ucuncuTok}`);

    expect(res.status).toBe(403);
    expect(await db.groupDmMembers.findOne({ groupId: gid, userId: memberId })).not.toBeNull();
  });

  it('GÜVENLİK: ÇIKARILAN üye hemen ardından üyelik mutasyonu yapamaz', async () => {
    await request(app)
      .delete(`/api/gdm/${gid}/members/${ucuncuId}`)
      .set('Authorization', `Bearer ${memberTok}`)
      .expect(200);

    const yeniId = uuidv4();
    await db.users.insert({ _id: yeniId, username: 'y2', displayName: 'Y2', tokenVersion: 0 });

    const res = await request(app)
      .post(`/api/gdm/${gid}/members`)
      .set('Authorization', `Bearer ${ucuncuTok}`)
      .send({ userId: yeniId });

    expectDenied(res.status);
  });

  it('GÜVENLİK: var olmayan kullanıcı eklenemez (uydurma kimlik)', async () => {
    const res = await request(app)
      .post(`/api/gdm/${gid}/members`)
      .set('Authorization', `Bearer ${memberTok}`)
      .send({ userId: uuidv4() });

    expect(res.status).toBe(404);
  });

  it('GÜVENLİK: BAŞKA gruptaki üyelik bu grubu mutasyona uğratmaya yetmez', async () => {
    // Yabancı, kendi sahibi olduğu ayrı bir grup üzerinden yetki devşiremez.
    const kendiGid = uuidv4();
    await db.groupDmConversations.insert({ _id: kendiGid, name: 'Yabancinin Grubu', createdBy: strangerId, ownerId: strangerId, createdAt: 1 });
    await db.groupDmMembers.insert({ _id: uuidv4(), groupId: kendiGid, userId: strangerId, joinedAt: 1 });

    const res = await request(app)
      .delete(`/api/gdm/${gid}/members/${ucuncuId}`)
      .set('Authorization', `Bearer ${strangerTok}`);

    expectDenied(res.status);
    expect(await db.groupDmMembers.findOne({ groupId: gid, userId: ucuncuId })).not.toBeNull();
  });
});
