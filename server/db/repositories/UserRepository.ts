// server/db/repositories/UserRepository.ts
// SECURITY: apPrivateKey artık users tablosunda değil — user_ap_keys tablosunda.
// Özel anahtara erişmek için yalnızca getApPrivateKey(userId) kullanın.
// Tüm findById / findByUsername vb. metotlar özel anahtarı DÖNDÜRMEZ.
//
// Şifreleme: apPrivateKey DB'de AES-256-GCM ile şifreli saklanır (apPrivateKeyEnc).
// Uygulama katmanı şifreleme: DB sızıntısında bile private key okunamaz.

import db from '../loader';
import type { UserStatus } from './types/entities';
import { encryptApPrivateKey, decryptApPrivateKey } from '../../lib/apKeyEncryption';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { parsePersistedNonNegativeInteger } from '../../lib/persistedInteger';


export interface X3dhPreKeyBundleResult {
  _id: string;
  identityKey: string | null;
  signedPreKey: { keyId: number; publicKey: string; signature: string } | null;
  oneTimePreKey: { keyId: number; publicKey: string } | null;
  remainingOneTimeKeys: number;
  invalidState?: boolean;
}

function parseX3dhSignedPreKey(value: unknown): X3dhPreKeyBundleResult['signedPreKey'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.keyId) || (v.keyId as number) < 0 || (v.keyId as number) > 2_147_483_647 ||
      typeof v.publicKey !== 'string' || v.publicKey.length < 1 || v.publicKey.length > 256 ||
      typeof v.signature !== 'string' || v.signature.length < 1 || v.signature.length > 512 ||
      Object.keys(v).some((key) => !['keyId', 'publicKey', 'signature'].includes(key))) return null;
  return { keyId: v.keyId as number, publicKey: v.publicKey, signature: v.signature };
}

function parseX3dhOneTimePreKey(value: unknown): X3dhPreKeyBundleResult['oneTimePreKey'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.keyId) || (v.keyId as number) < 0 || (v.keyId as number) > 2_147_483_647 ||
      typeof v.publicKey !== 'string' || v.publicKey.length < 1 || v.publicKey.length > 256 ||
      Object.keys(v).some((key) => !['keyId', 'publicKey'].includes(key))) return null;
  return { keyId: v.keyId as number, publicKey: v.publicKey };
}

// The fallback exists only for NODE_ENV=test, because production repository
// atomicity is PostgreSQL-owned. Serializing it keeps unit tests faithful to
// the one-time semantic instead of teaching them a racy read/modify/write.
const x3dhFallbackTails = new Map<string, Promise<void>>();
async function withX3dhFallbackLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = x3dhFallbackTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  x3dhFallbackTails.set(key, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (x3dhFallbackTails.get(key) === tail) x3dhFallbackTails.delete(key);
  }
}

const totpFallbackTails = new Map<string, Promise<void>>();
async function withTotpFallbackLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = totpFallbackTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  totpFallbackTails.set(key, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (totpFallbackTails.get(key) === tail) totpFallbackTails.delete(key);
  }
}

export interface RegistrationIdentityRow extends Record<string, unknown> {
  _id: string;
  username: string;
  displayName: string;
  password: string;
  avatarColor: string;
  avatarUrl: string | null;
  status: string;
  bio: string;
  tokenVersion: number;
  apPublicKey: string;
  createdAt: number;
}

class UserRepository {
  async findById(id: string) {
    return db.users.findOne({ _id: id });
  }

  async findByUsername(username: string) {
    return db.users.findOne({ username: username.toLowerCase() });
  }

  /**
   * ActivityPub actor URL → yerel kullanıcı (federation DM routing).
   *
   * Desteklenen formatlar:
   *   /api/federation/users/:username          — kendi instance'ımız
   *   /users/:username                         — yaygın AP sunucu paterni
   *   /u/:username  |  /accounts/:username     — Misskey / Pleroma varyantları
   *
   * Hiçbiri eşleşmezse null döner; uzun vadede webfinger lookup gerekebilir.
   */
  async findByApUrl(apUrl: string) {
    const url = String(apUrl);

    // 1) Kendi instance paterni (önce dene — en spesifik)
    const ownMatch = url.match(/\/api\/federation\/users\/([^/?#]+)/i);
    if (ownMatch?.[1]) return this.findByUsername(ownMatch[1]);

    // 2) Yaygın AP aktor path kalıpları
    const genericMatch = url.match(/\/(?:users|u|accounts)\/([^/?#]+)/i);
    if (genericMatch?.[1]) return this.findByUsername(genericMatch[1]);

    // 3) Eşleşme yok — webfinger lookup için yer tutucu
    return null;
  }

  async findByEmail(email: string) {
    if (!email) return null;
    return db.users.findOne({ email: String(email).toLowerCase() });
  }

  async findBySsoIdentity(provider: string, issuer: string, externalId: string) {
    if (!provider || !issuer || !externalId) return null;
    return db.users.findOne({ ssoProvider: provider, ssoIssuer: issuer, ssoId: externalId });
  }

  /**
   * Pre-058 SSO rows did not record the upstream issuer. They are deliberately
   * quarantined under a provider-specific sentinel by the migration and may be
   * upgraded only after the route verifies an operator-approved legacy issuer.
   */
  async findLegacySsoIdentity(provider: string, externalId: string) {
    if (!provider || !externalId) return null;
    return db.users.findOne({ ssoProvider: provider, ssoIssuer: `legacy:${provider}`, ssoId: externalId });
  }

  /** Atomically claim an otherwise-unbound local account for one SSO identity. */
  async claimSsoIdentity(userId: string, provider: string, issuer: string, externalId: string): Promise<boolean> {
    if (!userId || !provider || !issuer || !externalId) return false;
    const result = await db.users.update(
      { _id: userId, ssoProvider: null, ssoIssuer: null, ssoId: null },
      { $set: { ssoProvider: provider, ssoIssuer: issuer, ssoId: externalId } },
    );
    return result.updated === 1;
  }

  /** Atomically namespace one explicitly approved pre-058 identity binding. */
  async upgradeLegacySsoIdentity(userId: string, provider: string, issuer: string, externalId: string): Promise<boolean> {
    if (!userId || !provider || !issuer || !externalId) return false;
    const result = await db.users.update(
      { _id: userId, ssoProvider: provider, ssoIssuer: `legacy:${provider}`, ssoId: externalId },
      { $set: { ssoIssuer: issuer } },
    );
    return result.updated === 1;
  }

  async findByEmailToken(token: string) {
    return db.users.findOne({ emailToken: token });
  }

  async create(data: Record<string, unknown>) {
    return db.users.insert(data);
  }

  /**
   * Registration has two durable identity records: the public user row and the
   * encrypted ActivityPub signing key. They must appear atomically. Creating the
   * user first and saving the key afterwards leaves an unusable half-account when
   * the second write fails, and a retry then reports "username already taken".
   */
  async createWithApKeys(
    data: Record<string, unknown>,
    apPublicKey: string,
    apPrivateKey: string,
  ): Promise<RegistrationIdentityRow> {
    const id = data._id;
    const username = data.username;
    const displayName = data.displayName;
    const password = data.password;
    const avatarColor = data.avatarColor;
    const avatarUrl = data.avatarUrl ?? null;
    const status = data.status ?? 'offline';
    const bio = data.bio ?? '';
    const tokenVersion = data.tokenVersion ?? 0;
    const createdAt = data.createdAt;

    if (typeof id !== 'string' || !id || typeof username !== 'string' || !username ||
        typeof displayName !== 'string' || !displayName || typeof password !== 'string' || !password ||
        typeof avatarColor !== 'string' || !avatarColor || typeof status !== 'string' || !status ||
        typeof bio !== 'string' || typeof tokenVersion !== 'number' || !Number.isSafeInteger(tokenVersion) || tokenVersion < 0 ||
        typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0 ||
        !apPublicKey || !apPrivateKey) {
      throw new TypeError('invalid registration identity data');
    }

    const apPrivateKeyEnc = encryptApPrivateKey(apPrivateKey);
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'UserRepository ActivityPub identity transaction');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query<RegistrationIdentityRow>(
          `INSERT INTO users
             (_id, username, "displayName", password, "avatarColor", "avatarUrl", status, bio, "tokenVersion", "apPublicKey", "createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING *`,
          [id, username, displayName, password, avatarColor, avatarUrl, status, bio, tokenVersion, apPublicKey, createdAt],
        );
        await client.query(
          `INSERT INTO user_ap_keys ("userId","apPrivateKeyEnc","keyVersion","createdAt","updatedAt")
           VALUES ($1,$2,1,$3,$3)`,
          [id, apPrivateKeyEnc, createdAt],
        );
        const user = inserted.rows[0];
        if (!user) throw new Error('registration user insert returned no row');
        await client.query('COMMIT');
        return user;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
        throw err;
      } finally {
        client.release();
      }
    }

    // Collection/test fallback cannot share a PostgreSQL transaction. Compensate
    // immediately on key-write failure so single-process development still keeps
    // the same all-or-nothing observable contract.
    let created = false;
    try {
      const user = await db.users.insert({ ...data, apPublicKey });
      created = true;
      await this.saveApKeys(id, apPublicKey, apPrivateKey);
      return user as unknown as RegistrationIdentityRow;
    } catch (err) {
      if (created) {
        try { await db.users.remove({ _id: id }); } catch { /* preserve original failure */ }
      }
      throw err;
    }
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.users.update({ _id: id }, { $set: fields });
  }

  async updateWhere(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.users.update(filter, modifier);
  }

  /**
   * Atomically fetch an X3DH public bundle and consume at most one OTPK.
   *
   * A previous route did findById -> choose otpks[0] -> update(slice(1)). Two
   * concurrent senders could therefore receive the SAME one-time prekey. The
   * PostgreSQL path locks the user row and returns identity/signed/OTPK state
   * from one statement, so a concurrent bundle replacement cannot be mixed
   * with an older identity key either.
   */
  async consumeX3dhPreKeyBundle(userId: string): Promise<X3dhPreKeyBundleResult | null> {
    if (!userId) throw new TypeError('userId is required');
    const rawPool = (db as unknown as { _pool?: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } })._pool;
    const pool = postgresPoolOrTestFallback(typeof rawPool?.query === 'function' ? rawPool : null, 'UserRepository consumeX3dhPreKeyBundle');

    if (pool) {
      const result = await pool.query(
        `WITH candidate AS (
           SELECT _id,
                  "x3dhIdentityKey" AS identity_key,
                  "x3dhSignedPreKey" AS signed_pre_key,
                  CASE
                    WHEN jsonb_typeof("x3dhOneTimePreKeys") = 'array'
                     AND jsonb_array_length("x3dhOneTimePreKeys") > 0
                    THEN "x3dhOneTimePreKeys" -> 0
                    ELSE NULL
                  END AS one_time_pre_key,
                  CASE
                    WHEN jsonb_typeof("x3dhOneTimePreKeys") = 'array'
                     AND jsonb_array_length("x3dhOneTimePreKeys") > 0
                    THEN "x3dhOneTimePreKeys" - 0
                    ELSE COALESCE("x3dhOneTimePreKeys", '[]'::jsonb)
                  END AS remaining_keys
             FROM users
            WHERE _id = $1
            FOR UPDATE
         )
         UPDATE users u
            SET "x3dhOneTimePreKeys" = c.remaining_keys
           FROM candidate c
          WHERE u._id = c._id
         RETURNING u._id, c.identity_key, c.signed_pre_key, c.one_time_pre_key,
                   jsonb_array_length(c.remaining_keys) AS remaining_count`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const remaining = parsePersistedNonNegativeInteger(row.remaining_count, 'persisted X3DH remaining prekey count');
      const signedPreKey = parseX3dhSignedPreKey(row.signed_pre_key);
      const oneTimePreKey = parseX3dhOneTimePreKey(row.one_time_pre_key);
      return {
        _id: String(row._id),
        identityKey: typeof row.identity_key === 'string' ? row.identity_key : null,
        signedPreKey,
        oneTimePreKey,
        remainingOneTimeKeys: remaining,
        invalidState: (row.signed_pre_key !== null && !signedPreKey) ||
          (row.one_time_pre_key !== null && !oneTimePreKey) ||
          (row.identity_key !== null && typeof row.identity_key !== 'string'),
      };
    }

    return withX3dhFallbackLock(userId, async () => {
      const user = await db.users.findOne({ _id: userId }) as Record<string, unknown> | null;
      if (!user) return null;
      const rawKeys = user.x3dhOneTimePreKeys;
      const keys = Array.isArray(rawKeys) ? rawKeys : [];
      const first = keys[0];
      const remaining = first === undefined ? keys : keys.slice(1);
      if (first !== undefined) {
        await db.users.update({ _id: userId }, { $set: { x3dhOneTimePreKeys: remaining } });
      }
      const signedPreKey = parseX3dhSignedPreKey(user.x3dhSignedPreKey);
      const oneTimePreKey = parseX3dhOneTimePreKey(first);
      return {
        _id: String(user._id),
        identityKey: typeof user.x3dhIdentityKey === 'string' ? user.x3dhIdentityKey : null,
        signedPreKey,
        oneTimePreKey,
        remainingOneTimeKeys: remaining.length,
        invalidState: (user.x3dhSignedPreKey !== null && user.x3dhSignedPreKey !== undefined && !signedPreKey) ||
          (first !== null && first !== undefined && !oneTimePreKey) ||
          (user.x3dhIdentityKey !== null && user.x3dhIdentityKey !== undefined && typeof user.x3dhIdentityKey !== 'string'),
      };
    });
  }

  /**
   * 2FA yedek kodunu ATOMIK olarak tuketir.
   *
   * ══════════════════════════════════════════════════════════════════════════
   * KAPATILAN GERCEK ACIK (P2) — TEK KULLANIMLIK GARANTISI IHLALI
   * ══════════════════════════════════════════════════════════════════════════
   * Rota su deseni kullaniyordu:
   *
   *     const backups = readBackupCodes(user.twoFactorBackup);  // OKU
   *     const idx = backups.findIndex(...);                     // KONTROL
   *     backups.splice(idx, 1);                                 // DEGISTIR
   *     await Users.update(user._id, { twoFactorBackup: ... }); // YAZ
   *
   * Klasik bir TOCTOU. GERCEK PostgreSQL'e karsi IKI AYRI BAGLANTIYLA
   * olculdu (scripts/backup-code-race-probe.cjs):
   *
   *     ES ZAMANLI BASARILI KULLANIM: 2 / 2   → IHLAL
   *
   * Yani tek kullanimlik bir yedek kod es zamanli olarak IKI KEZ
   * tuketilebiliyordu. Mock veritabani bunu GIZLIYORDU (orada 1/2 goruluyordu),
   * bu yuzden yalnizca birim testine guvenmek yeterli degildi.
   *
   * DUZELTME: tek bir kosullu UPDATE. `@>` iceriyor mu diye bakar ve `-`
   * ile ogeyi cikarir; ikisi ayni ifadede oldugu icin YARIS PENCERESI YOKTUR.
   * `rowCount` yarisi kimin kazandigini soyler.
   *
   * @returns kodu BU cagri tukettiyse true; baskasi onceden tukettiyse false.
   */
  async consumeBackupCode(userId: string, stored: string): Promise<boolean> {
    const rawPool = (db as unknown as { _pool?: { query: (sql: string, params: unknown[]) => Promise<{ rowCount?: number }> } })._pool;
    const pool = postgresPoolOrTestFallback(typeof rawPool?.query === 'function' ? rawPool : null, 'UserRepository consumeBackupCode');

    if (pool) {
      const r = await pool.query(
        `UPDATE users
            SET "twoFactorBackup" = "twoFactorBackup" - $2
          WHERE _id = $1
            AND "twoFactorBackup" @> $3::jsonb`,
        [userId, stored, JSON.stringify([stored])],
      );
      // Kosullu UPDATE ISLEDIYSE yarisi KAZANDIK — bitti.
      if ((r?.rowCount ?? 0) > 0) return true;

      // rowCount 0 IKI ANLAMA gelebilir:
      //   (a) yarisi KAYBETTIK — kod baskasi tarafindan tuketildi
      //   (b) karsimizdaki gercek bir PostgreSQL havuzu DEGIL (test cifti)
      // Ikisini ayirt etmenin dogru yolu SQL'i tahmin etmek degil, DURUMU
      // OKUMAKTIR. Asagidaki yol kodu yeniden arar:
      //   • gercek Postgres'te yarisi kaybettiysek kod ARTIK YOK -> false
      //   • test cifti ise kod hâlâ durur -> normal sekilde tuketilir
      // Boylece her iki ortamda da DOGRU semantik elde edilir.
    }

    // POSTGRES DISI YOL (koleksiyon API / testler): atomik kosullu guncelleme
    // yok. Once-oku-sonra-yaz yapilir ama kodun HALA orada oldugu yeniden
    // dogrulanir; tek surecli kullanimda tek kullanimligi korur.
    const user = await db.users.findOne({ _id: userId }) as { twoFactorBackup?: unknown } | null;
    if (!user) return false;
    const raw = user.twoFactorBackup;
    const validBackup = (value: unknown): value is string =>
      typeof value === 'string' && value.length >= 8 && value.length <= 128;
    const list: string[] = Array.isArray(raw)
      ? raw.filter(validBackup)
      : (() => {
          try {
            const p = JSON.parse(String(raw ?? '[]'));
            return Array.isArray(p) ? p.filter(validBackup) : [];
          } catch { return []; }
        })();

    const idx = list.indexOf(stored);
    if (idx === -1) return false;
    list.splice(idx, 1);
    await db.users.update({ _id: userId }, { $set: { twoFactorBackup: JSON.stringify(list) } });
    return true;
  }

  /** Atomically enable TOTP and record the setup code's time-step as consumed. */
  async enableTwoFactorWithStep(userId: string, secret: string, step: number, backupHashes: string[]): Promise<boolean> {
    if (!userId || !secret || !Number.isSafeInteger(step) || step < 0 ||
        !Array.isArray(backupHashes) || backupHashes.some((v) => !/^[a-f0-9]{64}$/.test(v))) {
      throw new TypeError('invalid two-factor activation state');
    }
    const rawPool = (db as unknown as { _pool?: { query: (sql: string, params: unknown[]) => Promise<{ rowCount?: number }> } })._pool;
    const pool = postgresPoolOrTestFallback(typeof rawPool?.query === 'function' ? rawPool : null, 'UserRepository enableTwoFactorWithStep');
    if (pool) {
      const result = await pool.query(
        `UPDATE users
            SET "twoFactorEnabled" = TRUE,
                "twoFactorBackup" = $4::jsonb,
                "twoFactorLastUsedStep" = $3
          WHERE _id = $1
            AND "twoFactorSecret" = $2
            AND "twoFactorEnabled" = FALSE`,
        [userId, secret, step, JSON.stringify(backupHashes)],
      );
      return (result.rowCount ?? 0) === 1;
    }
    return withTotpFallbackLock(userId, async () => {
      const current = await db.users.findOne({ _id: userId }) as Record<string, unknown> | null;
      if (!current || current.twoFactorEnabled || current.twoFactorSecret !== secret) return false;
      await db.users.update({ _id: userId }, { $set: {
        twoFactorEnabled: 1,
        twoFactorBackup: JSON.stringify(backupHashes),
        twoFactorLastUsedStep: step,
      } });
      return true;
    });
  }

  /**
   * Consume a TOTP time-step exactly once. The monotonic conditional update is
   * shared by login and other sensitive TOTP-confirmed operations, preventing
   * the same 30-second code from authorizing independent concurrent requests.
   */
  async consumeTotpStep(userId: string, step: number): Promise<boolean> {
    if (!userId || !Number.isSafeInteger(step) || step < 0) throw new TypeError('invalid TOTP step');
    const rawPool = (db as unknown as { _pool?: { query: (sql: string, params: unknown[]) => Promise<{ rowCount?: number }> } })._pool;
    const pool = postgresPoolOrTestFallback(typeof rawPool?.query === 'function' ? rawPool : null, 'UserRepository consumeTotpStep');
    if (pool) {
      const result = await pool.query(
        `UPDATE users
            SET "twoFactorLastUsedStep" = $2
          WHERE _id = $1
            AND "twoFactorEnabled" = TRUE
            AND ("twoFactorLastUsedStep" IS NULL OR "twoFactorLastUsedStep" < $2)`,
        [userId, step],
      );
      return (result.rowCount ?? 0) === 1;
    }
    return withTotpFallbackLock(userId, async () => {
      const current = await db.users.findOne({ _id: userId }) as Record<string, unknown> | null;
      if (!current?.twoFactorEnabled) return false;
      let previous = -1;
      if (current.twoFactorLastUsedStep !== null && current.twoFactorLastUsedStep !== undefined) {
        try { previous = parsePersistedNonNegativeInteger(current.twoFactorLastUsedStep, 'persisted TOTP step'); }
        catch { return false; }
      }
      if (previous >= step) return false;
      await db.users.update({ _id: userId }, { $set: { twoFactorLastUsedStep: step } });
      return true;
    });
  }

  async setStatus(id: string, status: UserStatus) {
    return db.users.update({ _id: id }, { $set: { status } });
  }

  async incrementTokenVersion(id: string) {
    return db.users.update({ _id: id }, { $inc: { tokenVersion: 1 } });
  }

  async findByIds(ids: string[]) {
    return db.users.find({ _id: { $in: ids } });
  }

  async findByUsernames(usernames: string[]) {
    const lower = usernames.map((u: string) => u.toLowerCase());
    return db.users.find({ username: { $in: lower } });
  }

  async count(query: Record<string, unknown> = {}) {
    return db.users.count(query);
  }

  async delete(id: string) {
    return db.users.remove({ _id: id });
  }

  async searchPaginated(query: Record<string, unknown>, { skip = 0, limit = 50 } = {}) {
    return db.users.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);
  }

  async findWhere(query: Record<string, unknown>) {
    return db.users.find(query);
  }

  // ── ActivityPub özel anahtar — AYRI TABLO + ŞİFRELİ ─────────────────────
  // apPrivateKey users tablosunda bulunmaz; SELECT * sorgularına dahil olmaz.
  // DB'de AES-256-GCM şifreli saklanır (apPrivateKeyEnc).
  // Yalnızca federation imzalama operasyonları bu metodu çağırmalıdır.

  async getApPrivateKey(userId: string): Promise<string | null> {
    const row = await db.userApKeys.findOne({ userId });
    const encrypted = row?.apPrivateKeyEnc;
    if (typeof encrypted !== 'string') return null;
    return decryptApPrivateKey(encrypted);
  }

  private apKeyWriteTail: Promise<void> = Promise.resolve();

  async saveApKeys(userId: string, apPublicKey: string, apPrivateKey: string): Promise<void> {
    if (!userId || !apPublicKey || !apPrivateKey) throw new TypeError('invalid ActivityPub key material');
    const apPrivateKeyEnc = encryptApPrivateKey(apPrivateKey);
    const now = Date.now();
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'UserRepository saveApKeys');

    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const userUpdate = await client.query(
          'UPDATE users SET "apPublicKey"=$2 WHERE _id=$1',
          [userId, apPublicKey],
        );
        if (userUpdate.rowCount !== 1) throw new Error('ActivityPub key owner not found');
        await client.query(
          `INSERT INTO user_ap_keys ("userId","apPrivateKeyEnc","keyVersion","createdAt","updatedAt")
           VALUES ($1,$2,1,$3,$3)
           ON CONFLICT ("userId") DO UPDATE
           SET "apPrivateKeyEnc"=EXCLUDED."apPrivateKeyEnc",
               "keyVersion"=user_ap_keys."keyVersion" + 1,
               "updatedAt"=EXCLUDED."updatedAt"`,
          [userId, apPrivateKeyEnc, now],
        );
        await client.query('COMMIT');
        return;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
        throw err;
      } finally {
        client.release();
      }
    }

    // Test/non-PG compatibility path. Serialize the pair so two local writes
    // cannot interleave and produce mismatched public/private key material.
    let release!: () => void;
    const previous = this.apKeyWriteTail;
    this.apKeyWriteTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const owner = await db.users.findOne({ _id: userId });
      if (!owner) throw new Error('ActivityPub key owner not found');
      const existing = await db.userApKeys.findOne({ userId });
      if (existing) {
        const currentVersion = parsePersistedNonNegativeInteger(existing.keyVersion, 'ActivityPub keyVersion', { defaultWhenMissing: 1, max: 2_147_483_646 });
        if (currentVersion < 1) throw new Error('Invalid ActivityPub keyVersion');
        await db.userApKeys.update({ userId }, { $set: { apPrivateKeyEnc, keyVersion: currentVersion + 1, updatedAt: now } });
      } else {
        await db.userApKeys.insert({ userId, apPrivateKeyEnc, keyVersion: 1, createdAt: now, updatedAt: now });
      }
      await db.users.update({ _id: userId }, { $set: { apPublicKey } });
    } finally {
      release();
    }
  }

  async deleteApKeys(userId: string): Promise<void> {
    if (!userId) throw new TypeError('userId required');
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'UserRepository ActivityPub identity transaction');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM user_ap_keys WHERE "userId"=$1', [userId]);
        await client.query('UPDATE users SET "apPublicKey"=NULL WHERE _id=$1', [userId]);
        await client.query('COMMIT');
        return;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
        throw err;
      } finally {
        client.release();
      }
    }
    await db.userApKeys.remove({ userId });
    await db.users.update({ _id: userId }, { $set: { apPublicKey: null } });
  }

}

export default new UserRepository();
