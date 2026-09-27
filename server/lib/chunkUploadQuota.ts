// server/lib/chunkUploadQuota.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PARÇALI YÜKLEME KOTASI — KULLANICI BAŞINA, DAĞITIK, KAPALI-BAŞARISIZ
// ════════════════════════════════════════════════════════════════════════════
// `/api/upload/chunk` geçici parçaları paylaşılan yükleme biriminde
// (`_chunks/`) biriktirir. Bu modül, bir kimliği doğrulanmış kullanıcının o
// birimde tutabileceği durumu üç eksende sınırlar:
//
//   · eşzamanlı oturum sayısı      (CHUNK_UPLOAD_MAX_SESSIONS, varsayılan 4)
//   · oturum başına işlenmiş bayt   (canlı boost/küresel dosya hakkı — rota verir)
//   · kullanıcı başına toplam bayt  (CHUNK_UPLOAD_MAX_TEMP_MB, varsayılan 400)
//
// Toplam, işlenmiş parçalar ile HENÜZ AKAN isteklerin kiralarını (lease)
// birlikte sayar: yavaş gönderilen onlarca 10 MB'lık gövde de disk tüketir.
// Kira, gövde okunmadan ÖNCE `Content-Length` kadar alınır; bu yüzden hiçbir
// istek ayrılmamış bir baytı diske yazamaz.
//
// ── OTORİTE ────────────────────────────────────────────────────────────────
// `REDIS_URL` tanımlıysa (çok düğümlü dağıtım) TEK otorite Redis'tir. Her
// karar tek bir Lua betiğinde atomik verilir; iki düğüm son oturum yuvası ya
// da son baytlar için yarışırsa yalnız biri kazanır. Redis erişilemezse
// çağrı FIRLATIR ve rota 503 döner — süreç-yerel bir sayaca DÜŞÜLMEZ, çünkü
// o sayaç her düğümde ayrı olur ve sınırı düğüm sayısıyla çarpar.
//
// `REDIS_URL` yoksa dağıtım bilinçli olarak tek düğümdür; aynı durum makinesi
// süreç belleğinde çalışır (`LocalQuotaBackend`). İki arka uç alan-alan aynı
// hash düzenini ve kararları uygular; gerçek Redis eşdeğerliği
// tests/pg-integration/chunk-upload-quota-redis.pgtest.ts ile kanıtlanır.
//
// ── DURUM DÜZENİ (kullanıcı başına TEK hash) ───────────────────────────────
//   a:<sk>             oturumun son etkinliği (ms)
//   s:<sk>             oturumun işlenmiş baytları
//   l:<sk>:<leaseId>   "<bayt>:<bitişMs>:<retry 0|1>" — akan isteğin kirası
//
// Etkinliği `CHUNK_UPLOAD_SESSION_TTL_MIN` kadar eski oturumlar ve süresi
// dolmuş kiralar bir sonraki rezervasyonda düşürülür. Disk tarafı aynı eşikle
// jobs/chunkSessionSweeper.ts tarafından temizlenir.

import crypto from 'crypto';
import { cache } from './redisAdapter';
import { envSafeInt } from './envNumbers';

const MB = 1024 * 1024;

export interface ChunkQuotaConfig {
  maxSessions: number;
  userMaxBytes: number;
  sessionTtlMs: number;
  leaseTtlMs: number;
}

const CONFIG: ChunkQuotaConfig = Object.freeze({
  maxSessions: envSafeInt('CHUNK_UPLOAD_MAX_SESSIONS', 4, { min: 1, max: 1_000 }),
  userMaxBytes: envSafeInt('CHUNK_UPLOAD_MAX_TEMP_MB', 400, { min: 1, max: 1_000_000 }) * MB,
  sessionTtlMs: envSafeInt('CHUNK_UPLOAD_SESSION_TTL_MIN', 60, { min: 1, max: 7 * 24 * 60 }) * 60_000,
  // Must outlive the longest possible request body (Node's default
  // requestTimeout is 300 s). A crashed worker's lease self-expires.
  leaseTtlMs: 15 * 60_000,
});

const KEY_TTL_MS = Math.max(CONFIG.sessionTtlMs, CONFIG.leaseTtlMs) + 60_000;
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

export function chunkQuotaConfig(): ChunkQuotaConfig {
  return CONFIG;
}

export type ChunkQuotaRejection = 'SESSIONS' | 'SESSION_BYTES' | 'USER_BYTES';

export interface ChunkQuotaLease {
  readonly bytes: number;
  /** Convert the in-flight lease into committed session bytes. `gone` means
   * the session no longer exists (released, finalized or expired). */
  commit(now?: number): Promise<'committed' | 'gone'>;
  /** Drop an unconsumed lease. Idempotent; a no-op after commit. */
  refund(): Promise<void>;
  /** Undo a commit whose chunk was not stored (duplicate/conflict/error). */
  uncommit(): Promise<void>;
}

export type ChunkReservation =
  | { ok: true; newSession: boolean; lease: ChunkQuotaLease }
  | { ok: false; reason: ChunkQuotaRejection; sessionInflight: number };

interface ReserveArgs {
  now: number;
  sessionKey: string;
  leaseId: string;
  bytes: number;
  retry: boolean;
  sessionMaxBytes: number;
}

type RawReserve =
  | { status: 'OK'; newSession: boolean }
  | { status: ChunkQuotaRejection; sessionInflight: number };

interface QuotaBackend {
  reserve(userKey: string, args: ReserveArgs): Promise<RawReserve>;
  commit(userKey: string, sessionKey: string, leaseId: string, now: number): Promise<'committed' | 'gone'>;
  refund(userKey: string, sessionKey: string, leaseId: string): Promise<void>;
  uncommit(userKey: string, sessionKey: string, bytes: number): Promise<void>;
  release(userKey: string, sessionKey: string): Promise<void>;
}

// ── Redis (authoritative) ───────────────────────────────────────────────────
// ARGV strings are written back verbatim: Redis formats Lua numbers with
// %.17g, and byte counts / epoch milliseconds must stay exact integers.
const RESERVE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local staleBefore = tonumber(ARGV[2])
local sk = ARGV[3]
local bytes = tonumber(ARGV[5])
local maxSessions = tonumber(ARGV[7])
local sessionMax = tonumber(ARGV[8])
local userMax = tonumber(ARGV[9])
local retry = ARGV[10]

local flat = redis.call('HGETALL', key)
local activity, committed, leases = {}, {}, {}
for i = 1, #flat, 2 do
  local f, v = flat[i], flat[i + 1]
  local kind = string.sub(f, 1, 2)
  -- Raw strings: assigning tonumber(garbage) == nil would drop the table key
  -- and hide a corrupt field from the cleanup below.
  if kind == 'a:' then activity[string.sub(f, 3)] = v
  elseif kind == 's:' then committed[string.sub(f, 3)] = v
  elseif kind == 'l:' then leases[#leases + 1] = { f, v } end
end

local sessions, total = 0, 0
local live = {}
for s, rawAt in pairs(activity) do
  local at = tonumber(rawAt)
  if at == nil or at < staleBefore then
    redis.call('HDEL', key, 'a:' .. s, 's:' .. s)
  else
    live[s] = true
    sessions = sessions + 1
  end
end
local liveCommitted = {}
for s, rawB in pairs(committed) do
  local b = tonumber(rawB) or 0
  if live[s] then
    liveCommitted[s] = b
    total = total + b
  else
    redis.call('HDEL', key, 's:' .. s)
  end
end

local prefix = 'l:' .. sk .. ':'
local sessionInflight, sessionLeases = 0, 0
for _, entry in ipairs(leases) do
  local f, v = entry[1], entry[2]
  local b, exp, r = string.match(v, '^(%d+):(%d+):([01])$')
  if b == nil or tonumber(exp) <= now then
    redis.call('HDEL', key, f)
  else
    total = total + tonumber(b)
    if string.sub(f, 1, #prefix) == prefix then
      sessionLeases = sessionLeases + 1
      if r == '0' then sessionInflight = sessionInflight + tonumber(b) end
    end
  end
end

local isNew = not live[sk]
if isNew and sessions >= maxSessions then return { 'SESSIONS', sessionLeases } end
if retry == '0' and (liveCommitted[sk] or 0) + sessionInflight + bytes > sessionMax then
  return { 'SESSION_BYTES', sessionLeases }
end
if total + bytes > userMax then return { 'USER_BYTES', sessionLeases } end

redis.call('HSET', key, 'a:' .. sk, ARGV[1], prefix .. ARGV[4], ARGV[5] .. ':' .. ARGV[6] .. ':' .. retry)
if isNew then redis.call('HSET', key, 's:' .. sk, '0') end
redis.call('PEXPIRE', key, ARGV[11])
if isNew then return { 'OK', 1 } end
return { 'OK', 0 }
`;

const COMMIT_LUA = `
local key = KEYS[1]
local lf = 'l:' .. ARGV[1] .. ':' .. ARGV[2]
local v = redis.call('HGET', key, lf)
if not v then return 'GONE' end
redis.call('HDEL', key, lf)
if redis.call('HEXISTS', key, 'a:' .. ARGV[1]) == 0 then return 'GONE' end
local b = string.match(v, '^(%d+):')
redis.call('HINCRBY', key, 's:' .. ARGV[1], b)
redis.call('HSET', key, 'a:' .. ARGV[1], ARGV[3])
redis.call('PEXPIRE', key, ARGV[4])
return 'COMMITTED'
`;

const REFUND_LUA = `
return redis.call('HDEL', KEYS[1], 'l:' .. ARGV[1] .. ':' .. ARGV[2])
`;

const UNCOMMIT_LUA = `
local f = 's:' .. ARGV[1]
local cur = tonumber(redis.call('HGET', KEYS[1], f))
if cur == nil then return 0 end
local nextv = cur - tonumber(ARGV[2])
if nextv < 0 then nextv = 0 end
redis.call('HSET', KEYS[1], f, string.format('%.0f', nextv))
return 1
`;

const RELEASE_LUA = `
return redis.call('HDEL', KEYS[1], 'a:' .. ARGV[1], 's:' .. ARGV[1])
`;

function parseReserve(raw: unknown): RawReserve {
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('Malformed chunk quota reply');
  const status = String(raw[0]);
  const value = Number(raw[1]);
  if (status === 'OK') return { status: 'OK', newSession: value === 1 };
  if (status === 'SESSIONS' || status === 'SESSION_BYTES' || status === 'USER_BYTES') {
    return { status, sessionInflight: Number.isFinite(value) ? value : 0 };
  }
  throw new Error(`Unexpected chunk quota reply: ${status}`);
}

class RedisQuotaBackend implements QuotaBackend {
  async reserve(userKey: string, a: ReserveArgs): Promise<RawReserve> {
    return parseReserve(await cache.luaEvalAuthoritative(RESERVE_LUA, [userKey], [
      String(a.now),
      String(a.now - CONFIG.sessionTtlMs),
      a.sessionKey,
      a.leaseId,
      String(a.bytes),
      String(a.now + CONFIG.leaseTtlMs),
      String(CONFIG.maxSessions),
      String(a.sessionMaxBytes),
      String(CONFIG.userMaxBytes),
      a.retry ? '1' : '0',
      String(KEY_TTL_MS),
    ]));
  }

  async commit(userKey: string, sessionKey: string, leaseId: string, now: number): Promise<'committed' | 'gone'> {
    const raw = await cache.luaEvalAuthoritative(COMMIT_LUA, [userKey], [sessionKey, leaseId, String(now), String(KEY_TTL_MS)]);
    if (raw === 'COMMITTED') return 'committed';
    if (raw === 'GONE') return 'gone';
    throw new Error(`Unexpected chunk quota commit reply: ${String(raw)}`);
  }

  async refund(userKey: string, sessionKey: string, leaseId: string): Promise<void> {
    await cache.luaEvalAuthoritative(REFUND_LUA, [userKey], [sessionKey, leaseId]);
  }

  async uncommit(userKey: string, sessionKey: string, bytes: number): Promise<void> {
    await cache.luaEvalAuthoritative(UNCOMMIT_LUA, [userKey], [sessionKey, String(bytes)]);
  }

  async release(userKey: string, sessionKey: string): Promise<void> {
    await cache.luaEvalAuthoritative(RELEASE_LUA, [userKey], [sessionKey]);
  }
}

// ── Local (deliberate single-node mode) ─────────────────────────────────────
// Field-for-field mirror of the Lua scripts above.
class LocalQuotaBackend implements QuotaBackend {
  readonly hashes = new Map<string, { fields: Map<string, string>; expiresAt: number }>();

  private hash(userKey: string, now: number): Map<string, string> {
    const entry = this.hashes.get(userKey);
    if (entry && entry.expiresAt > now) return entry.fields;
    const fields = new Map<string, string>();
    this.hashes.set(userKey, { fields, expiresAt: now + KEY_TTL_MS });
    return fields;
  }

  private touch(userKey: string, now: number): void {
    const entry = this.hashes.get(userKey);
    if (entry) entry.expiresAt = now + KEY_TTL_MS;
  }

  async reserve(userKey: string, a: ReserveArgs): Promise<RawReserve> {
    const h = this.hash(userKey, a.now);
    const staleBefore = a.now - CONFIG.sessionTtlMs;
    const live = new Set<string>();
    let sessions = 0;
    let total = 0;
    for (const [f, v] of [...h]) {
      if (!f.startsWith('a:')) continue;
      const s = f.slice(2);
      const at = Number(v);
      if (!Number.isFinite(at) || at < staleBefore) { h.delete(f); h.delete(`s:${s}`); }
      else { live.add(s); sessions += 1; }
    }
    const committed = new Map<string, number>();
    for (const [f, v] of [...h]) {
      if (!f.startsWith('s:')) continue;
      const s = f.slice(2);
      const b = Number.isFinite(Number(v)) ? Number(v) : 0;
      if (live.has(s)) { committed.set(s, b); total += b; }
      else h.delete(f);
    }
    const prefix = `l:${a.sessionKey}:`;
    let sessionInflight = 0;
    let sessionLeases = 0;
    for (const [f, v] of [...h]) {
      if (!f.startsWith('l:')) continue;
      const m = /^(\d+):(\d+):([01])$/.exec(v);
      if (!m || Number(m[2]) <= a.now) { h.delete(f); continue; }
      total += Number(m[1]);
      if (f.startsWith(prefix)) {
        sessionLeases += 1;
        if (m[3] === '0') sessionInflight += Number(m[1]);
      }
    }

    const isNew = !live.has(a.sessionKey);
    if (isNew && sessions >= CONFIG.maxSessions) return { status: 'SESSIONS', sessionInflight: sessionLeases };
    if (!a.retry && (committed.get(a.sessionKey) ?? 0) + sessionInflight + a.bytes > a.sessionMaxBytes) {
      return { status: 'SESSION_BYTES', sessionInflight: sessionLeases };
    }
    if (total + a.bytes > CONFIG.userMaxBytes) return { status: 'USER_BYTES', sessionInflight: sessionLeases };

    h.set(`a:${a.sessionKey}`, String(a.now));
    h.set(`${prefix}${a.leaseId}`, `${a.bytes}:${a.now + CONFIG.leaseTtlMs}:${a.retry ? '1' : '0'}`);
    if (isNew) h.set(`s:${a.sessionKey}`, '0');
    this.touch(userKey, a.now);
    return { status: 'OK', newSession: isNew };
  }

  async commit(userKey: string, sessionKey: string, leaseId: string, now: number): Promise<'committed' | 'gone'> {
    const h = this.hash(userKey, now);
    const lf = `l:${sessionKey}:${leaseId}`;
    const v = h.get(lf);
    if (v === undefined) return 'gone';
    h.delete(lf);
    if (!h.has(`a:${sessionKey}`)) return 'gone';
    const bytes = Number(/^(\d+):/.exec(v)?.[1] ?? 0);
    h.set(`s:${sessionKey}`, String(Number(h.get(`s:${sessionKey}`) ?? 0) + bytes));
    h.set(`a:${sessionKey}`, String(now));
    this.touch(userKey, now);
    return 'committed';
  }

  async refund(userKey: string, sessionKey: string, leaseId: string): Promise<void> {
    this.hashes.get(userKey)?.fields.delete(`l:${sessionKey}:${leaseId}`);
  }

  async uncommit(userKey: string, sessionKey: string, bytes: number): Promise<void> {
    const h = this.hashes.get(userKey)?.fields;
    const cur = h?.get(`s:${sessionKey}`);
    if (!h || cur === undefined) return;
    h.set(`s:${sessionKey}`, String(Math.max(0, Number(cur) - bytes)));
  }

  async release(userKey: string, sessionKey: string): Promise<void> {
    const h = this.hashes.get(userKey)?.fields;
    h?.delete(`a:${sessionKey}`);
    h?.delete(`s:${sessionKey}`);
  }
}

const localBackend = new LocalQuotaBackend();
const backend: QuotaBackend = REDIS_CONFIGURED ? new RedisQuotaBackend() : localBackend;

/** Opaque per-user key. Raw account ids never appear in shared-store keys; the
 * `{}` hash tag keeps every field of one user on one Redis Cluster slot. */
function userQuotaKey(userId: string): string {
  const digest = crypto.createHash('sha256').update('chunk-quota\0').update(userId).digest('hex').slice(0, 32);
  return `chunk-quota:{${digest}}`;
}

const SESSION_KEY_RE = /^[a-f0-9]{64}$/;

function assertSessionKey(sessionKey: string): void {
  // Session keys are field-name fragments; anything but the canonical digest
  // could forge another session's `:`-delimited field.
  if (!SESSION_KEY_RE.test(sessionKey)) throw new TypeError('Invalid chunk session key');
}

export async function reserveChunkQuota(input: {
  userId: string;
  sessionKey: string;
  bytes: number;
  retry: boolean;
  sessionMaxBytes: number;
  now?: number;
}): Promise<ChunkReservation> {
  if (!input.userId) throw new TypeError('Chunk quota requires an authenticated user');
  assertSessionKey(input.sessionKey);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new TypeError('Invalid chunk byte count');
  if (!Number.isSafeInteger(input.sessionMaxBytes) || input.sessionMaxBytes < 0) throw new TypeError('Invalid session byte limit');

  const userKey = userQuotaKey(input.userId);
  const leaseId = crypto.randomUUID();
  const result = await backend.reserve(userKey, {
    now: input.now ?? Date.now(),
    sessionKey: input.sessionKey,
    leaseId,
    bytes: input.bytes,
    retry: input.retry,
    sessionMaxBytes: input.sessionMaxBytes,
  });
  if (result.status !== 'OK') return { ok: false, reason: result.status, sessionInflight: result.sessionInflight };

  let state: 'open' | 'committed' | 'closed' = 'open';
  const lease: ChunkQuotaLease = {
    bytes: input.bytes,
    async commit(now = Date.now()) {
      if (state !== 'open') throw new Error('Chunk quota lease already settled');
      state = 'committed';
      const outcome = await backend.commit(userKey, input.sessionKey, leaseId, now);
      if (outcome === 'gone') state = 'closed';
      return outcome;
    },
    async refund() {
      if (state !== 'open') return;
      state = 'closed';
      await backend.refund(userKey, input.sessionKey, leaseId);
    },
    async uncommit() {
      if (state !== 'committed') return;
      state = 'closed';
      await backend.uncommit(userKey, input.sessionKey, input.bytes);
    },
  };
  return { ok: true, newSession: result.newSession, lease };
}

/** Forget a finalized or purged session so its slot and bytes are reusable. */
export async function releaseChunkQuotaSession(userId: string, sessionKey: string): Promise<void> {
  assertSessionKey(sessionKey);
  await backend.release(userQuotaKey(userId), sessionKey);
}

/** @internal — tests only: clears the single-node backend. */
export function _resetChunkQuotaForTest(): void {
  localBackend.hashes.clear();
}

/** @internal — tests only: write one raw field (e.g. to model corruption). */
export function _setChunkQuotaFieldForTest(userId: string, field: string, value: string, now = Date.now()): void {
  (localBackend as unknown as { hash(k: string, n: number): Map<string, string> }).hash(userQuotaKey(userId), now).set(field, value);
}

/** @internal — tests only: raw single-node hash for one user. */
export function _chunkQuotaFieldsForTest(userId: string): Record<string, string> {
  return Object.fromEntries(localBackend.hashes.get(userQuotaKey(userId))?.fields ?? []);
}
