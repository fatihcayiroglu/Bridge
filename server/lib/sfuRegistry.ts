// server/lib/sfuRegistry.ts — Oturum 17: redis tipi, fonksiyon imzaları
// SFU oda kaydı — cluster modda hangi node hangi ses odasını yönetiyor.

import logger from './logger';
import { tryRequire } from './_optional-require';

// ── Tipler ────────────────────────────────────────────────────
interface RedisClient {
  setEx(key: string, ttl: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  expire(key: string, ttl: number): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  ttl(key: string): Promise<number>;
  on(event: string, cb: (err?: Error) => void): void;
  connect(): Promise<void>;
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

export const INSTANCE_ID = process.env.INSTANCE_ID || `node-${process.pid}`;
const KEY_PREFIX          = 'bridge:sfu:room:';
const TTL_SECONDS         = 3600;

async function _getRedis(): Promise<RedisClient | null> {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;
  try {
    const redisLib = tryRequire<{ createClient(opts: { url: string }): RedisClient }>('redis');
    if (!redisLib) return null;
    const { createClient } = redisLib;
    redis = createClient({ url: process.env.REDIS_URL });
    redis.on('error', (err?: Error) => logger.error({ err: err?.message, event: 'sfu_registry.redis.error' }, '[SFU Registry] Redis error'));
    await redis.connect();
    return redis;
  } catch (e) {
    logger.warn({ err: (e as Error).message, event: 'sfu_registry.redis.connect_failed' }, '[SFU Registry] Redis bağlantısı kurulamadı, tek-node modda devam');
    return null;
  }
}

/** Bir ses odasını bu node'a kaydet. */
export async function claimRoom(channelId: string): Promise<void> {
  const r = await _getRedis();
  if (!r) return;
  await r.setEx(`${KEY_PREFIX}${channelId}`, TTL_SECONDS, INSTANCE_ID);
}

/** Bu odanın hangi node'da olduğunu döndür. */
export async function getRoomOwner(channelId: string): Promise<string | null> {
  const r = await _getRedis();
  if (!r) return INSTANCE_ID;
  return r.get(`${KEY_PREFIX}${channelId}`);
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
  const owner = await r.get(`${KEY_PREFIX}${channelId}`);
  if (owner === INSTANCE_ID) {
    await r.del(`${KEY_PREFIX}${channelId}`);
  }
}

/** TTL'yi yenile (oda hâlâ aktifse). Her 10 dakikada bir çağrılmalı. */
export async function refreshRoom(channelId: string): Promise<void> {
  const r = await _getRedis();
  if (!r) return;
  const owner = await r.get(`${KEY_PREFIX}${channelId}`);
  if (owner === INSTANCE_ID) {
    await r.expire(`${KEY_PREFIX}${channelId}`, TTL_SECONDS);
  }
}

/** Bu node'un sahip olduğu tüm odaları listele. */
export async function listLocalRooms(): Promise<string[]> {
  const r = await _getRedis();
  if (!r) return [];
  const keys = await r.keys(`${KEY_PREFIX}*`);
  const rooms: string[] = [];
  for (const key of keys) {
    const owner = await r.get(key);
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
  const keys = await r.keys(`${KEY_PREFIX}*`);
  const rooms: RoomEntry[] = [];
  for (const key of keys) {
    const nodeId = await r.get(key);
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
      const ttl = await r.ttl(`${KEY_PREFIX}${rm.channelId}`);
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
