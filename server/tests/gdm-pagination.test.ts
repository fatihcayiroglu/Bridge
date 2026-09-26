// server/tests/gdm-pagination.test.ts
// Faz 10.6B — Group DM geçmiş sayfalama sözleşmesi.
//
// GERÇEK GroupDmRepository test edilir; yalnız db katmanı mock'lanır.
// (Faz 10.2 dersi: repository mock'lanırsa sorgu semantiği hiç sınanmaz.)
//
// DM'de kanıtlanan aynı veri kaybı sınıfı burada da mevcuttu:
// `createdAt < before` tek başına kullanıldığında, aynı milisaniyeyi paylaşan
// mesajlar sayfa sınırına denk geldiğinde o damgadaki TÜM kayıtlar elenir ve
// geçmişte kalıcı boşluk oluşur.

process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

import { stringOf } from './helpers/narrow';
import GroupDms from '../db/repositories/GroupDmRepository';
import db from '../db/loader';

const G = 'grp-1';
const OTHER = 'grp-2';

let seq = 0;
async function seed(groupId: string, createdAt: number, text: string): Promise<void> {
  seq += 1;
  await db.groupDmMessages.insert({ _id: `m-${text}`, groupId, createdAt, content: text, userId: 'u1' });
}

/** Ürün sayfalamasını taklit eder: son öğenin cursor'ı ile geriye ilerler. */
async function pageBackwards(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let before: number | undefined;
  let beforeId: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await GroupDms.findMessages(G, { limit, before, beforeId });
    if (!page.length) break;
    seen.push(...page.map(m => stringOf(m.content, 'icerik')));
    const oldest = page[page.length - 1] as { createdAt: number; _id: string };
    if (before === oldest.createdAt && beforeId === oldest._id) break;
    before = oldest.createdAt;
    beforeId = oldest._id;
  }
  return seen;
}

beforeEach(async () => {
  seq = 0;
  for (const m of await db.groupDmMessages.find({})) await db.groupDmMessages.remove({ _id: m._id });
});

describe('Group DM sayfalama — temel sözleşme', () => {
  it('boş grup boş sayfa döndürür', async () => {
    expect(await GroupDms.findMessages(G, { limit: 50 })).toHaveLength(0);
  });

  it('tek mesaj döner', async () => {
    await seed(G, 1000, 'a');
    expect(await GroupDms.findMessages(G, { limit: 50 })).toHaveLength(1);
  });

  it('ilk sayfa EN YENİ mesajları verir (azalan)', async () => {
    await seed(G, 1000, 'a'); await seed(G, 2000, 'b'); await seed(G, 3000, 'c');

    const page = await GroupDms.findMessages(G, { limit: 2 });

    expect(page.map(m => stringOf(m.content, 'icerik'))).toEqual(['c', 'b']);
  });

  it('limit sınırından az / tam / bir fazla', async () => {
    for (let i = 1; i <= 3; i += 1) await seed(G, i * 1000, `m${i}`);

    expect(await GroupDms.findMessages(G, { limit: 5 })).toHaveLength(3);
    expect(await GroupDms.findMessages(G, { limit: 3 })).toHaveLength(3);
    expect(await GroupDms.findMessages(G, { limit: 2 })).toHaveLength(2);
  });

  it('limit üst sınırı 100', async () => {
    for (let i = 0; i < 5; i += 1) await seed(G, 1000 + i, `x${i}`);
    expect((await GroupDms.findMessages(G, { limit: 5000 })).length).toBeLessThanOrEqual(100);
  });

  it('benzersiz damgalarda sayfalar bitişik — kopya ve boşluk yok', async () => {
    for (let i = 1; i <= 7; i += 1) await seed(G, i * 1000, `m${i}`);

    const seen = await pageBackwards(3);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(['m1','m2','m3','m4','m5','m6','m7'].sort());
  });

  it('cursor GRUP KAPSAMLIDIR — başka grubun mesajları sızmaz', async () => {
    await seed(G, 1000, 'mine');
    await seed(OTHER, 1000, 'theirs');

    const page = await GroupDms.findMessages(G, { limit: 50 });

    expect(page.map(m => stringOf(m.content, 'icerik'))).toEqual(['mine']);
  });
});

describe('Group DM sayfalama — aynı milisaniye (cursor bütünlüğü)', () => {
  it('aynı damgalı mesajlar sayfa sınırında KAYBOLMAZ', async () => {
    await seed(G, 5000, 'same-a');
    await seed(G, 5000, 'same-b');
    await seed(G, 5000, 'same-c');
    await seed(G, 5000, 'same-d');
    await seed(G, 1000, 'older');

    const seen = await pageBackwards(2);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(['older', 'same-a', 'same-b', 'same-c', 'same-d'].sort());
  });

  it('tek sayfaya sığan aynı damgalı grup eksiksiz döner', async () => {
    await seed(G, 5000, 'x1'); await seed(G, 5000, 'x2'); await seed(G, 5000, 'x3');

    expect(await GroupDms.findMessages(G, { limit: 50 })).toHaveLength(3);
  });

  it('tamamı aynı damgalı geçmişte sonsuz döngü oluşmaz', async () => {
    for (let i = 0; i < 6; i += 1) await seed(G, 7000, `t${i}`);

    const seen = await pageBackwards(2);

    expect(new Set(seen).size).toBe(6);
    expect(seen.length).toBeLessThanOrEqual(12);
  });
});
