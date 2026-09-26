// server/tests/fetch-ssrf.test.ts
// lib/fetch.ts SSRF koruması birim testleri

process.env.NODE_ENV = 'test';

// dns modülünü mock'la — gerçek DNS çözümlemesi yapmıyoruz
// `lib/fetch.ts` artik `resolve4` + `resolve6` kullaniyor ve ikisi de
// bos donerse SISTEM cozumleyicisine (`dns.lookup`) dusuyor. Eski mock
// yalnizca `resolve`/`resolve6` sagladigi icin yeni cagrilar `undefined`
// olup patliyordu — mock, modulun GERCEK bagimliliklarini yansitmalidir.
//
// NEDEN `lookup` YEDEGI EKLENDI (urun tarafinda): `dns.resolve*` yalnizca
// DNS'e sorar; `/etc/hosts` ve isletim sistemi cozumleyicisini gormez.
// undici ise baglanirken sistem cozumleyicisini kullanir. Bu ayrisma bir
// FAIL-OPEN uretiyordu: `resolve` bos donunce SSRF denetimi atlaniyor,
// undici ayni adi sistem uzerinden cozup ozel bir IP'ye baglanabiliyordu.
jest.mock('dns/promises', () => ({
  resolve:  jest.fn(),
  resolve4: jest.fn<Promise<string[]>, [hostname: string]>(),
  resolve6: jest.fn<Promise<string[]>, [hostname: string]>(),
  lookup:   jest.fn<Promise<Array<{ address: string; family: number }>>, [hostname: string, options?: unknown]>(),
}));

/**
 * `dns.lookup` ikizi — URUN onu `{ all: true }` ile cagirir ve o bicim DIZI
 * dondurur (`lib/ssrfGuard.ts:208`, `lib/urlSafety.ts:126`).
 *
 * `jest.mocked(dns.lookup)` asiri yuklenmis imzanin TEK ADRESLI dalini seciyor
 * ve dizi degeri reddediyordu. Erisim burada, TEK YERDE ve aciklamali biçimde
 * dogru dala baglanir; testler onu dogrudan kullanir.
 */
type LookupMock = jest.Mock<
  Promise<Array<{ address: string; family: number }>>,
  [hostname: string, options?: unknown]
>;
// FONKSIYON olarak yazilir, sabit olarak DEGIL: `jest.mock(...)` cagrilari
// ithallerin UZERINE cikarilir (hoisting) ve modul ust duzeyinde `dns` henuz
// baglanmamis olur ("Cannot access 'promises_1' before initialization").
const lookupMock = (): LookupMock => dns.lookup as unknown as LookupMock;

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
  // Testler A kaydini (`resolve4`) kurar; digerleri sonucu KIRLETMEMELI.
  (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('no AAAA'));
  (dns.lookup   as jest.Mock).mockRejectedValue(new Error('no lookup'));
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
    jest.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);
    await expect(fetchT('http://internal.example.com/')).rejects.toThrow(SSRFError);
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  test('loopback IP reddedilir', async () => {
    jest.mocked(dns.resolve4).mockResolvedValue(['127.0.0.1']);
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
    jest.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);
    await expect(fetchT('https://example.com/')).resolves.toBeDefined();
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  test('DNS birden fazla IP döndürürdü private varsa reddedilir', async () => {
    jest.mocked(dns.resolve4).mockResolvedValue(['8.8.8.8', '10.0.0.1']);
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
    jest.mocked(dns.resolve4).mockResolvedValue(['10.20.30.40']); // private — ama allowlist'te
    await expect(fetchT('https://idp.internal.corp/token')).resolves.toBeDefined();
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  test('file:// protokolü reddedilir', async () => {
    await expect(fetchT('file:///etc/passwd')).rejects.toThrow();
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  // ── DAVRANIS DEGISTI: FAIL-OPEN → FAIL-CLOSED ────────────────────────────
  // Bu test eskiden "DNS cozulemezse istek GECER" davranisini dogruluyordu.
  // O bilincli bir odundu (gecici DNS hatasi tum giden istekleri kirmasin)
  // ama guvenlik acisindan bir FAIL-OPEN idi: undici kendi resolver'ina
  // duser ve BIZIM dogrulamadigimiz bir adrese baglanabilirdi.
  //
  // Odun GEREKSIZDI: `resolveHostnameAddresses` zaten iki yol dener —
  // `dns.resolve4/6` ve sistem cozumleyicisi (`dns.lookup`, /etc/hosts
  // dahil). Ikisi birden bos donduyse ad gercekten cozulemiyordur ve istek
  // nasilsa basarisiz olurdu. Artik GUVENLI tarafta basarisiz olur.
  test('DNS hic cozulemezse istek REDDEDILIR (fail-closed)', async () => {
    jest.mocked(dns.resolve4).mockRejectedValue(new Error('ENOTFOUND'));
    jest.mocked(dns.resolve6).mockRejectedValue(new Error('ENOTFOUND'));
    lookupMock().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(fetchT('https://nonexistent.example.com/')).rejects.toThrow(SSRFError);
    // Dogrulanmamis hicbir hedefe baglanti DENENMEZ.
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  test('sistem cozumleyicisi cozerse istek GECER (/etc/hosts yolu korunur)', async () => {
    // Fail-closed, mesru sistem-cozumleyici yolunu KIRMAMALIDIR.
    jest.mocked(dns.resolve4).mockRejectedValue(new Error('ENOTFOUND'));
    jest.mocked(dns.resolve6).mockRejectedValue(new Error('ENOTFOUND'));
    lookupMock().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(fetchT('https://hosts-only.example.com/')).resolves.toBeDefined();
  });

  test('DNS çözümü askıda kalırsa uçtan uca timeout HTTP başlamadan da işler', async () => {
    jest.mocked(dns.resolve4).mockReturnValue(new Promise(() => {}));

    await expect(fetchT('https://hanging-dns.example.com/', { timeoutMs: 20 })).rejects.toThrow();
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  test('DNS rebinding: ilk çözüm public, bağlantı anında private → reddedilir', async () => {
    jest.mocked(dns.resolve4)
      .mockResolvedValueOnce(['93.184.216.34'])  // pre-check
      .mockResolvedValueOnce(['127.0.0.1']);       // connect-time re-check

    await expect(fetchT('https://rebind.example.com/')).rejects.toThrow(SSRFError);
  });

  test('hostname URL için pinned dispatcher geçirilir', async () => {
    jest.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);
    await fetchT('https://example.com/');
    const opts = mockUndiciFetch.mock.calls[0][1];
    expect(opts.dispatcher).toBeDefined();
  });
});
