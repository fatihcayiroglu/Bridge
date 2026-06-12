// server/routes/ai/moderation.ts — Content moderation routes
/**
 * @openapi
 * /ai/moderate:
 *   post:
 *     tags: [AI]
 *     summary: Mesaj içeriği moderasyon kontrolü
 *     description: Kural tabanlı + AI zinciriyle moderasyon. Sonuç 1 saat önbelleğe alınır.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messageId]
 *             properties:
 *               messageId: { type: string }
 *     responses:
 *       200:
 *         description: Moderasyon kararı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 safe:      { type: boolean }
 *                 score:     { type: integer, minimum: 0, maximum: 100 }
 *                 categories:
 *                   type: object
 *                   properties:
 *                     hate: { type: boolean }
 *                     harassment: { type: boolean }
 *                     spam: { type: boolean }
 *                     nsfw: { type: boolean }
 *                 reason:    { type: string }
 *                 provider:  { type: string }
 *                 messageId: { type: string }
 *                 cached:    { type: boolean }
 *       400: { description: 'messageId eksik' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /ai/auto-moderate:
 *   post:
 *     tags: [AI]
 *     summary: Otomatik moderasyon
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content, serverId]
 *             properties:
 *               content:  { type: string }
 *               serverId: { type: string }
 *     responses:
 *       200:
 *         description: Moderasyon kararı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 safe:     { type: boolean }
 *                 score:    { type: integer }
 *                 reason:   { type: string }
 *                 provider: { type: string }
 *       429: { description: 'Rate limit aşıldı' }

 *
 * /ai/moderate:
 *   post:
 *     tags: [AI]
 *     summary: Icerik AI ile moderasyon kontrolunden gec
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:  { type: string }
 *               serverId: { type: string }
 *     responses:
 *       200:
 *         description: Moderasyon sonucu
 */

import express from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router();

import { Members, Messages, Servers } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { cache } from '../../lib/redisAdapter';
import { rulesMod } from '../../lib/modRules';
import { callAI, AI_ENABLED, PROVIDER, safeProvider } from '../../lib/aiProvider';

// POST /api/ai/moderate
router.post('/moderate', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const { messageId } = req.body as Record<string, string>;
  if (!messageId) return res.status(400).json({ error: 'messageId gerekli' });

  const msg = await Messages.findById(messageId);
  if (!msg) return res.status(404).json({ error: 'Mesaj bulunamadı' });
  if (!await Members.findOne(_u.id, msg.serverId))
    return res.status(403).json({ error: 'Üye değilsiniz' });

  const cacheKey = `ai:mod:${messageId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const ruleResult = rulesMod(msg.content ?? '');
  let result: Record<string, unknown> = { ...ruleResult, provider: safeProvider('rules') };

  if (AI_ENABLED && ruleResult.safe) {
    try {
      const raw = await callAI(
        'İçerik moderasyonu. Sadece JSON: {"safe":bool,"score":0-100,"categories":{"hate":bool,"harassment":bool,"spam":bool,"nsfw":bool},"reason":"Türkçe"}',
        `"${msg.content?.slice(0, 400)}"`,
        120,
      );
      result = { ...JSON.parse(raw.replace(/```json|```/g, '').trim()), provider: safeProvider(PROVIDER) };
    } catch { /* kural sonucu kullan */ }
  }

  result.messageId = messageId;
  await cache.set(cacheKey, result, 3600);
  res.json(result);
});

// POST /api/ai/auto-moderate
router.post('/auto-moderate', authMiddleware, limits.ai(), async (req, res) => {
  const { content, serverId } = req.body as Record<string, string>;
  if (!content?.trim()) return res.json({ safe: true, score: 100 });

  const server = await Servers.findById(serverId);
  if (!((server as unknown as Record<string, unknown>)?.autoModerate)) return res.json({ safe: true, score: 100 });

  const ruleResult = rulesMod(content);
  if (!ruleResult.safe) return res.json({ ...ruleResult, provider: safeProvider('rules') });

  if (AI_ENABLED) {
    try {
      const raw = await callAI(
        'Moderasyon. JSON: {"safe":bool,"score":0-100,"reason":"Türkçe"}',
        `"${content.slice(0, 200)}"`,
        60,
      );
      return res.json({ ...JSON.parse(raw.replace(/```json|```/g, '').trim()), provider: safeProvider(PROVIDER) });
    } catch { /* fall through */ }
  }

  return res.json({ ...ruleResult, provider: safeProvider('rules') });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
