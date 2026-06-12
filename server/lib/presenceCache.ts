// server/lib/presenceCache.ts
// Kullanıcı presence (çevrimiçi durumu) ve üyelik listesi önbelleği
//
// ── Socket sayacı (multi-tab, cluster-safe) ────────────────────
//
// SORUN (önceki versiyon):
//   _socketMap process-local'dı. PM2 cluster modunda aynı kullanıcı iki
//   farklı worker'a düşerse, worker-1 kullanıcıyı online, worker-2 offline
//   görebilirdi. Sticky-session olmadan online/offline durumu tutarsızdı.
//
// ÇÖZÜM (bu versiyon):
//   - _socketMap hâlâ process-local (her worker kendi socket'larını bilir)
//   - Kullanıcı gerçekten online/offline olduğunda Redis Pub/Sub üzerinden
//     diğer worker'lar bilgilendirilir.
//   - isUserOnline() Redis'teki TTL'li "online heartbeat" key'ini kullanır.
//     Bu key tüm worker'larda tutarlıdır.
//   - trackSocket() → markOnline() + publish('joined')
//   - releaseSocket() → tüm socketler gittiyse markOffline() + publish('left')
//
// Tek-instance veya sticky-session kurulumunda öncekiyle davranış aynıdır.

import { cache, subscribeToChannel, publishToChannel } from './redisAdapter';
import logger from './logger';

const MEMBERSHIP_TTL_S  = 300;   // 5 dakika — üyelik listesi nadiren değişir
const STATUS_THROTTLE_S = 10;    // aynı status için 10 saniyede bir DB yazması yeter
const ONLINE_TTL_S      = 600;   // 10 dakika — online heartbeat penceresi
const PRESENCE_CHANNEL  = 'bridge:presence';

// ── Process-local socket sayacı ────────────────────────────────
// userId → Set<socketId>  (bu process'te açık olan socket'lar)
const _socketMap = new Map<string, Set<string>>();

// ── Cluster Pub/Sub başlatma ───────────────────────────────────
// Socket.io başlamadan önce bu modül import edilebilir;
// subscribeToChannel Redis bağlantısı hazır olunca abone olur.
// Mesaj: JSON { event: 'presence:joined' | 'presence:left', userId: string }
// Şu an bu mesajları alıcı taraf aktif olarak tüketmiyor;
// isUserOnline() zaten Redis'teki TTL key'ine bakıyor. Pub/Sub, gelecekte
// "friend-online" push notification veya socket fanout için kullanılabilir.
let _unsubscribe: (() => Promise<void>) | null = null;

(async () => {
  try {
    _unsubscribe = await subscribeToChannel(PRESENCE_CHANNEL, (raw) => {
      try {
        const msg = JSON.parse(raw) as { event: string; userId: string };
        logger.debug({ msg, event: 'presenceCache.pubsub.received' }, 'Presence pub/sub mesajı alındı');
      } catch { /* malformed message — ignore */ }
    });
  } catch (err) {
    logger.warn({ err, event: 'presenceCache.pubsub.subscribe_failed' }, 'Presence pub/sub aboneliği başlatılamadı — fallback modda çalışılıyor');
  }
})();

// ── Multi-tab socket sayacı ────────────────────────────────────

/**
 * Kullanıcının bir socket bağlantısını kaydeder.
 * İlk socket ise Redis'e online işaret eder ve cluster'a bildirir.
 * @returns kullanıcının bu worker'daki toplam aktif socket sayısı
 */
async function trackSocket(userId: string, socketId: string): Promise<number> {
  if (!_socketMap.has(userId)) _socketMap.set(userId, new Set());
  _socketMap.get(userId)!.add(socketId);
  const count = _socketMap.get(userId)!.size;

  if (count === 1) {
    // İlk socket: online heartbeat yaz + cluster'a bildir
    await markOnline(userId);
    publishToChannel(PRESENCE_CHANNEL, JSON.stringify({ event: 'presence:joined', userId })).catch(() => {});
  }

  return count;
}

/**
 * Kullanıcının bir socket bağlantısını kaldırır.
 * Son socket giderse Redis'ten offline işaret eder ve cluster'a bildirir.
 * @returns kalan aktif socket sayısı (0 ise gerçekten offline)
 */
async function releaseSocket(userId: string, socketId: string): Promise<number> {
  const sockets = _socketMap.get(userId);
  if (!sockets) return 0;
  sockets.delete(socketId);

  if (sockets.size === 0) {
    _socketMap.delete(userId);
    // Son socket: offline işaret et + cluster'a bildir
    await markOffline(userId);
    publishToChannel(PRESENCE_CHANNEL, JSON.stringify({ event: 'presence:left', userId })).catch(() => {});
    return 0;
  }
  return sockets.size;
}

/** Kullanıcının bu process'teki aktif socket sayısını döner (0 = bu worker'da yok) */
function socketCount(userId: string): number {
  return _socketMap.get(userId)?.size ?? 0;
}

// ── Üyelik cache ───────────────────────────────────────────────

/**
 * Kullanıcının sunucu üyeliklerini önbellekten alır.
 * Cache miss durumunda Members.findByUser() çağırır ve önbellekler.
 */
async function getMembershipsCached(
  userId: string,
  fetchFn: () => Promise<Array<{ serverId: string }>>
): Promise<Array<{ serverId: string }>> {
  const key = `presence:memberships:${userId}`;
  try {
    const cached = await cache.get<Array<{ serverId: string }>>(key);
    if (cached) return cached;
  } catch { /* cache erişim hatası → DB'ye fall through */ }

  const memberships = await fetchFn();

  try {
    await cache.set(key, memberships, MEMBERSHIP_TTL_S);
  } catch { /* cache yazma hatası → devam et */ }

  return memberships;
}

/**
 * Üyelik önbelleğini geçersiz kılar.
 * Kullanıcı bir sunucuya katıldığında veya ayrıldığında çağrılmalıdır.
 */
async function invalidateMemberships(userId: string): Promise<void> {
  try {
    await cache.del(`presence:memberships:${userId}`);
  } catch {}
}

// ── Status throttle ────────────────────────────────────────────

/**
 * Aynı status için DB yazmasını kısa süreyle bastırır.
 * @returns true → DB'ye yaz, false → throttle edildi, atla
 */
async function throttleStatusWrite(userId: string, newStatus: string): Promise<boolean> {
  const key = `presence:status_throttle:${userId}`;
  try {
    const last = await cache.get<string>(key);
    if (last === newStatus) return false;
    await cache.set(key, newStatus, STATUS_THROTTLE_S);
  } catch {
    // Cache erişim hatası → güvenli taraf: her zaman yaz
  }
  return true;
}

// ── Online heartbeat (Redis-backed, cluster-wide) ──────────────

/** Kullanıcıyı tüm cluster'da online olarak işaretler (TTL'li) */
async function markOnline(userId: string): Promise<void> {
  try {
    await cache.set(`presence:online:${userId}`, 1, ONLINE_TTL_S);
  } catch {}
}

/** Kullanıcıyı tüm cluster'da offline olarak işaretler */
async function markOffline(userId: string): Promise<void> {
  try {
    await cache.del(`presence:online:${userId}`);
  } catch {}
}

/**
 * Kullanıcının online olup olmadığını kontrol eder (cluster-wide).
 * Bu process'te socket varsa anında true döner (hızlı path).
 * Yoksa Redis'teki heartbeat key'ine bakar (diğer worker'larda olabilir).
 */
async function isUserOnline(userId: string): Promise<boolean> {
  // Önce bu process'in socket map'ini kontrol et (en hızlı)
  if (socketCount(userId) > 0) return true;
  // Redis'e bak (diğer worker'larda veya kısa süreli yeniden bağlanmalarda)
  try {
    const val = await cache.get(`presence:online:${userId}`);
    return val !== null;
  } catch {
    return false;
  }
}

// ── Diagnostics ────────────────────────────────────────────────

/** Bu process'te takip edilen toplam socket bağlantısı sayısı (debug) */
function activeSockets(): number {
  let total = 0;
  for (const set of _socketMap.values()) total += set.size;
  return total;
}

/** Bu process'te en az bir socketi olan kullanıcı sayısı */
function onlineUserCount(): number {
  return _socketMap.size;
}

export {
  trackSocket,
  releaseSocket,
  socketCount,
  getMembershipsCached,
  invalidateMemberships,
  throttleStatusWrite,
  markOnline,
  markOffline,
  isUserOnline,
  activeSockets,
  onlineUserCount,
};
