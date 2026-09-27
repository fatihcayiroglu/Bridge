// server/middleware/auth.ts
// JWT auth + refresh token rotation (stored in DB)
// JWT_SECRET / REFRESH_SECRET hiçbir zaman hardcoded default kullanmıyor.
// REFRESH_SECRET: refresh token'ları DB'de HMAC-SHA256 ile pepper'lar (plain text saklanmaz).

import jwt from 'jsonwebtoken';
import { attachActor } from '../lib/requestContext';
import crypto from 'crypto';
import logger from '../lib/logger';
import { Auth, Users } from '../db/repositories';
import { Request, Response, NextFunction } from 'express';
import type { AuthedRequest as _AuthedRequest } from '../types/express.d';
import { parseTokenVersion } from '../lib/tokenVersion';
import { parsePersistedEpochMillis } from '../lib/persistedEpoch';

export interface JwtPayload {
  id: string;
  _id?: string;        // alias for id — some routes use _id
  username: string;
  v: number;
  isAdmin?: boolean;
  displayName?: string;
  avatarColor?: string;
  role?: string;
  flags?: string[];
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user: JwtPayload;
  headers: Request['headers'] & { authorization?: string };
}

/**
 * AuthedRequest — authMiddleware'den geçtiği garantili route'lar için.
 * user alanı non-optional'dır; null check gerektirmez.
 * Tek kaynak: types/express.d.ts — buradan re-export edilir.
 *
 * @example
 *   router.get('/profile', authMiddleware, async (req, res) => {
 *     const id = req.user.id; // ✅ tip hatası yok
 *   });
 */
export type { AuthedRequest } from '../types/express.d';

/**
 * castAuthed — require()-style route'lar için tip dönüşüm yardımcısı.
 * authMiddleware zaten user'ı doldurduğundan bu cast güvenlidir.
 *
 * @example
 *   router.get('/me', authMiddleware, async (req, res) => {
 *     const { id } = castAuthed(req).user;
 *   });
 */
export function castAuthed(req: Request): _AuthedRequest {
  return req as _AuthedRequest;
}

// ── SECRET VALIDATION ────────────────────────────────────────
const INSECURE_DEFAULTS = new Set([
  'bridge-dev-secret-CHANGE-IN-PRODUCTION',
  'bridge-refresh-secret-CHANGE-IN-PRODUCTION',
  'CHANGE_ME_LONG_RANDOM_STRING',
  'CHANGE_ME_DIFFERENT_LONG_STRING',
  'secret',
  'changeme',
]);

function _validateSecret(name: string, value: string | undefined): void {
  if (!value) {
    const msg =
      `[Auth] FATAL: ${name} environment variable is missing.\n` +
      `       Generate one with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ secretName: name, event: 'auth.secret.missing' }, msg);
      process.exit(1);
    }
    throw new Error(msg);
  }
  if (INSECURE_DEFAULTS.has(value)) {
    const msg =
      `[Auth] FATAL: ${name} uses an insecure default value.\n` +
      `       Never use this in production. Generate a secure value:\n` +
      `       node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ secretName: name, event: 'auth.secret.insecure_default' }, msg);
      process.exit(1);
    }
    // Dev ortamında: sadece warn ile geçmeyi zorlaştır — görünür banner + 3s gecikme
    // Amaç: geliştiricinin uyarıyı görmeden production'a çıkmasını engellemek.
    // CI ortamında (CI=true) gecikme atlanır.
    console.error('\n' + '█'.repeat(60));
    console.error('█  ⚠️  GÜVENSİZ VARSAYILAN SECRET KULLANILIYOR' + ' '.repeat(13) + '█');
    console.error('█  ' + name.padEnd(55) + '█');
    console.error('█  Production\'a bu değerle ÇIKMA!'.padEnd(59) + '█');
    console.error('█'.repeat(60) + '\n');
    logger.warn({ secretName: name, event: 'auth.secret.insecure_default' }, msg);
    if (process.env.CI !== 'true' && process.env.NODE_ENV !== 'test') {
      // Sync sleep — kasıtlı: geliştirici dikkatini çekmek için
      const start = Date.now();
      while (Date.now() - start < 3000) { /* intentional busy-wait */ }
    }
  }
  if (value.length < 32) {
    const msg = `[Auth] WARNING: ${name} is too short (${value.length} chars). At least 32 chars are recommended.`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ secretName: name, length: value.length, event: 'auth.secret.too_short' }, msg);
      process.exit(1);
    }
    logger.warn({ secretName: name, length: value.length, event: 'auth.secret.too_short' }, msg);
  }
}

_validateSecret('JWT_SECRET', process.env.JWT_SECRET);
_validateSecret('REFRESH_SECRET', process.env.REFRESH_SECRET);

const JWT_SECRET = process.env.JWT_SECRET as string;
const REFRESH_SECRET = process.env.REFRESH_SECRET as string;
const ACCESS_TOKEN_TTL = (process.env.ACCESS_TOKEN_TTL || '15m') as import('jsonwebtoken').SignOptions['expiresIn'];
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || '30d';

// TTL in ms for refresh token DB rows
const REFRESH_TTL_MS = (() => {
  const match = /^(\d+)([dh])$/.exec(REFRESH_TOKEN_TTL);
  if (!match) throw new Error('[Auth] REFRESH_TOKEN_TTL must be an integer followed by d or h');
  const amount = Number(match[1]);
  const unitMs = match[2] === 'd' ? 86_400_000 : 3_600_000;
  const ttl = amount * unitMs;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error('[Auth] REFRESH_TOKEN_TTL is out of range');
  return ttl;
})();

/** REFRESH_SECRET ile HMAC — DB'de düz token saklanmaz. */
function _hashRefreshToken(rawToken: string): string {
  return crypto.createHmac('sha256', REFRESH_SECRET).update(rawToken).digest('hex');
}

async function _findRefreshTokenRow(rawToken: string) {
  const hashed = _hashRefreshToken(rawToken);
  let row = await Auth.findRefreshToken(hashed);
  // Geçiş: eski plain-text kayıtlar (dev/test)
  if (!row && process.env.NODE_ENV !== 'production') {
    row = await Auth.findRefreshToken(rawToken);
  }
  return row;
}

export interface UserLike {
  _id: string;
  username: string;
  tokenVersion?: number;
  isAdmin?: boolean | 0 | 1;
  role?: string;
  flags?: string[];
}

/**
 * MEDYA JETONU — yalnizca `/uploads` yolundaki EK yetkilendirmesi icin.
 *
 * NEDEN AYRI BIR JETON: erisim jetonu 15 dakikada dolar. Medya cerezi bunu
 * tasisaydi, bosta duran bir sekmede `<img>` istekleri 15 dakika sonra 401
 * almaya baslardi (yenileme yalnizca bir API cagrisi 401 alinca tetiklenir).
 * Yani ekler "bazen kirik" gorunurdu.
 *
 * NEDEN DAHA UZUN OMUR GUVENLI: bu jeton YETKI TASIMAZ, yalnizca KIMLIK.
 * Her istekte dosyanin sahibi cozulur ve kanal gorunurlugu / DM / GDM uyeligi
 * YENIDEN hesaplanir. Ayrica cerez `httpOnly`, `sameSite=strict` ve
 * `path=/uploads` kapsamlidir; API uclarina hic gonderilmez.
 */
const MEDIA_TOKEN_TTL = (process.env.MEDIA_TOKEN_TTL || '7d') as import('jsonwebtoken').SignOptions['expiresIn'];

export function makeMediaToken(user: UserLike): string {
  return jwt.sign(
    {
      id: String(user._id ?? ''),
      username: user.username ?? '',
      // IPTAL EDILEBILIRLIK: normal erisim jetonu gibi `v` tasir. Kullanici
      // tum oturumlari iptal ettiginde (tokenVersion artar) medya jetonu da
      // GECERSIZ olur. Medya kolayligi ugruna iptal semantigi ZAYIFLATILMAZ.
      v: parseTokenVersion(user.tokenVersion),
      // Yetki iddiasi TASIMAZ: isAdmin/role/flags BILEREK yok.
      purpose: 'media',
    },
    JWT_SECRET,
    { expiresIn: MEDIA_TOKEN_TTL },
  );
}

export function makeToken(user: UserLike): string {
  const flags = Array.isArray(user.flags) ? user.flags : [];
  const adminByClaims = Boolean(user.isAdmin) || user.role === 'admin' || flags.includes('admin');

  return jwt.sign(
    {
      id: user._id,
      username: user.username,
      v: parseTokenVersion(user.tokenVersion),
      ...(adminByClaims && { isAdmin: true as const }),
      ...(user.role && { role: user.role }),
      ...(flags.length && { flags }),
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

// Each refresh token is a random opaque string stored in the DB
// This allows true rotation: using a token once invalidates it.
// family: her giriş oturumuna yeni bir UUID atanır — token zinciri izlenir.
export async function makeRefreshToken(user: UserLike): Promise<string> {
  const token = crypto.randomBytes(48).toString('hex');
  const family = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  await Auth.insertRefreshTokenRow({
    token: _hashRefreshToken(token),
    userId: user._id,
    expiresAt: now + REFRESH_TTL_MS,
    createdAt: now,
    used: false,
    family,
    tokenVersion: parseTokenVersion(user.tokenVersion),
  });
  return token;
}

export interface RotateResult {
  user: UserLike;
  newToken: string;
}

export type RotateError = 'reuse' | 'expired' | 'not_found' | 'user_not_found' | 'revoked';
export type RotateResultOrError = RotateResult | { error: RotateError };

const _refreshTokenLocks = new Map<string, Promise<void>>();

async function withRefreshTokenLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = _refreshTokenLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  _refreshTokenLocks.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (_refreshTokenLocks.get(key) === tail) _refreshTokenLocks.delete(key);
  }
}

export async function rotateRefreshToken(oldToken: string): Promise<RotateResultOrError | null> {
  const oldTokenHash = _hashRefreshToken(oldToken);
  const now = Date.now();
  const newToken = crypto.randomBytes(48).toString('hex');
  const newTokenHash = _hashRefreshToken(newToken);
  const newFamily = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');

  // Production PostgreSQL path: SELECT ... FOR UPDATE + consume + insert are
  // one transaction. Two concurrent refreshes can no longer both observe
  // the old token as unused.
  const atomic = await Auth.rotateRefreshTokenAtomic({
    oldTokenHash,
    newTokenHash,
    newFamily,
    now,
    expiresAt: now + REFRESH_TTL_MS,
  });
  if (atomic) {
    // `rotateRefreshTokenAtomic` satiri `Record<string, unknown>` olarak
    // dondurur; dogrudan daraltma TS2352 verir (yeterli ortusme yok).
    if (atomic.status === 'ok') return { user: atomic.user as unknown as UserLike, newToken };
    if (atomic.status === 'reuse') {
      logger.warn(
        { event: 'auth.refresh_token.reuse_detected' },
        'Refresh token reuse detected. Revoking token family.'
      );
    }
    return { error: atomic.status as RotateError };
  }

  // Unit-test/in-memory adapter fallback. Serialize by the HMAC of the token
  // so the mock exercises the same one-winner/replay-revokes-family contract.
  return withRefreshTokenLock(oldTokenHash, async () => {
    const row = await _findRefreshTokenRow(oldToken);

    if (row && row.used) {
      logger.warn(
        { userId: row.userId, family: row.family, event: 'auth.refresh_token.reuse_detected' },
        'Refresh token reuse detected. Revoking token family.'
      );
      if (row.family) await Auth.revokeByFamily(row.family);
      else await Auth.revokeAllForUser(row.userId);
      return { error: 'reuse' as RotateError };
    }

    if (!row) return { error: 'not_found' as RotateError };
    let rowExpiresAt: number | null;
    try {
      rowExpiresAt = parsePersistedEpochMillis(row.expiresAt);
    } catch {
      rowExpiresAt = null;
    }
    if (rowExpiresAt === null || rowExpiresAt <= Date.now()) {
      await Auth.revokeRefreshToken(row.token as string);
      return { error: 'expired' as RotateError };
    }

    const family = row.family || newFamily;
    const user = await Users.findById(row.userId);
    if (!user) {
      await Auth.revokeRefreshToken(row.token as string);
      return { error: 'user_not_found' as RotateError };
    }
    let issuedVersion: number | null = null;
    let currentVersion: number | null = null;
    try {
      if (row.tokenVersion === null || row.tokenVersion === undefined) throw new TypeError('Missing refresh tokenVersion');
      issuedVersion = parseTokenVersion(row.tokenVersion);
      currentVersion = parseTokenVersion(user.tokenVersion);
    } catch {
      // Persisted revocation state must never be interpreted through Number()
      // coercion. Treat corruption exactly like a stale generation.
    }
    if (issuedVersion === null || currentVersion === null || issuedVersion !== currentVersion) {
      if (row.family) await Auth.revokeByFamily(row.family);
      else await Auth.revokeRefreshToken(row.token as string);
      return { error: 'revoked' as RotateError };
    }

    await Auth.updateRefreshTokenWhere(
      { token: row.token },
      { $set: { used: true, usedAt: Date.now(), family } }
    );

    await Auth.insertRefreshTokenRow({
      token: newTokenHash,
      userId: user._id,
      expiresAt: Date.now() + REFRESH_TTL_MS,
      createdAt: Date.now(),
      used: false,
      family,
      tokenVersion: currentVersion,
    });
    return { user, newToken };
  });
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  if (!rawToken) return;
  await Auth.revokeRefreshToken(_hashRefreshToken(rawToken));
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await Auth.revokeAllForUser(userId);
}

// Clean expired + used refresh tokens periodically.
// Sprint 62: setInterval module-load side effect kaldırıldı.
// Artık yalnızca startAuthCleanup() çağrıldığında başlar — test ortamlarında
// birden fazla import olursa birden fazla timer oluşmaz.
// server/index.ts'te uygulama başlarken çağrılması gerekir.
let _authCleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startAuthCleanup(): void {
  if (_authCleanupTimer !== null) return;
  _authCleanupTimer = setInterval(async () => {
    try {
      const now = Date.now();
      await Auth.removeRefreshTokensWhere({ expiresAt: { $lt: now } });
      await Auth.removeRefreshTokensWhere({ used: true, usedAt: { $lt: now - 5 * 60_000 } });
    } catch (error) {
      logger.warn({ event: 'auth.refresh_cleanup.failed', error }, 'Refresh-token cleanup failed');
    }
  }, 5 * 60 * 1000);
  _authCleanupTimer.unref?.();
}

export function stopAuthCleanup(): void {
  if (_authCleanupTimer !== null) {
    clearInterval(_authCleanupTimer);
    _authCleanupTimer = null;
  }
}

/** @internal — sadece testlerde kullanılır */
export function _resetAuthCleanupForTest(): void {
  stopAuthCleanup();
}

/**
 * Token dogrular; gecersizse `null` doner.
 *
 * IMZA `string | null | undefined` KABUL EDER — bu bir gevsetme degil,
 * GERCEGIN yazilmasidir: cagiranlarin cogu `authorization?.slice(7)` gibi
 * ISTEGE BAGLI bir degerle gelir ve fonksiyon zaten bu durumda `null`
 * donuyordu (`jwt.verify` firlatir, catch yutar). Imza `string` dedigi surece
 * her cagri yeri ya bir daraltma yazmak ya da cast etmek zorundaydi.
 *
 * FAIL-CLOSED korunur: dizge OLMAYAN her girdi dogrudan `null`dur.
 */
export function verifyToken(token: string | null | undefined): JwtPayload | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Kimlik doğrulamadan ÖNCE çalışan hız sınırlayıcı için hesap kimliği.
 *
 * Final21 Faz 11 (F21-11-04): küresel `/api` sınırlayıcısı rotaların
 * `authMiddleware`inden önce bağlıdır ve `req.user` göremiyordu; aynı NAT
 * arkasındaki kimlikli kullanıcıların hepsi tek bir IP kovasını (200/dk)
 * paylaşıyor ve 10 aşımda IP'nin tamamı banlanıyordu.
 *
 * YALNIZCA imzası doğrulanan erişim jetonu kimlik verir. Medya jetonu ve sahte
 * imza `null`dır (anonim → sıkı IP tavanı). `tokenVersion` burada BİLEREK
 * sorgulanmaz: bu bir yetki kararı değil, sayaç anahtarıdır; iptal edilmiş
 * jeton yine rotanın `authMiddleware`inde 401 alır ve kullanıcı kotasıyla
 * sınırlı kalır. `req.user` AYARLANMAZ — kimlik doğrulaması rotada kalır.
 */
/**
 * Kimliği YALNIZCA imzası doğrulanmış bir erişim jetonundan çıkarır (sayaç anahtarı içindir,
 * yetki kararı DEĞİL: `tokenVersion` sorgulanmaz). Medya jetonu ve sahte imza `null` döner.
 * HTTP küresel sınırlayıcısı (F21-11-04) ve soket bağlantı sınırlayıcısı aynı kuralı kullanır.
 */
export function verifiedTokenSubject(token: unknown): string | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const decoded = verifyToken(token);
  if (!decoded || (decoded as { purpose?: string }).purpose === 'media') return null;
  return typeof decoded.id === 'string' && decoded.id.length > 0 ? decoded.id : null;
}

export function verifiedAccessTokenSubject(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return verifiedTokenSubject(header.slice(7));
}

// Token version cache (avoids DB hit on every request) — LRU eviction
const TOKEN_CACHE_TTL = 30_000;
const MAX_TOKEN_CACHE_ENTRIES = 50_000;

type TokenCacheEntry = { version: number; expiresAt: number };

class LruTokenCache {
  private readonly map = new Map<string, TokenCacheEntry>();

  constructor(private readonly max: number) {}

  get(userId: string): TokenCacheEntry | undefined {
    const entry = this.map.get(userId);
    if (!entry) return undefined;
    this.map.delete(userId);
    this.map.set(userId, entry);
    return entry;
  }

  set(userId: string, entry: TokenCacheEntry): void {
    if (this.map.has(userId)) this.map.delete(userId);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
    this.map.set(userId, entry);
  }

  delete(userId: string): void {
    this.map.delete(userId);
  }
}

const _cache = new LruTokenCache(MAX_TOKEN_CACHE_ENTRIES);

export function _invalidateTokenCache(userId: string): void {
  _cache.delete(userId);
}

function _setTokenCache(userId: string, version: number): void {
  _cache.set(userId, { version, expiresAt: Date.now() + TOKEN_CACHE_TTL });
}

/**
 * Jeton surumu — iptal semantigi. `uploadAuthz` de bunu kullanir ki medya
 * jetonlari oturum iptalini AYNEN onurlandirsin.
 */
export async function getTokenVersion(userId: string): Promise<number | null> {
  return _getTokenVersion(userId);
}

async function _getTokenVersion(userId: string): Promise<number | null> {
  // tokenVersion is an immediate revocation boundary. A worker-local cache is
  // safe only in an explicit single-node deployment; in a Redis-configured
  // cluster another node may bump tokenVersion and cannot invalidate this
  // process's LRU. Bypass it in cluster mode so password/2FA/email security
  // changes take effect on every node without a 30-second stale-token window.
  if (!process.env.REDIS_URL) {
    const cached = _cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.version;
  }
  const user = await Users.findById(userId);
  if (!user) return null;
  const version = parseTokenVersion((user as UserLike & { tokenVersion?: unknown }).tokenVersion);
  if (!process.env.REDIS_URL) _setTokenCache(userId, version);
  return version;
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const decoded = verifyToken(header.slice(7));
  if (!decoded) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // ── AYRICALIK YUKSELTMESI KAPATILDI ────────────────────────────────────────
  // `verifyToken` YALNIZCA imzayi dogrular. Medya jetonu da ayni sirla
  // imzalandigi ve 7 GUN yasadigi icin, denetlenmeseydi API'ye tam erisim
  // saglayan uzun omurlu bir kimlik olurdu (olculdu: /api/servers, /api/me,
  // /api/friends hepsi 200 donuyordu).
  //
  // Medya jetonunun TEK isi `/uploads` altindaki ek yetkilendirmesidir.
  // Burada acikca REDDEDILIR; kapsam ayrimi kanit haline gelir.
  if ((decoded as { purpose?: string }).purpose === 'media') {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  try {
    const currentVersion = await _getTokenVersion(decoded.id);
    if (currentVersion === null) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    if ((decoded.v ?? 0) !== currentVersion) {
      res.status(401).json({ error: 'Token revoked. Please log in again.' });
      return;
    }
    req.user = decoded;
    // Kimlik ARTIK bilinir: korelasyon bağlamına iliştirilir; bundan sonraki
    // her günlük satırı isteği HEM `requestId` HEM sahibiyle gösterir.
    // Yeni bir bağlam AÇILMAZ — o, buraya kadar biriken asenkron zinciri
    // koparırdı.
    attachActor(decoded.id);
    next();
  } catch {
    res.status(500).json({ error: 'Auth check failed' });
  }
}


/**
 * FAZ G1 — YONETICI DENETIMI ARTIK DB GERCEGINE BAKAR.
 *
 * ONCEKI HAL: yetki karari TAMAMEN JWT ICERIGINDEN veriliyordu
 * (`user.isAdmin`, `user.role`, `user.flags`). Bu, "yetkiyle ilgili iddiayi
 * token'dan okuma" kusurudur: yoneticiligi ALINMIS bir kullanici, elindeki
 * token suresi dolana kadar yonetici kalmaya devam ederdi. `tokenVersion`
 * denetimi yalniz oturum iptalini kapsar; rol degisikligini KAPSAMAZ.
 *
 * Olcum: bu fonksiyonun GERCEK cagirani YOKTU (webpush.ts yalnizca import
 * ediyordu, hicbir rotaya baglamiyordu). Yani sevk edilen bir acik degildi —
 * ama ayni ada sahip, DOGRU gorunen ve YANLIS calisan bir tuzakti. Kanonik
 * sahip `routes/admin/middleware.ts::adminOnly`dir ve DB'den okur; bu
 * fonksiyon da ayni sozlesmeye hizalandi.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const claim = (req as AuthRequest).user;
  if (!claim?.id) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const { Users } = await import('../db/repositories');
    const dbUser = await Users.findById(claim.id);
    if (!dbUser?.isAdmin) {
      res.status(403).json({ error: 'Admin required' });
      return;
    }
    next();
  } catch {
    // Fail-closed: cozumleme basarisizsa yonetici DEGIL sayilir.
    res.status(403).json({ error: 'Admin required' });
  }
}
