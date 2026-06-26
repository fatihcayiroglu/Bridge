// server/lib/permCache.ts — Oturum 15: tam tip eklenmiş sürüm
// getMemberPerms her socket mesajında DB'ye vuruyordu.
// Bu modül, izinleri TTL'li bir Map'te önbelleğe alır.

const PERM_CACHE_TTL_MS = 30_000;  // 30 saniye
const MAX_CACHE_ENTRIES = 50_000;  // memory guard

interface CacheEntry {
  perms: number;
  expiresAt: number;
}

// key: "userId:serverId" veya "userId:serverId:channelId"
// value: { perms: number, expiresAt: number }
const _cache = new Map<string, CacheEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (v.expiresAt < now) _cache.delete(k);
  }
}, 60_000).unref();

/**
 * İzinleri önbellekten alır; yoksa resolvePermissions'ı çağırır ve önbellekler.
 * @param userId    - Kullanıcı ID
 * @param serverId  - Sunucu ID
 * @param resolveFn - async (userId, serverId, channelId?) => permsBitmask
 * @param channelId - Kanal bazlı override için (opsiyonel)
 */
export async function getCachedPerms(
  userId: string,
  serverId: string,
  resolveFn: (
    userId: string,
    serverId: string,
    channelId: string | null,
  ) => Promise<number>,
  channelId: string | null = null,
): Promise<number> {
  const key = channelId
    ? `${userId}:${serverId}:${channelId}`
    : `${userId}:${serverId}`;

  const cached = _cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.perms;

  // Memory guard: dolmak üzereyse en eski %10'u at
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
 *   2. userId verilmişse   → o kullanıcıya ait tüm sunucu girişleri silinir
 *   3. Sadece serverId     → sunucunun tüm cache'i temizlenir
 */
export function invalidatePerms(
  serverId: string,
  userId: string | null = null,
  channelId: string | null = null,
): void {
  if (channelId) {
    const suffix = `:${serverId}:${channelId}`;
    for (const k of _cache.keys()) {
      if (k.endsWith(suffix)) _cache.delete(k);
    }
    return;
  }

  if (userId) {
    const prefix = `${userId}:${serverId}`;
    for (const k of _cache.keys()) {
      if (k.startsWith(prefix)) _cache.delete(k);
    }
    return;
  }

  const pattern = `:${serverId}`;
  for (const k of _cache.keys()) {
    if (k.includes(pattern)) _cache.delete(k);
  }
}

/** Test amaçlı — cache'i temizler */
export function _clearCache(): void { _cache.clear(); }

/** Test amaçlı — cache boyutunu döner */
export function _cacheSize(): number { return _cache.size; }
