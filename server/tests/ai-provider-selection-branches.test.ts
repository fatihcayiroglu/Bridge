// server/tests/ai-provider-selection-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AI SAĞLAYICI — SEÇİM SIRASI, HIZ SINIRI DEVRİ VE BOŞ YANIT
// ════════════════════════════════════════════════════════════════════════════
//
// Sağlayıcı seçimi modül YÜKLENİRKEN ortam değişkenlerinden yapılır, bu yüzden
// her sağlayıcı ancak izole bir modül grafiğiyle ölçülebilir. Ölçülen
// sözleşmeler:
//
//   · ÖNCELİK. Birden fazla anahtar yapılandırılmışsa sıra belgelenmiş
//     olandır (Groq → Gemini → OpenRouter → Ollama). Sıranın kayması,
//     operatörün ücretli sağlayıcıya farkında olmadan geçmesi demektir.
//   · HIZ SINIRI ≠ HATA. 429 bir sonraki sağlayıcıya DEVREDİLİR; başka
//     sağlayıcı yoksa istek BAŞARISIZ olur. Sessizce boş dize dönmek,
//     çağıran moderasyon/özetleme kodunda "AI hiçbir şey bulmadı" gibi
//     okunurdu — yani hız sınırı sessizce "temiz içerik" anlamına gelirdi.
//   · DİĞER HTTP HATALARI hemen yükseltilir; yeniden deneme kalıbı vardır
//     ama sonunda hata çağırana ulaşır.
//   · BOŞ TAMAMLAMA. Sağlayıcı 200 ama içeriksiz dönerse sonuç boş DİZEDİR;
//     `undefined` değil — çağıranlar doğrudan `.trim()`/`.length` çağırır.

'use strict';
process.env.NODE_ENV = 'test';

const fetchT = jest.fn();
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: log }));

type AiModule = typeof import('../lib/aiProvider');

const AI_ENV = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_URL', 'OLLAMA_MODEL'] as const;
const saved: Record<string, string | undefined> = {};

/** Loads the module with exactly the given AI environment. */
function load(env: Partial<Record<(typeof AI_ENV)[number], string>>): AiModule {
  for (const key of AI_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  let mod!: AiModule;
  jest.isolateModules(() => { mod = require('../lib/aiProvider') as AiModule; });
  return mod;
}

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const realSetTimeout = global.setTimeout;

beforeAll(() => { for (const key of AI_ENV) saved[key] = process.env[key]; });
afterAll(() => {
  for (const key of AI_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  // The retry backoff sleeps 0.5s then 1s. Collapse only those waits so a
  // failing call stays a unit test; everything else keeps real timing.
  jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any, ms: any, ...rest: any[]) => (
    typeof ms === 'number' && ms >= 500 ? realSetTimeout(fn, 0) : realSetTimeout(fn, ms, ...rest)
  )) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('provider selection follows the documented priority', () => {
  const priority: Array<[string, Partial<Record<(typeof AI_ENV)[number], string>>, string]> = [
    ['groq wins over everything', { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x', OPENROUTER_API_KEY: 'y', OLLAMA_URL: 'http://o' }, 'groq'],
    ['gemini is next', { GEMINI_API_KEY: 'x', OPENROUTER_API_KEY: 'y', OLLAMA_URL: 'http://o' }, 'gemini'],
    ['openrouter is next', { OPENROUTER_API_KEY: 'y', OLLAMA_URL: 'http://o' }, 'openrouter'],
    ['ollama is the last real provider', { OLLAMA_URL: 'http://o' }, 'ollama'],
    ['no configuration means rules only', {}, 'rules'],
  ];

  for (const [name, env, expected] of priority) {
    it(name, () => {
      const ai = load(env);
      expect(ai.PROVIDER).toBe(expected);
      expect(ai.AI_ENABLED).toBe(expected !== 'rules');
    });
  }

  it('announces the selected provider outside production only', () => {
    load({ GROQ_API_KEY: 'g' });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.provider.init', provider: 'groq' }), expect.any(String));

    log.info.mockClear();
    process.env.NODE_ENV = 'production';
    try {
      const ai = load({ GROQ_API_KEY: 'g' });
      expect(log.info).not.toHaveBeenCalled();
      // ...and the provider name is not leaked to callers either.
      expect(ai.safeProvider('groq')).toBe('ai');
    } finally { process.env.NODE_ENV = 'test'; }
  });

  it('reports the real provider name outside production', () => {
    const ai = load({ GROQ_API_KEY: 'g' });
    expect(ai.safeProvider('groq')).toBe('groq');
  });

  it('an unconfigured deployment fails the call instead of pretending to answer', async () => {
    const ai = load({});
    await expect(ai.callAI('sys', 'user')).rejects.toThrow('AI_DISABLED');
    expect(fetchT).not.toHaveBeenCalled();
    // Three attempts were made before giving up.
    expect(log.warn.mock.calls.filter(([obj]: any[]) => obj?.event === 'ai.retry')).toHaveLength(2);
  });
});

describe('Groq', () => {
  it('sends the chat payload and returns the trimmed completion', async () => {
    const ai = load({ GROQ_API_KEY: 'gk' });
    fetchT.mockResolvedValue(response(200, { choices: [{ message: { content: '  hello  ' } }] }));

    await expect(ai.callAI('sys', 'user', 128)).resolves.toBe('hello');

    const [url, init] = fetchT.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer gk');
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(128);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' }, { role: 'user', content: 'user' },
    ]);
  });

  it('a 200 with no completion is an empty string, not undefined', async () => {
    const ai = load({ GROQ_API_KEY: 'gk' });
    fetchT.mockResolvedValue(response(200, {}));
    await expect(ai.callAI('sys', 'user')).resolves.toBe('');
  });

  it('a rate limit with no other provider fails rather than answering emptily', async () => {
    const ai = load({ GROQ_API_KEY: 'gk' });
    fetchT.mockResolvedValue(response(429, {}));
    await expect(ai.callAI('sys', 'user')).rejects.toThrow('AI_DISABLED');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.groq.rate_limit' }), expect.any(String));
  });

  it('a rate limit hands the request to the next configured provider', async () => {
    const ai = load({ GROQ_API_KEY: 'gk', GEMINI_API_KEY: 'gm' });
    fetchT
      .mockResolvedValueOnce(response(429, {}))
      .mockResolvedValueOnce(response(200, { candidates: [{ content: { parts: [{ text: 'from gemini' }] } }] }));

    await expect(ai.callAI('sys', 'user')).resolves.toBe('from gemini');
    expect(String((fetchT.mock.calls[1] as unknown[])[0])).toContain('generativelanguage.googleapis.com');
  });

  it('any other HTTP failure surfaces after the retries are exhausted', async () => {
    const ai = load({ GROQ_API_KEY: 'gk' });
    fetchT.mockResolvedValue(response(500, {}));
    await expect(ai.callAI('sys', 'user')).rejects.toThrow('Groq 500');
    expect(fetchT).toHaveBeenCalledTimes(3);
  });

  it('a transient failure that later succeeds is retried, not surfaced', async () => {
    const ai = load({ GROQ_API_KEY: 'gk' });
    fetchT
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(response(200, { choices: [{ message: { content: 'recovered' } }] }));
    await expect(ai.callAI('sys', 'user')).resolves.toBe('recovered');
    expect(fetchT).toHaveBeenCalledTimes(2);
  });
});

describe('Gemini', () => {
  it('sends the prompt as one part and returns the trimmed text', async () => {
    const ai = load({ GEMINI_API_KEY: 'gm' });
    fetchT.mockResolvedValue(response(200, { candidates: [{ content: { parts: [{ text: ' answer ' }] } }] }));

    await expect(ai.callAI('sys', 'user', 64)).resolves.toBe('answer');

    const [url, init] = fetchT.mock.calls[0] as [string, any];
    // P5 AI-04: the key used to ride in the URL (`?key=gm`), where every proxy,
    // APM agent and error log records it. It is a header now.
    expect(url).not.toContain('gm');
    expect(init.headers['x-goog-api-key']).toBe('gm');
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0].text).toBe('sys\n\nuser');
    expect(body.generationConfig.maxOutputTokens).toBe(64);
  });

  it('a 200 with no candidate text is an empty string', async () => {
    const ai = load({ GEMINI_API_KEY: 'gm' });
    fetchT.mockResolvedValue(response(200, { candidates: [] }));
    await expect(ai.callAI('sys', 'user')).resolves.toBe('');
  });

  it('a rate limit falls through to the next provider', async () => {
    const ai = load({ GEMINI_API_KEY: 'gm', OPENROUTER_API_KEY: 'or' });
    fetchT
      .mockResolvedValueOnce(response(429, {}))
      .mockResolvedValueOnce(response(200, { choices: [{ message: { content: 'from openrouter' } }] }));
    await expect(ai.callAI('sys', 'user')).resolves.toBe('from openrouter');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.gemini.rate_limit' }), expect.any(String));
  });

  it('any other HTTP failure surfaces', async () => {
    const ai = load({ GEMINI_API_KEY: 'gm' });
    fetchT.mockResolvedValue(response(503, {}));
    await expect(ai.callAI('sys', 'user')).rejects.toThrow('Gemini 503');
  });
});

describe('OpenRouter', () => {
  it('identifies the calling application and returns the completion', async () => {
    const ai = load({ OPENROUTER_API_KEY: 'or' });
    fetchT.mockResolvedValue(response(200, { choices: [{ message: { content: ' routed ' } }] }));

    await expect(ai.callAI('sys', 'user')).resolves.toBe('routed');

    const [url, init] = fetchT.mock.calls[0] as [string, any];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers['HTTP-Referer']).toBe('https://bridge.chat');
    expect(init.headers['X-Title']).toBe('Bridge');
  });

  it('a 200 with no completion is an empty string', async () => {
    const ai = load({ OPENROUTER_API_KEY: 'or' });
    fetchT.mockResolvedValue(response(200, { choices: [{}] }));
    await expect(ai.callAI('sys', 'user')).resolves.toBe('');
  });

  it('a rate limit is NOT special-cased here and surfaces as an error', async () => {
    const ai = load({ OPENROUTER_API_KEY: 'or', OLLAMA_URL: 'http://ollama.internal' });
    fetchT.mockResolvedValue(response(429, {}));
    await expect(ai.callAI('sys', 'user')).rejects.toThrow('OpenRouter 429');
    // Ollama is configured but must not be reached by a failed OpenRouter call.
    expect(fetchT.mock.calls.every(([url]: unknown[]) => String(url).includes('openrouter.ai'))).toBe(true);
  });
});

describe('Ollama', () => {
  it('posts a single prompt to the configured host and skips the SSRF guard', async () => {
    const ai = load({ OLLAMA_URL: 'http://ollama.internal:11434' });
    fetchT.mockResolvedValue(response(200, { response: '  local answer  ' }));

    await expect(ai.callAI('sys', 'user', 32)).resolves.toBe('local answer');

    const [url, init] = fetchT.mock.calls[0] as [string, any];
    expect(url).toBe('http://ollama.internal:11434/api/generate');
    // The host is operator-configured and deliberately internal, so the guard
    // that blocks private addresses is bypassed only here.
    expect(init.skipSsrfCheck).toBe(true);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama3.2');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(32);
    expect(body.prompt).toContain('sys');
    expect(body.prompt).toContain('user');
  });

  it('honours an explicitly configured model', async () => {
    const ai = load({ OLLAMA_URL: 'http://ollama.internal', OLLAMA_MODEL: 'qwen2.5:7b' });
    fetchT.mockResolvedValue(response(200, { response: 'ok' }));
    await ai.callAI('sys', 'user');
    expect(JSON.parse((fetchT.mock.calls[0] as any[])[1].body).model).toBe('qwen2.5:7b');
  });

  it('a 200 with no response field is an empty string', async () => {
    const ai = load({ OLLAMA_URL: 'http://ollama.internal' });
    fetchT.mockResolvedValue(response(200, {}));
    await expect(ai.callAI('sys', 'user')).resolves.toBe('');
  });

  it('a failing local server surfaces its status', async () => {
    const ai = load({ OLLAMA_URL: 'http://ollama.internal' });
    fetchT.mockResolvedValue(response(502, {}));
    await expect(ai.callAI('sys', 'user')).rejects.toThrow('Ollama 502');
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
