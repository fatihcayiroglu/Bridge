// server/routes/twoFactor.ts — TOTP 2FA (speakeasy-compatible)
// speakeasy veya otpauth kütüphanesi olmadan saf TOTP implementasyonu
// RFC 6238 uyumlu — Google Authenticator, Authy, vb. ile çalışır

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import crypto from 'crypto';
import { Users } from '../db/repositories';
import { authMiddleware, makeToken, makeRefreshToken } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import bcrypt from 'bcryptjs';
import { setRefreshCookie } from '../lib/authCookies';
import { setMediaCookie } from '../lib/mediaCookie';
import { sanitizeOwnUser } from '../lib/userUtils';
import { peekTwoFactorLoginChallenge, claimTwoFactorLoginChallenge } from '../lib/twoFactorLoginChallenge';
import { rotateSecuritySession } from '../lib/securitySession';
import { parseTokenVersion } from '../lib/tokenVersion';
import {
  STEP_UP_POLICY,
  isStepUpScope,
  mintSignInGrants,
  mintStepUpGrant,
  recordFailedStepUpProof,
  stepUpProofsLocked,
} from '../lib/stepUp';
import logger from '../lib/logger';

// ── TOTP Implementasyonu (bağımlılıksız) ────────────────────
function base32Decode(str: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const encoded = str;
  const padding = encoded.match(/=+$/)?.[0] ?? '';
  const unpadded = encoded.slice(0, encoded.length - padding.length).toUpperCase();
  if (padding.length > 6 || !/^[A-Z2-7]{16,128}$/.test(unpadded)) {
    throw new TypeError('Invalid persisted TOTP secret');
  }
  str = unpadded;
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of str) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}

function base32Encode(buf: Buffer | Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += alphabet[(val >>> bits) & 31]; } }
  if (bits > 0) out += alphabet[(val << (5 - bits)) & 31];
  while (out.length % 8) out += '=';
  return out;
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { buf[i] = Number(c & 0xffn); c >>= 8n; }
  const hmac  = crypto.createHmac('sha1', key).update(buf).digest();
  // RFC 4226 dinamik kirpma (dynamic truncation).
  // `hmac[i]` indeksli erisimdir ve `noUncheckedIndexedAccess` altinda
  // `number | undefined` doner; ustelik sinir disinda SESSIZCE `undefined`
  // verir. `readUInt8` / `readUInt32BE` KESIN `number` doner ve sinir disinda
  // ACIKCA hata firlatir. `readUInt32BE(offset) & 0x7fffffff`, elle yazilan
  // dort baytlik birlestirmenin birebir aynisidir.
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const code   = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(code % 1_000_000).padStart(6, '0');
}

function totpCandidates(secret: string): Array<{ code: string; step: number }> {
  const t = Math.floor(Date.now() / 1000 / 30);
  // ±1 pencere toleransı
  return [t - 1, t, t + 1].map((step) => ({ code: hotp(secret, step), step }));
}

function totpNow(secret: string): string[] {
  return totpCandidates(secret).map(({ code }) => code);
}

async function generateTotpQrDataUri(otpauthUrl: string): Promise<string> {
  try {
    const mod = await import('qrcode') as unknown as {
      default?: { toDataURL?: (text: string, opts?: Record<string, unknown>) => Promise<string> };
      toDataURL?: (text: string, opts?: Record<string, unknown>) => Promise<string>;
    };
    const toDataURL = mod.default?.toDataURL ?? mod.toDataURL;
    if (typeof toDataURL !== 'function') return '';
    return await toDataURL(otpauthUrl, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
  } catch {
    // qrcode is an optional server dependency. The manual secret + otpauth URL
    // remain usable if an intentionally-minimal install omits optional deps.
    return '';
  }
}

function matchingTotpStep(secret: string, submitted: string): number | null {
  // Prefer the newest matching step in the astronomically unlikely event that
  // adjacent HOTP values collide; recording the highest step remains fail-safe.
  try {
    const matches = totpCandidates(secret).filter(({ code }) => safeEqual(code, submitted));
    return matches.length ? Math.max(...matches.map(({ step }) => step)) : null;
  } catch {
    // Persisted MFA state is security state. A malformed secret must disable
    // this verification attempt, never degrade to HMAC with an empty/partial key.
    return null;
  }
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// ════════════════════════════════════════════════════════════════════════════
// YEDEK KODLAR — KAPATILAN IKI GERCEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Yedek kodlar 2FA'yi TAMAMEN atlar; yani parola ile ESDEGER kimlik
// bilgisidir. Iki sorun vardi:
//
// A) DUZ METIN DEPOLAMA
//    `twoFactorBackup: JSON.stringify(backupCodes)` kodlari OLDUGU GIBI
//    veritabanina yaziyordu. Veritabanini okuyabilen herkes — calinmis bir
//    yedek, SQL enjeksiyonu, kotu niyetli yonetici — HER kullanici icin
//    calisan 2FA atlatma kimlik bilgisi elde ediyordu.
//
// B) 32 BIT ENTROPI
//    `randomBytes(4)` yalnizca 32 bit uretiyordu. Hiz siniri bunu cevrimici
//    kaba kuvvete karsi pratikte koruyordu, ama savunma derinligi icin
//    yetersizdi ve tek bir hiz-siniri hatasi kritik hale gelirdi.
//
// ── NEDEN SHA-256, NEDEN BCRYPT DEGIL ──────────────────────────────────────
// Paralolar DUSUK entropilidir; bu yuzden bcrypt gibi YAVAS bir KDF gerekir.
// Yedek kodlar ise 64 bit KRIPTOGRAFIK RASTGELELIKTIR: bir ozetten geri
// getirmek, ozet hizindan bagimsiz olarak uygulanamazdir. Ustelik dogrulama
// 8 kodun HEPSINE bakmak zorundadir — bcrypt cost 12 ile bu istek basina
// ~2 saniye CPU demekti ve ucuz girdiyle pahali is yaptiran bir DoS yuzeyi
// olurdu. Yuksek entropili jetonlar icin tek gecis SHA-256 dogru primitiftir
// (oturum jetonlarinin ayni sekilde saklanmasinin nedeni de budur).
/**
 * Saklanan yedek kodlari OKUR.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * KAPATILAN GERCEK ACIK (P1) — YEDEK KODLAR HIC CALISMIYORDU
 * ══════════════════════════════════════════════════════════════════════════
 * Eski kod soyleydi:
 *
 *   JSON.parse(typeof user.twoFactorBackup === 'string' ? user.twoFactorBackup : '[]')
 *
 * Ama `twoFactorBackup` sutunu JSONB'dir (db/postgres/schema.ts:32) ve
 * pg surucusu JSONB'yi ZATEN PARSE EDER. Gercek veritabanina karsi olculdu:
 *
 *   SELECT '["abc","def"]'::jsonb  ->  typeof = 'object', Array.isArray = true
 *
 * Yani kosul HER ZAMAN yanlisti ve liste HER ZAMAN bos donuyordu:
 *   • gonderilen her yedek kod 401 aliyordu
 *   • /status her zaman backupRemaining: 0 bildiriyordu
 *   • kimlik dogrulayicisini kaybeden kullanici KALICI OLARAK kilitleniyordu
 *
 * Yedek kodlar tam olarak bu durum icin var olan KURTARMA mekanizmasidir.
 *
 * Artik her iki temsil de kabul edilir: surucunun dondurdugu dizi ve
 * (eski/SQLite yollari icin) JSON dizesi.
 */
function readBackupCodes(raw: unknown): string[] {
  const valid = (v: unknown): v is string => typeof v === 'string' && v.length >= 8 && v.length <= 128;
  if (Array.isArray(raw)) return raw.filter(valid);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(valid) : [];
    } catch { return []; }
  }
  return [];
}

function hashBackupCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim(), 'utf8').digest('hex');
}

/** Sabit zamanli dize karsilastirmasi. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Gonderilen kod, saklanan girdiyle eslesiyor mu?
 *
 * GERIYE DONUK UYUMLULUK: bu duzeltmeden ONCE kaydolmus kullanicilarin
 * kodlari DUZ METIN olarak duruyor. Onlari gecersiz kilmak, kullanicilari
 * kendi hesaplarindan edebilirdi; bu yuzden saklanan deger bir SHA-256
 * ozeti gorunumunde DEGILSE eski duz-metin yolu sabit zamanli olarak
 * denenir. Yeni uretilen her kod ozetlenmis olarak yazilir.
 */
function backupCodeMatches(submitted: string, stored: string): boolean {
  const isHash = /^[a-f0-9]{64}$/i.test(stored);
  return isHash
    ? safeEqual(stored.toLowerCase(), hashBackupCode(submitted))
    : safeEqual(stored, submitted.trim());
}

function generateBackupCodes(n = 8): string[] {
  // 8 bayt = 64 bit entropi (onceden 4 bayt = 32 bit).
  return Array.from({ length: n }, () => crypto.randomBytes(8).toString('hex'));
}

// ── ENDPOINTS ─────────────────────────────────────────────────

// POST /api/2fa/setup — QR kodu üret, secret döndür
/**
 * @openapi
 * /2fa/setup:
 *   post:
 *     tags: [TwoFactor]
 *     summary: 2FA kurulumu başlat (TOTP QR kodu)
 *     responses:
 *       200:
 *         description: QR kodu ve secret
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 secret: { type: string }
 *                 qrCode: { type: string, description: 'data URI' }
 */
router.post('/setup', authMiddleware, limits.twoFactor(), async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.twoFactorEnabled) return res.status(400).json({ error: '2FA already enabled' });

  const secret = generateSecret();
  // Secret'ı geçici olarak kaydet (henüz aktif değil)
  await Users.update(user._id, { twoFactorSecret: secret, twoFactorLastUsedStep: null });

  const issuer   = encodeURIComponent(process.env.INSTANCE_NAME || 'Bridge');
  const account  = encodeURIComponent(user.username);
  const otpauthUrl = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

  const qrCode = await generateTotpQrDataUri(otpauthUrl);
  res.json({ secret, otpauthUrl, qrCode });
});

// POST /api/2fa/verify — Kurulum sonrası ilk doğrulama + aktifleştirme
/**
 * @openapi
 * /2fa/verify:
 *   post:
 *     tags: [TwoFactor]
 *     summary: 2FA kodu doğrulayarak aktifleştir
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string, example: '123456' }
 *     responses:
 *       200: { description: 2FA aktifleştirildi }
 *       400: { description: Geçersiz kod }
 */
router.post('/verify', authMiddleware, limits.twoFactor(), async (req, res) => {
  const _u = castAuthed(req).user;
  const code = (req.body as Record<string, unknown> | null | undefined)?.code;
  if (typeof code !== 'string' || code.length < 1 || code.length > 128)
    return res.status(400).json({ error: 'code required' });

  const user = await Users.findById(_u.id);
  if (!user?.twoFactorSecret) return res.status(400).json({ error: 'Run /setup first' });
  if (user.twoFactorEnabled) return res.status(400).json({ error: '2FA already active' });

  const matchedStep = matchingTotpStep(user.twoFactorSecret, code.trim());
  if (matchedStep === null) return res.status(400).json({ error: 'Invalid code. Check your authenticator app.' });

  const backupCodes = generateBackupCodes();
  const enabled = await Users.enableTwoFactorWithStep(
    user._id,
    user.twoFactorSecret,
    matchedStep,
    backupCodes.map(hashBackupCode),
  );
  if (!enabled) return res.status(409).json({ error: '2FA setup was already completed or replaced' });
  const rotated = await rotateSecuritySession(user._id, res, 'two_factor_enabled');

  res.json({ ok: true, token: rotated.token, backupCodes,
    message: 'Save these backup codes safely. They cannot be shown again.' });
});

// POST /api/2fa/check — Login sırasında kod kontrolü
/**
 * @openapi
 * /2fa/check:
 *   post:
 *     tags: [TwoFactor]
 *     summary: Giriş sırasında 2FA kodu kontrol et
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tempToken, code]
 *             properties:
 *               tempToken: { type: string }
 *               code: { type: string }
 *     responses:
 *       200:
 *         description: Doğrulama başarılı — JWT token döner
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string }
 *       401: { description: Geçersiz kod }
 */
router.post('/check', limits.twoFactor(), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { tempToken, code } = body;
  if (typeof tempToken !== 'string' || tempToken.length < 32 || tempToken.length > 128
      || typeof code !== 'string' || code.length < 1 || code.length > 128)
    return res.status(400).json({ error: 'tempToken and code required' });

  const challenge = await peekTwoFactorLoginChallenge(tempToken);
  if (!challenge) return res.status(401).json({ error: 'Invalid or expired two-factor challenge' });

  const user = await Users.findById(challenge.userId);
  if (!user?.twoFactorEnabled || parseTokenVersion(user.tokenVersion) !== challenge.tokenVersion) {
    return res.status(401).json({ error: 'Invalid or expired two-factor challenge' });
  }

  const trimmed = code.trim().replace(/\s/g, '');
  let usedBackup = false;
  let remaining: number | undefined;
  let backupHashToConsume: string | null = null;
  let totpStepToConsume: number | null = null;

  if (typeof user.twoFactorSecret === 'string' && (totpStepToConsume = matchingTotpStep(user.twoFactorSecret, trimmed)) !== null) {
    // The login challenge and TOTP step are independently one-use. Claim the
    // challenge first, then atomically claim the durable step below.
  } else {
    const backups = readBackupCodes(user.twoFactorBackup);
    const idx = backups.findIndex(stored => backupCodeMatches(trimmed, stored));
    if (idx === -1) return res.status(401).json({ error: 'Invalid 2FA code' });
    // Do not burn a recovery code until this request has won the one-time
    // login challenge. Two concurrent valid codes for the same challenge must
    // consume at most the code belonging to the single winning request.
    const storedHash = backups[idx];
    // `findIndex` -1 dondurmediyse oge vardir; yine de kontrol edilir ki
    // indeksli erisimin `undefined` ihtimali SESSIZCE gecmesin.
    if (storedHash === undefined) return res.status(401).json({ error: 'Invalid 2FA code' });
    backupHashToConsume = storedHash;
    usedBackup = true;
    remaining = backups.length - 1;
  }

  const claimed = await claimTwoFactorLoginChallenge(tempToken);
  if (!claimed || claimed.userId !== user._id || claimed.tokenVersion !== parseTokenVersion(user.tokenVersion)) {
    return res.status(401).json({ error: 'Two-factor challenge already used or expired' });
  }

  if (backupHashToConsume) {
    const wonBackup = await Users.consumeBackupCode(user._id, backupHashToConsume);
    if (!wonBackup) return res.status(401).json({ error: 'Invalid 2FA code' });
  } else if (totpStepToConsume !== null) {
    const wonStep = await Users.consumeTotpStep(user._id, totpStepToConsume);
    if (!wonStep) return res.status(401).json({ error: 'TOTP code was already used' });
  }

  await Users.setStatus(user._id, 'online');
  const token = makeToken(user);
  const refreshToken = await makeRefreshToken(user);
  setRefreshCookie(res, refreshToken);
  setMediaCookie(res, user);

  return res.json({
    ok: true,
    token,
    user: sanitizeOwnUser({ ...user, status: 'online' }),
    // The second factor was just demonstrated: level-2 step-up grants (P7 B2).
    stepUp: mintSignInGrants(user, usedBackup ? 'backup_code' : 'totp'),
    ...(usedBackup ? { usedBackup: true, remaining } : {}),
  });
});

// POST /api/2fa/step-up — P7 B2: prove the second factor again for one scope
/**
 * @openapi
 * /2fa/step-up:
 *   post:
 *     tags: [TwoFactor]
 *     summary: Step-up proof with a TOTP or backup code (level 2) for one action scope
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, scope]
 *             properties:
 *               code: { type: string }
 *               scope: { type: string, enum: [account-security, sensitive-export, destructive-admin, moderation-burst] }
 *     responses:
 *       200: { description: 'Step-up grant for the scope (keep in memory only)' }
 *       400: { description: 'Invalid code, scope, or 2FA not enabled' }
 *       429: { description: 'Too many failed step-up proofs; sign in again or wait' }
 *       503: { description: 'Failed-proof counter unavailable' }
 */
// ════════════════════════════════════════════════════════════════════════════
// The same verifier and replay protection as `/check`: a TOTP step is consumed
// atomically (`consumeTotpStep`), a backup code is burned (`consumeBackupCode`).
// A wrong, replayed or already-used code counts toward the account's
// failed-proof lock; the lock never applies to `/check` (sign-in) or password
// reset, so it cannot be used to keep the owner out.
router.post('/step-up', authMiddleware, limits.twoFactor(), async (req, res) => {
  const _u = castAuthed(req).user;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { code, scope } = body;
  if (!isStepUpScope(scope)) return res.status(400).json({ error: 'scope required' });
  if (typeof code !== 'string' || code.length < 1 || code.length > 128)
    return res.status(400).json({ error: 'code required' });

  const user = await Users.findById(_u.id);
  if (!user?.twoFactorEnabled) return res.status(400).json({ error: '2FA not enabled' });

  const refuse = async (): Promise<void> => {
    const locked = await recordFailedStepUpProof(user._id);
    res.status(400).json({ error: 'STEP_UP_PROOF_INVALID', locked });
  };

  try {
    if (await stepUpProofsLocked(user._id)) {
      return res.status(429).json({ error: 'STEP_UP_LOCKED', retryAfterMs: STEP_UP_POLICY.failedProof.windowMs, methods: ['sign_in'] });
    }
    const trimmed = code.trim().replace(/\s/g, '');
    const step = typeof user.twoFactorSecret === 'string' ? matchingTotpStep(user.twoFactorSecret, trimmed) : null;
    let method: 'totp' | 'backup_code' = 'totp';
    let remaining: number | undefined;
    if (step !== null) {
      if (!await Users.consumeTotpStep(user._id, step)) return await refuse();
    } else {
      const backups = readBackupCodes(user.twoFactorBackup);
      const stored = backups.find(candidate => backupCodeMatches(trimmed, candidate));
      if (stored === undefined || !await Users.consumeBackupCode(user._id, stored)) return await refuse();
      method = 'backup_code';
      remaining = backups.length - 1;
    }
    const grant = mintStepUpGrant(user, method, scope);
    logger.info({ userId: user._id, scope, method, event: 'step_up.granted' }, 'Step-up proof accepted');
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, stepUp: grant, ...(method === 'backup_code' ? { usedBackup: true, remaining } : {}) });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), userId: user._id, event: 'step_up.proof_unavailable' }, 'Step-up proof could not be checked');
    return res.status(503).json({ error: 'STEP_UP_UNAVAILABLE' });
  }
});

// POST /api/2fa/disable — legacy compatibility wrapper for clients/tests that
// still call the old endpoint instead of DELETE /api/2fa.
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK ACIK (P1) — PAROLA HIC DOGRULANMIYORDU
// ════════════════════════════════════════════════════════════════════════════
// Eski kod yalnizca parolanin VAR OLUP OLMADIGINA bakiyordu:
//
//     if (!password) return res.status(400).json({ error: 'password required' });
//     ... await Users.update(user._id, { twoFactorEnabled: 0, ... });
//
// Yani `{"password":"herhangi"}` ile 2FA KAPANIYORDU. `bcrypt` bu dosyada
// yalnizca yorumlarda geciyordu — hic import edilmemis, hic cagrilmamisti.
//
// NEDEN P1: 2FA tam olarak "parola veya oturum ele gecirildi" senaryosu icin
// vardir. Calinmis bir erisim jetonu ikinci faktoru kapatabiliyorsa, 2FA
// kendisini savunmak icin var oldugu saldirgana karsi hicbir sey yapmiyordu.
// Ustelik ayni cagri `twoFactorSecret` ve `twoFactorBackup` alanlarini da
// siliyordu — mesru kullanicinin kurtarma kodlari da yok oluyordu.
//
// KARDES YOL: `DELETE /api/2fa` GECERLI BIR TOTP KODU istiyordu. Ayni islem,
// iki uc, iki farkli guvenlik seviyesi — bu projede tekrar tekrar gercek acik
// ureten desen.
router.post('/disable', authMiddleware, limits.twoFactor(), async (req, res) => {
  const _u = castAuthed(req).user;
  const password = (req.body as Record<string, unknown> | null | undefined)?.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 128)
    return res.status(400).json({ error: 'password required' });
  const user = await Users.findById(_u.id);
  if (!user?.twoFactorEnabled) return res.status(400).json({ error: '2FA not enabled' });

  // PAROLA GERCEKTEN DOGRULANIR. Hata mesaji kasitli olarak GENELDIR:
  // "parola yanlis" ile "2FA kapali" ayrimi bir numaralandirma ipucu verirdi.
  const gecerli = await bcrypt.compare(password, String(user.password ?? ''));
  if (!gecerli) return res.status(400).json({ error: 'Invalid credentials' });

  await Users.update(user._id, { twoFactorEnabled: 0, twoFactorSecret: null, twoFactorBackup: '[]', twoFactorLastUsedStep: null });
  const rotated = await rotateSecuritySession(user._id, res, 'two_factor_disabled');
  return res.json({ ok: true, token: rotated.token, message: '2FA disabled' });
});

// POST /api/2fa/backup-codes/regenerate — yedek kodlari yenile
/**
 * @openapi
 * /2fa/backup-codes/regenerate:
 *   post:
 *     tags: [TwoFactor]
 *     summary: Yedek kodlari yeniden uret (eskiler gecersizlesir)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string }
 *     responses:
 *       200: { description: 'Yeni yedek kodlar (yalnizca BIR kez donulur)' }
 *       400: { description: 'Parola gerekli / gecersiz / 2FA kapali' }
 */
// ════════════════════════════════════════════════════════════════════════════
// YEDEK KOD YENILEME
// ════════════════════════════════════════════════════════════════════════════
// Kullanicinin kodlari tukendiginde veya sizdigindan suphelendiginde yeni set
// alabilmesi gerekir. Bu uc EKLENENE KADAR istemcide yenileme yapmanin hicbir
// yolu yoktu (BACKEND_GAP).
//
// PARALEL BIR KURTARMA MIMARISI KURULMAZ: ayni uretec, ayni ozetleme ve ayni
// depolama bicimi kullanilir — yalnizca `/verify` icindeki kayit adiminin
// yeniden calistirilmasidir.
//
// ── GUVENLIK ────────────────────────────────────────────────────────────────
// * kimlik dogrulanmis oturum SART (authMiddleware)
// * 2FA zaten ACIK olmali — kapaliyken kod uretmek anlamsiz ve yaniltici olur
// * PAROLA yeniden dogrulanir; `/disable` ile AYNI hassas-eylem sozlesmesi
// * hata mesaji GENELDIR (parola yanlis / 2FA kapali ayrimi numaralandirma
//   ipucu verirdi) — `/disable` ile ayni gerekce
// * diske YALNIZCA ozet yazilir; duz metin yalnizca BU yanitta bir kez doner
// * duz metin loglanmaz
//
// ── ES ZAMANLILIK ───────────────────────────────────────────────────────────
// Iki es zamanli yenileme ayni satirin TEK kolonunu yazar; son yazan kazanir.
// Bu nedenle sonucta TEK bir kanonik set kalir ve digerinin kodlari gecersiz
// olur. "Iki bagimsiz gecerli set" durumu OLUSAMAZ — istenen degismez budur.
router.post('/backup-codes/regenerate', authMiddleware, limits.twoFactor(), async (req, res) => {
  const _u = castAuthed(req).user;
  const password = (req.body as Record<string, unknown> | null | undefined)?.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 128)
    return res.status(400).json({ error: 'password required' });

  const user = await Users.findById(_u.id);
  if (!user?.twoFactorEnabled) return res.status(400).json({ error: '2FA not enabled' });

  const gecerli = await bcrypt.compare(password, String(user.password ?? ''));
  if (!gecerli) return res.status(400).json({ error: 'Invalid credentials' });

  const backupCodes = generateBackupCodes();
  await Users.update(user._id, {
    // ESKI SET ATILIR: kolon tamamen degistirilir, birlestirilmez.
    twoFactorBackup: JSON.stringify(backupCodes.map(hashBackupCode)),
  });
  const rotated = await rotateSecuritySession(user._id, res, 'two_factor_backup_codes_regenerated');

  return res.json({
    ok: true,
    token: rotated.token,
    backupCodes,
    message: 'Previous backup codes are no longer valid. Save these safely; they cannot be shown again.',
  });
});

// DELETE /api/2fa — 2FA'yı kaldır
/**
 * @openapi
 * /2fa:
 *   delete:
 *     tags: [TwoFactor]
 *     summary: 2FA'yı devre dışı bırak
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string }
 *     responses:
 *       200: { description: 2FA devre dışı bırakıldı }
 */
router.delete('/', authMiddleware, limits.twoFactor(), async (req, res) => {
  const _u = castAuthed(req).user;
  const code = (req.body as Record<string, unknown> | null | undefined)?.code;
  if (typeof code !== 'string' || code.length < 1 || code.length > 128)
    return res.status(400).json({ error: 'Invalid code' });
  const user = await Users.findById(_u.id);
  if (!user?.twoFactorEnabled) return res.status(400).json({ error: '2FA not enabled' });

  const matchedStep = typeof user.twoFactorSecret === 'string'
    ? matchingTotpStep(user.twoFactorSecret, code.trim())
    : null;
  if (matchedStep === null) return res.status(400).json({ error: 'Invalid code' });
  if (!await Users.consumeTotpStep(user._id, matchedStep)) {
    return res.status(400).json({ error: 'Invalid or already-used code' });
  }

  await Users.update(user._id, { twoFactorEnabled: 0, twoFactorSecret: null, twoFactorBackup: '[]', twoFactorLastUsedStep: null });
  const rotated = await rotateSecuritySession(user._id, res, 'two_factor_disabled');
  res.json({ ok: true, token: rotated.token, message: '2FA disabled' });
});

// GET /api/2fa/status
/**
 * @openapi
 * /2fa/status:
 *   get:
 *     tags: [TwoFactor]
 *     summary: 2FA durumu
 *     responses:
 *       200:
 *         description: 2FA durumu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled: { type: boolean }
 */
router.get('/status', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  const backups = readBackupCodes(user?.twoFactorBackup);
  res.json({
    enabled:       !!user?.twoFactorEnabled,
    backupRemaining: backups.length,
  });
});

// ── TEST KANCALARI ──────────────────────────────────────────────────────────
// Saf fonksiyonlar; disari acmak bir guvenlik yuzeyi olusturmaz ve yedek-kod
// entropisi ile disk-uzeri temsilinin DOGRUDAN test edilmesini saglar.
export const __hashBackupCodeForTest   = hashBackupCode;
export const __generateBackupCodesForTest = generateBackupCodes;
export const __backupCodeMatchesForTest = backupCodeMatches;
export const __readBackupCodesForTest   = readBackupCodes;
export const __totpNowForTest          = totpNow;
export const __matchingTotpStepForTest = matchingTotpStep;

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
// DIKKAT: yukaridaki `module.exports = router` ES adli-ihraclarini EZER.
// Test kancalari bu yuzden ACIKCA yeniden baglanir.
module.exports.__hashBackupCodeForTest      = hashBackupCode;
module.exports.__generateBackupCodesForTest = generateBackupCodes;
module.exports.__backupCodeMatchesForTest   = backupCodeMatches;
module.exports.__readBackupCodesForTest     = readBackupCodes;
module.exports.__totpNowForTest             = totpNow;
module.exports.__matchingTotpStepForTest    = matchingTotpStep;
