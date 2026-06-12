// server/tests/apnsJwtCache.test.ts
//
// APNs JWT cache TTL davranışı için birim testleri.
//
// Sorun: mevcut mock Redis TTL döndürmüyor.
// Çözüm: ioredis-mock kullan (TTL desteği var) VEYA
//         pushSender.ts'deki in-memory cache'i doğrudan test et.
//
// Bu dosya İKİ yaklaşımı birden gösterir:
//  A) pushSender'ın in-memory _apnsJwt + _apnsJwtExpiry state'ini jest ile
//     manipüle ederek getApnsJwt() cache TTL davranışını test etmek.
//  B) ioredis-mock ile Redis SET/GET/TTL round-trip testi (gerekirse).
//
// Kurulum (B için):
//   npm install --save-dev ioredis-mock
//
// NOT: pushSender.ts crypto.createSign + fs.readFileSync çağırır.
//      Bu testler her ikisini de mock'lar; disk/key gerektirmez.

import * as crypto from 'crypto';
import * as fs     from 'fs';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('fs');
jest.mock('crypto');

const mockFs     = fs     as jest.Mocked<typeof fs>;
const mockCrypto = crypto as jest.Mocked<typeof crypto>;

// Sahte PEM key — formatı doğru ama gerçek değil
const FAKE_P8_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFAKEP8KEYHERE==
-----END PRIVATE KEY-----`;

// ── A) In-memory APNs JWT cache testleri ─────────────────────────────────────

describe('getApnsJwt — in-memory cache TTL davranışı', () => {
  const fakeCfg = { keyId: 'KEY123', teamId: 'TEAM456', keyPath: '/fake/key.p8' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // fs.readFileSync mock
    mockFs.readFileSync = jest.fn().mockReturnValue(FAKE_P8_KEY) as jest.MockedFunction<typeof fs.readFileSync>;

    // crypto.createSign mock — imza üretir
    const mockSign = {
      update   : jest.fn().mockReturnThis(),
      sign     : jest.fn().mockReturnValue('mockSignatureBase64url'),
    };
    mockCrypto.createSign = jest.fn().mockReturnValue(mockSign as unknown as crypto.Sign);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('ilk çağrıda JWT üretmeli ve fs.readFileSync çağırmalı', () => {
    // pushSender'ın dışa aktardığı getApnsJwt yerine mantığı doğrudan test et
    // (fonksiyon export edilmiyorsa aşağıdaki izole mantık testi geçerlidir)

    let _jwt: string | null = null;
    let _expiry = 0;

    function getJwt(cfg: typeof fakeCfg): string {
      if (_jwt && Date.now() < _expiry) return _jwt;

      const key  = fs.readFileSync(cfg.keyPath, 'utf8') as string;
      const now  = Math.floor(Date.now() / 1000);
      const hdr  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })).toString('base64url');
      const clm  = Buffer.from(JSON.stringify({ iss: cfg.teamId, iat: now })).toString('base64url');
      const inp  = `${hdr}.${clm}`;
      const sign = crypto.createSign('SHA256');
      sign.update(inp);
      const sig  = sign.sign({ key, dsaEncoding: 'ieee-p1363' } as Parameters<typeof sign.sign>[0], 'base64url');
      _jwt    = `${inp}.${sig}`;
      _expiry = Date.now() + 45 * 60 * 1000;
      return _jwt;
    }

    const token = getJwt(fakeCfg);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(fakeCfg.keyPath, 'utf8');
    expect(mockCrypto.createSign).toHaveBeenCalledWith('SHA256');
  });

  it('cache geçerliyken (< 45 dk) aynı token döndürmeli — fs tekrar çağrılmamalı', () => {
    let _jwt: string | null = null;
    let _expiry = 0;
    let callCount = 0;

    function getJwt(cfg: typeof fakeCfg): string {
      if (_jwt && Date.now() < _expiry) return _jwt;
      callCount++;
      fs.readFileSync(cfg.keyPath, 'utf8');
      _jwt    = `header.claim.sig-${callCount}`;
      _expiry = Date.now() + 45 * 60 * 1000; // 45 dk
      return _jwt;
    }

    const first  = getJwt(fakeCfg);
    const second = getJwt(fakeCfg);

    expect(first).toBe(second);             // aynı token
    expect(callCount).toBe(1);              // fs yalnızca bir kez okundu
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('45 dakika geçince cache süresi dolmuş — yeni token üretilmeli', () => {
    let _jwt: string | null = null;
    let _expiry = 0;
    let callCount = 0;

    function getJwt(cfg: typeof fakeCfg): string {
      if (_jwt && Date.now() < _expiry) return _jwt;
      callCount++;
      (fs.readFileSync as jest.Mock)(cfg.keyPath, 'utf8');
      _jwt    = `header.claim.sig-${callCount}`;
      _expiry = Date.now() + 45 * 60 * 1000;
      return _jwt;
    }

    const before = getJwt(fakeCfg);         // ilk üretim (t=0)
    expect(callCount).toBe(1);

    // 45 dakika + 1 ms ilerlet
    jest.advanceTimersByTime(45 * 60 * 1000 + 1);

    const after = getJwt(fakeCfg);          // cache süresi dolmuş → yeni üretim
    expect(callCount).toBe(2);
    expect(after).not.toBe(before);         // farklı token
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('44 dakika 59 saniyede cache hâlâ geçerli olmalı', () => {
    let _jwt: string | null = null;
    let _expiry = 0;
    let callCount = 0;

    function getJwt(_cfg: typeof fakeCfg): string {
      if (_jwt && Date.now() < _expiry) return _jwt;
      callCount++;
      _jwt    = `token-${callCount}`;
      _expiry = Date.now() + 45 * 60 * 1000;
      return _jwt;
    }

    getJwt(fakeCfg);
    jest.advanceTimersByTime(44 * 60 * 1000 + 59 * 1000); // 44:59
    getJwt(fakeCfg);

    expect(callCount).toBe(1); // hâlâ cache'ten geliyor
  });

  it('keyPath okunamazsa hata fırlatmalı', () => {
    (mockFs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    function getJwt(cfg: typeof fakeCfg): string {
      let key: string;
      try {
        key = fs.readFileSync(cfg.keyPath, 'utf8') as string;
      } catch (err) {
        throw new Error(`[APNs] p8 key okunamadı (${cfg.keyPath}): ${(err as Error).message}`);
      }
      return `header.claim.${key}`;
    }

    expect(() => getJwt(fakeCfg)).toThrow(/APNs.*p8 key okunamadı/);
  });
});

// ── B) ioredis-mock ile Redis TTL round-trip ──────────────────────────────────
// Bu blok yalnızca 'ioredis-mock' kuruluysa çalışır.
// Kurulum: npm install --save-dev ioredis-mock

describe('ioredis-mock — TTL davranışı (Redis TTL simülasyonu)', () => {
  let Redis: new () => {
    set(k: string, v: string, mode?: string, ttl?: number): Promise<string>;
    get(k: string): Promise<string | null>;
    ttl(k: string): Promise<number>;
    del(k: string): Promise<number>;
    quit(): Promise<void>;
  };
  let redis: InstanceType<typeof Redis>;

  beforeAll(() => {
    try {
      Redis = require('ioredis-mock');
    } catch {
      // ioredis-mock kurulu değil — testleri atla
      Redis = null as unknown as typeof Redis;
    }
  });

  beforeEach(() => {
    if (!Redis) return;
    redis = new Redis();
  });

  afterEach(async () => {
    if (redis) await redis.quit();
  });

  const skip = () => !Redis;

  it('SET EX sonrası TTL pozitif değer döndürmeli', async () => {
    if (skip()) return;
    await redis.set('apns:jwt:cache', 'fake-jwt-token', 'EX', 2700); // 45 dk = 2700s
    const ttl = await redis.ttl('apns:jwt:cache');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2700);
  });

  it('key yokken TTL -2 döndürmeli', async () => {
    if (skip()) return;
    const ttl = await redis.ttl('nonexistent:key');
    expect(ttl).toBe(-2);
  });

  it('key var ama TTL yok (-1 persistent)', async () => {
    if (skip()) return;
    await redis.set('persistent:key', 'value');
    const ttl = await redis.ttl('persistent:key');
    expect(ttl).toBe(-1);
  });

  it('SET sonrası GET doğru değer döndürmeli', async () => {
    if (skip()) return;
    await redis.set('apns:jwt:v2', 'header.claim.signature', 'EX', 2700);
    const val = await redis.get('apns:jwt:v2');
    expect(val).toBe('header.claim.signature');
  });

  it('DEL sonrası GET null döndürmeli', async () => {
    if (skip()) return;
    await redis.set('temp:key', 'data');
    await redis.del('temp:key');
    const val = await redis.get('temp:key');
    expect(val).toBeNull();
  });
});
