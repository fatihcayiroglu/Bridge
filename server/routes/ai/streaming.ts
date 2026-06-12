// server/routes/ai/streaming.ts — SSE streaming endpoints (ask & Clyde)
/**
 * @openapi
 * /ai/ask/stream:
 *   get:
 *     tags: [AI]
 *     summary: AI sohbet — SSE stream
 *     description: Provider sırası Groq → Gemini → Ollama. event:token / event:done / event:error.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, maxLength: 500 }
 *       - in: query
 *         name: channelId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: SSE akışı
 *         content:
 *           text/event-stream:
 *             schema: { type: string }
 *       400: { description: 'q parametresi eksik' }
 *       429: { description: 'Rate limit aşıldı (5 istek/dk)' }
 *       503: { description: 'AI devre dışı' }
 *
 * /ai/clyde/stream:
 *   get:
 *     tags: [AI]
 *     summary: Clyde asistanı — SSE stream (çok turlu)
 *     description: Provider sırası Groq → Gemini → OpenRouter → Ollama. Tüm eventler data: biçiminde.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, maxLength: 800 }
 *       - in: query
 *         name: channelId
 *         schema: { type: string }
 *       - in: query
 *         name: history
 *         schema: { type: string, description: 'JSON [{role,content}] max 20 tur' }
 *     responses:
 *       200:
 *         description: SSE akışı
 *         content:
 *           text/event-stream:
 *             schema: { type: string }
 *       400: { description: 'q parametresi eksik' }
 *       429: { description: 'Rate limit aşıldı' }
 *       503: { description: 'AI devre dışı' }

 *
 * /ai/stream:
 *   post:
 *     tags: [AI]
 *     summary: AI yanitini akis (SSE) olarak al
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompt]
 *             properties:
 *               prompt:    { type: string }
 *               channelId: { type: string }
 *               model:     { type: string }
 *     responses:
 *       200:
 *         description: Server-Sent Events akisi
 *         content:
 *           text/event-stream:
 *             schema: { type: string }
 *
 * /ai/stream/cancel:
 *   post:
 *     tags: [AI]
 *     summary: Aktif AI akisini iptal et
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Akis iptal edildi
 */

import express from 'express';
const router = express.Router();

import { Messages } from '../../db/repositories';
import { authMiddleware } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { callAI, AI_ENABLED, GROQ_KEY, GEMINI_KEY, OPENROUTER_KEY, OLLAMA_URL, OLLAMA_MODEL } from '../../lib/aiProvider';
import { fetchT } from '../../lib/fetch';

// ── Helpers ──────────────────────────────────────────────────────

function sseHeaders(res: express.Response): void {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** Calculate appropriate max_tokens based on model context window and message length */
function calculateMaxTokens(modelName: string, contextLen: number): number {
  const MODEL_LIMITS: Record<string, number> = {
    'llama-3.3-70b-versatile': 8192,      // Groq
    'gemini-1.5-pro': 131072,             // Gemini (very large)
    'meta-llama/llama-3.2-3b-instruct:free': 8192,  // OpenRouter
  };
  
  const contextLimit = MODEL_LIMITS[modelName] || 4096;
  
  // Estimate: context uses ~4 tokens/word avg, leave 20% safety margin
  const estimatedContextTokens = (contextLen / 4) * 1.2;
  const availableTokens = Math.max(512, contextLimit - estimatedContextTokens - 500); // min 512, max based on available
  
  return Math.min(2048, availableTokens); // Cap at 2048 for safety
}

async function getChannelContext(channelId: string, maxMessages: number = 20): Promise<string> {
  if (!channelId) return '';
  try {
    // Dynamically adjust message limit based on context needs
    const msgs = await Messages.messagesFind({ channelId }).sort({ createdAt: -1 }).limit(maxMessages);
    return msgs.reverse()
      .map((m: { displayName?: string; username?: string; content?: string }) =>
        `${m.displayName || m.username}: ${m.content}`)
      .join('\n');
  } catch {
    return '';
  }
}

interface StreamMessage { role: string; content: string }

async function streamGroq(
  messages: StreamMessage[],
  send: (data: unknown) => void,
  res: express.Response,
  temperature = 0.3,
): Promise<boolean> {
  if (!GROQ_KEY) return false;
  
  // Calculate safe max_tokens based on message context
  const contextLength = JSON.stringify(messages).length;
  const maxTokens = calculateMaxTokens('llama-3.3-70b-versatile', contextLength);
  
  const r = await fetchT('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, temperature, stream: true, messages }),
    timeoutMs: 60_000, // 60s — SSE stream için uzun timeout
  });
  if (!r.ok || !r.body) return false;

  const reader = r.body.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') { send({ done: true }); res.end(); return true; }
      try {
        const chunk = JSON.parse(raw);
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) send({ token });
      } catch { /* skip malformed chunk */ }
    }
  }
  send({ done: true }); res.end(); return true;
}

async function streamOllama(
  messages: StreamMessage[],
  send: (data: unknown) => void,
  res: express.Response,
): Promise<boolean> {
  if (!OLLAMA_URL) return false;
  const r = await fetchT(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true }),
    timeoutMs: 120_000, // 120s — yerel Ollama için daha uzun
    skipSsrfCheck: true, // OLLAMA_URL yönetici tarafından yapılandırılır (internal servis)
  });
  if (!r.ok || !r.body) return false;

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
        if (d.done) { send({ done: true }); res.end(); return true; }
      } catch { /* skip */ }
    }
  }
  return false;
}

// ── GET /api/ai/ask/stream?q=...&channelId=... ───────────────────

router.get('/ask/stream', authMiddleware, limits['ai.stream'](), async (req, res) => {
  const q         = String(req.query.q ?? '').trim().slice(0, 500);
  const channelId = String(req.query.channelId ?? '');

  if (!q) return res.status(400).json({ error: 'q parametresi gerekli' });
  if (!AI_ENABLED) return res.status(503).json({ error: 'AI devre dışı' });

  sseHeaders(res);
  
  // RELIABILITY: Cleanup on client disconnect or error
  let isClosed = false;
  const cleanup = () => { isClosed = true; };
  res.on('close', cleanup);
  res.on('error', cleanup);
  
  // RELIABILITY: Stream timeout (45s, before provider 60s timeout)
  const streamTimeout = setTimeout(() => {
    if (!isClosed) {
      try { res.write('data: {"error":"Stream timeout"}\n\n'); res.end(); } catch { /* client gone */ }
    }
  }, 45_000);

  const send = (data: unknown) => {
    if (isClosed) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };

  const channelContext = await getChannelContext(channelId);
  const messages: StreamMessage[] = [
    { role: 'system', content: `Bağlam:\n${channelContext}` },
    { role: 'user', content: q },
  ];

  try {
    if (await streamGroq(messages, send, res, 0.3)) { clearTimeout(streamTimeout); return; }
    if (await streamOllama(messages, send, res)) { clearTimeout(streamTimeout); return; }

    send({ error: 'AI sağlayıcı bulunamadı' });
    res.end();
  } catch (err) {
    send({ error: err instanceof Error ? err.message : 'AI hatası' });
    res.end();
  } finally {
    clearTimeout(streamTimeout);
  }
});

// ── GET /api/ai/stream?q=...&channelId=... ───────────────────────

router.get('/stream', authMiddleware, limits['ai.stream'](), async (req, res) => {
  const q         = String(req.query.q ?? '').trim().slice(0, 500);
  const channelId = String(req.query.channelId ?? '');
  if (!q)          return res.status(400).json({ error: 'q parametresi gerekli' });
  if (!AI_ENABLED) return res.status(503).json({ error: 'AI devre dışı' });

  sseHeaders(res);

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const context  = await getChannelContext(channelId);
  const system   = 'Bridge chat uygulamasının yardımcı asistanısın. Türkçe yanıt ver. Kısa ve öz ol.';
  const userMsg  = context ? `Son mesajlar:\n${context}\n\nSoru: ${q}` : q;
  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: userMsg },
  ];

  try {
    if (await streamGroq(messages, d => sendEvent('token', d), res)) return;

    // Gemini — fake stream (no native SSE in REST)
    if (GEMINI_KEY) {
      const text  = await callAI(system, userMsg, 512);
      const words = text.split(' ');
      for (const word of words) {
        sendEvent('token', { token: word + ' ' });
        await new Promise(r => setTimeout(r, 15));
      }
      sendEvent('done', {}); res.end(); return;
    }

    if (await streamOllama(messages, d => sendEvent('token', d), res)) return;

    sendEvent('error', { message: 'AI sağlayıcı bulunamadı' });
    res.end();
  } catch (err) {
    sendEvent('error', { message: err instanceof Error ? err.message : 'AI hatası' });
    res.end();
  }
});

// ── GET /api/ai/clyde/stream?q=...&channelId=...&history=[...] ──

router.get('/clyde/stream', authMiddleware, limits['ai.stream'](), async (req, res) => {
  const q         = String(req.query.q ?? '').trim().slice(0, 800);
  const channelId = String(req.query.channelId ?? '');
  if (!q)          return res.status(400).json({ error: 'q parametresi gerekli' });
  if (!AI_ENABLED) return res.status(503).json({ error: 'AI devre dışı — GROQ_API_KEY veya GEMINI_API_KEY gerekli' });

  let history: StreamMessage[] = [];
  try {
    if (req.query.history as string) {
      const parsed = JSON.parse(String(req.query.history as string));
      if (Array.isArray(parsed)) {
        history = parsed
          .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
          .slice(-20);
      }
    }
  } catch { /* invalid history — ignore */ }

  sseHeaders(res);
  
  // RELIABILITY: Cleanup on client disconnect or error
  let isClosed = false;
  const cleanup = () => { isClosed = true; };
  res.on('close', cleanup);
  res.on('error', cleanup);
  
  // RELIABILITY: Stream timeout (45s, before provider 60s timeout)
  const streamTimeout = setTimeout(() => {
    if (!isClosed) {
      try { res.write('data: {"error":"Stream timeout"}\n\n'); res.end(); } catch { /* client gone */ }
    }
  }, 45_000);

  const send = (data: unknown) => {
    if (isClosed) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };

  const channelContext = await getChannelContext(channelId);
  const systemPrompt   = [
    'Sen Bridge chat uygulamasının AI asistanı Clyde\'sın.',
    'Kişiliğin: Samimi, yardımsever, zeki ve esprili.',
    'Yanıtlarında markdown kullanabilirsin: **kalın**, `kod`, ```kod blokları```.',
    'Kısa ve öz ol. Kullanıcının dilinde yanıt ver.',
    channelContext ? `\nMevcut kanal bağlamı:\n${channelContext}` : '',
  ].join('\n');

  const messages: StreamMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: q },
  ];

  try {
    if (await streamGroq(messages, send, res, 0.7)) return;

    // Gemini multi-turn
    if (GEMINI_KEY) {
      const geminiMsgs = [
        ...history.map(m => ({
          role:  m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        { role: 'user', parts: [{ text: q }] },
      ];
      const contextLen = JSON.stringify(geminiMsgs).length;
      const maxTokens = calculateMaxTokens('gemini-1.5-pro', contextLen);
      
      const r = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents:          geminiMsgs,
            generationConfig:  { maxOutputTokens: maxTokens, temperature: 0.7 },
          }),
          timeoutMs: 30_000,
        },
      );
      if (r.ok) {
        const data = await r.json() as { candidates?: [{ content: { parts: [{ text: string }] } }] };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        for (const word of text.split(/(\s+)/)) {
          if (word) send({ token: word });
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        send({ done: true }); res.end(); return;
      }
    }

    // OpenRouter
    if (OPENROUTER_KEY) {
      const contextLen = JSON.stringify(messages).length;
      const maxTokens = calculateMaxTokens('meta-llama/llama-3.2-3b-instruct:free', contextLen);
      
      const r = await fetchT('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${OPENROUTER_KEY}`,
          'HTTP-Referer':  'https://github.com/bridge-app',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.2-3b-instruct:free', max_tokens: maxTokens, temperature: 0.7, stream: true, messages,
        }),
        timeoutMs: 60_000,
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
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') { send({ done: true }); res.end(); return; }
            try {
              const chunk = JSON.parse(raw);
              const token = chunk.choices?.[0]?.delta?.content;
              if (token) send({ token });
            } catch { /* skip */ }
          }
        }
        send({ done: true }); res.end(); return;
      }
    }

    if (await streamOllama(messages, send, res)) return;

    send({ error: 'AI sağlayıcı yapılandırılmamış' });
    res.end();
  } catch (err) {
    send({ error: err instanceof Error ? err.message : 'Sunucu hatası' });
    res.end();
  } finally {
    clearTimeout(streamTimeout);
  }
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
