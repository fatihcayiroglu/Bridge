// @ts-nocheck
// server/lib/captcha.js
// CAPTCHA & Bot Koruma Katmanı
//
// v45 İyileştirmeleri:
//   - Redis store (restart & multi-instance güvenli)
//   - Token replay koruması (kullanılan token blacklist)
//   - IP spoofing koruması (güvenilir proxy whitelist)
//   - Progressive CAPTCHA (login'de 3+ denemeden sonra)
//   - Şüpheli giriş e-posta uyarısı (yeni IP/cihaz)
//   - Account enumeration koruması (generic hata mesajları)
//   - Gelişmiş bot puan sistemi (sec-fetch, encoding vb.)
//   - Admin istatistik desteği

'use strict';

const crypto = require('crypto');

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
  console.log(`[CAPTCHA] Sağlayıcı: ${CFG.provider.toUpperCase()} | Aktif: ${isEnabled}`);
}

// ── REDIS STORE ───────────────────────────────────────────────
let _redis = null;
try {
  const { getClient } = require('./redisAdapter');
  _redis = getClient?.() || null;
  if (_redis) console.log('[CAPTCHA] Redis store aktif');
} catch { /* in-memory fallback */ }

const _memStore  = new Map();
const _usedTokens = new Map(); // sha256(token) → expireAt ms

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
async function _storeGet(ip) {
  if (_redis) {
    try {
      const raw = await _redis.get(`captcha:ip:${ip}`);
      if (raw) return JSON.parse(raw);
    } catch { /* fallback */ }
  }
  if (!_memStore.has(ip)) _memStore.set(ip, { fails: 0, lockedUntil: 0, regs: [] });
  return _memStore.get(ip);
}

async function _storeSet(ip, data) {
  if (_redis) {
    try {
      await _redis.set(`captcha:ip:${ip}`, JSON.stringify(data), 'EX', 7200);
      return;
    } catch { /* fallback */ }
  }
  _memStore.set(ip, data);
}

// ── TOKEN REPLAY KORUMASI ─────────────────────────────────────
async function _markTokenUsed(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  _usedTokens.set(hash, Date.now() + CFG.tokenBlacklistTtl * 1000);
  if (_redis) {
    try { await _redis.set(`captcha:token:${hash}`, '1', 'EX', CFG.tokenBlacklistTtl); } catch {}
  }
}

async function _isTokenUsed(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  if (_redis) {
    try { if (await _redis.get(`captcha:token:${hash}`)) return true; } catch {}
  }
  const exp = _usedTokens.get(hash);
  return exp ? Date.now() < exp : false;
}

// ── IP DOĞRULAMA ──────────────────────────────────────────────
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|fc00:|fd)/;

function _isTrustedProxy(ip) {
  return CFG.trustedProxies.includes(ip) || PRIVATE_IP_RE.test(ip);
}

function _getIp(req) {
  const remote = (req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  if (_isTrustedProxy(remote)) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const candidate = xff.split(',')[0].trim().replace(/^::ffff:/, '');
      if (candidate && !PRIVATE_IP_RE.test(candidate)) return candidate;
    }
  }
  return remote;
}

// ── CAPTCHA DOĞRULAMA ─────────────────────────────────────────
async function verifyCaptcha(token, remoteIp) {
  if (!isEnabled) return { ok: true, skip: true };
  if (!token)     return { ok: false, error: 'CAPTCHA token eksik' };

  if (await _isTokenUsed(token)) {
    return { ok: false, error: 'CAPTCHA süresi doldu, tekrar deneyin' };
  }

  try {
    const { secret, verify } = CFG.provider === 'hcaptcha' ? CFG.hcaptcha : CFG.turnstile;
    const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp || '' });
    const r = await fetch(verify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: 'CAPTCHA servisine ulaşılamadı' };
    const data = await r.json();
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
      console.warn('[CAPTCHA] Doğrulama hatası (dev modunda atlandı):', e.message);
      return { ok: true, skip: true };
    }
    return { ok: false, error: 'CAPTCHA servisi geçici olarak kullanılamıyor' };
  }
}

// ── GİRİŞ SAYACI & KİLİT ─────────────────────────────────────
async function recordFailedLogin(ip) {
  const data = await _storeGet(ip);
  data.fails = (data.fails || 0) + 1;
  if (data.fails >= CFG.maxFailedLogins) {
    data.lockedUntil = Date.now() + CFG.lockoutMs;
    console.warn(`[CAPTCHA] IP kilitlendi: ${ip} (${data.fails} başarısız giriş)`);
  }
  await _storeSet(ip, data);
}

async function recordSuccessfulLogin(ip) {
  const data = await _storeGet(ip);
  data.fails = 0; data.lockedUntil = 0;
  await _storeSet(ip, data);
}

async function isLoginLocked(ip) {
  const data = await _storeGet(ip);
  if (!data.lockedUntil) return false;
  if (Date.now() > data.lockedUntil) {
    data.lockedUntil = 0; data.fails = 0;
    await _storeSet(ip, data);
    return false;
  }
  return true;
}

async function loginLockRemainingMs(ip) {
  const data = await _storeGet(ip);
  return Math.max(0, (data.lockedUntil || 0) - Date.now());
}

async function getFailCount(ip) {
  const data = await _storeGet(ip);
  return data.fails || 0;
}

async function shouldShowLoginCaptcha(ip) {
  const fails = await getFailCount(ip);
  return isEnabled && fails >= CFG.progressiveCaptchaThreshold;
}

// ── KAYIT HIZ SINIRI ─────────────────────────────────────────
async function recordRegistration(ip) {
  const data = await _storeGet(ip);
  const now  = Date.now();
  data.regs  = (data.regs || []).filter(t => now - t < 3_600_000);
  data.regs.push(now);
  await _storeSet(ip, data);
}

async function isRegistrationThrottled(ip) {
  const data = await _storeGet(ip);
  const now  = Date.now();
  return (data.regs || []).filter(t => now - t < 3_600_000).length >= CFG.maxRegistrationsPerHour;
}

// ── ŞÜPHELİ GİRİŞ TESPİTİ ───────────────────────────────────
const _knownDevices = new Map(); // userId → Set<"ip:fingerprint">

function _deviceFingerprint(req) {
  const ua   = req.headers['user-agent'] || '';
  const lang = req.headers['accept-language'] || '';
  return crypto.createHash('sha256').update(`${ua}|${lang}`).digest('hex').slice(0, 16);
}

async function checkSuspiciousLogin(req, user) {
  if (!user?._id) return;
  const ip  = _getIp(req);
  const key = String(user._id);
  const fp  = `${ip}:${_deviceFingerprint(req)}`;
  if (!_knownDevices.has(key)) _knownDevices.set(key, new Set());
  const known = _knownDevices.get(key);
  if (known.has(fp)) return;
  known.add(fp);
  if (known.size > 20) known.delete(known.values().next().value);

  console.info(`[CAPTCHA] Şüpheli giriş: user=${user.username} ip=${ip}`);

  if (user.email) {
    try {
      const mailer = require('./mailer');
      if (typeof mailer.sendSuspiciousLoginAlert === 'function') {
        mailer.sendSuspiciousLoginAlert({
          to:        user.email,
          username:  user.displayName || user.username,
          ip,
          userAgent: req.headers['user-agent'] || 'Bilinmiyor',
          time:      new Date().toLocaleString('tr-TR'),
        }).catch(() => {});
      }
    } catch { /* mailer yoksa atla */ }
  }
}

// ── ACCOUNT ENUMERATION KORUMASI ─────────────────────────────
const GENERIC_LOGIN_ERROR = 'Kullanıcı adı veya şifre hatalı';

// ── GELİŞMİŞ BOT PUAN SİSTEMİ ────────────────────────────────
function getBotScore(req) {
  let score = 0;
  const ua  = (req.headers['user-agent'] || '').toLowerCase();
  if (!ua || ua.length < 10) score += 40;
  const botPatterns = ['curl/','wget/','python-requests','python-urllib','go-http-client','libwww','scrapy','axios/','java/','okhttp','ruby','php/','perl/'];
  if (botPatterns.some(p => ua.includes(p))) score += 50;
  if (!req.headers['accept-language']) score += 15;
  if (!req.headers['accept'])          score += 10;
  if (!req.headers['accept-encoding']) score += 10;
  if (!req.headers['connection'])      score += 5;
  if (!req.headers['referer'] && req.headers['origin']) score += 5;
  if (req.method === 'POST' && !req.headers['content-type']) score += 20;
  // Sec-Fetch headers — modern tarayıcılar gönderir
  if (!req.headers['sec-fetch-site'] && !req.headers['sec-fetch-mode'] && ua.includes('chrome')) score += 15;
  // UA "Mozilla" iddiası ama çok kısa
  if (ua.startsWith('mozilla') && ua.length < 40) score += 20;
  return score;
}

// ── MİDDLEWARE'LER ───────────────────────────────────────────

function captchaMiddleware(req, res, next) {
  if (!isEnabled) return next();
  const token = req.body?.captchaToken || req.body?.['h-captcha-response'] || req.body?.['cf-turnstile-response'];
  const ip    = _getIp(req);
  verifyCaptcha(token, ip).then(r => r.ok ? next() : res.status(400).json({ error: r.error || 'CAPTCHA doğrulaması başarısız' })).catch(() => next());
}

function progressiveCaptchaMiddleware(req, res, next) {
  if (!isEnabled) return next();
  const ip = _getIp(req);
  shouldShowLoginCaptcha(ip).then(async needed => {
    if (!needed) return next();
    const token = req.body?.captchaToken || req.body?.['h-captcha-response'] || req.body?.['cf-turnstile-response'];
    if (!token) return res.status(400).json({ error: 'Çok fazla başarısız giriş. Lütfen CAPTCHA\'yı tamamlayın.', requireCaptcha: true });
    const result = await verifyCaptcha(token, ip);
    return result.ok ? next() : res.status(400).json({ error: result.error || 'CAPTCHA doğrulaması başarısız' });
  }).catch(() => next());
}

function loginLockMiddleware(req, res, next) {
  const ip = _getIp(req);
  Promise.all([isLoginLocked(ip), loginLockRemainingMs(ip)]).then(([locked, remainMs]) => {
    if (!locked) return next();
    const remainSec = Math.ceil(remainMs / 1000);
    return res.status(429).json({ error: `Çok fazla başarısız giriş denemesi. ${Math.ceil(remainSec / 60)} dakika sonra tekrar deneyin.`, retryAfter: remainSec, locked: true });
  }).catch(() => next());
}

function botFilterMiddleware(threshold = 60) {
  return (req, res, next) => {
    const score = getBotScore(req);
    if (score >= threshold) {
      console.warn(`[CAPTCHA] Şüpheli istek engellendi (skor: ${score}) — ${_getIp(req)}`);
      return res.status(403).json({ error: 'İstek reddedildi' });
    }
    next();
  };
}

function registrationThrottleMiddleware(req, res, next) {
  const ip = _getIp(req);
  isRegistrationThrottled(ip).then(t => t
    ? res.status(429).json({ error: 'Bu IP adresinden son 1 saat içinde çok fazla hesap oluşturuldu. Lütfen bekleyin.', retryAfter: 3600 })
    : next()
  ).catch(() => next());
}

// ── ADMİN İSTATİSTİKLERİ ─────────────────────────────────────
async function getAdminStats() {
  const now = Date.now();
  const lockedIps = [];
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
function getPublicConfig() {
  return {
    enabled:  isEnabled,
    provider: isEnabled ? CFG.provider : 'none',
    sitekey:  isEnabled ? (CFG.provider === 'hcaptcha' ? CFG.hcaptcha.sitekey : CFG.turnstile.sitekey) : '',
    progressiveCaptchaThreshold: CFG.progressiveCaptchaThreshold,
  };
}

module.exports = {
  verifyCaptcha,
  captchaMiddleware,
  progressiveCaptchaMiddleware,
  loginLockMiddleware,
  botFilterMiddleware,
  registrationThrottleMiddleware,
  recordFailedLogin,
  recordSuccessfulLogin,
  isLoginLocked,
  loginLockRemainingMs,
  getFailCount,
  shouldShowLoginCaptcha,
  recordRegistration,
  isRegistrationThrottled,
  getBotScore,
  checkSuspiciousLogin,
  GENERIC_LOGIN_ERROR,
  getPublicConfig,
  getAdminStats,
  _getIp,
};
export {};
