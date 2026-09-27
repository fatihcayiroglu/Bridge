/**
 * @openapi
 * /account/export:
 *   get: { tags: [Account], summary: Export caller account data, responses: { '200': { description: Account export } } }
 * /account/deletion-preflight:
 *   get: { tags: [Account], summary: Check account deletion blockers, responses: { '200': { description: Deletion preflight } } }
 * /account:
 *   delete: { tags: [Account], summary: Delete caller account, responses: { '200': { description: Account deleted } } }
 */
// server/routes/account.ts — Kişisel veri dışa aktarma + hesap silme
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 6 — DIŞA AKTARMA  (GET /api/account/export)
// FAZ 5 — HESAP SİLME   (DELETE /api/account)
// ════════════════════════════════════════════════════════════════════════════
// Politika `lib/accountLifecycle.ts` içinde TEK KAYNAKTAN tanımlıdır; burada
// yalnızca uygulanır.
//
// ── SUNUCU SAHİPLİĞİ: SESSİZ DEVİR YOK, ÖKSÜZ SUNUCU YOK ──────────────────
// Canlı veritabanında 2328 sunucu 661 kullanıcıya aitti ve 503 sunucunun
// birden fazla üyesi vardı. Bir hesabı silerken sahipliği sessizce başkasına
// devretmek de, sunucuyu sahipsiz bırakmak da kabul edilemez: ikisi de
// BAŞKA insanların topluluğunu etkiler.
//
// Bu yüzden silme, sınırlı ve açık bir ÖN KOŞULA bağlıdır: kullanıcı, başka
// üyesi olan bir sunucunun sahibiyse önce devretmeli ya da sunucuyu
// silmelidir. Tek üyesi kendisi olan sunucular ise kimseyi etkilemediği için
// hesapla birlikte silinir.

import express from 'express';
import type { Request, Response } from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { authMiddleware } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { Users, Auth } from '../db/repositories';
import db from '../db/loader';
import logger from '../lib/logger';
import { disconnectLiveUserSessions } from '../lib/sessionRevocation';
import bcrypt from 'bcryptjs';
import { LIFECYCLE } from '../lib/accountLifecycle';
import {
  eraseAccountData, existingTables, ownershipBlockers, releaseAfterErasure, tableColumns,
  type TransactionRunner,
} from '../lib/accountDeletion';

const router = express.Router();

type Pool = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};
function pool(): Pool | null {
  const p = (db as unknown as { _pool?: Pool })._pool;
  return p && typeof p.query === 'function' ? p : null;
}

// ════════════════════════════════════════════════════════════════════════════
// FAZ 6 — KİŞİSEL VERİ DIŞA AKTARMA
// ════════════════════════════════════════════════════════════════════════════
// ASLA DIŞA AKTARILMAZ: parola hash'i, 2FA sırrı/yedek kodları, e-posta
// doğrulama jetonu, yenileme jetonları, OAuth jetonları, WebAuthn kayıtları,
// ActivityPub ÖZEL anahtarı, push abonelik anahtarları, webhook/bot sırları.
//
// Bu liste POZİTİF'tir: hangi sütunların çıkacağı tek tek yazılır. Negatif
// bir kara liste, şemaya yeni bir sır sütunu eklendiğinde SESSİZCE sızdırır.
const PROFILE_FIELDS = [
  '_id', 'username', 'displayName', 'avatarColor', 'avatarUrl', 'status',
  'presenceVisibility', 'bio', 'website', 'location', 'pronouns',
  'bannerColor', 'bannerUrl', 'statusText', 'statusEmoji', 'email',
  'emailVerified', 'twoFactorEnabled', 'isAdmin', 'dmPrivacy', 'createdAt',
] as const;

/** Yalnızca ÇAĞIRANIN kendi satırlarını çeken dışa aktarma kaynakları. */
const EXPORT_SOURCES: Array<{ key: string; table: string; column: string; columns?: string[] }> = [
  { key: 'memberships',        table: 'members',            column: 'userId' },
  { key: 'messages',           table: 'messages',           column: 'userId' },
  { key: 'directMessages',     table: 'dm_messages',        column: 'userId' },
  { key: 'groupDmMessages',    table: 'group_dm_messages',  column: 'userId' },
  { key: 'threadMessages',     table: 'thread_messages',    column: 'userId' },
  { key: 'savedMessages',      table: 'saved_messages',     column: 'userId' },
  { key: 'notificationPrefs',  table: 'notification_prefs', column: 'userId' },
  { key: 'notificationKeywords', table: 'notification_keywords', column: 'userId' },
  { key: 'channelReadPositions', table: 'channel_read_positions', column: 'userId' },
  { key: 'uploads',            table: 'uploads',            column: 'userId' },
  { key: 'badges',             table: 'user_badges',        column: 'userId' },
  { key: 'boosts',             table: 'server_boosts',      column: 'userId' },
  { key: 'ownedServers',       table: 'servers',            column: 'ownerId' },
  { key: 'scheduledMessages',  table: 'scheduled_msgs',     column: 'userId' },
  { key: 'messageReports',     table: 'message_reports',    column: 'reporterId' },
];

// GET /api/account/export
router.get('/export', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const p = pool();
  if (!p) return res.status(503).json({ error: 'Export requires PostgreSQL' });

  try {
    const user = await Users.findById(_u.id) as Record<string, unknown> | null;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const profile: Record<string, unknown> = {};
    for (const f of PROFILE_FIELDS) profile[f] = user[f] ?? null;

    const present = await existingTables(p);
    const data: Record<string, unknown> = {};

    for (const src of EXPORT_SOURCES) {
      if (!present.has(src.table)) { data[src.key] = []; continue; }
      const cols = await tableColumns(p, src.table);
      if (!cols.has(src.column)) { data[src.key] = []; continue; }
      // KAPSAM: her sorgu ÇAĞIRANIN kimliğiyle daraltılır.
      const { rows } = await p.query(
        `SELECT * FROM "${src.table}" WHERE "${src.column}" = $1 LIMIT 50000`, [_u.id],
      );
      data[src.key] = rows;
    }

    // Sosyal graf: iki yönlü olduğu için ayrı ele alınır.
    if (present.has('friendships')) {
      const { rows } = await p.query(
        `SELECT * FROM friendships WHERE "userId"=$1 OR "friendId"=$1 LIMIT 50000`, [_u.id]);
      data.friendships = rows;
    }
    if (present.has('blocks')) {
      // Yalnızca ÇAĞIRANIN kurduğu engeller. Kimin ONU engellediği BAŞKA
      // kullanicilarin verisidir ve sizdirilmaz.
      const { rows } = await p.query(
        `SELECT * FROM blocks WHERE "blockerId"=$1 LIMIT 50000`, [_u.id]);
      data.blocksCreated = rows;
    }

    logger.info({ userId: _u.id, event: 'account.export.generated' }, 'Kişisel veri dışa aktarıldı.');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="bridge-export-${_u.id}.json"`);
    return res.status(200).json({
      format: 'bridge-personal-export',
      version: 1,
      generatedAt: new Date().toISOString(),
      userId: _u.id,
      profile,
      data,
      notes: {
        excluded: [
          'password hash', 'two-factor secret and backup codes',
          'email verification token', 'refresh tokens', 'OAuth tokens',
          'WebAuthn credentials', 'ActivityPub private key',
          'push subscription keys', 'webhook and bot secrets',
        ],
        scope: 'Only data belonging to the requesting user is included.',
      },
    });
  } catch (err) {
    logger.error({ err, userId: _u.id, event: 'account.export.failed' }, 'Dışa aktarma başarısız.');
    return res.status(500).json({ error: 'Export failed' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ 5 — HESAP SİLME
// ════════════════════════════════════════════════════════════════════════════

// Politikanın uygulayıcısı `lib/accountDeletion.ts`tir; yönetici silmesi de AYNI kodu
// kullanır (Final21 Faz 19). Burada yalnızca kişinin kendi isteğinin koşulları vardır.

// GET /api/account/deletion-preflight — silmeden ÖNCE ne olacağını göster.
router.get('/deletion-preflight', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const p = pool();
  if (!p) return res.status(503).json({ error: 'Requires PostgreSQL' });
  try {
    const blockers = await ownershipBlockers(p, _u.id);
    return res.json({
      canDelete: blockers.length === 0,
      blockers,
      policy: LIFECYCLE.map(r => ({ table: r.table, disposition: r.disposition, why: r.why })),
    });
  } catch (err) {
    logger.error({ err, userId: _u.id, event: 'account.preflight.failed' }, 'Preflight başarısız.');
    return res.status(500).json({ error: 'Preflight failed' });
  }
});

// DELETE /api/account
router.delete('/', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const p = pool();
  if (!p) return res.status(503).json({ error: 'Requires PostgreSQL' });

  const { password, confirm } = (req.body ?? {}) as { password?: string; confirm?: string };

  // ── Açık onay ────────────────────────────────────────────────────────────
  // Yanlışlıkla tetiklenen bir DELETE geri alınamaz. Niyet ACIKÇA belirtilir.
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation required', expected: { confirm: 'DELETE' } });
  }

  // ── Yakın kimlik doğrulama ───────────────────────────────────────────────
  // Çalınmış/ödünç alınmış bir oturum, hesabı silmeye YETMEMELİDİR. Mevcut
  // mimari parola ile yeniden doğrulamayı destekliyor.
  const user = await Users.findById(_u.id) as { password?: string } | null;
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password confirmation required' });
  }
  const ok = await bcrypt.compare(password, String(user.password ?? ''));
  if (!ok) {
    logger.warn({ userId: _u.id, event: 'account.delete.bad_password' }, 'Silme reddedildi: parola hatalı.');
    // 400, 401 DEĞİL (Final21 Faz 19): 401 "oturum geçersiz" demektir. İstemcinin apiFetch'i
    // 401'de jetonu yeniler, isteği (parolayla birlikte) TEKRAR gönderir, yine 401 alınca
    // yenilemeyi kapatıp OTURUMU KAPATIR — yanlış yazılan bir parola kişiyi dışarı atardı.
    // Parola değişimi ve 2FA uçları da yanlış parolayı 400 ile bildirir.
    return res.status(400).json({ error: 'Password incorrect' });
  }

  try {
    const blockers = await ownershipBlockers(p, _u.id);
    if (blockers.length > 0) {
      // SESSİZ DEVİR YOK. Kullanıcıya tam olarak ne yapması gerektiği söylenir.
      return res.status(409).json({
        error: 'Ownership transfer required before deletion',
        blockers,
        remedy: 'Transfer ownership or delete these first, then retry.',
      });
    }

    const transaction = (db as unknown as { _transaction: TransactionRunner })._transaction;
    const { applied, plan } = await eraseAccountData(p, transaction, _u.id);

    // ── Yetki iptali ─────────────────────────────────────────────────────
    // `tokenVersion` hem erişim jetonunu hem MEDYA çerezini geçersizler.
    await Auth.revokeAllForUser(_u.id).catch(() => { /* satırlar zaten silindi */ });
    await disconnectLiveUserSessions(_u.id, 'account_deleted');

    // ── Profil görselleri ve önbellek ────────────────────────────────────
    // İşlem tamamlandı: kişinin artık hiçbir kaydın başvurmadığı profil görselleri silinir.
    // Dosya silinemezse hesap silme GERİ ALINMAZ (veritabanı yetkilidir); olay kaydedilir.
    const assets = await releaseAfterErasure(p, plan, (url, err) => {
      logger.error({ err, userId: _u.id, url, event: 'account.delete.asset_release_failed' },
        'Hesap silindi ama bir profil görseli silinemedi.');
    });

    logger.info(
      { userId: _u.id, tables: applied.length, repliesScrubbed: plan.repliesScrubbed, assets, event: 'account.deleted' },
      'Hesap silindi.',
    );
    return res.status(200).json({ ok: true, deleted: true, applied, profileAssets: assets });
  } catch (err) {
    logger.error({ err, userId: _u.id, event: 'account.delete.failed' }, 'Hesap silme başarısız.');
    return res.status(500).json({ error: 'Deletion failed' });
  }
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
