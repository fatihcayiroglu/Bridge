// server/db/postgres/transaction.ts
// withTransaction helper — atomik DB işlemleri için.
//
// Kullanım:
//   import { withTransaction } from '../db/postgres/transaction';
//
//   const result = await withTransaction(async (client) => {
//     await client.query('UPDATE ...');
//     await client.query('INSERT ...');
//     return { success: true };
//   });
//
// Hata durumunda ROLLBACK otomatik uygulanır ve hata yeniden fırlatılır.

import { PoolClient } from 'pg';
import { pool } from './pool';

export type TransactionFn<T> = (client: PoolClient) => Promise<T>;

export async function withTransaction<T>(fn: TransactionFn<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
