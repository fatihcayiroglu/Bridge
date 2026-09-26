// client/tests/webauthn-flows.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// PASSKEY AKISLARI — BASARI, IPTAL VE HER ARIZA YOLU
// ════════════════════════════════════════════════════════════════════════════
// `core/webauthn-svelte.ts` kabuktaki iki gorunur passkey dugmesinin kanonik
// sahibidir. Bu dosya davranisi olcer:
//
//   * ikili <-> base64url donusumu SUNUCU SOZLESMESINE uyuyor mu
//   * oturum KANONIK yoldan (auth-compat.startApp) kuruluyor mu
//   * her ariza yolunda kullaniciya ANLAMLI bir mesaj gidiyor mu
//   * hicbir yol arayuzu KALICI olarak asili birakmiyor mu
//
// ── EN ONEMLI IKI IDDIA ─────────────────────────────────────────────────────
// 1. Sunucu REDDETTIGINDE oturum KURULMAMALI. Aksi halde istemci, sunucunun
//    dogrulamadigi bir kimlikle oturum acardi — kimlik dogrulamanin tamamen
//    atlanmasi demektir.
// 2. Kullanici IPTAL ettiginde akis temiz bicimde sonlanmali; `false` donmeli
//    ve mesaj gosterilmeli. Sessiz yutma, dugmeye basip hicbir sey olmamasi
//    demektir — bu ozelligin duzeltmek icin var oldugu kusurun ta kendisi.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const authMsg: Array<{ msg: string; tur?: string }> = [];
const startAppCagrilari: Array<{ token: string; user: unknown }> = [];

vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => '' }));
vi.mock('../js/core/auth-compat.ts', () => ({
  showAuthMsg: (msg: string, tur?: string) => { authMsg.push({ msg, tur }); },
  startApp: async (token: string, user: unknown) => { startAppCagrilari.push({ token, user }); },
}));

const apiFetchCagrilari: Array<{ url: string; init?: RequestInit }> = [];
let apiFetchYanit: (url: string) => Response;
vi.mock('../js/core/api-fetch.ts', () => ({
  apiFetch: async (url: string, init?: RequestInit) => {
    apiFetchCagrilari.push({ url, init });
    return apiFetchYanit(url);
  },
}));

import {
  isSupported, isPlatformAuthenticatorAvailable,
  passkeyLogin, registerPasskey, listPasskeys, deletePasskey,
} from '../js/core/webauthn-svelte.ts';

// ── Yardimcilar ─────────────────────────────────────────────────────────────
const yanit = (durum: number, govde: unknown): Response =>
  ({ ok: durum >= 200 && durum < 300, status: durum, json: async () => govde } as Response);

const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const buf = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b.buffer;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const KAYIT_SECENEK = {
  challenge: b64u('meydan-okuma'),
  rp: { id: 'localhost', name: 'Bridge' },
  user: { id: b64u('kullanici-1'), name: 'ali', displayName: 'Ali' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 60000,
  attestation: 'none',
  authenticatorSelection: { residentKey: 'preferred' },
  excludeCredentials: [{ type: 'public-key', id: b64u('eski-kimlik'), transports: ['usb'] }],
};
const GIRIS_SECENEK = {
  challenge: b64u('giris-meydan'),
  rpId: 'localhost',
  timeout: 60000,
  userVerification: 'preferred',
  allowCredentials: [{ type: 'public-key', id: b64u('kimlik-1'), transports: ['internal'] }],
};

let fetchYanitlari: Response[] = [];
const fetchCagrilari: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  authMsg.length = 0; startAppCagrilari.length = 0;
  apiFetchCagrilari.length = 0; fetchCagrilari.length = 0;
  fetchYanitlari = [];
  apiFetchYanit = () => yanit(200, {});

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    fetchCagrilari.push({ url: String(url), init });
    return fetchYanitlari.shift() ?? yanit(200, {});
  });

  // Varsayilan: WebAuthn DESTEKLENIYOR
  vi.stubGlobal('PublicKeyCredential', function () {} as unknown);
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { credentials: { create: vi.fn(), get: vi.fn() } },
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('destek tespiti', () => {
  it('WebAuthn API varsa DESTEKLENIYOR', () => {
    expect(isSupported()).toBe(true);
  });

  it('PublicKeyCredential yoksa DESTEKLENMIYOR', () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(isSupported()).toBe(false);
  });

  it.each([
    [{ get: vi.fn() }, 'create'],
    [{ create: vi.fn() }, 'get'],
  ])('credential API %s olmadan destek bildirmez', (credentials) => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials } });
    expect(isSupported()).toBe(false);
  });

  it('platform doğrulayıcı desteğini true/false/yok/hata olarak güvenle ölçer', async () => {
    const ctor = globalThis.PublicKeyCredential as unknown as Record<string, unknown>;
    const available = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('privacy'));
    ctor.isUserVerifyingPlatformAuthenticatorAvailable = available;
    await expect(isPlatformAuthenticatorAvailable()).resolves.toBe(true);
    await expect(isPlatformAuthenticatorAvailable()).resolves.toBe(false);
    delete ctor.isUserVerifyingPlatformAuthenticatorAvailable;
    await expect(isPlatformAuthenticatorAvailable()).resolves.toBe(false);
    vi.stubGlobal('PublicKeyCredential', undefined);
    await expect(isPlatformAuthenticatorAvailable()).resolves.toBe(false);
  });

  it('desteklenmeyen tarayicida giris DENENMEZ ve mesaj gosterilir', () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    return passkeyLogin('ali').then((ok) => {
      expect(ok).toBe(false);
      expect(authMsg[0].msg).toContain('desteklemiyor');
      expect(fetchCagrilari).toHaveLength(0);   // aga hic cikilmadi
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('passkey ile giris', () => {
  const kimlikDondur = () => {
    (navigator.credentials.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'kimlik-1',
      response: {
        clientDataJSON: buf('istemci-verisi'),
        authenticatorData: buf('dogrulayici'),
        signature: buf('imza'),
        userHandle: buf('kullanici'),
      },
    });
  };

  it('BASARILI akis oturumu KANONIK yoldan kurar', () => {
    fetchYanitlari = [
      yanit(200, GIRIS_SECENEK),
      yanit(200, { ok: true, token: 'jeton-1', user: { id: 'u1', username: 'ali' } }),
    ];
    kimlikDondur();
    return passkeyLogin('ali').then((ok) => {
      expect(ok).toBe(true);
      expect(startAppCagrilari).toHaveLength(1);
      expect(startAppCagrilari[0].token).toBe('jeton-1');
    });
  });

  it('gonderilen kimlik bilgisi SUNUCU SOZLESMESINE uyar', () => {
    fetchYanitlari = [yanit(200, GIRIS_SECENEK), yanit(200, { ok: true, token: 't', user: { id: 'u' } })];
    kimlikDondur();
    return passkeyLogin('ali').then(() => {
      const govde = JSON.parse(String(fetchCagrilari[1].init?.body));
      // Sunucu base64url dizeler bekler; ArrayBuffer JSON'da `{}` olurdu.
      expect(govde.credential.id).toBe('kimlik-1');
      expect(typeof govde.credential.response.clientDataJSON).toBe('string');
      expect(govde.credential.response.clientDataJSON.length).toBeGreaterThan(0);
      expect(govde.credential.response).toHaveProperty('authenticatorData');
      expect(govde.credential.response).toHaveProperty('signature');
      expect(fetchCagrilari[0].init).toMatchObject({ credentials: 'include', redirect: 'error' });
      expect(fetchCagrilari[1].init).toMatchObject({ credentials: 'include', redirect: 'error' });
    });
  });

  it('es zamanli ikinci passkey girisini reddeder ve iki oturum yarisi baslatmaz', async () => {
    const assertion = deferred<PublicKeyCredential>();
    fetchYanitlari = [
      yanit(200, GIRIS_SECENEK),
      yanit(200, { ok: true, token: 't', user: { _id: 'u', username: 'ali' } }),
    ];
    (navigator.credentials.get as ReturnType<typeof vi.fn>).mockReturnValue(assertion.promise);

    const first = passkeyLogin('ali');
    await vi.waitFor(() => expect(navigator.credentials.get).toHaveBeenCalledTimes(1));
    await expect(passkeyLogin('veli')).resolves.toBe(false);
    expect(fetchCagrilari).toHaveLength(1);

    assertion.resolve({
      id: 'kimlik-1',
      response: {
        clientDataJSON: buf('istemci'), authenticatorData: buf('auth'),
        signature: buf('imza'), userHandle: null,
      },
    } as unknown as PublicKeyCredential);
    await expect(first).resolves.toBe(true);
    expect(startAppCagrilari).toHaveLength(1);
  });

  it('SUNUCU REDDEDERSE oturum KURULMAZ', () => {
    // En kritik iddia: sunucu dogrulamadan oturum acilmamali.
    fetchYanitlari = [
      yanit(200, GIRIS_SECENEK),
      yanit(401, { error: 'Signature verification failed' }),
    ];
    kimlikDondur();
    return passkeyLogin('ali').then((ok) => {
      expect(ok).toBe(false);
      expect(startAppCagrilari).toHaveLength(0);
      // 401 kanonik metne eslenir; sunucu govdesi/ozel metin gosterilmez.
      expect(authMsg[0].msg).toBe(t('error_unauthorized'));
      expect(authMsg[0].msg).not.toContain('Signature verification failed');
    });
  });

  it('sunucu OTURUM ALANLARINI eksik dondurse bile oturum kurulmaz', () => {
    fetchYanitlari = [yanit(200, GIRIS_SECENEK), yanit(200, { ok: true })];  // token yok
    kimlikDondur();
    return passkeyLogin('ali').then((ok) => {
      expect(ok).toBe(false);
      expect(startAppCagrilari).toHaveLength(0);
    });
  });

  it('KULLANICI IPTALI temiz sonlanir (NotAllowedError)', () => {
    fetchYanitlari = [yanit(200, GIRIS_SECENEK)];
    const hata = Object.assign(new Error('iptal'), { name: 'NotAllowedError' });
    (navigator.credentials.get as ReturnType<typeof vi.fn>).mockRejectedValue(hata);
    return passkeyLogin('ali').then((ok) => {
      expect(ok).toBe(false);
      expect(authMsg[0].msg).toContain('iptal');
      expect(startAppCagrilari).toHaveLength(0);
    });
  });

  it.each([
    ['SecurityError', 'adres'],
    ['AbortError', 'iptal'],
  ])('%s tarayıcı hatasını güvenli kullanıcı mesajına çevirir', async (name, fragment) => {
    fetchYanitlari = [yanit(200, GIRIS_SECENEK)];
    (navigator.credentials.get as ReturnType<typeof vi.fn>)
      .mockRejectedValue(Object.assign(new Error('raw browser detail'), { name }));
    await expect(passkeyLogin('ali')).resolves.toBe(false);
    expect(authMsg.at(-1)?.msg).toContain(fragment);
  });

  it('Error olmayan tarayıcı reddini genel mesaja çevirir', async () => {
    fetchYanitlari = [yanit(200, GIRIS_SECENEK)];
    (navigator.credentials.get as ReturnType<typeof vi.fn>).mockRejectedValue({ reason: 'opaque' });
    await expect(passkeyLogin('ali')).resolves.toBe(false);
    expect(authMsg.at(-1)?.msg).toContain('tamamlanamadı');
  });

  it('BASLATMA reddedilirse dogrulayici HIC cagrilmaz', () => {
    fetchYanitlari = [yanit(429, { error: 'Too many attempts' })];
    return passkeyLogin('ali').then((ok) => {
      expect(ok).toBe(false);
      expect(navigator.credentials.get).not.toHaveBeenCalled();
      expect(authMsg[0].msg).toContain('Çok fazla istek');
      expect(authMsg[0].msg).not.toContain('Too many attempts');
    });
  });

  it('MEYDAN OKUMA eksikse akis durur', () => {
    fetchYanitlari = [yanit(200, { rpId: 'localhost' })];   // challenge yok
    return passkeyLogin('ali').then((ok) => {
      expect(ok).toBe(false);
      expect(navigator.credentials.get).not.toHaveBeenCalled();
    });
  });

  it('JSON olmayan begin yanıtını genel hata olarak sınırlar', async () => {
    fetchYanitlari = [{
      ok: false, status: 502, json: async () => { throw new SyntaxError('html'); },
    } as Response];
    await expect(passkeyLogin('ali')).resolves.toBe(false);
    expect(authMsg.at(-1)?.msg).toBe(t('error_server'));
  });

  it('istek seçeneklerinin güvenli varsayılanlarını uygular', async () => {
    fetchYanitlari = [
      yanit(200, { challenge: b64u('x'), allowCredentials: { hostile: true } }),
      yanit(200, { token: 't', user: { _id: 'u' } }),
    ];
    (navigator.credentials.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'id', response: {
        clientDataJSON: buf('c'), authenticatorData: buf('a'), signature: buf('s'), userHandle: null,
      },
    });
    await expect(passkeyLogin('ali')).resolves.toBe(true);
    const options = (navigator.credentials.get as ReturnType<typeof vi.fn>).mock.calls[0][0].publicKey;
    expect(options).toMatchObject({
      rpId: undefined, timeout: 60_000, userVerification: 'preferred', allowCredentials: [],
    });
  });

  it('null assertion ve token tipi bozuk oturum ayrı ayrı reddedilir', async () => {
    fetchYanitlari = [yanit(200, GIRIS_SECENEK)];
    (navigator.credentials.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(passkeyLogin('ali')).resolves.toBe(false);

    fetchYanitlari = [yanit(200, GIRIS_SECENEK), yanit(200, { token: 7, user: { _id: 'u' } })];
    kimlikDondur();
    await expect(passkeyLogin('ali')).resolves.toBe(false);
    expect(startAppCagrilari).toHaveLength(0);
  });

  it('AG HATASI yutulur ve mesaja donusur', () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ağ yok'); });
    return passkeyLogin('ali').then((ok) => {
      expect(ok).toBe(false);
      expect(authMsg).toHaveLength(1);
    });
  });

  it('KULLANICI ADI OLMADAN da denenebilir (discoverable credential)', () => {
    fetchYanitlari = [yanit(200, GIRIS_SECENEK), yanit(200, { ok: true, token: 't', user: { id: 'u' } })];
    kimlikDondur();
    return passkeyLogin(null).then((ok) => {
      expect(ok).toBe(true);
      const govde = JSON.parse(String(fetchCagrilari[0].init?.body));
      expect(govde.username).toBeUndefined();
    });
  });

  it('HICBIR ariza yolu istisna SIZDIRMAZ', async () => {
    // Arayuzu asili birakmamanin on kosulu: cagri her zaman doner.
    const senaryolar: Array<() => void> = [
      () => { fetchYanitlari = [yanit(500, {})]; },
      () => { fetchYanitlari = [yanit(200, GIRIS_SECENEK)];
              (navigator.credentials.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('x')); },
      () => { fetchYanitlari = [yanit(200, GIRIS_SECENEK)];
              (navigator.credentials.get as ReturnType<typeof vi.fn>).mockResolvedValue(null); },
    ];
    for (const kur of senaryolar) {
      authMsg.length = 0; kur();
      await expect(passkeyLogin('ali')).resolves.toBe(false);
      expect(authMsg.length).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('passkey kaydi', () => {
  const kimlikOlustur = () => {
    (navigator.credentials.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'yeni-kimlik',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: buf('istemci'),
        attestationObject: buf('tasdik'),
        getTransports: () => ['internal'],
      },
    });
  };

  it('BASARILI kayit sunucuya dogru govdeyi gonderir', () => {
    apiFetchYanit = (url) => url.includes('begin') ? yanit(200, KAYIT_SECENEK) : yanit(200, { ok: true });
    kimlikOlustur();
    return registerPasskey('Telefonum').then((ok) => {
      expect(ok).toBe(true);
      const govde = JSON.parse(String(apiFetchCagrilari[1].init?.body));
      expect(govde.name).toBe('Telefonum');
      expect(govde.credential.id).toBe('yeni-kimlik');
      expect(typeof govde.credential.response.attestationObject).toBe('string');
      expect(govde.credential.response.transports).toEqual(['internal']);
      expect(apiFetchCagrilari[0].init).toMatchObject({ redirect: 'error' });
      expect(apiFetchCagrilari[1].init).toMatchObject({ redirect: 'error' });
    });
  });

  it('AYNI cihaz zaten kayitliysa anlamli mesaj (InvalidStateError)', () => {
    apiFetchYanit = () => yanit(200, KAYIT_SECENEK);
    const hata = Object.assign(new Error('dup'), { name: 'InvalidStateError' });
    (navigator.credentials.create as ReturnType<typeof vi.fn>).mockRejectedValue(hata);
    return registerPasskey().then((ok) => {
      expect(ok).toBe(false);
      expect(authMsg[0].msg).toContain('zaten');
    });
  });

  it('es zamanli ikinci kaydı reddeder ve tek tarayıcı töreni yürütür', async () => {
    const credential = deferred<PublicKeyCredential>();
    apiFetchYanit = (url) => url.includes('begin') ? yanit(200, KAYIT_SECENEK) : yanit(200, {});
    (navigator.credentials.create as ReturnType<typeof vi.fn>).mockReturnValue(credential.promise);
    const first = registerPasskey('Birinci');
    await vi.waitFor(() => expect(navigator.credentials.create).toHaveBeenCalledTimes(1));
    await expect(registerPasskey('İkinci')).resolves.toBe(false);
    expect(apiFetchCagrilari).toHaveLength(1);
    credential.resolve({
      id: 'cred', authenticatorAttachment: null,
      response: { clientDataJSON: buf('c'), attestationObject: buf('a') },
    } as unknown as PublicKeyCredential);
    await expect(first).resolves.toBe(true);
    const body = JSON.parse(String(apiFetchCagrilari[1].init?.body));
    expect(body.credential.response.transports).toEqual([]);
  });

  it('begin reddi, eksik challenge ve null credential fail-closed sonlanır', async () => {
    apiFetchYanit = () => yanit(503, {});
    await expect(registerPasskey()).resolves.toBe(false);
    expect(authMsg.at(-1)?.msg).toBe(t('error_server'));

    apiFetchYanit = () => yanit(200, { user: { id: b64u('u') } });
    await expect(registerPasskey()).resolves.toBe(false);

    apiFetchYanit = () => yanit(200, KAYIT_SECENEK);
    (navigator.credentials.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(registerPasskey()).resolves.toBe(false);
  });

  it('varsayılan timeout ve boş exclude listesiyle kayıt yapar', async () => {
    const options = { ...KAYIT_SECENEK, timeout: 'bad', excludeCredentials: { hostile: true } };
    apiFetchYanit = (url) => url.includes('begin') ? yanit(200, options) : yanit(200, {});
    kimlikOlustur();
    await expect(registerPasskey()).resolves.toBe(true);
    const publicKey = (navigator.credentials.create as ReturnType<typeof vi.fn>).mock.calls[0][0].publicKey;
    expect(publicKey.timeout).toBe(60_000);
    expect(publicKey.excludeCredentials).toEqual([]);
  });

  it('SUNUCU DOGRULAMASI basarisizsa basarili gorunmez', () => {
    apiFetchYanit = (url) => url.includes('begin')
      ? yanit(200, KAYIT_SECENEK)
      : yanit(400, { error: 'Challenge mismatch' });
    kimlikOlustur();
    return registerPasskey().then((ok) => {
      expect(ok).toBe(false);
      expect(authMsg[0].msg).toContain('İstek geçersiz');
      expect(authMsg[0].msg).not.toContain('Challenge mismatch');
    });
  });

  it('SURESI DOLMUS meydan okuma ham sunucu metni sizdirilmadan bildirilir', () => {
    apiFetchYanit = (url) => url.includes('begin')
      ? yanit(200, KAYIT_SECENEK)
      : yanit(400, { error: 'Challenge expired. Please try again.' });
    kimlikOlustur();
    return registerPasskey().then((ok) => {
      expect(ok).toBe(false);
      expect(authMsg[0].msg).toContain('İstek geçersiz');
      expect(authMsg[0].msg).not.toContain('Challenge expired');
    });
  });

  it('desteklenmeyen tarayicida kayit DENENMEZ', () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    return registerPasskey().then((ok) => {
      expect(ok).toBe(false);
      expect(apiFetchCagrilari).toHaveLength(0);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kimlik bilgisi yonetimi', () => {
  it('doğrudan dizi ve credentials sarmalayıcısını okur; bozuk şekli boşaltır', async () => {
    apiFetchYanit = vi.fn()
      .mockResolvedValueOnce(yanit(200, [{ id: 'a' }]))
      .mockResolvedValueOnce(yanit(200, { credentials: [{ id: 'b' }] }))
      .mockResolvedValueOnce(yanit(200, { credentials: { hostile: true } }));
    await expect(listPasskeys()).resolves.toEqual([{ id: 'a' }]);
    await expect(listPasskeys()).resolves.toEqual([{ id: 'b' }]);
    await expect(listPasskeys()).resolves.toEqual([]);
    expect(apiFetchCagrilari[0].init).toMatchObject({ redirect: 'error' });
  });

  it('liste basarisiz olursa BOS dizi doner (cokmez)', async () => {
    apiFetchYanit = () => { throw new Error('ağ'); };
    await expect(listPasskeys()).resolves.toEqual([]);
  });

  it('bos id ile silme istegi GONDERILMEZ', async () => {
    await expect(deletePasskey('')).resolves.toBe(false);
    expect(apiFetchCagrilari).toHaveLength(0);
  });

  it('silme id KODLANARAK gonderilir', async () => {
    apiFetchYanit = () => yanit(200, {});
    await deletePasskey('a/b c');
    expect(apiFetchCagrilari[0].url).toContain(encodeURIComponent('a/b c'));
    expect(apiFetchCagrilari[0].init).toMatchObject({ method: 'DELETE', redirect: 'error' });
  });

  it('silme sunucu reddini ve ağ hatasını false olarak döndürür', async () => {
    apiFetchYanit = vi.fn()
      .mockResolvedValueOnce(yanit(403, {}))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(deletePasskey('a')).resolves.toBe(false);
    await expect(deletePasskey('b')).resolves.toBe(false);
  });
});
