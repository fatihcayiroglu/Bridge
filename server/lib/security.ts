// server/lib/security.ts
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import logger from './logger';

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  "'": '&#x27;', '/': '&#x2F;', '`': '&#x60;', '=': '&#x3D;',
};

export function escapeHtml(str: unknown): string {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"'`=/]/g, (c: string) => HTML_ENTITIES[c] ?? c);
}

export function sanitizeMessage(content: unknown): string {
  if (typeof content !== 'string') return '';
  return content
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/data:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim()
    .slice(0, 2000);
}

export function sanitizeUsername(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.replace(/[^a-zA-Z0-9_.ÇĞİÖŞÜçğışöşü-]/g, '').trim().slice(0, 32);
}

export function sanitizeDisplayName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .replace(/<[^>]*>/g, '')           // HTML tag sil
    .replace(/javascript\s*:/gi, '')   // javascript: protokol
    .replace(/data\s*:/gi, '')         // data: URI
    .replace(/on\w+\s*=/gi, '')        // onerror= onclick= vb.
    .replace(/\u0000/g, '')            // null byte
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width karakter
    .trim()
    .slice(0, 32);
}

export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol);
  } catch { return false; }
}

// ── REDIS STORE (spam + progressive rate limit) ───────────────
// Redis varsa kullanır; yoksa in-memory fallback devreye girer.
// Çok instance'lı deploy'da tüm node'lar aynı state'i görür.

// Sprint 121 FIX 24: Bağımsız Redis client oluşturmak yerine redisAdapter'daki
// paylaşımlı client kullanılıyor — üç ayrı bağlantı havuzu → tek havuz.
import { redisClient as _sharedRedisClient, isRedisAvailable } from './redisAdapter';

async function redisGet<T>(key: string): Promise<T | null> {
  if (!isRedisAvailable()) return null;
  const client = _sharedRedisClient();
  if (!client) return null;
  try {
    const raw = await (client as { get(k: string): Promise<string | null> }).get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

async function redisSet(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  if (!isRedisAvailable()) return false;
  const client = _sharedRedisClient();
  if (!client) return false;
  try {
    await (client as { set(k: string, v: string, opts: { EX: number }): Promise<unknown> })
      .set(key, JSON.stringify(value), { EX: ttlSeconds });
    return true;
  } catch { return false; }
}

async function redisDel(key: string): Promise<void> {
  if (!isRedisAvailable()) return;
  const client = _sharedRedisClient();
  if (!client) return;
  try { await (client as { del(k: string): Promise<unknown> }).del(key); } catch { /* non-fatal */ }
}

// ── ANTİ-SPAM ────────────────────────────────────────────────
// Redis'te key: security:spam:<userId>  TTL: 120s
// Fallback: in-memory spamMap

const MAX_SPAM_ENTRIES = 10_000;
interface SpamState { messages: Array<{ content: string; ts: number }>; warned: boolean; muteUntil: number; }
const spamMap = new Map<string, SpamState>();

const SPAM_CONFIG = { maxMessages: 5, windowMs: 4000, duplicateMax: 3, warnBeforeMute: true };

export type SpamResult =
  | { blocked: false; warning?: boolean; reason?: string }
  | { blocked: true; reason: string; remainingMs?: number };

function _checkSpamSync(userId: string, content: string, state: SpamState): { result: SpamResult; state: SpamState } {
  const now = Date.now();
  if (state.muteUntil > now) return { result: { blocked: true, reason: 'spam_muted', remainingMs: state.muteUntil - now }, state };
  state.messages = state.messages.filter(m => now - m.ts < SPAM_CONFIG.windowMs);
  state.messages.push({ content: content?.trim(), ts: now });
  let result: SpamResult = { blocked: false };
  if (state.messages.length > SPAM_CONFIG.maxMessages) {
    if (!state.warned && SPAM_CONFIG.warnBeforeMute) {
      state.warned = true;
      result = { blocked: false, warning: true, reason: 'spam_warning' };
    } else {
      state.muteUntil = now + 30_000;
      state.warned = false;
      result = { blocked: true, reason: 'spam_rate', remainingMs: 30_000 };
    }
  }
  const trimmed = content?.trim().toLowerCase();
  if (trimmed) {
    const dupCount = state.messages.filter(m => m.content?.toLowerCase() === trimmed).length;
    if (dupCount > SPAM_CONFIG.duplicateMax) result = { blocked: true, reason: 'spam_duplicate' };
  }
  return { result, state };
}

export async function checkSpamAsync(userId: string, content: string): Promise<SpamResult> {
  const redisKey = `security:spam:${userId}`;
  const stored = await redisGet<SpamState>(redisKey);
  const state: SpamState = stored ?? { messages: [], warned: false, muteUntil: 0 };
  const { result, state: newState } = _checkSpamSync(userId, content, state);
  const ttl = Math.ceil(Math.max(SPAM_CONFIG.windowMs, newState.muteUntil - Date.now(), 0) / 1000) + 5;
  const saved = await redisSet(redisKey, newState, ttl || 120);
  if (!saved) {
    // Redis başarısız — in-memory fallback
    if (!spamMap.has(userId) && spamMap.size >= MAX_SPAM_ENTRIES) spamMap.delete(spamMap.keys().next().value!);
    spamMap.set(userId, newState);
  }
  return result;
}

// Geriye dönük uyumluluk: sync API (in-memory only — Redis'e yazmaz)
// Yeni kod checkSpamAsync kullanmalı.
export function checkSpam(userId: string, content: string): SpamResult {
  const state = spamMap.get(userId) ?? { messages: [], warned: false, muteUntil: 0 };
  const { result, state: newState } = _checkSpamSync(userId, content, state);
  if (!spamMap.has(userId) && spamMap.size >= MAX_SPAM_ENTRIES) spamMap.delete(spamMap.keys().next().value!);
  spamMap.set(userId, newState);
  return result;
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, state] of spamMap) {
    const messagesStale = state.messages.every(m => now - m.ts > 60_000);
    const muteExpired   = state.muteUntil < now;
    if (muteExpired && messagesStale) { spamMap.delete(uid); continue; }
    if (muteExpired && !state.messages.length) spamMap.delete(uid);
  }
}, 60_000).unref();

// ── INPUT VALİDATİON ─────────────────────────────────────────
type Validator = (v: unknown) => string | null;
const validators: Record<string, Validator> = {
  messageContent(v) {
    if (typeof v !== 'string') return 'content must be a string';
    if (!v.trim()) return 'content cannot be empty';
    if (v.length > 2000) return 'content too long (max 2000)';
    return null;
  },
  username(v) {
    if (typeof v !== 'string') return 'username must be a string';
    if (v.length < 3) return 'username too short (min 3)';
    if (v.length > 32) return 'username too long (max 32)';
    if (!/^[a-zA-Z0-9_]+$/.test(v)) return 'username can only contain letters, numbers, underscores';
    const reserved = ['everyone', 'here', 'bridge', 'admin', 'system', 'bot'];
    if (reserved.includes(v.toLowerCase())) return 'username is reserved';
    return null;
  },
  password(v) {
    if (typeof v !== 'string') return 'password must be a string';
    if (v.length < 8) return 'password too short (min 8)';
    if (v.length > 128) return 'password too long';
    if (/^(.)\1+$/.test(v)) return 'password too simple';
    return null;
  },
  serverName(v) {
    if (typeof v !== 'string') return 'name must be a string';
    if (!v.trim()) return 'name required';
    if (v.length > 50) return 'name too long (max 50)';
    if (/<[^>]*>/.test(v)) return 'name contains invalid characters';
    return null;
  },
  channelName(v) {
    if (typeof v !== 'string') return 'name must be a string';
    if (!v.trim()) return 'name required';
    if (v.length > 32) return 'channel name too long (max 32)';
    if (!/^[a-z0-9\-_ğüşöçıİĞÜŞÖÇ ]+$/i.test(v)) return 'channel name has invalid characters';
    return null;
  },
};

export function validateInput(field: string, value: unknown): string | null {
  const validator = validators[field];
  if (!validator) return null;
  return validator(value);
}

// ── CSRF ─────────────────────────────────────────────────────
// Redis-backed (multi-instance safe) + in-memory LRU fallback.
const CSRF_TTL_S       = 3600;
const MAX_CSRF_ENTRIES = 50_000;
const csrfTokens = new Map<string, { token: string; expiresAt: number }>();

export async function generateCsrfToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const payload = { token, expiresAt: Date.now() + CSRF_TTL_S * 1000 };
  const saved = await redisSet(`security:csrf:${userId}`, payload, CSRF_TTL_S);
  if (!saved) {
    if (!csrfTokens.has(userId) && csrfTokens.size >= MAX_CSRF_ENTRIES) {
      csrfTokens.delete(csrfTokens.keys().next().value!);
    }
    csrfTokens.set(userId, payload);
  }
  return token;
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, data] of csrfTokens) { if (data.expiresAt < now) csrfTokens.delete(uid); }
}, 10 * 60_000).unref();

export async function verifyCsrfToken(userId: string, token: string): Promise<boolean> {
  const redisStored = await redisGet<{ token: string; expiresAt: number }>(`security:csrf:${userId}`);
  const stored = redisStored ?? csrfTokens.get(userId);
  if (!stored || stored.expiresAt < Date.now()) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(stored.token), Buffer.from(token));
  } catch { return false; }
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

// ── PROGRESSIVE RATE LIMIT ───────────────────────────────────
// Redis'te key: security:violation:<key>  TTL: 3700s
// Fallback: in-memory violationMap

const MAX_VIOLATION_ENTRIES = 50_000;
interface ViolationState { hits: number[]; violations: number; bannedUntil: number; }
const violationMap = new Map<string, ViolationState>();

export type RateLimitResult = { blocked: false } | { blocked: true; bannedUntil: number; violations?: number };

export async function progressiveRateLimitAsync(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  const redisKey = `security:violation:${key}`;
  const stored = await redisGet<ViolationState>(redisKey);
  const now = Date.now();
  const state: ViolationState = stored ?? { hits: [], violations: 0, bannedUntil: 0 };

  if (state.bannedUntil > now) return { blocked: true, bannedUntil: state.bannedUntil };

  state.hits = state.hits.filter(t => now - t < windowMs);
  state.hits.push(now);

  let result: RateLimitResult = { blocked: false };
  if (state.hits.length > max) {
    state.violations++;
    const banMs = Math.min(windowMs * Math.pow(2, state.violations - 1), 3_600_000);
    state.bannedUntil = now + banMs;
    state.hits = [];
    result = { blocked: true, bannedUntil: state.bannedUntil, violations: state.violations };
  }

  const ttl = Math.ceil(Math.max(windowMs, state.bannedUntil - now, 0) / 1000) + 100;
  const saved = await redisSet(redisKey, state, ttl || 3700);
  if (!saved) {
    if (!violationMap.has(key) && violationMap.size >= MAX_VIOLATION_ENTRIES) violationMap.delete(violationMap.keys().next().value!);
    violationMap.set(key, state);
  }

  return result;
}

// Geriye dönük uyumluluk: sync API (in-memory only)
// Yeni kod progressiveRateLimitAsync kullanmalı.
export function progressiveRateLimit(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const state = violationMap.get(key) || { hits: [], violations: 0, bannedUntil: 0 };
  if (state.bannedUntil > now) return { blocked: true, bannedUntil: state.bannedUntil };
  state.hits = state.hits.filter(t => now - t < windowMs);
  state.hits.push(now);
  if (!violationMap.has(key) && violationMap.size >= MAX_VIOLATION_ENTRIES) violationMap.delete(violationMap.keys().next().value!);
  violationMap.set(key, state);
  if (state.hits.length > max) {
    state.violations++;
    const banMs = Math.min(windowMs * Math.pow(2, state.violations - 1), 3_600_000);
    state.bannedUntil = now + banMs;
    state.hits = [];
    violationMap.set(key, state);
    return { blocked: true, bannedUntil: state.bannedUntil, violations: state.violations };
  }
  return { blocked: false };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of violationMap) {
    if (s.bannedUntil < now && s.hits.every(t => now - t > 300_000)) violationMap.delete(k);
  }
}, 5 * 60_000).unref();

// exports above are inline (export keyword on each function)
