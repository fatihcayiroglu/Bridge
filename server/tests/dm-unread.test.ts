// server/tests/dm-unread.test.ts
// Faz 10.3 — DM okunmamış sayacı (türetilmiş) sözleşmesi.
//
// GERÇEK DmRepository test edilir; yalnız veritabanı katmanı mock'lanır.
// Faz 10.2'de öğrenilen ders: repository mock'lanırsa sorgu semantiği hiç
// sınanmaz ve gerçek hatalar testlerden kaçar.
//
// TÜRETME KAYNAĞI (yeni şema YOK):
//   dmConversations.readAt[userId]  ← dm-read.ts yazar
//   dmMessages.createdAt / .userId

process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

import Dms from '../db/repositories/DmRepository';
import db from '../db/loader';

const DM_A = 'ua_ub';
const DM_B = 'ua_uc';
const ME = 'ua';
const OTHER = 'ub';

let seq = 0;
/** Mesaj ekler. `from` gönderen kullanıcı; `at` createdAt. */
async function msg(dmId: string, from: string, at: number): Promise<void> {
  seq += 1;
  await db.dmMessages.insert({ _id: `m${seq}`, dmId, userId: from, createdAt: at, content: `c${seq}` });
}

beforeEach(async () => {
  seq = 0;
  for (const m of await db.dmMessages.find({})) await db.dmMessages.remove({ _id: m._id });
});

describe('countUnread — temel vakalar', () => {
  it('A: hiç mesaj yoksa 0', async () => {
    expect(await Dms.countUnread(DM_A, ME, 1000)).toBe(0);
  });

  it('B: yalnız kendi mesajların varsa 0 (kendi mesajın okunmamış olmaz)', async () => {
    await msg(DM_A, ME, 2000);
    await msg(DM_A, ME, 3000);

    expect(await Dms.countUnread(DM_A, ME, 1000)).toBe(0);
  });

  it('C: readAt sonrası tek gelen mesaj → 1', async () => {
    await msg(DM_A, OTHER, 2000);

    expect(await Dms.countUnread(DM_A, ME, 1000)).toBe(1);
  });

  it('D: readAt sonrası birden çok gelen mesaj → tam sayı', async () => {
    await msg(DM_A, OTHER, 2000);
    await msg(DM_A, OTHER, 3000);
    await msg(DM_A, OTHER, 4000);

    expect(await Dms.countUnread(DM_A, ME, 1500)).toBe(3);
  });

  it('E: readAt ÖNCESİ gelen mesajlar sayılmaz', async () => {
    await msg(DM_A, OTHER, 1000);
    await msg(DM_A, OTHER, 2000);

    expect(await Dms.countUnread(DM_A, ME, 5000)).toBe(0);
  });

  it('F: karışık (kendi + gelen) → yalnız gelen sayılır', async () => {
    await msg(DM_A, OTHER, 2000);
    await msg(DM_A, ME,    2500);
    await msg(DM_A, OTHER, 3000);
    await msg(DM_A, ME,    3500);

    expect(await Dms.countUnread(DM_A, ME, 1000)).toBe(2);
  });

  it('I: readAt yoksa gelen mesajların TAMAMI sayılır', async () => {
    await msg(DM_A, OTHER, 1000);
    await msg(DM_A, OTHER, 2000);
    await msg(DM_A, ME,    2500);

    expect(await Dms.countUnread(DM_A, ME, undefined)).toBe(2);
  });
});

describe('countUnread — izolasyon', () => {
  it('G: konuşma A\'nın okunmamışı konuşma B\'yi etkilemez', async () => {
    await msg(DM_A, OTHER, 2000);
    await msg(DM_A, OTHER, 3000);
    await msg(DM_B, 'uc',  2000);

    expect(await Dms.countUnread(DM_A, ME, 1000)).toBe(2);
    expect(await Dms.countUnread(DM_B, ME, 1000)).toBe(1);
  });

  it('H: kullanıcı A ve B sayıları BAĞIMSIZ (kendi mesajı hariç tutma yönü)', async () => {
    await msg(DM_A, ME,    2000);   // ME gönderdi
    await msg(DM_A, OTHER, 3000);   // OTHER gönderdi

    // ME için: yalnız OTHER'ın mesajı okunmamış
    expect(await Dms.countUnread(DM_A, ME, 1000)).toBe(1);
    // OTHER için: yalnız ME'nin mesajı okunmamış
    expect(await Dms.countUnread(DM_A, OTHER, 1000)).toBe(1);
  });

  it('kullanıcının farklı readAt değerleri farklı sonuç verir (kullanıcı-kapsamlı)', async () => {
    await msg(DM_A, OTHER, 2000);
    await msg(DM_A, OTHER, 4000);

    expect(await Dms.countUnread(DM_A, ME, 1000)).toBe(2);
    expect(await Dms.countUnread(DM_A, ME, 3000)).toBe(1);
    expect(await Dms.countUnread(DM_A, ME, 5000)).toBe(0);
  });
});

describe('countUnread — sınır davranışı', () => {
  it('J: readAt ile AYNI damgalı mesaj okunmuş sayılır ($gt, tekrar saymaz)', async () => {
    await msg(DM_A, OTHER, 3000);   // tam readAt anındaki mesaj
    await msg(DM_A, OTHER, 3001);

    // Okundu imleci o mesajın damgasına eşit → o mesaj okunmuştur.
    expect(await Dms.countUnread(DM_A, ME, 3000)).toBe(1);
  });

  it('J2: aynı damgalı birden çok gelen mesaj deterministik sayılır', async () => {
    await msg(DM_A, OTHER, 3000);
    await msg(DM_A, OTHER, 3000);
    await msg(DM_A, OTHER, 3000);

    expect(await Dms.countUnread(DM_A, ME, 2999)).toBe(3);
    expect(await Dms.countUnread(DM_A, ME, 3000)).toBe(0);
  });

  it('geçersiz girdilerde güvenli 0 döner (çökme yok)', async () => {
    await msg(DM_A, OTHER, 2000);

    expect(await Dms.countUnread('', ME, 1000)).toBe(0);
    expect(await Dms.countUnread(DM_A, '', 1000)).toBe(0);
  });

  it('salt okumadır — sayım hiçbir mesajı/durumu değiştirmez', async () => {
    await msg(DM_A, OTHER, 2000);
    const before = (await db.dmMessages.find({})).length;

    await Dms.countUnread(DM_A, ME, 1000);

    expect((await db.dmMessages.find({})).length).toBe(before);
  });
});
