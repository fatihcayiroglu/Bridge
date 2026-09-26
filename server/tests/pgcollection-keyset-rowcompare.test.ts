// server/tests/pgcollection-keyset-rowcompare.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KEYSET İMLECİ — DİSJONKSİYON DEĞİL, SATIR KARŞILAŞTIRMASI
// ════════════════════════════════════════════════════════════════════════════
//
// Kompozit imleçli sayfalama (`MessageRepository.findByChannel`) şu sorguyu
// üretir:
//
//     createdAt < X  OR  (createdAt = X AND _id < Y)
//
// PostgreSQL bir DİSJONKSİYONU tek bir indeks aralık koşuluna çeviremez;
// `(channelId, createdAt DESC, _id DESC)` indeksi seek için kullanılamaz ve
// planlayıcı tarayıp filtreler.
//
// ── GERÇEK PostgreSQL 18 ÜZERİNDE ÖLÇÜLDÜ (kanalda 100 000 mesaj) ──────────
//   DESC · OR biçimi          : 200 154 satır filtrelendi · 6 446 buffer · 64.595 ms
//   DESC · satır karşılaştırma:     154 satır filtrelendi ·    11 buffer ·  0.277 ms
//   ASC  · OR biçimi          : 100 153 satır filtrelendi · 3 223 buffer · 35.443 ms
//   ASC  · satır karşılaştırma:     154 satır filtrelendi ·    10 buffer ·  0.231 ms
//
// İki biçim AYNI satırları döndürür (INTERSECT ile doğrulandı: 50/50).
//
// BU DOSYANIN İŞİ: yeniden yazmanın (a) TAM OLARAK imleç şeklinde devreye
// girdiğini ve (b) BAŞKA HİÇBİR `$or`u değiştirmediğini sabitlemek. İkincisi
// birincisinden daha önemlidir: genel bir disjonksiyonu satır
// karşılaştırmasına çevirmek sorgunun ANLAMINI değiştirir ve sessizce yanlış
// satır döndürür.

import { buildWhere } from '../db/postgres/pgCollection';

describe('keyset cursor is compiled to a row comparison', () => {
  it('rewrites the descending cursor shape into an indexable range condition', () => {
    const { sql, params } = buildWhere({
      channelId: 'c1',
      $or: [{ createdAt: { $lt: 100 } }, { createdAt: 100, _id: { $lt: 'm9' } }],
    });
    // Satır karşılaştırması `Index Cond` üretir; OR biçimi üretmez.
    expect(sql).toBe('"channelId" = $1 AND ("createdAt", "_id") < ($2, $3)');
    expect(sql).not.toContain(' OR ');
    expect(params).toEqual(['c1', 100, 'm9']);
  });

  it('rewrites the ascending cursor shape with the matching direction', () => {
    const { sql, params } = buildWhere({
      channelId: 'c1',
      $or: [{ createdAt: { $gt: 100 } }, { createdAt: 100, _id: { $gt: 'm9' } }],
    });
    expect(sql).toBe('"channelId" = $1 AND ("createdAt", "_id") > ($2, $3)');
    expect(params).toEqual(['c1', 100, 'm9']);
  });

  it('keeps parameter order aligned with the placeholders it emits', () => {
    // Sıra bozulursa sorgu HATA VERMEZ; yanlış sayfayı döndürür. Bu yüzden
    // yer tutucu numaraları ve parametre dizisi birlikte doğrulanır.
    const { sql, params } = buildWhere({
      serverId: 's1',
      channelId: 'c1',
      $or: [{ createdAt: { $lt: 42 } }, { createdAt: 42, _id: { $lt: 'zz' } }],
    });
    expect(sql).toBe('"serverId" = $1 AND "channelId" = $2 AND ("createdAt", "_id") < ($3, $4)');
    expect(params).toEqual(['s1', 'c1', 42, 'zz']);
  });
});

describe('every other disjunction is left exactly as it was', () => {
  it('does not rewrite a single-clause $or (no tie-breaker present)', () => {
    const { sql, params } = buildWhere({ channelId: 'c1', $or: [{ createdAt: { $lt: 100 } }] });
    expect(sql).toBe('"channelId" = $1 AND (("createdAt" < $2))');
    expect(params).toEqual(['c1', 100]);
  });

  it('does not rewrite an ordinary equality disjunction', () => {
    const { sql, params } = buildWhere({ $or: [{ userId: 'a' }, { userId: 'b' }] });
    expect(sql).toBe('(("userId" = $1) OR ("userId" = $2))');
    expect(params).toEqual(['a', 'b']);
  });

  it('does not rewrite when the tie-breaker boundary differs from the range boundary', () => {
    // `createdAt = 999` ile `createdAt < 100` AYNI imleç değildir. Satır
    // karşılaştırmasına çevirmek burada anlamı değiştirirdi.
    const { sql, params } = buildWhere({
      $or: [{ createdAt: { $lt: 100 } }, { createdAt: 999, _id: { $lt: 'm9' } }],
    });
    expect(sql).toBe('(("createdAt" < $1) OR ("createdAt" = $2 AND "_id" < $3))');
    expect(params).toEqual([100, 999, 'm9']);
  });

  it('does not rewrite when the two clauses compare in opposite directions', () => {
    const { sql } = buildWhere({
      $or: [{ createdAt: { $lt: 100 } }, { createdAt: 100, _id: { $gt: 'm9' } }],
    });
    expect(sql).toContain(' OR ');
    expect(sql).not.toContain('("createdAt", "_id")');
  });

  it('does not rewrite a non-strict comparison', () => {
    const { sql } = buildWhere({
      $or: [{ createdAt: { $lte: 100 } }, { createdAt: 100, _id: { $lte: 'm9' } }],
    });
    expect(sql).toContain(' OR ');
    expect(sql).not.toContain('("createdAt", "_id")');
  });

  it('does not rewrite when the tie clause carries an extra column', () => {
    const { sql } = buildWhere({
      $or: [
        { createdAt: { $lt: 100 } },
        { createdAt: 100, _id: { $lt: 'm9' }, userId: 'u1' },
      ],
    });
    expect(sql).toContain(' OR ');
    expect(sql).not.toContain('("createdAt", "_id")');
  });

  it('does not rewrite a three-clause disjunction', () => {
    const { sql } = buildWhere({
      $or: [
        { createdAt: { $lt: 100 } },
        { createdAt: 100, _id: { $lt: 'm9' } },
        { userId: 'u1' },
      ],
    });
    expect(sql).toContain(' OR ');
  });

  it('still refuses an unknown column inside the cursor shape', () => {
    // Yeniden yazma yolu kolon beyaz listesini ATLAMAMALIDIR; aksi halde
    // enjeksiyon yüzeyi açılırdı.
    expect(() => buildWhere({
      $or: [{ nopeColumn: { $lt: 1 } }, { nopeColumn: 1, alsoNope: { $lt: 2 } }],
    })).toThrow(/Unknown column name/);
  });
});
