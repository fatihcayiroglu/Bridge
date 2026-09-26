process.env.NODE_ENV = 'test';
process.env.HTTP_MAX_REDIRECTS = '1';

import type { Response as UndiciResponse } from 'undici';

const mockUndiciFetch = jest.fn();
const mockAssertTargetAllowed = jest.fn();
const mockResolveAddresses = jest.fn();
const mockAssertAddresses = jest.fn();
let capturedConnect: { lookup?: Function; servername?: string } | undefined;

class MockSSRFError extends Error {
  constructor(message: string, public hostname?: string) { super(message); this.name = 'SSRFError'; }
}

jest.mock('undici', () => ({
  fetch: (...args: unknown[]) => mockUndiciFetch(...args),
  Agent: jest.fn().mockImplementation((opts: { connect?: typeof capturedConnect }) => {
    capturedConnect = opts?.connect;
    return { kind: 'agent' };
  }),
}));

jest.mock('../lib/ssrfGuard', () => ({
  SSRFError: MockSSRFError,
  isPrivateIP: jest.fn(() => false),
  assertUrlIsPublic: jest.fn(),
  assertTargetAllowed: (...args: unknown[]) => mockAssertTargetAllowed(...args),
  assertAddressesNotPrivate: (...args: unknown[]) => mockAssertAddresses(...args),
  resolveHostnameAddresses: (...args: unknown[]) => mockResolveAddresses(...args),
}));

import { fetchT } from '../lib/fetch';

function response(status: number, location?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(location === undefined ? {} : { location }),
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedConnect = undefined;
  mockAssertTargetAllowed.mockImplementation(async (url: string | URL) => ({
    hostname: new URL(String(url)).hostname,
    addresses: ['93.184.216.34'],
    allowlisted: false,
    bareIp: false,
  }));
  mockResolveAddresses.mockResolvedValue(['93.184.216.34']);
  mockUndiciFetch.mockResolvedValue(response(200));
});

describe('fetch transport and redirect branches', () => {
  it('passes body and explicit redirect through without manual redirect handling', async () => {
    await fetchT('https://public.example/post', {
      method: 'POST', body: 'payload', redirect: 'error', headers: { 'X-Test': '1' },
    });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
    const init = mockUndiciFetch.mock.calls[0][1];
    expect(init.body).toBe('payload');
    expect(init.redirect).toBe('error');
    expect(init.headers['X-Test']).toBe('1');
    expect(init.headers['User-Agent']).toMatch(/^Bridge\//);
  });

  it('omits null body and accepts URL objects', async () => {
    await fetchT(new URL('https://public.example/object'), { body: null });
    const init = mockUndiciFetch.mock.calls[0][1];
    expect(Object.prototype.hasOwnProperty.call(init, 'body')).toBe(false);
  });

  it.each([
    [303, 'PUT', 'GET'],
    [301, 'POST', 'GET'],
    [302, 'POST', 'GET'],
    [307, 'POST', 'POST'],
  ])('redirect %s maps method %s -> %s and resolves relative Location', async (status, method, expected) => {
    mockUndiciFetch
      .mockResolvedValueOnce(response(status as number, '/next'))
      .mockResolvedValueOnce(response(200));

    await fetchT('https://public.example/start', { method: method as string, body: 'x' });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(2);
    expect(mockUndiciFetch.mock.calls[1][0]).toBe('https://public.example/next');
    expect(mockUndiciFetch.mock.calls[1][1].method).toBe(expected);
    if (expected === 'GET') expect(mockUndiciFetch.mock.calls[1][1].body).toBeUndefined();
    else expect(mockUndiciFetch.mock.calls[1][1].body).toBe('x');
    expect(mockAssertTargetAllowed).toHaveBeenCalledTimes(2);
  });

  it('returns redirect response unchanged when Location is absent', async () => {
    const redirect = response(302);
    mockUndiciFetch.mockResolvedValueOnce(redirect);
    await expect(fetchT('https://public.example/start')).resolves.toBe(redirect);
    expect(mockAssertTargetAllowed).toHaveBeenCalledTimes(1);
  });

  it('fails closed after the configured redirect limit', async () => {
    mockUndiciFetch
      .mockResolvedValueOnce(response(302, '/one'))
      .mockResolvedValueOnce(response(302, '/two'));
    await expect(fetchT('https://public.example/start')).rejects.toThrow(/Too many redirects/);
  });

  it('allowlisted/bare-IP verdicts do not create a custom dispatcher', async () => {
    mockAssertTargetAllowed.mockResolvedValueOnce({ hostname: 'allowed', addresses: [], allowlisted: true, bareIp: false });
    await fetchT('https://allowed.example/', { redirect: 'manual' });
    expect(mockUndiciFetch.mock.calls[0][1].dispatcher).toBeUndefined();

    mockAssertTargetAllowed.mockResolvedValueOnce({ hostname: '1.1.1.1', addresses: ['1.1.1.1'], allowlisted: false, bareIp: true });
    await fetchT('https://1.1.1.1/', { redirect: 'manual' });
    expect(mockUndiciFetch.mock.calls[1][1].dispatcher).toBeUndefined();
  });

  it('rejects an unresolved non-allowlisted hostname before transport', async () => {
    mockAssertTargetAllowed.mockResolvedValue({ hostname: 'none.example', addresses: [], allowlisted: false, bareIp: false });
    await expect(fetchT('https://none.example/')).rejects.toThrow(/could not be resolved/i);
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('dispatcher lookup supports all=true, IPv6 family and ENOTFOUND', async () => {
    await fetchT('https://public.example/', { redirect: 'manual' });
    expect(capturedConnect?.lookup).toEqual(expect.any(Function));

    mockResolveAddresses.mockResolvedValueOnce(['2001:4860:4860::8888', '93.184.216.34']);
    const all = await new Promise<unknown[]>((resolve, reject) => {
      capturedConnect!.lookup!('ignored', { all: true }, (err: Error | null, entries: unknown[]) => err ? reject(err) : resolve(entries));
    });
    expect(all).toEqual([
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);

    mockResolveAddresses.mockResolvedValueOnce([]);
    await expect(new Promise((resolve, reject) => {
      capturedConnect!.lookup!('ignored', {}, (err: Error | null, value: unknown) => err ? reject(err) : resolve(value));
    })).rejects.toThrow(/ENOTFOUND/);
  });

  it('composes caller abort + timeout without leaking into transport', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller-cancelled'));
    await expect(fetchT('https://public.example/', { signal: controller.signal })).rejects.toThrow('caller-cancelled');
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('uses the manual AbortSignal-any fallback when native any is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    try {
      const controller = new AbortController();
      mockAssertTargetAllowed.mockImplementation(() => new Promise(() => {}));
      const pending = fetchT('https://public.example/', { signal: controller.signal, timeoutMs: 5_000 });
      controller.abort(new Error('manual-any-abort'));
      await expect(pending).rejects.toThrow('manual-any-abort');
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
      else delete (AbortSignal as unknown as { any?: unknown }).any;
    }
  });
});
