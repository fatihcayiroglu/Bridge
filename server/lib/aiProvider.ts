// server/lib/aiProvider.ts
// Merkezi AI sağlayıcı modülü — tüm AI çağrıları buradan geçer.
//
// Öncelik sırası (ilk bulunan kullanılır):
//  1. GROQ         → groq.com          → ücretsiz, dakikada 30 istek
//  2. GEMINI       → aistudio.google.com → ücretsiz, günde 1500
//  3. OPENROUTER   → openrouter.ai     → ücretsiz modeller mevcut
//  4. OLLAMA       → yerel, sınırsız   → OLLAMA_URL env
//  5. rules        → AI yok, kural tabanlı fallback
//
// Kullanım:
//   const { callAI, AI_ENABLED, PROVIDER } = require('../lib/aiProvider');
//   const result = await callAI('system prompt', 'user message', 500);


import logger from './logger';
import { fetchT } from './fetch';

const GROQ_KEY       = process.env.GROQ_API_KEY;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OLLAMA_URL     = process.env.OLLAMA_URL;
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL || 'llama3.2';

const PROVIDER   = GROQ_KEY ? 'groq' : GEMINI_KEY ? 'gemini' : OPENROUTER_KEY ? 'openrouter' : OLLAMA_URL ? 'ollama' : 'rules';
const AI_ENABLED = PROVIDER !== 'rules';

// Production'da hangi AI servisi kullanıldığı sızdırılmaz
const safeProvider = (p: string) => process.env.NODE_ENV === 'production' ? 'ai' : p;

type GroqChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

type OllamaResponse = {
  response?: string;
};

if (process.env.NODE_ENV !== 'production') {
  logger.info({ provider: PROVIDER, event: 'ai.provider.init' }, `AI provider: ${PROVIDER.toUpperCase()}`);
}

// ── Retry with exponential backoff ───────────────────────────
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === maxAttempts - 1) throw err;
      const wait = Math.pow(2, i) * 500;
      logger.warn({ err: err instanceof Error ? err.message : String(err), attempt: i + 1, waitMs: wait, event: 'ai.retry' }, 'AI call failed, retrying.');
      await sleep(wait);
    }
  }
  throw new Error(`Unsupported AI provider: ${PROVIDER}`);
}

// ── Ana AI çağrısı ────────────────────────────────────────────
// system: string — sistem promptu
// user:   string — kullanıcı mesajı / içerik
// maxTokens: number — max çıktı token sayısı
async function callAI(system: string, user: string, maxTokens = 500): Promise<string> {
  return withRetry(async () => {
    if (GROQ_KEY) {
      const r = await fetchT('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: maxTokens,
          temperature: 0.3,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        timeoutMs: 15_000,
      });
      if (r.ok) { const d = await r.json() as GroqChatResponse; return d.choices?.[0]?.message?.content?.trim() || ''; }
      if (r.status !== 429) throw new Error(`Groq ${r.status}`);
      logger.warn({ event: 'ai.groq.rate_limit' }, 'Groq rate limit hit, falling back.');
    }

    if (GEMINI_KEY) {
      const r = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${system}\n\n${user}` }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
          }),
          timeoutMs: 15_000,
        }
      );
      if (r.ok) { const d = await r.json() as GeminiResponse; return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''; }
      if (r.status !== 429) throw new Error(`Gemini ${r.status}`);
      logger.warn({ event: 'ai.gemini.rate_limit' }, 'Gemini rate limit hit, falling back.');
    }

    if (OPENROUTER_KEY) {
      const r = await fetchT('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'HTTP-Referer': 'https://bridge.chat',
          'X-Title': 'Bridge',
        },
        body: JSON.stringify({
          model: 'mistralai/mistral-7b-instruct:free',
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        timeoutMs: 15_000,
      });
      if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
      const d = await r.json() as GroqChatResponse; return d.choices?.[0]?.message?.content?.trim() || '';
    }

    if (OLLAMA_URL) {
      const r = await fetchT(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt: `${system}\n\nKullanıcı: ${user}\n\nYanıt:`,
          stream: false,
          options: { num_predict: maxTokens, temperature: 0.3 },
        }),
        timeoutMs: 30_000,
        skipSsrfCheck: true, // OLLAMA_URL yönetici tarafından yapılandırılır (internal servis)
      });
      if (!r.ok) throw new Error(`Ollama ${r.status}`);
      const d = await r.json() as OllamaResponse; return d.response?.trim() || '';
    }

    throw new Error('AI_DISABLED');
  });
}

export { callAI,
  AI_ENABLED,
  PROVIDER,
  safeProvider,
  GROQ_KEY,
  GEMINI_KEY,
  OPENROUTER_KEY,
  OLLAMA_URL,
  OLLAMA_MODEL, };
