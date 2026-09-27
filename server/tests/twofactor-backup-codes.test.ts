// server/tests/twofactor-backup-codes.test.ts
//
// 2FA YEDEK KODLARI — DİSKTE DÜZ METİN VE ZAYIF ENTROPİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN İKİ GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Yedek kodlar 2FA'yı TAMAMEN atlar — yani parola ile EŞDEĞER kimlik
// bilgisidir. İkisi de bu programda bulundu:
//
// A) DÜZ METİN DEPOLAMA (asıl bulgu)
//      twoFactorBackup: JSON.stringify(backupCodes)
//    Kodlar veritabanına OLDUĞU GİBİ yazılıyordu. Veritabanını okuyabilen
//    herkes — çalınmış bir yedek, SQL enjeksiyonu, kötü niyetli yönetici,
//    yanlış yapılandırılmış bir replika — HER kullanıcı için çalışan bir 2FA
//    atlatma kimlik bilgisi elde ediyordu. Parolalar bcrypt ile saklanırken
//    onlara eşdeğer bu kodlar korumasızdı.
//
// B) 32 BİT ENTROPİ
//      crypto.randomBytes(4)
//    Hız sınırı çevrimiçi kaba kuvveti pratikte engelliyordu, ama savunma
//    derinliği yoktu: tek bir hız-sınırı hatası bunu kritik hale getirirdi.
//
// ── NEDEN SHA-256, BCRYPT DEĞİL ─────────────────────────────────────────────
// Doğrulama saklanan 8 kodun HEPSİNE bakmak zorundadır. bcrypt cost 12 ile bu
// istek başına ~2 saniye CPU demekti — ucuz girdiyle pahalı iş yaptıran bir
// DoS yüzeyi. Yedek kodlar 64 bit KRİPTOGRAFİK rastgelelik taşır; özetten geri
// getirmek özet hızından bağımsız olarak uygulanamazdır. Oturum jetonlarının
// aynı şekilde saklanmasının nedeni de budur.

// ── HIZ SINIRI: BU SUITTE YUKSELTILIR ──────────────────────────────────────
// `/api/2fa/check` uretimde `limits.twoFactor()` altindadir: 5 dakikada 5
// istek. Bu dosya YEDEK KOD semantigini olcmek icin ondan cok daha fazla
// istek atar; 6. istekten itibaren 429 geliyordu ve bu 9 testi dusuruyordu.
//
// DIKKAT — SINIR ZAYIFLATILMIYOR: yalnizca bu suit icin yukseltilir, uretim
// varsayilanina DOKUNULMAZ. Sinirin KENDISI ayri bir dosyada acikca
// olculur: `tests/twofactor-rate-limit.test.ts`.
//
// Deger router IMPORT EDILMEDEN once ayarlanmalidir: limit tablosu modul
// yuklenirken okunur.
process.env.RL_2FA_MAX = '1000';

import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));

const request = require('supertest');
import db from '../db/loader';
import { authMiddleware } from '../middleware/auth';
import { issueTwoFactorLoginChallenge } from '../lib/twoFactorLoginChallenge';
import { requireDoc } from './helpers/mockDb';
import twoFactorRouter, {
  __hashBackupCodeForTest as hashBackupCode,
  __generateBackupCodesForTest as generateBackupCodes,
  __backupCodeMatchesForTest as backupCodeMatches,
  __readBackupCodesForTest as readBackupCodes,
  __totpNowForTest as totpNow,
  __matchingTotpStepForTest as matchingTotpStep,
} from '../routes/twoFactor';

// URETIMDEKI GIBI monte edilir: `setupRoutes.ts:156` -> mountApi('/2fa', router)
// yani uygulama duzeyinde authMiddleware YOKTUR. Bu onemlidir: `/check`
// GIRIS SIRASINDA cagrilir, kullanici henuz tam kimlik dogrulamamistir.
// (Mevcut twoFactor.test.ts auth'u mount'a ekliyor; bu, yalnizca kimlikli
// uclar icin dogru bir kisayoldur ve `/check` icin yaniltici olurdu.)
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/2fa', twoFactorRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

// ════════════════════════════════════════════════════════════════════════════
// ENTROPİ
// ════════════════════════════════════════════════════════════════════════════
describe('yedek kod entropisi', () => {
  it('kod başına 64 BİT (16 onaltılık karakter)', () => {
    // Onceden randomBytes(4) = 32 bit = 8 karakterdi.
    for (const c of generateBackupCodes()) {
      expect({ uzunluk: c.length, onaltilik: /^[a-f0-9]+$/.test(c) })
        .toEqual({ uzunluk: 16, onaltilik: true });
    }
  });

  it('varsayılan 8 kod üretilir', () => {
    expect(generateBackupCodes().length).toBe(8);
  });

  it('kodlar BENZERSİZ (CSPRNG kullanılıyor)', () => {
    const hepsi = [
      ...generateBackupCodes(), ...generateBackupCodes(),
      ...generateBackupCodes(), ...generateBackupCodes(),
    ];
    expect({ toplam: hepsi.length, benzersiz: new Set(hepsi).size })
      .toEqual({ toplam: 32, benzersiz: 32 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DİSKTE TEMSİL
// ════════════════════════════════════════════════════════════════════════════
describe('diskte temsil', () => {
  it('özet SHA-256’dır ve düz metinle EŞLEŞMEZ', () => {
    const kod = 'a1b2c3d4e5f60718';
    const ozet = hashBackupCode(kod);
    expect(ozet).toBe(crypto.createHash('sha256').update(kod, 'utf8').digest('hex'));
    expect(ozet === kod).toBe(false);
    expect(ozet).toHaveLength(64);
  });

  it('KURULUM sonrası veritabanında DÜZ METİN kod BULUNMAZ', async () => {
    // En onemli iddia: calinmis bir veritabani calisan kimlik bilgisi vermemeli.
    db._reset?.();
    const userId = uuidv4();
    const kodlar = generateBackupCodes();
    await db.users.insert({
      _id: userId, username: 'u', tokenVersion: 0,
      twoFactorEnabled: true, twoFactorSecret: 'S',
      twoFactorBackup: JSON.stringify(kodlar.map(hashBackupCode)),
    });
    const saklanan = String((await requireDoc(db.users, { _id: userId })).twoFactorBackup);
    const sizan = kodlar.filter(k => saklanan.includes(k));
    expect({ sizan }).toEqual({ sizan: [] });
  });

  it('boşluk kırpılır — kopyala/yapıştır kodu bozmaz', () => {
    expect(hashBackupCode('  abc123  ')).toBe(hashBackupCode('abc123'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EŞLEŞTİRME — özet + eski düz metin
// ════════════════════════════════════════════════════════════════════════════
describe('backupCodeMatches', () => {
  it('ÖZETLENMİŞ girdi doğru kodu kabul eder', () => {
    const kod = 'deadbeefdeadbeef';
    expect(backupCodeMatches(kod, hashBackupCode(kod))).toBe(true);
  });

  it('ÖZETLENMİŞ girdi yanlış kodu REDDEDER', () => {
    expect(backupCodeMatches('yanlis', hashBackupCode('deadbeefdeadbeef'))).toBe(false);
  });

  it('ESKİ düz metin girdi hâlâ çalışır (geriye dönük uyumluluk)', () => {
    // Bu duzeltmeden ONCE kaydolmus kullanicilari hesaplarindan etmemeliyiz.
    expect(backupCodeMatches('legacy123', 'legacy123')).toBe(true);
  });

  it('ESKİ düz metin girdi yanlış kodu REDDEDER', () => {
    expect(backupCodeMatches('baska', 'legacy123')).toBe(false);
  });

  it('özetin KENDİSİ kod olarak kabul EDİLMEZ', () => {
    // Veritabanini okuyabilen biri ozeti dogrudan gonderip giremesin.
    const kod = 'deadbeefdeadbeef';
    const ozet = hashBackupCode(kod);
    expect(backupCodeMatches(ozet, ozet)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GERÇEK ROTA — tüketim ve tek kullanımlık davranış
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/2fa/check — yedek kod ile', () => {
  let app: express.Express, userId: string, token: string, tempToken: string;

  const seed = async (backup: string[]) => {
    db._reset?.();
    userId = uuidv4();
    token = tok(userId);
    await db.users.insert({
      _id: userId, username: 'u', displayName: 'U', tokenVersion: 0,
      twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      twoFactorBackup: JSON.stringify(backup),
    });
    tempToken = await issueTwoFactorLoginChallenge(userId, 0);
  };

  beforeEach(() => { app = buildApp(); });

  it('ÖZETLENMİŞ yedek kod kabul edilir', async () => {
    const kod = 'a1b2c3d4e5f60718';
    await seed([hashBackupCode(kod)]);
    const r = await request(app).post('/api/2fa/check').send({ tempToken, code: kod });
    expect({ status: r.status, usedBackup: r.body.usedBackup })
      .toEqual({ status: 200, usedBackup: true });
  });

  it('kod TEK KULLANIMLIKTIR — ikinci deneme reddedilir', async () => {
    const kod = 'a1b2c3d4e5f60718';
    await seed([hashBackupCode(kod)]);
    await request(app).post('/api/2fa/check').send({ tempToken, code: kod });
    const ikinci = await request(app).post('/api/2fa/check').send({ tempToken, code: kod });
    expect(ikinci.status).toBe(401);
  });

  it('aynı challenge ile yarışan iki FARKLI geçerli backup kodundan yalnız kazanan tüketilir', async () => {
    const a = '1111222233334444';
    const b = 'aaaabbbbccccdddd';
    await seed([hashBackupCode(a), hashBackupCode(b)]);

    const [ra, rb] = await Promise.all([
      request(app).post('/api/2fa/check').send({ tempToken, code: a }),
      request(app).post('/api/2fa/check').send({ tempToken, code: b }),
    ]);

    expect([ra.status, rb.status].sort()).toEqual([200, 401]);
    const stored = readBackupCodes((await requireDoc(db.users, { _id: userId })).twoFactorBackup);
    expect(stored).toHaveLength(1);
  });

  it('kullanılan kod DEPODAN silinir', async () => {
    const kod = 'a1b2c3d4e5f60718';
    await seed([hashBackupCode(kod), hashBackupCode('ffffffffffffffff')]);
    await request(app).post('/api/2fa/check').send({ tempToken, code: kod });
    const kalan = JSON.parse(String((await requireDoc(db.users, { _id: userId })).twoFactorBackup));
    expect({ kalan: kalan.length, tuketilenVarMi: kalan.includes(hashBackupCode(kod)) })
      .toEqual({ kalan: 1, tuketilenVarMi: false });
  });

  it('ESKİ düz metin kod da kabul edilir (geriye dönük uyumluluk)', async () => {
    await seed(['legacyplaincode']);
    const r = await request(app).post('/api/2fa/check').send({ tempToken, code: 'legacyplaincode' });
    expect({ status: r.status, usedBackup: r.body.usedBackup })
      .toEqual({ status: 200, usedBackup: true });
  });

  it('YANLIŞ kod 401 döner', async () => {
    await seed([hashBackupCode('a1b2c3d4e5f60718')]);
    const r = await request(app).post('/api/2fa/check').send({ tempToken, code: 'yanliskodburada' });
    expect(r.status).toBe(401);
  });

  it('BAŞKA kullanıcının kodu işe YARAMAZ', async () => {
    const kod = 'a1b2c3d4e5f60718';
    await seed([hashBackupCode(kod)]);
    const digerId = uuidv4();
    await db.users.insert({
      _id: digerId, username: 'v', tokenVersion: 0,
      twoFactorEnabled: true, twoFactorSecret: 'S', twoFactorBackup: '[]',
    });
    const otherChallenge = await issueTwoFactorLoginChallenge(digerId, 0);
    const r = await request(app).post('/api/2fa/check').send({
      tempToken: otherChallenge,
      userId, // ignored: client ids may not retarget a server-side challenge
      code: kod,
    });
    expect(r.status).toBe(401);
  });
});

describe('POST /api/2fa/check — TOTP adımı tek kullanımlıdır', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';

  it('aynı zaman koduyla iki bağımsız challenge yarışınca yalnız biri oturum açar', async () => {
    db._reset?.();
    const id = uuidv4();
    await db.users.insert({
      _id: id, username: 'totp-race', displayName: 'TOTP Race', tokenVersion: 0,
      twoFactorEnabled: true, twoFactorSecret: SECRET, twoFactorBackup: '[]',
      twoFactorLastUsedStep: null,
    });
    const [challengeA, challengeB] = await Promise.all([
      issueTwoFactorLoginChallenge(id, 0),
      issueTwoFactorLoginChallenge(id, 0),
    ]);
    const code = totpNow(SECRET)[1];
    const app = buildApp();
    const [a, b] = await Promise.all([
      request(app).post('/api/2fa/check').send({ tempToken: challengeA, code }),
      request(app).post('/api/2fa/check').send({ tempToken: challengeB, code }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect((await requireDoc(db.users, { _id: id })).twoFactorLastUsedStep).toEqual(expect.any(Number));
  });

  it('bozuk saklı base32 sırlarını boş/kısmi HMAC anahtarına indirgemez', () => {
    for (const secret of ['!', 'AAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAA*', 'A'.repeat(129)]) {
      expect(matchingTotpStep(secret, '000000')).toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1 GERİLEME KİLİDİ — JSONB DİZİ TEMSİLİ
// ════════════════════════════════════════════════════════════════════════════
// `twoFactorBackup` sütunu JSONB'dir (db/postgres/schema.ts:32) ve pg sürücüsü
// JSONB'yi ZATEN PARSE EDER. Eski kod yalnızca DİZE temsilini kabul ediyordu:
//
//   JSON.parse(typeof v === 'string' ? v : '[]')
//
// GERÇEK veritabanına karşı ölçüldü:
//   SELECT '["abc","def"]'::jsonb  →  typeof 'object', Array.isArray true
//
// Yani koşul HER ZAMAN yanlıştı ve liste HER ZAMAN boş dönüyordu:
//   • gönderilen her yedek kod 401 alıyordu
//   • /status her zaman backupRemaining: 0 bildiriyordu
//   • kimlik doğrulayıcısını kaybeden kullanıcı KALICI OLARAK kilitleniyordu
//
// Yedek kodlar tam olarak bu durum için var olan KURTARMA mekanizmasıdır.
describe('JSONB temsili (gerçek Postgres davranışı)', () => {
  it('DİZİ girdi okunur — sürücünün gerçekte döndürdüğü biçim', () => {
    expect(readBackupCodes(['legacy01', 'legacy02'])).toEqual(['legacy01', 'legacy02']);
  });

  it('DİZE girdi de okunur (eski/SQLite yolu)', () => {
    expect(readBackupCodes('["legacy01","legacy02"]')).toEqual(['legacy01', 'legacy02']);
  });

  it('null / undefined / bozuk girdi boş liste verir — patlamaz', () => {
    expect({
      yok:   readBackupCodes(undefined),
      bos:   readBackupCodes(null),
      bozuk: readBackupCodes('{bozuk'),
      nesne: readBackupCodes({ a: 1 }),
    }).toEqual({ yok: [], bos: [], bozuk: [], nesne: [] });
  });

  it('nesne/sayı ve aşırı kısa girdiler çalışan yedek koda dönüştürülmez', () => {
    expect(readBackupCodes([{}, 7, 'short', 'valid-old-code'])).toEqual(['valid-old-code']);
  });

  it('SÖMÜRÜ: DİZİ olarak saklanan kod artık KABUL edilir', async () => {
    // Kusurun tam hali. Bu test duzeltmeden ONCE 401 alirdi.
    db._reset?.();
    const kod = 'a1b2c3d4e5f60718';
    const id = uuidv4();
    await db.users.insert({
      _id: id, username: 'u', tokenVersion: 0,
      twoFactorEnabled: true, twoFactorSecret: 'S',
      twoFactorBackup: [hashBackupCode(kod)],   // ← pg surucusunun dondurdugu bicim
    });
    const app = buildApp();
    const challenge = await issueTwoFactorLoginChallenge(id, 0);
    const r = await request(app).post('/api/2fa/check').send({ tempToken: challenge, code: kod });
    expect({ status: r.status, usedBackup: r.body.usedBackup })
      .toEqual({ status: 200, usedBackup: true });
  });

  it('DİZİ temsilinde /status doğru sayıyı bildirir (0 DEĞİL)', async () => {
    db._reset?.();
    const id = uuidv4();
    await db.users.insert({
      _id: id, username: 'u', tokenVersion: 0,
      twoFactorEnabled: true, twoFactorSecret: 'S',
      twoFactorBackup: [hashBackupCode('a'), hashBackupCode('b'), hashBackupCode('c')],
    });
    const app = express();
    app.use(express.json());
    app.use('/api/2fa', authMiddleware, twoFactorRouter);
    const r = await request(app).get('/api/2fa/status')
      .set('Authorization', `Bearer ${tok(id)}`);
    expect({ status: r.status, kalan: r.body.backupRemaining })
      .toEqual({ status: 200, kalan: 3 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GERÇEK DEPOLAMA YOLU — /verify (2FA etkinleştirme)
// ════════════════════════════════════════════════════════════════════════════
// BU BÖLÜM BİR MUTASYONUN HAYATTA KALMASI ÜZERİNE EKLENDİ.
//
// İlk yazdığım "veritabanında düz metin bulunmaz" testi, özetleri KENDİSİ
// ekleyip sonra düz metin aramıyordu — yani kendi kurgusunu doğruluyordu,
// üretimin YAZMA satırını hiç çalıştırmıyordu. Depolamayı düz metne geri
// çeviren mutasyon bu yüzden HAYATTA KALDI: tam olarak bu programda avladığım
// içi boş test kalıbı, kendi testimde.
//
// Aşağıdaki testler gerçek `/verify` ucunu sürerek YAZMA satırını çalıştırır.
// Geçerli TOTP, üretimin KENDİ `totpNow` fonksiyonuyla üretilir (test içinde
// ikinci bir HOTP uygulaması yazmak, kaçındığımız kopya-uygulama hatasıdır).
describe('POST /api/2fa/verify — gerçek depolama yolu', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';

  async function enable() {
    db._reset?.();
    const id = uuidv4();
    await db.users.insert({
      _id: id, username: 'u', displayName: 'U', tokenVersion: 0,
      twoFactorEnabled: false, twoFactorSecret: SECRET, twoFactorBackup: '[]',
    });
    const app = express();
    app.use(express.json());
    app.use('/api/2fa', authMiddleware, twoFactorRouter);
    const gecerli = totpNow(SECRET)[1];              // mevcut zaman penceresi
    const r = await request(app).post('/api/2fa/verify')
      .set('Authorization', `Bearer ${tok(id)}`).send({ code: gecerli });
    return { id, r };
  }

  it('etkinleştirme BAŞARILI ve düz metin kodlar KULLANICIYA döner', async () => {
    const { r } = await enable();
    expect({ status: r.status, adet: (r.body.backupCodes || []).length })
      .toEqual({ status: 200, adet: 8 });
  });

  it('DİSKE yazılan değer ÖZETTİR — düz metin kod SIZMAZ', async () => {
    // Mutasyonu olduren asil iddia: uretimin YAZMA satirini calistirir.
    const { id, r } = await enable();
    const kodlar: string[] = r.body.backupCodes;
    const saklanan = JSON.stringify((await requireDoc(db.users, { _id: id })).twoFactorBackup);
    expect({ sizan: kodlar.filter(k => saklanan.includes(k)) }).toEqual({ sizan: [] });
  });

  it('saklanan her giriş 64 karakterlik SHA-256 özetidir', async () => {
    const { id } = await enable();
    const saklanan = readBackupCodes((await requireDoc(db.users, { _id: id })).twoFactorBackup);
    expect({
      adet: saklanan.length,
      hepsiOzet: saklanan.every(v => /^[a-f0-9]{64}$/.test(v)),
    }).toEqual({ adet: 8, hepsiOzet: true });
  });

  it('dönen düz metin kod GERÇEKTEN /check ile çalışır (uçtan uca)', async () => {
    // Pozitif kontrol: ozetleme kullaniciyi kendi kodundan ETMEMELI.
    const { id, r } = await enable();
    const kod = r.body.backupCodes[0];
    const app2 = buildApp();
    const afterEnable = await requireDoc(db.users, { _id: id });
    const challenge = await issueTwoFactorLoginChallenge(id, Number(afterEnable.tokenVersion || 0));
    const c = await request(app2).post('/api/2fa/check').send({ tempToken: challenge, code: kod });
    expect({ status: c.status, usedBackup: c.body.usedBackup, kalan: c.body.remaining })
      .toEqual({ status: 200, usedBackup: true, kalan: 7 });
  });
});


// ============================================================================
// SABIT ZAMANLI KARSILASTIRMA
// ============================================================================
// Bu blok bir MUTASYON KAMPANYASI bulgusundan dogdu: `crypto.timingSafeEqual`
// cagrisi `ab.equals(bb)` ile degistirildiginde bu dosyadaki TUM testler
// gecmeye devam etti. Yani sabit zamanli karsilastirma HIC dogrulanmiyordu.
//
// Davranis acisindan ikisi ayni sonucu verir; fark YALNIZCA zamanlamadadir.
// `Buffer.equals` ilk farkli baytta cikar, `timingSafeEqual` cikmaz. Yedek
// kodlar dogrulanirken erken cikis, saldirganin kodu baytt bayt aramasina
// izin verir.
//
// ── NEDEN SURE OLCULMUYOR ───────────────────────────────────────────────────
// Zamanlama esigine dayali bir test mesgul bir makinede FLAKE uretir ve
// gevsetile gevsetile anlamsizlasir. Bunun yerine sabit zamanli ilkelin
// GERCEKTEN CAGRILDIGI dogrulanir — deterministik ve mutasyonu oldurur.
describe('yedek kod karsilastirmasi sabit zamanlidir', () => {
  it('esit uzunlukta DOGRU kod icin timingSafeEqual kullanilir', () => {
    const casus = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      const saklanan = crypto.createHash('sha256').update('kod-1234', 'utf8').digest('hex');
      expect(backupCodeMatches('kod-1234', saklanan)).toBe(true);
      expect(casus).toHaveBeenCalled();
    } finally { casus.mockRestore(); }
  });

  it('esit uzunlukta YANLIS kod icin de timingSafeEqual kullanilir', () => {
    // Asil onemli durum budur: zamanlama saldirisi BASARISIZ karsilastirmalar
    // uzerinden yurutulur. Erken cikis burada olursa sizinti burada olur.
    const casus = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      const saklanan = crypto.createHash('sha256').update('dogru-kod', 'utf8').digest('hex');
      expect(backupCodeMatches('yanlis-kod', saklanan)).toBe(false);
      expect(casus).toHaveBeenCalled();
    } finally { casus.mockRestore(); }
  });
});
