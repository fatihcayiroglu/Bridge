// server/routes/bot-marketplace.ts — Sprint 83: Bot Marketplace Catalog API
// Sprint 98: pool.query() → BotMarketplaceRepository geçişi ✅

import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { BotMarketplace } from '../db/repositories/BotMarketplaceRepository.js';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
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
  changelog: string;
  supportUrl: string;
  sourceUrl: string;
  approved: boolean;
  submittedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Yardımcı: DB satırını API nesnesine dönüştür ──────────────────────────────
function rowToBot(row: object): MarketplaceBot {
  const r = row as Record<string, unknown>;
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
    changelog:       r.changelog as string,
    supportUrl:      r.supportUrl as string,
    sourceUrl:       r.sourceUrl as string,
    approved:        r.approved as boolean,
    submittedBy:     r.submittedBy as string | null,
    createdAt:       r.createdAt as number,
    updatedAt:       r.updatedAt as number,
  };
}

// ── GET /api/bots/marketplace/categories ─────────────────────────────────────
/**
 * @openapi
 * /api/bots/marketplace/categories:
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

router.get('/categories', limits.general(), async (_req: Request, res: Response) => {
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
 * /api/bots/marketplace:
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
router.get('/', limits.general(), async (req: Request, res: Response) => {
  try {
    const { category, featured, q, limit = '50', offset = '0' } = req.query as Record<string, string>;
    const lim = Math.min(parseInt(limit) || 50, 100);
    const off = Math.max(parseInt(offset) || 0, 0);

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

// ── GET /api/bots/marketplace/:botId ─────────────────────────────────────────
/**
 * @openapi
 * /api/bots/marketplace/{botId}:
 *   get:
 *     summary: Tek bir marketplace botunun detayı
 *     tags: [Bot Marketplace]
 */
router.get('/:botId', limits.general(), async (req: Request, res: Response) => {
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
 * /api/bots/marketplace:
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
        permissions:     permissions ?? [],
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

// ── PATCH /api/bots/marketplace/:botId ───────────────────────────────────────
/**
 * @openapi
 * /api/bots/marketplace/{botId}:
 *   patch:
 *     summary: Bot güncelle (sadece admin)
 *     tags: [Bot Marketplace]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:botId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = castAuthed(req).user;
    if (!user.isAdmin) return res.status(403).json({ error: 'Sadece adminler güncelleyebilir' });

    const existing = await BotMarketplace.findById(String(req.params.botId ?? ''));
    if (!existing) return res.status(404).json({ error: 'Bot not found' });

    const updated = await BotMarketplace.update(String(req.params.botId ?? ''), req.body as Record<string, string>);
    if (!updated) return res.status(400).json({ error: 'Güncellenecek alan yok' });

    // Onay log'u
    if ('approved' in req.body) {
      await BotMarketplace.addReview({
        id:         uuidv4(),
        botId:      String(req.params.botId ?? ''),
        reviewerId: user._id ?? user.id,
        action:     (req.body as Record<string, string>).approved ? 'approve' : 'reject',
        note:       typeof (req.body as Record<string, unknown>).note === 'string' ? (req.body as Record<string, string>).note : '',
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
 * /api/bots/marketplace/{botId}:
 *   delete:
 *     summary: Botu marketplace'den kaldır (sadece admin)
 *     tags: [Bot Marketplace]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:botId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = castAuthed(req).user;
    if (!user.isAdmin) return res.status(403).json({ error: 'Sadece adminler silebilir' });

    const existing = await BotMarketplace.findById(String(req.params.botId ?? ''));
    if (!existing) return res.status(404).json({ error: 'Bot not found' });
    await BotMarketplace.deleteBot(String(req.params.botId ?? ''));
    res.status(204).send();
  } catch (err) {
    console.error('[bot-marketplace] DELETE /:botId error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Seed verisi (ilk çalıştırmada DB boşsa 5 featured botu yükle) ──────────────
const CATALOG_SEED = [
  { id: 'bridge-music',  name: 'Bridge Music',  author: 'Bridge Team', authorVerified: true, avatar: '🎵', category: 'music',      tags: ['müzik','eğlence'],       description: 'YouTube, Spotify, SoundCloud desteği. Sıra yönetimi, 8D audio, bass boost.',     longDescription: '', verified: true,  featured: true,  installs: 12840, rating: 4.8, ratingCount: 3241, commands: ['/play','/skip','/queue'], permissions: ['Ses Kanalına Bağlan'], changelog: '', supportUrl: '#', sourceUrl: '#' },
  { id: 'bridge-guard',  name: 'Bridge Guard',  author: 'Bridge Team', authorVerified: true, avatar: '🛡️', category: 'moderation', tags: ['moderasyon','güvenlik'],  description: 'AI destekli spam tespiti, raid koruması, otomatik moderasyon.',                   longDescription: '', verified: true,  featured: true,  installs: 38700, rating: 4.9, ratingCount: 7821, commands: ['/ban','/kick','/warn'],  permissions: ['Üyeleri Yönet'],       changelog: '', supportUrl: '#', sourceUrl: '#' },
  { id: 'bridge-ai',     name: 'Bridge AI',     author: 'Bridge Team', authorVerified: true, avatar: '🧠', category: 'ai',         tags: ['ai','asistan'],          description: 'Kanal özeti, çeviri, kod yardımı, soru-cevap.',                                   longDescription: '', verified: true,  featured: true,  installs: 52000, rating: 4.9, ratingCount: 11203,commands: ['/ask','/summarize'],     permissions: ['Mesaj Gönder'],         changelog: '', supportUrl: '#', sourceUrl: '#' },
  { id: 'welcome-pro',   name: 'Welcome Pro',   author: 'Bridge Team', authorVerified: true, avatar: '👋', category: 'management', tags: ['yönetim','karşılama'],   description: 'Özelleştirilebilir karşılama mesajları ve otomatik rol atama.',                   longDescription: '', verified: true,  featured: true,  installs: 21000, rating: 4.7, ratingCount: 4102, commands: ['/setwelcome'],           permissions: ['Rolleri Yönet'],       changelog: '', supportUrl: '#', sourceUrl: '#' },
  { id: 'game-night',    name: 'Game Night',    author: 'Bridge Team', authorVerified: true, avatar: '🎮', category: 'fun',        tags: ['eğlence','oyun'],        description: 'Trivia, kelime oyunu, satranç turnuvası. 20+ oyun.',                               longDescription: '', verified: true,  featured: true,  installs: 9400,  rating: 4.6, ratingCount: 1892, commands: ['/trivia','/chess'],      permissions: ['Mesaj Gönder'],         changelog: '', supportUrl: '#', sourceUrl: '#' },
];

export async function ensureMarketplaceSeed(): Promise<void> {
  try {
    const total = await BotMarketplace.count();
    if (total > 0) return;

    const now = Date.now();
    for (const b of CATALOG_SEED) {
      await BotMarketplace.submit({
        id:              b.id,
        name:            b.name,
        author:          b.author,
        authorVerified:  b.authorVerified,
        avatar:          b.avatar,
        category:        b.category,
        tags:            b.tags,
        description:     b.description,
        longDescription: b.longDescription,
        commands:        b.commands,
        permissions:     b.permissions,
        changelog:       '',
        supportUrl:      b.supportUrl,
        sourceUrl:       b.sourceUrl,
        submittedBy:     null,
        createdAt:       now,
        updatedAt:       now,
      });
    }
    console.info('[bot-marketplace] Seed verisi yüklendi (5 bot).');
  } catch (err) {
    console.warn('[bot-marketplace] Seed yüklenemedi:', (err as Error).message);
  }
}


export default router;
