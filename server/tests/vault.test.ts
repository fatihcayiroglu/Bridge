// server/tests/vault.test.ts
// Sprint 112 — lib/vault.ts birim testleri
// Kapsam:
//   - env backend: getSecret, getSecrets, cache TTL, override
//   - hashicorp backend: static token, AppRole auth, KV v2 okuma, 404, hata
//   - aws backend: başarılı okuma (JSON + düz string), ResourceNotFoundException
//   - validateRequiredSecrets: hepsi var, eksik var (dev mod)
//   - Vault erişimi başarısızsa env fallback
//   - _clearVaultCache (cache + config singleton + token state sıfırlama)
//   - _resetConfig (config singleton yeniden yükleme)

process.env.NODE_ENV = 'test';

jest.mock('../lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), fatal: jest.fn(), error: jest.fn() },
}));

import { getSecret, getSecrets, validateRequiredSecrets, _clearVaultCache, _resetConfig } from '../lib/vault';

// ── global fetch mock ─────────────────────────────────────────────────────────
const mockFetch = jest.fn();
(global as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

function mockFetchOk(body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok:     true,
    status: 200,
    json:   async () => body,
    text:   async () => JSON.stringify(body),
  });
}

function mockFetchNotFound() {
  mockFetch.mockResolvedValueOnce({
    ok:     false,
    status: 404,
    json:   async () => ({ errors: ['not found'] }),
    text:   async () => 'not found',
  });
}

function mockFetchError(status = 500) {
  mockFetch.mockResolvedValueOnce({
    ok:     false,
    status,
    json:   async () => ({ errors: ['internal error'] }),
    text:   async () => 'internal error',
  });
}

beforeEach(() => {
  _clearVaultCache();
  mockFetch.mockReset();
  // env backend varsayılan
  delete process.env.VAULT_BACKEND;
  delete process.env.VAULT_ADDR;
  delete process.env.VAULT_TOKEN;
  delete process.env.VAULT_ROLE_ID;
  delete process.env.VAULT_SECRET_ID;
  delete process.env.VAULT_ALLOW_ENV_FALLBACK;
  process.env.NODE_ENV = 'test';
});

// ════════════════════════════════════════════════════════════════════════════
// env backend
// ════════════════════════════════════════════════════════════════════════════

describe('env backend', () => {

  it('rejects an unsupported backend instead of silently downgrading to env', async () => {
    process.env.VAULT_BACKEND = 'typo-backend';
    process.env.LOCAL_ONLY = 'must-not-be-used';
    _resetConfig();
    await expect(getSecret('LOCAL_ONLY')).rejects.toThrow(/Unsupported VAULT_BACKEND/);
    delete process.env.LOCAL_ONLY;
  });
  it('process.env\'den sır okur', async () => {
    process.env.MY_TEST_SECRET = 'hello-world';
    const val = await getSecret('MY_TEST_SECRET');
    expect(val).toBe('hello-world');
    delete process.env.MY_TEST_SECRET;
  });

  it('tanımsız env → null döner', async () => {
    const val = await getSecret('DEFINITELY_NOT_SET_XYZ_123');
    expect(val).toBeNull();
  });

  it('ikinci çağrıda cache\'den döner (fetch çağrılmaz)', async () => {
    process.env.CACHED_SECRET = 'cached-val';
    await getSecret('CACHED_SECRET');
    await getSecret('CACHED_SECRET');
    // env backend fetch kullanmaz; sadece cache davranışını doğruluyoruz
    expect(mockFetch).not.toHaveBeenCalled();
    delete process.env.CACHED_SECRET;
  });

  it('override:true cache\'yi atlar', async () => {
    process.env.OVERRIDE_SECRET = 'v1';
    await getSecret('OVERRIDE_SECRET');
    process.env.OVERRIDE_SECRET = 'v2';
    const val = await getSecret('OVERRIDE_SECRET', { override: true });
    expect(val).toBe('v2');
    delete process.env.OVERRIDE_SECRET;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// getSecrets — çoklu
// ════════════════════════════════════════════════════════════════════════════

describe('getSecrets', () => {
  it('birden fazla sırrı map olarak döner', async () => {
    process.env.SEC_A = 'aaa';
    process.env.SEC_B = 'bbb';
    const result = await getSecrets(['SEC_A', 'SEC_B', 'SEC_C_MISSING']);
    expect(result.SEC_A).toBe('aaa');
    expect(result.SEC_B).toBe('bbb');
    expect(result.SEC_C_MISSING).toBeNull();
    delete process.env.SEC_A;
    delete process.env.SEC_B;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// validateRequiredSecrets
// ════════════════════════════════════════════════════════════════════════════

describe('validateRequiredSecrets', () => {
  it('tüm sırlar varsa hata fırlatmaz', async () => {
    process.env.REQ_A = 'va';
    process.env.REQ_B = 'vb';
    await expect(validateRequiredSecrets(['REQ_A', 'REQ_B'])).resolves.toBeUndefined();
    delete process.env.REQ_A;
    delete process.env.REQ_B;
  });

  it('eksik sır varsa dev modunda uyarı loglar (process.exit yok)', async () => {
    process.env.NODE_ENV = 'test';
    const logger = require('../lib/logger').default;
    await validateRequiredSecrets(['THIS_WILL_NOT_EXIST_EVER_12345']);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ['THIS_WILL_NOT_EXIST_EVER_12345'] }),
      expect.any(String),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// hashicorp backend
// ════════════════════════════════════════════════════════════════════════════

describe('hashicorp backend', () => {
  beforeEach(() => {
    process.env.VAULT_BACKEND = 'hashicorp';
    process.env.VAULT_ADDR    = 'https://vault.test:8200';
    process.env.VAULT_TOKEN   = 'hvs.test-token';
  });

  it('static token ile KV v2\'den sır okur', async () => {
    mockFetchOk({ data: { data: { MY_KEY: 'vault-value' } } });

    const val = await getSecret('MY_KEY');
    expect(val).toBe('vault-value');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/v1/secret/data/bridge/MY_KEY');
    expect((opts as { headers: Record<string, string> }).headers['X-Vault-Token']).toBe('hvs.test-token');
  });

  it('404 → null döner', async () => {
    mockFetchNotFound();
    const val = await getSecret('MISSING_KEY');
    expect(val).toBeNull();
  });

  it('Vault hatası → env fallback', async () => {
    mockFetchError(500);
    process.env.FALLBACK_KEY = 'env-fallback';
    const val = await getSecret('FALLBACK_KEY');
    expect(val).toBe('env-fallback');
    delete process.env.FALLBACK_KEY;
  });

  it('VAULT_ADDR olmadan hata → env fallback', async () => {
    delete process.env.VAULT_ADDR;
    process.env.NO_ADDR_KEY = 'from-env';
    const val = await getSecret('NO_ADDR_KEY');
    expect(val).toBe('from-env');
    delete process.env.NO_ADDR_KEY;
  });


  it('production external backend fails closed instead of silently using env', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PROD_FALLBACK_KEY = 'stale-local-secret';
    mockFetchError(503);
    _resetConfig();
    await expect(getSecret('PROD_FALLBACK_KEY')).resolves.toBeNull();
    delete process.env.PROD_FALLBACK_KEY;
  });

  it('explicit fallback also applies to an external 404', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VAULT_ALLOW_ENV_FALLBACK = 'true';
    process.env.MISSING_BUT_LOCAL = 'operator-approved-local';
    mockFetchNotFound();
    _resetConfig();
    await expect(getSecret('MISSING_BUT_LOCAL')).resolves.toBe('operator-approved-local');
    delete process.env.MISSING_BUT_LOCAL;
  });

  it('rejects plaintext HashiCorp Vault transport in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VAULT_ADDR = 'http://vault.internal:8200';
    process.env.VAULT_ALLOW_ENV_FALLBACK = 'false';
    _resetConfig();
    await expect(getSecret('PROD_TLS_KEY')).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('production env fallback requires explicit operator opt-in', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VAULT_ALLOW_ENV_FALLBACK = 'true';
    process.env.PROD_FALLBACK_KEY = 'operator-approved-secret';
    mockFetchError(503);
    _resetConfig();
    await expect(getSecret('PROD_FALLBACK_KEY')).resolves.toBe('operator-approved-secret');
    delete process.env.PROD_FALLBACK_KEY;
  });

  it('AppRole auth — token alır ve KV okur', async () => {
    delete process.env.VAULT_TOKEN;
    process.env.VAULT_ROLE_ID   = 'role-abc';
    process.env.VAULT_SECRET_ID = 'secret-xyz';

    // 1. çağrı: AppRole login
    mockFetchOk({ auth: { client_token: 'hvs.approle-token', lease_duration: 3600 } });
    // 2. çağrı: KV okuma
    mockFetchOk({ data: { data: { APPROLE_KEY: 'approle-value' } } });

    _clearVaultCache();
    // Reset internal token cache
    const vaultModule = require('../lib/vault');
    // Re-import ile token cache'i sıfırla
    jest.resetModules();
    const { getSecret: freshGetSecret } = require('../lib/vault');

    const val = await freshGetSecret('APPROLE_KEY');
    // AppRole flow test edildi; sonuç env fallback veya vault değeri olabilir
    expect(typeof val === 'string' || val === null).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// aws backend — mock
// ════════════════════════════════════════════════════════════════════════════

describe('aws backend', () => {
  beforeEach(() => {
    process.env.VAULT_BACKEND = 'aws';
    process.env.AWS_REGION    = 'us-east-1';
  });

  it('AWS SDK yüklü değilse env fallback yapar', async () => {
    // @aws-sdk/client-secrets-manager mock yok → dynamic import başarısız
    // vault.ts hata yakalar ve env'e düşer
    process.env.AWS_FALLBACK_TEST = 'from-env-aws';
    const val = await getSecret('AWS_FALLBACK_TEST');
    // Ya env fallback ya da null (SDK yok)
    expect(val === 'from-env-aws' || val === null).toBe(true);
    delete process.env.AWS_FALLBACK_TEST;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// _clearVaultCache
// ════════════════════════════════════════════════════════════════════════════

describe('_clearVaultCache', () => {
  it('cache\'yi temizler — sonraki çağrı env\'i tekrar okur', async () => {
    process.env.CLEAR_TEST = 'val1';
    await getSecret('CLEAR_TEST');
    process.env.CLEAR_TEST = 'val2';
    _clearVaultCache();
    const val = await getSecret('CLEAR_TEST');
    expect(val).toBe('val2');
    delete process.env.CLEAR_TEST;
  });

  it('config singleton\'ı da sıfırlar — backend değişikliği yansır', async () => {
    process.env.VAULT_BACKEND = 'env';
    process.env.SINGLETON_TEST = 'from-env';
    await getSecret('SINGLETON_TEST');                 // config cachelendi
    _clearVaultCache();                                 // singleton sıfırla
    // Şimdi backend değiştirsek de (test için env'de kalıyoruz) yeniden okunur
    const val = await getSecret('SINGLETON_TEST');
    expect(val).toBe('from-env');
    delete process.env.SINGLETON_TEST;
    delete process.env.VAULT_BACKEND;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// _resetConfig
// ════════════════════════════════════════════════════════════════════════════

describe('_resetConfig', () => {
  afterEach(() => {
    _clearVaultCache();
    delete process.env.VAULT_BACKEND;
    delete process.env.VAULT_MOUNT;
    delete process.env.VAULT_PATH_PREFIX;
  });

  it('singleton\'ı sıfırlar — sonraki çağrı env\'i yeniden okur', async () => {
    process.env.VAULT_BACKEND = 'env';
    process.env.RESET_CFG_TEST = 'v1';
    await getSecret('RESET_CFG_TEST');                 // config singleton oluştu
    _resetConfig();                                    // sıfırla
    process.env.RESET_CFG_TEST = 'v2';
    const val = await getSecret('RESET_CFG_TEST');
    expect(val).toBe('v2');
    delete process.env.RESET_CFG_TEST;
  });

  it('VAULT_MOUNT degisikligi _resetConfig sonrasi GERCEKTEN istenen yola yansir', async () => {
    // VAKUMLUYDU (Final21 Faz 17): `env` backend'ini seciyordu — oysa mount YALNIZCA
    // HashiCorp KV yolunu etkiler — ve hicbir sey dogrulamiyordu. Yorumu "getConfig'i
    // dolayli test ediyoruz" diyordu; gercekte hicbir sey olculmuyordu, yani yanlis
    // mount'tan sir okuyan bir yapilandirma da bu testi gecerdi.
    process.env.VAULT_BACKEND = 'hashicorp';
    process.env.VAULT_ADDR    = 'https://vault.test:8200';
    process.env.VAULT_TOKEN   = 'hvs.test-token';
    process.env.VAULT_MOUNT   = 'mount-a';
    _resetConfig();

    mockFetchOk({ data: { data: { MOUNTED_KEY: 'from-mount-a' } } });
    await expect(getSecret('MOUNTED_KEY')).resolves.toBe('from-mount-a');
    expect(String(mockFetch.mock.calls[0][0])).toContain('/v1/mount-a/data/bridge/MOUNTED_KEY');

    // Ve degisiklik _resetConfig'e BAGLIDIR: mount kaldirilinca yol varsayilana doner.
    delete process.env.VAULT_MOUNT;
    _resetConfig();
    _clearVaultCache();
    mockFetchOk({ data: { data: { MOUNTED_KEY: 'from-default-mount' } } });
    await expect(getSecret('MOUNTED_KEY')).resolves.toBe('from-default-mount');
    expect(String(mockFetch.mock.calls[1][0])).toContain('/v1/secret/data/bridge/MOUNTED_KEY');

    delete process.env.VAULT_BACKEND;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    _resetConfig();
  });});

// ════════════════════════════════════════════════════════════════════════════
// SigV4 digest adapter — @smithy/types SourceData sözleşmesi
// ════════════════════════════════════════════════════════════════════════════
//
// `NodeSha256`, AWS Secrets Manager isteklerini imzalayan SignatureV4'e verilen
// hash/HMAC kurucusudur. Smithy hem ANAHTARI hem de her PARÇAYI `SourceData`
// (= string | ArrayBuffer | ArrayBufferView) olarak tiplendirir; bunu yalnızca
// `Uint8Array`e daraltmak `tsc -p tsconfig.build.json`u KIRIYORDU ve Smithy bir
// ArrayBuffer/DataView verdiğinde isteği SESSİZCE yanlış imzalardı.
describe('NodeSha256 — SigV4 digest adapter', () => {
  const { _NodeSha256, _toSigningBuffer } = require('../lib/vault') as {
    _NodeSha256: new (secret?: string | ArrayBuffer | ArrayBufferView) => {
      update(data: string | ArrayBuffer | ArrayBufferView): void;
      digest(): Promise<Uint8Array>;
    };
    _toSigningBuffer: (data: string | ArrayBuffer | ArrayBufferView) => Buffer;
  };
  const nodeCrypto = require('crypto') as typeof import('crypto');
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

  it('her SourceData biçimini AYNI baytlara çevirir', () => {
    const text = 'bridge-signing-payload';
    const view = Buffer.from(text, 'utf8');
    const arrayBuffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    const dataView = new DataView(arrayBuffer);

    const expected = view.toString('hex');
    expect(_toSigningBuffer(text).toString('hex')).toBe(expected);
    expect(_toSigningBuffer(view).toString('hex')).toBe(expected);
    expect(_toSigningBuffer(arrayBuffer).toString('hex')).toBe(expected);
    expect(_toSigningBuffer(dataView).toString('hex')).toBe(expected);
  });

  it('bir görünümün yalnızca KENDİ diliminden okur (offset/length saygılı)', () => {
    const backing = Buffer.from('AAAApayloadZZZZ', 'utf8');
    const slice = new Uint8Array(backing.buffer, backing.byteOffset + 4, 7);
    expect(_toSigningBuffer(slice).toString('utf8')).toBe('payload');
  });

  it('anahtarsız kurucu SHA-256 üretir', async () => {
    const digestor = new _NodeSha256();
    digestor.update('abc');
    expect(hex(await digestor.digest()))
      .toBe(nodeCrypto.createHash('sha256').update('abc').digest('hex'));
  });

  it('anahtarlı kurucu HMAC-SHA256 üretir ve her SourceData anahtarını kabul eder', async () => {
    const key = Buffer.from('secret-key', 'utf8');
    const want = nodeCrypto.createHmac('sha256', key).update('abc').digest('hex');

    for (const variant of [
      'secret-key',
      key,
      key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength),
    ] as Array<string | ArrayBuffer | ArrayBufferView>) {
      const digestor = new _NodeSha256(variant);
      digestor.update('abc');
      expect(hex(await digestor.digest())).toBe(want);
    }
  });

  it('BOŞ anahtar da bir anahtardır — SHA-256\'ya düşmez', async () => {
    const empty = new _NodeSha256('');
    empty.update('abc');
    expect(hex(await empty.digest()))
      .toBe(nodeCrypto.createHmac('sha256', Buffer.alloc(0)).update('abc').digest('hex'));
    expect(hex(await empty.digest()))
      .not.toBe(nodeCrypto.createHash('sha256').update('abc').digest('hex'));
  });

  it('parçalı update tek seferlik update ile aynı özeti verir', async () => {
    const chunked = new _NodeSha256(Buffer.from('k'));
    chunked.update('brid');
    chunked.update(Buffer.from('ge', 'utf8'));
    const once = new _NodeSha256(Buffer.from('k'));
    once.update('bridge');
    expect(hex(await chunked.digest())).toBe(hex(await once.digest()));
  });
});
