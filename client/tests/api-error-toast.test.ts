// client/tests/api-error-toast.test.ts — Sprint 64
// api-error-toast.ts için unit testler
//
// Kapsam:
//   - handleApiError(Response): HTTP status → i18n key → toast eşlemesi
//   - handleApiError(Response): severity mapping (error / warning)
//   - handleApiError(Response): report=true → errorBoundary.report çağrısı
//   - handleApiError(Response): customMessage önceliği
//   - handleApiError(Response): fallbackKey kullanımı (bilinmeyen status)
//   - handleApiError(Error): ağ hatası algılama (Failed to fetch, AbortError)
//   - handleApiError(Error): genel Error nesnesi
//   - handleApiError(unknown): string / null / undefined girişler
//   - Kısa yollar: toastForbidden, toastRateLimit, toastNetworkError, toastSuccess
//   - Severity override: opts.severity

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockToast           = jest.fn();
const mockErrorBoundaryRp = jest.fn();

jest.mock('../js/core/utils', () => ({
  toast: mockToast,
}), { virtual: true });

jest.mock('../js/core/i18n', () => ({
  t: (key: string, fallback?: string) => fallback ?? key,
}), { virtual: true });

jest.mock('../js/core/error-boundary', () => ({
  errorBoundary: {
    report: mockErrorBoundaryRp,
    wrap:   jest.fn((_, fn) => fn),
  },
}), { virtual: true });

// ── Import ────────────────────────────────────────────────────────────────────

import {
  handleApiError,
  toastForbidden,
  toastRateLimit,
  toastNetworkError,
  toastSuccess,
} from '../js/core/api-error-toast';

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function mockResponse(status: number, url = '/api/test', body: object = {}): Response {
  const r = {
    ok:     status < 400,
    status,
    url,
    clone:  () => r,
    json:   () => Promise.resolve(body),
    text:   () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
  return r;
}

function mockError(message: string, name = 'Error'): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── handleApiError — Response ─────────────────────────────────────────────────

describe('handleApiError — Response nesnesi', () => {

  test('400 → error_generic i18n key, error severity', async () => {
    await handleApiError(mockResponse(400));
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringContaining('hata'),   // fallback içeriyor
      'error',
    );
  });

  test('401 → error_unauthorized, warning severity', async () => {
    await handleApiError(mockResponse(401));
    const [, severity] = mockToast.mock.calls[0];
    expect(severity).toBe('warning');
  });

  test('403 → error_forbidden, warning severity', async () => {
    await handleApiError(mockResponse(403));
    const [, severity] = mockToast.mock.calls[0];
    expect(severity).toBe('warning');
  });

  test('404 → error_not_found, error severity', async () => {
    await handleApiError(mockResponse(404));
    const [, severity] = mockToast.mock.calls[0];
    expect(severity).toBe('error');
  });

  test('413 → error_upload_size', async () => {
    await handleApiError(mockResponse(413));
    const [msg] = mockToast.mock.calls[0];
    expect(msg).toBeTruthy();
    const [, severity] = mockToast.mock.calls[0];
    expect(severity).toBe('error');
  });

  test('429 → error_ratelimit, warning severity', async () => {
    await handleApiError(mockResponse(429));
    const [, severity] = mockToast.mock.calls[0];
    expect(severity).toBe('warning');
  });

  test('500 → error_server, error severity', async () => {
    await handleApiError(mockResponse(500));
    const [, severity] = mockToast.mock.calls[0];
    expect(severity).toBe('error');
  });

  test('502 → error_server (same as 500)', async () => {
    await handleApiError(mockResponse(502));
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('503 → error_server', async () => {
    await handleApiError(mockResponse(503));
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('bilinmeyen status (418) → fallbackKey kullanılır', async () => {
    await handleApiError(mockResponse(418));
    expect(mockToast).toHaveBeenCalledTimes(1);
    const [msg] = mockToast.mock.calls[0];
    expect(msg).toBeTruthy();
  });

  test('customMessage: kendi mesajını override eder', async () => {
    await handleApiError(mockResponse(500), { customMessage: 'Özel mesaj' });
    expect(mockToast).toHaveBeenCalledWith('Özel mesaj', 'error');
  });

  test('fallbackKey: bilinmeyen status için özel key', async () => {
    await handleApiError(mockResponse(418), { fallbackKey: 'error_not_found' });
    // i18n mock'u fallback olarak key döndürür, gerçek sistemde çeviri gelir
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  test('severity override: warning olarak geçilince 500 bile warning', async () => {
    await handleApiError(mockResponse(500), { severity: 'warning' });
    const [, sev] = mockToast.mock.calls[0];
    expect(sev).toBe('warning');
  });

  test('report=false (default): errorBoundary.report çağrılmaz', async () => {
    await handleApiError(mockResponse(500));
    expect(mockErrorBoundaryRp).not.toHaveBeenCalled();
  });

  test('report=true: errorBoundary.report çağrılır', async () => {
    await handleApiError(mockResponse(500), { report: true });
    expect(mockErrorBoundaryRp).toHaveBeenCalledWith(
      expect.any(Error),
      'api-error-toast',
    );
  });

  test('report=true, 401: errorBoundary.report çağrılır', async () => {
    await handleApiError(mockResponse(401), { report: true });
    expect(mockErrorBoundaryRp).toHaveBeenCalled();
  });
});

// ── handleApiError — Error nesnesi ────────────────────────────────────────────

describe('handleApiError — Error nesnesi', () => {

  test('"Failed to fetch" → ağ hatası mesajı', async () => {
    await handleApiError(mockError('Failed to fetch'));
    const [msg, sev] = mockToast.mock.calls[0];
    expect(msg).toContain('Bağlantı');
    expect(sev).toBe('error');
  });

  test('AbortError → ağ hatası mesajı', async () => {
    await handleApiError(mockError('The operation was aborted', 'AbortError'));
    const [msg] = mockToast.mock.calls[0];
    expect(msg).toContain('Bağlantı');
  });

  test('NetworkError → ağ hatası mesajı', async () => {
    await handleApiError(mockError('Network request failed', 'NetworkError'));
    const [msg] = mockToast.mock.calls[0];
    expect(msg).toContain('Bağlantı');
  });

  test('genel Error → fallback mesaj gösterilir', async () => {
    await handleApiError(new Error('Unexpected problem'));
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('customMessage: Error için de override çalışır', async () => {
    await handleApiError(mockError('Failed to fetch'), { customMessage: 'Bağlantı yok' });
    expect(mockToast).toHaveBeenCalledWith('Bağlantı yok', 'error');
  });

  test('report=true: errorBoundary.report çağrılır', async () => {
    await handleApiError(new Error('boom'), { report: true });
    expect(mockErrorBoundaryRp).toHaveBeenCalledWith(
      expect.any(Error),
      'api-error-toast',
    );
  });

  test('severity override: Error için warning', async () => {
    await handleApiError(new Error('x'), { severity: 'warning' });
    const [, sev] = mockToast.mock.calls[0];
    expect(sev).toBe('warning');
  });
});

// ── handleApiError — bilinmeyen giriş ─────────────────────────────────────────

describe('handleApiError — unknown giriş', () => {

  test('string giriş → fallback toast', async () => {
    await handleApiError('something went wrong');
    expect(mockToast).toHaveBeenCalledTimes(1);
    const [, sev] = mockToast.mock.calls[0];
    expect(sev).toBe('error');
  });

  test('null giriş → fallback toast', async () => {
    await handleApiError(null);
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  test('undefined giriş → fallback toast', async () => {
    await handleApiError(undefined);
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  test('number giriş → fallback toast', async () => {
    await handleApiError(42);
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  test('report=true: errorBoundary.report çağrılır', async () => {
    await handleApiError('raw error', { report: true });
    expect(mockErrorBoundaryRp).toHaveBeenCalled();
  });

  test('customMessage: unknown giriş için de override çalışır', async () => {
    await handleApiError(null, { customMessage: 'Bilinmeyen hata' });
    expect(mockToast).toHaveBeenCalledWith('Bilinmeyen hata', 'error');
  });
});

// ── Kısa yollar ───────────────────────────────────────────────────────────────

describe('toastForbidden', () => {
  test('varsayılan mesaj, warning severity', () => {
    toastForbidden();
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'warning');
  });

  test('özel mesaj geçilince onu kullanır', () => {
    toastForbidden('Kanalı yönetme yetkin yok.');
    expect(mockToast).toHaveBeenCalledWith('Kanalı yönetme yetkin yok.', 'warning');
  });
});

describe('toastRateLimit', () => {
  test('warning severity ile çağrılır', () => {
    toastRateLimit();
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'warning');
  });
});

describe('toastNetworkError', () => {
  test('error severity ile çağrılır', () => {
    toastNetworkError();
    expect(mockToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('mesaj Bağlantı içerir', () => {
    toastNetworkError();
    const [msg] = mockToast.mock.calls[0];
    expect(msg).toContain('Bağlantı');
  });
});

describe('toastSuccess', () => {
  test('success severity ile çağrılır', () => {
    toastSuccess('Kaydedildi!');
    expect(mockToast).toHaveBeenCalledWith('Kaydedildi!', 'success');
  });

  test('mesajı aynen iletir', () => {
    toastSuccess('İşlem tamamlandı.');
    expect(mockToast).toHaveBeenCalledWith('İşlem tamamlandı.', 'success');
  });
});

// ── Tüm HTTP status'lerin toast ürettiği ─────────────────────────────────────

describe('handleApiError — tüm bilinen HTTP statuslar toast üretir', () => {
  const statuses = [400, 401, 403, 404, 413, 429, 500, 502, 503];

  statuses.forEach(status => {
    test(`${status} → toast çağrılır`, async () => {
      await handleApiError(mockResponse(status));
      expect(mockToast).toHaveBeenCalledTimes(1);
    });

    afterEach(() => jest.clearAllMocks());
  });
});
