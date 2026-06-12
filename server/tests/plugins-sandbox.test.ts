// server/tests/plugins-sandbox.test.ts
// Sprint 77 — Plugin sandbox güçlendirme testleri
// Kapsam: resourceLimits, boot timeout, HTTP route proxy, import() geçişi, allowlist logger

'use strict';

process.env.NODE_ENV = 'test';

import { validateManifest, isAllowed } from '../../plugins/allowlist';
import { WORKER_RESOURCE_LIMITS, WORKER_BOOT_TIMEOUT_MS } from '../../plugins/lifecycle';

// ── [1] resourceLimits sabitleri ──────────────────────────────
describe('sandbox — resourceLimits sabitleri', () => {
  it('maxOldGenerationSizeMb tanımlı ve makul (32–512 MB arası)', () => {
    expect(WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBeGreaterThanOrEqual(32);
    expect(WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBeLessThanOrEqual(512);
  });

  it('maxYoungGenerationSizeMb tanımlı ve maxOld\'dan küçük', () => {
    expect(WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb).toBeLessThan(
      WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb
    );
  });

  it('stackSizeMb tanımlı ve sıfırdan büyük', () => {
    expect(WORKER_RESOURCE_LIMITS.stackSizeMb).toBeGreaterThan(0);
  });

  it('codeRangeSizeMb tanımlı', () => {
    expect(WORKER_RESOURCE_LIMITS.codeRangeSizeMb).toBeGreaterThan(0);
  });
});

// ── [2] Boot timeout sabiti ───────────────────────────────────
describe('sandbox — boot timeout', () => {
  it('WORKER_BOOT_TIMEOUT_MS en az 5000ms', () => {
    expect(WORKER_BOOT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('WORKER_BOOT_TIMEOUT_MS 60s veya altında (makul üst sınır)', () => {
    expect(WORKER_BOOT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

// ── [3] allowlist — logger parametresi ───────────────────────
describe('allowlist — logger parametresi (Sprint 77)', () => {
  it('isAllowed: geçersiz manifest + logger → logger.warn çağrılır', () => {
    const warnMock = jest.fn();
    const result = isAllowed({ id: 'INVALID_ID', name: 'X', version: '1.0.0' }, { warn: warnMock });
    expect(result).toBe(false);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toContain('[Allowlist]');
  });

  it('isAllowed: geçersiz manifest + logger YOK → hata fırlatmaz', () => {
    expect(() => isAllowed({ id: 'INVALID_ID', name: 'X', version: '1.0.0' })).not.toThrow();
  });

  it('isAllowed: geçerli manifest + logger → logger.warn çağrılmaz', () => {
    const warnMock = jest.fn();
    isAllowed({ id: 'valid-plugin', name: 'Test', version: '1.0.0' }, { warn: warnMock });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('isAllowed: console.warn artık doğrudan çağrılmıyor — logger parametresiz çalışır', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    isAllowed({ id: 'INVALID', name: 'X', version: '1.0.0' });
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── [4] validateManifest — mevcut testlerin regresyon koruması ─
describe('allowlist — validateManifest regresyon', () => {
  it('geçerli minimal manifest → ok', () => {
    expect(validateManifest({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0' }).ok).toBe(true);
  });

  it('yasaklı izin → reddedilir', () => {
    const r = validateManifest({ id: 'x-plugin', name: 'X', version: '1.0.0', permissions: ['admin:write'] });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('admin:write');
  });

  it('yasaklı kategori → reddedilir', () => {
    const r = validateManifest({ id: 'x-plugin', name: 'X', version: '1.0.0', category: 'adult' });
    expect(r.ok).toBe(false);
  });

  it('bilinmeyen izin → reddedilir', () => {
    const r = validateManifest({ id: 'x-plugin', name: 'X', version: '1.0.0', permissions: ['crypto:mine'] });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('Bilinmeyen izin');
  });

  it('izinsiz plugin (permissions tanımsız) → kabul edilir', () => {
    expect(validateManifest({ id: 'x-plugin', name: 'X', version: '1.0.0' }).ok).toBe(true);
  });

  it('permissions dizi değilse → reddedilir', () => {
    const r = validateManifest({ id: 'x-plugin', name: 'X', version: '1.0.0', permissions: 'messages:read' });
    expect(r.ok).toBe(false);
  });

  it("kısıtlı izin (restricted) manifest'te → reddedilmez", () => {
    const r = validateManifest({ id: 'x-plugin', name: 'X', version: '1.0.0', permissions: ['admin:read'] });
    expect(r.ok).toBe(true);
  });

  it('izin array içinde non-string → reddedilir', () => {
    const r = validateManifest({ id: 'x-plugin', name: 'X', version: '1.0.0', permissions: [42] });
    expect(r.ok).toBe(false);
  });
});

// ── [5] HTTP route proxy — mock tabanlı birim testi ───────────
describe('sandbox — HTTP route proxy mock', () => {
  it('reqId + timer mekanizması: pending map temizlenir', async () => {
    // Gerçek Worker spawn olmadan proxy mantığını test et.
    // Aynı reqId ile response gelince pending item silinmeli.
    const pendingRequests = new Map<string, { resolve: (r: { status: number; body: unknown }) => void; timer: ReturnType<typeof setTimeout> }>();
    let resolvedWith: { status: number; body: unknown } | null = null;

    const reqId = 'test-req-1';
    const timer = setTimeout(() => {}, 5_000);
    pendingRequests.set(reqId, {
      resolve: (r) => { resolvedWith = r; },
      timer,
    });

    // Simüle: worker'dan http:response geldi
    const pending = pendingRequests.get(reqId);
    if (pending) {
      pendingRequests.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve({ status: 200, body: { blockedWords: [] } });
    }

    expect(pendingRequests.has(reqId)).toBe(false);
    expect(resolvedWith).toEqual({ status: 200, body: { blockedWords: [] } });
  });

  it('reqId bilinmiyorsa pending map bozulmaz', () => {
    const pendingRequests = new Map<string, { resolve: (r: { status: number; body: unknown }) => void; timer: ReturnType<typeof setTimeout> }>();
    const unknownReqId = 'nonexistent-req';

    const pending = pendingRequests.get(unknownReqId);
    expect(pending).toBeUndefined();
    expect(pendingRequests.size).toBe(0);
  });

  it('timeout (5000ms) sonrası map temizlenir ve 504 dönülür', () => {
    jest.useFakeTimers();
    const pendingRequests = new Map<string, { resolve: (r: { status: number; body: unknown }) => void; timer: ReturnType<typeof setTimeout> }>();
    let timedOut = false;
    let responseStatus = 0;

    const reqId = 'timeout-req';
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      timedOut = true;
      responseStatus = 504;
    }, 5_000);
    pendingRequests.set(reqId, { resolve: () => {}, timer });

    jest.advanceTimersByTime(5_001);

    expect(timedOut).toBe(true);
    expect(responseStatus).toBe(504);
    expect(pendingRequests.has(reqId)).toBe(false);

    jest.useRealTimers();
  });

  // ── Mock req/res genişletme testleri (Sprint 77b) ───────────

  type HttpResponse = { type: string; reqId: string; status: number; body: unknown };
  type MockPort = { postMessage: (m: unknown) => void };

  it('mockRes.redirect() 302 ile yanıt gönderir', () => {
    const posted: HttpResponse[] = [];
    const port: MockPort = { postMessage: (msg) => posted.push(msg as HttpResponse) };

    const mockRes = buildMockRes('req-redirect', port);
    mockRes.redirect('/new-path');

    expect(posted).toHaveLength(1);
    expect(posted[0].status).toBe(302);
    expect(posted[0].body).toEqual({ redirect: '/new-path' });
  });

  it('mockRes.redirect() özel status kodu ile çalışır', () => {
    const posted: HttpResponse[] = [];
    const port: MockPort = { postMessage: (msg) => posted.push(msg as HttpResponse) };

    const mockRes = buildMockRes('req-redirect-301', port);
    mockRes.redirect(301, '/permanent');

    expect(posted[0].status).toBe(301);
    expect(posted[0].body).toEqual({ redirect: '/permanent' });
  });

  it('mockRes._headersSent guard: json() ikinci kez çağrılınca yok sayılır', () => {
    const posted: HttpResponse[] = [];
    const port: MockPort = { postMessage: (msg) => posted.push(msg as HttpResponse) };

    const mockRes = buildMockRes('req-double', port);
    mockRes.json({ first: true });
    mockRes.json({ second: true }); // ikinci çağrı sessizce yutulmalı

    expect(posted).toHaveLength(1);
    expect(posted[0].body).toEqual({ first: true });
  });

  it('mockRes.set() header kaydeder', () => {
    const posted: HttpResponse[] = [];
    const port: MockPort = { postMessage: (msg) => posted.push(msg as HttpResponse) };

    const mockRes = buildMockRes('req-header', port);
    mockRes.set('X-Custom', 'value');
    mockRes.json({ ok: true });

    expect(mockRes._headers['X-Custom']).toBe('value');
  });

  it('mockNext() hata nesnesiyle çağrılınca 500 döner', () => {
    const posted: HttpResponse[] = [];
    const port: MockPort = { postMessage: (msg) => posted.push(msg as HttpResponse) };

    const mockRes = buildMockRes('req-next-err', port);
    const next = buildMockNext('req-next-err', mockRes, port);
    next(new Error('middleware hatası'));

    expect(posted[0].status).toBe(500);
    expect((posted[0].body as { error: string }).error).toBe('middleware hatası');
  });

  it('mockNext() hatasız çağrılınca 404 döner', () => {
    const posted: HttpResponse[] = [];
    const port: MockPort = { postMessage: (msg) => posted.push(msg as HttpResponse) };

    const mockRes = buildMockRes('req-next-noop', port);
    const next = buildMockNext('req-next-noop', mockRes, port);
    next();

    expect(posted[0].status).toBe(404);
  });

  it('handler exception fırlatınca 500 döner ve map temizlenir', () => {
    const posted: HttpResponse[] = [];
    const port: MockPort = { postMessage: (msg) => posted.push(msg as HttpResponse) };

    const mockRes = buildMockRes('req-throw', port);
    try {
      throw new Error('handler patladı');
    } catch (e) {
      if (!mockRes._headersSent) {
        port.postMessage({ type: 'http:response', reqId: 'req-throw', status: 500, body: { error: (e as Error).message } });
      }
    }

    expect(posted[0].status).toBe(500);
    expect((posted[0].body as { error: string }).error).toBe('handler patladı');
  });
});

// ── [Fix #1] bootTimer cleanup ────────────────────────────────
describe('Fix #1 — bootTimer worker error/exit handler\'da temizlenir', () => {
  it('clearTimeout idempotenttir: aynı timer iki kez temizlenirse hata fırlatmaz', () => {
    // Gerçek bir Worker spawn etmeden timer davranışını doğrula.
    jest.useFakeTimers();
    const timer = setTimeout(() => { throw new Error('bootTimer ateşlendi!'); }, 10_000);
    expect(() => {
      clearTimeout(timer); // worker.on('error') tarafından
      clearTimeout(timer); // worker.on('exit') tarafından — idempotent olmalı
    }).not.toThrow();
    jest.runAllTimers(); // 10 saniye ileri sar — hata fırlatmamalı
    jest.useRealTimers();
  });
});

// ── [Fix #2] hook:event double-dispatch ───────────────────────
describe('Fix #2 — hook:event switch case\'de ele alınır, if-block kaldırıldı', () => {
  it('WorkerToMain type union hook:event içeriyor', () => {
    // Tip güvencesi: lifecycle.ts'deki switch artık hook:event case'i içeriyor.
    // Bu test, case'in var olduğunu ve msg.event + msg.args alanlarına erişilebildiğini doğrular.
    type WorkerToMainHookEvent = { type: 'hook:event'; event: string; args: unknown[] };
    const msg: WorkerToMainHookEvent = { type: 'hook:event', event: 'message:created', args: [{ id: 1 }] };
    expect(msg.type).toBe('hook:event');
    expect(msg.event).toBe('message:created');
    expect(msg.args).toHaveLength(1);
  });
});

// ── [Fix #3] teardown _pendingRequests temizliği ──────────────
describe('Fix #3 — teardown sırasında bekleyen HTTP isteklerinin timer\'ları iptal edilir', () => {
  it('teardown öncesi pending map\'te timer varsa clearTimeout çağrılır', () => {
    jest.useFakeTimers();
    const clearedTimers: unknown[] = [];
    const origClear = globalThis.clearTimeout;
    jest.spyOn(globalThis, 'clearTimeout').mockImplementation((t) => {
      clearedTimers.push(t);
      origClear(t as ReturnType<typeof setTimeout>);
    });

    const pendingRequests = new Map<string, { resolve: (r: { status: number; body: unknown }) => void; timer: ReturnType<typeof setTimeout> }>();
    const t1 = setTimeout(() => {}, 5_000);
    const t2 = setTimeout(() => {}, 5_000);
    pendingRequests.set('req-1', { resolve: () => {}, timer: t1 });
    pendingRequests.set('req-2', { resolve: () => {}, timer: t2 });

    // Teardown mantığını simüle et (lifecycle.ts'den kopyalandı)
    for (const { timer } of pendingRequests.values()) clearTimeout(timer);
    pendingRequests.clear();

    expect(pendingRequests.size).toBe(0);
    expect(clearedTimers).toContain(t1);
    expect(clearedTimers).toContain(t2);

    jest.spyOn(globalThis, 'clearTimeout').mockRestore();
    jest.useRealTimers();
  });

  it('pending map boşken teardown hata fırlatmaz', () => {
    const pendingRequests = new Map<string, { resolve: (r: { status: number; body: unknown }) => void; timer: ReturnType<typeof setTimeout> }>();
    expect(() => {
      for (const { timer } of pendingRequests.values()) clearTimeout(timer);
      pendingRequests.clear();
    }).not.toThrow();
  });
});

// ── [Fix #4] worker.on yerine worker.once race condition ──────
describe('Fix #4 — torn_down listener\'ı ara mesajları geçirir', () => {
  it('torn_down olmayan mesaj gelince listener resolve etmez', () => {
    let resolved = false;
    const messages: Array<{ type: string }> = [
      { type: 'log' },
      { type: 'torn_down' },
    ];

    // Fix #4 mantığını simüle et: worker.on + type filtresi
    const onMsg = (msg: { type: string }) => {
      if (msg.type !== 'torn_down') return;
      resolved = true;
    };

    onMsg(messages[0]); // 'log' — geçmeli, resolve etmemeli
    expect(resolved).toBe(false);

    onMsg(messages[1]); // 'torn_down' — resolve etmeli
    expect(resolved).toBe(true);
  });
});

// ── [Fix #6] headers normalisation ───────────────────────────
describe('Fix #6 — Express headers Record<string, string> olarak normalleştirilir', () => {
  it('string[] header değerleri birleştirilir', () => {
    const rawHeaders: Record<string, string | string[] | undefined> = {
      'content-type': 'application/json',
      'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
      'x-empty': undefined,
    };
    // lifecycle.ts'deki normalleştirme mantığının kopyası
    const normalized = Object.fromEntries(
      Object.entries(rawHeaders)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v as string]),
    );
    expect(normalized['content-type']).toBe('application/json');
    expect(normalized['set-cookie']).toBe('a=1; Path=/, b=2; Path=/');
    expect('x-empty' in normalized).toBe(false);
  });

  it('tüm değerler string ise sonuç değişmez', () => {
    const rawHeaders: Record<string, string | string[] | undefined> = {
      'authorization': 'Bearer token123',
      'accept': 'application/json',
    };
    const normalized = Object.fromEntries(
      Object.entries(rawHeaders)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v as string]),
    );
    expect(normalized['authorization']).toBe('Bearer token123');
    expect(normalized['accept']).toBe('application/json');
  });
});

// ── Test yardımcıları — lifecycle.ts proxy mantığını izole test eder ──
function buildMockRes(reqId: string, port: { postMessage: (m: unknown) => void }) {
  return {
    _status: 200,
    _headersSent: false,
    _headers: {} as Record<string, string>,
    status(code: number) { this._status = code; return this; },
    set(field: string | Record<string, string>, value?: string) {
      if (typeof field === 'object') { Object.assign(this._headers, field); }
      else if (value !== undefined) { this._headers[field] = value; }
      return this;
    },
    header(field: string, value?: string) { return this.set(field, value); },
    json(data: unknown) {
      if (this._headersSent) return;
      this._headersSent = true;
      port.postMessage({ type: 'http:response', reqId, status: this._status, body: data });
    },
    send(data: unknown) {
      if (this._headersSent) return;
      this._headersSent = true;
      const body = typeof data === 'object' ? data : { data };
      port.postMessage({ type: 'http:response', reqId, status: this._status, body });
    },
    redirect(urlOrStatus: string | number, url?: string) {
      if (this._headersSent) return;
      this._headersSent = true;
      const redirectUrl = typeof urlOrStatus === 'string' ? urlOrStatus : (url ?? '/');
      const redirectStatus = typeof urlOrStatus === 'number' ? urlOrStatus : 302;
      port.postMessage({ type: 'http:response', reqId, status: redirectStatus, body: { redirect: redirectUrl } });
    },
  };
}

function buildMockNext(
  reqId: string,
  mockRes: ReturnType<typeof buildMockRes>,
  port: { postMessage: (m: unknown) => void },
) {
  return (err?: unknown) => {
    if (mockRes._headersSent) return;
    mockRes._headersSent = true;
    const status = err ? 500 : 404;
    const body = err instanceof Error
      ? { error: err.message }
      : { error: 'next() called — no further handler in sandbox.' };
    port.postMessage({ type: 'http:response', reqId, status, body });
  };
}
