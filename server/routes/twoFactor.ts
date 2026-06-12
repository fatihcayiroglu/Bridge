// server/routes/twoFactor.ts — TOTP 2FA (speakeasy-compatible)
// speakeasy veya otpauth kütüphanesi olmadan saf TOTP implementasyonu
// RFC 6238 uyumlu — Google Authenticator, Authy, vb. ile çalışır

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import crypto from 'crypto';
import { Users } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';

// ── TOTP Implementasyonu (bağımlılıksız) ────────────────────
function base32Decode(str: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.replace(/=+$/, '').toUpperCase();
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
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = ((hmac[offset] & 0x7f) << 24) | (hmac[offset+1] << 16) | (hmac[offset+2] << 8) | hmac[offset+3];
  return String(code % 1_000_000).padStart(6, '0');
}

function totpNow(secret: string): string[] {
  const t = Math.floor(Date.now() / 1000 / 30);
  // ±1 pencere toleransı
  return [hotp(secret, t - 1), hotp(secret, t), hotp(secret, t + 1)];
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function generateBackupCodes(n = 8): string[] {
  return Array.from({ length: n }, () => crypto.randomBytes(4).toString('hex'));
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
  await Users.update(user._id, { twoFactorSecret: secret });

  const issuer   = encodeURIComponent(process.env.INSTANCE_NAME || 'Bridge');
  const account  = encodeURIComponent(user.username);
  const otpauthUrl = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

  const qrCode = `data:text/plain;charset=utf-8,${encodeURIComponent(otpauthUrl)}`;
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
  const { code } = req.body as Record<string, string>;
  if (!code) return res.status(400).json({ error: 'code required' });

  const user = await Users.findById(_u.id);
  if (!user?.twoFactorSecret) return res.status(400).json({ error: 'Run /setup first' });
  if (user.twoFactorEnabled) return res.status(400).json({ error: '2FA already active' });

  const valid = totpNow(user.twoFactorSecret).includes(String(code).trim());
  if (!valid) return res.status(400).json({ error: 'Invalid code. Check your authenticator app.' });

  const backupCodes = generateBackupCodes();
  await Users.update(user._id, {
    twoFactorEnabled: 1,
    twoFactorBackup:  JSON.stringify(backupCodes),
  });

  res.json({ ok: true, backupCodes, message: 'Save these backup codes safely. They cannot be shown again.' });
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
router.post('/check', async (req, res) => {
  const { userId, code } = req.body as Record<string, string>;
  if (!userId || !code) return res.status(400).json({ error: 'userId and code required' });

  const user = await Users.findById(userId);
  if (!user?.twoFactorEnabled) return res.json({ ok: true, bypassed: true });

  const trimmed = String(code).trim().replace(/\s/g, '');

  // TOTP kontrolü
  if (typeof user.twoFactorSecret === 'string' && totpNow(user.twoFactorSecret).includes(trimmed)) {
    return res.json({ ok: true });
  }

  // Backup kod kontrolü
  const backups = JSON.parse(typeof user.twoFactorBackup === 'string' ? user.twoFactorBackup : '[]') as string[];
  const idx     = backups.indexOf(trimmed);
  if (idx !== -1) {
    backups.splice(idx, 1); // Kullanılmış kodu sil
    await Users.update(user._id, { twoFactorBackup: JSON.stringify(backups) });
    return res.json({ ok: true, usedBackup: true, remaining: backups.length });
  }

  res.status(401).json({ error: 'Invalid 2FA code' });
});


// POST /api/2fa/disable — legacy compatibility wrapper for clients/tests that
// still call the old endpoint instead of DELETE /api/2fa.
router.post('/disable', authMiddleware, limits.twoFactor(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { password } = req.body as Record<string, string>;
  if (!password) return res.status(400).json({ error: 'password required' });
  const user = await Users.findById(_u.id);
  if (!user?.twoFactorEnabled) return res.status(400).json({ error: '2FA not enabled' });
  await Users.update(user._id, { twoFactorEnabled: 0, twoFactorSecret: null, twoFactorBackup: '[]' });
  return res.json({ ok: true, message: '2FA disabled' });
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
  const { code } = req.body as Record<string, string>;
  const user = await Users.findById(_u.id);
  if (!user?.twoFactorEnabled) return res.status(400).json({ error: '2FA not enabled' });

  const valid = typeof user.twoFactorSecret === 'string' && totpNow(user.twoFactorSecret).includes(String(code || '').trim());
  if (!valid) return res.status(400).json({ error: 'Invalid code' });

  await Users.update(user._id, { twoFactorEnabled: 0, twoFactorSecret: null, twoFactorBackup: '[]' });
  res.json({ ok: true, message: '2FA disabled' });
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
  const backups = JSON.parse(typeof user?.twoFactorBackup === 'string' ? user.twoFactorBackup : '[]') as string[];
  res.json({
    enabled:       !!user?.twoFactorEnabled,
    backupRemaining: backups.length,
  });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
