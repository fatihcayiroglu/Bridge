// server/routes/semantic.js: AI Semantic Search
// "Bu haftaki önemli kararlar" gibi doğal dil sorguları
// Groq/Gemini/OpenRouter/Ollama ile çalışır — API key gerekmez (kural tabanlı fallback)

const express      = require('express');
const router       = express.Router();
const { Members, Messages, Users, Channels } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { cache }    = require('../lib/redisAdapter');
const { limits }   = require('../middleware/rateLimit');

const { callAI, AI_ENABLED } = require('../lib/aiProvider');

// ── KURAL TABANLI FALLBACK ──────────────────────────────────────
function keywordSearch(query, messages) {
  const q = query.toLowerCase();
  const keywords = q.split(/\s+/).filter(w => w.length > 2);
  return messages
    .map(m => {
      const content = (m.content || '').toLowerCase();
      const score = keywords.reduce((s, kw) => s + (content.includes(kw) ? 1 : 0), 0);
      return { ...m, _score: score };
    })
    .filter(m => m._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 10);
}

// ── POST /api/semantic/search — Doğal dil mesaj araması ─────────
router.post('/search', authMiddleware, limits.ai(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { query, serverId, channelId, days = 7 } = req.body;
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
  const filter: Record<string,any> = { serverId, createdAt: { $gt: since }, type: { $ne: 'system' } };
  if (channelId) filter.channelId = channelId;

  const messages = await Messages.messagesFind(filter).sort({ createdAt: -1 }).limit(200);
  if (!messages.length) return res.json({ results: [], query, provider: 'none', total: 0 });

  // Kullanıcı adlarını getir
  const userIds = [...new Set(messages.map(m => m.userId))];
  const users   = await Users.findByIds(userIds);
  const userMap = {};
  users.forEach(u => { userMap[u._id] = u.displayName || u.username; });

  // Kanal adlarını getir
  const channelIds = [...new Set(messages.map(m => m.channelId))];
  const channels   = await Channels.findWhere({ _id: { $in: channelIds } });
  const channelMap = {};
  channels.forEach(c => { channelMap[c._id] = c.name; });

  let results;
  let provider = 'rules';

  if (AI_ENABLED) {
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

      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      const indices = (parsed.indices || []).slice(0, 15);
      results = {
        matches: indices.map(i => messages[i]).filter(Boolean).map(m => ({
          _id: m._id, content: m.content, userId: m.userId,
          username: userMap[m.userId] || '?', channelId: m.channelId,
          channelName: channelMap[m.channelId] || '?', createdAt: m.createdAt,
        })),
        explanation: parsed.explanation || '',
      };
      provider = require('../lib/aiProvider').PROVIDER;
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
  } else {
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

  const out = { ...results, query, provider, total: results.matches.length, days, aiDisabled: !AI_ENABLED };
  await cache.set(cacheKey, out, 180); // 3dk cache
  res.json(out);
}));

// ── GET /api/semantic/digest/:serverId — Haftalık özet ─────────
router.get('/digest/:serverId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;
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
        try { const r = JSON.parse(m.reactions || '{}'); reactionCount = (Object.values(r) as any[]).reduce((s: number, v: any) => s + (v as any[]).length, 0) as number; } catch {}
        return { ...m, reactionCount };
      })
      .sort((a: any, b: any) => b.reactionCount - a.reactionCount)
      .slice(0, 3);

    return { channelId: ch._id, channelName: ch.name, messageCount: msgs.length, topMessages: topMsgs };
  }));

  // Aktif üyeler
  const allMsgs = await Messages.findWhere({ serverId, createdAt: { $gt: since } });
  const msgByUser = {};
  allMsgs.forEach(m => { msgByUser[m.userId] = (msgByUser[m.userId] || 0) + 1; });
  const topUsers = Object.entries(msgByUser)
    .sort((a: any, b: any) => b[1] - a[1])
    .slice(0, 5)
    .map(([uid, count]) => ({ userId: uid, messageCount: count }));

  const userIds = topUsers.map(u => u.userId);
  const users = await Users.findByIds(userIds);
  const userMap = {};
  users.forEach(u => { userMap[u._id] = u.displayName || u.username; });
  topUsers.forEach((u: any) => { u.username = userMap[u.userId] || '?'; });

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
}));

// ── GET /api/semantic/engagement/:serverId — Bağlılık skoru ────
router.get('/engagement/:serverId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;

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
}));

module.exports = router;
export {};
