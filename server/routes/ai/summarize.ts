// server/routes/ai/summarize.ts — Channel summarization route
/**
 * @openapi
 * /ai/summarize/{channelId}:
 *   get:
 *     tags: [AI]
 *     summary: Kanal mesajlarını özetle
 *     description: >
 *       Son `limit` mesajı (max 100) alır; AI etkinse LLM ile, değilse
 *       kural tabanlı rulesSummary() ile özetler. Sonuç 5 dakika Redis'te önbelleğe alınır.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 100 }
 *     responses:
 *       200:
 *         description: Özet başarıyla oluşturuldu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 summary:      { type: string }
 *                 provider:     { type: string, example: groq }
 *                 messageCount: { type: integer }
 *                 participants: { type: integer }
 *                 from:         { type: integer }
 *                 to:           { type: integer }
 *                 cached:       { type: boolean }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */

import express from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router();

import { Channels, Members, Messages, Users } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { cache } from '../../lib/redisAdapter';
import { rulesSummary, MessageLike } from '../../lib/modRules';
import { callAI, AI_ENABLED, PROVIDER, safeProvider } from '../../lib/aiProvider';

// GET /api/ai/summarize/:channelId
router.get('/:channelId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.channelId ?? '');
  const limit = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);

  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });
  if (!await Members.findOne(_u.id, channel.serverId))
    return res.status(403).json({ error: 'Üye değilsiniz' });

  const cacheKey = `ai:sum:${channelId}:${limit}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const msgs = (await Messages.messagesFind({ channelId, type: { $ne: 'system' } })
    .sort({ createdAt: -1 }).limit(limit)).reverse();

  const userIds = [...new Set(msgs.map((m: { userId: string }) => m.userId))];
  const users   = await Users.findByIds(userIds);
  const userMap: Record<string, string> = {};
  users.forEach((u: { _id: string; displayName?: string; username: string }) => {
    userMap[u._id] = u.displayName || u.username;
  });

  let summary: string;
  let provider = PROVIDER;

  if (AI_ENABLED) {
    const transcript = msgs
      .map((m: MessageLike) =>
        `${userMap[m.userId] || '?'}: ${(m.content || '').slice(0, 150)}`)
      .join('\n');
    summary = await callAI(
      'Bridge chat asistanı. Türkçe, kısa özetle. 2-3 cümle + ana konular (maddeli).',
      `Son ${msgs.length} mesaj:\n${transcript.slice(0, 5000)}`,
    );
  } else {
    summary  = rulesSummary(msgs, userMap);
    provider = 'rules';
  }

  const result = {
    summary,
    provider,
    messageCount:  msgs.length,
    participants:  userIds.length,
    from:          msgs[0]?.createdAt,
    to:            msgs[msgs.length - 1]?.createdAt,
  };
  await cache.set(cacheKey, result, 300);
  res.json(result);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
