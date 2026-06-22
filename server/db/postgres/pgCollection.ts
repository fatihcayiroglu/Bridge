// server/db/postgres/pgCollection.ts
// SQLite Collection ile birebir aynı async API'yi PostgreSQL üzerinde sağlar.
// Hiçbir route değişikliği gerekmez; sadece db/loader.js'i değiştirmek yeter.

import { v4 as uuidv4 } from 'uuid';
import type { Pool, PoolClient } from 'pg';

const JSONB_COLS = new Set([
  'reactions', 'replyTo', 'bridgedFrom', 'tags', 'roles', 'participants',
  'editHistory', 'options', 'keys', 'meta', 'activity', 'config',
  'events', 'defaultRoles', 'questions', 'answers',
]);

const TABLE_PRIMARY_KEYS: Record<string, string[]> = {
  members: ['userId', 'serverId'],
  refresh_tokens: ['token'],
  unread_counts: ['userId', 'channelId'],
  user_ap_keys: ['userId'],
};

// ── Kolon adı whitelist (injection koruması) ─────────────────
// Tüm schema'daki geçerli kolon adları. buildWhere / insert / update
// çağrılarında bilinmeyen kolon adları reddedilir.
// Yeni kolon eklendiğinde bu Set'i ve schema.ts'i birlikte güncelleyin.
const ALLOWED_COLUMNS = new Set([
  // ── Evrensel ──────────────────────────────────────────────
  '_id', 'name', 'type', 'status', 'icon', 'url', 'token', 'code', 'used',
  'sent', 'email', 'password', 'username', 'bio', 'website', 'location',
  'pronouns', 'color', 'description', 'topic', 'category', 'label', 'emoji',
  'order', 'position', 'active', 'pinned', 'verified', 'closed', 'collapsed',
  'count', 'uses', 'duration', 'level', 'detail', 'secret', 'endpoint',
  'platform', 'question', 'permissions', 'allow', 'deny', 'action', 'target',
  // ── Upload sahipliği (Sprint 75) ──────────────────────────
  'key', 'originalName', 'mimeType',
  // ── Zaman ─────────────────────────────────────────────────
  'createdAt', 'editedAt', 'sentAt', 'joinedAt', 'addedAt', 'expiresAt',
  'lastSeen', 'lastMessageAt', 'sendAt', 'scheduledId',
  // ── Kullanıcı ─────────────────────────────────────────────
  'createdBy', 'displayName', 'avatarColor', 'avatarUrl', 'bannerColor', 'bannerUrl',
  'statusText', 'statusEmoji', 'tokenVersion', 'emailVerified', 'emailToken',
  'emailTokenExp', 'twoFactorSecret', 'twoFactorEnabled', 'twoFactorBackup',
  'isAdmin', 'ssoProvider', 'ssoId',
  // ── Auth ──────────────────────────────────────────────────
  'userId', 'family', 'usedAt', 'tokenHash',
  // ── Sunucu / Kanal ────────────────────────────────────────
  'ownerId', 'serverId', 'channelId', 'categoryId', 'parentMessageId',
  'threadId', 'threadCount', 'messageCount', 'discoverable', 'iconUrl',
  'logChannelId', 'verificationEnabled', 'defaultRoles', 'ssoConfig',
  'sourceServerId', 'sourceChannelId', 'targetServerId', 'targetChannelId',
  'targetId', 'targetType',
  // ── Mesaj / İçerik ────────────────────────────────────────
  'content', 'fileUrl', 'fileName', 'fileType', 'isEncrypted', 'e2eData',
  'bridgedFrom', 'replyTo', 'editHistory', 'reactions', 'roles', 'tags',
  'participants', 'options', 'keys', 'meta', 'activity', 'config', 'events',
  'questions', 'answers',
  // ── Federation ────────────────────────────────────────────
  'actorId', 'adminId', 'dmId', 'friendId',
  // ── Diğer ─────────────────────────────────────────────────
  'e2e', 'maxUses', 'multiSelect', 'timeout', 'timeoutUntil',
  'inviteCode', 'inviteCreatedAt',

  'apPublicKey',
  'apPrivateKeyEnc',
  'keyVersion',
  'updatedAt',]);

/**
 * Kolon adını doğrula — SQL injection'a karşı ikinci savunma katmanı.
 * Bilinmeyen kolon adları bir hata fırlatır.
 *
 * Bu kontrol parameterized query'ye ek olarak uygulanır; değerler
 * zaten $1/$2 placeholder ile korunuyor. Kolon *adı* ise identifier
 * olduğundan pg driver parametrize edemez — whitelist zorunludur.
 */
function assertValidColumn(col: string): void {
  // $or gibi MongoDB operatörleri bu fonksiyona gelmez
  if (!ALLOWED_COLUMNS.has(col)) {
    throw new Error(
      `[pgCollection] Unknown column name: "${col}". ` +
      "Schema değişikliği yaptıysanız ALLOWED_COLUMNS Set'ini güncelleyin.",
    );
  }
}


// Objeyi DB'ye yazmadan önce JSONB sütunlarını serialize et
function toRow(obj: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
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
function fromRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  const obj: Record<string, unknown> = {};
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
type QueryValue = string | number | boolean | null | RegExp | Record<string, unknown> | Array<Record<string, unknown>> | unknown[];
export type DbRecord = Record<string, unknown>;
export type DbQuery<T extends object = DbRecord> = Partial<Record<Extract<keyof T, string>, unknown>> & Record<string, unknown>;
export type DbUpdate<T extends object = DbRecord> = DbQuery<T> & {
  $set?: Partial<T> & DbRecord;
  $inc?: DbRecord;
  $push?: DbRecord;
};
export type DbInsert<T extends object = DbRecord> = Partial<T> & DbRecord;

export interface FindChain<T extends object> extends PromiseLike<T[]> {
  sort(spec: DbQuery<T>): FindChain<T>;
  skip(n: number): FindChain<T>;
  limit(n: number): FindChain<T>;
  catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T[] | TResult>;
  finally(onfinally?: (() => void) | null): Promise<T[]>;
  [Symbol.asyncIterator](): AsyncGenerator<T, void, unknown>;
}

function objectToRecord(value: object): DbRecord {
  return Object.fromEntries(Object.entries(value));
}

function typedFromRow<T extends object>(row: DbRecord | null): T | null {
  return fromRow(row) as T | null;
}

export function buildWhere(query: Record<string, unknown> | null | undefined): { sql: string; params: unknown[] } {
  if (!query || Object.keys(query).length === 0) {
    return { sql: 'TRUE', params: [] };
  }

  const parts: string[]  = [];
  const params: unknown[] = [];
  let   n      = 1; // $1, $2, ...

  function addParam(v: unknown): string { params.push(v); return `$${n++}`; }

  function processKey(k: string, v: QueryValue): void {
    if (k !== '$or') assertValidColumn(k);
    const col = `"${k}"`;
    if (k === '$or') {
      const orParts = (v as Array<Record<string, QueryValue>>).map(sub => {
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
            if (!(val as unknown[])?.length) { parts.push('FALSE'); return; }
            parts.push(`${col} = ANY(${addParam(val)}::text[])`);
            break;
          case '$nin':
            if (!(val as unknown[])?.length) return;
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

  for (const [k, v] of Object.entries(query)) processKey(k, v as QueryValue);

  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

export class PgCollection<T extends object = DbRecord> {
  /**
   * @param {import('pg').Pool} pool
   * @param {string} table  — tablo adı (örn. 'users')
   */
  // Sprint 26: strict:true için property declarations eklendi
  pool: Pool;
  table: string;

  constructor(pool: Pool, table: string) {
    this.pool  = pool;
    this.table = table;
  }

  async _query(sql: string, params: unknown[] = []): Promise<import('pg').QueryResult> {
    const client: PoolClient = await this.pool.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }

  // ── findOne ───────────────────────────────────────────────────
  async findOne(query: DbQuery<T> = {}, _options?: unknown): Promise<T | null> {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `SELECT * FROM "${this.table}" WHERE ${sql} LIMIT 1`,
      params
    );
    return typedFromRow<T>(res.rows[0] ?? null);
  }

  // ── find — chainable (sort/skip/limit) ───────────────────────
  find(query: DbQuery<T> = {}, _options?: unknown): FindChain<T> {
    const self = this;
    let _sortSql  = '';
    let _skipVal  = 0;
    let _limitVal: number | null = null;

    const chain = {
      sort(spec: DbQuery<T>) {
        const parts = Object.entries(spec).map(([col, dir]: [string, unknown]) => {
          assertValidColumn(col);
          return `"${col}" ${dir === -1 || dir === 'desc' ? 'DESC' : 'ASC'}`;
        });
        _sortSql = parts.length ? ' ORDER BY ' + parts.join(', ') : '';
        return chain;
      },
      skip(n: number) { _skipVal = n || 0; return chain; },
      limit(n: number) { _limitVal = n; return chain; },

      // Promise interface — await find(...) çalışır
      then<TResult1 = T[], TResult2 = never>(resolve?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
        const { sql, params } = buildWhere(query);
        let q = `SELECT * FROM "${self.table}" WHERE ${sql}${_sortSql}`;
        if (_limitVal !== null) q += ` LIMIT ${_limitVal}`;
        if (_skipVal  > 0)      q += ` OFFSET ${_skipVal}`;
        return self._query(q, params)
          .then(res => res.rows.map(r => typedFromRow<T>(r)).filter((r): r is T => r !== null))
          .then(resolve ?? ((value: T[]) => value as TResult1), reject ?? undefined);
      },

      catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T[] | TResult> {
        return Promise.resolve(chain).catch(onrejected ?? undefined);
      },

      finally(onfinally?: (() => void) | null): Promise<T[]> {
        return Promise.resolve(chain).finally(onfinally ?? undefined);
      },

      // Symbol.asyncIterator — for await ... of find() çalışır
      [Symbol.asyncIterator]() {
        return (async function* () {
          const { sql, params } = buildWhere(query);
          let q = `SELECT * FROM "${self.table}" WHERE ${sql}${_sortSql}`;
          if (_limitVal !== null) q += ` LIMIT ${_limitVal}`;
          if (_skipVal  > 0)      q += ` OFFSET ${_skipVal}`;
          const res = await self._query(q, params);
          for (const row of res.rows) {
            const mapped = typedFromRow<T>(row);
            if (mapped !== null) yield mapped;
          }
        })();
      },
    };
    return chain;
  }

  // ── insert ────────────────────────────────────────────────────
  async insert(doc: DbInsert<T>): Promise<T> {
    const mutableDoc: DbRecord = { ...doc };
    const primaryKeys = TABLE_PRIMARY_KEYS[this.table] || ['_id'];
    if (primaryKeys.includes('_id') && (!Object.prototype.hasOwnProperty.call(mutableDoc, '_id') || mutableDoc['_id'] === undefined || mutableDoc['_id'] === null || mutableDoc['_id'] === '')) mutableDoc['_id'] = uuidv4();
    const row   = toRow(mutableDoc);
    const keys  = Object.keys(row);
    keys.forEach(assertValidColumn);
    const cols  = keys.map(k => `"${k}"`).join(', ');
    const vals  = keys.map((_, i) => `$${i + 1}`).join(', ');
    const params = Object.values(row);
    await this._query(
      `INSERT INTO "${this.table}" (${cols}) VALUES (${vals}) ON CONFLICT (${primaryKeys.map(key => `"${key}"`).join(", ")}) DO NOTHING`,
      params
    );
    return { ...mutableDoc } as T;
  }

  // ── update ────────────────────────────────────────────────────
  async update(query: DbQuery<T>, update: DbUpdate<T>, _options?: unknown): Promise<{ updated: number | null }> {
    const { sql: whereSql, params: whereParams } = buildWhere(query);
    const setParts  = [];
    const setParams = [];

    if (update.$set) {
      const row = toRow(update.$set as Record<string, unknown>);
      for (const [k, v] of Object.entries(row)) {
        assertValidColumn(k);
        setParams.push(v);
        setParts.push(`"${k}" = $${setParams.length}`);
      }
    }

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc as Record<string, unknown>)) {
        assertValidColumn(k);
        setParams.push(v);
        setParts.push(`"${k}" = COALESCE("${k}", 0) + $${setParams.length}`);
      }
    }

    if (update.$push) {
      // JSONB array append — PostgreSQL JSONB operatörü
      for (const [k, v] of Object.entries(update.$push as Record<string, unknown>)) {
        assertValidColumn(k);
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
  async remove(query: DbQuery<T> = {}, _options?: unknown): Promise<{ deleted: number | null }> {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `DELETE FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return { deleted: res.rowCount };
  }

  // ── count ─────────────────────────────────────────────────────
  async count(query: DbQuery<T> = {}): Promise<number> {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `SELECT COUNT(*) AS n FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return parseInt(res.rows[0]?.n ?? 0);
  }

  // ── ensureIndex — PostgreSQL'de zaten schema.sql'de tanımlı ──
  async insertMany(docs: Array<DbInsert<T>>): Promise<T[]> {
    const inserted: T[] = [];
    for (const doc of docs) {
      inserted.push(await this.insert(doc));
    }
    return inserted;
  }

  ensureIndex(..._args: unknown[]): void {}
}

