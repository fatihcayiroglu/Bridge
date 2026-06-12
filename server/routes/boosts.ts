// server/routes/boosts.ts — Sprint 93
// Sprint 98: db.query() → BoostRepository geçişi ✅
// Sprint 105: OpenAPI annotations eklendi

/**
 * @openapi
 * /servers/{sid}/boosts:
 *   get:
 *     tags: [Boosts]
 *     summary: Sunucu boost listesi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Boost listesi }
 *   post:
 *     tags: [Boosts]
 *     summary: Sunucuyu boost et
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Boost başarılı }
 *       409: { description: Zaten boost edilmiş }
 *   delete:
 *     tags: [Boosts]
 *     summary: Boost geri al
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Boost kaldırıldı }
 * /servers/vanity/{slug}:
 *   get:
 *     tags: [Boosts]
 *     summary: Vanity URL ile sunucu bul
 *     parameters:
 *       - { name: slug, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Sunucu bilgisi }
 *       404: { description: Vanity URL bulunamadı }
 * /servers/{sid}/vanity:
 *   patch:
 *     tags: [Boosts]
 *     summary: Vanity URL güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sid, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug]
 *             properties:
 *               slug: { type: string, minLength: 2, maxLength: 32, pattern: '^[a-z0-9-]+$' }
 *     responses:
 *       200: { description: Vanity URL güncellendi }
 */

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { Boosts } from '../db/repositories/BoostRepository.js';

// ── Tier tanımları (client'taki BOOST_TIERS ile senkron) ──────────────────────
const BOOST_TIERS = [
  { level: 0, boosts: 0,  uploadLimitMB: 25,  audioBitrate: 96,  perks: [] },
  { level: 1, boosts: 2,  uploadLimitMB: 25,  audioBitrate: 128, perks: ['Özel emoji (+50)', 'HD ses kalitesi', 'Özel davet arka planı'] },
  { level: 2, boosts: 7,  uploadLimitMB: 50,  audioBitrate: 256, perks: ['Özel emoji (+100)', '256 kbps ses', 'Server banner', '50 MB dosya'] },
  { level: 3, boosts: 14, uploadLimitMB: 100, audioBitrate: 384, perks: ['Özel emoji (+250)', '384 kbps ses', 'Vanity URL', '100 MB dosya', 'Animasyonlu icon'] },
];

function getTier(count: number) {
  return [...BOOST_TIERS].reverse().find(t => count >= t.boosts) ?? BOOST_TIERS[0];
}

// ── GET /servers/:sid/boosts ──────────────────────────────────────────────────
router.get('/:sid/boosts', authMiddleware, async (req, res) => {
  const sid = String(req.params.sid ?? '');
  const row = await Boosts.getServerBoostInfo(sid);
  if (!row) return res.status(404).json({ error: 'Server not found' });

  const count    = row.boostCount ?? 0;
  const tier     = getTier(count);
  const boosters = await Boosts.getBoosters(sid);

  res.json({ count, tier: tier.level, perks: tier.perks, uploadLimitMB: tier.uploadLimitMB, audioBitrate: tier.audioBitrate, boosters });
});

// ── POST /servers/:sid/boosts — boost satın al ────────────────────────────────
router.post('/:sid/boosts', authMiddleware, limits.api(), async (req, res) => {
  const sid = String(req.params.sid ?? '');
  const me = castAuthed(req).user as { id: string };

  const serverRow = await Boosts.getServerBoostInfo(sid);
  if (!serverRow) return res.status(404).json({ error: 'Server not found' });

  const existing = await Boosts.getActiveBoost(sid, me.id);
  if (existing) return res.status(409).json({ error: 'Already boosting this server' });

  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await Boosts.addBoost(sid, me.id, expiresAt);

  const newCount = await Boosts.countActiveBoosts(sid);
  const newTier  = getTier(newCount);
  await Boosts.updateBoostStats(sid, newCount, newTier.level);

  res.json({ ok: true, count: newCount, tier: newTier.level });
});

// ── DELETE /servers/:sid/boosts — boost iptal ─────────────────────────────────
router.delete('/:sid/boosts', authMiddleware, async (req, res) => {
  const sid = String(req.params.sid ?? '');
  const me = castAuthed(req).user as { id: string };

  await Boosts.removeBoost(sid, me.id);

  const newCount = await Boosts.countActiveBoosts(sid);
  const newTier  = getTier(newCount);
  await Boosts.updateBoostStats(sid, newCount, newTier.level);

  res.json({ ok: true, count: newCount, tier: newTier.level });
});

// ── GET /servers/vanity/:slug — vanity URL resolve ───────────────────────────
router.get('/vanity/:slug', async (req, res) => {
  const slug   = String(String(req.params.slug ?? '') ?? "").toLowerCase().trim();
  const server = await Boosts.getByVanityUrl(slug);
  if (!server) return res.status(404).json({ error: 'Vanity URL not found' });
  res.json(server);
});

// ── PATCH /servers/:sid/vanity — vanity URL ayarla ───────────────────────────
router.patch('/:sid/vanity', authMiddleware, async (req, res) => {
  const sid = String(req.params.sid ?? '');
  const me = castAuthed(req).user as { id: string };
  const { vanityUrl } = req.body as { vanityUrl: string };

  const server = await Boosts.getServerOwnerAndTier(sid);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== me.id) return res.status(403).json({ error: 'Only server owner can set vanity URL' });

  if (server.boostTier < 3) return res.status(403).json({ error: 'Vanity URL requires Boost Level 3', code: 'BOOST_REQUIRED' });

  if (!vanityUrl) {
    await Boosts.setVanityUrl(sid, null);
    return res.json({ ok: true, vanityUrl: null });
  }

  const slug = vanityUrl.toLowerCase().trim();
  if (!/^[a-z0-9-]{3,32}$/.test(slug)) {
    return res.status(400).json({ error: 'Vanity URL must be 3–32 chars, letters/numbers/hyphens only' });
  }

  const RESERVED = new Set(['api', 'admin', 'login', 'register', 'discover', 'app', 'bridge', 'invite', 'support']);
  if (RESERVED.has(slug)) return res.status(400).json({ error: 'This vanity URL is reserved' });

  const conflict = await Boosts.checkVanityConflict(slug, sid);
  if (conflict) return res.status(409).json({ error: 'This vanity URL is already taken' });

  await Boosts.setVanityUrl(sid, slug);
  res.json({ ok: true, vanityUrl: slug });
});

export { router };
