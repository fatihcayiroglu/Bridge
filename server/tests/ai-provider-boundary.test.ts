// server/tests/ai-provider-boundary.test.ts
//
// P5 Workstream B — the provider boundary an operator relies on:
//   · AI_PROVIDER selects exactly one provider; `none` is an off switch that
//     holds even when API keys are present (nothing is ever contacted).
//   · A self-hosted OpenAI-compatible server (vLLM, llama.cpp, LM Studio,
//     LocalAI, Ollama /v1) is a first-class provider: AI_BASE_URL + AI_MODEL.
//   · One call has ONE total deadline (AI_TIMEOUT_MS) across its retries.
//   · What reaches a client on failure never carries upstream text.
'use strict';
process.env.NODE_ENV = 'test';

const fetchT = jest.fn();
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: log }));

type AiModule = typeof import('../lib/aiProvider');
const KEYS = ['AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'AI_TIMEOUT_MS',
  'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_URL', 'OLLAMA_MODEL'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });
beforeEach(() => { jest.clearAllMocks(); });

function load(env: Partial<Record<(typeof KEYS)[number], string>>): AiModule {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let mod!: AiModule;
  jest.isolateModules(() => { mod = require('../lib/aiProvider') as AiModule; });
  return mod;
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('AI_PROVIDER selects one provider; none is an off switch', () => {
  it('none: AI is off even with keys configured, and nothing is contacted', async () => {
    const ai = load({ AI_PROVIDER: 'none', GROQ_API_KEY: 'gk', OLLAMA_URL: 'http://ollama.internal' });
    expect(ai.AI_ENABLED).toBe(false);
    expect(ai.PROVIDER).toBe('rules');
    await expect(ai.callAI('s', 'u')).rejects.toThrow('AI_DISABLED');
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('an explicit choice wins over the legacy priority — the other keys are never used', async () => {
    const ai = load({ AI_PROVIDER: 'ollama', GROQ_API_KEY: 'gk', OLLAMA_URL: 'http://ollama.internal' });
    expect(ai.PROVIDER).toBe('ollama');
    fetchT.mockResolvedValue(ok({ response: 'local' }));
    await expect(ai.callAI('s', 'u')).resolves.toBe('local');
    expect(fetchT.mock.calls.every(([url]) => String(url).startsWith('http://ollama.internal'))).toBe(true);
  });

  it('an unknown value disables AI loudly rather than guessing', () => {
    const ai = load({ AI_PROVIDER: 'chatgpt', GROQ_API_KEY: 'gk' });
    expect(ai.AI_ENABLED).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'ai.provider.invalid' }), expect.any(String));
  });
});

describe('self-hosted OpenAI-compatible provider', () => {
  it('posts the chat payload to <AI_BASE_URL>/chat/completions with the configured model', async () => {
    const ai = load({ AI_BASE_URL: 'http://llm.internal:8000/v1/', AI_MODEL: 'local-model', AI_API_KEY: 'sk-local' });
    expect(ai.PROVIDER).toBe('openai-compatible');
    fetchT.mockResolvedValue(ok({ choices: [{ message: { content: ' self-hosted ' } }] }));

    await expect(ai.callAI('sys', 'usr', 64)).resolves.toBe('self-hosted');
    const [url, init] = fetchT.mock.calls[0] as [string, any];
    expect(url).toBe('http://llm.internal:8000/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-local');
    expect(init.skipSsrfCheck).toBe(true); // operator-configured internal host
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'local-model', max_tokens: 64,
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }],
    });
  });

  it('no AI_API_KEY → no Authorization header at all (local servers need none)', async () => {
    const ai = load({ AI_BASE_URL: 'http://llm.internal:8000/v1', AI_MODEL: 'm' });
    fetchT.mockResolvedValue(ok({ choices: [{ message: { content: 'x' } }] }));
    await ai.callAI('s', 'u');
    expect((fetchT.mock.calls[0] as any[])[1].headers.Authorization).toBeUndefined();
  });

  it.each([
    ['without AI_MODEL', { AI_BASE_URL: 'http://llm.internal/v1' }],
    ['with credentials in the URL', { AI_BASE_URL: 'http://user:pw@llm.internal/v1', AI_MODEL: 'm' }],
    ['with a non-http scheme', { AI_BASE_URL: 'file:///tmp/sock', AI_MODEL: 'm' }],
  ])('is refused %s', (_label, env) => {
    const ai = load(env);
    expect(ai.AI_ENABLED).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'ai.provider.invalid', provider: 'openai-compatible' }), expect.any(String));
  });

  it('a failing server surfaces its status only', async () => {
    const ai = load({ AI_BASE_URL: 'http://llm.internal/v1', AI_MODEL: 'm' });
    fetchT.mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'internal detail' }) });
    await expect(ai.callAI('s', 'u')).rejects.toThrow('OpenAI-compatible 502');
  });
});

describe('one total deadline per call', () => {
  it('each attempt gets at most the remaining budget, not a fresh 15 s', async () => {
    const ai = load({ GROQ_API_KEY: 'gk', AI_TIMEOUT_MS: '2000' });
    fetchT.mockResolvedValue(ok({ choices: [{ message: { content: 'x' } }] }));
    await ai.callAI('s', 'u');
    expect((fetchT.mock.calls[0] as any[])[1].timeoutMs).toBeLessThanOrEqual(2000);
  });

  it('a retry that would start after the deadline is not made', async () => {
    const ai = load({ GROQ_API_KEY: 'gk', AI_TIMEOUT_MS: '1000' });
    fetchT.mockRejectedValue(new Error('socket hang up'));
    const t0 = Date.now();
    await expect(ai.callAI('s', 'u')).rejects.toThrow();
    // Attempt 1, 500 ms backoff, attempt 2; the 1000 ms backoff would cross the deadline.
    expect(fetchT).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('client-facing failure text', () => {
  it('never forwards upstream text (internal hosts, provider detail)', () => {
    const ai = load({});
    const shown = ai.aiFailureForClient(new Error('connect ECONNREFUSED 10.0.0.5:11434'), 'test');
    expect(shown).not.toContain('10.0.0.5');
    expect(shown).toBe('AI sağlayıcısına şu anda ulaşılamıyor');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'ai.call_failed', context: 'test' }), expect.any(String));
  });

  it('a timeout says so', () => {
    const ai = load({});
    expect(ai.aiFailureForClient(new ai.AiUnavailableError('AI_TIMEOUT'), 'test')).toBe('AI sağlayıcısı zamanında yanıt vermedi');
  });
});

export {};
