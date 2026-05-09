// @ts-nocheck
// server/routes/ai.js.1 (TAMAMEN ÜCRETSİZ)
//
// ÜCRETSİZ AI SAĞLAYICILAR (öncelik sırasıyla):
//  1. GROQ  → groq.com → ücretsiz kayıt → dakikada 30 istek → GROQ_API_KEY
//  2. GEMINI → aistudio.google.com → ücretsiz → günde 1500 → GEMINI_API_KEY
//  3. OPENROUTER → openrouter.ai → ücretsiz modeller → OPENROUTER_API_KEY
//  4. OLLAMA → kendi sunucunda, sınırsız → OLLAMA_URL=http://localhost:11434
//  5. KURAL TABANLI → sıfır API, her zaman çalışır (moderasyon, basit özet)

const express      = require('express');
const router       = express.Router();
const { Channels, Members, Messages, Users, Servers } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { cache }    = require('../lib/redisAdapter');
const { limits }   = require('../middleware/rateLimit');
const { rulesMod, rulesSummary } = require('../lib/modRules');

const { callAI, AI_ENABLED, PROVIDER, safeProvider, GROQ_KEY, GEMINI_KEY, OPENROUTER_KEY, OLLAMA_URL, OLLAMA_MODEL } = require('../lib/aiProvider');

const TRANSLATE_URL  = process.env.LIBRETRANSLATE_URL;
const TRANSLATE_KEY  = process.env.LIBRETRANSLATE_KEY || '';

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

router.get('/summarize/:channelId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { channelId } = req.params;
  const limit = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);

  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });
  if (!await Members.findOne(_u.id, channel.serverId))
    return res.status(403).json({ error: 'Üye değilsiniz' });

  const cacheKey = `ai:sum:${channelId}:${limit}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const msgs = (await Messages.messagesFind({ channelId, type: { $ne: 'system' } }).sort({ createdAt: -1 }).limit(limit)).reverse();
  const userIds = [...new Set(msgs.map(m => m.userId))];
  const users   = await Users.findByIds(userIds);
  const userMap = {};
  users.forEach(u => { userMap[u._id] = u.displayName || u.username; });

  let summary, provider = PROVIDER;
  if (AI_ENABLED) {
    const transcript = msgs.map(m => `${userMap[m.userId] || '?'}: ${(m.content || '').slice(0, 150)}`).join('\n');
    summary  = await callAI('Bridge chat asistanı. Türkçe, kısa özetle. 2-3 cümle + ana konular (maddeli).', `Son ${msgs.length} mesaj:\n${transcript.slice(0, 5000)}`);
  } else {
    summary = rulesSummary(msgs, userMap);
    provider = 'rules';
  }

  const result = { summary, provider, messageCount: msgs.length, participants: userIds.length,
    from: msgs[0]?.createdAt, to: msgs[msgs.length - 1]?.createdAt };
  await cache.set(cacheKey, result, 300);
  res.json(result);
}));

router.post('/translate', authMiddleware, limits.ai(), asyncHandler(async (req, res) => {
  const { text, targetLang = 'tr', sourceLang = 'auto' } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text gerekli' });
  if (text.length > 1000) return res.status(400).json({ error: 'Max 1000 karakter' });

  if (TRANSLATE_URL) {
    try {
      const r = await fetch(`${TRANSLATE_URL}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: sourceLang, target: targetLang, api_key: TRANSLATE_KEY }) });
      const d = await r.json();
      if (r.ok && d.translatedText) return res.json({ translated: d.translatedText, provider: safeProvider('libretranslate'), targetLang });
    } catch {}
  }

  if (AI_ENABLED) {
    const langs = { tr:'Türkçe', en:'İngilizce', de:'Almanca', fr:'Fransızca', es:'İspanyolca', ar:'Arapça', zh:'Çince', ja:'Japonca', ru:'Rusça' };
    const translated = await callAI('Çeviri asistanı. Sadece çeviriyi ver.', `"${text}" → ${langs[targetLang] || targetLang}`);
    return res.json({ translated, provider: safeProvider(PROVIDER), targetLang });
  }

  res.status(503).json({ error: 'Çeviri servisi yok', hint: 'GROQ_API_KEY veya LIBRETRANSLATE_URL ekle (.env)',
    free: { groq: 'groq.com (ücretsiz kayıt)', libretranslate: 'docker run -p 5000:5000 libretranslate/libretranslate' } });
}));

router.post('/moderate', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { messageId } = req.body;
  if (!messageId) return res.status(400).json({ error: 'messageId gerekli' });
  const msg = await Messages.findById(messageId);
  if (!msg) return res.status(404).json({ error: 'Mesaj bulunamadı' });
  if (!await Members.findOne(_u.id, msg.serverId))
    return res.status(403).json({ error: 'Üye değilsiniz' });

  const cacheKey = `ai:mod:${messageId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const ruleResult = rulesMod(msg.content);
  let result = { ...ruleResult, provider: safeProvider('rules') };

  if (AI_ENABLED && ruleResult.safe) {
    try {
      const raw = await callAI(
        'İçerik moderasyonu. Sadece JSON: {"safe":bool,"score":0-100,"categories":{"hate":bool,"harassment":bool,"spam":bool,"nsfw":bool},"reason":"Türkçe"}',
        `"${msg.content?.slice(0, 400)}"`, 120);
      result = { ...JSON.parse(raw.replace(/```json|```/g, '').trim()), provider: safeProvider(PROVIDER) };
    } catch { /* kural sonucu kullan */ }
  }

  result.messageId = messageId;
  await cache.set(cacheKey, result, 3600);
  res.json(result);
}));

router.post('/auto-moderate', authMiddleware, limits.ai(), asyncHandler(async (req, res) => {
  const { content, serverId } = req.body;
  if (!content?.trim()) return res.json({ safe: true, score: 100 });
  const server = await Servers.findById(serverId);
  if (!server?.autoModerate) return res.json({ safe: true, score: 100 });
  const ruleResult = rulesMod(content);
  if (!ruleResult.safe) return res.json({ ...ruleResult, provider: safeProvider('rules') });
  if (AI_ENABLED) {
    try {
      const raw = await callAI('Moderasyon. JSON: {"safe":bool,"score":0-100,"reason":"Türkçe"}', `"${content.slice(0, 200)}"`, 60);
      return res.json({ ...JSON.parse(raw.replace(/```json|```/g, '').trim()), provider: safeProvider(PROVIDER) });
    } catch {}
  }
  return res.json({ ...ruleResult, provider: safeProvider('rules') });
}));

router.get('/suggest-reply/:channelId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!AI_ENABLED) return res.json({ suggestions: ['👍', 'Anladım!', 'Teşekkürler!', '🔥'], provider: safeProvider('rules') });
  const { channelId } = req.params;
  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });
  if (!await Members.findOne(_u.id, channel.serverId))
    return res.status(403).json({ error: 'Üye değilsiniz' });

  const msgs = (await Messages.messagesFind({ channelId }).sort({ createdAt: -1 }).limit(6)).reverse();
  const uids = [...new Set(msgs.map(m => m.userId))];
  const users = await Users.findByIds(uids);
  const um = {}; users.forEach(u => { um[u._id] = u.displayName || u.username; });
  const transcript = msgs.map(m => `${um[m.userId] || '?'}: ${(m.content || '').slice(0, 80)}`).join('\n');

  const raw = await callAI('Yanıt önerisi. Sadece JSON: ["öneri1","öneri2","öneri3"] — kısa Türkçe', transcript, 100);
  let parsed;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); if (!Array.isArray(parsed)) throw ''; }
  catch { parsed = ['Anladım! 👍', 'Harika!', 'Teşekkürler!']; }
  res.json({ suggestions: parsed.slice(0, 4), provider: safeProvider(PROVIDER) });
}));

router.get('/discover-match', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const memberships = await Members.findByUser(_u.id);
  const joinedIds   = memberships.map(m => m.serverId);
  const servers     = await Servers.find({ discoverable: 1, _id: { $nin: joinedIds } });
  if (!servers.length) return res.json({ recommendations: [], provider: safeProvider('none') });

  const enrich = async (list) => Promise.all(list.map(async s => {
    const mc = (await Members.findByServer(s._id)).length;
    return { id: s._id, name: s.name, icon: s.icon, iconUrl: s.iconUrl, description: s.description, tags: s.tags, memberCount: mc };
  }));

  if (!AI_ENABLED) {
    const enriched = await enrich(servers.slice(0, 5));
    enriched.sort((a, b) => b.memberCount - a.memberCount);
    return res.json({ recommendations: enriched.map(s => ({ ...s, reason: 'Popüler topluluk' })), provider: safeProvider('rules') });
  }

  const joinedSrvs = await Servers.find({ _id: { $in: joinedIds } });
  const interests  = [...new Set(joinedSrvs.flatMap(s => s.tags || []))];
  const bio        = (await Users.findById(_u.id))?.bio || '';
  const list       = servers.slice(0, 15).map(s => ({ id: s._id, name: s.name, tags: (s.tags || []).join(', ') }));

  const raw = await callAI('Sunucu önerisi. Sadece JSON: [{"id":"...","reason":"Türkçe kısa neden"}]',
    `İlgiler: ${interests.join(', ') || '?'}\nBio: ${bio || '?'}\nSunucular: ${JSON.stringify(list)}\nEn uygun 5 seç.`, 250);
  let recs;
  try { recs = JSON.parse(raw.replace(/```json|```/g, '').trim()); if (!Array.isArray(recs)) throw ''; }
  catch { recs = servers.slice(0, 5).map(s => ({ id: s._id, reason: 'Popüler sunucu' })); }

  const enriched = await Promise.all(recs.slice(0, 5).map(async rec => {
    const srv = servers.find(s => s._id === rec.id); if (!srv) return null;
    const mc  = (await Members.findByServer(srv._id)).length;
    return { ...rec, name: srv.name, icon: srv.icon, description: srv.description, tags: srv.tags, memberCount: mc };
  }));
  res.json({ recommendations: enriched.filter(Boolean), provider: safeProvider(PROVIDER) });
}));

// ─────────────────────────────────────────────────────────────
// STREAMING ASK — Server-Sent Events
// GET /api/ai/ask/stream?q=...&channelId=...
// ─────────────────────────────────────────────────────────────
router.get('/ask/stream', authMiddleware, limits.ai(), asyncHandler(async (req, res) => {
  const q         = String(req.query.q ?? '').trim().slice(0, 500);
  const channelId = String(req.query.channelId ?? '');
  if (!q) return res.status(400).json({ error: 'q parametresi gerekli' });
  if (!AI_ENABLED) return res.status(503).json({ error: 'AI devre dışı' });

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx proxy buffering'i kapat
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Context — son 10 mesaj
  let context = '';
  if (channelId) {
    try {
      const msgs = await Messages.messagesFind({ channelId }).sort({ createdAt: -1 }).limit(10);
      context = msgs.reverse().map(m => `${m.displayName || m.username}: ${m.content}`).join('\n');
    } catch {}
  }

  const system = 'Bridge chat uygulamasının yardımcı asistanısın. Türkçe yanıt ver. Kısa ve öz ol.';
  const userMsg = context
    ? `Son mesajlar:\n${context}\n\nSoru: ${q}`
    : q;

  try {
    // Groq streaming
    if (GROQ_KEY) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile', max_tokens: 512, temperature: 0.3, stream: true,
          messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        }),
      });
      if (r.ok && r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') { send('done', {}); res.end(); return; }
            try {
              const chunk = JSON.parse(raw);
              const token = chunk.choices?.[0]?.delta?.content;
              if (token) send('token', { token });
            } catch {}
          }
        }
        send('done', {}); res.end(); return;
      }
    }

    // Gemini — no native streaming via REST, fallback to full response chunked
    if (GEMINI_KEY) {
      const text = await callAI(system, userMsg, 512);
      // Fake stream — kelime kelime gönder
      const words = text.split(' ');
      for (const word of words) {
        send('token', { token: word + ' ' });
        await new Promise(r => setTimeout(r, 15));
      }
      send('done', {}); res.end(); return;
    }

    // Ollama streaming
    if (OLLAMA_URL) {
      const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt: `${system}\n\n${userMsg}`, stream: true }),
      });
      if (r.ok && r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = dec.decode(value).split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (d.response) send('token', { token: d.response });
              if (d.done) { send('done', {}); res.end(); return; }
            } catch {}
          }
        }
        send('done', {}); res.end(); return;
      }
    }

    send('error', { message: 'AI sağlayıcı bulunamadı' });
    res.end();
  } catch (err) {
    send('error', { message: err.message || 'AI hatası' });
    res.end();
  }
}));

router.get('/status', authMiddleware, (req, res) => {
  res.json({
    enabled: AI_ENABLED, provider: safeProvider(PROVIDER),
    features: { summarize: true, translate: AI_ENABLED || !!TRANSLATE_URL, moderation: true, suggestReply: true, discoverMatch: true },
    setup: {
      groq:        { url: 'https://console.groq.com', env: 'GROQ_API_KEY=gsk_...', note: 'ÜCRETSİZ, Llama 3.3 70B, dakikada 30 istek — ÖNERİLEN' },
      gemini:      { url: 'https://aistudio.google.com', env: 'GEMINI_API_KEY=AIza...', note: 'Ücretsiz, günde 1500 istek' },
      openrouter:  { url: 'https://openrouter.ai', env: 'OPENROUTER_API_KEY=sk-or-...', note: 'Ücretsiz modeller mevcut' },
      ollama:      { install: 'curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2', env: 'OLLAMA_URL=http://localhost:11434', note: 'Kendi sunucunda, SINIRSIZ ücretsiz' },
      translate:   { install: 'docker run -p 5000:5000 libretranslate/libretranslate', env: 'LIBRETRANSLATE_URL=http://localhost:5000', note: 'Ücretsiz çeviri' },
    },
  });
});

// ── CLYDE AI ASISTANI — SSE STREAMING ─────────────────────────
// İstemci tarafı: client/js/core/clyde.js
// Endpoint: GET /api/ai/clyde/stream?q=...&channelId=...&history=[...]
// Multi-turn: history parametresi JSON array [{role,content}]
router.get('/clyde/stream', authMiddleware, limits.ai(), asyncHandler(async (req, res) => {
  const q         = String(req.query.q ?? '').trim().slice(0, 800);
  const channelId = String(req.query.channelId ?? '');
  let   history   = [];

  if (!q) return res.status(400).json({ error: 'q parametresi gerekli' });
  if (!AI_ENABLED) return res.status(503).json({ error: 'AI devre dışı — GROQ_API_KEY veya GEMINI_API_KEY gerekli' });

  // Konuşma geçmişini parse et
  try {
    if (req.query.history) {
      const parsed = JSON.parse(String(req.query.history ?? ''));
      if (Array.isArray(parsed)) {
        history = parsed
          .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
          .slice(-20); // max 20 tur
      }
    }
  } catch { /* geçersiz history — ignore */ }

  // SSE headers
  res.setHeader('Content-Type',       'text/event-stream');
  res.setHeader('Cache-Control',      'no-cache');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no');
  res.flushHeaders();

  const send = (event, data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  // Kanal bağlamını al (son 8 mesaj)
  let channelContext = '';
  if (channelId) {
    try {
      const msgs = await Messages.messagesFind({ channelId }).sort({ createdAt: -1 }).limit(8);
      channelContext = msgs.reverse().map(m => `${m.displayName || m.username}: ${m.content}`).join('\n');
    } catch { /* bağlam alınamazsa devam et */ }
  }

  // Clyde sistem kişiliği
  const systemPrompt = `Sen Bridge chat uygulamasının AI asistanı Clyde'sın. Discord'un Clyde'ından ilham alındın ama çok daha yeteneklisin.
Kişiliğin: Samimi, yardımsever, zeki ve esprili. Aşırı formal değilsin ama profesyonelsin.
Yanıtlarında markdown kullanabilirsin: **kalın**, \`kod\`, \`\`\`kod blokları\`\`\`.
Kısa ve öz ol — gereksiz tekrar yapma. Kullanıcının dilinde yanıt ver (Türkçe yazarlarsa Türkçe, İngilizce yazarlarsa İngilizce).
${channelContext ? `\nMevcut kanal bağlamı (son mesajlar):\n${channelContext}` : ''}`;

  // Mesaj geçmişini oluştur
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: q },
  ];

  try {
    // ── GROQ Streaming ──────────────────────────────────
    if (GROQ_KEY) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile', max_tokens: 1024, temperature: 0.7, stream: true,
          messages,
        }),
      });

      if (r.ok && r.body) {
        const reader = r.body.getReader();
        const dec    = new TextDecoder();
        let   buf    = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') { send({ done: true }); res.end(); return; }
            try {
              const chunk = JSON.parse(raw);
              const token = chunk.choices?.[0]?.delta?.content;
              if (token) send({ token });
            } catch {}
          }
        }
        send({ done: true }); res.end(); return;
      }
    }

    // ── GEMINI — fake stream ─────────────────────────────
    if (GEMINI_KEY) {
      const geminiMsgs = history.length
        ? history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
        : [];
      geminiMsgs.push({ role: 'user', parts: [{ text: q }] });

      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: geminiMsgs,
            generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
          }),
        }
      );
      if (r.ok) {
        const data = await r.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        // Kelime kelime simüle et
        const words = text.split(/(\s+)/);
        for (const word of words) {
          if (word) send({ token: word });
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        send({ done: true }); res.end(); return;
      }
    }

    // ── OpenRouter ──────────────────────────────────────
    if (OPENROUTER_KEY) {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'HTTP-Referer':  'https://github.com/bridge-app',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.2-3b-instruct:free', max_tokens: 1024, temperature: 0.7, stream: true,
          messages,
        }),
      });
      if (r.ok && r.body) {
        const reader = r.body.getReader();
        const dec    = new TextDecoder();
        let   buf    = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') { send({ done: true }); res.end(); return; }
            try {
              const chunk = JSON.parse(raw);
              const token = chunk.choices?.[0]?.delta?.content;
              if (token) send({ token });
            } catch {}
          }
        }
        send({ done: true }); res.end(); return;
      }
    }

    // ── Ollama ───────────────────────────────────────────
    if (OLLAMA_URL) {
      const r = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true }),
      });
      if (r.ok && r.body) {
        const reader = r.body.getReader();
        const dec    = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = dec.decode(value).split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (d.message?.content) send({ token: d.message.content });
              if (d.done) { send({ done: true }); res.end(); return; }
            } catch {}
          }
        }
        send({ done: true }); res.end(); return;
      }
    }

    send({ error: 'AI sağlayıcı yapılandırılmamış' });
    res.end();
  } catch (err) {
    send({ error: err.message || 'Sunucu hatası' });
    res.end();
  }
}));

module.exports = router;
export {};
