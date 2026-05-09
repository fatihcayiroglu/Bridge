// @ts-nocheck
// server/lib/sfuRegistry.js
// SFU oda kaydı — cluster modda hangi node hangi ses odasını yönetiyor.
//
// Sorun: 3 Bridge node varsa, kullanıcılar farklı node'lara düşer.
// Kullanıcı A → node-1, Kullanıcı B → node-2 olursa ikisi aynı
// mediasoup router'a bağlı olmadığından ses akışı çalışmaz.
//
// Çözüm: Redis'te "hangi channelId hangi node'da" kaydını tut.
// Yeni kullanıcı katıldığında o node'a yönlendir (socket.io room redirect).
//
// Tek node modda (REDIS_URL yoksa) no-op olarak çalışır.

'use strict';

let redis = null;

const INSTANCE_ID  = process.env.INSTANCE_ID || `node-${process.pid}`;
const KEY_PREFIX   = 'bridge:sfu:room:';
const TTL_SECONDS  = 3600; // 1 saat — boş oda otomatik temizlenir

async function _getRedis() {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;
  try {
    const { createClient } = require('redis');
    redis = createClient({ url: process.env.REDIS_URL });
    redis.on('error', err => console.error('[SFU Registry] Redis error:', err.message));
    await redis.connect();
    return redis;
  } catch (e) {
    console.warn('[SFU Registry] Redis bağlantısı kurulamadı, tek-node modda devam:', e.message);
    return null;
  }
}

/**
 * Bir ses odasını bu node'a kaydet.
 * @param {string} channelId
 */
async function claimRoom(channelId) {
  const r = await _getRedis();
  if (!r) return; // tek node, kayıt gerekmez
  await r.setEx(`${KEY_PREFIX}${channelId}`, TTL_SECONDS, INSTANCE_ID);
}

/**
 * Bu odarın hangi node'da olduğunu döndür.
 * @param {string} channelId
 * @returns {string|null} instanceId veya null (oda yok)
 */
async function getRoomOwner(channelId) {
  const r = await _getRedis();
  if (!r) return INSTANCE_ID; // tek node, her zaman kendisi
  return r.get(`${KEY_PREFIX}${channelId}`);
}

/**
 * Bu node bu odanın sahibi mi?
 * @param {string} channelId
 * @returns {boolean}
 */
async function isLocalRoom(channelId) {
  const owner = await getRoomOwner(channelId);
  return owner === null || owner === INSTANCE_ID;
}

/**
 * Oda kaydını sil (oda kapandığında).
 * @param {string} channelId
 */
async function releaseRoom(channelId) {
  const r = await _getRedis();
  if (!r) return;
  // Sadece bu node'un odalarını sil
  const owner = await r.get(`${KEY_PREFIX}${channelId}`);
  if (owner === INSTANCE_ID) {
    await r.del(`${KEY_PREFIX}${channelId}`);
  }
}

/**
 * TTL'yi yenile (oda hâlâ aktifse).
 * Her 10 dakikada bir çağrılmalı.
 * @param {string} channelId
 */
async function refreshRoom(channelId) {
  const r = await _getRedis();
  if (!r) return;
  const owner = await r.get(`${KEY_PREFIX}${channelId}`);
  if (owner === INSTANCE_ID) {
    await r.expire(`${KEY_PREFIX}${channelId}`, TTL_SECONDS);
  }
}

/**
 * Bu node'un sahip olduğu tüm odaları listele.
 * @returns {string[]} channelId listesi
 */
async function listLocalRooms() {
  const r = await _getRedis();
  if (!r) return [];
  const keys = await r.keys(`${KEY_PREFIX}*`);
  const rooms = [];
  for (const key of keys) {
    const owner = await r.get(key);
    if (owner === INSTANCE_ID) {
      rooms.push(key.replace(KEY_PREFIX, ''));
    }
  }
  return rooms;
}

/**
 * Tüm node'lardaki tüm aktif odaları döndür.
 * Her oda için { channelId, nodeId } bilgisi içerir.
 * @returns {{ channelId: string, nodeId: string }[]}
 */
async function listAllRooms() {
  const r = await _getRedis();
  if (!r) return [];
  const keys = await r.keys(`${KEY_PREFIX}*`);
  const rooms = [];
  for (const key of keys) {
    const nodeId = await r.get(key);
    if (nodeId) {
      rooms.push({ channelId: key.replace(KEY_PREFIX, ''), nodeId });
    }
  }
  return rooms;
}

/**
 * Cluster genelinde SFU istatistiklerini döndür.
 * @returns {{ totalRooms: number, localRooms: number, rooms: object[] }}
 */
async function getStats() {
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

  const all    = await listAllRooms();
  const local  = all.filter(rm => rm.nodeId === INSTANCE_ID);

  // Her oda için kalan TTL al
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

module.exports = {
  claimRoom,
  getRoomOwner,
  isLocalRoom,
  releaseRoom,
  refreshRoom,
  listLocalRooms,
  listAllRooms,
  getStats,
  INSTANCE_ID,
};
export {};
