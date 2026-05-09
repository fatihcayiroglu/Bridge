// server/lib/permCache.js.1
// getMemberPerms her socket mesajında DB'ye vuruyordu.
// Bu modül, izinleri TTL'li bir Map'te önbelleğe alır.
//
// KULLANIM:
//   const { getCachedPerms, invalidatePerms } = require('../lib/permCache');
//   const perms = await getCachedPerms(userId, serverId, resolvePermissions);
//
// Cache geçersiz kılma:
//   - Kanal override değişince: invalidatePerms(serverId, null, channelId)
//     → Yalnızca o kanalla ilgili girişler silinir (gereksiz DB sorgusu olmaz)
//   - Rol değişikliğinde (sunucu geneli): invalidatePerms(serverId)
//   - Kullanıcı atıldığında: invalidatePerms(serverId, userId)
//
// v56.1 DEĞİŞİKLİKLER:
//   - invalidatePerms'e channelId parametresi eklendi.
//   - Kanal bazlı invalidation: tüm sunucu yerine yalnızca etkilenen kanalın
//     cache kayıtları silinir. Rol/kick gibi sunucu geneli durumlar korundu.

'use strict';

const PERM_CACHE_TTL_MS  = 30_000;  // 30 saniye
const MAX_CACHE_ENTRIES  = 50_000;  // memory guard

// key: "userId:serverId" veya "userId:serverId:channelId"
// value: { perms: number, expiresAt: number }
const _cache = new Map();

// Periyodik temizleme (süresi dolmuş girişler)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (v.expiresAt < now) _cache.delete(k);
  }
}, 60_000);

/**
 * İzinleri önbellekten alır; yoksa resolvePermissions'ı çağırır ve önbellekler.
 * @param {string}   userId
 * @param {string}   serverId
 * @param {Function} resolveFn  — async (userId, serverId) => permsBitmask
 * @param {string}   [channelId] — kanal bazlı override için
 */
async function getCachedPerms(userId, serverId, resolveFn, channelId = null) {
  const key = channelId
    ? `${userId}:${serverId}:${channelId}`
    : `${userId}:${serverId}`;

  const cached = _cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.perms;

  // Memory guard
  if (_cache.size >= MAX_CACHE_ENTRIES) {
    const toDelete = Math.floor(MAX_CACHE_ENTRIES * 0.1);
    let deleted = 0;
    for (const k of _cache.keys()) {
      _cache.delete(k);
      if (++deleted >= toDelete) break;
    }
  }

  const perms = await resolveFn(userId, serverId, channelId);
  _cache.set(key, { perms, expiresAt: Date.now() + PERM_CACHE_TTL_MS });
  return perms;
}

/**
 * İzin önbelleğini seçici olarak geçersiz kılar.
 *
 * Davranış önceliği (en kısıtlıdan en genişe):
 *   1. channelId verilmişse → yalnızca o kanalın girişleri silinir
 *      Örnek: kanal override PUT/DELETE → sadece o kanalı etkiler
 *   2. userId verilmişse   → o kullanıcıya ait tüm sunucu girişleri silinir
 *   3. Sadece serverId     → sunucunun tüm cache'i temizlenir
 *      (rol değişikliği, kick/ban gibi sunucu geneli olaylar)
 *
 * @param {string}      serverId
 * @param {string|null} [userId]    — belirtilirse sadece o kullanıcı
 * @param {string|null} [channelId] — belirtilirse sadece o kanal
 */
function invalidatePerms(serverId, userId = null, channelId = null) {
  if (channelId) {
    // Kanal bazlı: yalnızca "userId:serverId:channelId" formatındaki girişler
    const suffix = `:${serverId}:${channelId}`;
    for (const k of _cache.keys()) {
      if (k.endsWith(suffix)) _cache.delete(k);
    }
    return;
  }

  if (userId) {
    // Kullanıcı bazlı: "userId:serverId" ve "userId:serverId:*"
    const prefix = `${userId}:${serverId}`;
    for (const k of _cache.keys()) {
      if (k.startsWith(prefix)) _cache.delete(k);
    }
    return;
  }

  // Sunucu geneli (rol değişikliği, ban, kick vb.)
  const pattern = `:${serverId}`;
  for (const k of _cache.keys()) {
    if (k.includes(pattern)) _cache.delete(k);
  }
}

/** Test amaçlı — cache'i temizler */
function _clearCache() { _cache.clear(); }

/** Test amaçlı — cache boyutunu döner */
function _cacheSize() { return _cache.size; }

module.exports = { getCachedPerms, invalidatePerms, _clearCache, _cacheSize };
export {};
