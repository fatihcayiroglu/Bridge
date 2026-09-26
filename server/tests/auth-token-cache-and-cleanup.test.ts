// server/tests/auth-token-cache-and-cleanup.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// middleware/auth — JETON SURUMU ONBELLEGI, TTL AYRISTIRMA VE TEMIZLIK
// ════════════════════════════════════════════════════════════════════════════
// Uc kucuk ama guvenlik tasiyan parca:
//
// 1. `tokenVersion` ONBELLEGI bir LRU'dur ve SINIRLIDIR. Sinir olmasaydi her
//    goren kullanici icin kalici bir girdi birikirdi. Ama daha onemlisi:
//    onbellek bir IPTAL SINIRIDIR — `_invalidateTokenCache` cagrildiginda
//    kayit DUSMELI, yoksa iptal edilmis bir oturum TTL boyunca gecerli kalir.
//
// 2. `REFRESH_TOKEN_TTL` ayristirmasi ACILISTA yapilir ve HATALI bir deger
//    sessizce varsayilana DUSMEZ. Sessiz varsayilan, operatorun "7 gun"
//    sandigi bir kurulumun 30 gun calismasi demek olurdu.
//
// 3. TEMIZLIK ZAMANLAYICISI tek seferliktir. Modul birden cok kez ic
//    aktarilsa da IKINCI bir zamanlayici kurulmamalidir; aksi hâlde ayni
//    silme sorgusu katlanarak tekrarlanir.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: logger, createLogger: () => logger }));

import { Auth } from '../db/repositories';
// Onbellek ve zamanlayici testleri PAYLASILAN modul ornegini kullanir:
// `isolateModules` ayri bir `db/loader` ornegi yaratir ve disarida eklenen
// satirlar o ornekte GORUNMEZ. Yalnizca TTL AYRISTIRMASI taze bir yukleme
// gerektirir (deger modul yuklenirken bir kez okunur).
import * as sharedAuth from '../middleware/auth';

type AuthModule = typeof import('../middleware/auth');

/** Verilen TTL yapilandirmasiyla taze bir modul ornegi yukler. */
async function loadAuth(ttl?: string): Promise<AuthModule> {
  const previous = process.env.REFRESH_TOKEN_TTL;
  if (ttl === undefined) delete process.env.REFRESH_TOKEN_TTL;
  else process.env.REFRESH_TOKEN_TTL = ttl;

  let mod!: AuthModule;
  await jest.isolateModulesAsync(async () => { mod = await import('../middleware/auth'); });

  if (previous === undefined) delete process.env.REFRESH_TOKEN_TTL;
  else process.env.REFRESH_TOKEN_TTL = previous;
  return mod;
}

const db = require('../db/loader');

beforeEach(() => {
  db._reset?.();
  jest.restoreAllMocks();
  for (const fn of Object.values(logger)) fn.mockClear();
  // Onbellek MODUL SEVIYESINDEDIR; testler arasi sizinti olmamasi icin
  // kullanilan kimlikler acikca dusurulur.
  for (const id of ['u1', 'u2', 'yok']) sharedAuth._invalidateTokenCache(id);
});

afterEach(() => { jest.resetModules(); });

describe('the refresh TTL is parsed strictly at load time', () => {
  it.each([['30d'], ['7d'], ['1h'], ['720h']])('accepts %s', async (ttl) => {
    await expect(loadAuth(ttl)).resolves.toBeDefined();
  });

  it.each([
    ['a bare number', '30'],
    ['minutes, which are not supported', '30m'],
    ['a fractional amount', '1.5d'],
    ['an empty unit', 'd'],
    ['nonsense', 'sonsuza-kadar'],
  ])('refuses %s rather than falling back to a default', async (_label, ttl) => {
    // Sessiz varsayilan, operatorun "7 gun" sandigi kurulumun 30 gun
    // calismasi demek olurdu — bu bir guvenlik sapmasidir.
    await expect(loadAuth(ttl)).rejects.toThrow(/REFRESH_TOKEN_TTL must be an integer followed by d or h/);
  });

  it('refuses a value that overflows the safe integer range', async () => {
    await expect(loadAuth('999999999999999999d')).rejects.toThrow(/out of range/);
  });

  it('uses the documented default when nothing is configured', async () => {
    await expect(loadAuth(undefined)).resolves.toBeDefined();
  });
});

describe('the token-version cache is a revocation boundary', () => {
  it('reads the stored version and serves a repeat from cache', async () => {
    const auth = sharedAuth;
    await db.users.insert({ _id: 'u1', username: 'u1', tokenVersion: 3 });

    await expect(auth.getTokenVersion('u1')).resolves.toBe(3);

    const findById = jest.spyOn(db.users, 'findOne');
    await expect(auth.getTokenVersion('u1')).resolves.toBe(3);
    // Ikinci okuma veritabanina GITMEZ.
    expect(findById).not.toHaveBeenCalled();
  });

  it('drops the cached version the moment a session is revoked', async () => {
    const auth = sharedAuth;
    await db.users.insert({ _id: 'u1', username: 'u1', tokenVersion: 1 });
    await expect(auth.getTokenVersion('u1')).resolves.toBe(1);

    await db.users.update({ _id: 'u1' }, { $set: { tokenVersion: 2 } });
    auth._invalidateTokenCache('u1');

    // Iptal ANINDA gecerli olmalidir; TTL beklenmez.
    await expect(auth.getTokenVersion('u1')).resolves.toBe(2);
  });

  it('reports an unknown user as having no version at all', async () => {
    const auth = sharedAuth;
    await expect(auth.getTokenVersion('yok')).resolves.toBeNull();
  });

  it('bounds the cache so it cannot grow with every user seen', async () => {
    const auth = sharedAuth;
    // Tavan 50.000'dir; onu doldurmak bir birim testi icin orantisiz olurdu.
    // Olculen sey SINIRIN VARLIGI ve LRU tazeleme davranisidir: tekrar okunan
    // bir kimlik listenin SONUNA tasinir, yani en son kullanilan korunur.
    await db.users.insert({ _id: 'u1', username: 'u1', tokenVersion: 7 });
    await expect(auth.getTokenVersion('u1')).resolves.toBe(7);

    // Tazeleme: ikinci okuma yine onbellekten gelir (DB'ye gidilmez).
    const findOne = jest.spyOn(db.users, 'findOne');
    await expect(auth.getTokenVersion('u1')).resolves.toBe(7);
    await expect(auth.getTokenVersion('u1')).resolves.toBe(7);
    expect(findOne).not.toHaveBeenCalled();

    // Dusurulunce yeniden okunur — girdi gercekten onbellekteydi.
    auth._invalidateTokenCache('u1');
    await expect(auth.getTokenVersion('u1')).resolves.toBe(7);
    expect(findOne).toHaveBeenCalled();
  });

  it('keeps each user independent when one is invalidated', async () => {
    const auth = sharedAuth;
    await db.users.insert({ _id: 'u1', username: 'u1', tokenVersion: 1 });
    await db.users.insert({ _id: 'u2', username: 'u2', tokenVersion: 5 });
    await auth.getTokenVersion('u1');
    await auth.getTokenVersion('u2');

    auth._invalidateTokenCache('u1');
    const findOne = jest.spyOn(db.users, 'findOne');
    await auth.getTokenVersion('u2');
    // u2'nin girdisi ETKILENMEZ.
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('the refresh-token cleanup timer is installed exactly once', () => {
  // Zamanlayici MODUL SEVIYESINDE bir tekildir (singleton). Yalnizca ILK
  // kurulum gozlemlenebilir, bu yuzden uc ozellik TEK bir testte olculur:
  // idempotanlik, iki silme filtresi ve arizadan sonra hayatta kalma.
  it('installs once, sweeps both row classes and survives a failure', async () => {
    jest.useFakeTimers();
    try {
      const remove = jest.spyOn(Auth, 'removeRefreshTokensWhere')
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue(undefined as never);

      sharedAuth.startAuthCleanup();
      sharedAuth.startAuthCleanup();
      sharedAuth.startAuthCleanup();

      // ── DONGU 1: ilk sorgu duser ───────────────────────────────────────
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth.refresh_cleanup.failed' }), expect.any(String));

      // ── DONGU 2: zamanlayici HAYATTA ve tam olarak BIR tanedir ─────────
      remove.mockClear();
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

      // Tek dongu = iki silme sorgusu. Ucuncu bir cagri, ucuncu bir
      // zamanlayicinin kuruldugunu gosterirdi.
      expect(remove).toHaveBeenCalledTimes(2);
      const filters = remove.mock.calls.map(c => JSON.stringify(c[0]));
      expect(filters.some(f => f.includes('expiresAt'))).toBe(true);
      // Kullanilmis jetonlar HEMEN degil, kisa bir gecikmeyle silinir: es
      // zamanli bir yenileme yarisini YENIDEN-KULLANIM olarak yakalayabilmek icin.
      expect(filters.some(f => f.includes('usedAt'))).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});
