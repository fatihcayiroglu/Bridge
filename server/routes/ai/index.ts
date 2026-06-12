// server/routes/ai/index.ts — Assembles AI sub-routes
// Replaces the monolithic ai.ts (597 lines → 4 focused modules)
import express from 'express';
import summarizeRouter  from './summarize';
import translateRouter  from './translate';
import moderationRouter from './moderation';
import streamingRouter  from './streaming';
import { authMiddleware } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { AI_ENABLED, PROVIDER, safeProvider, GROQ_KEY, GEMINI_KEY, OPENROUTER_KEY, OLLAMA_URL, OLLAMA_MODEL } from '../../lib/aiProvider';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router();

// Suggest-reply (small, lives here)
import { Channels, Members, Messages, Users, Servers } from '../../db/repositories';

import { callAI } from '../../lib/aiProvider';

/**
 * @openapi
 * /ai/status:
 *   get:
 *     tags: [AI]
 *     summary: AI servis durumu
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: AI konfigürasyonu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:  { type: boolean }
 *                 provider: { type: string, example: groq }
 *
 * /ai/suggest-reply/{channelId}:
 *   get:
 *     tags: [AI]
 *     summary: Mesaj yanıt önerisi al
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Yanıt önerileri
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 suggestions: { type: array, items: { type: string } }
 *                 provider:    { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /ai/discover-match:
 *   get:
 *     tags: [AI]
 *     summary: Sunucu önerisi (AI tabanlı keşif)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Önerilen sunucular
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 servers: { type: array, items: { $ref: '#/components/schemas/Server' } }
 *
 * /ai/ask/stream:
 *   get:
 *     tags: [AI]
 *     summary: AI sohbet — SSE stream
 *     description: Server-Sent Events ile gerçek zamanlı AI yanıtı. `?q=` ile soru, `?channelId=` ile kanal bağlamı.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, maxLength: 1000 }
 *       - in: query
 *         name: channelId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: SSE akışı — `data: {"token":"..."}` / `data: {"done":true}`
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       429: { description: 'Rate limit aşıldı' }
 *
 * /ai/clyde/stream:
 *   get:
 *     tags: [AI]
 *     summary: Clyde asistanı — SSE stream (çok turlu)
 *     description: Kanal bağlamını göz önünde bulundurarak çok turlu AI sohbet akışı.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: channelId
 *         schema: { type: string }
 *       - in: query
 *         name: history
 *         schema: { type: string, description: 'JSON encoded [{role,content}]' }
 *     responses:
 *       200:
 *         description: SSE stream
 *         content:
 *           text/event-stream:
 *             schema: { type: string }
 *
 * /ai/summarize/{channelId}:
 *   get:
 *     tags: [AI]
 *     summary: Kanal mesajlarını özetle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Özet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 summary:  { type: string }
 *                 provider: { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /ai/translate:
 *   post:
 *     tags: [AI]
 *     summary: Metin çevir
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text]
 *             properties:
 *               text:       { type: string, maxLength: 1000 }
 *               targetLang: { type: string, default: tr, example: en }
 *               sourceLang: { type: string, default: auto }
 *     responses:
 *       200:
 *         description: Çeviri sonucu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 translated: { type: string }
 *                 provider:   { type: string }
 *                 targetLang: { type: string }
 *
 * /ai/moderate:
 *   post:
 *     tags: [AI]
 *     summary: Mesaj içeriği moderasyon kontrolü
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:   { type: string }
 *               channelId: { type: string }
 *     responses:
 *       200:
 *         description: Moderasyon kararı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 flagged:   { type: boolean }
 *                 reason:    { type: string }
 *                 action:    { type: string, enum: [allow, warn, block] }
 *                 provider:  { type: string }
 *
 * /ai/auto-moderate:
 *   post:
 *     tags: [AI]
 *     summary: Otomatik moderasyon (sunucu kurallarına göre)
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
 *               userId:   { type: string }
 *     responses:
 *       200:
 *         description: Moderasyon kararı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 action:  { type: string, enum: [allow, warn, mute, kick, ban] }
 *                 reason:  { type: string }
 *                 ruleId:  { type: string }

 *
 * /ai/chat:
 *   post:
 *     tags: [AI]
 *     summary: AI sohbet asistani
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messages]
 *             properties:
 *               messages:  { type: array, items: { type: object } }
 *               channelId: { type: string }
 *               model:     { type: string }
 *     responses:
 *       200:
 *         description: AI yaniti
 *
 * /ai/models:
 *   get:
 *     tags: [AI]
 *     summary: Kullanilabilir AI modellerini listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Model listesi
 *
 * /ai/usage:
 *   get:
 *     tags: [AI]
 *     summary: AI kullanim istatistiklerini getir
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Kullanim metrikleri
 */

router.get('/suggest-reply/:channelId', authMiddleware, limits.ai(), async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(String(req.params.channelId ?? ''));
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });
  if (!await Members.findOne(_u.id, channel.serverId))
    return res.status(403).json({ error: 'Üye değilsiniz' });

  if (!AI_ENABLED) return res.json({ suggestions: ['👍', 'Anladım!', 'Teşekkürler!', '🔥'], provider: safeProvider('rules') });

  const msgs = (await Messages.messagesFind({ channelId: String(req.params.channelId ?? '') }).sort({ createdAt: -1 }).limit(6)).reverse();
  const uids  = [...new Set(msgs.map((m: { userId: string }) => m.userId))];
  const users = await Users.findByIds(uids);
  const um: Record<string, string> = {};
  users.forEach((u: { _id: string; displayName?: string; username: string }) => { um[u._id] = u.displayName || u.username; });

  // SECURITY: Prompt injection önleme — kullanıcı içeriği sistem promptundan kesin ayrılır
  const _sanitizeAiUsername = (n: string) => n.replace(/[^\w\s\-ÇĞİÖŞÜçğışöşü]/g, '').slice(0, 32);
  const transcript = msgs
    .map((m: { userId: string; content?: string }) => {
      const safeUser = _sanitizeAiUsername(um[m.userId] || 'User');
      const safeContent = (m.content || '')
        .replace(/\[MSG\]|\[SYSTEM\]|\[INST\]|<\|im_start\|>|<\|im_end\|>/gi, '')
        .slice(0, 120);
      return `[MSG] ${safeUser}: ${safeContent}`;
    })
    .join('\n');

  const _aiSystemPrompt = 'Sen bir sohbet asistanısın. [MSG] etiketli mesajlara bakarak 3 kısa Türkçe yanıt öner. SADECE JSON: ["öneri1","öneri2","öneri3"]';
  const raw = await callAI(_aiSystemPrompt, transcript, 120);
  let parsed: string[];
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!Array.isArray(parsed)) throw new Error('not array');
    parsed = parsed.filter((s: unknown) => typeof s === 'string').map((s: string) => s.slice(0, 80));
  } catch {
    parsed = ['Anladım! 👍', 'Harika!', 'Teşekkürler!'];
  }
  res.json({ suggestions: parsed.slice(0, 4), provider: safeProvider(PROVIDER) });
});

// Discover match (small, lives here)
router.get('/discover-match', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const memberships = await Members.findByUser(_u.id);
  const joinedIds   = memberships.map((m: { serverId: string }) => m.serverId);
  const servers     = await Servers.find({ discoverable: 1, _id: { $nin: joinedIds } });
  if (!servers.length) return res.json({ recommendations: [], provider: safeProvider('none') });

  type EnrichedServer = { id: string; name: string; icon: string; iconUrl?: string; description?: string; tags?: string[]; memberCount: number };
  const normalizeTags = (tags: unknown): string[] => Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const enrich = async (list: Array<{ _id: string; name: string; icon?: string | null; iconUrl?: string | null; description?: string; tags?: string | string[] }>): Promise<EnrichedServer[]> =>
    Promise.all(list.map(async s => ({
      id: s._id, name: s.name, icon: s.icon ?? '', iconUrl: s.iconUrl ?? undefined,
      description: s.description, tags: normalizeTags(s.tags),
      memberCount: (await Members.findByServer(s._id)).length,
    })));

  if (!AI_ENABLED) {
    const enriched = await enrich(servers.slice(0, 5));
    enriched.sort((a, b) => b.memberCount - a.memberCount);
    return res.json({ recommendations: enriched.map(s => ({ ...s, reason: 'Popüler topluluk' })), provider: safeProvider('rules') });
  }

  const joinedSrvs = await Servers.find({ _id: { $in: joinedIds } });
  const interests  = [...new Set(joinedSrvs.flatMap(s => normalizeTags(s.tags)))];
  const bio        = (await Users.findById(_u.id))?.bio || '';
  const list       = servers.slice(0, 15).map(s => ({ id: s._id, name: s.name, tags: normalizeTags(s.tags).join(', ') }));

  const raw = await callAI(
    'Sunucu önerisi. Sadece JSON: [{"id":"...","reason":"Türkçe kısa neden"}]',
    `İlgiler: ${interests.join(', ') || '?'}\nBio: ${bio || '?'}\nSunucular: ${JSON.stringify(list)}\nEn uygun 5 seç.`,
    250,
  );

  let recs: { id: string; reason: string }[];
  try {
    recs = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!Array.isArray(recs)) throw new Error('not array');
  } catch {
    recs = servers.slice(0, 5).map((s: { _id: string }) => ({ id: s._id, reason: 'Popüler sunucu' }));
  }

  const enriched = await Promise.all(recs.slice(0, 5).map(async rec => {
    const srv = servers.find((s: { _id: string }) => s._id === rec.id);
    if (!srv) return null;
    const mc = (await Members.findByServer(srv._id)).length;
    return { ...rec, name: srv.name, icon: srv.icon, description: srv.description, tags: srv.tags, memberCount: mc };
  }));
  res.json({ recommendations: enriched.filter(Boolean), provider: safeProvider(PROVIDER) });
});

// Status endpoint
router.get('/status', authMiddleware, (_req, res) => {
  res.json({
    enabled:  AI_ENABLED,
    provider: safeProvider(PROVIDER),
    features: { summarize: true, translate: AI_ENABLED || !!process.env.LIBRETRANSLATE_URL, moderation: true, suggestReply: true, discoverMatch: true },
    setup: {
      groq:        { url: 'https://console.groq.com', env: 'GROQ_API_KEY=gsk_...', note: 'ÜCRETSİZ, Llama 3.3 70B — ÖNERİLEN' },
      gemini:      { url: 'https://aistudio.google.com', env: 'GEMINI_API_KEY=AIza...', note: 'Ücretsiz, günde 1500 istek' },
      openrouter:  { url: 'https://openrouter.ai', env: 'OPENROUTER_API_KEY=sk-or-...', note: 'Ücretsiz modeller mevcut' },
      ollama:      { install: 'curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2', env: 'OLLAMA_URL=http://localhost:11434', note: 'Kendi sunucunda, SINIRSIZ ücretsiz' },
      translate:   { install: 'docker run -p 5000:5000 libretranslate/libretranslate', env: 'LIBRETRANSLATE_URL=http://localhost:5000', note: 'Ücretsiz çeviri' },
    },
  });
});

// Mount sub-routers
router.use('/summarize', summarizeRouter);
router.use('/translate',  translateRouter);
router.use('/', moderationRouter);
router.use('/', streamingRouter);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
