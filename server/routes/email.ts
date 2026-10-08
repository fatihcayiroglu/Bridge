// server/routes/email.ts — E-posta doğrulama & şifre sıfırlama
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router();
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Users } from '../db/repositories';
import { authMiddleware, revokeAllRefreshTokens, _invalidateTokenCache } from '../middleware/auth';
import { sendVerificationEmail, sendPasswordResetEmail } from '../lib/mailer';
import { limits } from '../middleware/rateLimit';
import logger from '../lib/logger';
import { disconnectLiveUserSessions } from '../lib/sessionRevocation';
import { parseTokenVersion } from '../lib/tokenVersion';
import { isPersistedEpochExpired } from '../lib/persistedEpoch';
import { requireStepUp } from '../lib/stepUp';

/**
 * @openapi
 * /email/add:
 *   post:
 *     summary: E-posta adresi ekle veya değiştir
 *     tags: [Email]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email, maxLength: 254 }
 *     responses:
 *       200:
 *         description: Doğrulama e-postası gönderildi
 *       400:
 *         description: Geçersiz e-posta
 *       403:
 *         description: 'STEP_UP_REQUIRED — a fresh account-security proof is needed (X-Bridge-Step-Up)'
 */
// ── Final21 UX: amaçlı jetonlar ─────────────────────────────────────────────
// Tek `emailToken` sütunu İKİ amaçla yazılıyordu: e-posta doğrulama (24 sa, YENİ
// eklenen ve henüz doğrulanmamış adrese gider) ve şifre sıfırlama. `/reset-password`
// jetonu amacına bakmadan kabul ettiği için bir DOĞRULAMA bağlantısı aynı zamanda bir
// SIFIRLAMA anahtarıydı; `/forgot` da doğrulanmamış adrese sıfırlama gönderiyordu. Yanlış
// ya da başkasına ait bir adres ekleyen kullanıcının hesabı, o adresin sahibine açık
// kalırdı. İstemci bu akışı ilk kez erişilebilir yaptığı için (Ayarlar > Güvenlik >
// Kurtarma e-postası, girişte "Şifremi unuttum") iki kural birlikte gelir:
//   · jeton amacını taşır (`v.` doğrulama, `r.` sıfırlama) ve yalnız kendi ucunda geçer;
//   · sıfırlama YALNIZ doğrulanmış adrese gönderilir ve yalnız doğrulanmış hesapta işler.
const VERIFY_TOKEN_PREFIX = 'v.';
const RESET_TOKEN_PREFIX = 'r.';
function purposeToken(prefix: string): string { return prefix + crypto.randomBytes(32).toString('hex'); }
function isVerifiedEmail(value: unknown): boolean { return value === true || value === 1 || value === '1' || value === 't'; }

// POST /api/email/add — Kullanıcı e-posta ekler/değiştirir
// P7 B2: the recovery address controls password reset, so changing it needs a
// fresh `account-security` step-up proof (a stolen session alone is not enough).
router.post('/add', authMiddleware, limits.email(), requireStepUp('email.change'), async (req, res) => {
  const _u = castAuthed(req).user;
  const emailValue = (req.body as Record<string, unknown> | null | undefined)?.email;
  if (typeof emailValue !== 'string')
    return res.status(400).json({ error: 'Provide a valid email address' });
  const email = emailValue.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Provide a valid email address' });

  const token  = purposeToken(VERIFY_TOKEN_PREFIX);
  const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24 saat

  // Başka hesapta kullanılıyor mu?
  const existing = await Users.findByEmail(email);
  if (existing && existing._id !== _u.id)
    return res.status(400).json({ error: 'This email is already used by another account' });

  await Users.update(_u.id, {
    email,
    emailVerified:  0,
    emailToken:     token,
    emailTokenExp:  expiry,
  });

  const user = await Users.findById(_u.id);
  try {
    await sendVerificationEmail(email, token, user?.username ?? 'user');
    res.json({ ok: true, message: 'Verification email has been sent' });
  } catch (e) {
    logger.error({ err: e, event: 'email.verification.send_failed' }, 'Failed to send verification email.');
    res.json({ ok: true, message: 'Email saved (delivery failed in this environment)' });
  }
});

/**
 * @openapi
 * /email/verify:
 *   get:
 *     summary: E-posta doğrulama linkini işle
 *     tags: [Email]
 *     parameters:
 *       - { name: token, in: query, required: true, schema: { type: string } }
 *     responses:
 *       302:
 *         description: E-posta doğrulandı — uygulamaya yönlendirir (/?email=verified)
 *       400:
 *         description: Geçersiz veya süresi dolmuş token
 */
// GET /api/email/verify?token=... — E-posta doğrulama linki
router.get('/verify', async (req, res) => {
  const token = req.query.token;
  if (typeof token !== 'string' || token.length < 1 || token.length > 256)
    return res.status(400).send('Missing or invalid token');
  if (!token.startsWith(VERIFY_TOKEN_PREFIX)) return res.status(400).send('Invalid or expired link');

  const user = await Users.findByEmailToken(token);
  if (!user) return res.status(400).send('Invalid or expired link');
  try {
    if (isPersistedEpochExpired(user.emailTokenExp))
      return res.status(400).send('Link expired. Request a new one.');
  } catch {
    return res.status(400).send('Invalid or expired link');
  }

  await Users.update(user._id, { emailVerified: 1, emailToken: null, emailTokenExp: null });

  // Kullanıcı uygulamaya döner; sonuç orada kendi dilinde gösterilir. (Eski yanıt İngilizce
  // sabit bir sayfaydı ve satır içi betiği CSP tarafından zaten engelleniyordu.)
  res.redirect(302, '/?email=verified');
});

/**
 * @openapi
 * /email/resend:
 *   post:
 *     summary: Doğrulama e-postasını yeniden gönder
 *     tags: [Email]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: E-posta gönderildi
 *       400:
 *         description: E-posta yok veya zaten doğrulanmış
 */
// POST /api/email/resend — Doğrulama e-postasını yeniden gönder
router.post('/resend', authMiddleware, limits.email(), async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.email) return res.status(400).json({ error: 'No email is set for this account' });
  if (user.emailVerified) return res.status(400).json({ error: 'Email is already verified' });

  const token  = purposeToken(VERIFY_TOKEN_PREFIX);
  const expiry = Date.now() + 24 * 60 * 60 * 1000;
  await Users.update(user._id, { emailToken: token, emailTokenExp: expiry });

  try {
    await sendVerificationEmail(user.email, token, user.username);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true, devNote: 'Check server console for email content' });
  }
});

/**
 * @openapi
 * /email/forgot:
 *   post:
 *     summary: Şifre sıfırlama e-postası gönder
 *     tags: [Email]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email, maxLength: 254 }
 *     responses:
 *       200:
 *         description: İstek alındı (enumeration önleme)
 */
// POST /api/email/forgot — Şifre sıfırlama talebi
router.post('/forgot', async (req, res) => {
  const emailValue = (req.body as Record<string, unknown> | null | undefined)?.email;
  // Güvenlik: malformed/missing input dahil her zaman aynı dış yanıtı döndür.
  // Geçersiz girdilerde repository/provider çağrısı yapma.
  if (typeof emailValue !== 'string')
    return res.json({ ok: true, message: 'If the address exists, a reset email has been sent' });
  const email = emailValue.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.json({ ok: true, message: 'If the address exists, a reset email has been sent' });

  const user = await Users.findByEmail(email);
  // Yanıt her durumda aynı kalır (kimlik sızdırmaz); yalnız DOĞRULANMIŞ adrese gönderilir.
  if (user && user.email && isVerifiedEmail(user.emailVerified)) {
    const token  = purposeToken(RESET_TOKEN_PREFIX);
    const expiry = Date.now() + 60 * 60 * 1000; // 1 saat
    await Users.update(user._id, { emailToken: token, emailTokenExp: expiry });
    try {
      await sendPasswordResetEmail(user.email, token, user.username);
    } catch (err) {
      // Preserve the anti-enumeration response contract, but keep provider
      // failures observable for operators.
      logger.error(
        { err, userId: user._id, event: 'auth.password_reset_email_failed' },
        '[Auth] Password reset email delivery failed.',
      );
    }
  }
  res.json({ ok: true, message: 'If the address exists, a reset email has been sent' });
});

/**
 * @openapi
 * /email/reset-password:
 *   post:
 *     summary: Token ile şifreyi sıfırla
 *     tags: [Email]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token:       { type: string, minLength: 1, maxLength: 256 }
 *               newPassword: { type: string, minLength: 8, maxLength: 128 }
 *     responses:
 *       200:
 *         description: Şifre güncellendi
 *       400:
 *         description: Geçersiz token veya kısa şifre
 */
// POST /api/email/reset-password — Token ile yeni şifre
router.post('/reset-password', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { token, newPassword } = body;
  if (typeof token !== 'string' || token.length < 1 || token.length > 256
      || typeof newPassword !== 'string')
    return res.status(400).json({ error: 'token and newPassword are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (newPassword.length > 128) return res.status(400).json({ error: 'Password too long (max 128 characters)' });
  if (!token.startsWith(RESET_TOKEN_PREFIX)) return res.status(400).json({ error: 'Invalid or expired link' });

  const user = await Users.findByEmailToken(token);
  if (!user || !isVerifiedEmail(user.emailVerified)) return res.status(400).json({ error: 'Invalid or expired link' });
  try {
    if (isPersistedEpochExpired(user.emailTokenExp))
      return res.status(400).json({ error: 'Invalid or expired link' });
  } catch {
    return res.status(400).json({ error: 'Invalid or expired link' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await Users.update(user._id, {
    password: hash, emailToken: null, emailTokenExp: null, tokenVersion: parseTokenVersion(user.tokenVersion) + 1,
  });
  await revokeAllRefreshTokens(user._id);
  _invalidateTokenCache(user._id);
  await disconnectLiveUserSessions(user._id, 'password_reset');
  res.json({ ok: true, message: 'Password updated. You can sign in now.' });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
