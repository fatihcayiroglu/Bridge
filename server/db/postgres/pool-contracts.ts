// server/db/postgres/pool-contracts.ts
//
// ════════════════════════════════════════════════════════════════════════════
// POSTGRESQL HAVUZU — İHTİYAÇ SÖZLEŞMELERİ (ARAYÜZ AYRIŞTIRMASI)
// ════════════════════════════════════════════════════════════════════════════
//
// `PgCollection`, `jobs/embedHistory.ts` ve benzeri sahipler imzalarında
// `pg.Pool`un TAMAMINI talep ediyordu. Oysa kullandıkları yüzey üç üyeden
// ibaret:
//
//     pool.connect() → client.query(sql, params) → client.release()
//     (bazı sahipler ayrıca doğrudan `pool.query`)
//
// `pg.Pool.query` ağır biçimde aşırı yüklenmiş (overloaded) ve jeneriktir;
// `pg.Pool` ayrıca `EventEmitter` yüzeyinin tamamını taşır. Bu iki şey birlikte
// test ikizlerinin tipe UYMASINI imkânsız kılıyordu. Ölçüldü (Final20 → Final21
// devri): tek bu sebep `tests/pgCollection.test.ts` ve
// `tests/embedHistory.test.ts` içinde **39** strict hatası üretiyordu.
//
// Alışılmış "çözüm" `as any` yazmaktır; o da tipi tamamen kaybettirir. Burada
// tersi yapılır: İHTİYAÇ yazılır.
//
// ── GERÇEK `pg` TİPLERİYLE UYUM DERLEME ZAMANINDA KANITLANIR ────────────────
// Aşağıdaki `assert*Compatible` fonksiyonları ÇAĞRILMAZ. Var olma sebepleri,
// `pg.Pool` / `pg.PoolClient` tiplerinin bu sözleşmeleri karşıladığını
// derleyiciye kanıtlatmaktır. `pg` bir gün imzasını değiştirirse hata ÜRÜN
// KODUNUN DERLENMESİNDE çıkar — testlerde değil.

import type { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Bir sorgu sonucunun ürün kodunun FİİLEN okuduğu yüzeyi.
 *
 * `pg.QueryResult` ayrıca `command`, `oid`, `fields` taşır; bu kod tabanında
 * hiçbiri okunmuyor. Sözleşmeye eklemek, test ikizlerini hiç kullanılmayan
 * alanları üretmeye zorlardı.
 */
export interface QueryResultLike<Row = QueryResultRow> {
  rows: Row[];
  rowCount?: number | null;
}

/** Havuzdan alınan istemcinin kullanılan yüzeyi. */
export interface QueryingClient {
  // JENERİK DEĞİL — bilerek.
  // Jenerik bir metot imzasını bir `jest.fn` KARŞILAYAMAZ (jenerik olmayan bir
  // imza, hedefin TÜM örneklemeleri için geçerli olmak zorundadır). Jenerik
  // burada zaten hiçbir şey kazandırmıyordu: `PgCollection` tip argümanı
  // vermeden çağırıp satırları `typedFromRow<T>` ile kendisi daraltıyor.
  // Satır tipi `QueryResultRow`dur — `pg`nin kendi açık indeks imzalı satır
  // tipi; bu bizim eklediğimiz bir gevşetme değildir.
  query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike<QueryResultRow>>;
  release(err?: Error | boolean): void;
}

/** Havuzun kullanılan yüzeyi. */
export interface QueryingPool {
  connect(): Promise<QueryingClient>;
}

/**
 * Doğrudan `pool.query(...)` çağıran sahipler için.
 *
 * `pg` bunu havuz düzeyinde de sunar (içeride bir istemci ödünç alıp bırakır).
 */
export interface DirectQueryingPool {
  // `QueryingClient.query` ile aynı gerekçe: jenerik değil.
  query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike<QueryResultRow>>;
}

// ── DERLEME ZAMANI UYUM KANITLARI ──────────────────────────────────────────

/** @internal derleme zamanı kanıt */
export function assertPoolCompatible(pool: Pool): QueryingPool {
  return pool;
}

/** @internal derleme zamanı kanıt */
export function assertClientCompatible(client: PoolClient): QueryingClient {
  return client;
}

/** @internal derleme zamanı kanıt */
export function assertDirectQueryCompatible(pool: Pool): DirectQueryingPool {
  return pool;
}
