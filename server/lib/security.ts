// server/lib/security.ts
import crypto from 'crypto';

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  "'": '&#x27;', '/': '&#x2F;', '`': '&#x60;', '=': '&#x3D;',
};

export function escapeHtml(str: unknown): string {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"'`=/]/g, c => HTML_ENTITIES[c]);
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
  return name.replace(/<[^>]*>/g, '').trim().slice(0, 32);
}

export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol);
  } catch { return false; }
}

// ── ANTİ-SPAM ────────────────────────────────────────────────
const MAX_SPAM_ENTRIES = 10_000;
interface SpamState { messages: Array<{ content: string; ts: number }>; warned: boolean; muteUntil: number; }
const spamMap = new Map<string, SpamState>();

const SPAM_CONFIG = { maxMessages: 5, windowMs: 4000, duplicateMax: 3, warnBeforeMute: true };

export type SpamResult =
  | { blocked: false; warning?: boolean; reason?: string }
  | { blocked: true; reason: string; remainingMs?: number };

export function checkSpam(userId: string, content: string): SpamResult {
  const now = Date.now();
  const state = spamMap.get(userId) || { messages: [], warned: false, muteUntil: 0 };
  if (state.muteUntil > now) return { blocked: true, reason: 'spam_muted', remainingMs: state.muteUntil - now };
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
  if (!spamMap.has(userId) && spamMap.size >= MAX_SPAM_ENTRIES) spamMap.delete(spamMap.keys().next().value!);
  spamMap.set(userId, state);
  return result;
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, state] of spamMap) {
    if (state.messages.every(m => now - m.ts > 60_000) && state.muteUntil < now) spamMap.delete(uid);
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
const MAX_CSRF_ENTRIES = 50_000;
const csrfTokens = new Map<string, { token: string; expiresAt: number }>();

export function generateCsrfToken(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  if (!csrfTokens.has(userId) && csrfTokens.size >= MAX_CSRF_ENTRIES) csrfTokens.delete(csrfTokens.keys().next().value!);
  csrfTokens.set(userId, { token, expiresAt: Date.now() + 3_600_000 });
  return token;
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, data] of csrfTokens) { if (data.expiresAt < now) csrfTokens.delete(uid); }
}, 10 * 60_000).unref();

export function verifyCsrfToken(userId: string, token: string): boolean {
  const stored = csrfTokens.get(userId);
  if (!stored || stored.expiresAt < Date.now()) return false;
  try { return crypto.timingSafeEqual(Buffer.from(stored.token), Buffer.from(token)); }
  catch { return false; }
}

export function securityHeaders(req: any, res: any, next: () => void): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

// ── PROGRESSIVE RATE LIMIT ───────────────────────────────────
const MAX_VIOLATION_ENTRIES = 50_000;
interface ViolationState { hits: number[]; violations: number; bannedUntil: number; }
const violationMap = new Map<string, ViolationState>();

export type RateLimitResult = { blocked: false } | { blocked: true; bannedUntil: number; violations?: number };

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

module.exports = {
  escapeHtml, sanitizeMessage, sanitizeUsername, sanitizeDisplayName,
  isSafeUrl, checkSpam, validateInput, generateCsrfToken, verifyCsrfToken,
  securityHeaders, progressiveRateLimit,
};
