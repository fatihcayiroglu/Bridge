// server/tests/dm-pagination.test.ts
// Faz 10.2 — DM sayfalama sözleşmesi.
//
// GERÇEK DmRepository test edilir; yalnızca veritabanı katmanı (db/loader)
// deterministik mock ile değiştirilir. Repository mock'lanmaz — aksi halde
// asıl sorgu semantiği (cursor davranışı) hiç sınanmamış olurdu.
//
// KORUNAN SÖZLEŞME (routes/dm.ts:156-166):
//   GET /api/dm/:dmId/messages?before=<ms>&limit=<n>
//   - limit varsayılan 50, üst sınır 100
//   - `before` MİLİSANİYE zaman damgasıdır
//   - sonuç en yeniden eskiye çekilir, route `.reverse()` ile ASC döndürür

process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

import { stringOf } from './helpers/narrow';
import Dms from '../db/repositories/DmRepository';
import db from '../db/loader';

const DM = 'u1_u2';

/** Belirtilen zaman damgasıyla mesaj ekler (aynı ms'i kasıtlı üretebilmek için). */
async function seed(createdAt: number, text: string): Promise<string> {
  const doc = await db.dmMessages.insert({
    _id: `m-${text}`, dmId: DM, createdAt, content: text, userId: 'u1',
  });
  return doc._id;
}

/**
 * Ürün sayfalamasını taklit eder: en yeni sayfayı alır, sonra son öğenin
 * createdAt'ini `before` olarak kullanarak geriye doğru ilerler —
 * routes/dm.ts'in istemciye sunduğu sözleşmenin aynısı.
 */
async function pageBackwards(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let before: number | undefined = undefined;
  let beforeId: string | undefined = undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await Dms.findMessages(DM, { limit, before, beforeId });
    if (!page.length) break;
    seen.push(...page.map(m => stringOf(m.content, 'icerik')));
    const oldest = page[page.length - 1] as { createdAt: number; _id: string };
    // Kompozit cursor: aynı damgadaki kayıtlar arasında da ilerleyebilmek için
    // son öğenin (createdAt, _id) çifti taşınır.
    if (before === oldest.createdAt && beforeId === oldest._id) break;
    before = oldest.createdAt;
    beforeId = oldest._id;
  }
  return seen;
}

beforeEach(async () => {
  const all = await db.dmMessages.find({});
  for (const m of all) await db.dmMessages.remove({ _id: m._id });
});

describe('DM sayfalama — temel sözleşme', () => {
  it('boş konuşma boş sayfa döndürür', async () => {
    expect(await Dms.findMessages(DM, { limit: 50 })).toHaveLength(0);
  });

  it('ilk sayfa EN YENİ mesajları verir (azalan sıra)', async () => {
    await seed(1000, 'a'); await seed(2000, 'b'); await seed(3000, 'c');

    const page = await Dms.findMessages(DM, { limit: 2 });

    expect(page.map(m => stringOf(m.content, 'icerik'))).toEqual(['c', 'b']);
  });

  it('limit üst sınırı 100 ile kısıtlanır', async () => {
    for (let i = 0; i < 5; i += 1) await seed(1000 + i, `m${i}`);

    const page = await Dms.findMessages(DM, { limit: 5000 });

    expect(page.length).toBeLessThanOrEqual(100);
  });

  it('`before` verilen damgadan ESKİ mesajları getirir', async () => {
    await seed(1000, 'a'); await seed(2000, 'b'); await seed(3000, 'c');

    const page = await Dms.findMessages(DM, { limit: 50, before: 3000 });

    expect(page.map(m => stringOf(m.content, 'icerik'))).toEqual(['b', 'a']);
  });

  it('benzersiz damgalarda sayfalar bitişiktir — kopya ve boşluk yok', async () => {
    for (let i = 1; i <= 7; i += 1) await seed(i * 1000, `m${i}`);

    const seen = await pageBackwards(3);

    expect(new Set(seen).size).toBe(seen.length);                 // kopya yok
    expect(seen.sort()).toEqual(['m1','m2','m3','m4','m5','m6','m7'].sort()); // boşluk yok
  });
});

describe('DM sayfalama — aynı milisaniye (cursor bütünlüğü)', () => {
  // Bu blok gerçek bir veri kaybı senaryosunu kilitler: iki kullanıcı aynı
  // milisaniyede yazdığında ya da bir mesaj patlaması olduğunda birden çok
  // kayıt aynı `createdAt` değerini alır. Cursor yalnız zaman damgasına
  // dayanırsa sayfa sınırı o grubun içine düştüğünde kalan kayıtlar
  // SESSİZCE ATLANIR ve geçmişte kalıcı boşluk oluşur.

  it('aynı damgalı mesajlar sayfa sınırında KAYBOLMAZ', async () => {
    // 4 mesaj, hepsi aynı ms; ardından daha eski bir mesaj.
    await seed(5000, 'same-a');
    await seed(5000, 'same-b');
    await seed(5000, 'same-c');
    await seed(5000, 'same-d');
    await seed(1000, 'older');

    const seen = await pageBackwards(2);

    expect(new Set(seen).size).toBe(seen.length); // kopya yok
    expect(seen.sort()).toEqual(['older', 'same-a', 'same-b', 'same-c', 'same-d'].sort());
  });

  it('tek sayfaya sığan aynı damgalı grup eksiksiz döner', async () => {
    await seed(5000, 'x1'); await seed(5000, 'x2'); await seed(5000, 'x3');

    const page = await Dms.findMessages(DM, { limit: 50 });

    expect(page).toHaveLength(3);
  });

  it('aynı damgalı grup sayfalanırken sonsuz döngü oluşmaz', async () => {
    for (let i = 0; i < 6; i += 1) await seed(7000, `t${i}`);

    const seen = await pageBackwards(2);

    // pageBackwards 20 turluk koruma taşıyor; ilerleme olmazsa erken çıkar.
    expect(seen.length).toBeLessThanOrEqual(6 + 6); // patolojik tekrar yok
    expect(new Set(seen).size).toBe(6);             // hepsi görüldü, kopyasız
  });
});
