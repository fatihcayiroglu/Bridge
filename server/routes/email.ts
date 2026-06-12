// server/routes/email.ts — E-posta doğrulama & şifre sıfırlama
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router();
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { Users } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { sendVerificationEmail, sendPasswordResetEmail } from '../lib/mailer';
import { limits } from '../middleware/rateLimit';
import logger from '../lib/logger';

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
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Doğrulama e-postası gönderildi
 *       400:
 *         description: Geçersiz e-posta
 */
// POST /api/email/add — Kullanıcı e-posta ekler/değiştirir
router.post('/add', authMiddleware, limits.email(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { email } = req.body as Record<string, string>;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Provide a valid email address' });

  const token  = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24 saat

  // Başka hesapta kullanılıyor mu?
  const existing = await Users.findByEmail(email);
  if (existing && existing._id !== _u.id)
    return res.status(400).json({ error: 'This email is already used by another account' });

  await Users.update(_u.id, {
    email:          email.toLowerCase(),
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
 *       200:
 *         description: E-posta doğrulandı (HTML yanıt)
 *       400:
 *         description: Geçersiz veya süresi dolmuş token
 */
// GET /api/email/verify?token=... — E-posta doğrulama linki
router.get('/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const user = await Users.findByEmailToken(String(token));
  if (!user) return res.status(400).send('Invalid or expired link');
  if ((user.emailTokenExp ?? 0) < Date.now()) return res.status(400).send('Link expired. Request a new one.');

  await Users.update(user._id, { emailVerified: 1, emailToken: null, emailTokenExp: null });

  // Kullanıcıyı uygulamaya yönlendir
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h2 style="color:#2d9cdb;">✅ Email Verified</h2>
      <p>Your account is verified. You can return to the app.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
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

  const token  = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + 24 * 60 * 60 * 1000;
  await Users.update(user._id, { emailToken: token, emailTokenExp: expiry });

  try {
    await sendVerificationEmail(user.email, token, user.username);
    res.json({ ok: true });
  } catch (e) {
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
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: İstek alındı (enumeration önleme)
 */
// POST /api/email/forgot — Şifre sıfırlama talebi
router.post('/forgot', async (req, res) => {
  const { email } = req.body as Record<string, string>;
  // Güvenlik: her zaman aynı mesaj döndür (kullanıcı enumeration önleme)
  if (!email) return res.json({ ok: true });

  const user = await Users.findByEmail(email);
  if (user) {
    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 60 * 60 * 1000; // 1 saat
    await Users.update(user._id, { emailToken: token, emailTokenExp: expiry });
    if (user.email) { try { await sendPasswordResetEmail(user.email, token, user.username); } catch {} }
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
 *               token:       { type: string }
 *               newPassword: { type: string, minLength: 8 }
 *     responses:
 *       200:
 *         description: Şifre güncellendi
 *       400:
 *         description: Geçersiz token veya kısa şifre
 */
// POST /api/email/reset-password — Token ile yeni şifre
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body as Record<string, string>;
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = await Users.findByEmailToken(String(token));
  if (!user || typeof user.emailTokenExp !== 'number' || user.emailTokenExp < Date.now())
    return res.status(400).json({ error: 'Invalid or expired link' });

  const hash = await bcrypt.hash(newPassword, 12);
  await Users.update(user._id, {
    password: hash, emailToken: null, emailTokenExp: null, tokenVersion: (user.tokenVersion || 0) + 1,
  });
  res.json({ ok: true, message: 'Password updated. You can sign in now.' });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
