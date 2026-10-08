// server/tests/twofactor-disable-authz.test.ts
//
// 2FA DEVRE DIŞI BIRAKMA — YETKİLENDİRME
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK (P1) — PAROLA HİÇ DOĞRULANMIYORDU
// ════════════════════════════════════════════════════════════════════════════
// `POST /api/2fa/disable` ("eski istemciler için uyumluluk sarmalayıcısı")
// şunu yapıyordu:
//
//     const { password } = req.body;
//     if (!password) return res.status(400).json({ error: 'password required' });
//     ...
//     await Users.update(user._id, { twoFactorEnabled: 0, ... });   // KAPATIR
//
// Parolanın VAR OLUP OLMADIĞINA bakıyor, DOĞRU OLUP OLMADIĞINA bakmıyordu.
// `bcrypt` bu dosyada yalnızca YORUMLARDA geçiyor — hiç import edilmemiş,
// hiç çağrılmamış.
//
// ── NEDEN P1 ────────────────────────────────────────────────────────────────
// 2FA tam olarak "parola veya oturum ele geçirildi" senaryosu için vardır.
// Çalınmış bir erişim jetonu `{"password":"herhangi"}` göndererek ikinci
// faktörü kapatabiliyorsa, 2FA kendisini savunmak için var olduğu saldırgana
// karşı hiçbir şey yapmıyor demektir. Üstelik aynı çağrı `twoFactorSecret`
// ve `twoFactorBackup` alanlarını da siliyor — meşru kullanıcının kurtarma
// kodları da yok oluyor.
//
// ── KARDEŞ YOL ASİMETRİSİ ───────────────────────────────────────────────────
// Kardeşi `DELETE /api/2fa` GEÇERLİ BİR TOTP KODU istiyordu. Aynı işlem, iki
// uç, iki farklı güvenlik seviyesi. Bu projede tekrar tekrar gerçek açık
// üreten desenin ta kendisi.

import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_q: Request, _s: Response, n: NextFunction) => n(),
  limits: new Proxy({}, { get: () => () => (_q: Request, _s: Response, n: NextFunction) => n() }),
}));

import db from '../db/loader';
import { authMiddleware } from '../middleware/auth';
import twoFactorRouter, { __totpNowForTest as totpNow } from '../routes/twoFactor';
import { stepUpFor } from './helpers/stepUp';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/2fa', authMiddleware, twoFactorRouter);
  return app;
}
const app = buildApp();

// ── SURE SINIRI: BU PAKET CPU-BAGIMLIDIR, GECIKME OLCMEZ ────────────────────
// Her senaryo bir `bcrypt.hash(..., 10)` ile kullanici tohumlar, uc
// (endpoint) ise ayrica `bcrypt.compare` calistirir. Bu KASITLI olarak
// pahalidir; parola dogrulamasinin maliyeti guvenligin kendisidir.
//
// Jest paketleri paralel kostugunda ayni CPU'yu paylasan bu isler varsayilan
// 10 sn'lik siniri asabiliyor. Olculen sey YETKILENDIRME DAVRANISI'dir
// (yanlis parola 2FA'yi kapatamaz), gecikme DEGIL. Sinir bu yuzden gercek
// ise gore yukseltilir; bcrypt maliyeti DUSURULMEZ.
jest.setTimeout(60_000);

const SECRET  = 'JBSWY3DPEHPK3PXP';
const PAROLA  = 'gercekParola123';
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

async function seed2fa() {
  (db as unknown as { _reset?: () => void })._reset?.();
  const id = uuidv4();
  await (db as unknown as { users: { insert: (d: unknown) => Promise<unknown> } }).users.insert({
    _id: id, username: 'u', displayName: 'U', tokenVersion: 0,
    password: await bcrypt.hash(PAROLA, 10),
    twoFactorEnabled: true, twoFactorSecret: SECRET,
    twoFactorBackup: JSON.stringify(['a'.repeat(64)]),
  });
  return { id, token: tok(id) };
}

const oku = async (id: string) =>
  (db as unknown as { users: { findOne: (q: unknown) => Promise<Record<string, unknown>> } })
    .users.findOne({ _id: id });

// ════════════════════════════════════════════════════════════════════════════
// SÖMÜRÜ — gerileme kilidi
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/2fa/disable — parola doğrulaması', () => {
  it('SÖMÜRÜ: YANLIŞ parola 2FA’yı KAPATAMAZ', async () => {
    // Duzeltmeden ONCE bu istek 200 donuyor ve 2FA'yi kapatiyordu.
    const { id, token } = await seed2fa();
    const r = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).set(stepUpFor(token, 'account-security'))
      .send({ password: 'tamamenYanlisParola' });

    const u = await oku(id);
    expect({ status: r.status, hala2faAcik: !!u.twoFactorEnabled })
      .toEqual({ status: 400, hala2faAcik: true });
  });

  it('YANLIŞ parola sonrası SECRET ve YEDEK KODLAR korunur', async () => {
    // Basarisiz deneme kullaniciyi kurtarma kodlarindan ETMEMELI.
    const { id, token } = await seed2fa();
    await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).set(stepUpFor(token, 'account-security'))
      .send({ password: 'yanlis' });

    const u = await oku(id);
    expect({
      secretVar: typeof u.twoFactorSecret === 'string' && u.twoFactorSecret.length > 0,
      yedekVar:  String(u.twoFactorBackup ?? '[]') !== '[]',
    }).toEqual({ secretVar: true, yedekVar: true });
  });

  it('BOŞ parola reddedilir', async () => {
    const { token } = await seed2fa();
    const r = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).set(stepUpFor(token, 'account-security')).send({ password: '' });
    expect(r.status).toBe(400);
  });

  it('parola ALANI HİÇ yoksa reddedilir', async () => {
    const { token } = await seed2fa();
    const r = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).set(stepUpFor(token, 'account-security')).send({});
    expect(r.status).toBe(400);
  });

  it('kimlik doğrulaması OLMADAN erişilemez', async () => {
    const r = await request(app).post('/api/2fa/disable').send({ password: PAROLA });
    expect(r.status).toBe(401);
  });

  it('2FA zaten KAPALIYSA 400 döner', async () => {
    (db as unknown as { _reset?: () => void })._reset?.();
    const id = uuidv4();
    await (db as unknown as { users: { insert: (d: unknown) => Promise<unknown> } }).users.insert({
      _id: id, username: 'v', tokenVersion: 0,
      password: await bcrypt.hash(PAROLA, 10), twoFactorEnabled: false,
    });
    const r = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${tok(id)}`).set(stepUpFor(tok(id), 'account-security')).send({ password: PAROLA });
    expect(r.status).toBe(400);
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  it('POZİTİF KONTROL: DOĞRU parola 2FA’yı kapatır', async () => {
    // Bu olmadan yukaridaki testler "her zaman reddet" gibi asiri genis bir
    // yamada da yesil kalirdi — ve kullanici 2FA'yi HIC kapatamazdi.
    const { id, token } = await seed2fa();
    const r = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).set(stepUpFor(token, 'account-security')).send({ password: PAROLA });

    const u = await oku(id);
    expect({ status: r.status, kapandi: !u.twoFactorEnabled })
      .toEqual({ status: 200, kapandi: true });
  });

  it('başarılı kapatmada secret ve yedek kodlar TEMİZLENİR', async () => {
    const { id, token } = await seed2fa();
    await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).set(stepUpFor(token, 'account-security')).send({ password: PAROLA });
    const u = await oku(id);
    expect({ secret: u.twoFactorSecret, yedek: String(u.twoFactorBackup) })
      .toEqual({ secret: null, yedek: '[]' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KARDEŞ YOL — DELETE /api/2fa
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/2fa — kardeş yol TOTP ister', () => {
  it('GEÇERSİZ kod 2FA’yı kapatamaz', async () => {
    const { id, token } = await seed2fa();
    const r = await request(app).delete('/api/2fa')
      .set('Authorization', `Bearer ${token}`).send({ code: '000000' });
    const u = await oku(id);
    expect({ status: r.status, hala: !!u.twoFactorEnabled })
      .toEqual({ status: 400, hala: true });
  });

  it('POZİTİF KONTROL: GEÇERLİ TOTP 2FA’yı kapatır', async () => {
    const { id, token } = await seed2fa();
    const gecerli = totpNow(SECRET)[1];       // mevcut zaman penceresi
    const r = await request(app).delete('/api/2fa')
      .set('Authorization', `Bearer ${token}`).send({ code: gecerli });
    const u = await oku(id);
    expect({ status: r.status, kapandi: !u.twoFactorEnabled })
      .toEqual({ status: 200, kapandi: true });
  });

  it('İKİ uç da AYNI güvenlik seviyesini uygular', async () => {
    // Asimetrinin kendisi bulguydu: bir uc dogrulama yapmiyordu.
    const a = await seed2fa();
    const ra = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${a.token}`).set(stepUpFor(a.token, 'account-security')).send({ password: 'yanlis' });

    const b = await seed2fa();
    const rb = await request(app).delete('/api/2fa')
      .set('Authorization', `Bearer ${b.token}`).send({ code: '000000' });

    expect({ disable: ra.status, del: rb.status }).toEqual({ disable: 400, del: 400 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P7 B2 — SU-ATK-04: a stolen session plus a phished password must not remove
// the second factor. The inline password check stays; a level-2 step-up proof
// (TOTP or backup code) is required in addition.
// ════════════════════════════════════════════════════════════════════════════
describe('P7 B2 — POST /api/2fa/disable needs a level-2 account-security proof', () => {
  it('the right password without a proof, or with a password-level proof, keeps 2FA on', async () => {
    const { id, token } = await seed2fa();
    const none = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).send({ password: PAROLA });
    expect(none.status).toBe(403);
    expect(none.body).toMatchObject({ error: 'STEP_UP_REQUIRED', action: 'two_factor.disable', level: 2, reasons: ['step_up_missing'] });

    const l1 = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).set(stepUpFor(token, 'account-security', 'password')).send({ password: PAROLA });
    expect(l1.status).toBe(403);
    expect(l1.body.reasons).toEqual(['step_up_level']);
    expect(!!(await oku(id)).twoFactorEnabled).toBe(true);

    const l2 = await request(app).post('/api/2fa/disable')
      .set('Authorization', `Bearer ${token}`).set(stepUpFor(token, 'account-security', 'totp')).send({ password: PAROLA });
    expect(l2.status).toBe(200);
    expect(!!(await oku(id)).twoFactorEnabled).toBe(false);
  });

  it('DELETE /api/2fa keeps its own inline TOTP check and needs no separate proof', async () => {
    const { id, token } = await seed2fa();
    const r = await request(app).delete('/api/2fa')
      .set('Authorization', `Bearer ${token}`).send({ code: totpNow(SECRET)[1] });
    expect(r.status).toBe(200);
    expect(!!(await oku(id)).twoFactorEnabled).toBe(false);
  });
});
