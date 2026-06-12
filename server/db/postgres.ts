// server/db/postgres.ts
// Geriye dönük uyumluluk re-export'u.
// Tüm yeni kodlar doğrudan alt modülleri import etmeli:
//   import { pool }            from './db/postgres/pool'
//   import { withTransaction } from './db/postgres/transaction'
//   import { ftsSearch }       from './db/postgres/fts'
//   import db                  from './db/postgres/index'

export { default } from './postgres/index';
export { default as db } from './postgres/index';
export { pool }            from './postgres/pool';
export { withTransaction } from './postgres/transaction';
export { ftsSearch }       from './postgres/fts';
