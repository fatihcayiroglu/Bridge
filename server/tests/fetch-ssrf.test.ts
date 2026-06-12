// server/tests/fetch-ssrf.test.ts
// lib/fetch.ts SSRF koruması birim testleri

process.env.NODE_ENV = 'test';

// dns modülünü mock'la — gerçek DNS çözümlemesi yapmıyoruz
jest.mock('dns/promises', () => ({
  resolve:  jest.fn(),
  resolve6: jest.fn(),
}));

const mockUndiciFetch = jest.fn().mockResolvedValue({
  ok:   true,
  json: async () => ({}),
  text: async () => '',
  status: 200,
});

/** Agent mock — connect.lookup callback'ini yakalar (DNS rebinding testi için) */
let _capturedConnect: { lookup?: Function; servername?: string } | undefined;

jest.mock('undici', () => ({
  fetch: (...args: unknown[]) => mockUndiciFetch(...args),
  Agent: jest.fn().mockImplementation((opts: { connect?: typeof _capturedConnect }) => {
    _capturedConnect = opts?.connect;
    return { __tag: 'mock-agent' };
  }),
}));

import dns from 'dns/promises';

import { fetchT, isPrivateIP, SSRFError } from '../lib/fetch';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SSRF_ALLOWLIST;
  _capturedConnect = undefined;
  mockUndiciFetch.mockImplementation(async (_url, options) => {
    const dispatcher = options?.dispatcher as { __tag?: string } | undefined;
    if (dispatcher?.__tag === 'mock-agent' && _capturedConnect?.lookup) {
      await new Promise<void>((resolve, reject) => {
        _capturedConnect!.lookup!('example.com', {}, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    return {
      ok: true,
      json: async () => ({}),
      text: async () => '',
      status: 200,
    };
  });
});

// ── isPrivateIP birim testleri ────────────────────────────────
describe('isPrivateIP', () => {
  const privateIPs = [
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.255',
    '127.0.0.1', '127.0.0.2',
    '169.254.0.1', '169.254.169.254',   // AWS metadata
    '0.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1', 'fd00::1',
    '::ffff:192.168.1.1',
  ];

  const publicIPs = [
    '1.1.1.1', '8.8.8.8', '93.184.216.34',
    '2001:4860:4860::8888',
  ];

  test.each(privateIPs)('isPrivateIP(%s) → true', ip => {
    expect(isPrivateIP(ip)).toBe(true);
  });

  test.each(publicIPs)('isPrivateIP(%s) → false', ip => {
    expect(isPrivateIP(ip)).toBe(false);
  });
});

// ── fetchT SSRF engelleme ─────────────────────────────────────
describe('fetchT SSRF protection', () => {
  test('private IP hostname reddedilir', async () => {
    dns.resolve.mockResolvedValue(['10.0.0.1']);
    await expect(fetchT('http://internal.example.com/')).rejects.toThrow(SSRFError);
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  test('loopback IP reddedilir', async () => {
    dns.resolve.mockResolvedValue(['127.0.0.1']);
    await expect(fetchT('http://localhost/')).rejects.toThrow(SSRFError);
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  test('AWS metadata endpoint reddedilir (literal IP)', async () => {
    await expect(fetchT('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(SSRFError);
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  test('IPv6 loopback literal reddedilir', async () => {
    await expect(fetchT('http://[::1]/')).rejects.toThrow(SSRFError);
  });

  test('public IP geçer', async () => {
    dns.resolve.mockResolvedValue(['93.184.216.34']);
    await expect(fetchT('https://example.com/')).resolves.toBeDefined();
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  test('DNS birden fazla IP döndürürdü private varsa reddedilir', async () => {
    dns.resolve.mockResolvedValue(['8.8.8.8', '10.0.0.1']);
    await expect(fetchT('https://tricky.example.com/')).rejects.toThrow(SSRFError);
  });

  test('skipSsrfCheck=true geçer (internal servisler için)', async () => {
    await expect(
      fetchT('http://localhost/', { skipSsrfCheck: true })
    ).resolves.toBeDefined();
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  test('SSRF_ALLOWLIST whitelist bypass çalışır', async () => {
    process.env.SSRF_ALLOWLIST = 'idp.internal.corp';
    dns.resolve.mockResolvedValue(['10.20.30.40']); // private — ama allowlist'te
    await expect(fetchT('https://idp.internal.corp/token')).resolves.toBeDefined();
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  test('file:// protokolü reddedilir', async () => {
    await expect(fetchT('file:///etc/passwd')).rejects.toThrow();
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  test('DNS çözümlenemezse istek geçer (DNS timeout senaryosu)', async () => {
    dns.resolve.mockRejectedValue(new Error('ENOTFOUND'));
    dns.resolve6.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(fetchT('https://nonexistent.example.com/')).resolves.toBeDefined();
  });

  test('DNS rebinding: ilk çözüm public, bağlantı anında private → reddedilir', async () => {
    dns.resolve
      .mockResolvedValueOnce(['93.184.216.34'])  // pre-check
      .mockResolvedValueOnce(['127.0.0.1']);       // connect-time re-check

    await expect(fetchT('https://rebind.example.com/')).rejects.toThrow(SSRFError);
  });

  test('hostname URL için pinned dispatcher geçirilir', async () => {
    dns.resolve.mockResolvedValue(['93.184.216.34']);
    await fetchT('https://example.com/');
    const opts = mockUndiciFetch.mock.calls[0][1];
    expect(opts.dispatcher).toBeDefined();
  });
});
