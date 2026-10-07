// server/lib/security.ts
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { envSafeInt } from './envNumbers';

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
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
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
import { cache, redisAuthoritativeCommand } from './redisAdapter';

function sharedRedisConfigured(): boolean {
  return typeof process.env.REDIS_URL === 'string' && process.env.REDIS_URL.trim().length > 0;
}

async function redisGet<T>(key: string): Promise<T | null> {
  // Deliberate single-node mode keeps the bounded in-process stores below.
  // Once REDIS_URL is configured, security state is authoritative across nodes
  // and must never silently degrade to independent worker-local copies.
  if (!sharedRedisConfigured()) return null;
  try {
    const raw = await redisAuthoritativeCommand(`security get ${key}`, client =>
      (client as { get(k: string): Promise<string | null> }).get(key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Redis security state unavailable: ${key}: ${detail}`, { cause: err });
  }
}

async function redisSet(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  if (!sharedRedisConfigured()) return false;
  try {
    await redisAuthoritativeCommand(`security set ${key}`, client =>
      (client as { set(k: string, v: string, opts: { EX: number }): Promise<unknown> })
        .set(key, JSON.stringify(value), { EX: ttlSeconds }));
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Redis security state unavailable: ${key}: ${detail}`, { cause: err });
  }
}

// ── ANTİ-SPAM ────────────────────────────────────────────────
// Redis'te key: security:spam:<userId>  TTL: 120s
// Fallback: in-memory spamMap

const MAX_SPAM_ENTRIES = 10_000;
interface SpamState {
  messages: Array<{ content: string; ts: number }>;
  warned: boolean;
  muteUntil: number;
  strikes: number;
  strikeWindowStartedAt: number;
}
const spamMap = new Map<string, SpamState>();

const SPAM_CONFIG = Object.freeze({
  maxMessages: envSafeInt('SPAM_MAX_MESSAGES', 5, { min: 1, max: 1_000 }),
  windowMs: envSafeInt('SPAM_WINDOW_MS', 4_000, { min: 100, max: 60_000 }),
  duplicateMax: envSafeInt('SPAM_DUPLICATE_MAX', 3, { min: 1, max: 100 }),
  warnBeforeMute: true,
  strikeWindowMs: envSafeInt('SPAM_STRIKE_WINDOW_MS', 60_000, { min: 1_000, max: 10 * 60_000 }),
  muteAfterStrikes: envSafeInt('SPAM_MUTE_AFTER_STRIKES', 3, { min: 1, max: 100 }),
  muteMs: envSafeInt('SPAM_MUTE_MS', 30_000, { min: 1_000, max: 60 * 60_000 }),
  minRetryMs: envSafeInt('SPAM_MIN_RETRY_MS', 1_000, { min: 100, max: 60_000 }),
});

export type SpamResult =
  | { blocked: false; warning?: boolean; reason?: string }
  | { blocked: true; reason: string; remainingMs?: number };

function _checkSpamSync(userId: string, content: string, state: SpamState): { result: SpamResult; state: SpamState } {
  void userId;
  const now = Date.now();
  if (state.muteUntil > now) {
    return { result: { blocked: true, reason: 'spam_muted', remainingMs: state.muteUntil - now }, state };
  }

  state.messages = state.messages.filter(m => now - m.ts < SPAM_CONFIG.windowMs);
  if (state.messages.length === 0) state.warned = false;
  if (
    state.strikeWindowStartedAt > 0
    && now - state.strikeWindowStartedAt >= SPAM_CONFIG.strikeWindowMs
  ) {
    state.strikes = 0;
    state.strikeWindowStartedAt = 0;
  }

  state.messages.push({ content: content?.trim(), ts: now });
  let result: SpamResult = { blocked: false };

  if (state.messages.length > SPAM_CONFIG.maxMessages) {
    if (!state.warned && SPAM_CONFIG.warnBeforeMute) {
      state.warned = true;
      result = { blocked: false, warning: true, reason: 'spam_warning' };
    } else {
      // Rejected overflow attempts must not make the active message window
      // denser; otherwise an automatic retry is punished for the same burst.
      state.messages.pop();

      if (state.strikeWindowStartedAt === 0) {
        state.strikeWindowStartedAt = now;
        state.strikes = 0;
      }
      state.strikes += 1;

      if (state.strikes >= SPAM_CONFIG.muteAfterStrikes) {
        state.muteUntil = now + SPAM_CONFIG.muteMs;
        state.warned = false;
        state.strikes = 0;
        state.strikeWindowStartedAt = 0;
        result = {
          blocked: true,
          reason: 'spam_rate',
          remainingMs: SPAM_CONFIG.muteMs,
        };
      } else {
        const oldestTs = state.messages[0]?.ts ?? now;
        const untilSlot = Math.max(0, SPAM_CONFIG.windowMs - (now - oldestTs));
        result = {
          blocked: true,
          reason: 'spam_rate',
          remainingMs: Math.max(SPAM_CONFIG.minRetryMs, untilSlot),
        };
      }
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
  return cache.withKeyLock(`security:spam:${userId}`, async () => {
    const redisKey = `security:spam:${userId}`;
    const stored = await redisGet<SpamState>(redisKey);
    const rawState = stored ?? spamMap.get(userId);
    const state: SpamState = rawState
      ? {
          ...rawState,
          strikes: rawState.strikes ?? 0,
          strikeWindowStartedAt: rawState.strikeWindowStartedAt ?? 0,
        }
      : { messages: [], warned: false, muteUntil: 0, strikes: 0, strikeWindowStartedAt: 0 };
    if (!Array.isArray(state.messages) || typeof state.warned !== 'boolean' ||
        !Number.isFinite(state.muteUntil) ||
        !Number.isSafeInteger(state.strikes) || state.strikes < 0 ||
        !Number.isFinite(state.strikeWindowStartedAt) || state.strikeWindowStartedAt < 0 ||
        state.messages.some(m => !m || typeof m !== 'object' || typeof m.content !== 'string' || !Number.isFinite(m.ts))) {
      throw new Error(`Corrupt spam security state: ${userId}`);
    }
    const { result, state: newState } = _checkSpamSync(userId, content, state);
    const strikeRemaining = newState.strikeWindowStartedAt > 0
      ? Math.max(0, SPAM_CONFIG.strikeWindowMs - (Date.now() - newState.strikeWindowStartedAt))
      : 0;
    const ttl = Math.ceil(Math.max(
      SPAM_CONFIG.windowMs,
      newState.muteUntil - Date.now(),
      strikeRemaining,
      0,
    ) / 1000) + 5;
    const saved = await redisSet(redisKey, newState, ttl || 120);
    if (!saved) {
      // Deliberate single-node deployment only: keep the fallback bounded.
      if (!spamMap.has(userId) && spamMap.size >= MAX_SPAM_ENTRIES) spamMap.delete(spamMap.keys().next().value!);
      spamMap.set(userId, newState);
    }
    return result;
  });
}

// Geriye dönük uyumluluk: sync API (in-memory only — Redis'e yazmaz)
// Yeni kod checkSpamAsync kullanmalı.
export function checkSpam(userId: string, content: string): SpamResult {
  const state = spamMap.get(userId) ?? {
    messages: [], warned: false, muteUntil: 0, strikes: 0, strikeWindowStartedAt: 0,
  };
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
// Redis destekli (cok ornekli guvenli) + bellek ici yedek.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK KUSUR — KULLANICI BASINA TEK JETON
// ════════════════════════════════════════════════════════════════════════════
// Jeton `security:csrf:<userId>` altinda TEK bir kayit olarak tutuluyordu ve
// her `generateCsrfToken` cagrisi oncekinin USTUNE YAZIYORDU. Yani ayni
// kullanicinin AYNI ANDA yalnizca BIR gecerli jetonu olabiliyordu.
//
// URUN ETKISI (test kusuru DEGIL): iki sekme. A sekmesi jetonunu alir; B
// sekmesi acilir ve kendi jetonunu alir; bu anda A'nin jetonu GECERSIZ olur.
// A'daki bir sonraki degisiklik istegi "CSRF token invalid or expired" ile
// reddedilir. Ayni sey masaustu uygulamasi + tarayici, ya da yeniden yuklenen
// bir sekme icin de gecerlidir. Gunluk kullanimda cok sekme kacinilmazdir.
//
// Olcum: tam Playwright kosusunda `POST /api/servers` uc kez 403 dondu;
// testler TEK BASINA calistirildiginda geciyordu — cunku es zamanli ikinci
// bir jeton talebi yoktu.
//
// ── COZUM ─────────────────────────────────────────────────────────────────
// Her jeton KENDI anahtarinda saklanir: `security:csrf:<userId>:<token>`.
// Boylece ayni kullanicinin es zamanli birden fazla gecerli jetonu olur.
//
// ── GUVENLIK OZELLIKLERI KORUNDU ──────────────────────────────────────────
//   • jeton hala 32 bayt kriptografik rastgele
//   • jeton hala KULLANICIYA baglidir — anahtar userId icerir, baska bir
//     kullanicinin jetonu bu kullanici icin DOGRULANMAZ
//   • jeton hala 1 saat sonra suresi dolar (TTL anahtarin uzerindedir)
//   • dogrulama artik TAM ANAHTAR ARAMASIDIR: dogru jetonu bilmeyen istek
//     var olmayan bir anahtar sorar. Gizli degeri bayt bayt karsilastirmadigi
//     icin zamanlama yan kanali OLUSMAZ (timingSafeEqual'in amaci buydu).
//   • bellek ici yedek ayni sinirlarla calisir ve toplamda kapaklidir
//
// Es zamanli jeton sayisi TTL ile sinirlidir; ayrica yedek yolda kullanici
// basina kapak vardir. Jeton uretimi `authMiddleware` arkasindadir — kimligi
// dogrulanmamis istek jeton uretemez.
const CSRF_TTL_S        = 3600;
const MAX_CSRF_ENTRIES  = 50_000;
/** Ayni kullanicinin es zamanli tutulan jeton sayisi (yedek yol). */
const MAX_CSRF_PER_USER = 16;

/** key: `<userId>\u0000<token>` → expiresAt */
const csrfTokens = new Map<string, number>();

const csrfKey    = (userId: string, token: string) => `security:csrf:${userId}:${token}`;
const csrfMemKey = (userId: string, token: string) => `${userId}\u0000${token}`;

/** Yedek yolda ayni kullanicinin en eski jetonlarini budar. */
function pruneMemoryTokens(userId: string): void {
  const prefix = `${userId}\u0000`;
  const mine: string[] = [];
  const now = Date.now();
  for (const [k, exp] of csrfTokens) {
    if (exp < now) { csrfTokens.delete(k); continue; }
    if (k.startsWith(prefix)) mine.push(k);
  }
  // Map ekleme sirasini korur — bastan silmek EN ESKIyi siler.
  while (mine.length >= MAX_CSRF_PER_USER) csrfTokens.delete(mine.shift()!);
  while (csrfTokens.size >= MAX_CSRF_ENTRIES) {
    csrfTokens.delete(csrfTokens.keys().next().value!);
  }
}

export async function generateCsrfToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + CSRF_TTL_S * 1000;
  const saved = await redisSet(csrfKey(userId, token), { expiresAt }, CSRF_TTL_S);
  if (!saved) {
    pruneMemoryTokens(userId);
    csrfTokens.set(csrfMemKey(userId, token), expiresAt);
  }
  return token;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of csrfTokens) { if (exp < now) csrfTokens.delete(k); }
}, 10 * 60_000).unref();

export async function verifyCsrfToken(userId: string, token: string): Promise<boolean> {
  // Bicim denetimi: uretilen jeton 64 karakterlik hex'tir. Bu, saldirganin
  // anahtar alanina rastgele icerik enjekte etmesini de engeller.
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  if (typeof userId !== 'string' || !userId) return false;

  const stored = await redisGet<{ expiresAt: number }>(csrfKey(userId, token));
  // Once a shared Redis authority is configured, both positive and negative
  // lookups are authoritative. Never resurrect a token from process-local
  // memory after Redis says the key does not exist; that would let state
  // minted in deliberate single-node mode survive into a clustered/security
  // authority configuration on just one worker.
  if (sharedRedisConfigured()) return !!stored && stored.expiresAt >= Date.now();

  const memExp = csrfTokens.get(csrfMemKey(userId, token));
  if (memExp === undefined) return false;
  if (memExp < Date.now()) { csrfTokens.delete(csrfMemKey(userId, token)); return false; }
  return true;
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Bridge'in BİRİNCİL taraf sesi/görüntüsü vardır (P2P voice + video).
  // Eskiden burada `microphone=()` ve `camera=()` yazıyordu: BOŞ allowlist
  // kaynağın KENDİSİNİ de reddeder, bu yüzden üst düzey Bridge dokümanı
  // `getUserMedia()` çağırdığında Chrome şu ihlali veriyordu:
  //   "Permissions policy violation: microphone is not allowed in this document"
  // Sonuç: sesli sohbet hiçbir tarayıcıda çalışamıyordu.
  //
  // `(self)` yalnızca AYNI KÖKEN'e izin verir — `*` KULLANILMAZ, üçüncü taraf
  // iframe'ler mikrofon/kamera alamaz. `geolocation` kullanılmadığı için
  // reddedilmeye devam eder.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');

  // ── API YANITLARI ONBELLEKLENEMEZ (v1.124.1) ──────────────────────────────
  // OLCULDU: `/api/*` yanitlari HICBIR `Cache-Control` basligi tasimiyordu.
  // Kendi basina bir acik degildi, ama Bridge internete Cloudflare gibi bir
  // onbellek katmaninin ARKASINDA cikacagi icin gercek bir risk haline gelir:
  // baslik yoksa ara katmanlar sezgisel (heuristic) onbellekleme yapabilir ve
  // KIMLIK DOGRULANMIS bir yanit baska bir kullaniciya servis edilebilir.
  //
  // Cloudflare tarafinda "cache bypass" kurali yazmak dogrudur ve
  // CLOUDFLARE-PRODUCTION.md bunu tarif eder — ama guvenlik TEK bir dis
  // yapilandirmaya BIRAKILAMAZ. Yanlis yazilmis ya da sonradan degistirilmis
  // bir edge kurali, sessizce ozel veri sizdirirdi. Kaynak, kendi
  // onbelleklenebilirligini kendisi beyan eder.
  //
  // Yalnizca `/api/*` kapsanir: hashlenmis statik varliklar ve yuklemeler
  // BILEREK disaridadir; onlarin uzun omurlu onbeleklenmesi istenir.
  // `req.path` Express'in turetilmis bir ozelligidir ve her istek benzeri
  // nesnede BULUNMAZ (ic cagrilar, testler, bazi adapterler). Burada patlamak,
  // guvenlik basliklarinin TAMAMINI dusururdu — yani bir onbellek iyilestirmesi
  // uygulamayi guvensiz hale getirirdi. Bu yuzden yol savunmaci turetilir.
  const path = typeof req.path === 'string'
    ? req.path
    : (String((req as { url?: string }).url ?? '').split('?')[0] ?? '');

  if (path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, private');
    // HTTP/1.0 ara katmanlari ve bazi kurumsal vekiller icin.
    res.setHeader('Pragma', 'no-cache');
    // Kimlik/oturum farkli yanit uretir; paylasimli onbellekler ayirt etsin.
    res.setHeader('Vary', 'Authorization, Cookie, Origin');
  }

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
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError('progressive rate limit requires positive safe integer bounds');
  }
  return cache.withKeyLock(`security:violation:${key}`, async () => {
    const redisKey = `security:violation:${key}`;
    const stored = await redisGet<ViolationState>(redisKey);
    const now = Date.now();
    const state: ViolationState = stored ?? { hits: [], violations: 0, bannedUntil: 0 };
    if (!Array.isArray(state.hits) || !Number.isSafeInteger(state.violations) || state.violations < 0 ||
        !Number.isFinite(state.bannedUntil) || state.hits.some(t => !Number.isFinite(t))) {
      throw new Error(`Corrupt progressive rate-limit state: ${key}`);
    }

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
  });
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
