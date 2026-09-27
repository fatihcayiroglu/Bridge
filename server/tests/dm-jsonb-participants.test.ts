// server/tests/dm-jsonb-participants.test.ts
// Faz 10 — P1: `GET /api/dm` GERÇEK PostgreSQL'de 500 dönüyordu.
//
// KÖK NEDEN
//   dm_conversations.participants JSONB bir DİZİDİR: ["A","B"].
//   DmRepository.findConversationsByUser skaler eşitlik kuruyordu:
//     db.dmConversations.find({ participants: userId })
//   pgCollection bunu `"participants" = $1` olarak üretiyor; PostgreSQL sağ
//   tarafı JSON olarak ayrıştırmaya çalışıp şu hatayı veriyordu:
//     invalid input syntax for type json
//
// NEDEN HİÇBİR TEST YAKALAMADI
//   dm.test.ts REPOSITORY KATMANINI mock'luyor ve findConversationsByUser'ı
//   JS'te `participants.includes(userId)` ile uyguluyordu. Yani gerçek
//   repository sorgusu hiçbir zaman sınanmadı. Mock DB de skaler eşitlik
//   yapar — yani hata mock'ta da vardı, sadece hiç çağrılmadı.
//
// DÜZELTME
//   pgCollection'a AÇIK `$contains` operatörü eklendi → `col @> $n::jsonb`.
//   Mevcut hiçbir sorgunun anlamı değişmedi; yalnız üyelik niyeti açıkça
//   ifade edilebilir hale geldi. Migration YOK.
//
// Bu süit ÜRETİLEN SQL'i doğrular (deterministik) — uçtan uca gerçek Postgres
// kanıtı iki kullanıcılı runtime'da `GET /api/dm → 200` ile alınır.

process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';
import { buildWhere } from '../db/postgres/pgCollection';

describe('pgCollection — JSONB üyelik SQL üretimi', () => {
  it('$contains JSONB containment operatörü üretir', () => {
    const { sql, params } = buildWhere({ participants: { $contains: 'user-a' } });

    expect(sql).toContain('@>');
    expect(sql).toContain('::jsonb');
    // Skaler eşitlik ASLA üretilmemeli — üretimdeki 500'ün kaynağı buydu.
    expect(sql).not.toMatch(/"participants"\s*=\s*\$/);
    expect(params).toContain(JSON.stringify(['user-a']));
  });

  it('skaler eşitlik hâlâ düz kolonlar için normal çalışır', () => {
    const { sql, params } = buildWhere({ _id: 'dm-1' });

    expect(sql).toMatch(/"_id"\s*=\s*\$1/);
    expect(sql).not.toContain('@>');
    expect(params).toEqual(['dm-1']);
  });

  it('$contains dizi verildiğinde onu olduğu gibi kullanır', () => {
    const { params } = buildWhere({ participants: { $contains: ['a', 'b'] } });

    expect(params).toContain(JSON.stringify(['a', 'b']));
  });
});

describe('üyelik semantiği (mock DB, pg `@>` ile aynı sözleşme)', () => {
  let db: ReturnType<typeof createMockDb>;

  const A = 'user-a', B = 'user-b', C = 'user-c';

  beforeEach(async () => {
    db = createMockDb();
    await db.dmConversations.insert({ _id: 'dm-ab', participants: [A, B], createdAt: 1, lastMessageAt: 1 });
    await db.dmConversations.insert({ _id: 'dm-bc', participants: [B, C], createdAt: 2, lastMessageAt: 2 });
  });

  const findFor = (uid: string) => db.dmConversations.find({ participants: { $contains: uid } });

  it('A kendi konuşmasını bulur', async () => {
    const rows = await findFor(A);

    expect(rows.map((r: { _id: string }) => r._id)).toEqual(['dm-ab']);
  });

  it('B HER İKİ konuşmasını da bulur', async () => {
    const rows = await findFor(B);

    expect(rows.map((r: { _id: string }) => r._id).sort()).toEqual(['dm-ab', 'dm-bc']);
  });

  it('ilgisiz kullanıcı hiçbir konuşma görmez', async () => {
    expect(await findFor('user-yok')).toHaveLength(0);
  });

  it('C, A–B konuşmasını GÖREMEZ (kapsam sızıntısı yok)', async () => {
    const rows = await findFor(C);

    expect(rows.map((r: { _id: string }) => r._id)).toEqual(['dm-bc']);
  });

  it('skaler eşitlik dizi kolonuyla EŞLEŞMEZ (regresyon kilidi)', async () => {
    // Eski hatalı biçim. Mock'ta sessizce boş döner, gerçek Postgres'te
    // 500 fırlatırdı. Her iki durumda da YANLIŞ; bir daha kullanılmamalı.
    const rows = await db.dmConversations.find({ participants: A });

    expect(rows).toHaveLength(0);
  });
});
