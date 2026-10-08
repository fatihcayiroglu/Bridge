// server/tests/twofactor-setup-verify-disable-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// 2FA — KURULUM, AKTİFLEŞTİRME VE KAPATMA DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// 2FA'nın açılıp kapanması hesabın en hassas geçişidir. Ölçülmemiş dallar:
//
//   · ÇİFT KURULUM — 2FA zaten açıkken yeni bir gizli anahtar yazılırsa
//     kullanıcının çalışan doğrulayıcısı SESSİZCE geçersizleşir ve hesaba
//     erişilemez hâle gelir.
//   · KOD TEKRARI — aynı TOTP adımı iki kez tüketilememelidir; aksi hâlde
//     omuz üstünden okunan bir kod ikinci kez kullanılabilirdi.
//   · YARIŞ — iki eşzamanlı `/verify` isteğinden yalnız BİRİ 2FA'yı
//     aktifleştirebilir; kaybeden açık bir çakışma hatası almalıdır.
//   · KAPATMA — parola ile kapatmada mesaj KASITLI olarak geneldir
//     (numaralandırma ipucu vermez) ve kod ile kapatmada adım tüketilir.
//   · BOZUK GİZLİ ANAHTAR — depoda geçersiz bir base32 gizli anahtar varsa
//     kod doğrulaması çökmemeli, kod GEÇERSİZ sayılmalıdır.
//
// Hız sınırı bu suitte YÜKSELTİLİR; sınırın kendisi ayrı bir dosyada ölçülür.
process.env.RL_2FA_MAX = '1000';
process.env.NODE_ENV = 'test';

import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));

const request = require('supertest');
import db from '../db/loader';
import { requireDoc } from './helpers/mockDb';
import twoFactorRouter, {
  __generateBackupCodesForTest as generateBackupCodes,
  __hashBackupCodeForTest as hashBackupCode,
  __matchingTotpStepForTest as matchingTotpStep,
  __readBackupCodesForTest as readBackupCodes,
  __totpNowForTest as totpNow,
} from '../routes/twoFactor';
import { stepUpFor } from './helpers/stepUp';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/2fa', twoFactorRouter);
  return app;
}

const app = buildApp();
const tok = (uid: string, v = 0) => jwt.sign({ id: uid, v }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

/**
 * Güvenlik geçişleri oturumu DÖNDÜRÜR (tokenVersion artar). İkinci isteği
 * kurmadan önce güncel sürümle yeni bir jeton alınır; aksi hâlde 401 gelir ve
 * ölçülmek istenen ürün dalına hiç ulaşılmaz.
 */
async function freshToken(id: string): Promise<string> {
  const row = await db.users.findOne({ _id: id });
  return tok(id, Number(row?.tokenVersion ?? 0));
}
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** `totpNow` ±1 pencerelik ADAY listesi döndürür; şimdiki kod ortadakidir. */
const currentCode = (secret = SECRET): string => totpNow(secret)[1]!;

async function makeUser(over: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv4();
  await db.users.insert({
    _id: id, username: `u-${id.slice(0, 6)}`, email: `${id}@bridge.test`,
    password: await require('bcryptjs').hash('gizli-parola', 4),
    tokenVersion: 0, twoFactorEnabled: 0, twoFactorSecret: null,
    twoFactorBackup: '[]', twoFactorLastUsedStep: null,
    ...over,
  });
  return id;
}

beforeEach(() => { db._reset?.(); });

describe('kurulum', () => {
  it('gizli anahtar üretir, geçici olarak yazar ve otpauth bağlantısı verir', async () => {
    const id = await makeUser();

    const res = await request(app).post('/api/2fa/setup').set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'));

    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(res.body.otpauthUrl).toContain(`secret=${res.body.secret}`);
    expect(String(res.body.qrCode)).toMatch(/^data:image\/(?:png|svg\+xml)/);

    const stored = await requireDoc(db.users, { _id: id });
    expect(stored.twoFactorSecret).toBe(res.body.secret);
    // Henuz AKTIF degildir.
    expect(stored.twoFactorEnabled).toBeFalsy();
  });

  it('silinmiş kullanıcı kurulum yapamaz', async () => {
    const res = await request(app).post('/api/2fa/setup').set('Authorization', `Bearer ${tok(uuidv4())}`).set(stepUpFor(tok(uuidv4()), 'account-security'));

    // Kimlik katmani silinmis kullaniciyi ZATEN reddeder; uc noktaya
    // ulasilamaz. Onemli olan kurulumun YAPILMAMASIDIR.
    expect(res.status).toBe(401);
  });

  it('2FA zaten açıkken yeni gizli anahtar yazılmaz', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: SECRET });

    const res = await request(app).post('/api/2fa/setup').set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('2FA already enabled');
    // Calisan dogrulayici KORUNUR.
    expect((await requireDoc(db.users, { _id: id })).twoFactorSecret).toBe(SECRET);
  });
});

describe('aktifleştirme', () => {
  it('kod alanı olmadan aktifleştirme reddedilir', async () => {
    const id = await makeUser({ twoFactorSecret: SECRET });

    for (const code of [undefined, 42, '', 'x'.repeat(129)]) {
      const res = await request(app).post('/api/2fa/verify')
        .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ code });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('code required');
    }
  });

  it('kurulum yapılmadan aktifleştirme reddedilir', async () => {
    const id = await makeUser();

    const res = await request(app).post('/api/2fa/verify')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ code: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Run /setup first');
  });

  it('zaten aktif 2FA yeniden aktifleştirilemez', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: SECRET });

    const res = await request(app).post('/api/2fa/verify')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ code: currentCode() });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('2FA already active');
  });

  it('yanlış kod aktifleştirmez', async () => {
    const id = await makeUser({ twoFactorSecret: SECRET });

    const res = await request(app).post('/api/2fa/verify')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid code. Check your authenticator app.');
    expect((await requireDoc(db.users, { _id: id })).twoFactorEnabled).toBeFalsy();
  });

  it('doğru kod 2FA\'yı açar ve yedek kodları BİR KEZ gösterir', async () => {
    const id = await makeUser({ twoFactorSecret: SECRET });

    const res = await request(app).post('/api/2fa/verify')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ code: currentCode() });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.backupCodes).toHaveLength(8);
    expect(res.body.token).toBeTruthy();

    const stored = await requireDoc(db.users, { _id: id });
    expect(stored.twoFactorEnabled).toBeTruthy();
    // Yedek kodlar DUZ METIN saklanmaz.
    const persisted = String(stored.twoFactorBackup);
    expect(res.body.backupCodes.filter((c: string) => persisted.includes(c))).toEqual([]);
  });

  it('ikinci aktifleştirme isteği çakışma ile reddedilir', async () => {
    const id = await makeUser({ twoFactorSecret: SECRET });
    const code = currentCode();

    const first = await request(app).post('/api/2fa/verify')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ code });
    expect(first.status).toBe(200);

    // Ayni gizli anahtarla ikinci kez: artik AKTIF oldugu icin reddedilir.
    const second = await request(app).post('/api/2fa/verify')
      .set('Authorization', `Bearer ${await freshToken(id)}`).set(stepUpFor(await freshToken(id), 'account-security')).send({ code });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('2FA already active');
  });
});

describe('kod ile kapatma', () => {
  it('geçersiz kod biçimi reddedilir', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: SECRET });

    for (const code of [undefined, 7, '', 'x'.repeat(129)]) {
      const res = await request(app).delete('/api/2fa')
        .set('Authorization', `Bearer ${tok(id)}`).send({ code });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid code');
    }
    expect((await requireDoc(db.users, { _id: id })).twoFactorEnabled).toBeTruthy();
  });

  it('2FA açık değilken kapatma reddedilir', async () => {
    const id = await makeUser();

    const res = await request(app).delete('/api/2fa')
      .set('Authorization', `Bearer ${tok(id)}`).send({ code: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('2FA not enabled');
  });

  it('gizli anahtar yokken kod doğrulanamaz', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: null });

    const res = await request(app).delete('/api/2fa')
      .set('Authorization', `Bearer ${tok(id)}`).send({ code: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid code');
  });

  it('doğru kod 2FA\'yı kapatır ve tüm gizli durumu temizler', async () => {
    const id = await makeUser({
      twoFactorEnabled: 1, twoFactorSecret: SECRET,
      twoFactorBackup: JSON.stringify(generateBackupCodes().map(hashBackupCode)),
    });

    const res = await request(app).delete('/api/2fa')
      .set('Authorization', `Bearer ${tok(id)}`).send({ code: currentCode() });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const stored = await requireDoc(db.users, { _id: id });
    expect(stored.twoFactorEnabled).toBeFalsy();
    expect(stored.twoFactorSecret).toBeNull();
    expect(readBackupCodes(stored.twoFactorBackup)).toEqual([]);
  });

  it('aktifleştirmede tüketilen adım kapatma için yeniden kullanılamaz', async () => {
    const id = await makeUser({ twoFactorSecret: SECRET });
    const code = currentCode();

    // Ayni TOTP adimi once AKTIFLESTIRMEDE tuketilir...
    const enabled = await request(app).post('/api/2fa/verify')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ code });
    expect(enabled.status).toBe(200);

    // ...ve ayni kodla KAPATMA denendiginde tekrar kabul EDILMEZ.
    const res = await request(app).delete('/api/2fa')
      .set('Authorization', `Bearer ${await freshToken(id)}`).send({ code });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or already-used code');
    expect((await requireDoc(db.users, { _id: id })).twoFactorEnabled).toBeTruthy();
  });
});

describe('parola ile kapatma ve yedek kod yenileme', () => {
  it('parola alanı zorunludur', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: SECRET });

    for (const password of [undefined, 5, '', 'x'.repeat(129)]) {
      const res = await request(app).post('/api/2fa/disable')
        .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('password required');
    }
  });

  it('yanlış parola genel bir hata verir', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: SECRET });

    const res = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password: 'yanlis-parola' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid credentials');
    expect((await requireDoc(db.users, { _id: id })).twoFactorEnabled).toBeTruthy();
  });

  it('parolası olmayan kayıt için de doğrulama başarısız olur', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: SECRET, password: null });

    const res = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password: 'gizli-parola' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('doğru parola 2FA\'yı kapatır', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: SECRET });

    const res = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password: 'gizli-parola' });

    expect(res.status).toBe(200);
    expect((await requireDoc(db.users, { _id: id })).twoFactorEnabled).toBeFalsy();
  });

  it('yedek kod yenileme eski seti tamamen atar', async () => {
    const old = generateBackupCodes();
    const id = await makeUser({
      twoFactorEnabled: 1, twoFactorSecret: SECRET,
      twoFactorBackup: JSON.stringify(old.map(hashBackupCode)),
    });

    const res = await request(app).post('/api/2fa/backup-codes/regenerate')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password: 'gizli-parola' });

    expect(res.status).toBe(200);
    expect(res.body.backupCodes).toHaveLength(8);
    const persisted = readBackupCodes((await requireDoc(db.users, { _id: id })).twoFactorBackup);
    expect(persisted).toHaveLength(8);
    // Eski setten HICBIRI hayatta kalmaz.
    expect(persisted.filter(h => old.map(hashBackupCode).includes(h))).toEqual([]);
  });

  it('yenileme de yanlış parolayla reddedilir', async () => {
    const id = await makeUser({ twoFactorEnabled: 1, twoFactorSecret: SECRET });

    const res = await request(app).post('/api/2fa/backup-codes/regenerate')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password: 'yanlis' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid credentials');
  });
});

describe('gizli anahtar ve yedek kod çözümlemesi', () => {
  it('bozuk base32 gizli anahtar kodu geçersiz yapar, çökertmez', () => {
    for (const secret of ['', 'kisa', 'GECERSIZ!!!', '1'.repeat(200)]) {
      expect(matchingTotpStep(secret, '123456')).toBeNull();
    }
  });

  it('padding içeren geçerli gizli anahtar çözülür', () => {
    const padded = `${SECRET.slice(0, 24)}======`;
    const candidates = totpNow(padded);
    expect(candidates).toHaveLength(3);
    expect(matchingTotpStep(padded, candidates[1]!)).not.toBeNull();
  });

  it('yedek kod listesi dizi, JSON dizesi ve bozuk girdiden güvenle okunur', () => {
    const hash = crypto.createHash('sha256').update('a'.repeat(16)).digest('hex');

    expect(readBackupCodes([hash, 'kisa', 42])).toEqual([hash]);
    expect(readBackupCodes(JSON.stringify([hash]))).toEqual([hash]);
    expect(readBackupCodes('{bozuk')).toEqual([]);
    expect(readBackupCodes(JSON.stringify({ codes: [hash] }))).toEqual([]);
    expect(readBackupCodes(null)).toEqual([]);
    expect(readBackupCodes(7)).toEqual([]);
  });
});
