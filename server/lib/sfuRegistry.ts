// server/lib/sfuRegistry.ts — Oturum 17: redis tipi, fonksiyon imzaları
// SFU oda kaydı — cluster modda hangi node hangi ses odasını yönetiyor.

import { randomUUID } from 'crypto';
import logger from './logger';
import { tryRequire } from './_optional-require';
import { envSafeInt } from './envNumbers';

// ── Tipler ────────────────────────────────────────────────────
interface RedisClient {
  setEx(key: string, ttl: number, value: string): Promise<unknown>;
  /**
   * `SET key value NX EX ttl` — ATOMİK koşullu yazma.
   * `NX` başarısızsa `null` döner (anahtar zaten var).
   * Bu imza `claimRoom`'un yarış-serbest olabilmesi için gereklidir.
   */
  set(key: string, value: string, opts: { NX?: boolean; EX?: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  expire(key: string, ttl: number): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  ttl(key: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  on(event: string, cb: (err?: Error) => void): void;
  connect(): Promise<void>;
  withAbortSignal?(signal: AbortSignal): RedisClient;
  destroy?(): void;
}

export interface RoomEntry {
  channelId: string;
  nodeId:    string;
}

export interface SfuStats {
  mode:       'single-node' | 'cluster';
  instanceId: string;
  totalRooms: number;
  localRooms: number;
  rooms:      Array<RoomEntry & { ttlSeconds: number }>;
}

// ── Sabitler ──────────────────────────────────────────────────
let redis: RedisClient | null = null;
let redisConnectPromise: Promise<RedisClient> | null = null;

export const INSTANCE_ID = process.env.INSTANCE_ID || `node-${process.pid}`;
const KEY_PREFIX          = 'bridge:sfu:room:';
export const ROOM_LEASE_TTL_SECONDS = 3600;
const TTL_SECONDS         = ROOM_LEASE_TTL_SECONDS;
const REDIS_COMMAND_TIMEOUT_MS = envSafeInt('REDIS_COMMAND_TIMEOUT_MS', 2_000, { min: 100, max: 30_000 });

// ════════════════════════════════════════════════════════════════════════════
// ODA SAHİBİNİN CANLILIĞI (P1 çok-düğüm: SFU-05, SFU-08)
// ════════════════════════════════════════════════════════════════════════════
// Oda anahtarı sahibini bir saat tutar. Sahip düğüm ÖLÜRSE (SIGKILL, OOM,
// düğüm kaybı) anahtar TTL dolana kadar ölü sahibi gösteriyordu: ÖLÇÜLDÜ —
// hayatta kalan düğümlere gelen her katılım ölü düğüme yönlendirildi ve oda
// ~1 saat kullanılamadı. Redis BOŞ yeniden başladığında ise canlı odanın kaydı
// kayboldu ve başka bir düğüm AYNI kanal için ikinci bir router açtı
// (bölünmüş beyin; yeni katılımcı eskileri duyamadı).
//
//  · Her düğüm kısa bir canlılık kirası tutar (`bridge:sfu:node:<id>`,
//    SFU_NODE_LEASE_MS, varsayılan 30 sn) ve NODE_HEARTBEAT_MS'de bir yeniler.
//  · Talep: sahip YOKSA → al; sahip BİZSEK → tazele; sahip CANLIYSA →
//    yönlendir; sahibin canlılık kirası YOKSA → atomik devral.
//  · Sahip, her kalp atışında yerel odalarını yeniden ilan eder: başkası
//    almışsa yerel oda kapanır (fail-closed); kayıt kaybolmuşsa geri yazar.
//  · Kayıt dönemi (`bridge:sfu:registry-epoch`) yeni oluşmuşsa (ilk açılış ya
//    da veri kaybı) BOŞ bir odanın yeni talebi REGISTRY_SETTLE_MS boyunca
//    reddedilir: canlı sahipler bu sürede odalarını yeniden ilan eder.
//  · Kirasını doğrulayamayan düğüm, kira dolmadan (NODE_LEASE_MS - 5 sn)
//    yerel odalarını kapatır (rooms.ts); böylece devralma iki router açamaz.
//
// Not: betikler sahibin canlılık anahtarını sahip değerinden türetir; bu,
// Redis Cluster'ın tek-slot kuralına uymaz. Bridge tek bir Redis/Sentinel
// dağıtımı kullanır (createClient), Redis Cluster kullanmaz.
const NODE_KEY_PREFIX = 'bridge:sfu:node:';
const EPOCH_KEY       = 'bridge:sfu:registry-epoch';
export const NODE_LEASE_MS = envSafeInt('SFU_NODE_LEASE_MS', 30_000, { min: 3_000, max: 600_000 });
export const NODE_HEARTBEAT_MS = Math.max(1_000, Math.floor(NODE_LEASE_MS / 3));
export const REGISTRY_SETTLE_MS = NODE_HEARTBEAT_MS * 2 + 2_000;
const BOOT_NONCE = randomUUID();

/** Registry epoch creation shared by claim and heartbeat (Redis server clock). */
const EPOCH_LUA = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local epoch = tonumber(redis.call('GET', KEYS[2]))
if not epoch then
  epoch = now
  redis.call('SET', KEYS[2], tostring(now))
end`;

/** Keep this node's liveness lease; value is the boot nonce of this process. */
const NODE_LEASE_LUA = `if redis.call('GET', KEYS[3]) == ARGV[5] then
  redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[6]))
else
  redis.call('SET', KEYS[3], ARGV[5], 'PX', tonumber(ARGV[6]))
end`;

// KEYS: room, epoch, own node key.
// ARGV: me, room ttl s, settle ms, node key prefix, boot nonce, node lease ms.
const CLAIM_LUA = `${EPOCH_LUA}
${NODE_LEASE_LUA}
local me = ARGV[1]
local ttl = tonumber(ARGV[2])
local owner = redis.call('GET', KEYS[1])
if owner == me then
  redis.call('EXPIRE', KEYS[1], ttl)
  return {'owned', me}
end
if not owner then
  if now - epoch < tonumber(ARGV[3]) then return {'settling', ''} end
  redis.call('SET', KEYS[1], me, 'EX', ttl)
  return {'owned', me}
end
if redis.call('EXISTS', ARGV[4] .. owner) == 1 then return {'remote', owner} end
redis.call('SET', KEYS[1], me, 'EX', ttl)
return {'takeover', owner}`;

// Heartbeat + re-assertion of one room this node is serving.
// KEYS: room, epoch, own node key. ARGV: me, room ttl s, (unused), (unused), boot nonce, node lease ms.
const REASSERT_LUA = `${EPOCH_LUA}
${NODE_LEASE_LUA}
local owner = redis.call('GET', KEYS[1])
if owner == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
end
if not owner then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
end
return 0`;

/** A brand-new room cannot be claimed while the registry settles after (re)creation. */
export class SfuRegistrySettlingError extends Error {
  constructor(public readonly channelId: string) {
    super(`[SFU Registry] registry is settling; room ${channelId} cannot be claimed yet`);
  }
}

function ownershipArgs(): string[] {
  return [INSTANCE_ID, String(TTL_SECONDS), String(REGISTRY_SETTLE_MS), NODE_KEY_PREFIX, BOOT_NONCE, String(NODE_LEASE_MS)];
}

async function runSfuRedisCommand<T>(
  r: RedisClient,
  operation: string,
  command: (client: RedisClient) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const scoped = r.withAbortSignal?.(controller.signal) ?? r;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`SFU Redis command timeout during ${operation}`));
    }, REDIS_COMMAND_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    return await Promise.race([command(scoped), timeout]);
  } catch (err) {
    if (timedOut) {
      // Do not reuse a client whose command queue was black-holed. node-redis
      // supports AbortSignal for queued command cancellation; destroying the
      // underlying connection is a second guard for older/partial facades.
      if (redis === r) redis = null;
      try { r.destroy?.(); } catch { /* already closed */ }
      logger.error(
        { event: 'sfu_registry.redis.command_timeout', operation, timeoutMs: REDIS_COMMAND_TIMEOUT_MS },
        '[SFU Registry] Redis command timed out; ownership remains fail-closed.',
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function reassertOwnedRoom(r: RedisClient, key: string): Promise<boolean> {
  const result = await runSfuRedisCommand(r, 'reassert owned room', client => client.eval(
    REASSERT_LUA,
    { keys: [key, EPOCH_KEY, `${NODE_KEY_PREFIX}${INSTANCE_ID}`], arguments: ownershipArgs() },
  ));
  return Number(result) === 1;
}

async function _getRedis(): Promise<RedisClient | null> {
  if (redis) return redis;
  if (redisConnectPromise) return redisConnectPromise;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  redisConnectPromise = (async () => {
    const redisLib = tryRequire<{ createClient(opts: { url: string }): RedisClient }>('redis');
    if (!redisLib) throw new Error('redis package unavailable while REDIS_URL is configured');
    const { createClient } = redisLib;
    // Do not publish a half-connected client into module state. If connect()
    // fails, a later call must retry instead of reusing a dead singleton.
    const candidate = createClient({ url: redisUrl });
    candidate.on('error', (err?: Error) => logger.error({ err: err?.message, event: 'sfu_registry.redis.error' }, '[SFU Registry] Redis error'));
    await runSfuRedisCommand(candidate, 'connect', client => client.connect());
    redis = candidate;
    return candidate;
  })();
  try {
    return await redisConnectPromise;
  } catch (e) {
    redis = null;
    logger.error({ err: (e as Error).message, event: 'sfu_registry.redis.connect_failed' },
      '[SFU Registry] Redis coordination unavailable while REDIS_URL is configured. SFU ownership will fail closed.');
    throw e;
  } finally {
    redisConnectPromise = null;
  }
}

/**
 * @internal — YALNIZCA TESTLERDE.
 *
 * Modül düzeyinde tutulan Redis istemcisini kapatır. Entegrasyon süitleri
 * birden fazla "node" simüle etmek için modülü izole biçimde yükler; her
 * yükleme kendi bağlantısını açar ve kapatılmazsa Jest AÇIK HANDLE nedeniyle
 * çıkamaz (koşu asılı kalır). Üretimde çağıranı yoktur.
 */
export async function _closeForTest(): Promise<void> {
  const client = redis as unknown as { quit?: () => Promise<unknown> } | null;
  redis = null;
  redisConnectPromise = null;
  if (client?.quit) { try { await client.quit(); } catch { /* zaten kapalı */ } }
}

/** `claimRoom` sonucu — sahiplik kazanıldı mı, kazanılmadıysa sahibi kim. */
export interface RoomClaim {
  /** Bu node odanın KANONİK sahibi mi? */
  owned: boolean;
  /** Kayıtlı sahip; Redis yoksa `INSTANCE_ID` (tek-node modu). */
  owner: string | null;
}

/**
 * Bir ses odasını bu node'a ATOMİK olarak kaydet.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * KAPATILAN GERÇEK AÇIK — SESSİZ SAHİPLİK ÇALMA
 * ════════════════════════════════════════════════════════════════════════════
 * Burada eskiden koşulsuz `SETEX` vardı:
 *
 *     await r.setEx(KEY, TTL, INSTANCE_ID);      // her zaman ÜZERİNE YAZAR
 *
 * `SETEX` mevcut sahibi ne olursa olsun EZER. Çağıran taraf ise
 * (socket/handlers/mediasoup/index.ts:106) önce `isLocalRoom()` bakıp sonra
 * odayı oluşturuyordu — klasik bir KONTROL-ET-SONRA-DAVRAN yarışı:
 *
 *   1. Node A: isLocalRoom(ch) → anahtar YOK → owner null → "benim" → devam
 *   2. Node B: isLocalRoom(ch) → anahtar HL YOK → "benim" → devam
 *   3. İkisi de yerel bir mediasoup router'ı OLUŞTURUR
 *   4. İkisi de claimRoom() çağırır → son yazan kazanır
 *
 * Sonuç: AYNI kanal için İKİ AYRI SFU odası. Katılımcılar iki node'a bölünür ve
 * BİRBİRLERİNİ DUYAMAZ; kayıt yalnızca birini sahip gösterdiği için diğer
 * node'daki akranlar yeniden bağlanana kadar mahsur kalır.
 *
 * `SET ... NX EX` tek turda hem test eder hem yazar; yarış kapanır. Sahiplik
 * ZATEN bu node'daysa (yeniden başlatma/yeniden çağrı) TTL tazelenir ve
 * `owned: true` döner — kendi odamızı kendimizden çalmayız.
 */
export async function claimRoom(channelId: string): Promise<RoomClaim> {
  const r = await _getRedis();
  // REDIS_URL hiç yapılandırılmamışsa deployment açıkça tek-node modundadır.
  // Yapılandırılmış Redis'in bağlantı hatası ise _getRedis tarafından
  // fırlatılır; multi-node sahipliği varsayımla kazanılmış sayılmaz.
  if (!r) return { owned: true, owner: INSTANCE_ID };

  // One atomic decision: free → claim, ours → renew, live remote → redirect,
  // remote whose node lease is gone → take over. Never a GET-then-SET race.
  const raw = await runSfuRedisCommand(r, 'claim room', client => client.eval(
    CLAIM_LUA,
    { keys: [`${KEY_PREFIX}${channelId}`, EPOCH_KEY, `${NODE_KEY_PREFIX}${INSTANCE_ID}`], arguments: ownershipArgs() },
  ));
  const [status, owner] = Array.isArray(raw) ? raw.map(String) : [String(raw), ''];
  if (status === 'owned') return { owned: true, owner: INSTANCE_ID };
  if (status === 'takeover') {
    logger.warn({ channelId, previousOwner: owner, event: 'sfu.room.takeover' },
      '[SFU Registry] Room owner node lease expired; ownership taken over by this node.');
    return { owned: true, owner: INSTANCE_ID };
  }
  if (status === 'settling') throw new SfuRegistrySettlingError(channelId);
  if (status === 'remote' && owner) return { owned: false, owner };
  throw new Error(`[SFU Registry] unexpected claim result: ${status}`);
}

/** Bu odanın hangi node'da olduğunu döndür. */
export async function getRoomOwner(channelId: string): Promise<string | null> {
  const r = await _getRedis();
  if (!r) return INSTANCE_ID;
  return runSfuRedisCommand(r, 'get room owner', client => client.get(`${KEY_PREFIX}${channelId}`));
}

/** Bu node bu odanın sahibi mi? */
export async function isLocalRoom(channelId: string): Promise<boolean> {
  const owner = await getRoomOwner(channelId);
  return owner === null || owner === INSTANCE_ID;
}

/** Oda kaydını sil (oda kapandığında). */
export async function releaseRoom(channelId: string): Promise<void> {
  const r = await _getRedis();
  if (!r) return;
  await runSfuRedisCommand(r, 'release room', client => client.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`,
    { keys: [`${KEY_PREFIX}${channelId}`], arguments: [INSTANCE_ID] },
  ));
}

/**
 * Heartbeat for a room this node serves: renews the node liveness lease and
 * re-asserts the room (renews our key, restores a key lost with Redis data).
 * `false` = another node owns the room now; the local router must close.
 * Called every NODE_HEARTBEAT_MS per live room.
 */
export async function refreshRoom(channelId: string): Promise<boolean> {
  const r = await _getRedis();
  if (!r) return true;
  return reassertOwnedRoom(r, `${KEY_PREFIX}${channelId}`);
}

/** Bu node'un sahip olduğu tüm odaları listele. */
export async function listLocalRooms(): Promise<string[]> {
  const r = await _getRedis();
  if (!r) return [];
  const keys = await runSfuRedisCommand(r, 'list local room keys', client => client.keys(`${KEY_PREFIX}*`));
  const rooms: string[] = [];
  for (const key of keys) {
    const owner = await runSfuRedisCommand(r, 'read local room owner', client => client.get(key));
    if (owner === INSTANCE_ID) {
      rooms.push(key.replace(KEY_PREFIX, ''));
    }
  }
  return rooms;
}

/** Tüm node'lardaki tüm aktif odaları döndür. */
export async function listAllRooms(): Promise<RoomEntry[]> {
  const r = await _getRedis();
  if (!r) return [];
  const keys = await runSfuRedisCommand(r, 'list all room keys', client => client.keys(`${KEY_PREFIX}*`));
  const rooms: RoomEntry[] = [];
  for (const key of keys) {
    const nodeId = await runSfuRedisCommand(r, 'read listed room owner', client => client.get(key));
    if (nodeId) {
      rooms.push({ channelId: key.replace(KEY_PREFIX, ''), nodeId });
    }
  }
  return rooms;
}

/** Cluster genelinde SFU istatistiklerini döndür. */
export async function getStats(): Promise<SfuStats> {
  const r = await _getRedis();
  if (!r) {
    return {
      mode:       'single-node',
      instanceId: INSTANCE_ID,
      totalRooms: 0,
      localRooms: 0,
      rooms:      [],
    };
  }

  const all   = await listAllRooms();
  const local = all.filter(rm => rm.nodeId === INSTANCE_ID);

  const roomsWithTtl = await Promise.all(
    all.map(async (rm) => {
      const ttl = await runSfuRedisCommand(r, 'read room ttl', client => client.ttl(`${KEY_PREFIX}${rm.channelId}`));
      return { ...rm, ttlSeconds: ttl };
    })
  );

  return {
    mode:       'cluster',
    instanceId: INSTANCE_ID,
    totalRooms: all.length,
    localRooms: local.length,
    rooms:      roomsWithTtl,
  };
}
