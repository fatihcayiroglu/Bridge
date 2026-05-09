// server/routes/email.js — E-posta doğrulama & şifre sıfırlama
const express    = require('express');
const router     = express.Router();
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Users }  = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../lib/mailer');
const { limits } = require('../middleware/rateLimit'); // rate limiting
const logger = require('../lib/logger');

// POST /api/email/add — Kullanıcı e-posta ekler/değiştirir
router.post('/add', authMiddleware, limits.email(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { email } = req.body;
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
    await sendVerificationEmail(email, token, user.username);
    res.json({ ok: true, message: 'Verification email has been sent' });
  } catch (e) {
    logger.error({ err: e, event: 'email.verification.send_failed' }, 'Failed to send verification email.');
    res.json({ ok: true, message: 'Email saved (delivery failed in this environment)' });
  }
}));

// GET /api/email/verify?token=... — E-posta doğrulama linki
router.get('/verify', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const user = await Users.findByEmailToken(token);
  if (!user) return res.status(400).send('Invalid or expired link');
  if (user.emailTokenExp < Date.now()) return res.status(400).send('Link expired. Request a new one.');

  await Users.update(user._id, { emailVerified: 1, emailToken: null, emailTokenExp: null });

  // Kullanıcıyı uygulamaya yönlendir
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h2 style="color:#5865f2;">✅ Email Verified</h2>
      <p>Your account is verified. You can return to the app.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
}));

// POST /api/email/resend — Doğrulama e-postasını yeniden gönder
router.post('/resend', authMiddleware, limits.email(), asyncHandler(async (req, res) => {
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
}));

// POST /api/email/forgot — Şifre sıfırlama talebi
router.post('/forgot', asyncHandler(async (req, res) => {
  const { email } = req.body;
  // Güvenlik: her zaman aynı mesaj döndür (kullanıcı enumeration önleme)
  if (!email) return res.json({ ok: true });

  const user = await Users.findByEmail(email);
  if (user) {
    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 60 * 60 * 1000; // 1 saat
    await Users.update(user._id, { emailToken: token, emailTokenExp: expiry });
    try { await sendPasswordResetEmail(user.email, token, user.username); } catch {}
  }
  res.json({ ok: true, message: 'If the address exists, a reset email has been sent' });
}));

// POST /api/email/reset-password — Token ile yeni şifre
router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = await Users.findByEmailToken(token);
  if (!user || user.emailTokenExp < Date.now())
    return res.status(400).json({ error: 'Invalid or expired link' });

  const hash = await bcrypt.hash(newPassword, 12);
  await Users.update(user._id, {
    password: hash, emailToken: null, emailTokenExp: null, tokenVersion: (user.tokenVersion || 0) + 1,
  });
  res.json({ ok: true, message: 'Password updated. You can sign in now.' });
}));

module.exports = router;
export {};
