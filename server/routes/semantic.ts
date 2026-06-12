/**
 * @openapi
 * tags:
 *   - name: Semantic
 *     description: Semantic API endpoints

 *
 * /semantic/search:
 *   post:
 *     tags: [Search]
 *     summary: Semantik mesaj arama (AI embedding)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query, serverId]
 *             properties:
 *               query:    { type: string, description: 'Doğal dil sorgu' }
 *               serverId: { type: string }
 *               limit:    { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: Eşleşen mesajlar
 *
 * /semantic/digest/{serverId}:
 *   get:
 *     tags: [AI]
 *     summary: Sunucu haftalık digest oluştur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Haftalık özet
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /semantic/engagement/{serverId}:
 *   get:
 *     tags: [AI]
 *     summary: Sunucu bağlılık analizi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bağlılık metrikleri
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/semantic.ts: AI Semantic Search
// "Bu haftaki önemli kararlar" gibi doğal dil sorguları
// Groq/Gemini/OpenRouter/Ollama ile çalışır — API key gerekmez (kural tabanlı fallback)

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import { Members, Messages, Users, Channels } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { cache } from '../lib/redisAdapter';
import { limits } from '../middleware/rateLimit';

import { callAI, AI_ENABLED } from '../lib/aiProvider';
import logger from '../lib/logger';
import { generateEmbedding, vectorSearch, PGVECTOR_ENABLED, EMBEDDING_PROVIDER } from '../lib/pgvector';

// ── KURAL TABANLI FALLBACK ──────────────────────────────────────
function keywordSearch<T extends { content?: string }>(query: string, messages: T[]): Array<T & { _score: number }> {
  const q = query.toLowerCase();
  const keywords = q.split(/\s+/).filter(w => w.length > 2);
  return messages
    .map(m => {
      const content = String(m.content || '').toLowerCase();
      const score = keywords.reduce((s, kw) => s + (content.includes(kw) ? 1 : 0), 0);
      return { ...m, _score: score };
    })
    .filter(m => m._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 10);
}

// ── POST /api/semantic/search — Doğal dil mesaj araması ─────────
router.post('/search', authMiddleware, limits.ai(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { query, serverId, channelId, days: rawDays = 7 } = req.body as { query?: string; serverId?: string; channelId?: string; days?: unknown; limit?: unknown };
  const days = Number(rawDays) || 7;
  if (!query?.trim()) return res.status(400).json({ error: 'query gerekli' });
  if (!serverId)      return res.status(400).json({ error: 'serverId gerekli' });

  // Üyelik kontrolü
  const member = await Members.findOne(_u.id, serverId);
  if (!member) return res.status(403).json({ error: 'Bu sunucuya üye değilsiniz' });

  const cacheKey = `sem:${serverId}:${channelId || ''}:${query.slice(0,50)}:${days}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  // Mesajları getir
  const since = Date.now() - (days * 24 * 60 * 60 * 1000);
  const filter: Record<string, unknown> = { serverId, createdAt: { $gt: since }, type: { $ne: 'system' } };
  if (channelId) filter.channelId = channelId;

  const messages = await Messages.messagesFind(filter).sort({ createdAt: -1 }).limit(200);
  if (!messages.length) return res.json({ results: [], query, provider: 'none', total: 0 });

  // Kullanıcı adlarını getir
  const userIds = [...new Set(messages.map(m => m.userId))];
  const users   = await Users.findByIds(userIds);
  const userMap: Record<string, string> = {};
  users.forEach(u => { userMap[u._id] = u.displayName || u.username; });

  // Kanal adlarını getir
  const channelIds = [...new Set(messages.map(m => m.channelId))];
  const channels   = await Channels.findWhere({ _id: { $in: channelIds } });
  const channelMap: Record<string, string> = {};
  channels.forEach(c => { channelMap[c._id] = c.name; });

  let results;
  let provider = 'rules';

  // ── pgvector semantik arama (AI_ENABLED gerektirmez) ─────────────────────
  if (PGVECTOR_ENABLED) {
    try {
      const embedding = await generateEmbedding(query);
      if (embedding) {
        // PostgreSQL pool'u repositories'den al
        const { pool } = await import('../db/postgres');
        const vectorMatches = await vectorSearch({
          db:        pool,
          embedding,
          serverId,
          channelId: channelId || undefined,
          since,
          limit:     Number(req.body.limit) || 10,
        });

        if (vectorMatches.length > 0) {
          // vectorSearch message_id dizisi döner, mesajları eşleştir
          const matchedMessages = vectorMatches
            .map(vm => messages.find(m => m._id === vm.message_id))
            .filter((m): m is NonNullable<typeof m> => Boolean(m));

          if (matchedMessages.length > 0) {
            results = {
              matches: matchedMessages.map(m => ({
                _id:         m._id,
                content:     m.content,
                userId:      m.userId,
                username:    userMap[m.userId] || '?',
                channelId:   m.channelId,
                channelName: channelMap[m.channelId] || '?',
                createdAt:   m.createdAt,
              })),
              explanation: `pgvector cosine similarity araması (${EMBEDDING_PROVIDER}) — ${matchedMessages.length} sonuç.`,
            };
            provider = `pgvector:${EMBEDDING_PROVIDER}`;
          }
        }
      }
    } catch (err) {
      logger.warn({ err, event: 'semantic.pgvector.failed' }, 'pgvector araması başarısız, devam ediliyor.');
    }
  }

  // ── AI araması (pgvector sonuç vermediyse veya devre dışıysa) ────────────
  if (!results && AI_ENABLED) {
    try {
      // AI'ya mesajları ver ve ilgilileri bul
      const transcript = messages.slice(0, 100).map((m, i) =>
        `[${i}] #${channelMap[m.channelId] || '?'} ${userMap[m.userId] || '?'}: ${(m.content || '').slice(0, 120)}`
      ).join('\n');

      const raw = await callAI(
        'Semantic arama asistanı. Kullanıcının sorgusuna en uygun mesajların indeks numaralarını döndür. Sadece JSON: {"indices":[0,3,7,...],"explanation":"Türkçe kısa açıklama"}',
        `Sorgu: "${query}"\n\nMesajlar:\n${transcript.slice(0, 6000)}`,
        200
      );

      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as { indices?: number[]; explanation?: string };
      const indices = (parsed.indices || []).slice(0, 15);
      results = {
        matches: indices.map((i: number) => messages[i]).filter((m): m is NonNullable<typeof m> => Boolean(m)).map(m => ({
          _id: m._id, content: m.content, userId: m.userId,
          username: userMap[m.userId] || '?', channelId: m.channelId,
          channelName: channelMap[m.channelId] || '?', createdAt: m.createdAt,
        })),
        explanation: parsed.explanation || '',
      };
       
      provider = ((await import('../lib/aiProvider')) as { PROVIDER?: string }).PROVIDER ?? 'unknown';
    } catch {
      // Fallback
      const matched = keywordSearch(query, messages);
      results = {
        matches: matched.map(m => ({
          _id: m._id, content: m.content, userId: m.userId,
          username: userMap[m.userId] || '?', channelId: m.channelId,
          channelName: channelMap[m.channelId] || '?', createdAt: m.createdAt,
        })),
        explanation: 'Anahtar kelime eşleşmesi kullanıldı.',
      };
    }
  } else if (!results) {
    // pgvector da sonuç vermedi, AI da kapalı — keyword fallback
    const matched = keywordSearch(query, messages);
    results = {
      matches: matched.map(m => ({
        _id: m._id, content: m.content, userId: m.userId,
        username: userMap[m.userId] || '?', channelId: m.channelId,
        channelName: channelMap[m.channelId] || '?', createdAt: m.createdAt,
      })),
      explanation: 'AI aktif değil — anahtar kelime araması kullanıldı. GROQ_API_KEY ekleyerek AI aramayı etkinleştirin.',
    };
  }

  // Son güvenlik ağı: pgvector + AI her ikisi de sonuç vermediyse keyword fallback
  if (!results) {
    const matched = keywordSearch(query, messages);
    results = {
      matches: matched.map(m => ({
        _id: m._id, content: m.content, userId: m.userId,
        username: userMap[m.userId] || '?', channelId: m.channelId,
        channelName: channelMap[m.channelId] || '?', createdAt: m.createdAt,
      })),
      explanation: 'Anahtar kelime eşleşmesi (fallback).',
    };
    provider = 'rules';
  }

  const out = { ...results, query, provider, total: results.matches.length, days, aiDisabled: !AI_ENABLED };
  await cache.set(cacheKey, out, 180); // 3dk cache
  res.json(out);
});

// ── GET /api/semantic/digest/:serverId — Haftalık özet ─────────
router.get('/digest/:serverId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const days = parseInt(String(req.query.days ?? '')) || 7;

  const member = await Members.findOne(_u.id, serverId);
  if (!member) return res.status(403).json({ error: 'Üye değilsiniz' });

  const cacheKey = `digest:${serverId}:${days}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const since = Date.now() - (days * 24 * 60 * 60 * 1000);

  // Tüm kanalları getir
  const channels = await Channels.findWhere({ serverId, type: 'text' });

  // Her kanal için mesaj sayısı ve en çok reaction alanlar
  const channelStats = await Promise.all(channels.map(async ch => {
    const msgs = await Messages.findWhere({ channelId: ch._id, createdAt: { $gt: since } });
    const topMsgs = msgs
      .filter(m => m.content && m.reactions)
      .map(m => {
        let reactionCount = 0;
        try { const r = JSON.parse(m.reactions || '{}'); reactionCount = (Object.values(r) as unknown[][]).reduce((s: number, v: unknown) => s + (Array.isArray(v) ? v.length : 0), 0); } catch {}
        return { ...m, reactionCount };
      })
      .sort((a: { reactionCount: number }, b: { reactionCount: number }) => b.reactionCount - a.reactionCount)
      .slice(0, 3);

    return { channelId: ch._id, channelName: ch.name, messageCount: msgs.length, topMessages: topMsgs };
  }));

  // Aktif üyeler
  const allMsgs = await Messages.findWhere({ serverId, createdAt: { $gt: since } });
  const msgByUser: Record<string, number> = {};
  allMsgs.forEach(m => { msgByUser[m.userId] = (msgByUser[m.userId] || 0) + 1; });
  const topUsers = Object.entries(msgByUser)
    .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
    .slice(0, 5)
    .map(([uid, count]) => ({ userId: uid, messageCount: count }));

  const userIds = topUsers.map(u => u.userId);
  const users = await Users.findByIds(userIds);
  const userMap: Record<string, string> = {};
  users.forEach(u => { userMap[u._id] = u.displayName || u.username; });
  topUsers.forEach((u: { userId: string; username?: string }) => { u.username = userMap[u.userId] || '?'; });

  // AI özet
  let aiSummary = null;
  if (AI_ENABLED && allMsgs.length > 0) {
    try {
      const topContent = allMsgs
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 60)
        .map(m => (m.content || '').slice(0, 100))
        .join('\n');

      aiSummary = await callAI(
        'Topluluk digest asistanı. Son X günün özetini yaz. Türkçe, 3-4 cümle, toplulukta ne konuşuldu, öne çıkan konular neler.',
        `Son ${days} günün mesajları:\n${topContent}`,
        300
      );
    } catch { aiSummary = null; }
  }

  const out = {
    serverId, days,
    totalMessages: allMsgs.length,
    channelStats: channelStats.filter(c => c.messageCount > 0).sort((a, b) => b.messageCount - a.messageCount),
    topUsers,
    aiSummary,
    generatedAt: Date.now(),
  };
  await cache.set(cacheKey, out, 1800); // 30dk cache
  res.json(out);
});

// ── GET /api/semantic/engagement/:serverId — Bağlılık skoru ────
router.get('/engagement/:serverId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');

  const member = await Members.findOne(_u.id, serverId);
  if (!member) return res.status(403).json({ error: 'Üye değilsiniz' });

  // Son 30 günlük veri
  const now = Date.now();
  const periods = [7, 14, 30].map(d => ({ days: d, since: now - d * 86400000 }));

  const scores = await Promise.all(periods.map(async ({ days, since }) => {
    const msgs = await Messages.findWhere({ serverId, createdAt: { $gt: since } });
    const activeUsers = new Set(msgs.map(m => m.userId)).size;
    const members = await Members.findByServer(serverId);
    const engagement = members.length > 0 ? Math.round((activeUsers / members.length) * 100) : 0;
    return { days, messages: msgs.length, activeUsers, totalMembers: members.length, engagementPct: engagement };
  }));

  // Trend hesapla
  const week = scores[0];
  const twoWeek = scores[1];
  const trend = twoWeek.messages > 0
    ? Math.round(((week.messages - twoWeek.messages / 2) / (twoWeek.messages / 2)) * 100)
    : 0;

  // En aktif saatler (son 7 gün)
  const recentMsgs = await Messages.findWhere({ serverId, createdAt: { $gt: now - 7 * 86400000 } });
  const hourCounts = new Array(24).fill(0);
  recentMsgs.forEach(m => {
    const hour = new Date(m.createdAt).getHours();
    hourCounts[hour]++;
  });
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  res.json({
    serverId,
    periods: scores,
    trend: { pct: trend, direction: trend > 0 ? 'up' : trend < 0 ? 'down' : 'stable' },
    peakHour,
    peakHourFormatted: `${peakHour}:00 - ${(peakHour + 1) % 24}:00`,
    generatedAt: now,
  });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
