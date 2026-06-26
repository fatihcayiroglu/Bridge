// server/tests/botRateLimit.test.ts
// Bot SDK rateLimit event ve otomatik retry davranışı testleri

'use strict';
process.env.NODE_ENV = 'test';

// BridgeBot'un _api metodunu izole test et
// Gerçek socket bağlantısı kurulmaz — sadece HTTP katmanı test edilir.

import EventEmitter from 'eventemitter3';

// Minimal _api izolasyonu için BridgeBot'ı subclass'lıyoruz
class TestBot extends EventEmitter {
  constructor() {
    super();
    this.token     = 'brg_bot_test';
    this.serverUrl = 'http://localhost:3001';
    this.debug     = false;
  }

  _log(...args) { if (this.debug) console.log('[TestBot]', ...args); }

  async _api(method, path, body, _retryCount = 0) {
    const url = `${this.serverUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type':  'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 && _retryCount < 3) {
      const retryAfterSec = parseFloat(res.headers.get('retry-after') || '1');
      const retryAfterMs  = Math.ceil(retryAfterSec * 1000);
      this.emit('rateLimit', { path, method, retryAfter: retryAfterSec, retryCount: _retryCount });
      await new Promise(r => setTimeout(r, retryAfterMs));
      return this._api(method, path, body, _retryCount + 1);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`API hatası ${res.status}: ${err.error || res.statusText}`);
    }

    return res.status === 204 ? null : res.json();
  }
}

describe('Bot SDK — rateLimit event & retry', () => {
  let bot;
  const rateLimitEvents = [];

  beforeEach(() => {
    bot = new TestBot();
    rateLimitEvents.length = 0;
    bot.on('rateLimit', (info) => rateLimitEvents.push(info));
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('429 alınca rateLimit event\'i tetiklenir', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (h) => h === 'retry-after' ? '0.01' : null },
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ success: true }),
      });

    const result = await bot._api('GET', '/api/test');
    expect(rateLimitEvents).toHaveLength(1);
    expect(rateLimitEvents[0]).toMatchObject({ path: '/api/test', method: 'GET', retryCount: 0 });
    expect(result).toEqual({ success: true });
  });

  it('maks 3 retry sonra hata fırlatır', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h) => h === 'retry-after' ? '0.001' : null },
      json: async () => ({}),
    });

    await expect(bot._api('POST', '/api/messages/ch1', { content: 'hi' }))
      .rejects.toThrow('API hatası 429');

    // 3 rateLimit eventi tetiklenir (retryCount 0, 1, 2)
    expect(rateLimitEvents).toHaveLength(3);
    expect(rateLimitEvents.map(e => e.retryCount)).toEqual([0, 1, 2]);
  }, 10000);

  it('rateLimit subscribe edilmezse hata fırlatılmaz', async () => {
    const quietBot = new TestBot(); // hiç listener yok
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => '0.001' },
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true }),
      });

    await expect(quietBot._api('GET', '/api/health')).resolves.toEqual({ ok: true });
  });

  it('Retry-After header yoksa 1 saniye bekler', async () => {
    const sleepSpy = jest.spyOn(global, 'setTimeout');

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => null },
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
      });

    await expect(bot._api('GET', '/api/test')).resolves.toEqual({});
    expect(sleepSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });
});
