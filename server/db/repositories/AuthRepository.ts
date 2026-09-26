// server/db/repositories/AuthRepository.ts
// Kimlik doğrulama nesneleri (refresh token, WebAuthn, audit log) sorgularını toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { parseTokenVersion } from '../../lib/tokenVersion';
import { parsePersistedEpochMillis } from '../../lib/persistedEpoch';
import { parsePersistedNonNegativeInteger } from '../../lib/persistedInteger';

class AuthRepository {
  private refreshStore() {
    const store = db.refreshTokens;
    if (!store) throw new Error('Refresh-token store is unavailable');
    return store;
  }
  private adminLogStore() {
    const store = db.adminLogs;
    if (!store) throw new Error('Admin-log store is unavailable');
    return store;
  }
  private auditLogStore() {
    const store = db.auditLogs;
    if (!store) throw new Error('Audit-log store is unavailable');
    return store;
  }

  private credentialCounterTail: Promise<void> = Promise.resolve();

  // ── Refresh Tokens ─────────────────────────────────────────

  async findRefreshToken(token: string) {
    return this.refreshStore().findOne({ token });
  }

  async insertRefreshToken(userId: string, token: string, expiresAt: number, tokenVersion: number) {
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 256 ||
        typeof token !== 'string' || token.length < 1 || token.length > 512 ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() ||
        !Number.isSafeInteger(tokenVersion) || tokenVersion < 0) {
      throw new TypeError('Invalid refresh-token row');
    }
    return this.refreshStore().insert({ userId, token, expiresAt, tokenVersion, createdAt: Date.now() });
  }

  async revokeRefreshToken(token: string) {
    return this.refreshStore().remove({ token });
  }

  async revokeAllForUser(userId: string) {
    return this.refreshStore().remove({ userId });
  }

  /**
   * Token ailesi saldırısı tespitinde tüm aile token'larını iptal eder.
   * Bir token iki kez kullanıldığında (reuse), aynı family değerine sahip
   * tüm token'lar silinir — meşru oturum da kapatılmış olur.
   * Bu, token çalınması durumunda saldırganı sistemden atar.
   */
  async revokeByFamily(family: string) {
    if (!family) return;
    return this.refreshStore().remove({ family });
  }

  async findByFamily(family: string) {
    if (!family) return [];
    const result = await this.refreshStore().find({ family });
    if (!Array.isArray(result)) throw new Error('Refresh-token store returned an invalid result');
    return result;
  }

  async updateRefreshTokenWhere(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return this.refreshStore().update(filter, modifier);
  }

  async removeRefreshTokensWhere(filter: Record<string, unknown>) {
    return this.refreshStore().remove(filter);
  }

  /**
   * PostgreSQL refresh rotation must be one transaction guarded by a row lock.
   * Returning null means the caller is running on the in-memory test adapter
   * and should use its serialized fallback instead.
   */
  async rotateRefreshTokenAtomic(input: {
    oldTokenHash: string;
    newTokenHash: string;
    newFamily: string;
    now: number;
    expiresAt: number;
  }): Promise<
    | { status: 'ok'; user: Record<string, unknown> }
    | { status: 'reuse' | 'expired' | 'not_found' | 'user_not_found' | 'revoked' }
    | null
  > {
    if (!input.oldTokenHash || !input.newTokenHash || !input.newFamily ||
        !Number.isSafeInteger(input.now) || input.now < 0 ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now) {
      throw new TypeError('Invalid refresh-token rotation input');
    }
    if (process.env.NODE_ENV === 'test') return null;

    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'atomic refresh-token rotation',
    );
    if (!pool?.connect) throw new Error('PostgreSQL pool cannot connect for atomic refresh-token rotation');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{
        token: string; userId: string; expiresAt: number | string; used: boolean | number; family: string | null; tokenVersion: number | string;
      }>(
        `SELECT token, "userId", "expiresAt", used, family, "tokenVersion"
           FROM refresh_tokens
          WHERE token = $1
          FOR UPDATE`,
        [input.oldTokenHash],
      );
      const row = selected.rows[0];

      if (!row) {
        await client.query('COMMIT');
        return { status: 'not_found' };
      }

      if (row.used === true || row.used === 1) {
        if (row.family) {
          await client.query('DELETE FROM refresh_tokens WHERE family = $1', [row.family]);
        } else {
          await client.query('DELETE FROM refresh_tokens WHERE "userId" = $1', [row.userId]);
        }
        await client.query('COMMIT');
        return { status: 'reuse' };
      }

      let rowExpiresAt: number | null;
      try {
        rowExpiresAt = parsePersistedEpochMillis(row.expiresAt);
      } catch {
        // A malformed persisted security timestamp is not a usable session.
        // Revoke the row instead of accepting JavaScript coercions such as
        // whitespace, hex, exponent notation or fractional text.
        rowExpiresAt = null;
      }
      if (rowExpiresAt === null || rowExpiresAt <= input.now) {
        await client.query('DELETE FROM refresh_tokens WHERE token = $1', [row.token]);
        await client.query('COMMIT');
        return { status: 'expired' };
      }

      const foundUser = await client.query<Record<string, unknown>>(
        'SELECT * FROM users WHERE _id = $1',
        [row.userId],
      );
      const user = foundUser.rows[0];
      if (!user) {
        await client.query('DELETE FROM refresh_tokens WHERE token = $1', [row.token]);
        await client.query('COMMIT');
        return { status: 'user_not_found' };
      }

      let issuedVersion: number | null = null;
      let currentVersion: number | null = null;
      try {
        // Migration 052 makes the issuance version mandatory. Missing or
        // non-canonical persisted values are therefore security-state
        // corruption and must revoke the session rather than coerce to zero.
        if (row.tokenVersion === null || row.tokenVersion === undefined) throw new TypeError('Missing refresh tokenVersion');
        issuedVersion = parseTokenVersion(row.tokenVersion);
        currentVersion = parseTokenVersion(user.tokenVersion);
      } catch {
        issuedVersion = null;
        currentVersion = null;
      }
      if (issuedVersion === null || currentVersion === null || issuedVersion !== currentVersion) {
        if (row.family) {
          await client.query('DELETE FROM refresh_tokens WHERE family = $1', [row.family]);
        } else {
          await client.query('DELETE FROM refresh_tokens WHERE token = $1', [row.token]);
        }
        await client.query('COMMIT');
        return { status: 'revoked' };
      }

      // Legacy rows may predate token families. Assign one while the row is
      // locked so a later replay revokes exactly this chain, not unrelated sessions.
      const family = row.family || input.newFamily;
      await client.query(
        `UPDATE refresh_tokens
            SET used = TRUE, "usedAt" = $2, family = $3
          WHERE token = $1`,
        [row.token, input.now, family],
      );
      await client.query(
        `INSERT INTO refresh_tokens
           (token, "userId", "expiresAt", "createdAt", used, "usedAt", family, "tokenVersion")
         VALUES ($1, $2, $3, $4, FALSE, NULL, $5, $6)`,
        [input.newTokenHash, row.userId, input.expiresAt, input.now, family, currentVersion],
      );

      await client.query('COMMIT');
      return { status: 'ok', user };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Tam satır ekleme (rotation / family alanları dahil). */
  async insertRefreshTokenRow(row: Record<string, unknown>) {
    const userId = row.userId;
    const token = row.token;
    const expiresAt = row.expiresAt;
    const tokenVersion = row.tokenVersion;
    const family = row.family;
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 256 ||
        typeof token !== 'string' || token.length < 1 || token.length > 512 ||
        typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() ||
        typeof tokenVersion !== 'number' || !Number.isSafeInteger(tokenVersion) || tokenVersion < 0 ||
        (family !== undefined && family !== null && (typeof family !== 'string' || family.length < 1 || family.length > 256))) {
      throw new TypeError('Invalid refresh-token row');
    }
    const normalizedFamily: string | undefined = typeof family === 'string' ? family : undefined;
    return this.refreshStore().insert({
      ...row,
      userId,
      token,
      expiresAt,
      tokenVersion,
      family: normalizedFamily,
      createdAt: Date.now(),
      used: false,
    });
  }

  // ── WebAuthn Credentials ───────────────────────────────────

  /**
   * WebAuthn credentials have one canonical owner: `webauthn_credentials`.
   * PostgreSQL `users` has no embedded credential / webauthnEnabled columns;
   * silently falling back to those phantom fields turns schema drift into either
   * a 500 or, worse, a second credential authority. Fail closed instead.
   */
  private webauthnCollection() {
    const collection = db.webauthnCredentials;
    if (!collection) throw new Error('WebAuthn credential store is unavailable');
    return collection;
  }

  hasWebauthnCollection() {
    return Boolean(db.webauthnCredentials);
  }

  async findCredential(credentialId: string) {
    return this.webauthnCollection().findOne({ credentialId });
  }

  async findCredentialByDocId(id: string, userId?: string) {
    const query: Record<string, unknown> = { _id: id };
    if (userId) query.userId = userId;
    return this.webauthnCollection().findOne(query);
  }

  async findCredentialsByUser(userId: string) {
    return this.webauthnCollection().find({ userId });
  }

  async insertCredential(data: Record<string, unknown>) {
    return this.webauthnCollection().insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateCredential(credentialId: string, fields: Record<string, unknown>) {
    return this.webauthnCollection().update({ credentialId }, { $set: fields });
  }

  async updateCredentialByDocId(id: string, fields: Record<string, unknown>) {
    return this.webauthnCollection().update({ _id: id }, { $set: fields });
  }

  /**
   * Monotonically advance the authenticator signature counter. The check and
   * write are one SQL statement so concurrent valid assertions cannot write
   * an older counter after a newer one and weaken clone/replay detection.
   */
  async advanceCredentialCounterByDocId(id: string, observedCounter: number, lastUsedAt = Date.now()): Promise<boolean> {
    if (!id || !Number.isSafeInteger(observedCounter) || observedCounter < 0 || observedCounter > 0xffffffff ||
        !Number.isSafeInteger(lastUsedAt) || lastUsedAt < 0) {
      throw new TypeError('Invalid WebAuthn counter update');
    }
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'AuthRepository advanceCredentialCounterByDocId');
    if (pool) {
      if (observedCounter === 0) {
        // Counterless authenticators are valid only while the stored counter
        // is also zero. Once a credential has ever produced a non-zero counter,
        // accepting a later zero would erase clone/replay detection semantics.
        const res = await pool.query(
          'UPDATE webauthn_credentials SET "lastUsedAt"=$2 WHERE _id=$1 AND counter=0',
          [id, lastUsedAt],
        );
        return res.rowCount === 1;
      }
      const res = await pool.query(
        `UPDATE webauthn_credentials
            SET counter=$2,"lastUsedAt"=$3
          WHERE _id=$1 AND (counter=0 OR counter < $2)`,
        [id, observedCounter, lastUsedAt],
      );
      return res.rowCount === 1;
    }

    let release!: () => void;
    const previous = this.credentialCounterTail;
    this.credentialCounterTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const current = await this.findCredentialByDocId(id) as { counter?: unknown; signCount?: unknown } | null;
      if (!current) return false;
      const rawCurrent = current.counter ?? current.signCount ?? 0;
      const currentCounter = parsePersistedNonNegativeInteger(rawCurrent, 'persisted WebAuthn counter', { max: 0xffffffff });
      if ((observedCounter !== 0 || currentCounter !== 0) && observedCounter <= currentCounter) return false;
      await this.updateCredentialByDocId(id, { counter: observedCounter, lastUsedAt });
      return true;
    } finally {
      release();
    }
  }

  async deleteCredential(id: string, userId: string) {
    return this.webauthnCollection().remove({ _id: id, userId });
  }

  // ── Admin / Audit Logs ─────────────────────────────────────

  async insertAdminLog(data: Record<string, unknown>) {
    return this.adminLogStore().insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findAdminLogs(query: Record<string, unknown> = {}, limit = 100) {
    return this.adminLogStore().find(query).sort({ createdAt: -1 }).limit(limit) ?? [];
  }

  async insertAuditLog(data: Record<string, unknown>) {
    return this.auditLogStore().insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findAuditLogs(serverId: string, limit = 50) {
    return this.auditLogStore().find({ serverId }).sort({ createdAt: -1 }).limit(limit) ?? [];
  }

  async getAuditLog(serverId: string, opts: number | {
    limit?: number; offset?: number; action?: string; after?: number; before?: number;
  } = 50) {
    const limit = typeof opts === 'number' ? opts : (opts.limit ?? 50);
    const offset = typeof opts === 'number' ? 0 : (opts.offset ?? 0);
    const action = typeof opts === 'number' ? undefined : opts.action;
    const query: Record<string, unknown> = { serverId };
    if (action) query.action = action;
    if (typeof opts !== 'number' && (opts.after !== undefined || opts.before !== undefined)) {
      query.createdAt = {
        ...(opts.after !== undefined ? { $gte: opts.after } : {}),
        ...(opts.before !== undefined ? { $lte: opts.before } : {}),
      };
    }
    const entries = await this.auditLogStore().find(query).sort({ createdAt: -1 }).skip(offset).limit(limit) ?? [];
    const total = await this.auditLogStore().count(query) ?? entries.length;
    return { entries, total };
  }

  async findAuditLogsWhere(query: Record<string, unknown>) {
    return this.auditLogStore().find(query).sort({ createdAt: -1 }) ?? [];
  }

  auditLogsFind(query: Record<string, unknown>) {
    return this.auditLogStore().find(query);
  }
}

const authRepository = new AuthRepository();
export default authRepository;

// CommonJS compatibility for legacy test suites/importers.
module.exports = authRepository;
module.exports.default = authRepository;
