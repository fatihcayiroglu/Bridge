// @ts-nocheck
// server/db/postgres/pgCollection.js
// SQLite Collection ile birebir aynı async API'yi PostgreSQL üzerinde sağlar.
// Hiçbir route değişikliği gerekmez; sadece db/loader.js'i değiştirmek yeter.

'use strict';

const JSONB_COLS = new Set([
  'reactions', 'replyTo', 'bridgedFrom', 'tags', 'roles', 'participants',
  'editHistory', 'options', 'keys', 'meta', 'activity', 'config',
  'events', 'defaultRoles', 'questions', 'answers',
]);

// Objeyi DB'ye yazmadan önce JSONB sütunlarını serialize et
function toRow(obj) {
  const row = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && JSONB_COLS.has(k)) {
      row[k] = JSON.stringify(v);
    } else {
      row[k] = v;
    }
  }
  return row;
}

// DB'den gelen satırı JS objesine dönüştür
function fromRow(row) {
  if (!row) return null;
  const obj = {};
  for (const [k, v] of Object.entries(row)) {
    // PostgreSQL JSONB'yi zaten parse ederek döndürür;
    // string olarak gelirse (eski uyumluluk) parse et
    if (JSONB_COLS.has(k) && typeof v === 'string') {
      try { obj[k] = JSON.parse(v); } catch { obj[k] = v; }
    } else if (typeof v === 'boolean') {
      obj[k] = v;
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

// MongoDB-tarzı query'yi PostgreSQL WHERE + params'a çevirir
function buildWhere(query) {
  if (!query || Object.keys(query).length === 0) {
    return { sql: 'TRUE', params: [], counter: { n: 1 } };
  }

  const parts  = [];
  const params = [];
  let   n      = 1; // $1, $2, ...

  function addParam(v) { params.push(v); return `$${n++}`; }

  function processKey(k, v) {
    const col = `"${k}"`;
    if (k === '$or') {
      const orParts = v.map(sub => {
        const r = buildWhere(sub);
        // Offset param numbering
        const reNumbered = r.sql.replace(/\$(\d+)/g, (_, i) => {
          const newIdx = n + parseInt(i) - 1;
          return `$${newIdx}`;
        });
        n += r.params.length;
        params.push(...r.params);
        return `(${reNumbered})`;
      });
      parts.push(`(${orParts.join(' OR ')})`);
      return;
    }

    if (v === null) { parts.push(`${col} IS NULL`); return; }

    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
      for (const [op, val] of Object.entries(v)) {
        switch (op) {
          case '$in':
            if (!val?.length) { parts.push('FALSE'); return; }
            parts.push(`${col} = ANY(${addParam(val)}::text[])`);
            break;
          case '$nin':
            if (!val?.length) return;
            parts.push(`${col} != ALL(${addParam(val)}::text[])`);
            break;
          case '$lt':  parts.push(`${col} < ${addParam(val)}`);  break;
          case '$lte': parts.push(`${col} <= ${addParam(val)}`); break;
          case '$gt':  parts.push(`${col} > ${addParam(val)}`);  break;
          case '$gte': parts.push(`${col} >= ${addParam(val)}`); break;
          case '$ne':  parts.push(`${col} != ${addParam(val)}`); break;
          case '$exists':
            parts.push(val ? `${col} IS NOT NULL` : `${col} IS NULL`);
            break;
          case '$regex': {
            const pattern = val instanceof RegExp ? val.source : val;
            parts.push(`${col} ILIKE ${addParam('%' + pattern + '%')}`);
            break;
          }
          default: break;
        }
      }
      return;
    }

    parts.push(`${col} = ${addParam(v)}`);
  }

  for (const [k, v] of Object.entries(query)) processKey(k, v);

  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

class PgCollection {
  /**
   * @param {import('pg').Pool} pool
   * @param {string} table  — tablo adı (örn. 'users')
   */
  constructor(pool, table) {
    this.pool  = pool;
    this.table = table;
  }

  async _query(sql, params = []) {
    const client = await this.pool.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }

  // ── findOne ───────────────────────────────────────────────────
  async findOne(query = {}) {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `SELECT * FROM "${this.table}" WHERE ${sql} LIMIT 1`,
      params
    );
    return fromRow(res.rows[0]) ?? null;
  }

  // ── find — chainable (sort/skip/limit) ───────────────────────
  find(query = {}) {
    const self = this;
    let _sortSql  = '';
    let _skipVal  = 0;
    let _limitVal = null;

    const chain = {
      sort(spec) {
        const parts = Object.entries(spec).map(([col, dir]) =>
          `"${col}" ${dir === -1 || dir === 'desc' ? 'DESC' : 'ASC'}`
        );
        _sortSql = parts.length ? ' ORDER BY ' + parts.join(', ') : '';
        return chain;
      },
      skip(n) { _skipVal = n || 0; return chain; },
      limit(n) { _limitVal = n; return chain; },

      // Promise interface — await find(...) çalışır
      then(resolve, reject) {
        const { sql, params } = buildWhere(query);
        let q = `SELECT * FROM "${self.table}" WHERE ${sql}${_sortSql}`;
        if (_limitVal !== null) q += ` LIMIT ${_limitVal}`;
        if (_skipVal  > 0)      q += ` OFFSET ${_skipVal}`;
        return self._query(q, params)
          .then(res => res.rows.map(fromRow))
          .then(resolve, reject);
      },

      // Symbol.asyncIterator — for await ... of find() çalışır
      [Symbol.asyncIterator]() {
        return (async function* () {
          const { sql, params } = buildWhere(query);
          let q = `SELECT * FROM "${self.table}" WHERE ${sql}${_sortSql}`;
          if (_limitVal !== null) q += ` LIMIT ${_limitVal}`;
          if (_skipVal  > 0)      q += ` OFFSET ${_skipVal}`;
          const res = await self._query(q, params);
          for (const row of res.rows) yield fromRow(row);
        })();
      },
    };
    return chain;
  }

  // ── insert ────────────────────────────────────────────────────
  async insert(doc) {
    if (!doc._id) doc._id = require('uuid').v4();
    const row   = toRow(doc);
    const keys  = Object.keys(row);
    const cols  = keys.map(k => `"${k}"`).join(', ');
    const vals  = keys.map((_, i) => `$${i + 1}`).join(', ');
    const params = Object.values(row);
    await this._query(
      `INSERT INTO "${this.table}" (${cols}) VALUES (${vals}) ON CONFLICT (_id) DO NOTHING`,
      params
    );
    return { ...doc };
  }

  // ── update ────────────────────────────────────────────────────
  async update(query, update) {
    const { sql: whereSql, params: whereParams } = buildWhere(query);
    const setParts  = [];
    const setParams = [];

    if (update.$set) {
      const row = toRow(update.$set);
      for (const [k, v] of Object.entries(row)) {
        setParams.push(v);
        setParts.push(`"${k}" = $${setParams.length}`);
      }
    }

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        setParams.push(v);
        setParts.push(`"${k}" = COALESCE("${k}", 0) + $${setParams.length}`);
      }
    }

    if (update.$push) {
      // JSONB array append — PostgreSQL JSONB operatörü
      for (const [k, v] of Object.entries(update.$push)) {
        setParams.push(JSON.stringify(v));
        setParts.push(`"${k}" = COALESCE("${k}", '[]'::jsonb) || $${setParams.length}::jsonb`);
      }
    }

    if (!setParts.length) return { updated: 0 };

    // WHERE parametrelerini offset et
    const offset   = setParams.length;
    const whereSqlOffsetted = whereSql.replace(/\$(\d+)/g, (_, i) => `$${parseInt(i) + offset}`);
    const allParams = [...setParams, ...whereParams];

    const res = await this._query(
      `UPDATE "${this.table}" SET ${setParts.join(', ')} WHERE ${whereSqlOffsetted}`,
      allParams
    );
    return { updated: res.rowCount };
  }

  // ── remove ────────────────────────────────────────────────────
  async remove(query = {}) {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `DELETE FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return { deleted: res.rowCount };
  }

  // ── count ─────────────────────────────────────────────────────
  async count(query = {}) {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `SELECT COUNT(*) AS n FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return parseInt(res.rows[0]?.n ?? 0);
  }

  // ── ensureIndex — PostgreSQL'de zaten schema.sql'de tanımlı ──
  ensureIndex() {}
}

module.exports = { PgCollection, buildWhere };
export {};
