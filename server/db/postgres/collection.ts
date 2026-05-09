// @ts-nocheck
// server/db/postgres/collection.js
// JSONB kolon listesi, buildWhere query builder ve PgCollection sınıfı

'use strict';

const { v4: uuidv4 } = require('uuid');

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
function buildWhere(query) {
  if (!query || Object.keys(query).length === 0) return { sql: 'TRUE', params: [] };

  const parts  = [];
  const params = [];
  let   idx    = 1;

  function ph() { return `$${idx++}`; }
  function safeCol(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Unsafe column identifier: ${name}`);
    }
    return `"${name}"`;
  }

  function processKey(k, v) {
    // camelCase → PostgreSQL için çift tırnak
    const col = safeCol(k);

    if (k === '$or') {
      const orParts = v.map(sub => {
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
  constructor(table) {
    this.table = table;
  }

  // ── Tek kayıt bul ────────────────────────────────────────
  async findOne(query = {}) {
    const { sql, params } = buildWhere(query);
    const q = `SELECT * FROM "${this.table}" WHERE ${sql} LIMIT 1`;
    const { rows } = await pool.query(q, params);
    return rows[0] ?? null;
  }

  // ── Çoklu kayıt — zincir API (SQLite uyumlu) ─────────────
  find(query = {}) {
    let _sort  = null;
    let _limit = null;
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
      if (_limit) q += ` LIMIT ${parseInt(_limit)}`;
      const { rows } = await pool.query(q, params);
      return rows;
    };

    const chain = {
      sort(s)  { _sort  = s; return chain; },
      limit(n) { _limit = n; return chain; },
      then(res, rej) { return exec().then(res, rej); },
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
  async insert(doc) {
    if (!doc._id) doc._id = uuidv4();
    const keys   = Object.keys(doc);
    const cols   = keys.map(k => `"${k}"`).join(', ');
    const phs    = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map(k => {
      const v = doc[k];
      // JSONB kolonlar: nesne/dizi → pg driver otomatik serialize eder
      return v;
    });
    await pool.query(
      `INSERT INTO "${this.table}" (${cols}) VALUES (${phs})`,
      values
    );
    return doc;
  }

  // ── Güncelle ─────────────────────────────────────────────
  async update(query, update) {
    const { sql: wSql, params: wParams } = buildWhere(query);

    if (update.$set) {
      const keys   = Object.keys(update.$set);
      const setCls = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const vals   = keys.map(k => update.$set[k]);
      // WHERE parametreleri $set'in ardından gelir
      const wOffset = vals.length;
      const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + wOffset}`);
      await pool.query(
        `UPDATE "${this.table}" SET ${setCls} WHERE ${wShifted}`,
        [...vals, ...wParams]
      );
    }

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 1}`);
        await pool.query(
          `UPDATE "${this.table}" SET "${k}" = "${k}" + $1 WHERE ${wShifted}`,
          [v, ...wParams]
        );
      }
    }

    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 1}`);
        await pool.query(
          `UPDATE "${this.table}" SET "${k}" = "${k}" || $1::jsonb WHERE ${wShifted}`,
          [JSON.stringify([v]), ...wParams]
        );
      }
    }

    return { updated: true };
  }

  // ── Sil ─────────────────────────────────────────────────
  async remove(query = {}) {
    const { sql, params } = buildWhere(query);
    const result = await pool.query(
      `DELETE FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return { deleted: result.rowCount };
  }

  // ── Say ──────────────────────────────────────────────────
  async count(query = {}) {
    const { sql, params } = buildWhere(query);
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return parseInt(rows[0].n);
  }

  ensureIndex() {} // No-op: indeksler schema'da tanımlı
}

module.exports = { buildWhere, JSONB_COLS, PgCollection: Collection };
export {};
