// server/routes/ai/streaming.ts — SSE streaming endpoints (ask & Clyde)
/**
 * @openapi
 * /ai/ask/stream:
 *   get:
 *     tags: [AI]
 *     summary: AI sohbet — SSE stream
 *     description: 'Provider sırası Groq → Gemini → Ollama. event:token / event:done / event:error.'
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
 *     description: 'Provider sırası Groq → Gemini → OpenRouter → Ollama. Tüm eventler data: biçiminde.'
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

import { authMiddleware } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { callAI, AI_ENABLED, GROQ_KEY, GEMINI_KEY, OPENROUTER_KEY, OLLAMA_URL, OLLAMA_MODEL, AI_BASE_URL, AI_MODEL, AI_API_KEY, aiFailureForClient } from '../../lib/aiProvider';
import { fetchT } from '../../lib/fetch';
import { readChannelForAi, channelDataBlock, CHANNEL_DATA_RULE, sanitizeHistory } from '../../lib/aiContext';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';

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

/**
 * P5: channel context comes only from lib/aiContext (permission check, no
 * deleted/system/E2EE rows, bounded) and is returned as a delimited DATA block
 * for a user turn — never pasted into the system prompt.
 */
async function getAuthorizedChannelContext(
  userId: string,
  channelId: string,
  maxMessages: number = 20,
): Promise<{ ok: true; context: string } | { ok: false; status: 403 | 404 | 503; error: string; code?: string }> {
  if (!channelId) return { ok: true, context: '' };
  const read = await readChannelForAi(userId, channelId, { limit: maxMessages });
  if (!read.ok) return read;
  return { ok: true, context: channelDataBlock(read.messages) };
}

interface StreamMessage { role: string; content: string }

async function streamGroq(
  messages: StreamMessage[],
  send: (data: unknown) => void,
  res: express.Response,
  temperature = 0.3,
): Promise<boolean> {
  if (!GROQ_KEY) return streamCompatible(messages, send, res, temperature);
  return streamOpenAiSse('https://api.groq.com/openai/v1/chat/completions',
    { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
    'llama-3.3-70b-versatile', messages, send, res, temperature, false);
}

/**
 * P5 AI-06: a self-hosted OpenAI-compatible server (AI_BASE_URL + AI_MODEL)
 * streams through the same SSE parser. Used only when Groq is not configured.
 */
async function streamCompatible(
  messages: StreamMessage[],
  send: (data: unknown) => void,
  res: express.Response,
  temperature = 0.3,
): Promise<boolean> {
  if (!AI_BASE_URL) return false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AI_API_KEY) headers.Authorization = `Bearer ${AI_API_KEY}`;
  return streamOpenAiSse(`${AI_BASE_URL}/chat/completions`, headers, AI_MODEL, messages, send, res, temperature, true);
}

async function streamOpenAiSse(
  url: string,
  headers: Record<string, string>,
  model: string,
  messages: StreamMessage[],
  send: (data: unknown) => void,
  res: express.Response,
  temperature: number,
  skipSsrfCheck: boolean,
): Promise<boolean> {
  // Calculate safe max_tokens based on message context
  const contextLength = JSON.stringify(messages).length;
  const maxTokens = calculateMaxTokens(model, contextLength);

  const r = await fetchT(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, stream: true, messages }),
    timeoutMs: 60_000, // 60s — SSE stream için uzun timeout
    ...(skipSsrfCheck ? { skipSsrfCheck: true } : {}), // operator-configured internal host
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
  const ctx = await getAuthorizedChannelContext(castAuthed(req).user.id, channelId);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error, ...(ctx.code ? { code: ctx.code } : {}) });

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

  // P5 AI-05: channel text is data in the user turn, not system authority.
  const channelContext = ctx.context;
  const messages: StreamMessage[] = [
    { role: 'system', content: channelContext ? `Bridge sohbet asistanısın. ${CHANNEL_DATA_RULE}` : 'Bridge sohbet asistanısın.' },
    { role: 'user', content: channelContext ? `${channelContext}\n\n${q}` : q },
  ];

  try {
    if (await streamGroq(messages, send, res, 0.3)) { clearTimeout(streamTimeout); return; }
    if (await streamOllama(messages, send, res)) { clearTimeout(streamTimeout); return; }

    send({ error: 'AI sağlayıcı bulunamadı' });
    res.end();
  } catch (err) {
    send({ error: aiFailureForClient(err, 'ai.ask.stream') });
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
  const ctx = await getAuthorizedChannelContext(castAuthed(req).user.id, channelId);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error, ...(ctx.code ? { code: ctx.code } : {}) });

  sseHeaders(res);

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const context  = ctx.context;
  const system   = 'Bridge chat uygulamasının yardımcı asistanısın. Türkçe yanıt ver. Kısa ve öz ol.'
    + (context ? ` ${CHANNEL_DATA_RULE}` : '');
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
    sendEvent('error', { message: aiFailureForClient(err, 'ai.stream') });
    res.end();
  }
});

// ── GET /api/ai/clyde/stream?q=...&channelId=...&history=[...] ──

router.get('/clyde/stream', authMiddleware, limits['ai.stream'](), async (req, res) => {
  const q         = String(req.query.q ?? '').trim().slice(0, 800);
  const channelId = String(req.query.channelId ?? '');
  if (!q)          return res.status(400).json({ error: 'q parametresi gerekli' });
  if (!AI_ENABLED) return res.status(503).json({ error: 'AI devre dışı — GROQ_API_KEY veya GEMINI_API_KEY gerekli' });
  const ctx = await getAuthorizedChannelContext(castAuthed(req).user.id, channelId);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error, ...(ctx.code ? { code: ctx.code } : {}) });

  // P5 AI-01: client history used to accept ANY role — a request could carry
  // its own "system" turns. Only user/assistant turns, bounded, are kept.
  let history: StreamMessage[] = [];
  try {
    if (req.query.history as string) {
      history = sanitizeHistory(JSON.parse(String(req.query.history as string)));
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

  const channelContext = ctx.context;
  const systemPrompt   = [
    'Sen Bridge chat uygulamasının AI asistanı Clyde\'sın.',
    'Kişiliğin: Samimi, yardımsever, zeki ve esprili.',
    'Yanıtlarında markdown kullanabilirsin: **kalın**, `kod`, ```kod blokları```.',
    'Kısa ve öz ol. Kullanıcının dilinde yanıt ver.',
    channelContext ? CHANNEL_DATA_RULE : '',
  ].join('\n');

  // P5 AI-05: the channel block is a user turn, not part of the system prompt.
  const contextTurn: StreamMessage[] = channelContext
    ? [{ role: 'user', content: `Mevcut kanal bağlamı:\n${channelContext}` }] : [];
  const messages: StreamMessage[] = [
    { role: 'system', content: systemPrompt },
    ...contextTurn,
    ...history,
    { role: 'user', content: q },
  ];

  try {
    if (await streamGroq(messages, send, res, 0.7)) return;

    // Gemini multi-turn
    if (GEMINI_KEY) {
      const geminiMsgs = [
        ...contextTurn.map(m => ({ role: 'user', parts: [{ text: m.content }] })),
        ...history.map(m => ({
          role:  m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        { role: 'user', parts: [{ text: q }] },
      ];
      const contextLen = JSON.stringify(geminiMsgs).length;
      const maxTokens = calculateMaxTokens('gemini-1.5-pro', contextLen);
      
      const r = await fetchT(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
        {
          method: 'POST',
          // P5 AI-04: the key is a header, never part of the URL.
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(GEMINI_KEY) },
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
    send({ error: aiFailureForClient(err, 'ai.clyde.stream') });
    res.end();
  } finally {
    clearTimeout(streamTimeout);
  }
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
