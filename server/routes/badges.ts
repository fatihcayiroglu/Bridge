import db from '../db';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
// server/routes/badges.ts
// Rozet sistemi: kullanıcı başarı rozetleri
// Admin API'si (POST/DELETE) + Public okuma (GET)


import express, { Request, Response } from 'express';
const router = express.Router();
import { v4 as uuidv4 } from 'uuid';
import { Users, Servers } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import logger from '../lib/logger';
import { limits } from '../middleware/rateLimit';

// ── Rozet tanımları ───────────────────────────────────────────────────────────
// Her rozet; badge key → { label, icon, description, auto } şeklindedir.
// auto:true rozetler sistem tarafından otomatik verilir (admin müdahalesi gerekmez).
export const BADGE_DEFS: Record<string, { label: string; icon: string; description: string; auto: boolean }> = {
  // Kullanım süresine dayalı
  early_adopter:    { label: 'Erken Benimseyici', icon: '🌱', description: 'Bridge\'in ilk 1000 kullanıcısından biri', auto: false },
  one_year:         { label: '1 Yıl',             icon: '🎂', description: 'Bridge\'de 1 yıl geçirdi',               auto: true  },
  two_years:        { label: '2 Yıl',             icon: '🎉', description: 'Bridge\'de 2 yıl geçirdi',               auto: true  },
  // Sosyal başarılar
  connector:        { label: 'Bağlayıcı',         icon: '🔗', description: '3+ platform bağlantısı ekledi',          auto: true  },
  verified:         { label: 'Onaylı',            icon: '✅', description: 'Kimlik doğrulandı',                       auto: false },
  // Topluluk rozetleri
  server_founder:   { label: 'Sunucu Kurucusu',   icon: '🏛️', description: 'Aktif bir sunucu kurdu',                 auto: true  },
  bot_developer:    { label: 'Bot Geliştiricisi', icon: '🤖', description: 'Bot API anahtarı oluşturdu',             auto: true  },
  // Özel / admin tarafından verilen
  contributor:      { label: 'Katkıda Bulunan',   icon: '💎', description: 'Bridge\'e katkıda bulundu',              auto: false },
  moderator:        { label: 'Moderatör',         icon: '🛡️', description: 'Güvenilir moderatör',                    auto: false },
  bug_hunter:       { label: 'Hata Avcısı',       icon: '🐛', description: 'Kritik bir hata bildirdi',              auto: false },
};

// ── Repository shim — Rozetler için DB erişimi ───────────────────────────────
// db.userBadges Collection API'si kullanılır (SQLite + PostgreSQL uyumlu).

type BadgeCollection = {
  find(q: Record<string, unknown>): Promise<unknown[]>;
  findOne(q: Record<string, unknown>): Promise<unknown>;
  insert(d: Record<string, unknown>): Promise<unknown>;
  remove(q: Record<string, unknown>): Promise<unknown>;
};

function getBadgeCollection(): BadgeCollection | null {
  const maybeCollection = (db as { userBadges?: Partial<BadgeCollection> }).userBadges;
  if (
    maybeCollection &&
    typeof maybeCollection.find === 'function' &&
    typeof maybeCollection.findOne === 'function' &&
    typeof maybeCollection.insert === 'function' &&
    typeof maybeCollection.remove === 'function'
  ) {
    return maybeCollection as BadgeCollection;
  }
  return null;
}

type BadgeRepo = {
  findByUser(userId: string): Promise<unknown[]>;
  findOne(userId: string, badge: string): Promise<unknown>;
  insert(data: { _id: string; userId: string; badge: string; label: string; icon: string; awardedAt: number; awardedBy: string | null }): Promise<unknown>;
  remove(userId: string, badge: string): Promise<unknown>;
};

function getBadgeRepo(): BadgeRepo;
function getBadgeRepo(options: { optional: true }): BadgeRepo | null;
function getBadgeRepo(options: { optional?: boolean } = {}): BadgeRepo | null {
  const col = getBadgeCollection();
  if (!col) {
    if (options.optional) return null;
    throw new Error('userBadges collection is not configured');
  }

  return {
    async findByUser(userId: string) {
      return col.find({ userId });
    },
    async findOne(userId: string, badge: string) {
      return col.findOne({ userId, badge });
    },
    async insert(data: { _id: string; userId: string; badge: string; label: string; icon: string; awardedAt: number; awardedBy: string | null }) {
      return col.insert(data);
    },
    async remove(userId: string, badge: string) {
      return col.remove({ userId, badge });
    },
  };
}

// ── Yardımcı: admin mi? ───────────────────────────────────────────────────────
function isAdmin(user: { role?: string; flags?: string[] } | undefined): boolean {
  return user?.role === 'admin' || user?.flags?.includes?.('admin') || false;
}

// ── GET /api/users/:userId/badges — public profil rozetleri ─────────────────
/**
 * @openapi
 * /users/{userId}/badges:
 *   get:
 *     tags: [Badges]
 *     summary: Kullanıcı rozetleri
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Rozet listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   key: { type: string }
 *                   label: { type: string }
 *                   icon: { type: string }
 *                   awardedAt: { type: integer }
 */
router.get('/users/:userId/badges', authMiddleware, async (req: Request, res: Response) => {
  const Badges = await getBadgeRepo();
  const badges = await Badges.findByUser(String(req.params.userId ?? ''));
  const typedBadges = badges as Array<{ badge: string; label?: string; icon?: string; awardedAt: number }>;
  res.json(typedBadges.map((b) => ({

    badge:      b.badge,
    label:      b.label  || BADGE_DEFS[b.badge]?.label       || b.badge,
    icon:       b.icon   || BADGE_DEFS[b.badge]?.icon        || '🏷️',
    description: BADGE_DEFS[b.badge]?.description            || '',
    awardedAt:  b.awardedAt,
  })));
});

// ── GET /api/badges/definitions — rozet kataloğu ────────────────────────────
/**
 * @openapi
 * /badges/definitions:
 *   get:
 *     tags: [Badges]
 *     summary: Rozet kataloğu
 *     security: []
 *     responses:
 *       200:
 *         description: Tüm rozet tanımları
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 */
router.get('/badges/definitions', (req: Request, res: Response) => {
  res.json(
    Object.entries(BADGE_DEFS).map(([key, def]) => ({
      badge:       key,
      label:       def.label,
      icon:        def.icon,
      description: def.description,
      auto:        def.auto,
    }))
  );
});

// ── POST /api/admin/badges/award — admin rozet ver ─────────────────────────
/**
 * @openapi
 * /admin/badges/award:
 *   post:
 *     tags: [Badges, Admin]
 *     summary: Kullanıcıya rozet ver
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, badgeKey]
 *             properties:
 *               userId: { type: string }
 *               badgeKey: { type: string }
 *     responses:
 *       200: { description: Rozet verildi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/admin/badges/award', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  if (!isAdmin(_u)) return res.status(403).json({ error: 'Sadece admin rozet verebilir' });

  const { userId, badge } = req.body as Record<string, string>;
  if (!userId || !badge) return res.status(400).json({ error: 'userId ve badge gerekli' });
  if (!BADGE_DEFS[badge])  return res.status(400).json({ error: `Bilinmeyen rozet: ${badge}` });

  const target = await Users.findById(userId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  const def    = BADGE_DEFS[badge];
  const Badges = await getBadgeRepo();

  const existing = await Badges.findOne(userId, badge);
  if (existing) return res.status(409).json({ error: 'Bu rozet zaten verilmiş' });

  const awarded = await Badges.insert({
    _id:       uuidv4(),
    userId,
    badge,
    label:     def.label,
    icon:      def.icon,
    awardedAt: Date.now(),
    awardedBy: _u.id,
  });

  res.status(201).json(awarded);
});

// ── DELETE /api/admin/badges/revoke — admin rozet geri al ──────────────────
/**
 * @openapi
 * /admin/badges/revoke:
 *   delete:
 *     tags: [Badges, Admin]
 *     summary: Kullanıcıdan rozet geri al
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, badgeKey]
 *             properties:
 *               userId: { type: string }
 *               badgeKey: { type: string }
 *     responses:
 *       200: { description: Rozet geri alındı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/admin/badges/revoke', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  if (!isAdmin(_u)) return res.status(403).json({ error: 'Sadece admin rozet kaldırabilir' });

  const { userId, badge } = req.body as Record<string, string>;
  if (!userId || !badge) return res.status(400).json({ error: 'userId ve badge gerekli' });

  const Badges = await getBadgeRepo();
  await Badges.remove(userId, badge);
  res.json({ ok: true });
});

// ── POST /api/badges/auto-check — sistem rozetlerini kontrol et ─────────────
// Giriş sonrası veya profil güncelleme sonrası çağrılır.
// Kullanıcının kazanması gereken auto rozeti varsa ekler.
export async function checkAndAwardAutoBadges(userId: string): Promise<void> {
  try {
    const Badges    = getBadgeRepo({ optional: true });
    if (!Badges) return;
    const user      = await Users.findById(userId);
    if (!user) return;

    const existing  = new Set(((await Badges.findByUser(userId)) as Array<{ badge: string }>).map((b) => b.badge));
    const toAward: string[] = [];

    // ─ 1 yıl / 2 yıl rozeti ─────────────────────────────────────
    const ageMs  = Date.now() - (user.createdAt || 0);
    const ageDay = ageMs / 86_400_000;
    if (ageDay >= 365 && !existing.has('one_year'))  toAward.push('one_year');
    if (ageDay >= 730 && !existing.has('two_years')) toAward.push('two_years');

    // ─ Connector rozeti: 3+ platform ────────────────────────────
    if (!existing.has('connector')) {
          const conns = await db.userConnections.find({ userId });
      if ((conns?.length ?? 0) >= 3) toAward.push('connector');
    }

    // ─ Server founder rozeti ─────────────────────────────────────
    if (!existing.has('server_founder')) {
        const ownedServers = await Servers.find({ ownerId: userId });
      if (ownedServers.length > 0) toAward.push('server_founder');
    }

    // ─ Bot developer rozeti ──────────────────────────────────────
    if (!existing.has('bot_developer')) {
          const botRow = await db.bots.findOne({ ownerId: userId });
      if (botRow) toAward.push('bot_developer');
    }

    // ─ Toplu ekle ───────────────────────────────────────────────
    for (const badge of toAward) {
      const def = BADGE_DEFS[badge];
      await Badges.insert({
        _id:       uuidv4(),
        userId,
        badge,
        label:     def.label,
        icon:      def.icon,
        awardedAt: Date.now(),
        awardedBy: 'system',
      }).catch(() => {/* UNIQUE ihlali — zaten var, yoksay */});
    }
  } catch (err) {
    // Rozet kontrolü asla kritik flow'u bloklamamalı
    logger.error({ err, event: 'badges.auto_check.error' }, '[badges] auto-check error');
  }
}

export default router;
