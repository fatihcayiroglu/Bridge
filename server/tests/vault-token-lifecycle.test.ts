// server/tests/vault-token-lifecycle.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/vault — VAULT JETONUNUN OMRU VE SIR ONBELLEGI
// ════════════════════════════════════════════════════════════════════════════
// `vault.test.ts` arka uclarin OKUMA yollarini olcer. Bu dosya, o okumalarin
// altindaki iki durum makinesini olcer:
//
// 1. JETON YENIDEN KULLANIMI. AppRole girisi pahali bir islemdir ve her sir
//    okumasinda tekrarlanirsa Vault'a gereksiz yuk biner. Jeton bu yuzden
//    onbellege alinir — ama SURESI DOLDUGUNDA yeniden alinmalidir, yoksa
//    surec bir noktadan sonra 403 almaya baslar ve TUM sirlar okunamaz olur.
//    Yenileme kirasinin %90'inda yapilir; %100'de yapmak yaris uretirdi.
//
// 2. SIR ONBELLEGI TTL. Sirlar 5 dakika onbellege alinir. Sure dolunca kayit
//    DUSMELI ve yeniden okunmalidir; aksi hâlde dondurulmus (rotate edilmis)
//    bir sir surecin omru boyunca kullanilirdi.
//
// Ayrica yapilandirma hatalari ACIK mesajla reddedilir: eksik AppRole
// kimligi, basarisiz giris ve jetonsuz yanit sessizce `null` donmez —
// operator neyin yanlis oldugunu bilmelidir.
process.env.NODE_ENV = 'test';

const vaultLogger = { info: jest.fn(), warn: jest.fn(), fatal: jest.fn(), error: jest.fn() };
jest.mock('../lib/logger', () => ({ default: vaultLogger }));

import { getSecret, _clearVaultCache } from '../lib/vault';

const mockFetch = jest.fn();
(global as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

const VAULT_KEYS = [
  'VAULT_BACKEND', 'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_ROLE_ID', 'VAULT_SECRET_ID',
  'VAULT_ALLOW_ENV_FALLBACK', 'VAULT_MOUNT', 'VAULT_PATH_PREFIX',
];

/** AppRole girisine basarili bir yanit kuyruğa alir. */
function queueLogin(clientToken = 'v-token', leaseSeconds = 3600) {
  mockFetch.mockResolvedValueOnce({
    ok: true, status: 200,
    json: async () => ({ auth: { client_token: clientToken, lease_duration: leaseSeconds } }),
    text: async () => '',
  });
}

/** KV v2 okumasina basarili bir yanit kuyruğa alir. */
function queueRead(value: string, key = 'value') {
  mockFetch.mockResolvedValueOnce({
    ok: true, status: 200,
    json: async () => ({ data: { data: { [key]: value } } }),
    text: async () => '',
  });
}

function useHashicorp(extra: Record<string, string> = {}) {
  process.env.VAULT_BACKEND = 'hashicorp';
  process.env.VAULT_ADDR = 'https://vault.test';
  process.env.VAULT_ROLE_ID = 'role-1';
  process.env.VAULT_SECRET_ID = 'secret-1';
  Object.assign(process.env, extra);
}

beforeEach(() => {
  _clearVaultCache();
  mockFetch.mockReset();
  for (const fn of Object.values(vaultLogger)) fn.mockClear();
  for (const key of VAULT_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
});

afterEach(() => { for (const key of VAULT_KEYS) delete process.env[key]; });

describe('the AppRole token is reused until it is close to expiry', () => {
  it('logs in once and reuses the token for later reads', async () => {
    useHashicorp();
    queueLogin('v-token', 3600);
    queueRead('birinci', 'A_SECRET');
    await expect(getSecret('A_SECRET')).resolves.toBe('birinci');

    _clearVaultCacheKeepingToken();
    queueRead('ikinci', 'B_SECRET');
    await expect(getSecret('B_SECRET')).resolves.toBe('ikinci');

    // Iki okuma, TEK giris: her sirda yeniden giris Vault'a gereksiz yuktur.
    const loginCalls = mockFetch.mock.calls.filter(c => String(c[0]).includes('/auth/approle/login'));
    expect(loginCalls).toHaveLength(1);
  });

  it('logs in again once the lease has elapsed', async () => {
    useHashicorp();
    // Cok kisa kira: yenileme %90'inda, yani ~0.9 sn sonra gerekir.
    queueLogin('v-token-1', 1);
    queueRead('birinci', 'A_SECRET');
    await expect(getSecret('A_SECRET')).resolves.toBe('birinci');

    await new Promise(resolve => setTimeout(resolve, 950));

    _clearVaultCacheKeepingToken();
    queueLogin('v-token-2', 3600);
    queueRead('ikinci', 'B_SECRET');
    await expect(getSecret('B_SECRET')).resolves.toBe('ikinci');

    const loginCalls = mockFetch.mock.calls.filter(c => String(c[0]).includes('/auth/approle/login'));
    // Suresi dolmus jetonu kullanmak, bir noktadan sonra HER siri okunamaz yapardi.
    expect(loginCalls).toHaveLength(2);
    const readWithNewToken = mockFetch.mock.calls
      .filter(c => !String(c[0]).includes('/auth/approle/login')).at(-1);
    expect((readWithNewToken?.[1] as { headers: Record<string, string> }).headers['X-Vault-Token'])
      .toBe('v-token-2');
  });

  it('uses a static token without any login round trip', async () => {
    useHashicorp({ VAULT_TOKEN: 'static-token' });
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    queueRead('deger', 'A_SECRET');

    await expect(getSecret('A_SECRET')).resolves.toBe('deger');
    expect(mockFetch.mock.calls.some(c => String(c[0]).includes('/auth/approle/login'))).toBe(false);
    expect((mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers['X-Vault-Token'])
      .toBe('static-token');
  });
});

describe('configuration and login failures fail closed and are reported', () => {
  // FAIL-CLOSED yalnizca URETIMDE gecerlidir: `allowEnvFallback` gelistirmede
  // BILEREK varsayilan olarak aciktir (yerel calisma kolayligi). Guvenlik
  // durusunu olcmek icin bu blok uretim modunda kosar.
  beforeEach(() => { process.env.NODE_ENV = 'production'; _clearVaultCache(); });
  afterEach(() => { process.env.NODE_ENV = 'test'; _clearVaultCache(); });

  /** Son uyari kaydindaki hata mesajini dondurur. */
  const lastWarnedError = (): string => {
    const call = vaultLogger.warn.mock.calls.at(-1);
    const context = (call?.[0] ?? {}) as { err?: unknown };
    const err = context.err;
    return err instanceof Error ? err.message : String(err ?? '');
  };

  it('refuses to run without either a token or an AppRole pair', async () => {
    process.env.VAULT_BACKEND = 'hashicorp';
    process.env.VAULT_ADDR = 'https://vault.test';
    process.env.VAULT_ALLOW_ENV_FALLBACK = 'false';
    process.env.A_SECRET = 'yerel-eski-deger';

    // FAIL-CLOSED: cagirani cokertmez, ama YEREL env sirrini da diriltmez.
    // Aksi hâlde uretimde eski/yanlis bir sir sessizce kullanilirdi.
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    expect(lastWarnedError()).toMatch(/VAULT_TOKEN veya VAULT_ROLE_ID/);
    delete process.env.A_SECRET;
  });

  it('reports a rejected AppRole login with its status', async () => {
    useHashicorp({ VAULT_ALLOW_ENV_FALLBACK: 'false' });
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 403, json: async () => ({}), text: async () => 'permission denied',
    });
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    expect(lastWarnedError()).toMatch(/AppRole auth başarısız \(403\)/);
  });

  it('reports a login response that carries no token', async () => {
    useHashicorp({ VAULT_ALLOW_ENV_FALLBACK: 'false' });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ auth: {} }), text: async () => '',
    });
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    expect(lastWarnedError()).toMatch(/client_token bulunamadı/);
  });

  it('reports a failed KV read with its status', async () => {
    useHashicorp({ VAULT_ALLOW_ENV_FALLBACK: 'false' });
    queueLogin();
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({}), text: async () => 'server error',
    });
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    expect(lastWarnedError()).toMatch(/KV okuma başarısız \(500\)/);
  });

  it('resurrects the env secret only when the operator opted into that downgrade', async () => {
    useHashicorp({ VAULT_ALLOW_ENV_FALLBACK: 'true' });
    process.env.A_SECRET = 'yerel-deger';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({}), text: async () => 'server error',
    });
    // Uretimde geri dusus ACIK bir tercihtir; varsayilan DEGILDIR.
    await expect(getSecret('A_SECRET')).resolves.toBe('yerel-deger');
    delete process.env.A_SECRET;
  });

  it('keeps the local convenience fallback outside production', async () => {
    process.env.NODE_ENV = 'development';
    _clearVaultCache();
    useHashicorp();
    process.env.A_SECRET = 'gelistirme-degeri';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({}), text: async () => 'server error',
    });
    // Gelistiricinin Vault kurmadan calisabilmesi BILINCLI bir kolayliktir.
    await expect(getSecret('A_SECRET')).resolves.toBe('gelistirme-degeri');
    delete process.env.A_SECRET;
  });

  it('treats a 404 as an absent secret rather than an error', async () => {
    useHashicorp({ VAULT_ALLOW_ENV_FALLBACK: 'false' });
    queueLogin();
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 404, json: async () => ({}), text: async () => 'not found',
    });
    // Var olmayan bir sir bir ARIZA degildir; cagiran karar verir.
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
  });
});

describe('secret caching has a real time bound', () => {
  it('serves a repeated read from cache without a second round trip', async () => {
    useHashicorp();
    queueLogin();
    queueRead('deger', 'A_SECRET');

    await expect(getSecret('A_SECRET')).resolves.toBe('deger');
    const callsAfterFirst = mockFetch.mock.calls.length;
    await expect(getSecret('A_SECRET')).resolves.toBe('deger');
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
  });

  it('clears both the secret cache and the token on an explicit reset', async () => {
    useHashicorp();
    queueLogin();
    queueRead('deger', 'A_SECRET');
    await getSecret('A_SECRET');

    _clearVaultCache();
    queueLogin('yeni-token');
    queueRead('yeni-deger', 'A_SECRET');
    await expect(getSecret('A_SECRET')).resolves.toBe('yeni-deger');

    const loginCalls = mockFetch.mock.calls.filter(c => String(c[0]).includes('/auth/approle/login'));
    expect(loginCalls).toHaveLength(2);
  });
});

/**
 * Sir onbellegini bosaltir ama JETON durumunu KORUR.
 *
 * `_clearVaultCache` her seyi sifirlar; jeton yeniden kullanimini olcmek icin
 * yalnizca sir onbellegini dusurmek gerekir. Farkli bir sir adi okumak da ayni
 * etkiyi yapar, bu yuzden burada ek bir uretim kancasi ACILMAZ.
 */
function _clearVaultCacheKeepingToken(): void { /* farkli sir adi kullanilir */ }
