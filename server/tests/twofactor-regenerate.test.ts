// server/tests/twofactor-regenerate.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// YEDEK KOD YENILEME — GUVENLIK VE DEGISMEZLER
// ════════════════════════════════════════════════════════════════════════════
// Kullanicinin kodlari tukendiginde veya sizdigindan suphelendiginde yeni set
// alabilmesi gerekir. Bu uc eklenene kadar bunun HICBIR yolu yoktu.
//
// ── KORUNAN DEGISMEZLER ─────────────────────────────────────────────────────
// 1. ESKI KODLAR GECERSIZLESIR. Yenileme eski seti korursa, sizdirilmis bir
//    kod sonsuza dek gecerli kalir — yenilemenin var olma sebebi ortadan
//    kalkar.
// 2. PAROLA GERCEKTEN DOGRULANIR. Ele gecirilmis bir OTURUM, parolayi
//    bilmeden kurtarma kodlarini yenileyip kalici erisim uretemez.
// 3. DISKE YALNIZCA OZET yazilir. Duz metin yalnizca yanitta bir kez doner.
// 4. 2FA KAPALIYKEN yenileme YAPILMAZ.
// 5. ES ZAMANLI iki yenileme IKI BAGIMSIZ GECERLI SET uretemez.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';
// ── HIZ SINIRI TEST ORTAMI ICIN YAPILANDIRILIR ──────────────────────────────
// `limits.twoFactor()` varsayilani 5 istek / 5 dakikadir ve IP'ye gore
// anahtarlanir. Bu dosyadaki testlerin hepsi ayni IP'den (127.0.0.1) gelir,
// bu yuzden altinci istekten itibaren 429 doner ve testler "urun bozuk" gibi
// gorunen bir hatayla duser — ilk kosuda tam olarak bu oldu.
//
// SINIR KALDIRILMAZ, yalnizca TEST ORTAMI icin yukseltilir; uretim
// varsayilanina DOKUNULMAZ. Sinirin kendisi ayrica `2fa.spec.ts` icinde
// brute-force testiyle korunmaktadir.
//
// Deger router IMPORT EDILMEDEN once ayarlanmalidir: limit tablosu modul
// yuklenirken okunur.
process.env.RL_2FA_MAX = '1000';

import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const request = require('supertest');
import db from '../db/loader';
import { requireDoc } from './helpers/mockDb';
import twoFactorRouter, {
  __hashBackupCodeForTest as hashBackupCode,
  __readBackupCodesForTest as readBackupCodes,
} from '../routes/twoFactor';
import { stepUpFor } from './helpers/stepUp';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/2fa', twoFactorRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

const PAROLA = 'dogru-parola';
const YOL = '/api/2fa/backup-codes/regenerate';

// NOT: sahte veritabani GERCEK bir bellek ici depodur; `findOne` bir jest
// mock'u DEGILDIR. Ilk yazimda `mockResolvedValue` kullanmaya calistim ve tum
// testler `TypeError` ile dustu. Kayit ekleyip GERI OKUMAK hem dogru hem de
// daha guclu: guncelleme yolunun kendisi calistirilmis olur.
async function kullaniciKur(over: Record<string, unknown> = {}) {
  const id = uuidv4();
  const eskiKodlar = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
  await db.users.insert({
    _id: id,
    username: 'ali-' + id.slice(0, 8),
    password: await bcrypt.hash(PAROLA, 4),
    twoFactorEnabled: 1,
    twoFactorSecret: 'JBSWY3DPEHPK3PXP',
    twoFactorBackup: JSON.stringify(eskiKodlar.map(hashBackupCode)),
    ...over,
  });
  return { id, eskiKodlar };
}

/** Kullanicinin DEPODAKI guncel yedek kod ozetleri. */
async function saklananOzetler(id: string): Promise<string[]> {
  const u = await requireDoc(db.users, { _id: id });
  return readBackupCodes(u?.twoFactorBackup);
}

// ════════════════════════════════════════════════════════════════════════════
describe('yenileme — mutlu yol', () => {
  it('yeni kod seti DONER', async () => {
    const { id } = await kullaniciKur();
    const res = await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: PAROLA }).expect(200);

    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.backupCodes)).toBe(true);
    expect(res.body.backupCodes).toHaveLength(8);
  });

  it('donen kodlar 64 BIT entropili (mevcut politika korunur)', async () => {
    const { id } = await kullaniciKur();
    const res = await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: PAROLA }).expect(200);
    for (const kod of res.body.backupCodes) {
      expect({ uzunluk: kod.length, onaltilik: /^[a-f0-9]+$/.test(kod) })
        .toEqual({ uzunluk: 16, onaltilik: true });
    }
  });

  it('DISKE yalnizca OZET yazilir — duz metin ASLA', async () => {
    const { id } = await kullaniciKur();
    const res = await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: PAROLA }).expect(200);

    const yazilan = JSON.stringify(await saklananOzetler(id));
    for (const kod of res.body.backupCodes) {
      expect(yazilan).not.toContain(kod);                 // duz metin YOK
      expect(yazilan).toContain(hashBackupCode(kod));      // ozet VAR
    }
  });

  it('ESKI kodlar depoda KALMAZ', async () => {
    // Yenilemenin tum anlami budur: sizdirilmis eski kod artik calismamali.
    const { id, eskiKodlar } = await kullaniciKur();
    await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: PAROLA }).expect(200);

    const yazilan = await saklananOzetler(id);
    for (const eski of eskiKodlar) {
      expect(yazilan).not.toContain(hashBackupCode(eski));
    }
  });

  it('yazilan set TAM OLARAK yeni kodlardan olusur (birlestirme YOK)', async () => {
    const { id } = await kullaniciKur();
    const res = await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: PAROLA }).expect(200);

    const yazilan = await saklananOzetler(id);
    expect(yazilan).toHaveLength(8);
    expect(new Set(yazilan)).toEqual(new Set(res.body.backupCodes.map(hashBackupCode)));
  });

  it('2FA DURUMU degistirilmez (yalnizca kodlar yenilenir)', async () => {
    const { id } = await kullaniciKur();
    await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: PAROLA }).expect(200);
    const u = await requireDoc(db.users, { _id: id });
    // Sema BOOLEAN; `pg` gercek boolean dondurur (1/0 OKUNAMAZ).
    expect(u.twoFactorEnabled).toBe(true);
    expect(u.twoFactorSecret).toBe('JBSWY3DPEHPK3PXP');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yenileme — yetkilendirme', () => {
  it('KIMLIKSIZ istek reddedilir', async () => {
    await kullaniciKur();
    await request(buildApp()).post(YOL).send({ password: PAROLA }).expect(401);
  });

  it('PAROLA olmadan reddedilir ve HICBIR yazma yapilmaz', async () => {
    const { id, eskiKodlar } = await kullaniciKur();
    await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({}).expect(400);
    expect(await saklananOzetler(id)).toEqual(eskiKodlar.map(hashBackupCode));
  });

  it.each([123, {}, [], null])('STRING olmayan parola %p bcrypt katmanina ulasmadan reddedilir', async (password) => {
    const { id, eskiKodlar } = await kullaniciKur();
    await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password }).expect(400);
    expect(await saklananOzetler(id)).toEqual(eskiKodlar.map(hashBackupCode));
  });

  it('YANLIS parola reddedilir ve kodlar DEGISMEZ', async () => {
    // Ele gecirilmis bir oturum, parolayi bilmeden kalici kurtarma erisimi
    // uretememelidir.
    const { id, eskiKodlar } = await kullaniciKur();
    const res = await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: 'yanlis-parola' }).expect(400);

    expect(res.body.error).toBe('Invalid credentials');
    expect(res.body).not.toHaveProperty('backupCodes');
    expect(await saklananOzetler(id)).toEqual(eskiKodlar.map(hashBackupCode));
  });

  it('2FA KAPALIYKEN reddedilir', async () => {
    const { id } = await kullaniciKur({ twoFactorEnabled: 0 });
    const res = await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: PAROLA }).expect(400);
    expect(res.body.error).toBe('2FA not enabled');
  });

  it('hata mesaji NUMARALANDIRMA ipucu vermez', async () => {
    // "parola yanlis" ile "2FA kapali" ayirt edilebilseydi, saldirgan
    // hesaplarin 2FA durumunu numaralandirabilirdi. `/disable` ile ayni
    // gerekce.
    const { id } = await kullaniciKur();
    const yanlisParola = await request(buildApp())
      .post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security'))
      .send({ password: 'yanlis' });
    expect(yanlisParola.body.error).toBe('Invalid credentials');
    expect(yanlisParola.body.error).not.toMatch(/2FA|enabled|secret/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yenileme — es zamanlilik', () => {
  it('IKI es zamanli yenileme TEK kanonik set birakir', async () => {
    // Istenen degismez: "iki bagimsiz gecerli set" OLUSAMAZ. Tek kolon
    // yazildigi icin son yazan kazanir ve digerinin kodlari gecersizdir.
    const { id } = await kullaniciKur();
    const app = buildApp();

    const [a, b] = await Promise.all([
      request(app).post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password: PAROLA }),
      request(app).post(YOL).set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password: PAROLA }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const sonSet = new Set(await saklananOzetler(id));
    const aOzet = a.body.backupCodes.map(hashBackupCode);
    const bOzet = b.body.backupCodes.map(hashBackupCode);

    const aGecerli = aOzet.every((h: string) => sonSet.has(h));
    const bGecerli = bOzet.every((h: string) => sonSet.has(h));

    // TAM OLARAK biri gecerli olmali — ikisi birden DEGIL.
    expect(aGecerli !== bGecerli).toBe(true);
  });
});
