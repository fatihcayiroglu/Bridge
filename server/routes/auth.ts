// server/routes/auth.ts
import express, { Response } from 'express';
import { checkAndAwardAutoBadges } from './badges';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { checkMagicBytes } from './upload';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import logger from '../lib/logger';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();

// ── httpOnly refresh-token cookie ─────────────────────────────
// Tarayıcı JS'in erişemeyeceği güvenli cookie ayarı.
// Sadece /api/refresh yolunda gönderilir (path kısıtı).
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün
function _setRefreshCookie(res: Response, token: string): void {
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

import { Users, Servers, Members } from '../db/repositories';
import { makeToken, makeRefreshToken, rotateRefreshToken, revokeAllRefreshTokens, authMiddleware, _invalidateTokenCache, } from '../middleware/auth';
import type { RotateResultOrError } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import captcha from '../lib/captcha';
import { validateBody, schemas } from '../middleware/validate';

import { sanitizeUser } from '../lib/userUtils';
import { generateCsrfToken } from '../lib/security';
import { AVATAR_COLORS } from '../lib/brandDefaults';

// sanitizeUser artık lib/userUtils.js'de tanımlı — tüm importlar oradan gelsin

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
    if (!ok) return cb(new Error('Only images allowed for avatars'));
    cb(null, true);
  },
});

/**
 * @openapi
 * /register:
 *   post:
 *     tags: [Auth]
 *     summary: Yeni kullanıcı kaydı
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:    { type: string, minLength: 2, maxLength: 32, example: john_doe }
 *               password:    { type: string, minLength: 8, format: password }
 *               displayName: { type: string }
 *     responses:
 *       201:
 *         description: Kayıt başarılı — JWT ve refresh token döner
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string }
 *                 user: { $ref: '#/components/schemas/User' }
 *       400: { description: Geçersiz istek }
 *       409: { description: Kullanıcı adı zaten alınmış }
 *       429:
 *         description: Rate limit aşıldı
 */
// POST /api/register
router.post('/register',
  captcha.botFilterMiddleware(60),           // bot parmak izi filtresi
  limits.register(),                         // IP rate limit
  captcha.registrationThrottleMiddleware,    // saatte max 3 kayıt/IP
  captcha.captchaMiddleware,                 // hCaptcha / Turnstile doğrulama
  validateBody(schemas.register),
  async (req: import("express").Request, res: import("express").Response) => {
  const { username, password, displayName } = req.body as Record<string, string>;
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
  if (exists) return res.status(409).json({ error: 'Username already taken' });

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
    // SECURITY: apPrivateKey users tablosuna yazılmıyor — saveApKeys ayrı tabloya yazar
  });

  // ActivityPub özel anahtarını ayrı tabloya kaydet
  if (apKeys.apPublicKey && apKeys.apPrivateKey) {
    await Users.saveApKeys(user._id, apKeys.apPublicKey, apKeys.apPrivateKey);
  }

  // Kayıt sayacını artır
  await captcha.recordRegistration(captcha._getIp(req));

  const defaultServer = await Servers.findOne({ name: 'Bridge Global' });
  if (defaultServer) {
    await Members.insert(user._id, defaultServer._id);
  }

  const token        = makeToken(user);
  const refreshToken = await makeRefreshToken(user);
  _setRefreshCookie(res, refreshToken);
  checkAndAwardAutoBadges(user._id).catch(() => {});
  res.json({ token, user: sanitizeUser(user) });
});

/**
 * @openapi
 * /login:
 *   post:
 *     tags: [Auth]
 *     summary: Kullanıcı girişi
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Giriş başarılı — JWT token ve kullanıcı objesi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string }
 *                 user:  { $ref: '#/components/schemas/User' }
 *       401: { description: Geçersiz kimlik bilgileri }
 *       403: { description: Hesap kilitli (2FA veya captcha) }
 *       429:
 *         description: Rate limit aşıldı
 */
// POST /api/login
router.post('/login',
  captcha.botFilterMiddleware(70),          // bot filtresi
  captcha.loginLockMiddleware,              // IP kilit kontrolü (async-safe)
  captcha.progressiveCaptchaMiddleware,     // 3+ başarısız denemeden sonra CAPTCHA sor
  limits.login(),
  validateBody(schemas.login),
  async (req: import("express").Request, res: import("express").Response) => {
  const { username, password } = req.body as Record<string, string>;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const ip = captcha._getIp(req);

  // Account enumeration koruması: kullanıcı var mı yok mu aynı süre geçirmeli
  // bcrypt.compare ile sahte hash karşılaştır — timing saldırısını önle
  const DUMMY_HASH = '$2b$12$invalidhashfortimingprotectionpadding00000000000000000';
  const user = await Users.findByUsername(username);
  const passwordValid = user
    ? await bcrypt.compare(password, user.password ?? '')
    : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

  if (!user || !passwordValid) {
    await captcha.recordFailedLogin(ip);
    // Generic mesaj — hangi alanın yanlış olduğunu söyleme
    return res.status(401).json({ error: captcha.GENERIC_LOGIN_ERROR });
  }

  await captcha.recordSuccessfulLogin(ip);

  // Sprint 121 FIX 16: E-posta doğrulama zorunluluğu
  // REQUIRE_EMAIL_VERIFICATION=true ise doğrulanmamış hesaplar giriş yapamaz.
  // SSO ile gelen hesaplar (emailVerified=1) bundan muaf — sso.ts'de zaten set ediliyor.
  const requireVerification = process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
  if (requireVerification && !user.emailVerified) {
    return res.status(403).json({
      error: 'EMAIL_NOT_VERIFIED',
      message: 'Lütfen giriş yapmadan önce e-posta adresinizi doğrulayın.',
    });
  }

  // Şüpheli giriş kontrolü (yeni IP/cihaz → e-posta uyarısı)
  captcha.checkSuspiciousLogin(req, user).catch(() => {});

  await Users.setStatus(user._id, 'online');

  const token        = makeToken(user);
  const refreshToken = await makeRefreshToken(user);
  _setRefreshCookie(res, refreshToken);
  // Auto-rozet kontrolü (fire-and-forget — login flow'unu bloklama)
  checkAndAwardAutoBadges(user._id).catch(() => {});
  res.json({ token, user: sanitizeUser({ ...user, status: 'online' }) });
});

// POST /api/refresh  — refresh token rotation
/**
 * @openapi
 * /refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Access token yenile (httpOnly cookie ile)
 *     security: []
 *     responses:
 *       200:
 *         description: Yeni token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string }
 *       401: { description: Geçersiz veya süresi dolmuş refresh token }
 */
router.post('/refresh', limits.refresh(), async (req: import("express").Request, res: import("express").Response) => {
  const refreshToken = req.cookies?.bridge_refresh || req.body?.refreshToken;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

  const result: RotateResultOrError | null = await rotateRefreshToken(refreshToken);
  if (!result || 'error' in result) {
    const reason = result && 'error' in result ? result.error : 'not_found';
    const msg = reason === 'reuse'
      ? 'Token reuse detected. All sessions revoked for security.'
      : reason === 'expired'
      ? 'Refresh token expired. Please log in again.'
      : 'Invalid or expired refresh token';
    return res.status(401).json({ error: msg, reason });
  }

  const { user, newToken } = result;
  _setRefreshCookie(res, newToken);
  res.json({ token: makeToken(user) });
});

// POST /api/logout — httpOnly cookie'yi temizle
/**
 * @openapi
 * /logout:
 *   post:
 *     tags: [Auth]
 *     summary: Oturumu kapat
 *     responses:
 *       200: { description: Çıkış başarılı }
 */
router.post('/logout', async (req: import("express").Request, res: import("express").Response) => {
  res.clearCookie('bridge_refresh', { httpOnly: true, sameSite: 'strict', path: '/api/refresh' });
  res.json({ ok: true });
});

// POST /api/change-password
/**
 * @openapi
 * /change-password:
 *   post:
 *     tags: [Auth]
 *     summary: Şifre değiştir
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [oldPassword, newPassword]
 *             properties:
 *               oldPassword: { type: string, format: password }
 *               newPassword: { type: string, format: password }
 *     responses:
 *       200: { description: Şifre değiştirildi }
 *       401: { description: Eski şifre yanlış }
 */
router.post('/change-password', authMiddleware, limits.changePassword(), validateBody(schemas.changePassword), async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { currentPassword, newPassword } = req.body as Record<string, string>;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (newPassword.length > 128)
    return res.status(400).json({ error: 'New password too long (max 128 characters)' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!(await bcrypt.compare(currentPassword, user.password ?? '')))
    return res.status(400).json({ error: 'Current password is incorrect' });

  const newHash    = await bcrypt.hash(newPassword, 12);
  const newVersion = (user.tokenVersion || 0) + 1;
  await Users.update(_u.id, { password: newHash, tokenVersion: newVersion });
  await revokeAllRefreshTokens(_u.id);
  _invalidateTokenCache(_u.id);

  const updated = await Users.findById(_u.id);
  if (!updated) return res.status(404).json({ error: 'User not found after update' });
  res.json({
    message:      'Password changed. All other sessions have been logged out.',
    token:        makeToken(updated),
    refreshToken: await makeRefreshToken(updated),
  });
});

// POST /api/logout-all
/**
 * @openapi
 * /logout-all:
 *   post:
 *     tags: [Auth]
 *     summary: Tüm oturumları kapat
 *     responses:
 *       200: { description: Tüm oturumlar kapatıldı }
 */
router.post('/logout-all', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const newVersion = (user.tokenVersion || 0) + 1;
  await Users.incrementTokenVersion(_u.id);
  await revokeAllRefreshTokens(_u.id);
  _invalidateTokenCache(_u.id);
  res.json({ message: 'All sessions logged out.' });
});

// GET /api/me
/**
 * @openapi
 * /me:
 *   get:
 *     tags: [Auth]
 *     summary: Giriş yapan kullanıcı bilgileri
 *     responses:
 *       200:
 *         description: Kullanıcı profili
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/User' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(sanitizeUser(user));
});

// PATCH /api/me
/**
 * @openapi
 * /me:
 *   patch:
 *     tags: [Auth]
 *     summary: Profil güncelle
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName: { type: string }
 *               bio: { type: string }
 *               status: { type: string, enum: [online, idle, dnd, offline] }
 *               pronouns: { type: string }
 *     responses:
 *       200:
 *         description: Profil güncellendi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/User' }
 */
router.patch('/me', authMiddleware, limits.settings(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { displayName, status, bio, website, location, pronouns, bannerColor } = req.body as Record<string, string>;
  const allowed = ['online','idle','dnd','offline'];
  // Sprint 121 FIX 22: Partial<> tipiyle tip güvenliği sağlandı
  const updates: Record<string, unknown> = {};
  if (displayName?.trim()) updates.displayName = displayName.trim().slice(0, 32);
  if (status && allowed.includes(status)) updates.status = status;
  if (typeof bio === 'string') updates.bio = bio.trim().slice(0, 180);
  if (typeof website === 'string') updates.website = website.trim().slice(0, 120);
  if (typeof location === 'string') updates.location = location.trim().slice(0, 60);
  if (typeof pronouns === 'string') updates.pronouns = pronouns.trim().slice(0, 40);
  if (typeof bannerColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(bannerColor.trim())) updates.bannerColor = bannerColor.trim();
  if ('bannerUrl' in req.body) updates.bannerUrl = req.body.bannerUrl === null ? null : undefined; // null = kaldır
  // Sprint 121 FIX 9: badge alanı kullanıcı tarafından set edilemiyor — sadece sistem/admin atayabilir.
  // Eskiden: if (typeof badge === 'string') updates.badge = badge.trim().slice(0, 20);
  // Bu, kullanıcının herhangi bir rozeti kendine eklemesine izin veriyordu.
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'Nothing to update' });

  await Users.update(_u.id, updates);
  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(sanitizeUser(user));
});

// POST /api/me/avatar — upload profile photo (GIF animasyonlu avatar dahil)
/**
 * @openapi
 * /me/avatar:
 *   post:
 *     tags: [Auth]
 *     summary: Avatar yükle
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200: { description: Avatar güncellendi }
 */
router.post('/me/avatar', authMiddleware, limits.settings(), (req, res, next) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Sprint 121 FIX 7: Magic byte kontrolü — MIME type spoofing engelle
  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'File content does not match declared type' });
  }
  const avatarUrl = `/uploads/${req.file.filename}`;
  await Users.update(_u.id, { avatarUrl });
  res.json({ avatarUrl });
});

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
    if (!ok) return cb(new Error('Only images allowed for banners'));
    cb(null, true);
  },
});
/**
 * @openapi
 * /me/banner:
 *   post:
 *     tags: [Auth]
 *     summary: Banner yükle
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200: { description: Banner güncellendi }
 */
router.post('/me/banner', authMiddleware, limits.settings(), (req, res, next) => {
  bannerUpload.single('banner')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Sprint 121 FIX 7: Magic byte kontrolü — banner için de zorunlu
  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'File content does not match declared type' });
  }
  const bannerUrl = `/uploads/${req.file.filename}`;
  await Users.update(_u.id, { bannerUrl });
  res.json({ bannerUrl });
});

// POST /api/me/banner-color — set profile banner color
/**
 * @openapi
 * /me/banner-color:
 *   patch:
 *     tags: [Auth]
 *     summary: Banner rengi güncelle
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               color: { type: string, example: '#2d9cdb' }
 *     responses:
 *       200: { description: Renk güncellendi }
 */
router.patch('/me/banner-color', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { bannerColor } = req.body as Record<string, string>;
  if (!bannerColor || !/^#[0-9a-fA-F]{3,8}$/.test(bannerColor))
    return res.status(400).json({ error: 'Invalid color' });
  await Users.update(_u.id, { bannerColor });
  res.json({ bannerColor });
});

// DELETE /api/me/avatar — remove profile photo
/**
 * @openapi
 * /me/avatar:
 *   delete:
 *     tags: [Auth]
 *     summary: Avatarı sil
 *     responses:
 *       200: { description: Avatar silindi }
 */
router.delete('/me/avatar', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (user?.avatarUrl) {
    const file = path.join(__dirname, '../uploads', path.basename(user.avatarUrl));
    fs.unlink(file, () => {});
  }
  await Users.update(_u.id, { avatarUrl: null });
  res.json({ avatarUrl: null });
});

// GET /api/captcha-config — client'a sitekey gönder (public, auth gerekmez)
/**
 * @openapi
 * /captcha-config:
 *   get:
 *     tags: [Auth]
 *     summary: Captcha yapılandırması
 *     security: []
 *     responses:
 *       200:
 *         description: Captcha ayarları
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled: { type: boolean }
 *                 siteKey: { type: string }
 */
router.get('/captcha-config', (req, res) => {
  // Sitekey değişmez — 1 saat cache'le
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(captcha.getPublicConfig());
});

// GET /api/auth/csrf-token — issue a CSRF token for the current user
// Browser clients must call this after login and include the returned token
// in the X-CSRF-Token header on all POST/PATCH/PUT/DELETE requests.
/**
 * @openapi
 * /csrf-token:
 *   get:
 *     tags: [Auth]
 *     summary: CSRF token al
 *     responses:
 *       200:
 *         description: CSRF token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 csrfToken: { type: string }
 */
router.get('/csrf-token', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const token = await generateCsrfToken(_u.id);
  res.json({ token });
});

export { router, sanitizeUser };

export default router;
module.exports = router;
module.exports.router = router;
module.exports.default = router;
