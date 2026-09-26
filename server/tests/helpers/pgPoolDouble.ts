// server/tests/helpers/pgPoolDouble.ts
//
// ════════════════════════════════════════════════════════════════════════════
// POSTGRESQL HAVUZ İKİZİ — TEK KANONİK, TİPLİ SAHİP
// ════════════════════════════════════════════════════════════════════════════
//
// İki test dosyası kendi havuz ikizini elle kuruyordu ve ikisi de aynı şekilde
// kırılıyordu: TypeScript, ikizin dönüş tipini İLK `return` ifadesinden çıkarıp
// geri kalanını ona uydurmaya çalışıyordu. Sonuç:
//
//     rows: never[]                      (ilk dönüş boş diziydi)
//     rows: { n: number }[]              (ilk dönüş COUNT satırıydı)
//
// ve `mockResolvedValueOnce({ rows: [{ _id, username }] })` yazan her satır
// TS2345/TS2322 veriyordu. Ölçüldü: bu tek sebep `pgCollection.test.ts` +
// `embedHistory.test.ts` içinde 39 strict hatası üretiyordu.
//
// Buradaki ikiz, ÜRÜN sözleşmesine (`db/postgres/pool-contracts.ts`) uyar ve
// satır tipini `QueryResultRow` (pg'nin kendi açık indeks imzalı satır tipi)
// üzerinden serbest bırakır; böylece her test kendi satır şeklini verebilir
// ama havuzun YÜZEYİ yine de denetlenir.
//
// `as any` KULLANILMAZ: amaç tipi kaybetmek değil, doğru yere koymaktır.

import type { QueryResultRow } from 'pg';
import type {
  QueryingPool,
  QueryingClient,
  QueryResultLike,
  DirectQueryingPool,
} from '../../db/postgres/pool-contracts';

/** İkizin kaydettiği tek sorgu. */
export interface RecordedQuery {
  sql: string;
  params: readonly unknown[];
}

/** Sorgu ikizi — testler `mockResolvedValueOnce(...)` ile yanıt kurabilir. */
export type QueryMock = jest.Mock<
  Promise<QueryResultLike<QueryResultRow>>,
  [sql: string, params?: readonly unknown[]]
>;

export interface PoolDouble extends QueryingPool {
  /** Çalıştırılan her sorgu, sırasıyla. */
  _queries: RecordedQuery[];
  /** İkizin bellek-içi satır deposu. */
  _store: QueryResultRow[];
  /** Havuzun verdiği tek istemci — `query` üzerinden yanıt kurulabilir. */
  _client: QueryingClient & { query: QueryMock; release: jest.Mock };
  /** `connect` çağrılarını doğrulamak için. */
  connect: jest.Mock<Promise<QueryingClient>, []>;
}

/**
 * Basit, gerçekçi bir in-memory havuz ikizi.
 *
 * Varsayılan davranış `PgCollection`ın ürettiği SQL biçimlerini tanır
 * (`SELECT COUNT(*)`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`). Bir test daha
 * özel bir yanıt isterse `_client.query.mockResolvedValueOnce(...)` kullanır.
 */
export function makePoolDouble(rows: QueryResultRow[] = []): PoolDouble {
  const store: QueryResultRow[] = [...rows];
  const queries: RecordedQuery[] = [];

  const query: QueryMock = jest.fn(
    async (sql: string, params: readonly unknown[] = []): Promise<QueryResultLike<QueryResultRow>> => {
      queries.push({ sql, params });
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ n: store.length }] };
      if (sql.startsWith('SELECT')) return { rows: [...store] };
      if (sql.startsWith('INSERT')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('DELETE')) return { rows: [], rowCount: store.length };
      return { rows: [], rowCount: 0 };
    },
  );

  const client: QueryingClient & { query: QueryMock; release: jest.Mock } = {
    query,
    release: jest.fn(),
  };

  const connect: jest.Mock<Promise<QueryingClient>, []> = jest.fn(async () => client);

  return { connect, _queries: queries, _store: store, _client: client };
}

/**
 * Yalnızca `pool.query(...)` kullanan sahipler için (havuzdan istemci
 * ödünç almadan). `jobs/embedHistory.ts` bu biçimi kullanır.
 */
export interface DirectPoolDouble extends DirectQueryingPool {
  /** Aynı fonksiyon, mock yüzeyiyle birlikte — çağrı iddiaları için. */
  query: QueryMock;
}

export function makeDirectPoolDouble(
  handler?: (sql: string, params: readonly unknown[]) => Promise<QueryResultLike<QueryResultRow>>,
): DirectPoolDouble {
  const query: QueryMock = jest.fn(
    async (sql: string, params: readonly unknown[] = []): Promise<QueryResultLike<QueryResultRow>> =>
      (handler ? handler(sql, params) : { rows: [] }),
  );
  return { query };
}
