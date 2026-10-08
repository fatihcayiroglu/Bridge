// server/routes/auth.ts
import express from 'express';
import { normalizeServerLocale } from '../lib/serverLocale';
import { checkAndAwardAutoBadges } from './badges';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { canonicalExtensionForMime, checkMagicBytes } from '../lib/uploadFileSafety';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import logger from '../lib/logger';
import { clearMediaCookie, setMediaCookie } from '../lib/mediaCookie';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();

import { clearRefreshCookie, setRefreshCookie } from '../lib/authCookies';
import db from '../db/loader';
import { hasLiveUploadReference } from '../lib/uploadReferenceSafety';

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

import { Users, Members, Notifications } from '../db/repositories';
import { makeToken, makeRefreshToken, rotateRefreshToken, revokeRefreshSession, revokeAllRefreshTokens, authMiddleware, _invalidateTokenCache, } from '../middleware/auth';
import type { RotateResultOrError } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import captcha from '../lib/captcha';
import { validateBody, schemas } from '../middleware/validate';

import { sanitizeOwnUser, sanitizeUser } from '../lib/userUtils';
import { generateCsrfToken } from '../lib/security';
import { AVATAR_COLORS } from '../lib/brandDefaults';
import { sanitizeDisplayName } from '../lib/displayName';
import { issueTwoFactorLoginChallenge } from '../lib/twoFactorLoginChallenge';
import { disconnectLiveUserSessions } from '../lib/sessionRevocation';
import { uploadRoot } from '../lib/runtimePaths';
import { parseTokenVersion } from '../lib/tokenVersion';
import { mintSignInGrants } from '../lib/stepUp';

// sanitizeUser artık lib/userUtils.js'de tanımlı — tüm importlar oradan gelsin

// ── Avatar upload (multer) ─────────────────────────────────────────────────
const UPLOAD_DIR = uploadRoot();
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ════════════════════════════════════════════════════════════════════════════
// AVATAR VE BANNER ALT DIZINE YAZILIR — KOKE DEGIL
// ════════════════════════════════════════════════════════════════════════════
// `middleware/uploadAuthz.ts` YAPISAL bir kural uygular:
//   · uploads KOKU        → OZEL mesaj ekleri (yetkilendirilir)
//   · uploads ALT DIZIN   → HERKESE ACIK varliklar (emoji, sticker, avatar…)
//
// Avatar ve banner KOKE yaziliyordu; yani HERKESE ACIK profil gorselleri OZEL
// ek muamelesi goruyordu. `findOwner` bunlari hicbir mesajda bulamayip
// `{kind:'orphan', uploaderId:null}` donduruyor, `authorized()` ise null
// yukleyici icin FALSE donduruyordu. Sonuc: avatar HIC KIMSEYE gorunmuyordu.
//
// DOGRUDAN OLCULDU (yukleme basarili, dosya erisilemez):
//   POST /api/me/avatar                → 200  { avatarUrl: /uploads/avatar_… }
//   GET  /uploads/avatar_… (sahibi)    → 403
//   GET  /uploads/avatar_… (anonim)    → 401   ← `<img>` yolu
//   GET  /uploads/avatar_… (baskasi)   → 403
//
// Diger acik varliklar zaten alt dizin kullaniyordu (emojis/, soundboard/,
// server-assets/, member-profiles/); avatar ve banner bu kaliba UYMUYORDU.
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
const BANNER_DIR = path.join(UPLOAD_DIR, 'banners');
for (const dir of [AVATAR_DIR, BANNER_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeUnlinkProfileFile(filePath: string): void {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

async function cleanupOldProfileAsset(
  url: string | null | undefined,
  subdir: 'avatars' | 'banners',
): Promise<void> {
  if (!url?.startsWith(`/uploads/${subdir}/`)) return;
  const fileName = path.basename(url);
  const canonicalKey = `uploads/${subdir}/${fileName}`;
  const filePath = path.join(UPLOAD_DIR, subdir, fileName);
  try {
    if (!await hasLiveUploadReference(db._pool, canonicalKey)) safeUnlinkProfileFile(filePath);
  } catch (error) {
    logger.error({ err: error, url, subdir, event: 'profile_asset.cleanup_failed' },
      'Profile DB state updated but physical cleanup was blocked');
  }
}

const avatarStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, AVATAR_DIR),
  filename: (_, file, cb) => {
    const ext = canonicalExtensionForMime(file.mimetype) ?? '';
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

  // Final quota admission is atomic. The earlier middleware is a cheap
  // rejection path; this reservation closes concurrent-register TOCTOU races.
  if (!(await captcha.claimRegistrationSlot(captcha._getIp(req)))) {
    return res.status(429).json({ error: 'Bu IP adresinden son 1 saat içinde çok fazla hesap oluşturuldu. Lütfen bekleyin.', retryAfter: 3600 });
  }

  // ActivityPub RSA anahtar çifti — Mastodon/Fediverse ile iletişim için
  const apKeys = generateApKeyPair();

  if (!apKeys.apPublicKey || !apKeys.apPrivateKey) {
    return res.status(503).json({ error: 'Identity key generation failed' });
  }
  const user = await Users.createWithApKeys({
    _id:          uuidv4(),
    username:     username.toLowerCase(),
    // KIMLIK TAKLIDI SAVUNMASI: gorunmez/yapisal karakterler temizlenir.
    // Temizlik sonrasi bos kalirsa kullanici adina geri dusulur.
    // Gerekce ve olculen somuru vektorleri: lib/displayName.ts
    displayName:  sanitizeDisplayName(displayName) || username,
    password:     await bcrypt.hash(password, 12),
    avatarColor:  AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    avatarUrl:    null,
    status:       'online',
    bio:          '',
    tokenVersion: 0,
    createdAt:    Date.now(),
  }, apKeys.apPublicKey, apKeys.apPrivateKey);

  let token: string;
  let refreshToken: string;
  try {
    token = makeToken(user);
    refreshToken = await makeRefreshToken(user);
  } catch (error) {
    // The registration identity is durable, but it is not usable until the
    // initial session can be issued. Leaving the user row behind turns a
    // transient refresh-store outage into a permanently "taken" username.
    try {
      await Users.delete(user._id);
    } catch (rollbackError) {
      logger.error(
        { err: rollbackError, userId: user._id, event: 'auth.registration_rollback_failed' },
        'Registration session issuance failed and the partial identity could not be rolled back.',
      );
    }
    throw error;
  }
  setRefreshCookie(res, refreshToken);
  // Ozel ek yetkilendirmesi icin medya cerezi (path=/uploads).
  setMediaCookie(res, user);
  checkAndAwardAutoBadges(user._id).catch(() => {});
  // The password was just set: a fresh credential proof (P7 B2 step-up, level 1).
  res.json({ token, user: sanitizeOwnUser(user), stepUp: mintSignInGrants(user, 'password') });
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
 *                 stepUp: { type: object, description: 'P7 B2 — one short-lived step-up grant per scope (memory-only on the client)' }
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
  void captcha.checkSuspiciousLogin(req, user).catch(err => {
    logger.warn({ err, userId: user._id, event: 'auth.suspicious_login_check_failed' }, 'Suspicious-login advisory check failed');
  });

  // 2FA is a SERVER-ENFORCED authentication stage. A correct password must
  // never mint access/refresh/media credentials while the second factor is
  // still pending. The opaque challenge contains no user id and is resolved
  // only from server-side state by /api/2fa/check.
  if (user.twoFactorEnabled) {
    const tempToken = await issueTwoFactorLoginChallenge(user._id, parseTokenVersion(user.tokenVersion));
    return res.status(202).json({ requiresTwoFactor: true, tempToken });
  }

  await Users.setStatus(user._id, 'online');

  const token        = makeToken(user);
  const refreshToken = await makeRefreshToken(user);
  setRefreshCookie(res, refreshToken);
  // Ozel ek yetkilendirmesi icin medya cerezi (path=/uploads).
  setMediaCookie(res, user);
  // Auto-rozet kontrolü (fire-and-forget — login flow'unu bloklama)
  checkAndAwardAutoBadges(user._id).catch(() => {});
  // A password sign-in is a fresh level-1 proof: one step-up grant per scope (P7 B2).
  res.json({ token, user: sanitizeOwnUser({ ...user, status: 'online' }), stepUp: mintSignInGrants(user, 'password') });
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
  const refreshToken = req.cookies?.bridge_refresh ?? req.body?.refreshToken;
  if (refreshToken === undefined || refreshToken === null || refreshToken === '') {
    return res.status(400).json({ error: 'refreshToken required' });
  }
  if (typeof refreshToken !== 'string' || refreshToken.length > 512) {
    return res.status(400).json({ error: 'refreshToken invalid' });
  }

  const result: RotateResultOrError | null = await rotateRefreshToken(refreshToken);
  if (!result || 'error' in result) {
    const reason = result && 'error' in result ? result.error : 'not_found';
    const msg = reason === 'reuse'
      ? 'Token reuse detected. All sessions revoked for security.'
      : reason === 'expired'
      ? 'Refresh token expired. Please log in again.'
      : reason === 'revoked'
      ? 'Session revoked. Please log in again.'
      : 'Invalid or expired refresh token';
    return res.status(401).json({ error: msg, reason });
  }

  const { user, newToken } = result;
  setRefreshCookie(res, newToken);
  // Ozel ek yetkilendirmesi icin medya cerezi (path=/uploads).
  setMediaCookie(res, user);
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
// ════════════════════════════════════════════════════════════════════════════
// P4 — PUSH DELIVERY ENDS WITH THE SESSION
// ════════════════════════════════════════════════════════════════════════════
// Push targets (native device tokens, Web Push subscriptions) are not tied to a
// session. Before P4 nothing removed them on logout, logout-all or a password
// change: a signed-out phone — or one that was lost and "logged out
// everywhere" — kept showing the account's DM and mention previews.
//
// Logout: the client names the installation it is leaving (`push.nativeToken`,
// `push.webEndpoint`). Removal is scoped to the refresh session's OWN user, so
// a request cannot delete another account's targets. Logout-all and password
// change remove every target of the account; devices that stay signed in
// re-register on their next start.
const PUSH_ID_MAX = 4096;

function logoutPushTargets(body: unknown): { nativeToken?: string; webEndpoint?: string } {
  const push = (body as { push?: unknown } | undefined)?.push;
  if (!push || typeof push !== 'object') return {};
  const { nativeToken, webEndpoint } = push as { nativeToken?: unknown; webEndpoint?: unknown };
  return {
    ...(typeof nativeToken === 'string' && nativeToken && nativeToken.length <= PUSH_ID_MAX ? { nativeToken } : {}),
    ...(typeof webEndpoint === 'string' && webEndpoint && webEndpoint.length <= PUSH_ID_MAX ? { webEndpoint } : {}),
  };
}

async function endPushForInstallation(userId: string, targets: { nativeToken?: string; webEndpoint?: string }): Promise<void> {
  try {
    if (targets.nativeToken) await Notifications.removeNativeTokenForUser(userId, targets.nativeToken);
    if (targets.webEndpoint) await Notifications.removePushSubscriptionWhere({ userId, endpoint: targets.webEndpoint });
  } catch (err) {
    logger.error({ err, userId, event: 'auth.logout.push_cleanup_failed' }, 'Logout could not remove this installation\'s push target');
  }
}

async function endPushForAccount(userId: string, reason: string): Promise<void> {
  try {
    const removed = await Notifications.removeAllPushTargetsForUser(userId);
    logger.info({ userId, reason, removed, event: 'auth.push_targets.revoked' }, 'Push targets revoked with the sessions');
  } catch (err) {
    logger.error({ err, userId, reason, event: 'auth.push_targets.revoke_failed' }, 'Push targets could not be revoked with the sessions');
  }
}

async function finishLogout(req: import("express").Request, res: import("express").Response) {
  const refreshToken = req.cookies?.bridge_refresh ?? req.body?.refreshToken;
  if (refreshToken !== undefined && refreshToken !== null && refreshToken !== '') {
    if (typeof refreshToken !== 'string' || refreshToken.length > 512) {
      return res.status(400).json({ error: 'refreshToken invalid' });
    }
    const owner = await revokeRefreshSession(refreshToken);
    if (owner) await endPushForInstallation(owner, logoutPushTargets(req.body));
  }
  clearRefreshCookie(res);
  clearMediaCookie(res);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true });
}

// The refresh cookie is deliberately scoped to /api/refresh, so a browser does
// not send it to /api/logout. A 307 preserves POST and lets the browser attach
// the cookie only to this path-scoped endpoint; fetch follows same-origin
// redirects by default. Native/API callers may alternatively send refreshToken
// in the request body and complete logout in one hop.
router.post('/refresh/logout', finishLogout);
router.post('/logout', async (req: import("express").Request, res: import("express").Response) => {
  if (req.cookies?.bridge_refresh || req.body?.refreshToken) return finishLogout(req, res);
  return res.redirect(307, '/api/refresh/logout');
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
  const newVersion = parseTokenVersion(user.tokenVersion) + 1;
  await Users.update(_u.id, { password: newHash, tokenVersion: newVersion });
  await revokeAllRefreshTokens(_u.id);
  _invalidateTokenCache(_u.id);
  await disconnectLiveUserSessions(_u.id, 'password_changed');
  await endPushForAccount(_u.id, 'password_changed');

  const updated = await Users.findById(_u.id);
  if (!updated) return res.status(404).json({ error: 'User not found after update' });
  const refreshToken = await makeRefreshToken(updated);
  setRefreshCookie(res, refreshToken);
  setMediaCookie(res, updated);
  res.json({
    message: 'Password changed. All other sessions have been logged out.',
    token: makeToken(updated),
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
  // NOT: burada surum HESAPLANIP atiliyordu; artirimi
  // `incrementTokenVersion` kendisi yapar.
  await Users.incrementTokenVersion(_u.id);
  await revokeAllRefreshTokens(_u.id);
  _invalidateTokenCache(_u.id);
  await disconnectLiveUserSessions(_u.id, 'logout_all');
  await endPushForAccount(_u.id, 'logout_all');
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
  res.json(sanitizeOwnUser(user));
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
 *               presenceVisibility: { type: string, enum: [visible, hidden] }
 *               dmPrivacy: { type: string, enum: [everyone, friends, none] }
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
  const rawBody = req.body as unknown;
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return res.status(400).json({ error: 'Profile update body must be an object' });
  }
  const body = rawBody as Record<string, unknown>;
  const { displayName, status, presenceVisibility, dmPrivacy, bio, website, location, pronouns, bannerColor, locale } = body;
  const allowed = ['online','idle','dnd','offline'];
  const allowedPresence = ['visible', 'hidden'];
  const allowedDmPrivacy = ['everyone', 'friends', 'none'];
  const updates: Record<string, unknown> = {};
  if (typeof displayName === 'string' && displayName.trim()) {
    // Ayni temizlik guncelleme yolunda da uygulanir — KARDES-YOL asimetrisi
    // bu programda defalarca gercek acik uretti.
    const temiz = sanitizeDisplayName(displayName);
    if (temiz) updates.displayName = temiz;
  }
  if (typeof status === 'string' && allowed.includes(status)) {
    // Backward-compatible REST callers still set the effective field, but the
    // same choice must survive reconnects via the durable preference owner.
    updates.status = status;
    updates.presenceStatus = status;
  }
  // Final21 Phase 16: the language this person reads, so server-written push copy is not
  // Turkish for everyone. Only a locale the server actually has copy for is stored.
  if (typeof locale === 'string') {
    const normalized = normalizeServerLocale(locale);
    if (normalized === locale.trim().toLowerCase().split(/[-_]/)[0]) updates.locale = normalized;
  }
  if (typeof presenceVisibility === 'string' && allowedPresence.includes(presenceVisibility)) updates.presenceVisibility = presenceVisibility;
  if (typeof dmPrivacy === 'string' && allowedDmPrivacy.includes(dmPrivacy)) updates.dmPrivacy = dmPrivacy;
  if (typeof bio === 'string') updates.bio = bio.trim().slice(0, 180);
  if (typeof website === 'string') updates.website = website.trim().slice(0, 120);
  if (typeof location === 'string') updates.location = location.trim().slice(0, 60);
  if (typeof pronouns === 'string') updates.pronouns = pronouns.trim().slice(0, 40);
  if (typeof bannerColor === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(bannerColor.trim())) updates.bannerColor = bannerColor.trim();
  if ('bannerUrl' in body) {
    if (body.bannerUrl !== null) return res.status(400).json({ error: 'bannerUrl is storage-owned; only null removal is allowed' });
    updates.bannerUrl = null; // null = kaldır
  }
  // Sprint 121 FIX 9: badge alanı kullanıcı tarafından set edilemiyor — sadece sistem/admin atayabilir.
  // Eskiden: if (typeof badge === 'string') updates.badge = badge.trim().slice(0, 20);
  // Bu, kullanıcının herhangi bir rozeti kendine eklemesine izin veriyordu.
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'Nothing to update' });

  const oldBannerForRemoval = updates.bannerUrl === null
    ? (await Users.findById(_u.id))?.bannerUrl
    : undefined;

  const requestedPresence = updates.presenceVisibility === 'hidden' || updates.presenceVisibility === 'visible'
    ? updates.presenceVisibility
    : null;
  const presence = requestedPresence ? await import('../lib/presenceCache') : null;

  // Privacy transitions use asymmetric ordering on purpose:
  //   hidden  -> authoritative Redis first, then durable DB
  //   visible -> durable DB first, then authoritative Redis
  // Every partial-failure state is therefore at least as private as the user's
  // durable preference. Configured Redis is authority; we never acknowledge a
  // visibility change while silently degrading to process-local state.
  if (requestedPresence === 'hidden') {
    try {
      await presence!.setPresenceVisibility(_u.id, false);
    } catch (err) {
      logger.warn({ userId: _u.id, err, event: 'auth.presence_visibility.authority_unavailable' },
        'Presence hide rejected because shared visibility authority is unavailable.');
      return res.status(503).json({ error: 'Presence coordination unavailable' });
    }
  }

  await Users.update(_u.id, updates);
  if (updates.bannerUrl === null) await cleanupOldProfileAsset(oldBannerForRemoval, 'banners');

  if (requestedPresence) {
    const visible = requestedPresence === 'visible';
    if (visible) {
      try {
        await presence!.setPresenceVisibility(_u.id, true);
      } catch (err) {
        logger.warn({ userId: _u.id, err, event: 'auth.presence_visibility.authority_unavailable' },
          'Presence show persisted but remains fail-closed until shared visibility authority recovers.');
        return res.status(503).json({ error: 'Presence coordination unavailable' });
      }
    }

    try {
      const locallyConnected = presence!.socketCount(_u.id) > 0;
      if (!visible) await presence!.markOffline(_u.id);
      else if (locallyConnected) await presence!.markOnline(_u.id);

      if (!visible || locallyConnected) {
        const memberships = await Members.findByUser(_u.id);
        const socketMod = await import('../socket');
        const io = socketMod.getIo?.();
        // Faz 16: tek yayın, çok oda — alıcı ortak sunucu sayısı kadar kopya alıyordu.
        const visibilityRooms = [...new Set(memberships.map(m => `server:${m.serverId}`))];
        if (visibilityRooms.length) {
          io?.to(visibilityRooms).emit('user:status', {
            userId: _u.id,
            status: visible ? 'online' : 'offline',
          });
        }
      }
    } catch (err) {
      // Authoritative visibility is already correct. Notification/legacy
      // heartbeat failures cannot make a hidden user visible, so they remain
      // best-effort and will self-heal on socket activity/reconnect.
      logger.warn({ userId: _u.id, err, event: 'auth.presence_visibility.broadcast_failed' },
        'Presence authority updated; realtime notification cleanup will recover asynchronously.');
    }
  }
  const user = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(sanitizeOwnUser(user));
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
 *               avatar: { type: string, format: binary }
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
  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  // Eski avatar yalnizca temizlik icin okunuyordu; degistirilen avatar artik
  // silinmedigi icin (F21-8-02, asagida) bu okuma olu bir DB sorgusuydu.
  try {
    await Users.update(_u.id, { avatarUrl });
  } catch (error) {
    // DB never took ownership of the new file.
    safeUnlinkProfileFile(req.file.path);
    throw error;
  }
  // ── Final21 Faz 8 — F21-8-02: DEĞİŞTİRİLEN AVATAR SİLİNMEZ ────────────────
  // Burada eskiden `cleanupOldProfileAsset(oldAvatarUrl, 'avatars')` vardı.
  //
  // KUSUR (gerçek uçlar üzerinden ÜRETİLDİ): her mesaj yazarın avatarını
  // ANLIK GÖRÜNTÜ olarak saklar (`socket/handlers/messages-send.ts:436`) ve
  // istemci `<img src={message.avatarUrl}>` çizer
  // (`client/js/core/MessageRenderer.svelte:558`). Eski dosya
  // `hasLiveUploadReference` ile denetleniyordu, ama o sorgu
  // `messages.avatarUrl`i KAPSAMIYOR. Sonuç:
  //
  //     avatar A yükle → mesaj gönder (mesaj A'yı tutar) → avatar B yükle
  //     GET A → 404          geçmiş mesaj hâlâ A'yı gösteriyor
  //
  // Yani kullanıcı avatarını değiştirdiğinde GEÇMİŞTEKİ TÜM MESAJLARININ avatarı
  // kırılıyordu. Mevcut test ("keeps the previous avatar while a message still
  // references it") referans denetimini MOCK'layıp `true` döndürdüğü için
  // gerçek sorgunun mesajları kapsamadığını hiç göremedi.
  //
  // NEDEN "sorguya messages.avatarUrl ekle" DEĞİL: eksiksiz denetim tüm mesaj
  // tablosunu tarar. 1M mesajda ÖLÇÜLDÜ: referanslı dosya 1 365 ms, referanssız
  // 1 482 ms — korpusla doğrusal büyür ve her avatar değişiminde koşardı.
  //
  // NEDEN SAKLAMAK DOĞRU: anlık görüntü tasarımının amacı geçmiş avatarı
  // KORUMAKTIR; dosyayı silmek bu tasarımla çelişir. Avatar dosyaları küçüktür
  // (yükleme sınırı) ve değişimler seyrektir. AÇIK KALDIRMA
  // (`DELETE /me/avatar`) kullanıcının "fotoğrafımı kaldır" niyetidir ve
  // dosyayı silmeye DEVAM EDER; geçmiş mesajlar o durumda istemcideki yedek
  // renk avatarına zarifçe düşer.
  res.json({ avatarUrl });
});

// POST /api/me/banner — upload profile banner image (Discord Nitro'da ücretli, burada bedava)
const bannerStorage = multer.diskStorage({
  // Avatar ile ayni gerekce — bkz. yukaridaki not.
  destination: (req, file, cb) => cb(null, BANNER_DIR),
  filename:    (req, file, cb) => {
    const ext = canonicalExtensionForMime(file.mimetype) ?? '';
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
 *               banner: { type: string, format: binary }
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
  const bannerUrl = `/uploads/banners/${req.file.filename}`;
  let currentUser;
  try {
    currentUser = await Users.findById(_u.id);
  } catch (error) {
    safeUnlinkProfileFile(req.file.path);
    throw error;
  }
  const oldBannerUrl = currentUser?.bannerUrl;
  try {
    await Users.update(_u.id, { bannerUrl });
  } catch (error) {
    safeUnlinkProfileFile(req.file.path);
    throw error;
  }
  await cleanupOldProfileAsset(oldBannerUrl, 'banners');
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
 *               bannerColor: { type: string, example: '#2d9cdb' }
 *     responses:
 *       200: { description: Renk güncellendi }
 */
router.patch('/me/banner-color', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { bannerColor } = req.body as Record<string, string>;
  if (!bannerColor || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(bannerColor))
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
  const oldAvatarUrl = user?.avatarUrl;
  await Users.update(_u.id, { avatarUrl: null });
  await cleanupOldProfileAsset(oldAvatarUrl, 'avatars');
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
router.get('/csrf-token', authMiddleware, limits.csrf(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  try {
    const token = await generateCsrfToken(_u.id);
    res.json({ token });
  } catch {
    res.status(503).json({ error: 'CSRF security state unavailable' });
  }
});

export { router, sanitizeUser };

export default router;
module.exports = router;
module.exports.router = router;
module.exports.default = router;
