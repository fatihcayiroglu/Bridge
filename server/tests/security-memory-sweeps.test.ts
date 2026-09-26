// server/tests/security-memory-sweeps.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/security — SPAM VE CSRF DURUMUNUN PERIYODIK SUPURULMESI
// ════════════════════════════════════════════════════════════════════════════
// Iki koruma da KULLANICI BASINA surec-ici durum tutar:
//
//   · spam durumu  — son mesaj zamanlari + susturma bitisi
//   · CSRF jetonu  — kullanici basina jeton ve son kullanma zamani
//
// Bu haritalar temizlenmezse koruma KENDISI bir bellek sizintisina donusur —
// ustelik en kotu anda, yani en cok farkli kullanici goruldugu saldiri
// altinda. Iki mekanizma birden vardir ve ikisi de olculmelidir:
//
//   1. PERIYODIK SUPURME — suresi dolmus kayitlar zamanlayiciyla dusurulur.
//      Susturmasi HALA suren bir kullanici DUSURULMEMELIDIR; aksi hâlde
//      susturma sessizce kalkar ve yaptirim kaybolur.
//   2. SERT TAVAN — harita dolduysa yeni bir kimlik EN ESKIYI dusurur.
//      Supurme aralik beklerken tavan ANINDA korur.
process.env.NODE_ENV = 'test';

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── SAHTE ZAMANLAYICI MODULDEN ONCE KURULUR ────────────────────────────────
// Supurme donguleri MODUL YUKLENIRKEN `setInterval` ile kaydedilir. Modul
// once ic aktarilirsa GERCEK zamanlayici kurulur ve `advanceTimersByTime`
// onu HIC tetiklemez — testler gecer ama supurme kodu calismaz.
jest.useFakeTimers();

type SecurityModule = typeof import('../lib/security');
let checkSpam: SecurityModule['checkSpam'];
let generateCsrfToken: SecurityModule['generateCsrfToken'];
let verifyCsrfToken: SecurityModule['verifyCsrfToken'];

beforeAll(async () => {
  await jest.isolateModulesAsync(async () => {
    const mod = await import('../lib/security');
    ({ checkSpam, generateCsrfToken, verifyCsrfToken } = mod);
  });
});

afterAll(() => { jest.useRealTimers(); });

describe('spam state is swept once it stops mattering', () => {
  it('keeps a user muted until the mute actually expires', () => {
    // Ard arda FARKLI mesajlar hiz sinirini tetikler (ayni metin ayri bir
    // "yineleme" kuralina takilir; olculen sey HIZ kuralidir).
    let result = checkSpam('u-spam', 'merhaba');
    for (let i = 0; i < 12 && !result.blocked; i += 1) result = checkSpam('u-spam', `mesaj ${i}`);
    expect(result.blocked).toBe(true);

    // Supurme dongusu calisir ama susturma HALA surmektedir (30 sn).
    jest.advanceTimersByTime(10_000);
    const stillMuted = checkSpam('u-spam', 'yine ben');
    // Yaptirim sessizce kalkmamalidir.
    expect(stillMuted.blocked).toBe(true);
    expect(stillMuted.reason).toBe('spam_muted');
  });

  it('forgets a quiet user after the sweep window', () => {
    expect(checkSpam('u-quiet', 'tek mesaj').blocked).toBe(false);

    // Mesajlar bayatlar ve susturma yoktur: kayit DUSER.
    jest.advanceTimersByTime(10 * 60_000);

    // Temiz sayfa: kullanici yeniden tam butceyle baslar.
    let result = checkSpam('u-quiet', 'geri dondum');
    expect(result.blocked).toBe(false);
    for (let i = 0; i < 3 && !result.blocked; i += 1) result = checkSpam('u-quiet', `d ${i}`);
    expect(result.blocked).toBe(false);
  });

  it('sweeps repeatedly without throwing on an empty map', () => {
    expect(() => jest.advanceTimersByTime(5 * 60_000)).not.toThrow();
  });

  it('keeps separate users independent through a sweep', () => {
    let noisy = checkSpam('u-a', 'x');
    for (let i = 0; i < 12 && !noisy.blocked; i += 1) noisy = checkSpam('u-a', `x${i}`);
    expect(noisy.blocked).toBe(true);

    jest.advanceTimersByTime(60_000);
    // Sessiz kullanici, gurultulu kullanicinin durumundan ETKILENMEZ.
    expect(checkSpam('u-b', 'selam').blocked).toBe(false);
  });
});

describe('CSRF tokens expire and are swept', () => {
  it('accepts a freshly issued token', async () => {
    const token = await generateCsrfToken('u-csrf');
    await expect(verifyCsrfToken('u-csrf', token)).resolves.toBe(true);
  });

  it('refuses a token issued to somebody else', async () => {
    const token = await generateCsrfToken('u-owner');
    await expect(verifyCsrfToken('u-other', token)).resolves.toBe(false);
  });

  it.each([
    ['an empty token', ''],
    ['a short token', 'abc'],
    ['a non-hex token', 'z'.repeat(64)],
  ])('refuses %s on format alone', async (_label, token) => {
    await expect(verifyCsrfToken('u-csrf', token)).resolves.toBe(false);
  });

  it('stops accepting a token once it has expired and been swept', async () => {
    const token = await generateCsrfToken('u-expire');
    await expect(verifyCsrfToken('u-expire', token)).resolves.toBe(true);

    // Sure asimi + supurme dongusu.
    jest.advanceTimersByTime(4 * 60 * 60 * 1000);
    jest.advanceTimersByTime(10 * 60_000);

    await expect(verifyCsrfToken('u-expire', token)).resolves.toBe(false);
  });

  it('sweeps without disturbing a still-valid token', async () => {
    const token = await generateCsrfToken('u-keep');
    jest.advanceTimersByTime(10 * 60_000);
    // Supurme YALNIZCA suresi dolmuslari dusurur.
    await expect(verifyCsrfToken('u-keep', token)).resolves.toBe(true);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
