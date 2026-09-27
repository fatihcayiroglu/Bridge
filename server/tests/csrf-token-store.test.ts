// server/tests/csrf-token-store.test.ts
//
// CSRF JETON DEPOSU — EŞ ZAMANLI OTURUMLAR
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR: jeton `security:csrf:<userId>` altında TEK kayıt
// olarak tutuluyordu; her üretim öncekinin ÜSTÜNE YAZIYORDU. Aynı kullanıcının
// aynı anda yalnızca BİR geçerli jetonu olabiliyordu.
//
// ÜRÜN ETKİSİ — test kusuru DEĞİL: iki sekme. A sekmesi jetonunu alır, B
// sekmesi açılıp kendi jetonunu alır, A'nın jetonu o anda GEÇERSİZ olur ve
// A'daki bir sonraki değişiklik isteği 403 döner. Aynısı masaüstü uygulaması
// + tarayıcı, ya da yeniden yüklenen sekme için de geçerlidir.
//
// Ölçüm: tam Playwright koşusunda `POST /api/servers` üç kez
// "CSRF token invalid or expired" ile 403 döndü; testler TEK BAŞINA
// çalıştırıldığında geçiyordu.
//
// ── BU TESTLER GÜVENLİK SINIRINI DA KİLİTLER ────────────────────────────
// Eş zamanlılığı düzeltmek, CSRF korumasını GEVŞETMEK DEĞİLDİR. Aşağıdaki
// sınırlar aynen korunmalıdır ve burada tek tek doğrulanır:
//   · başka kullanıcının jetonu KABUL EDİLMEZ
//   · süresi dolmuş jeton KABUL EDİLMEZ
//   · üretilmemiş/uydurma jeton KABUL EDİLMEZ
//   · biçimsiz jeton KABUL EDİLMEZ
//   · jeton tahmin edilemez olmalıdır
//
// Redis bu ortamda YOK; bu yüzden bellek içi yedek yol sınanır — yani en
// kısıtlı yol (kullanıcı başına kapak burada uygulanır).

process.env.NODE_ENV = 'test';

import { generateCsrfToken, verifyCsrfToken } from '../lib/security';

const USER = 'user-alice';
const OTHER = 'user-bob';

describe('CSRF — eş zamanlı oturumlar', () => {
  it('AYNI kullanıcının iki jetonu da geçerlidir (iki sekme)', async () => {
    const tabA = await generateCsrfToken(USER);
    const tabB = await generateCsrfToken(USER);

    expect(tabA).not.toBe(tabB);
    // Kusurlu davranışta tabA burada FALSE dönerdi.
    expect(await verifyCsrfToken(USER, tabA)).toBe(true);
    expect(await verifyCsrfToken(USER, tabB)).toBe(true);
  });

  it('makul sayıda eş zamanlı oturum desteklenir', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => generateCsrfToken('user-many')),
    );
    for (const t of tokens) expect(await verifyCsrfToken('user-many', t)).toBe(true);
  });
});

describe('CSRF — güvenlik sınırı korunur', () => {
  it('BAŞKA kullanıcının jetonu kabul edilmez', async () => {
    const aliceToken = await generateCsrfToken(USER);
    expect(await verifyCsrfToken(OTHER, aliceToken)).toBe(false);
  });

  it('üretilmemiş jeton kabul edilmez', async () => {
    await generateCsrfToken(USER);
    expect(await verifyCsrfToken(USER, 'a'.repeat(64))).toBe(false);
  });

  it('biçimsiz jeton kabul edilmez', async () => {
    await generateCsrfToken(USER);
    for (const bad of ['', 'kısa', 'Z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65),
                       '../../etc', 'security:csrf:user-alice']) {
      expect(await verifyCsrfToken(USER, bad)).toBe(false);
    }
  });

  it('jeton olmayan tipler kabul edilmez', async () => {
    for (const bad of [null, undefined, 0, {}, []]) {
      expect(await verifyCsrfToken(USER, bad as unknown as string)).toBe(false);
    }
  });

  it('boş kullanıcı kimliği kabul edilmez', async () => {
    const token = await generateCsrfToken(USER);
    expect(await verifyCsrfToken('', token)).toBe(false);
  });

  it('süresi dolmuş jeton kabul edilmez', async () => {
    const token = await generateCsrfToken('user-expiry');
    expect(await verifyCsrfToken('user-expiry', token)).toBe(true);

    // TTL 1 saat; saati ileri sararak süre dolmasını sınarız.
    const realNow = Date.now;
    Date.now = () => realNow() + 3600_000 + 1000;
    try {
      expect(await verifyCsrfToken('user-expiry', token)).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('jeton tahmin edilemez — 64 hex karakter, tekrar YOK', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = await generateCsrfToken('user-entropy');
      expect(t).toMatch(/^[a-f0-9]{64}$/);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
  });
});

describe('CSRF — bellek sınırlıdır', () => {
  it('kullanıcı başına jeton sayısı kapaklıdır', async () => {
    // Sınırsız birikim, kimliği doğrulanmış bir istemcinin bellek şişirmesine
    // izin verirdi. Kapak aşıldığında EN ESKİ jeton düşer.
    const uid = 'user-cap';
    const tokens: string[] = [];
    for (let i = 0; i < 40; i++) tokens.push(await generateCsrfToken(uid));

    const oldest = tokens[0];
    const newest = tokens[tokens.length - 1];
    expect(await verifyCsrfToken(uid, newest)).toBe(true);
    expect(await verifyCsrfToken(uid, oldest)).toBe(false);
  });
});
