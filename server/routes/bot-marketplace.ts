// server/routes/bot-marketplace.ts — Sprint 83: Bot Marketplace Catalog API
// Sprint 98: pool.query() → BotMarketplaceRepository geçişi ✅

import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../middleware/auth';
import { databaseAdminOnly } from '../lib/adminAuthority';
import { limits } from '../middleware/rateLimit';
import { BotMarketplace } from '../db/repositories/BotMarketplaceRepository.js';
import { Bots, Members } from '../db/repositories';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { BOT_SCOPES, classifyBotPermissions, consentMatches, readGrantedBotScopes, validateDeclaredBotScopes, type BotScope } from '../lib/botScopes';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery } from '../lib/queryNumbers';
const router = express.Router();

// ── Tip ──────────────────────────────────────────────────────────────────────
interface MarketplaceBot {
  id: string;
  name: string;
  author: string;
  authorVerified: boolean;
  avatar: string;
  category: string;
  tags: string[];
  description: string;
  longDescription: string;
  verified: boolean;
  featured: boolean;
  installs: number;
  rating: number;
  ratingCount: number;
  commands: string[];
  permissions: string[];
  /** Declared permissions Bridge does not implement; a listing with any is not installable. */
  unsupportedPermissions: string[];
  /** Exactly what installing asks the admin to consent to; the install body must echo it. */
  requestedScopes: BotScope[];
  changelog: string;
  supportUrl: string;
  sourceUrl: string;
  approved: boolean;
  submittedBy: string | null;
  createdAt: number;
  updatedAt: number;
  installable: boolean;
}

// ── Yardımcı: DB satırını API nesnesine dönüştür ──────────────────────────────
/** What installing this listing asks the admin to grant (the base scope is always included). */
function requestedScopes(permissions: unknown): { scopes: BotScope[]; unsupported: string[] } {
  const { scopes, unsupported } = classifyBotPermissions(permissions);
  return { scopes: BOT_SCOPES.filter((scope) => scope === 'commands' || scopes.includes(scope)), unsupported };
}

function rowToBot(row: object): MarketplaceBot {
  const r = row as Record<string, unknown>;
  const declared = requestedScopes(r.permissions);
  return {
    id:              r.id as string,
    name:            r.name as string,
    author:          r.author as string,
    authorVerified:  r.authorVerified as boolean,
    avatar:          r.avatar as string,
    category:        r.category as string,
    tags:            (r.tags as string[]) ?? [],
    description:     r.description as string,
    longDescription: r.longDescription as string,
    verified:        r.verified as boolean,
    featured:        r.featured as boolean,
    installs:        r.installs as number,
    rating:          parseFloat(String(r.rating ?? 0)),
    ratingCount:     r.ratingCount as number,
    commands:        (r.commands as string[]) ?? [],
    permissions:     (r.permissions as string[]) ?? [],
    unsupportedPermissions: declared.unsupported,
    requestedScopes: declared.scopes,
    changelog:       r.changelog as string,
    supportUrl:      r.supportUrl as string,
    sourceUrl:       r.sourceUrl as string,
    approved:        r.approved as boolean,
    submittedBy:     r.submittedBy as string | null,
    createdAt:       r.createdAt as number,
    updatedAt:       r.updatedAt as number,
    installable:      r.approved === true && typeof r.executableBotId === 'string' && r.executableBotId.length > 0
      && declared.unsupported.length === 0,
  };
}

// ── GET /api/bots/marketplace/categories ─────────────────────────────────────
/**
 * @openapi
 * /bots/marketplace/categories:
 *   get:
 *     summary: Mevcut bot kategorilerini listele (DB'den distinct)
 *     tags: [Bot Marketplace]
 */
const STATIC_CATEGORIES = [
  { id: '',            icon: '🌐', label: 'Tümü' },
  { id: 'music',       icon: '🎵', label: 'Müzik' },
  { id: 'moderation',  icon: '🛡️', label: 'Moderasyon' },
  { id: 'management',  icon: '⚙️', label: 'Yönetim' },
  { id: 'ai',          icon: '🤖', label: 'AI & Yardımcı' },
  { id: 'stats',       icon: '📊', label: 'İstatistik' },
  { id: 'fun',         icon: '🎮', label: 'Eğlence' },
  { id: 'tools',       icon: '🔧', label: 'Araçlar' },
  { id: 'integration', icon: '🌐', label: 'Entegrasyon' },
  { id: 'utility',     icon: '🔩', label: 'Yardımcı Araç' },
];

router.get('/categories', async (_req: Request, res: Response) => {
  try {
    const dbCatNames = await BotMarketplace.getCategories();
    const dbCats = new Set<string>(dbCatNames);
    const cats = STATIC_CATEGORIES.filter(c => c.id === '' || dbCats.has(c.id));
    res.json(cats);
  } catch {
    res.json(STATIC_CATEGORIES);
  }
});

// ── GET /api/bots/marketplace ─────────────────────────────────────────────────
/**
 * @openapi
 * /bots/marketplace:
 *   get:
 *     summary: Marketplace bot katalogunu listele
 *     tags: [Bot Marketplace]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *       - in: query
 *         name: featured
 *         schema: { type: boolean }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Full-text arama sorgusu
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Bot listesi + toplam sayı
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, featured, q } = req.query as Record<string, string>;
    const lim = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
    const off = parseNonNegativeSafeIntQuery(req.query.offset, 0);
    if (lim === null || off === null)
      return res.status(400).json({ error: 'limit/offset must be safe non-negative integers' });

    const { rows, total } = await BotMarketplace.listBots({
      category,
      search:   q,
      featured: featured === 'true',
      limit:    lim,
      offset:   off,
    });

    res.json({ bots: rows.map(rowToBot), total, limit: lim, offset: off });
  } catch (err) {
    console.error('[bot-marketplace] GET / error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── GET /api/bots/marketplace/installed?serverId=... ─────────────────────────
router.get('/installed', authMiddleware, async (req: Request, res: Response) => {
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : '';
  if (!serverId) return void res.status(400).json({ error: 'serverId required' });
  const user = castAuthed(req).user;
  if (!await Members.findOne(String(user._id ?? user.id), serverId)) {
    return void res.status(403).json({ error: 'Not a server member' });
  }
  const installed = await BotMarketplace.findInstalledMarketplaceIds(serverId);
  // What each installed bot may do here: the consented grant, or everything for the server's own bot.
  const grants: Record<string, BotScope[]> = {};
  for (const listingId of installed) {
    const listing = await BotMarketplace.findById(listingId);
    const executableBotId = typeof listing?.executableBotId === 'string' ? listing.executableBotId : '';
    const bot = executableBotId ? await Bots.findById(executableBotId) as { serverId?: string } | null : null;
    if (bot && String(bot.serverId) === serverId) { grants[listingId] = [...BOT_SCOPES]; continue; }
    const link = executableBotId ? await Bots.findServerBot(executableBotId, serverId) as { grantedScopes?: unknown } | null : null;
    grants[listingId] = readGrantedBotScopes(link?.grantedScopes);
  }
  res.json({ installed, grants });
});

// ── GET /api/bots/marketplace/:botId ─────────────────────────────────────────
/**
 * @openapi
 * /bots/marketplace/{botId}:
 *   get:
 *     summary: Tek bir marketplace botunun detayı
 *     tags: [Bot Marketplace]
 */
router.get('/:botId', async (req: Request, res: Response) => {
  try {
    const bot = await BotMarketplace.findById(String(req.params.botId ?? ''));
    if (!bot || !bot.approved) return res.status(404).json({ error: 'Bot not found' });
    res.json(rowToBot(bot));
  } catch (err) {
    console.error('[bot-marketplace] GET /:botId error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── POST /api/bots/marketplace ────────────────────────────────────────────────
/**
 * @openapi
 * /bots/marketplace:
 *   post:
 *     summary: Marketplace'e bot gönder (admin onayı gerekir)
 *     tags: [Bot Marketplace]
 *     security:
 *       - bearerAuth: []
 */
router.post('/', authMiddleware, limits.bots(), async (req: Request, res: Response) => {
  try {
    const user = castAuthed(req).user;
    const {
      id, name, description, longDescription, category,
      tags, avatar, commands, permissions, supportUrl, sourceUrl,
    } = req.body as Partial<MarketplaceBot>;

    if (!id || !name || !description || !category) {
      return res.status(400).json({ error: 'id, name, description, category zorunlu' });
    }
    if (!/^[a-z0-9-]{3,64}$/.test(id)) {
      return res.status(400).json({ error: 'id: sadece küçük harf, rakam ve tire; 3–64 karakter' });
    }
    // Only permissions Bridge enforces may be declared (Final21 Phase 14).
    const declared = validateDeclaredBotScopes(permissions);
    if (!declared.ok) return res.status(400).json({ error: declared.reason, supported: BOT_SCOPES });

    const now = Date.now();
    let inserted;
    try {
      inserted = await BotMarketplace.submit({
        id, name,
        author:          user.username ?? 'unknown',
        authorVerified:  false,
        avatar:          avatar ?? '🤖',
        category,
        tags:            tags ?? [],
        description,
        longDescription: longDescription ?? description,
        commands:        commands ?? [],
        permissions:     declared.scopes,
        changelog:       '',
        supportUrl:      supportUrl ?? '#',
        sourceUrl:       sourceUrl ?? '#',
        submittedBy:     user._id ?? user.id ?? null,
        createdAt:       now,
        updatedAt:       now,
      });
    } catch (pgErr: unknown) {
      if ((pgErr as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Bu ID zaten mevcut' });
      }
      throw pgErr;
    }

    res.status(201).json({
      ...rowToBot(inserted!),
      message: 'Bot gönderildi, admin onayı bekleniyor.',
    });
  } catch (err) {
    console.error('[bot-marketplace] POST / error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── POST/DELETE executable marketplace installation ─────────────────────────
async function requireManageServer(userId: string, serverId: string): Promise<boolean> {
  if (!await Members.findOne(userId, serverId)) return false;
  const perms = await resolvePermissions(userId, serverId).catch(() => 0);
  return hasPermission(perms, PERMS.MANAGE_SERVER) || hasPermission(perms, PERMS.ADMIN);
}

router.post('/:botId/install', authMiddleware, limits.bots(), async (req: Request, res: Response) => {
  const serverId = typeof (req.body as Record<string, unknown>)?.serverId === 'string'
    ? String((req.body as Record<string, unknown>).serverId) : '';
  const userId = String(castAuthed(req).user._id ?? castAuthed(req).user.id);
  if (!serverId) return void res.status(400).json({ error: 'serverId required' });
  if (!await requireManageServer(userId, serverId)) return void res.status(403).json({ error: 'No permission' });

  const listing = await BotMarketplace.findById(String(req.params.botId ?? ''));
  const executableBotId = listing?.approved === true && typeof listing.executableBotId === 'string'
    ? listing.executableBotId : '';
  if (!executableBotId) return void res.status(409).json({ error: 'Marketplace bot is not installable' });
  const requested = requestedScopes(listing?.permissions);
  if (requested.unsupported.length) {
    return void res.status(409).json({ error: 'Marketplace bot declares unsupported permissions', unsupported: requested.unsupported });
  }
  const bot = await Bots.findById(executableBotId) as { _id?: string; serverId?: string; active?: boolean; isPublic?: boolean } | null;
  if (!bot || bot.active !== true || bot.isPublic !== true) {
    return void res.status(409).json({ error: 'Executable bot is unavailable' });
  }
  if (String(bot.serverId) === serverId) return void res.json({ ok: true, installed: true, owned: true, grantedScopes: [...BOT_SCOPES] });

  // Explicit consent to exactly what the listing asks for (Final21 Phase 14). Installing
  // used to be one click with nothing recorded; the admin never saw what the bot could do.
  const accepted = (req.body as Record<string, unknown>)?.acceptedPermissions;
  if (!consentMatches(requested.scopes, accepted)) {
    return void res.status(400).json({ error: 'consent_required', permissions: requested.scopes });
  }

  const existing = await Bots.findServerBot(executableBotId, serverId) as { grantedScopes?: unknown } | null;
  if (!existing) {
    try {
      await Bots.addToServer(executableBotId, serverId, userId, requested.scopes);
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      // Another request reached the same target state first; the unique
      // (botId, serverId) owner makes this a successful idempotent retry.
    }
  } else if (!consentMatches(requested.scopes, readGrantedBotScopes(existing.grantedScopes))) {
    // The listing now asks for something different: the new consent replaces the old grant.
    await Bots.updateServerGrant(executableBotId, serverId, requested.scopes);
  }
  await BotMarketplace.syncInstallCount(executableBotId);
  res.json({ ok: true, installed: true, owned: false, grantedScopes: requested.scopes });
});

router.delete('/:botId/install/:serverId', authMiddleware, limits.bots(), async (req: Request, res: Response) => {
  const serverId = String(req.params.serverId ?? '');
  const userId = String(castAuthed(req).user._id ?? castAuthed(req).user.id);
  if (!serverId) return void res.status(400).json({ error: 'serverId required' });
  if (!await requireManageServer(userId, serverId)) return void res.status(403).json({ error: 'No permission' });

  const listing = await BotMarketplace.findById(String(req.params.botId ?? ''));
  const executableBotId = listing?.approved === true && typeof listing.executableBotId === 'string'
    ? listing.executableBotId : '';
  if (!executableBotId) return void res.status(404).json({ error: 'Marketplace bot not installed' });
  const bot = await Bots.findById(executableBotId) as { serverId?: string } | null;
  if (bot && String(bot.serverId) === serverId) {
    return void res.status(409).json({ error: 'Server-owned bot cannot be removed as a marketplace install' });
  }
  await Bots.removeFromServer(executableBotId, serverId);
  await BotMarketplace.syncInstallCount(executableBotId);
  res.json({ ok: true, installed: false });
});

// ── POST /api/bots/marketplace/:botId/rating ─────────────────────────────────
router.post('/:botId/rating', authMiddleware, limits.bots(), async (req: Request, res: Response) => {
  try {
    const raw = (req.body as Record<string, unknown>)?.rating;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > 5) {
      return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
    }
    const user = castAuthed(req).user;
    const updated = await BotMarketplace.rateBot(
      String(req.params.botId ?? ''),
      String(user._id ?? user.id),
      raw,
    );
    if (!updated) return res.status(404).json({ error: 'Bot not found' });
    return res.json(rowToBot(updated));
  } catch (err) {
    console.error('[bot-marketplace] POST /:botId/rating error:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── PATCH /api/bots/marketplace/:botId ───────────────────────────────────────
/**
 * @openapi
 * /bots/marketplace/{botId}:
 *   patch:
 *     summary: Bot güncelle (sadece admin)
 *     tags: [Bot Marketplace]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:botId', authMiddleware, databaseAdminOnly, async (req: Request, res: Response) => {
  try {
    const user = castAuthed(req).user;
    const existing = await BotMarketplace.findById(String(req.params.botId ?? ''));
    if (!existing) return res.status(404).json({ error: 'Bot not found' });

    const updateFields = { ...(req.body as Record<string, unknown>) } as Partial<import('../db/repositories/BotMarketplaceRepository.js').MarketplaceBotRow>;
    if ('permissions' in updateFields) {
      const declared = validateDeclaredBotScopes(updateFields.permissions);
      if (!declared.ok) return res.status(400).json({ error: declared.reason, supported: BOT_SCOPES });
      updateFields.permissions = declared.scopes;
    }
    if ('executableBotId' in updateFields) {
      if (updateFields.executableBotId !== null && typeof updateFields.executableBotId !== 'string') {
        return res.status(400).json({ error: 'executableBotId must be a string or null' });
      }
      const executableBotId = typeof updateFields.executableBotId === 'string' ? updateFields.executableBotId.trim() : '';
      updateFields.executableBotId = executableBotId || null;
      if (executableBotId) {
        const bot = await Bots.findById(executableBotId) as { active?: boolean; isPublic?: boolean } | null;
        if (!bot || bot.active !== true || bot.isPublic !== true) {
          return res.status(400).json({ error: 'Executable bot must be active and public' });
        }
      }
    }
    const updated = await BotMarketplace.update(String(req.params.botId ?? ''), updateFields);
    if (!updated) return res.status(400).json({ error: 'Güncellenecek alan yok' });

    // Onay log'u
    if ('approved' in req.body) {
      await BotMarketplace.addReview({
        id:         uuidv4(),
        botId:      String(req.params.botId ?? ''),
        reviewerId: String(user._id ?? user.id ?? ''),
        action:     (req.body as Record<string, string>).approved ? 'approve' : 'reject',
        // Tek okuma + daraltma: `Record<string, string>` indekslemesi
        // `noUncheckedIndexedAccess` altında `string | undefined` verir.
        note:       (() => {
          const raw = (req.body as Record<string, unknown>).note;
          return typeof raw === 'string' ? raw : '';
        })(),
        createdAt:  Date.now(),
      });
    }

    res.json(rowToBot(updated));
  } catch (err) {
    console.error('[bot-marketplace] PATCH /:botId error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── DELETE /api/bots/marketplace/:botId ──────────────────────────────────────
/**
 * @openapi
 * /bots/marketplace/{botId}:
 *   delete:
 *     summary: Botu marketplace'den kaldır (sadece admin)
 *     tags: [Bot Marketplace]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:botId', authMiddleware, databaseAdminOnly, async (req: Request, res: Response) => {
  try {
    const existing = await BotMarketplace.findById(String(req.params.botId ?? ''));
    if (!existing) return res.status(404).json({ error: 'Bot not found' });
    await BotMarketplace.deleteBot(String(req.params.botId ?? ''));
    res.status(204).send();
  } catch (err) {
    console.error('[bot-marketplace] DELETE /:botId error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

export default router;
