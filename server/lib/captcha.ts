// server/lib/captcha.ts — Oturum 16: return tipleri, imzasız fonksiyonlar düzeltildi
// CAPTCHA & Bot Koruma Katmanı

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import logger from './logger';
import { fetchT } from './fetch';
import { redisClient } from './redisAdapter';
import { sendSuspiciousLoginAlert as _sendSuspiciousLoginAlert } from './mailer';

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
  maxFailedLogins:             parseInt(process.env.MAX_FAILED_LOGINS   || '5'),
  lockoutMs:                   parseInt(process.env.LOGIN_LOCKOUT_MS    || String(15 * 60_000)),
  maxRegistrationsPerHour:     parseInt(process.env.MAX_REG_PER_HOUR   || '3'),
  progressiveCaptchaThreshold: parseInt(process.env.PROGRESSIVE_CAPTCHA_THRESHOLD || '3'),
  trustedProxies: (process.env.TRUSTED_PROXIES || '127.0.0.1,::1').split(',').map(s => s.trim()),
  tokenBlacklistTtl: parseInt(process.env.CAPTCHA_TOKEN_TTL || '300'),
};

const isEnabled = CFG.enabled && CFG.provider !== 'none';

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

// ── REDIS STORE ───────────────────────────────────────────────
interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
}

// redisClient() singleton döndürür; Redis başlatılmamışsa null gelir (in-memory fallback)
const _redis: RedisClient | null = redisClient() as RedisClient | null;
if (_redis) logger.info({ event: 'captcha.redis_store' }, 'CAPTCHA Redis store aktif.');

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
async function _storeGet(ip: string): Promise<IpData> {
  if (_redis) {
    try {
      const raw = await _redis.get(`captcha:ip:${ip}`);
      if (raw) return JSON.parse(raw) as IpData;
    } catch { /* fallback */ }
  }
  if (!_memStore.has(ip)) _memStore.set(ip, { fails: 0, lockedUntil: 0, regs: [] });
  return _memStore.get(ip)!;
}

async function _storeSet(ip: string, data: IpData): Promise<void> {
  if (_redis) {
    try {
      await _redis.set(`captcha:ip:${ip}`, JSON.stringify(data), 'EX', 7200);
      return;
    } catch { /* fallback */ }
  }
  _memStore.set(ip, data);
}

// ── TOKEN REPLAY KORUMASI ─────────────────────────────────────
async function _markTokenUsed(token: string): Promise<void> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  _usedTokens.set(hash, Date.now() + CFG.tokenBlacklistTtl * 1000);
  if (_redis) {
    try { await _redis.set(`captcha:token:${hash}`, '1', 'EX', CFG.tokenBlacklistTtl); } catch {}
  }
}

async function _isTokenUsed(token: string): Promise<boolean> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  if (_redis) {
    try { if (await _redis.get(`captcha:token:${hash}`)) return true; } catch {}
  }
  const exp = _usedTokens.get(hash);
  return exp ? Date.now() < exp : false;
}

// ── IP DOĞRULAMA ──────────────────────────────────────────────
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|fc00:|fd)/;

function _isTrustedProxy(ip: string): boolean {
  return CFG.trustedProxies.includes(ip) || PRIVATE_IP_RE.test(ip);
}

export function _getIp(req: Request): string {
  const remote = ((req.socket?.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
  if (_isTrustedProxy(remote)) {
    const xff = req.headers['x-forwarded-for'] as string | undefined;
    if (xff) {
      const candidate = xff.split(',')[0].trim().replace(/^::ffff:/, '');
      if (candidate && !PRIVATE_IP_RE.test(candidate)) return candidate;
    }
  }
  return remote;
}

// ── CAPTCHA DOĞRULAMA ─────────────────────────────────────────
export async function verifyCaptcha(
  token: string,
  remoteIp: string,
): Promise<CaptchaVerifyResult> {
  if (!isEnabled) return { ok: true, skip: true };
  if (!token)     return { ok: false, error: 'CAPTCHA token eksik' };

  if (await _isTokenUsed(token)) {
    return { ok: false, error: 'CAPTCHA süresi doldu, tekrar deneyin' };
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
      await _markTokenUsed(token);
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
  const data = await _storeGet(ip);
  data.fails = (data.fails || 0) + 1;
  if (data.fails >= CFG.maxFailedLogins) {
    data.lockedUntil = Date.now() + CFG.lockoutMs;
    logger.warn({ ip, fails: data.fails, event: 'captcha.ip.locked' }, '[CAPTCHA] IP kilitlendi');
  }
  await _storeSet(ip, data);
}

export async function recordSuccessfulLogin(ip: string): Promise<void> {
  const data = await _storeGet(ip);
  data.fails = 0; data.lockedUntil = 0;
  await _storeSet(ip, data);
}

export async function isLoginLocked(ip: string): Promise<boolean> {
  const data = await _storeGet(ip);
  if (!data.lockedUntil) return false;
  if (Date.now() > data.lockedUntil) {
    data.lockedUntil = 0; data.fails = 0;
    await _storeSet(ip, data);
    return false;
  }
  return true;
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
  const data = await _storeGet(ip);
  const now  = Date.now();
  data.regs  = (data.regs || []).filter(t => now - t < 3_600_000);
  data.regs.push(now);
  await _storeSet(ip, data);
}

export async function isRegistrationThrottled(ip: string): Promise<boolean> {
  const data = await _storeGet(ip);
  const now  = Date.now();
  return (data.regs || []).filter(t => now - t < 3_600_000).length >= CFG.maxRegistrationsPerHour;
}

// ── ŞÜPHELİ GİRİŞ TESPİTİ ───────────────────────────────────
const _knownDevices = new Map<string, Set<string>>();

function _deviceFingerprint(req: Request): string {
  const ua   = (req.headers['user-agent'] as string) || '';
  const lang = (req.headers['accept-language'] as string) || '';
  return crypto.createHash('sha256').update(`${ua}|${lang}`).digest('hex').slice(0, 16);
}

export async function checkSuspiciousLogin(
  req: Request,
  user: { _id?: string; username?: string; displayName?: string; email?: string } | null,
): Promise<void> {
  if (!user?._id) return;
  const ip  = _getIp(req);
  const key = String(user._id);
  const fp  = `${ip}:${_deviceFingerprint(req)}`;
  if (!_knownDevices.has(key)) _knownDevices.set(key, new Set());
  const known = _knownDevices.get(key)!;
  if (known.has(fp)) return;
  known.add(fp);
  if (known.size > 20) known.delete(known.values().next().value!);

  logger.info({ username: user.username, ip, event: 'captcha.suspicious_login' }, '[CAPTCHA] Şüpheli giriş');

  if (user.email) {
    try {
      if (typeof _sendSuspiciousLoginAlert === 'function') {
        _sendSuspiciousLoginAlert({
          to:        user.email,
          username:  user.displayName || user.username || user.email || 'user',
          ip,
          userAgent: (req.headers['user-agent'] as string) || 'Bilinmiyor',
          time:      new Date().toLocaleString('tr-TR'),
        }).catch(() => {});
      }
    } catch { /* mailer yoksa atla */ }
  }
}

// ── ACCOUNT ENUMERATION KORUMASI ─────────────────────────────
export const GENERIC_LOGIN_ERROR = 'Kullanıcı adı veya şifre hatalı';

// ── GELİŞMİŞ BOT PUAN SİSTEMİ ────────────────────────────────
export function getBotScore(req: Request): number {
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
export function captchaMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isEnabled) { next(); return; }
  const body = req.body as Record<string, string> | undefined;
  const token = body?.captchaToken || body?.['h-captcha-response'] || body?.['cf-turnstile-response'];
  const ip    = _getIp(req);
  verifyCaptcha(token || '', ip)
    .then(r => r.ok ? next() : res.status(400).json({ error: r.error || 'CAPTCHA doğrulaması başarısız' }))
    .catch(() => next());
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
  }).catch(() => next());
}

export function loginLockMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = _getIp(req);
  Promise.all([isLoginLocked(ip), loginLockRemainingMs(ip)]).then(([locked, remainMs]) => {
    if (!locked) return next();
    const remainSec = Math.ceil(remainMs / 1000);
    return res.status(429).json({ error: `Çok fazla başarısız giriş denemesi. ${Math.ceil(remainSec / 60)} dakika sonra tekrar deneyin.`, retryAfter: remainSec, locked: true });
  }).catch(() => next());
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
  ).catch(() => next());
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
    store:          _redis ? 'redis' : 'memory',
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
