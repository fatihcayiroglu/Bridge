// server/routes/discover.ts  (Session 10 — refactor)
// Keşif güçlendirmesi:
//   • Haftalık öne çıkan sunucular (GET /api/discover/featured)
//   • Kategori bazlı filtreleme  (?category=gaming)
//   • Gerçek zamanlı aktif üye sayısı Socket.IO push (discover:memberCount)
//
// Geriye dönük uyum: mevcut GET /api/discover tüm parametreleri hâlâ destekler.


import express, { Request, Response } from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();
export const adminDiscoverRouter = express.Router();
import { Servers, Members, Channels } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { isUserOnline } from '../lib/presenceCache';
import { cache } from '../lib/redisAdapter';
const MEMBER_COUNT_TTL  = 120; // saniye — üye sayısı cache
const FEATURED_TTL      = 300; // saniye — öne çıkan liste cache
const DISCOVER_LIMIT    = 50;

export const DISCOVER_CATEGORIES = [
  'gaming', 'music', 'art', 'tech', 'edu', 'social', 'other',
] as const;
export type DiscoverCategory = typeof DISCOVER_CATEGORIES[number];

interface ServerRow {
  _id: string;
  name: string;
  icon?: string;
  iconUrl?: string;
  bannerUrl?: string;
  description?: string;
  tags?: string | string[];
  category?: string;
  discoverable?: number;
  featured?: number;
  featuredAt?: number | null;
  createdAt: number;
  ownerId?: string;
  autoModerate?: boolean;
  _memberCount?: number;
  _onlinePre?: number;
}

interface MemberRow { userId: string; }

function queryString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeTags(tags: string | string[] | undefined): string[] {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    try { const parsed = JSON.parse(tags); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return tags ? [tags] : []; }
  }
  return [];
}

// ── Cache yardımcıları ────────────────────────────────────────────────────────

async function getMemberCountCached(serverId: string): Promise<number> {
  const key = `discover:memberCount:${serverId}`;
  try {
    const cached = await cache.get(key);
    if (cached !== null && cached !== undefined) return Number(cached);
  } catch { /* fall through */ }

  const members = await Members.findByServer(serverId);
  const count   = members.length;
  try { await cache.set(key, count, MEMBER_COUNT_TTL); } catch { /* ignore */ }
  return count;
}

/** Üye ekleme/çıkarmadan sonra cache'i geçersiz kıl */
export async function invalidateMemberCount(serverId: string): Promise<void> {
  try { await cache.del(`discover:memberCount:${serverId}`); } catch {}
}

async function getOnlineCountFromPresence(serverId: string): Promise<number> {
  try {
    const members = await Members.findByServer(serverId);
    if (!members.length) return 0;
    const checks = await Promise.all(members.map((m: MemberRow) => isUserOnline(m.userId)));
    return checks.filter(Boolean).length;
  } catch {
    return 0;
  }
}

// ── Sunucu serileştirici (paylaşılan) ────────────────────────────────────────
async function serializeServer(s: ServerRow) {
  const [channels, onlineCount] = await Promise.all([
    Channels.findWhere({ serverId: s._id, type: 'text' }),
    getOnlineCountFromPresence(s._id),
  ]);
  return {
    _id:          s._id,
    name:         s.name,
    icon:         s.icon,
    iconUrl:      s.iconUrl,
    bannerUrl:    s.bannerUrl,
    description:  s.description  || '',
    tags:         normalizeTags(s.tags),
    category:     s.category      || 'other',
    memberCount:  s._memberCount  || 0,
    onlineCount,
    channelCount: channels.length,
    createdAt:    s.createdAt,
    featured:     Boolean(s.featured),
    featuredAt:   s.featuredAt    || null,
  };
}

// ── GET /api/discover — ana liste ─────────────────────────────────────────────
/**
 * @openapi
 * /discover:
 *   get:
 *     tags: [Discover]
 *     summary: Sunucu keşif listesi
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string, enum: [gaming, music, art, tech, edu, social, other] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Arama sorgusu
 *     responses:
 *       200:
 *         description: Keşif listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Server' }
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const { q, tag, sort = 'members', category } = req.query;

  let servers = await Servers.find({ discoverable: 1 }) as ServerRow[];

  if (!servers.length) {
    const allServers = await Servers.find({}) as ServerRow[];
    const counts = await Promise.all(allServers.map((s: ServerRow) => getMemberCountCached(s._id)));
    allServers.forEach((s: ServerRow, i: number) => { s._memberCount = counts[i]; });
    servers = allServers.filter((s: ServerRow) => s._memberCount! > 1);
  } else {
    const counts = await Promise.all(servers.map((s: ServerRow) => getMemberCountCached(s._id)));
    servers.forEach((s: ServerRow, i: number) => { s._memberCount = counts[i]; });
    // Boş sunucuları discover listesinde göstermeyelim. Aksi halde discoverable=1
    // bırakılmış ama hiç üyesi olmayan test/ghost server kayıtları listede görünür.
    servers = servers.filter((s: ServerRow) => (s._memberCount ?? 0) > 0);
  }

  const qText = queryString(q);
  const tagText = queryString(tag);
  const categoryText = queryString(category);

  if (qText.trim()) {
    const lq = qText.trim().toLowerCase();
    servers = servers.filter((s: ServerRow) =>
      s.name.toLowerCase().includes(lq) ||
      (s.description || '').toLowerCase().includes(lq) ||
      normalizeTags(s.tags).some((t: string) => t.toLowerCase().includes(lq))
    );
  }

  if (tagText.trim()) {
    const lt = tagText.trim().toLowerCase();
    servers = servers.filter((s: ServerRow) =>
      normalizeTags(s.tags).some((t: string) => t.toLowerCase() === lt)
    );
  }

  if (categoryText.trim() && DISCOVER_CATEGORIES.includes(categoryText.trim() as DiscoverCategory)) {
    servers = servers.filter((s: ServerRow) => (s.category || 'other') === categoryText.trim());
  }

  if      (sort === 'members') servers.sort((a: ServerRow, b: ServerRow) => (b._memberCount || 0) - (a._memberCount || 0));
  else if (sort === 'newest')  servers.sort((a: ServerRow, b: ServerRow) => b.createdAt - a.createdAt);
  else if (sort === 'name')    servers.sort((a: ServerRow, b: ServerRow) => a.name.localeCompare(b.name));
  else if (sort === 'online') {
    const online = await Promise.all(servers.map((s: ServerRow) => getOnlineCountFromPresence(s._id)));
    servers.forEach((s: ServerRow, i: number) => { s._onlinePre = online[i]; });
    servers.sort((a: ServerRow, b: ServerRow) => (b._onlinePre || 0) - (a._onlinePre || 0));
  }

  const result = await Promise.all(servers.slice(0, DISCOVER_LIMIT).map(serializeServer));
  res.json(result);
});

// ── GET /api/discover/featured — öne çıkan sunucular ─────────────────────────
/**
 * @openapi
 * /discover/featured:
 *   get:
 *     tags: [Discover]
 *     summary: Öne çıkan sunucular
 *     responses:
 *       200:
 *         description: Öne çıkan liste (max 12)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Server' }
 */
router.get('/featured', authMiddleware, async (req: Request, res: Response) => {
  const CACHE_KEY = 'discover:featured:list';
  try {
    const cached = await cache.get(CACHE_KEY);
    if (typeof cached === 'string') return res.json(JSON.parse(cached));
  } catch { /* cache miss */ }

  const servers = await Servers.find({ featured: 1 }) as ServerRow[];
  const counts = await Promise.all(servers.map((s: ServerRow) => getMemberCountCached(s._id)));
  servers.forEach((s: ServerRow, i: number) => { s._memberCount = counts[i]; });
  servers.sort((a: ServerRow, b: ServerRow) => (b.featuredAt || 0) - (a.featuredAt || 0));

  const result = await Promise.all(servers.slice(0, 12).map(serializeServer));
  try { await cache.set(CACHE_KEY, JSON.stringify(result), FEATURED_TTL); } catch {}
  res.json(result);
});

// ── GET /api/discover/categories ─────────────────────────────────────────────
/**
 * @openapi
 * /discover/categories:
 *   get:
 *     tags: [Discover]
 *     summary: Kategori listesi
 *     security: []
 *     responses:
 *       200:
 *         description: Kategoriler
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: string }
 */
router.get('/categories', (req: Request, res: Response) => {
  const LABELS: Record<string, string> = {
    gaming: '🎮 Oyun', music: '🎵 Müzik', art: '🎨 Sanat',
    tech: '💻 Teknoloji', edu: '📚 Eğitim', social: '💬 Sosyal', other: '🌐 Diğer',
  };
  res.json(DISCOVER_CATEGORIES.map(id => ({ id, label: LABELS[id] || id })));
});

// ── PATCH /api/discover/settings ─────────────────────────────────────────────
/**
 * @openapi
 * /discover/settings:
 *   patch:
 *     tags: [Discover]
 *     summary: Sunucu keşif ayarları güncelle
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               serverId: { type: string }
 *               category: { type: string }
 *               listed: { type: boolean }
 *     responses:
 *       200: { description: Ayarlar güncellendi }
 */
router.patch('/settings', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { serverId, discoverable, description, tags, category } = req.body as { serverId?: string; discoverable?: boolean | string; description?: string; tags?: string[]; category?: string };
  if (!serverId) return res.status(400).json({ error: 'serverId required' });

  const server = await Servers.findById(serverId);
  if (!server)                  return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Only owner can update discovery' });

  const update: Record<string, unknown> = {};
  if (discoverable !== undefined) update.discoverable = discoverable ? 1 : 0;
  if (description  !== undefined) update.description  = String(description).trim().slice(0, 500);
  if (tags && Array.isArray(tags)) update.tags        = tags.slice(0, 10).map((t: unknown) => String(t).trim().toLowerCase().slice(0, 30));
  if (category && DISCOVER_CATEGORIES.includes(category as DiscoverCategory)) update.category = category;

  await Servers.update(serverId, update);
  res.json({ ok: true });
});

// ── POST /api/admin/discover/feature — admin öne çıkar ───────────────────────
// Not: bu router /api/discover altına mount edilir; tam yol /api/discover/admin/feature olur.
/**
 * @openapi
 * /discover/admin/feature:
 *   post:
 *     tags: [Discover, Admin]
 *     summary: Sunucuyu öne çıkar / kaldır
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [serverId, featured]
 *             properties:
 *               serverId: { type: string }
 *               featured: { type: boolean }
 *     responses:
 *       200: { description: Öne çıkarma durumu güncellendi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
async function updateFeaturedServer(req: Request, res: Response): Promise<Response | void> {
  const _u = castAuthed(req).user;
  if (!(_u?.role === 'admin' || _u?.flags?.includes?.('admin') || _u?.isAdmin)) {
    return res.status(403).json({ error: 'Sadece admin öne çıkarabilir' });
  }
  const { serverId } = req.body as { serverId?: string };
  const featuredRaw = (req.body as { featured?: unknown }).featured;
  const featured = featuredRaw === true || featuredRaw === 1 || featuredRaw === 'true' || featuredRaw === '1';
  if (!serverId) return res.status(400).json({ error: 'serverId gerekli' });

  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });

  await Servers.update(serverId, {
    featured:   featured ? 1 : 0,
    featuredAt: featured ? Date.now() : null,
  });
  try { await cache.del('discover:featured:list'); } catch {}
  res.json({ ok: true, serverId, featured });
}

router.post('/admin/feature', authMiddleware, limits.write(), updateFeaturedServer);
adminDiscoverRouter.post('/feature', authMiddleware, limits.write(), updateFeaturedServer);

export default router;
