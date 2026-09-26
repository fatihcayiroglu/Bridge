// server/lib/captcha.ts — Oturum 16: return tipleri, imzasız fonksiyonlar düzeltildi
// CAPTCHA & Bot Koruma Katmanı

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import type { IpRequestLike } from './clientIp';
import logger from './logger';
import { fetchT } from './fetch';
import { cache, isRedisAvailable } from './redisAdapter';
import { sendSuspiciousLoginAlert as _sendSuspiciousLoginAlert } from './mailer';
import { getClientIp as canonicalClientIp } from './clientIp';
import { envSafeInt } from './envNumbers';

// ── Config ────────────────────────────────────────────────────
const CFG = {
  enabled:    process.env.CAPTCHA_ENABLED !== 'false',
  provider:   process.env.HCAPTCHA_SECRET    ? 'hcaptcha'
            : process.env.TURNSTILE_SECRET   ? 'turnstile'
            : 'none',
  hcaptcha: {
    secret:  process.env.HCAPTCHA_SECRET   || '',
    sitekey: process.env.HCAPTCHA_SITEKEY  || '',
    verify:  'https://api.hcaptcha.com/siteverify',
  },
  turnstile: {
    secret:  process.env.TURNSTILE_SECRET  || '',
    sitekey: process.env.TURNSTILE_SITEKEY || '',
    verify:  'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  },
  maxFailedLogins:             envSafeInt('MAX_FAILED_LOGINS', 5, { min: 1, max: 100_000 }),
  lockoutMs:                   envSafeInt('LOGIN_LOCKOUT_MS', 15 * 60_000, { min: 1_000, max: 30 * 24 * 60 * 60_000 }),
  maxRegistrationsPerHour:     envSafeInt('MAX_REG_PER_HOUR', 3, { min: 1, max: 100_000 }),
  progressiveCaptchaThreshold: envSafeInt('PROGRESSIVE_CAPTCHA_THRESHOLD', 3, { min: 1, max: 100_000 }),
  trustedProxies: (process.env.TRUSTED_PROXIES || '127.0.0.1,::1').split(',').map(s => s.trim()),
  tokenBlacklistTtl: envSafeInt('CAPTCHA_TOKEN_TTL', 300, { min: 1, max: 7 * 24 * 60 * 60 }),
  knownDeviceTtlSec: envSafeInt('SUSPICIOUS_DEVICE_TTL_SEC', 30 * 24 * 3600, { min: 3_600, max: 365 * 24 * 60 * 60 }),
};

const isEnabled = CFG.enabled && CFG.provider !== 'none';
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

if (process.env.NODE_ENV !== 'production') {
  logger.info({ provider: CFG.provider, enabled: isEnabled, event: 'captcha.config' }, 'CAPTCHA yapılandırması yüklendi.');
}

// ── Tipler ────────────────────────────────────────────────────
export interface CaptchaVerifyResult {
  ok:     boolean;
  skip?:  boolean;
  error?: string;
  score?: number;
}

interface IpData {
  fails:       number;
  lockedUntil: number;
  regs:        number[];
}

interface AdminStats {
  store:          string;
  captchaEnabled: boolean;
  provider:       string;
  lockedIps:      Array<{ ip: string; fails: number; remainingSec: number }>;
  usedTokenCount: number;
  memStoreSize:   number;
}

export interface PublicConfig {
  enabled:                      boolean;
  provider:                     string;
  sitekey:                      string;
  progressiveCaptchaThreshold:  number;
}

// ── CAPTCHA STATE ──────────────────────────────────────────────
// Shared cache is the canonical owner for distributed replay state. It resolves
// Redis dynamically instead of capturing a client at module-import time.
const _memStore   = new Map<string, IpData>();
const _usedTokens = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [ip, d] of _memStore) {
    d.regs = (d.regs || []).filter(t => t > cutoff);
    if (!d.fails && !d.lockedUntil && !(d.regs || []).length) _memStore.delete(ip);
  }
  const now = Date.now();
  for (const [t, exp] of _usedTokens) if (exp < now) _usedTokens.delete(t);
}, 3_600_000).unref();

// ── STORE YARDIMCILARI ────────────────────────────────────────
// Mutation serialization prevents GET→SET lost updates in both explicit
// single-node mode and Redis-backed clusters. Security state must never use a
// process-local lock when REDIS_URL declares a shared authority.
const _localMutationTails = new Map<string, Promise<void>>();
async function _withSecurityMutationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (REDIS_CONFIGURED) {
    if (!isRedisAvailable()) throw new Error(`Redis CAPTCHA coordination unavailable: ${key}`);
    return cache.withKeyLock(`captcha-security:${key}`, fn, { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
  }
  const previous = _localMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  _localMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try { return await fn(); }
  finally {
    release();
    if (_localMutationTails.get(key) === tail) _localMutationTails.delete(key);
  }
}

//
// ════════════════════════════════════════════════════════════════════════════
// PAYLAŞILAN DEPO DÜŞTÜĞÜNDE FAIL-CLOSED — VE BU GÖRÜLMELİDİR
// ════════════════════════════════════════════════════════════════════════════
// REDIS_URL configured olduğunda CAPTCHA/login security state için Redis
// kanonik otoritedir. Redis erişilemezse süreç-içi belleğe SEYRELTME YOKTUR:
// lockout, kayıt kotası, replay ve known-device mutation/read yolları hatayı
// çağırana taşır. Böylece N node'lu dağıtımda quota/replay state node başına
// bölünmez.
//
// Deliberate no-Redis single-node modunda historical process-local store
// kullanılabilir; o durumda zaten ilan edilmiş bir shared authority yoktur.
//
// Uyarı KISILIR (throttle): kesinti sırasında saniyede binlerce satır üretmek
// logu kullanılamaz hâle getirirdi ve asıl sinyali gömerdi.
const DEGRADED_LOG_INTERVAL_MS = 60_000;
let _lastDegradedLogAt = 0;
let _degradedSince: number | null = null;
let _degradedEventCount = 0;

function _noteSharedStoreUnavailable(operation: string, err: unknown): void {
  _degradedEventCount++;
  if (_degradedSince === null) _degradedSince = Date.now();
  const now = Date.now();
  if (now - _lastDegradedLogAt < DEGRADED_LOG_INTERVAL_MS) return;
  _lastDegradedLogAt = now;
  logger.warn(
    {
      operation,
      err: err instanceof Error ? err.message : String(err),
      degradedSince: _degradedSince,
      occurrences: _degradedEventCount,
      event: 'captcha.shared_store.degraded',
    },
    REDIS_CONFIGURED
      ? '[CAPTCHA] Redis security authority erişilemez — CAPTCHA/login security state fail-closed reddediliyor.'
      : '[CAPTCHA] Optional cache erişilemez — deliberate single-node process-local CAPTCHA state kullanılıyor.',
  );
}

function _noteSharedStoreHealthy(): void {
  if (_degradedSince === null) return;
  logger.info(
    { degradedForMs: Date.now() - _degradedSince, occurrences: _degradedEventCount, event: 'captcha.shared_store.recovered' },
    '[CAPTCHA] Paylaşılan depo yeniden erişilebilir; küme genelinde koruma geri döndü.',
  );
  _degradedSince = null;
  _degradedEventCount = 0;
}

/** @internal — testler için bozulma durumunu okur/sıfırlar. */
export function _sharedStoreDegradationForTest(): { degradedSince: number | null; occurrences: number } {
  return { degradedSince: _degradedSince, occurrences: _degradedEventCount };
}

/** @internal — testler için bozulma durumunu sıfırlar. */
export function _resetSharedStoreDegradationForTest(): void {
  _degradedSince = null;
  _degradedEventCount = 0;
  _lastDegradedLogAt = 0;
}

async function _storeGet(ip: string): Promise<IpData> {
  try {
    const shared = REDIS_CONFIGURED
      ? await cache.getAuthoritative<unknown>(`captcha:ip:${ip}`)
      : await cache.get<unknown>(`captcha:ip:${ip}`);
    _noteSharedStoreHealthy();
    if (shared !== null) {
      if (!isIpData(shared)) throw new Error(`Malformed CAPTCHA security state for ${ip}`);
      return { fails: shared.fails, lockedUntil: shared.lockedUntil, regs: [...shared.regs] };
    }
  } catch (err) {
    _noteSharedStoreUnavailable('get', err);
    if (REDIS_CONFIGURED) throw err;
  }
  if (!_memStore.has(ip)) _memStore.set(ip, { fails: 0, lockedUntil: 0, regs: [] });
  return _memStore.get(ip)!;
}

async function _storeSet(ip: string, data: IpData): Promise<void> {
  try {
    if (!isIpData(data)) throw new Error(`Malformed CAPTCHA security state for ${ip}`);
    if (REDIS_CONFIGURED) await cache.setAuthoritative(`captcha:ip:${ip}`, data, 7200);
    else await cache.set(`captcha:ip:${ip}`, data, 7200);
    _noteSharedStoreHealthy();
    return;
  } catch (err) {
    _noteSharedStoreUnavailable('set', err);
    if (REDIS_CONFIGURED) throw err;
  }
  _memStore.set(ip, data);
}

function isIpData(value: unknown): value is IpData {
  const v = value as Partial<IpData> | null;
  return !!v && typeof v === 'object'
    && Number.isSafeInteger(v.fails) && Number(v.fails) >= 0
    && Number.isSafeInteger(v.lockedUntil) && Number(v.lockedUntil) >= 0
    && Array.isArray(v.regs)
    && v.regs.every(t => Number.isSafeInteger(t) && t >= 0);
}

// ── TOKEN REPLAY KORUMASI ─────────────────────────────────────
async function _claimTokenUsed(token: string): Promise<boolean> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const claimed = await cache.setIfAbsentAuthoritative(`captcha:token:${hash}`, 1, CFG.tokenBlacklistTtl);
  if (claimed) {
    _usedTokens.set(hash, Date.now() + CFG.tokenBlacklistTtl * 1000);
  }
  return claimed;
}

async function _isTokenUsed(token: string): Promise<boolean> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const shared = await cache.getAuthoritative(`captcha:token:${hash}`);
  if (shared !== null) return true;
  const exp = _usedTokens.get(hash);
  return exp ? Date.now() < exp : false;
}

// ── IP DOĞRULAMA ──────────────────────────────────────────────
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|fc00:|fd)/;

function _isTrustedProxy(ip: string): boolean {
  return CFG.trustedProxies.includes(ip) || PRIVATE_IP_RE.test(ip);
}

// KANONIK COZUMLEYICIYE DEVREDILDI (P1 sinifi).
// Eski kod `xff.split(',')[0]` — yani zincirin ILK hop'unu — aliyordu. O deger
// TAMAMEN istemci tarafindan yazilir: proxy gercek IP'yi SONA ekler. Kapi
// olarak `_isTrustedProxy(remote)` kullanilmasi bunu yalnizca kismen
// sinirliyordu, cunku Docker/Compose kurulumlarinda proxy ZATEN ozel bir
// IP'dir ve kapi her zaman aciliyordu.
//
// SONUC: kayit kotasi (MAX_REG_PER_HOUR = 3/saat/IP) ve bot filtresi
// sahtelenebilir bir anahtara baglaniyordu; saldirgan her istekte farkli bir
// XFF gondererek kotayi TAMAMEN atlayabilirdi.
/**
 * Puanlama ve parmak izi fonksiyonlarinin istekten OKUDUGU yuzey.
 *
 * Bu fonksiyonlar saf hesaplamalardir: Express'in tam `Request` nesnesine
 * degil, yalnizca `headers` / `method` / `body` / istemci IP'sine bagimlidirlar.
 * Imzada tam `Request` talep etmek, hem bagimliligi gizler hem de bu saf
 * mantigin Express disinda (ve testlerde) cagrilmasini imkansizlastirirdi.
 * Gercek `Request` bu sozlesmeye yapisal olarak uyar.
 */
export interface ScoredRequestLike extends IpRequestLike {
  method?: string;
  body?: unknown;
}

export function _getIp(req: ScoredRequestLike): string {
  return canonicalClientIp(req) || 'unknown';
}

// ── CAPTCHA DOĞRULAMA ─────────────────────────────────────────
export async function verifyCaptcha(
  token: string,
  remoteIp: string,
): Promise<CaptchaVerifyResult> {
  if (!isEnabled) return { ok: true, skip: true };
  if (!token)     return { ok: false, error: 'CAPTCHA token eksik' };

  try {
    if (await _isTokenUsed(token)) {
      return { ok: false, error: 'CAPTCHA süresi doldu, tekrar deneyin' };
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message, event: 'captcha.replay_store.read_error' }, '[CAPTCHA] Replay store okunamadı');
    return { ok: false, error: 'CAPTCHA güvenlik deposu geçici olarak kullanılamıyor' };
  }

  try {
    const { secret, verify } = CFG.provider === 'hcaptcha' ? CFG.hcaptcha : CFG.turnstile;
    const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp || '' });
    const r = await fetchT(verify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: 5000,
    });
    if (!r.ok) return { ok: false, error: 'CAPTCHA servisine ulaşılamadı' };
    const data = await r.json() as { success: boolean; 'error-codes'?: string[] };
    if (data.success) {
      // Provider success is not enough: claim the token atomically in the shared
      // replay store so two backend nodes cannot both accept the same response.
      let claimed: boolean;
      try {
        claimed = await _claimTokenUsed(token);
      } catch (e) {
        logger.warn({ err: (e as Error).message, event: 'captcha.replay_store.claim_error' }, '[CAPTCHA] Replay token claim failed');
        return { ok: false, error: 'CAPTCHA güvenlik deposu geçici olarak kullanılamıyor' };
      }
      if (!claimed) {
        return { ok: false, error: 'CAPTCHA süresi doldu, tekrar deneyin' };
      }
      return { ok: true };
    }
    const codes = data['error-codes'] || [];
    if (codes.includes('timeout-or-duplicate')) return { ok: false, error: 'CAPTCHA süresi doldu, tekrar deneyin' };
    if (codes.includes('invalid-input-response')) return { ok: false, error: 'Geçersiz CAPTCHA, tekrar deneyin' };
    return { ok: false, error: 'CAPTCHA doğrulanamadı' };
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn({ err: (e as Error).message, event: 'captcha.verify.error_dev_skip' }, '[CAPTCHA] Doğrulama hatası (dev modunda atlandı)');
      return { ok: true, skip: true };
    }
    return { ok: false, error: 'CAPTCHA servisi geçici olarak kullanılamıyor' };
  }
}

// ── GİRİŞ SAYACI & KİLİT ─────────────────────────────────────
export async function recordFailedLogin(ip: string): Promise<void> {
  await _withSecurityMutationLock(`login:${ip}`, async () => {
    const data = await _storeGet(ip);
    data.fails = (data.fails || 0) + 1;
    if (data.fails >= CFG.maxFailedLogins) {
      data.lockedUntil = Date.now() + CFG.lockoutMs;
      logger.warn({ ip, fails: data.fails, event: 'captcha.ip.locked' }, '[CAPTCHA] IP kilitlendi');
    }
    await _storeSet(ip, data);
  });
}

export async function recordSuccessfulLogin(ip: string): Promise<void> {
  await _withSecurityMutationLock(`login:${ip}`, async () => {
    const data = await _storeGet(ip);
    data.fails = 0; data.lockedUntil = 0;
    await _storeSet(ip, data);
  });
}

export async function isLoginLocked(ip: string): Promise<boolean> {
  return _withSecurityMutationLock(`login:${ip}`, async () => {
    const data = await _storeGet(ip);
    if (!data.lockedUntil) return false;
    if (Date.now() > data.lockedUntil) {
      data.lockedUntil = 0; data.fails = 0;
      await _storeSet(ip, data);
      return false;
    }
    return true;
  });
}

export async function loginLockRemainingMs(ip: string): Promise<number> {
  const data = await _storeGet(ip);
  return Math.max(0, (data.lockedUntil || 0) - Date.now());
}

export async function getFailCount(ip: string): Promise<number> {
  const data = await _storeGet(ip);
  return data.fails || 0;
}

export async function shouldShowLoginCaptcha(ip: string): Promise<boolean> {
  const fails = await getFailCount(ip);
  return isEnabled && fails >= CFG.progressiveCaptchaThreshold;
}

// ── KAYIT HIZ SINIRI ─────────────────────────────────────────
export async function recordRegistration(ip: string): Promise<void> {
  await _withSecurityMutationLock(`registration:${ip}`, async () => {
    const data = await _storeGet(ip);
    const now  = Date.now();
    data.regs  = (data.regs || []).filter(t => now - t < 3_600_000);
    data.regs.push(now);
    await _storeSet(ip, data);
  });
}

/** Atomically reserve one successful-registration quota slot. */
export async function claimRegistrationSlot(ip: string): Promise<boolean> {
  return _withSecurityMutationLock(`registration:${ip}`, async () => {
    const data = await _storeGet(ip);
    const now = Date.now();
    data.regs = (data.regs || []).filter(t => now - t < 3_600_000);
    if (data.regs.length >= CFG.maxRegistrationsPerHour) return false;
    data.regs.push(now);
    await _storeSet(ip, data);
    return true;
  });
}

export async function isRegistrationThrottled(ip: string): Promise<boolean> {
  const data = await _storeGet(ip);
  const now  = Date.now();
  return (data.regs || []).filter(t => now - t < 3_600_000).length >= CFG.maxRegistrationsPerHour;
}

// ── ŞÜPHELİ GİRİŞ TESPİTİ ───────────────────────────────────
function _deviceFingerprint(req: ScoredRequestLike): string {
  const ua   = (req.headers['user-agent'] as string) || '';
  const lang = (req.headers['accept-language'] as string) || '';
  return crypto.createHash('sha256').update(`${ua}|${lang}`).digest('hex').slice(0, 16);
}

export async function checkSuspiciousLogin(
  req: ScoredRequestLike,
  user: { _id?: string; username?: string; displayName?: string; email?: string } | null,
): Promise<void> {
  if (!user?._id) return;
  const ip = _getIp(req);
  const fp = `${ip}:${_deviceFingerprint(req)}`;
  const fpHash = crypto.createHash('sha256').update(fp).digest('hex').slice(0, 32);
  const deviceKey = `captcha:known-device:${String(user._id)}:${fpHash}`;

  let isNewDevice: boolean;
  try {
    isNewDevice = await cache.setIfAbsentAuthoritative(deviceKey, 1, CFG.knownDeviceTtlSec);
  } catch (err) {
    // Suspicious-login email is advisory. Cache uncertainty must not spam the
    // user on every login, so skip the alert and keep authentication unaffected.
    logger.warn({ err, event: 'captcha.known_device_store_error' }, '[CAPTCHA] Known-device store unavailable');
    return;
  }
  if (!isNewDevice) return;

  logger.info({ username: user.username, ip, event: 'captcha.suspicious_login' }, '[CAPTCHA] Şüpheli giriş');

  if (user.email) {
    try {
      if (typeof _sendSuspiciousLoginAlert === 'function') {
        await _sendSuspiciousLoginAlert({
          to:        user.email,
          username:  user.displayName || user.username || user.email || 'user',
          ip,
          userAgent: (req.headers['user-agent'] as string) || 'Bilinmiyor',
          time:      new Date().toLocaleString('tr-TR'),
        });
      }
    } catch (err) {
      // Advisory alert failure must not block authentication, but it must be
      // observable: silently dropping a security notification hides outages.
      logger.warn({ err, userId: user._id, event: 'captcha.suspicious_login_alert_failed' },
        '[CAPTCHA] Suspicious-login alert could not be delivered');
    }
  }
}

// ── ACCOUNT ENUMERATION KORUMASI ─────────────────────────────
export const GENERIC_LOGIN_ERROR = 'Kullanıcı adı veya şifre hatalı';

// ── GELİŞMİŞ BOT PUAN SİSTEMİ ────────────────────────────────
export function getBotScore(req: ScoredRequestLike): number {
  let score = 0;
  const ua  = ((req.headers['user-agent'] as string) || '').toLowerCase();
  if (!ua || ua.length < 10) score += 40;
  const botPatterns = ['curl/','wget/','python-requests','python-urllib','go-http-client','libwww','scrapy','axios/','java/','okhttp','ruby','php/','perl/'];
  if (botPatterns.some(p => ua.includes(p))) score += 50;
  if (!req.headers['accept-language']) score += 15;
  if (!req.headers['accept'])          score += 10;
  if (!req.headers['accept-encoding']) score += 10;
  if (!req.headers['connection'])      score += 5;
  if (!req.headers['referer'] && req.headers['origin']) score += 5;
  if (req.method === 'POST' && !req.headers['content-type']) score += 20;
  if (!req.headers['sec-fetch-site'] && !req.headers['sec-fetch-mode'] && ua.includes('chrome')) score += 15;
  if (ua.startsWith('mozilla') && ua.length < 40) score += 20;
  return score;
}

// ── MİDDLEWARE'LER ───────────────────────────────────────────
function failClosedSecurityMiddleware(
  res: Response,
  scope: string,
  error: unknown,
): Response {
  logger.error(
    { err: error instanceof Error ? error.message : String(error), scope, event: 'captcha.security_middleware.failure' },
    '[CAPTCHA] Güvenlik middleware hatası; istek fail-closed reddedildi.',
  );
  return res.status(503).json({ error: 'Güvenlik doğrulaması geçici olarak kullanılamıyor' });
}

export function captchaMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isEnabled) { next(); return; }
  const body = req.body as Record<string, string> | undefined;
  const token = body?.captchaToken || body?.['h-captcha-response'] || body?.['cf-turnstile-response'];
  const ip    = _getIp(req);
  verifyCaptcha(token || '', ip)
    .then(r => r.ok ? next() : res.status(400).json({ error: r.error || 'CAPTCHA doğrulaması başarısız' }))
    .catch(error => { failClosedSecurityMiddleware(res, 'captcha', error); });
}

export function progressiveCaptchaMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isEnabled) { next(); return; }
  const ip = _getIp(req);
  shouldShowLoginCaptcha(ip).then(async needed => {
    if (!needed) return next();
    const body  = req.body as Record<string, string> | undefined;
    const token = body?.captchaToken || body?.['h-captcha-response'] || body?.['cf-turnstile-response'];
    if (!token) return res.status(400).json({ error: "Çok fazla başarısız giriş. Lütfen CAPTCHA'yı tamamlayın.", requireCaptcha: true });
    const result = await verifyCaptcha(token, ip);
    return result.ok ? next() : res.status(400).json({ error: result.error || 'CAPTCHA doğrulaması başarısız' });
  }).catch(error => { failClosedSecurityMiddleware(res, 'progressive-captcha', error); });
}

export function loginLockMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = _getIp(req);
  Promise.all([isLoginLocked(ip), loginLockRemainingMs(ip)]).then(([locked, remainMs]) => {
    if (!locked) return next();
    const remainSec = Math.ceil(remainMs / 1000);
    return res.status(429).json({ error: `Çok fazla başarısız giriş denemesi. ${Math.ceil(remainSec / 60)} dakika sonra tekrar deneyin.`, retryAfter: remainSec, locked: true });
  }).catch(error => { failClosedSecurityMiddleware(res, 'login-lock', error); });
}

export function botFilterMiddleware(threshold: number = 60) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const score = getBotScore(req);
    if (score >= threshold) {
      logger.warn({ score, ip: _getIp(req), event: 'captcha.bot_filter.blocked' }, '[CAPTCHA] Şüpheli istek engellendi');
      res.status(403).json({ error: 'İstek reddedildi' });
      return;
    }
    next();
  };
}

export function registrationThrottleMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = _getIp(req);
  isRegistrationThrottled(ip).then(t => t
    ? res.status(429).json({ error: 'Bu IP adresinden son 1 saat içinde çok fazla hesap oluşturuldu. Lütfen bekleyin.', retryAfter: 3600 })
    : next()
  ).catch(error => { failClosedSecurityMiddleware(res, 'registration-throttle', error); });
}

// ── ADMİN İSTATİSTİKLERİ ─────────────────────────────────────
export async function getAdminStats(): Promise<AdminStats> {
  const now = Date.now();
  const lockedIps: AdminStats['lockedIps'] = [];
  for (const [ip, d] of _memStore) {
    if (d.lockedUntil && d.lockedUntil > now) {
      lockedIps.push({ ip, fails: d.fails, remainingSec: Math.ceil((d.lockedUntil - now) / 1000) });
    }
  }
  return {
    store:          isRedisAvailable() ? 'redis' : 'memory',
    captchaEnabled: isEnabled,
    provider:       CFG.provider,
    lockedIps,
    usedTokenCount: _usedTokens.size,
    memStoreSize:   _memStore.size,
  };
}

// ── PUBLIC CONFIG ─────────────────────────────────────────────
export function getPublicConfig(): PublicConfig {
  return {
    enabled:  isEnabled,
    provider: isEnabled ? CFG.provider : 'none',
    sitekey:  isEnabled ? (CFG.provider === 'hcaptcha' ? CFG.hcaptcha.sitekey : CFG.turnstile.sitekey) : '',
    progressiveCaptchaThreshold: CFG.progressiveCaptchaThreshold,
  };
}


export default {
  _getIp,
  recordFailedLogin,
  recordSuccessfulLogin,
  recordRegistration,
  claimRegistrationSlot,
  isLoginLocked,
  getBotScore,
  verifyCaptcha,
  captchaMiddleware,
  botFilterMiddleware,
  registrationThrottleMiddleware,
  progressiveCaptchaMiddleware,
  loginLockMiddleware,
  checkSuspiciousLogin,
  getAdminStats,
  getPublicConfig,
  GENERIC_LOGIN_ERROR,
};
