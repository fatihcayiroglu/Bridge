// server/tests/pgcollection-where-operators.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// buildWhere — SORGU OPERATORLERI SQL'E DOGRU VE PARAMETRELI CEVRILIR
// ════════════════════════════════════════════════════════════════════════════
// `pgCollection` Bridge'in Mongo-benzeri sorgularini PostgreSQL'e ceviren TEK
// noktadir. Kardes paketler enjeksiyon (`pgCollection-injection`) ve kolon
// beyaz listesini (`pgcollection-column-whitelist`) olcer. Bu dosya
// OPERATORLERIN ANLAMINI olcer.
//
// Neden onemli: bir operatorun yanlis cevrilmesi hata vermez — SESSIZCE
// YANLIS SATIRLARI dondurur. Ornekler:
//
//   · `$nin` yanlis cevrilirse dislanmasi gereken kayitlar listeye girer
//     (engellenen kullanici, silinmis kanal...).
//   · `$in` BOS bir dizi icin "hepsi" anlamina gelemez; hicbir sey
//     eslesmemelidir (`FALSE`), aksi hâlde bos bir izin listesi TUM kayitlari
//     acardi. Bu, yetkilendirme sorgularinda dogrudan bir aciktir.
//   · TANINMAYAN bir operator SESSIZCE YOK SAYILIR ve filtre uygulanmaz —
//     bu yuzden yazim hatasinin nasil davrandigi da kilitlenmelidir.
//
// Her deger PARAMETRE olarak baglanir; SQL metnine gomulmez.
process.env.NODE_ENV = 'test';

import { buildWhere } from '../db/postgres/pgCollection';

describe('an empty query matches everything explicitly', () => {
  it.each([
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
  ])('renders TRUE for %s', (_label, query) => {
    const { sql, params } = buildWhere(query as Record<string, unknown>);
    expect(sql).toBe('TRUE');
    expect(params).toEqual([]);
  });
});

describe('scalar equality and null are distinct', () => {
  it('binds a scalar as a parameter rather than inlining it', () => {
    const { sql, params } = buildWhere({ userId: 'u1' });
    expect(sql).toContain('$1');
    expect(sql).not.toContain('u1');
    expect(params).toEqual(['u1']);
  });

  it('renders an explicit NULL check with no parameter', () => {
    const { sql, params } = buildWhere({ deletedAt: null });
    expect(sql).toContain('IS NULL');
    expect(params).toEqual([]);
  });

  it('joins several fields with AND', () => {
    const { sql, params } = buildWhere({ serverId: 's1', channelId: 'c1' });
    expect(sql).toContain(' AND ');
    expect(params).toEqual(['s1', 'c1']);
  });
});

describe('set membership refuses to widen on an empty list', () => {
  it('renders ANY for a populated $in', () => {
    const { sql, params } = buildWhere({ _id: { $in: ['a', 'b'] } });
    expect(sql).toContain('= ANY(');
    expect(params).toEqual([['a', 'b']]);
  });

  it('renders FALSE for an empty $in instead of matching everything', () => {
    // Bos bir izin listesi TUM kayitlari acsaydi bu dogrudan bir yetki acigi
    // olurdu: "su kimliklerden biri" sorgusu "herkes"e donerdi.
    const { sql, params } = buildWhere({ _id: { $in: [] } });
    expect(sql).toBe('FALSE');
    expect(params).toEqual([]);
  });

  it('renders ALL for a populated $nin', () => {
    const { sql, params } = buildWhere({ userId: { $nin: ['blocked-1', 'blocked-2'] } });
    expect(sql).toContain('!= ALL(');
    expect(params).toEqual([['blocked-1', 'blocked-2']]);
  });

  it('applies no filter for an empty $nin, which excludes nobody', () => {
    // "Sunlari haric tut" listesi bossa dislanacak kimse yoktur; bu,
    // bos `$in` ile SIMETRIK DEGILDIR ve olculmesi gerekir.
    const { sql, params } = buildWhere({ userId: { $nin: [] } });
    expect(sql).toBe('TRUE');
    expect(params).toEqual([]);
  });
});

describe('range comparisons render the right direction', () => {
  it.each([
    ['$lt', '<'],
    ['$lte', '<='],
    ['$gt', '>'],
    ['$gte', '>='],
    ['$ne', '!='],
  ])('renders %s as %s', (operator, symbol) => {
    const { sql, params } = buildWhere({ createdAt: { [operator]: 1_700_000_000_000 } });
    expect(sql).toContain(`${symbol} $1`);
    expect(params).toEqual([1_700_000_000_000]);
  });

  it('combines a lower and an upper bound on one field', () => {
    const { sql, params } = buildWhere({ createdAt: { $gte: 100, $lt: 200 } });
    expect(sql).toContain('>= $1');
    expect(sql).toContain('< $2');
    expect(params).toEqual([100, 200]);
  });
});

describe('presence, membership and pattern operators', () => {
  it('renders $exists in both directions without a parameter', () => {
    expect(buildWhere({ bannerUrl: { $exists: true } }).sql).toContain('IS NOT NULL');
    expect(buildWhere({ bannerUrl: { $exists: false } }).sql).toContain('IS NULL');
    expect(buildWhere({ bannerUrl: { $exists: true } }).params).toEqual([]);
  });

  it('renders $contains as a JSONB containment check', () => {
    // Duz esitlik JSONB kolonunda "invalid input syntax for type json" ile
    // patlardi; uyelik niyeti ACIKCA ifade edilir.
    const { sql, params } = buildWhere({ participants: { $contains: 'u1' } });
    expect(sql).toContain('@>');
    expect(sql).toContain('::jsonb');
    expect(params).toEqual([JSON.stringify(['u1'])]);
  });

  it('accepts an array for $contains without double-wrapping it', () => {
    const { params } = buildWhere({ participants: { $contains: ['u1', 'u2'] } });
    expect(params).toEqual([JSON.stringify(['u1', 'u2'])]);
  });

  it('renders $regex as a bound ILIKE pattern, never inlined SQL', () => {
    const { sql, params } = buildWhere({ name: { $regex: 'gen' } });
    expect(sql).toContain('ILIKE $1');
    expect(params).toEqual(['%gen%']);
    // Desen METINDE degil, PARAMETREDE tasinir.
    expect(sql).not.toContain('gen');
  });

  it('takes the source out of a RegExp instance', () => {
    const { params } = buildWhere({ name: { $regex: /kanal/i } });
    expect(params).toEqual(['%kanal%']);
  });
});

describe('unknown operators are ignored rather than guessed', () => {
  it('applies no condition for an operator the translator does not implement', () => {
    // Yazim hatasi bir FILTRE uydurmaz. Sessizce yanlis satir dondurmektense
    // filtresiz kalmak, cagiran katmanin kendi yetki kontrolune birakir.
    const { sql, params } = buildWhere({ createdAt: { $yaklasik: 5 } });
    expect(sql).toBe('TRUE');
    expect(params).toEqual([]);
  });

  it('still applies the operators it does recognise alongside an unknown one', () => {
    const { sql, params } = buildWhere({ createdAt: { $gte: 10, $yaklasik: 5 } });
    expect(sql).toContain('>= $1');
    expect(params).toEqual([10]);
  });
});

describe('parameters are numbered in the order they are bound', () => {
  it('keeps placeholder numbering aligned with the parameter array', () => {
    const { sql, params } = buildWhere({
      serverId: 's1',
      createdAt: { $gte: 100 },
      name: { $regex: 'x' },
    });
    expect(params).toEqual(['s1', 100, '%x%']);
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).toContain('$3');
    // Yanlis numaralandirma degerleri BIRBIRINE karistirirdi.
    expect(sql).not.toContain('$4');
  });
});
