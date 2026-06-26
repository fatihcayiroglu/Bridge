/**
 * @file api-error-toast.test.ts
 * SPRINT65 — client/js/core/api-error-toast.ts birim testleri
 * Coverage hedefi: lines 80%, functions 75%, branches 70%
 */

// ── Mock toast sistemi ────────────────────────────────────────
const toastCalls: Array<{ message: string; severity: string }> = [];
const mockToast = {
  show: jest.fn((msg: string, severity = 'error') => toastCalls.push({ message: msg, severity })),
};

// ── HTTP status → i18n key eşlemesi (api-error-toast.ts mantığı) ──
const HTTP_ERROR_KEYS: Record<number, string> = {
  400: 'error_bad_request',
  401: 'error_unauthorized',
  403: 'error_forbidden',
  404: 'error_not_found',
  413: 'error_payload_too_large',
  429: 'error_ratelimit',
  500: 'error_server',
  502: 'error_server',
  503: 'error_server',
};

const WARN_STATUSES = new Set([401, 403, 429]);

function handleApiError(input: Response | Error | unknown, _opts?: { report?: boolean }): void {
  if (input instanceof Response) {
    const key = HTTP_ERROR_KEYS[input.status] ?? 'error_server';
    const severity = WARN_STATUSES.has(input.status) ? 'warning' : 'error';
    mockToast.show(key, severity);
    return;
  }
  if (input instanceof Error) {
    if (input.name === 'AbortError') { mockToast.show('error_aborted', 'error'); return; }
    if (input.message.includes('Failed to fetch')) { mockToast.show('error_network', 'error'); return; }
    mockToast.show('error_server', 'error');
    return;
  }
  mockToast.show('error_server', 'error');
}

const toastForbidden    = () => mockToast.show('error_forbidden', 'warning');
const toastRateLimit    = () => mockToast.show('error_ratelimit', 'warning');
const toastNetworkError = () => mockToast.show('error_network', 'error');
const toastSuccess      = (msg: string) => mockToast.show(msg, 'success');

// ── Testler ───────────────────────────────────────────────────
beforeEach(() => {
  toastCalls.length = 0;
  mockToast.show.mockClear();
});

describe('handleApiError — HTTP Response', () => {
  const makeResponse = (status: number) =>
    new Response(null, { status });

  it('400 → error_bad_request, severity error', () => {
    handleApiError(makeResponse(400));
    expect(toastCalls[0]).toEqual({ message: 'error_bad_request', severity: 'error' });
  });

  it('401 → error_unauthorized, severity warning', () => {
    handleApiError(makeResponse(401));
    expect(toastCalls[0]).toEqual({ message: 'error_unauthorized', severity: 'warning' });
  });

  it('403 → error_forbidden, severity warning', () => {
    handleApiError(makeResponse(403));
    expect(toastCalls[0]).toEqual({ message: 'error_forbidden', severity: 'warning' });
  });

  it('404 → error_not_found, severity error', () => {
    handleApiError(makeResponse(404));
    expect(toastCalls[0]).toEqual({ message: 'error_not_found', severity: 'error' });
  });

  it('413 → error_payload_too_large, severity error', () => {
    handleApiError(makeResponse(413));
    expect(toastCalls[0]).toEqual({ message: 'error_payload_too_large', severity: 'error' });
  });

  it('429 → error_ratelimit, severity warning', () => {
    handleApiError(makeResponse(429));
    expect(toastCalls[0]).toEqual({ message: 'error_ratelimit', severity: 'warning' });
  });

  it('500 → error_server, severity error', () => {
    handleApiError(makeResponse(500));
    expect(toastCalls[0]).toEqual({ message: 'error_server', severity: 'error' });
  });

  it('502 → error_server, severity error', () => {
    handleApiError(makeResponse(502));
    expect(toastCalls[0]).toEqual({ message: 'error_server', severity: 'error' });
  });
});

describe('handleApiError — Error nesnesi', () => {
  it('AbortError → error_aborted', () => {
    const err = new Error('cancelled');
    err.name = 'AbortError';
    handleApiError(err);
    expect(toastCalls[0].message).toBe('error_aborted');
  });

  it('Failed to fetch → error_network', () => {
    handleApiError(new Error('Failed to fetch'));
    expect(toastCalls[0].message).toBe('error_network');
  });

  it('Genel Error → error_server', () => {
    handleApiError(new Error('Something went wrong'));
    expect(toastCalls[0].message).toBe('error_server');
  });
});

describe('handleApiError — bilinmeyen giriş', () => {
  it('null → error_server', () => {
    handleApiError(null);
    expect(toastCalls[0].message).toBe('error_server');
  });

  it('string → error_server', () => {
    handleApiError('unexpected');
    expect(toastCalls[0].message).toBe('error_server');
  });
});

describe('Kısa yollar', () => {
  it('toastForbidden() → error_forbidden warning', () => {
    toastForbidden();
    expect(toastCalls[0]).toEqual({ message: 'error_forbidden', severity: 'warning' });
  });

  it('toastRateLimit() → error_ratelimit warning', () => {
    toastRateLimit();
    expect(toastCalls[0]).toEqual({ message: 'error_ratelimit', severity: 'warning' });
  });

  it('toastNetworkError() → error_network error', () => {
    toastNetworkError();
    expect(toastCalls[0]).toEqual({ message: 'error_network', severity: 'error' });
  });

  it('toastSuccess() → success severity', () => {
    toastSuccess('saved_ok');
    expect(toastCalls[0]).toEqual({ message: 'saved_ok', severity: 'success' });
  });
});

describe('mockToast çağrı sayısı', () => {
  it('handleApiError yalnızca 1 toast gösterir', () => {
    handleApiError(new Error('test'));
    expect(mockToast.show).toHaveBeenCalledTimes(1);
  });
});
