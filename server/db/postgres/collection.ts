// server/db/postgres/collection.ts
// @deprecated Sprint 48: Bu dosya pgCollection.ts ile değiştirildi.
// pgCollection.ts: SQL injection whitelist koruması + genişletilmiş JSONB desteği içeriyor.
// Yeni kod doğrudan pgCollection.ts'i import etmeli.
// Bu dosya yalnızca geriye-dönük uyumluluk için korunuyor.
//

import { v4 as uuidv4 } from 'uuid';

// ── JSONB KOLONLARI ───────────────────────────────────────────
// Bu kolonlar PostgreSQL'de zaten JSONB — otomatik parse edilir.
// Ekstra işlem gerekmez, ama fromRow'da tutarlılık için liste tutuyoruz.
const JSONB_COLS = new Set([
  'reactions','replyTo','bridgedFrom','tags','roles','participants',
  'editHistory','options','events','subscription','twoFactorBackup',
  'keys','e2eData',
]);

// ── QUERY BUILDER ────────────────────────────────────────────
// SQLite'daki ? yerine PostgreSQL $1, $2, ... kullanır
function buildWhere(query: Record<string, unknown> | null | undefined): { sql: string; params: unknown[] } {
  if (!query || Object.keys(query).length === 0) return { sql: 'TRUE', params: [] };

  const parts: string[]  = [];
  const params: unknown[] = [];
  let   idx    = 1;

  function ph() { return `$${idx++}`; }
  function safeCol(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Unsafe column identifier: ${name}`);
    }
    return `"${name}"`;
  }

  function processKey(k: string, v: unknown): void {
    // camelCase → PostgreSQL için çift tırnak
    const col = safeCol(k);

    if (k === '$or') {
      const orParts = (v as Record<string,unknown>[]).map((sub: Record<string,unknown>) => {
        const r = buildWhere(sub);
        // offset param indices
        const shifted = r.sql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + params.length}`);
        params.push(...r.params);
        idx = params.length + 1;
        return `(${shifted})`;
      });
      parts.push(`(${orParts.join(' OR ')})`);
      return;
    }

    if (v === null) { parts.push(`${col} IS NULL`); return; }

    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
      for (const [op, val] of Object.entries(v)) {
        if (!['$in', '$nin', '$lt', '$lte', '$gt', '$gte', '$ne', '$exists', '$regex'].includes(op)) {
          throw new Error(`Unsupported query operator: ${op}`);
        }
        if (op === '$in') {
          if (!val?.length) { parts.push('FALSE'); return; }
          const phs = val.map(() => ph()).join(',');
          parts.push(`${col} IN (${phs})`);
          params.push(...val);
        } else if (op === '$nin') {
          if (!val?.length) return;
          const phs = val.map(() => ph()).join(',');
          parts.push(`${col} NOT IN (${phs})`);
          params.push(...val);
        } else if (op === '$lt')  { parts.push(`${col} < ${ph()}`);  params.push(val); }
        else if (op === '$lte')   { parts.push(`${col} <= ${ph()}`); params.push(val); }
        else if (op === '$gt')    { parts.push(`${col} > ${ph()}`);  params.push(val); }
        else if (op === '$gte')   { parts.push(`${col} >= ${ph()}`); params.push(val); }
        else if (op === '$ne')    { parts.push(`${col} != ${ph()}`); params.push(val); }
        else if (op === '$exists') { parts.push(val ? `${col} IS NOT NULL` : `${col} IS NULL`); }
        else if (op === '$regex') {
          const pattern = val instanceof RegExp ? val.source : val;
          parts.push(`${col} ILIKE ${ph()}`);
          params.push(`%${pattern}%`);
        }
      }
      return;
    }

    parts.push(`${col} = ${ph()}`);
    params.push(v);
  }

  for (const [k, v] of Object.entries(query)) processKey(k, v);
  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

// ── COLLECTION SINIFI ────────────────────────────────────────
class Collection {
  // Sprint 26: strict:true için property declaration eklendi
  pool: import('pg').Pool;
  table: string;

  constructor(table: string, pool: import('pg').Pool) {
    this.table = table;
    this.pool  = pool;
  }

  // ── Tek kayıt bul ────────────────────────────────────────
  async findOne(query: Record<string,unknown> = {}) {
    const { sql, params } = buildWhere(query);
    const q = `SELECT * FROM "${this.table}" WHERE ${sql} LIMIT 1`;
    const { rows } = await this.pool.query(q, params);
    return rows[0] ?? null;
  }

  // ── Çoklu kayıt — zincir API (SQLite uyumlu) ─────────────
  find(query: Record<string,unknown> = {}) {
    let _sort: Record<string,unknown> | null  = null;
    let _limit: number | null = null;
    const self = this;

    const exec = async () => {
      const { sql, params } = buildWhere(query);
      let q = `SELECT * FROM "${self.table}" WHERE ${sql}`;
      if (_sort) {
        const parts = Object.entries(_sort).map(
          ([k, d]) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `"${k}"` : (() => { throw new Error(`Unsafe sort key: ${k}`); })()} ${d === -1 ? 'DESC' : 'ASC'}`
        );
        q += ` ORDER BY ${parts.join(', ')}`;
      }
      if (_limit) q += ` LIMIT ${_limit}`;
      const { rows } = await this.pool.query(q, params);
      return rows;
    };

    const chain = {
      sort(s: Record<string,unknown>)  { _sort  = s; return chain; },
      limit(n: number) { _limit = n; return chain; },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return exec().then(res, rej); },
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next() {
            if (done) return { done: true };
            done = true;
            return { value: await exec(), done: false };
          },
        };
      },
    };
    return chain;
  }

  // ── Ekle ────────────────────────────────────────────────
  async insert(doc: Record<string,unknown>) {
    if (!doc._id) doc._id = uuidv4();
    const keys   = Object.keys(doc);
    const cols   = keys.map(k => `"${k}"`).join(', ');
    const phs    = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map(k => {
      const v = doc[k];
      // JSONB kolonlar: nesne/dizi → pg driver otomatik serialize eder
      return v;
    });
    await this.pool.query(
      `INSERT INTO "${this.table}" (${cols}) VALUES (${phs})`,
      values
    );
    return doc;
  }

  // ── Güncelle ─────────────────────────────────────────────
  async update(query: Record<string,unknown>, update: Record<string,unknown>) {
    const { sql: wSql, params: wParams } = buildWhere(query);

    if (update.$set) {
      const $set   = update.$set as Record<string,unknown>;
      const keys   = Object.keys($set);
      const setCls = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const vals   = keys.map(k => $set[k]);
      // WHERE parametreleri $set'in ardından gelir
      const wOffset = vals.length;
      const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + wOffset}`);
      await this.pool.query(
        `UPDATE "${this.table}" SET ${setCls} WHERE ${wShifted}`,
        [...vals, ...wParams]
      );
    }

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 1}`);
        await this.pool.query(
          `UPDATE "${this.table}" SET "${k}" = "${k}" + $1 WHERE ${wShifted}`,
          [v, ...wParams]
        );
      }
    }

    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 1}`);
        await this.pool.query(
          `UPDATE "${this.table}" SET "${k}" = "${k}" || $1::jsonb WHERE ${wShifted}`,
          [JSON.stringify([v]), ...wParams]
        );
      }
    }

    return { updated: true };
  }

  // ── Sil ─────────────────────────────────────────────────
  async remove(query: Record<string,unknown> = {}) {
    const { sql, params } = buildWhere(query);
    const result = await this.pool.query(
      `DELETE FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return { deleted: result.rowCount };
  }

  // ── Say ──────────────────────────────────────────────────
  async count(query: Record<string,unknown> = {}) {
    const { sql, params } = buildWhere(query);
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS n FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return parseInt(rows[0].n);
  }

  ensureIndex() {} // No-op: indeksler schema'da tanımlı
}

export { buildWhere, JSONB_COLS };
export { Collection as PgCollection };
