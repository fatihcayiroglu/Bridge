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
import { channelDataBlock, CHANNEL_DATA_RULE } from '../../lib/aiContext';
import { callAI, AI_ENABLED, PROVIDER } from '../../lib/aiProvider';
import { serverAllowsAi } from '../../lib/aiServerPolicy';
import { limits } from '../../middleware/rateLimit';
import { createHash } from 'crypto';
import logger from '../../lib/logger';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { parseBoundedPositiveIntQuery } from '../../lib/queryNumbers';

// GET /api/ai/summarize/:channelId
// P5 AI-08: this sends channel history to the provider; it had no AI rate limit.
router.get('/:channelId', authMiddleware, limits.ai(), async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.channelId ?? '');
  const limit = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
  if (limit === null) return res.status(400).json({ error: 'limit must be a positive safe integer' });

  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });
  if (!await Members.findOne(_u.id, channel.serverId))
    return res.status(403).json({ error: 'Üye değilsiniz' });

  // FAZ F — VIEW_CHANNELS DENETIMI (sunucu uyeligi YETMEZ).
  //
  // Onceden yalniz uyelik denetleniyordu; oysa ozel bir kanal ayni sunucunun
  // uyesine de KAPALI olabilir. Sizinti AI'a bagli DEGILDI: saglayici
  // yapilandirilmamisken bile `rulesSummary` yedegi devreye giriyor ve
  // katilimci ADLARINI, en aktif kullaniciyi, mesaj sayisini, ilk/son zaman
  // damgalarini ve link sayisini donduruyordu. Yani gormeye yetkisi olmayan
  // bir uye, ozel kanali profilleyebiliyordu.
  //
  // Ayni kusur sinifi Faz D'de `search.ts` icinde duzeltilmisti.
  const perms = await resolvePermissions(_u.id, String(channel.serverId), channelId).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.READ_HISTORY))
    return res.status(403).json({ error: 'Bu kanalın geçmişini görüntüleyemezsiniz.' });

  // P5 AI-02: deleted messages are excluded in the QUERY, and the cache key
  // carries a fingerprint of exactly what would be summarised — a summary
  // made before a message was deleted (or edited) is never served after it.
  const msgs = ((await Messages.messagesFind({ channelId, deletedAt: null, type: { $ne: 'system' } })
    .sort({ createdAt: -1 }).limit(limit)) as Array<MessageLike & { _id?: string }>).reverse()
    .filter((m) => !(typeof m.content === 'string' && m.content.startsWith('🔒e2e:')));
  const fingerprint = createHash('sha256')
    .update(msgs.map((m) => `${m._id ?? ''}\u0000${m.content ?? ''}`).join('\u0001')).digest('hex').slice(0, 16);
  // P6: the server's AI setting is read on every request, BEFORE the cache —
  // a summary an AI wrote before the owner turned AI off is not served after.
  const serverAi = await serverAllowsAi(String(channel.serverId));
  const cacheKey = `ai:sum:${channelId}:${limit}:${fingerprint}`;
  const cached = serverAi ? await cache.get(cacheKey) : null;
  if (cached) return res.json({ ...cached, cached: true });

  const userIds = [...new Set(msgs.map((m: { userId: string }) => m.userId))];
  const users   = await Users.findByIds(userIds);
  const userMap: Record<string, string> = {};
  users.forEach((u: { _id: string; displayName?: string; username: string }) => {
    userMap[u._id] = u.displayName || u.username;
  });

  let summary: string;
  let provider = PROVIDER;
  let degraded = false;

  if (AI_ENABLED && serverAi) {
    const block = channelDataBlock(msgs.map((m: MessageLike) =>
      ({ author: userMap[m.userId] || '?', content: (m.content || '').slice(0, 150) })), 5000);
    try {
      summary = await callAI(
        `Bridge chat asistanı. Türkçe, kısa özetle. 2-3 cümle + ana konular (maddeli). ${CHANNEL_DATA_RULE}`,
        `Son ${msgs.length} mesaj:\n${block}`,
      );
    } catch (err) {
      // P5 AI-07: a provider outage degrades to the local summary — never a 500.
      logger.warn({ event: 'ai.summarize.degraded', err: err instanceof Error ? err.message.slice(0, 200) : 'non-error' },
        'AI provider unavailable; local summary served.');
      summary  = rulesSummary(msgs, userMap);
      provider = 'rules';
      degraded = true;
    }
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
    ...(degraded ? { degraded: true } : {}),
    ...(AI_ENABLED && !serverAi ? { aiDisabledForServer: true } : {}),
  };
  // An outage answer is not cached; neither is the local answer of a server
  // with AI off (turning AI back on must take effect on the next request).
  if (!degraded && serverAi) await cache.set(cacheKey, result, 300);
  res.json(result);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
