// server/lib/aiProvider.ts
// Merkezi AI sağlayıcı modülü — tüm AI çağrıları buradan geçer.
//
// Öncelik sırası (AI_PROVIDER verilmezse; ilk bulunan kullanılır):
//  1. GROQ         → groq.com          → ücretsiz, dakikada 30 istek
//  2. GEMINI       → aistudio.google.com → ücretsiz, günde 1500
//  3. OPENROUTER   → openrouter.ai     → ücretsiz modeller mevcut
//  4. OLLAMA       → yerel, sınırsız   → OLLAMA_URL env
//  5. OPENAI-COMPATIBLE → AI_BASE_URL + AI_MODEL (+ AI_API_KEY) — any server
//     that speaks the OpenAI chat-completions API: vLLM, llama.cpp server,
//     LM Studio, LocalAI, Ollama's /v1. Self-hosted; nothing leaves the network.
//  6. rules        → AI yok, kural tabanlı fallback
//
// P5 (AI boundary):
//  · AI_PROVIDER=groq|gemini|openrouter|ollama|openai-compatible|none selects
//    exactly one provider. `none` is the operator's off switch: AI stays off
//    even when keys are present (no provider is ever contacted).
//  · Every call has a TOTAL deadline (AI_TIMEOUT_MS, default 30 s) across its
//    retries — before, a call could take 3 × 15 s plus backoff (Ollama 3 × 30 s).
//  · The Gemini key travels in the x-goog-api-key header, never in the URL
//    (URLs end up in proxy, APM and error logs).
//  · Logs carry provider, status and latency only — never prompts or keys.
//
// Kullanım:
//   const { callAI, AI_ENABLED, PROVIDER } = require('../lib/aiProvider');
//   const result = await callAI('system prompt', 'user message', 500);


import logger from './logger';
import { fetchT } from './fetch';
import { aiOffByInstallation, KNOWN_AI_PROVIDERS } from './aiInstallation';

const env = process.env;
const SELECTED = (env.AI_PROVIDER || '').trim().toLowerCase();
const KNOWN = KNOWN_AI_PROVIDERS;
if (SELECTED && !KNOWN.has(SELECTED)) {
  logger.error({ event: 'ai.provider.invalid', value: SELECTED.slice(0, 40) },
    'AI_PROVIDER is not one of groq|gemini|openrouter|ollama|openai-compatible|none; AI stays disabled.');
}
const allow = (name: string) => !SELECTED || SELECTED === name;

// P6 AI-09/AI-10: one master-switch rule for chat, transcription and embeddings.
const DISABLED = aiOffByInstallation(env);

/**
 * P6 AI-09: where a voice message may be transcribed — or null.
 *
 * Transcription sends a member's audio to a third party. It used to read
 * GROQ_API_KEY / OPENAI_API_KEY on its own, so AI_PROVIDER=none did not stop
 * it, and an operator who chose one provider still had audio sent to another.
 * Now: off when the installation turned AI off; with AI_PROVIDER=groq only
 * Groq; with any other selected provider none (they have no transcription
 * path here); unset keeps the historical order Groq → OpenAI.
 */
function transcriptionTarget(e: NodeJS.ProcessEnv = process.env):
  { provider: 'groq' | 'openai'; url: string; key: string; model: string } | null {
  if (aiOffByInstallation(e)) return null;
  const sel = (e.AI_PROVIDER || '').trim().toLowerCase();
  if (sel && sel !== 'groq') return null;
  const groq = (e.GROQ_API_KEY || '').trim();
  if (groq) return { provider: 'groq', url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: groq, model: 'whisper-large-v3-turbo' };
  if (sel === 'groq') return null;
  const openai = (e.OPENAI_API_KEY || '').trim();
  if (openai) return { provider: 'openai', url: 'https://api.openai.com/v1/audio/transcriptions', key: openai, model: 'whisper-1' };
  return null;
}

const GROQ_KEY       = !DISABLED && allow('groq') ? env.GROQ_API_KEY : undefined;
const GEMINI_KEY     = !DISABLED && allow('gemini') ? env.GEMINI_API_KEY : undefined;
const OPENROUTER_KEY = !DISABLED && allow('openrouter') ? env.OPENROUTER_API_KEY : undefined;
const OLLAMA_URL     = !DISABLED && allow('ollama') ? env.OLLAMA_URL : undefined;
const OLLAMA_MODEL   = env.OLLAMA_MODEL || 'llama3.2';

/** OpenAI-compatible endpoint, normalised to its `/v1`-style base (no trailing slash). */
function compatibleBase(): string | undefined {
  if (DISABLED || !allow('openai-compatible')) return undefined;
  const raw = (env.AI_BASE_URL || '').trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw new Error('scheme');
    if (!env.AI_MODEL?.trim()) {
      logger.error({ event: 'ai.provider.invalid', provider: 'openai-compatible' }, 'AI_BASE_URL is set but AI_MODEL is not; the OpenAI-compatible provider stays disabled.');
      return undefined;
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    logger.error({ event: 'ai.provider.invalid', provider: 'openai-compatible' }, 'AI_BASE_URL is not a valid http(s) URL without credentials; the OpenAI-compatible provider stays disabled.');
    return undefined;
  }
}
const AI_BASE_URL = compatibleBase();
const AI_MODEL    = (env.AI_MODEL || '').trim();
const AI_API_KEY  = AI_BASE_URL ? (env.AI_API_KEY || '').trim() : '';

const PROVIDER = GROQ_KEY ? 'groq' : GEMINI_KEY ? 'gemini' : OPENROUTER_KEY ? 'openrouter'
  : OLLAMA_URL ? 'ollama' : AI_BASE_URL ? 'openai-compatible' : 'rules';
const AI_ENABLED = PROVIDER !== 'rules';

function envMs(name: string, def: number, min: number, max: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
}
/** Total budget for one callAI(), retries included. */
const AI_TIMEOUT_MS = envMs('AI_TIMEOUT_MS', 30_000, 1_000, 300_000);

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

/** A failure that is safe to show a client: no URL, no key, no upstream body. */
class AiUnavailableError extends Error {
  code: 'AI_DISABLED' | 'AI_TIMEOUT';
  constructor(code: 'AI_DISABLED' | 'AI_TIMEOUT') {
    super(code);
    this.name = 'AiUnavailableError';
    this.code = code;
  }
}

// ── Retry with exponential backoff, inside one total deadline ──────────────
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function withRetry<T>(fn: (remainingMs: number) => Promise<T>, maxAttempts = 3): Promise<T> {
  const deadline = Date.now() + AI_TIMEOUT_MS;
  for (let i = 0; i < maxAttempts; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AiUnavailableError('AI_TIMEOUT');
    try { return await fn(remaining); }
    catch (err) {
      if (i === maxAttempts - 1) throw err;
      const wait = Math.pow(2, i) * 500;
      if (Date.now() + wait >= deadline) throw err;
      logger.warn({ err: err instanceof Error ? err.message : String(err), attempt: i + 1, waitMs: wait, event: 'ai.retry' }, 'AI call failed, retrying.');
      await sleep(wait);
    }
  }
  throw new Error(`Unsupported AI provider: ${PROVIDER}`);
}

/** Headers for the OpenAI-compatible endpoint (the key only when configured). */
function compatibleHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AI_API_KEY) h.Authorization = `Bearer ${AI_API_KEY}`;
  return h;
}

// ── Ana AI çağrısı ────────────────────────────────────────────
// system: string — sistem promptu
// user:   string — kullanıcı mesajı / içerik
// maxTokens: number — max çıktı token sayısı
async function callAI(system: string, user: string, maxTokens = 500): Promise<string> {
  return withRetry(async (remainingMs) => {
    const budget = (ms: number) => Math.max(1, Math.min(ms, remainingMs));
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
        timeoutMs: budget(15_000),
      });
      if (r.ok) { const d = await r.json() as GroqChatResponse; return d.choices?.[0]?.message?.content?.trim() || ''; }
      if (r.status !== 429) throw new Error(`Groq ${r.status}`);
      logger.warn({ event: 'ai.groq.rate_limit' }, 'Groq rate limit hit, falling back.');
    }

    if (GEMINI_KEY) {
      const r = await fetchT(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
        {
          method: 'POST',
          // P5 AI-04: header, not `?key=` — a URL is logged by every proxy on the way.
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${system}\n\n${user}` }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
          }),
          timeoutMs: budget(15_000),
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
        timeoutMs: budget(15_000),
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
        timeoutMs: budget(30_000),
        skipSsrfCheck: true, // OLLAMA_URL yönetici tarafından yapılandırılır (internal servis)
      });
      if (!r.ok) throw new Error(`Ollama ${r.status}`);
      const d = await r.json() as OllamaResponse; return d.response?.trim() || '';
    }

    if (AI_BASE_URL) {
      const r = await fetchT(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: compatibleHeaders(),
        body: JSON.stringify({
          model: AI_MODEL,
          max_tokens: maxTokens,
          temperature: 0.3,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        timeoutMs: budget(30_000),
        skipSsrfCheck: true, // AI_BASE_URL is operator-configured (usually an internal service)
      });
      if (!r.ok) throw new Error(`OpenAI-compatible ${r.status}`);
      const d = await r.json() as GroqChatResponse; return d.choices?.[0]?.message?.content?.trim() || '';
    }

    throw new Error('AI_DISABLED');
  });
}

/**
 * The message a client may see for a failed AI call. Upstream error text can
 * carry internal addresses (Ollama / AI_BASE_URL hosts) or provider details;
 * it is logged server-side (message only) and never forwarded (P5 AI-03).
 */
function aiFailureForClient(err: unknown, context: string): string {
  logger.warn({ event: 'ai.call_failed', context, err: err instanceof Error ? err.message.slice(0, 200) : 'non-error' },
    'AI provider call failed.');
  return err instanceof AiUnavailableError && err.code === 'AI_TIMEOUT'
    ? 'AI sağlayıcısı zamanında yanıt vermedi'
    : 'AI sağlayıcısına şu anda ulaşılamıyor';
}

export { callAI,
  aiOffByInstallation,
  transcriptionTarget,
  aiFailureForClient,
  AiUnavailableError,
  AI_ENABLED,
  AI_TIMEOUT_MS,
  PROVIDER,
  safeProvider,
  GROQ_KEY,
  GEMINI_KEY,
  OPENROUTER_KEY,
  OLLAMA_URL,
  OLLAMA_MODEL,
  AI_BASE_URL,
  AI_MODEL,
  AI_API_KEY, };
