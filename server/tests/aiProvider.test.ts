// server/tests/aiProvider.test.ts
// lib/aiProvider merkezi AI modülü testleri
// Gerçek API çağrısı yapılmaz — fetch stub'lanır.
import { fetchMock, installFetchMock } from './helpers/fetchDouble';

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../lib/fetch', () => ({
  fetchT: jest.fn((...args: Parameters<typeof fetch>) => global.fetch(...args)),
}));

// Ortam değişkenlerini test için ayarla
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  Object.assign(process.env, ORIGINAL_ENV);
  // Modül cache'ini temizle — env değişikliği etkili olsun
  jest.resetModules();
});

function makeOkResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text } }],
    }),
  };
}

function makeRateLimitResponse() {
  return { ok: false, status: 429, json: async () => ({}) };
}

function makeErrorResponse(status: number) {
  return { ok: false, status, json: async () => ({ error: 'server error' }) };
}

describe('aiProvider — provider seçimi', () => {
  it('GROQ_API_KEY varsa provider groq olur', () => {
    process.env.GROQ_API_KEY = 'gsk_test';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_URL;
    const { PROVIDER, AI_ENABLED } = require('../lib/aiProvider');
    expect(PROVIDER).toBe('groq');
    expect(AI_ENABLED).toBe(true);
  });

  it('hiç key yoksa provider rules olur ve AI_ENABLED false', () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_URL;
    const { PROVIDER, AI_ENABLED } = require('../lib/aiProvider');
    expect(PROVIDER).toBe('rules');
    expect(AI_ENABLED).toBe(false);
  });
});

describe('aiProvider — callAI Groq', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'gsk_test';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_URL;
  });

  it('başarılı Groq yanıtını döner', async () => {
    installFetchMock().mockResolvedValue(makeOkResponse('merhaba!'));
    const { callAI } = require('../lib/aiProvider');
    const result = await callAI('sistem', 'kullanıcı', 100);
    expect(result).toBe('merhaba!');
    expect(fetchMock()).toHaveBeenCalledWith(
      expect.stringContaining('groq.com'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('Groq 500 hatası → Error fırlatır', async () => {
    installFetchMock().mockResolvedValue(makeErrorResponse(500));
    const { callAI } = require('../lib/aiProvider');
    await expect(callAI('sistem', 'kullanıcı')).rejects.toThrow('Groq 500');
  });

  it('AI_DISABLED (hiç provider yok) → Error fırlatır', async () => {
    delete process.env.GROQ_API_KEY;
    const { callAI } = require('../lib/aiProvider');
    await expect(callAI('sistem', 'kullanıcı')).rejects.toThrow('AI_DISABLED');
  });
});

describe('aiProvider — Groq 429 Gemini fallback', () => {
  it('Groq 429 → Gemini kullanılır', async () => {
    process.env.GROQ_API_KEY   = 'gsk_test';
    process.env.GEMINI_API_KEY = 'AIza_test';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_URL;

    installFetchMock()
      .mockResolvedValueOnce(makeRateLimitResponse()) // Groq 429
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'gemini yanıtı' }] } }],
        }),
      });

    const { callAI } = require('../lib/aiProvider');
    const result = await callAI('sistem', 'kullanıcı', 100);
    expect(result).toBe('gemini yanıtı');
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(fetchMock().mock.calls[1][0]).toContain('googleapis.com');
  });
});

describe('aiProvider — retry mantığı', () => {
  it('hata 3 kez → 3. denemede de hata fırlatır', async () => {
    process.env.GROQ_API_KEY = 'gsk_test';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_URL;

    installFetchMock().mockResolvedValue(makeErrorResponse(503));

    const { callAI } = require('../lib/aiProvider');
    await expect(callAI('sistem', 'kullanıcı')).rejects.toThrow();
    // withRetry 3 deneme yapar
    expect(fetchMock().mock.calls.length).toBe(3);
  }, 15000);
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
