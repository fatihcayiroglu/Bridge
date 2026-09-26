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
import { databaseAdminOnly } from '../lib/adminAuthority';
import { joinDiscoverableServer } from '../lib/serverMembership';
import { limits } from '../middleware/rateLimit';
import { isUserOnline } from '../lib/presenceCache';
import { cache } from '../lib/redisAdapter';
const MEMBER_COUNT_TTL  = 120; // saniye — üye sayısı cache
const FEATURED_TTL      = 300; // saniye — öne çıkan liste cache
const DISCOVER_DEFAULT_LIMIT = 50;
const DISCOVER_MAX_LIMIT     = 1000;

export const DISCOVER_CATEGORIES = [
  'gaming', 'music', 'art', 'tech', 'education', 'community', 'anime', 'science', 'social', 'other',
] as const;
export type DiscoverCategory = typeof DISCOVER_CATEGORIES[number];

function normalizeDiscoverCategory(value: unknown): DiscoverCategory {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'edu') return 'education'; // legacy migration value
  return DISCOVER_CATEGORIES.includes(raw as DiscoverCategory)
    ? raw as DiscoverCategory
    : 'other';
}

function requestedLimit(value: unknown): number {
  if (value === undefined) return DISCOVER_DEFAULT_LIMIT;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DISCOVER_DEFAULT_LIMIT;
  return Math.min(parsed, DISCOVER_MAX_LIMIT);
}

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

function parseOptionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;
  return null;
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
    category:     normalizeDiscoverCategory(s.category),
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
 *         schema: { type: string, enum: [gaming, music, art, tech, education, community, anime, science, social, other] }
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
  const { q, tag, sort = 'members', category, limit } = req.query;

  let servers = await Servers.find({ discoverable: 1 }) as ServerRow[];
  const counts = await Promise.all(servers.map((s: ServerRow) => getMemberCountCached(s._id)));
  servers.forEach((s: ServerRow, i: number) => { s._memberCount = counts[i]; });
  // Gizli/private sunucular hiçbir koşulda fallback olarak keşfe düşmez.
  // Boş discoverable test/ghost kayıtlarını da listeleme.
  servers = servers.filter((s: ServerRow) => (s._memberCount ?? 0) > 0);

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

  const rawCategory = categoryText.trim().toLowerCase();
  if (rawCategory && (rawCategory === 'edu' || DISCOVER_CATEGORIES.includes(rawCategory as DiscoverCategory))) {
    const wanted = normalizeDiscoverCategory(rawCategory);
    servers = servers.filter((s: ServerRow) => normalizeDiscoverCategory(s.category) === wanted);
  }

  if      (sort === 'members') servers.sort((a: ServerRow, b: ServerRow) => (b._memberCount || 0) - (a._memberCount || 0));
  else if (sort === 'newest')  servers.sort((a: ServerRow, b: ServerRow) => b.createdAt - a.createdAt);
  else if (sort === 'name')    servers.sort((a: ServerRow, b: ServerRow) => a.name.localeCompare(b.name));
  else if (sort === 'online') {
    const online = await Promise.all(servers.map((s: ServerRow) => getOnlineCountFromPresence(s._id)));
    servers.forEach((s: ServerRow, i: number) => { s._onlinePre = online[i]; });
    servers.sort((a: ServerRow, b: ServerRow) => (b._onlinePre || 0) - (a._onlinePre || 0));
  }

  const result = await Promise.all(servers.slice(0, requestedLimit(limit)).map(serializeServer));
  res.json(result);
});

// ── POST /api/discover/:serverId/join ────────────────────────────────────────
router.post('/:serverId/join', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const result = await joinDiscoverableServer(
    { id: _u.id, username: _u.username, displayName: _u.displayName },
    serverId,
  );

  // Legacy discover endpoint keeps its historical 404 for private servers,
  // but authorization semantics are now identical to /servers/:sid/join.
  if (result.status === 'not_found' || result.status === 'invite_required') {
    return res.status(404).json({ error: 'Discoverable server not found' });
  }
  if (result.status === 'banned') return res.status(403).json({ error: 'BANNED' });
  if (result.status === 'already_member') return res.status(400).json({ error: 'Already a member' });
  if (result.status === 'mfa_required') {
    return res.status(403).json({
      error: 'MFA_REQUIRED',
      message: 'Bu sunucuya katılmak için bir güvenlik anahtarı (passkey) kaydetmeniz gerekiyor.',
      mfaLevel: result.mfaLevel,
    });
  }
  return res.status(201).json({ ok: true });
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
  const CACHE_KEY = 'discover:featured:list:v2';
  try {
    const cached = await cache.get(CACHE_KEY);
    if (typeof cached === 'string') return res.json(JSON.parse(cached));
  } catch { /* cache miss */ }

  const servers = await Servers.find({ featured: true, discoverable: 1 }) as ServerRow[];
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
 *               items:
 *                 type: object
 *                 required: [id, label]
 *                 properties:
 *                   id: { type: string, enum: [gaming, music, art, tech, education, community, anime, science, social, other] }
 *                   label: { type: string }
 */
router.get('/categories', (req: Request, res: Response) => {
  const LABELS: Record<string, string> = {
    gaming: '🎮 Oyun', music: '🎵 Müzik', art: '🎨 Sanat',
    tech: '💻 Teknoloji', education: '📚 Eğitim', community: '👥 Topluluk',
    anime: '⛩️ Anime', science: '🔬 Bilim', social: '💬 Sosyal', other: '🌐 Diğer',
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
 *               category: { type: string, enum: [gaming, music, art, tech, education, community, anime, science, social, other] }
 *               discoverable: { type: boolean }
 *               description: { type: string, maxLength: 500 }
 *               tags:
 *                 type: array
 *                 maxItems: 10
 *                 items: { type: string }
 *     responses:
 *       200: { description: Ayarlar güncellendi }
 */
router.patch('/settings', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { serverId, discoverable, description, tags, category } = req.body as { serverId?: unknown; discoverable?: unknown; description?: unknown; tags?: unknown; category?: unknown };
  if (typeof serverId !== 'string' || !serverId.trim()) return res.status(400).json({ error: 'serverId required' });
  const discoverableBool = parseOptionalBoolean(discoverable);
  if (discoverableBool === null) return res.status(400).json({ error: 'discoverable must be boolean' });
  if (description !== undefined && typeof description !== 'string') return res.status(400).json({ error: 'description must be string' });
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')))
    return res.status(400).json({ error: 'tags must be an array of strings' });
  if (category !== undefined) {
    if (typeof category !== 'string') return res.status(400).json({ error: 'Invalid category' });
    const rawCategory = category.trim().toLowerCase();
    if (rawCategory !== 'edu' && !DISCOVER_CATEGORIES.includes(rawCategory as DiscoverCategory))
      return res.status(400).json({ error: 'Invalid category' });
  }

  const server = await Servers.findById(serverId);
  if (!server)                  return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Only owner can update discovery' });

  const update: Record<string, unknown> = {};
  if (discoverableBool !== undefined) update.discoverable = discoverableBool;
  if (description !== undefined) update.description = description.trim().slice(0, 500);
  if (tags !== undefined) update.tags = tags.slice(0, 10).map((t) => t.trim().toLowerCase().slice(0, 30));
  if (category !== undefined) update.category = normalizeDiscoverCategory(category);

  await Servers.update(serverId, update);
  // Featured sonucu sunucu metadata'sını içerir; discoverable/description/category
  // değişikliği eski private/public durumunu cache'te tutmamalı.
  try { await cache.del('discover:featured:list:v2'); } catch {}
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
  const { serverId } = req.body as { serverId?: unknown };
  const featured = parseOptionalBoolean((req.body as { featured?: unknown }).featured);
  if (typeof serverId !== 'string' || !serverId.trim()) return res.status(400).json({ error: 'serverId gerekli' });
  if (featured === undefined || featured === null) return res.status(400).json({ error: 'featured must be boolean' });

  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });

  await Servers.update(serverId, {
    featured,
    featuredAt: featured ? Date.now() : null,
  });
  try { await cache.del('discover:featured:list:v2'); } catch {}
  res.json({ ok: true, serverId, featured });
}

router.post('/admin/feature', authMiddleware, databaseAdminOnly, limits.write(), updateFeaturedServer);
adminDiscoverRouter.post('/feature', authMiddleware, databaseAdminOnly, limits.write(), updateFeaturedServer);

export default router;
