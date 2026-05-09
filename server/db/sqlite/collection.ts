// @ts-nocheck
const { v4: uuidv4 } = require('uuid');

function toRow(obj) {
  const row = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    row[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
  }
  return row;
}

const JSON_COLS = new Set(['reactions', 'replyTo', 'bridgedFrom', 'tags', 'roles', 'participants', 'editHistory', 'options']);
const BOOL_COLS = new Set(['pinned', 'sent', 'active', 'closed', 'multiSelect']);

function fromRow(row) {
  if (!row) return null;
  const obj = {};
  for (const [k, v] of Object.entries(row)) {
    if (JSON_COLS.has(k) && typeof v === 'string') {
      try { obj[k] = JSON.parse(v); } catch { obj[k] = v; }
    } else if (BOOL_COLS.has(k)) {
      obj[k] = v === 1 || v === true;
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

function fromRows(rows) { return rows.map(fromRow); }

function buildWhere(query) {
  if (!query || Object.keys(query).length === 0) return { sql: '1=1', params: [] };
  const parts = [];
  const params = [];

  function processKey(k, v) {
    if (k === '$or') {
      const orParts = v.map((sub) => {
        const r = buildWhere(sub);
        params.push(...r.params);
        return `(${r.sql})`;
      });
      parts.push(`(${orParts.join(' OR ')})`);
      return;
    }
    if (v === null) { parts.push(`"${k}" IS NULL`); return; }
    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
      for (const [op, val] of Object.entries(v)) {
        if (op === '$in') {
          if (!val || !val.length) { parts.push('0=1'); return; }
          parts.push(`"${k}" IN (${val.map(() => '?').join(',')})`);
          params.push(...val);
        } else if (op === '$nin') {
          if (!val || !val.length) return;
          parts.push(`"${k}" NOT IN (${val.map(() => '?').join(',')})`);
          params.push(...val);
        } else if (op === '$lt') { parts.push(`"${k}" < ?`); params.push(val); }
        else if (op === '$lte') { parts.push(`"${k}" <= ?`); params.push(val); }
        else if (op === '$gt') { parts.push(`"${k}" > ?`); params.push(val); }
        else if (op === '$gte') { parts.push(`"${k}" >= ?`); params.push(val); }
        else if (op === '$ne') { parts.push(`"${k}" != ?`); params.push(val); }
        else if (op === '$exists') { parts.push(val ? `"${k}" IS NOT NULL` : `"${k}" IS NULL`); }
      }
      if (v.$regex) {
        const pattern = v.$regex instanceof RegExp ? v.$regex.source : v.$regex;
        parts.push(`"${k}" LIKE ? ESCAPE '\\'`);
        params.push(`%${pattern.replace(/[%_]/g, (c) => `\\${c}`)}%`);
      }
    } else {
      parts.push(`"${k}" = ?`);
      params.push(typeof v === 'object' ? JSON.stringify(v) : v);
    }
  }

  for (const [k, v] of Object.entries(query)) processKey(k, v);
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}

class Collection {
  constructor(sqlite, table) {
    this.sqlite = sqlite;
    this.table = table;
  }

  _select(query = {}, { sort, limit } = {}) {
    const { sql, params } = buildWhere(query);
    let q = `SELECT * FROM "${this.table}" WHERE ${sql}`;
    if (sort) {
      const parts = Object.entries(sort).map(([k, d]) => `"${k}" ${d === -1 ? 'DESC' : 'ASC'}`);
      q += ` ORDER BY ${parts.join(', ')}`;
    }
    if (limit) q += ` LIMIT ${parseInt(limit, 10)}`;
    return this.sqlite.prepare(q).all(...params);
  }

  async findOne(query = {}) {
    const rows = this._select(query, { limit: 1 });
    return fromRow(rows[0] || null);
  }

  find(query = {}) {
    let _sort = null; let _limit = null;
    const exec = () => fromRows(this._select(query, { sort: _sort, limit: _limit }));
    const chain = {
      sort(s) { _sort = s; return chain; },
      limit(n) { _limit = n; return chain; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return chain;
  }

  async insert(doc) {
    if (!doc._id) doc._id = uuidv4();
    const row = toRow(doc);
    const cols = Object.keys(row).map((k) => `"${k}"`).join(', ');
    const phs = Object.keys(row).map(() => '?').join(', ');
    this.sqlite.prepare(`INSERT INTO "${this.table}" (${cols}) VALUES (${phs})`).run(...Object.values(row));
    return fromRow(row);
  }

  async update(query, update) {
    const { sql: w, params: wp } = buildWhere(query);
    if (update.$set) {
      const row = toRow(update.$set);
      const sc = Object.keys(row).map((k) => `"${k}" = ?`).join(', ');
      this.sqlite.prepare(`UPDATE "${this.table}" SET ${sc} WHERE ${w}`).run(...Object.values(row), ...wp);
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        this.sqlite.prepare(`UPDATE "${this.table}" SET "${k}" = "${k}" + ? WHERE ${w}`).run(v, ...wp);
      }
    }
    if (update.$push) {
      const rows = this._select(query);
      for (const row of rows) {
        for (const [k, v] of Object.entries(update.$push)) {
          let arr = [];
          try { arr = JSON.parse(row[k] || '[]'); } catch {}
          arr.push(v);
          this.sqlite.prepare(`UPDATE "${this.table}" SET "${k}" = ? WHERE "_id" = ?`).run(JSON.stringify(arr), row._id);
        }
      }
    }
    return { updated: true };
  }

  async remove(query = {}) {
    const { sql, params } = buildWhere(query);
    const info = this.sqlite.prepare(`DELETE FROM "${this.table}" WHERE ${sql}`).run(...params);
    return { deleted: info.changes };
  }

  async count(query = {}) {
    const { sql, params } = buildWhere(query);
    const row = this.sqlite.prepare(`SELECT COUNT(*) as n FROM "${this.table}" WHERE ${sql}`).get(...params);
    return row.n;
  }

  ensureIndex() {}
}

module.exports = { Collection };
export {};
