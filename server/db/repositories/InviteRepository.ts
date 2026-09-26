// server/db/repositories/InviteRepository.ts
// Davet kodu sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { parsePersistedEpochMillis } from '../../lib/persistedEpoch';
import { parsePersistedNonNegativeInteger } from '../../lib/persistedInteger';

/**
 * Yalnız "aynı davet kodu zaten var" hatasını tanır. Bağlantı kopması,
 * izin hatası vb. FALSE döner ve çağıran tarafından yükseltilir.
 */
function isDuplicateCodeError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e) return false;
  if (e.code === '23505') return true;                      // PostgreSQL unique_violation
  return typeof e.message === 'string' && /duplicate key|unique constraint/i.test(e.message);
}

export type InviteConsumeResult =
  | { status: 'ok'; uses: number }
  | { status: 'not_found' | 'expired' | 'max_uses' | 'already_member' | 'banned' | 'scope_mismatch' };

class InviteRepository {
  async findByCode(code: string) {
    return db.invites.findOne({ code });
  }

  async findByServer(serverId: string) {
    return db.invites.find({ serverId });
  }

  async create({ serverId, createdBy, maxUses = 0, ttlMs = 7 * 24 * 60 * 60 * 1000 }: { serverId: string; createdBy: string; maxUses?: number; ttlMs?: number }) {
    const expiresAt = Date.now() + ttlMs;

    // Faz 10.10 — ÇAKIŞMA DAYANIKLILIĞI.
    //
    // `invites.code` UNIQUE'tir (db/postgres/schema.ts) ama üretilen kod
    // uuid'in yalnız ilk bloğudur — 8 hex karakter. Çakışma nadirdir; olduğunda
    // sürücü duplicate-key (PostgreSQL 23505) fırlatıyor ve kullanıcı 500
    // görüyordu (tests/invite-security.test.ts ile kanıtlandı).
    //
    // YALNIZ çakışma yeniden denenir; başka hiçbir veritabanı hatası yutulmaz.
    // Şema değişmez, UNIQUE kısıtı gevşetilmez, kriptografik rastgelelik korunur.
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const code = uuidv4().split('-')[0];
      try {
        await db.invites.insert({ _id: uuidv4(), code, serverId, createdBy, expiresAt, maxUses, uses: 0 });
        return { code, expiresAt, maxUses };
      } catch (err) {
        lastErr = err;
        if (!isDuplicateCodeError(err)) throw err;   // alakasız hata olduğu gibi yükselir
      }
    }
    throw lastErr;
  }

  /**
   * Atomically consume an invite slot and create the membership.
   *
   * The invite row is locked before expiry/maxUses checks. Membership insert
   * and uses increment share the same PostgreSQL transaction, so two callers
   * cannot both consume the final slot and a failed/conflicting membership
   * never burns an invite use. Unit tests keep the in-memory compatibility
   * path; production must have a real Pool or fail closed.
   */
  async consumeForMemberAtomic(
    id: string,
    userId: string,
    expectedServerId: string,
    now = Date.now(),
  ): Promise<InviteConsumeResult | null> {
    if (process.env.NODE_ENV === 'test') return null;
    const pool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    if (!pool) throw new Error('PostgreSQL pool unavailable for atomic invite consumption');

    const client = await pool.connect();
    const rollback = async (status: Exclude<InviteConsumeResult['status'], 'ok'>): Promise<InviteConsumeResult> => {
      await client.query('ROLLBACK');
      return { status };
    };
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        _id: string; serverId: string; expiresAt: number | string; maxUses: number | string; uses: number | string;
      }>(
        'SELECT _id, "serverId", "expiresAt", "maxUses", uses FROM invites WHERE _id = $1 FOR UPDATE',
        [id],
      );
      if (!found.rows.length) return await rollback('not_found');

      const invite = found.rows[0]!;
      if (String(invite.serverId) !== expectedServerId) return await rollback('scope_mismatch');
      let inviteExpiresAt: number | null;
      try { inviteExpiresAt = parsePersistedEpochMillis(invite.expiresAt); }
      catch { return await rollback('expired'); }
      if (inviteExpiresAt === null || inviteExpiresAt <= now) return await rollback('expired');
      let maxUses: number;
      let uses: number;
      try {
        maxUses = parsePersistedNonNegativeInteger(invite.maxUses, 'invite maxUses', { max: 2_147_483_647 });
        uses = parsePersistedNonNegativeInteger(invite.uses, 'invite uses', { max: 2_147_483_647 });
      } catch {
        // Corrupt quota state must never turn a bounded invite into an unlimited one.
        return await rollback('max_uses');
      }
      if (maxUses > 0 && uses >= maxUses) return await rollback('max_uses');

      const inserted = await client.query<{ userId: string }>(
        `INSERT INTO members ("userId", "serverId", "joinedAt")
         VALUES ($1, $2, $3)
         ON CONFLICT ("userId", "serverId") DO NOTHING
         RETURNING "userId"`,
        [userId, expectedServerId, now],
      );
      if (!inserted.rows.length) {
        const existing = await client.query<{ banned: boolean }>(
          'SELECT banned FROM members WHERE "userId" = $1 AND "serverId" = $2 FOR UPDATE',
          [userId, expectedServerId],
        );
        return await rollback(existing.rows[0]?.banned ? 'banned' : 'already_member');
      }

      const updated = await client.query<{ uses: number | string }>(
        'UPDATE invites SET uses = uses + 1 WHERE _id = $1 RETURNING uses',
        [id],
      );
      if (!updated.rows.length) throw new Error('Invite disappeared while row lock was held');
      let committedUses: number;
      try {
        committedUses = parsePersistedNonNegativeInteger(updated.rows[0]!.uses, 'updated invite uses', { max: 2_147_483_647 });
      } catch {
        throw new Error('Invite usage counter returned invalid persisted state');
      }
      await client.query('COMMIT');
      return { status: 'ok', uses: committedUses };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async incrementUses(id: string) {
    return db.invites.update({ _id: id }, { $inc: { uses: 1 } });
  }

  async removeByServer(serverId: string) {
    return db.invites.remove({ serverId });
  }

  /** Daveti doğrular ve kullanılamaz ise hata mesajı döndürür. */
  isValid(invite: { expiresAt: unknown; maxUses: unknown; uses: unknown } | null | undefined) {
    if (!invite)                                         return 'Invalid invite code';
    try {
      const expiresAt = parsePersistedEpochMillis(invite.expiresAt);
      if (expiresAt === null || expiresAt <= Date.now()) return 'Invite has expired';
    } catch {
      return 'Invite has expired';
    }
    let maxUses: number;
    let uses: number;
    try {
      maxUses = parsePersistedNonNegativeInteger(invite.maxUses, 'invite maxUses', { max: 2_147_483_647 });
      uses = parsePersistedNonNegativeInteger(invite.uses, 'invite uses', { max: 2_147_483_647 });
    } catch {
      return 'Invite has reached its maximum uses';
    }
    if (maxUses > 0 && uses >= maxUses) return 'Invite has reached its maximum uses';
    return null; // geçerli
  }
}

export default new InviteRepository();
