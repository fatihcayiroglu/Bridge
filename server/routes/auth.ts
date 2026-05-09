// @ts-nocheck
// server/routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const router  = express.Router();

// ── httpOnly refresh-token cookie ─────────────────────────────
// Tarayıcı JS'in erişemeyeceği güvenli cookie ayarı.
// Sadece /api/refresh yolunda gönderilir (path kısıtı).
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün
function _setRefreshCookie(res, token) {
  res.cookie('bridge_refresh', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path:     '/api/refresh',
    maxAge:   COOKIE_MAX_AGE_MS,
  });
}

// ActivityPub için RSA-2048 anahtar çifti üret
function generateApKeyPair() {
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { apPublicKey: publicKey, apPrivateKey: privateKey };
  } catch (e) {
    logger.warn({ err: e, event: 'auth.ap_keypair.failed' }, 'ActivityPub key pair generation failed.');
    return { apPublicKey: null, apPrivateKey: null };
  }
}

const { Users, Servers, Members } = require('../db/repositories');
const {
  makeToken, makeRefreshToken, rotateRefreshToken,
  revokeAllRefreshTokens, authMiddleware, _invalidateTokenCache,
  castAuthed,
} = require('../middleware/auth');
const { limits }   = require('../middleware/rateLimit');
const captcha      = require('../lib/captcha');
const asyncHandler = require('../middleware/asyncHandler');
const logger = require('../lib/logger');
const { validateBody, schemas } = require('../middleware/validate');

const { sanitizeUser } = require('../lib/userUtils');

// sanitizeUser artık lib/userUtils.js'de tanımlı — tüm importlar oradan gelsin

const AVATAR_COLORS = ['#5865f2','#e8432d','#23a55a','#faa61a','#eb459e','#00aff4','#9b59b6','#1abc9c'];

// ── Avatar upload (multer) ─────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 6);
    cb(null, `avatar_${uuidv4()}${ext}`);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Only images allowed for avatars'), ok);
  },
});

// POST /api/register
router.post('/register',
  captcha.botFilterMiddleware(60),           // bot parmak izi filtresi
  limits.register(),                         // IP rate limit
  captcha.registrationThrottleMiddleware,    // saatte max 3 kayıt/IP
  captcha.captchaMiddleware,                 // hCaptcha / Turnstile doğrulama
  validateBody(schemas.register),
  asyncHandler(async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 32)
    return res.status(400).json({ error: 'Username must be 3-32 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username: letters, numbers and underscores only' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (password.length > 128)
    return res.status(400).json({ error: 'Password too long (max 128 characters)' });

  const exists = await Users.findByUsername(username);
  if (exists) return res.status(400).json({ error: 'Username already taken' });

  // ActivityPub RSA anahtar çifti — Mastodon/Fediverse ile iletişim için
  const apKeys = generateApKeyPair();

  const user = await Users.create({
    _id:          uuidv4(),
    username:     username.toLowerCase(),
    displayName:  (displayName?.trim() || username).slice(0, 32),
    password:     await bcrypt.hash(password, 12),
    avatarColor:  AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    avatarUrl:    null,
    status:       'online',
    bio:          '',
    tokenVersion: 0,
    createdAt:    Date.now(),
    apPublicKey:  apKeys.apPublicKey,
    apPrivateKey: apKeys.apPrivateKey,
  });

  // Kayıt sayacını artır
  await captcha.recordRegistration(captcha._getIp(req));

  const defaultServer = await Servers.findOne({ name: 'Bridge Global' });
  if (defaultServer) {
    await Members.insert(user._id, defaultServer._id);
  }

  const token        = makeToken(user);
  const refreshToken = await makeRefreshToken(user);
  _setRefreshCookie(res, refreshToken);
  res.json({ token, user: sanitizeUser(user) });
}));

// POST /api/login
router.post('/login',
  captcha.botFilterMiddleware(70),          // bot filtresi
  captcha.loginLockMiddleware,              // IP kilit kontrolü (async-safe)
  captcha.progressiveCaptchaMiddleware,     // 3+ başarısız denemeden sonra CAPTCHA sor
  limits.login(),
  validateBody(schemas.login),
  asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const ip = captcha._getIp(req);

  // Account enumeration koruması: kullanıcı var mı yok mu aynı süre geçirmeli
  // bcrypt.compare ile sahte hash karşılaştır — timing saldırısını önle
  const DUMMY_HASH = '$2b$12$invalidhashfortimingprotectionpadding00000000000000000';
  const user = await Users.findByUsername(username);
  const passwordValid = user
    ? await bcrypt.compare(password, user.password)
    : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

  if (!user || !passwordValid) {
    await captcha.recordFailedLogin(ip);
    // Generic mesaj — hangi alanın yanlış olduğunu söyleme
    return res.status(401).json({ error: captcha.GENERIC_LOGIN_ERROR });
  }

  await captcha.recordSuccessfulLogin(ip);

  // Şüpheli giriş kontrolü (yeni IP/cihaz → e-posta uyarısı)
  captcha.checkSuspiciousLogin(req, user).catch(() => {});

  await Users.setStatus(user._id, 'online');

  const token        = makeToken(user);
  const refreshToken = await makeRefreshToken(user);
  _setRefreshCookie(res, refreshToken);
  res.json({ token, user: sanitizeUser({ ...user, status: 'online' }) });
}));

// POST /api/refresh  — refresh token rotation
router.post('/refresh', limits.refresh(), asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.bridge_refresh || req.body?.refreshToken;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

  const result = await rotateRefreshToken(refreshToken);
  if (!result) return res.status(401).json({ error: 'Invalid or expired refresh token' });

  const { user, newToken } = result;
  _setRefreshCookie(res, newToken);
  res.json({ token: makeToken(user) });
}));

// POST /api/logout — httpOnly cookie'yi temizle
router.post('/logout', asyncHandler(async (req, res) => {
  res.clearCookie('bridge_refresh', { httpOnly: true, sameSite: 'strict', path: '/api/refresh' });
  res.json({ ok: true });
}));

// POST /api/change-password
router.post('/change-password', authMiddleware, limits.changePassword(), validateBody(schemas.changePassword), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (newPassword.length > 128)
    return res.status(400).json({ error: 'New password too long (max 128 characters)' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!(await bcrypt.compare(currentPassword, user.password)))
    return res.status(400).json({ error: 'Current password is incorrect' });

  const newHash    = await bcrypt.hash(newPassword, 12);
  const newVersion = (user.tokenVersion || 0) + 1;
  await Users.update(_u.id, { password: newHash, tokenVersion: newVersion });
  await revokeAllRefreshTokens(_u.id);
  _invalidateTokenCache(_u.id);

  const updated = await Users.findById(_u.id);
  res.json({
    message:      'Password changed. All other sessions have been logged out.',
    token:        makeToken(updated),
    refreshToken: await makeRefreshToken(updated),
  });
}));

// POST /api/logout-all
router.post('/logout-all', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const newVersion = (user.tokenVersion || 0) + 1;
  await Users.incrementTokenVersion(_u.id);
  await revokeAllRefreshTokens(_u.id);
  _invalidateTokenCache(_u.id);
  res.json({ message: 'All sessions logged out.' });
}));

// GET /api/me
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(sanitizeUser(user));
}));

// PATCH /api/me
router.patch('/me', authMiddleware, limits.settings(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { displayName, status, bio, website, location, pronouns, bannerColor, badge } = req.body;
  const allowed = ['online','idle','dnd','offline'];
  const updates = {};
  if (displayName?.trim()) updates.displayName = displayName.trim().slice(0, 32);
  if (status && allowed.includes(status)) updates.status = status;
  if (typeof bio === 'string') updates.bio = bio.trim().slice(0, 180);
  if (typeof website === 'string') updates.website = website.trim().slice(0, 120);
  if (typeof location === 'string') updates.location = location.trim().slice(0, 60);
  if (typeof pronouns === 'string') updates.pronouns = pronouns.trim().slice(0, 40);
  if (typeof bannerColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(bannerColor.trim())) updates.bannerColor = bannerColor.trim();
  if ('bannerUrl' in req.body) updates.bannerUrl = req.body.bannerUrl === null ? null : undefined; // null = kaldır
  if (typeof badge === 'string') updates.badge = badge.trim().slice(0, 20);
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'Nothing to update' });

  await Users.update(_u.id, updates);
  const user = await Users.findById(_u.id);
  res.json(sanitizeUser(user));
}));

// POST /api/me/avatar — upload profile photo (GIF animasyonlu avatar dahil)
router.post('/me/avatar', authMiddleware, limits.settings(), (req, res, next) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const avatarUrl = `/uploads/${req.file.filename}`;
  await Users.update(_u.id, { avatarUrl });
  res.json({ avatarUrl });
}));

// POST /api/me/banner — upload profile banner image (Discord Nitro'da ücretli, burada bedava)
const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    cb(null, `banner_${uuidv4()}${ext}`);
  },
});
const bannerUpload = multer({
  storage: bannerStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — animasyonlu GIF banner için geniş limit
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Only images allowed for banners'), ok);
  },
});
router.post('/me/banner', authMiddleware, limits.settings(), (req, res, next) => {
  bannerUpload.single('banner')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const bannerUrl = `/uploads/${req.file.filename}`;
  await Users.update(_u.id, { bannerUrl });
  res.json({ bannerUrl });
}));

// POST /api/me/banner-color — set profile banner color
router.patch('/me/banner-color', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { bannerColor } = req.body;
  if (!bannerColor || !/^#[0-9a-fA-F]{3,8}$/.test(bannerColor))
    return res.status(400).json({ error: 'Invalid color' });
  await Users.update(_u.id, { bannerColor });
  res.json({ bannerColor });
}));

// DELETE /api/me/avatar — remove profile photo
router.delete('/me/avatar', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (user?.avatarUrl) {
    const file = path.join(__dirname, '../uploads', path.basename(user.avatarUrl));
    fs.unlink(file, () => {});
  }
  await Users.update(_u.id, { avatarUrl: null });
  res.json({ avatarUrl: null });
}));

// GET /api/captcha-config — client'a sitekey gönder (public, auth gerekmez)
router.get('/captcha-config', (req, res) => {
  // Sitekey değişmez — 1 saat cache'le
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(captcha.getPublicConfig());
});

// GET /api/auth/csrf-token — issue a CSRF token for the current user
// Browser clients must call this after login and include the returned token
// in the X-CSRF-Token header on all POST/PATCH/PUT/DELETE requests.
router.get('/csrf-token', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { generateCsrfToken } = require('../lib/security');
  const token = generateCsrfToken(_u.id);
  res.json({ token });
}));

module.exports = { router, sanitizeUser };
export {};
