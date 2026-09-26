// server/socket/middleware/wsConnectionLimit.ts
// Sprint 119: Tehdit modeli D5 — WebSocket bağlantı limitsizliği giderildi.
//
// Tek bir IP'den açılabilecek eş zamanlı WS bağlantı sayısını sınırlar.
// Socket.IO middleware olarak çalışır; io.use() ile bağlanır.
//
// Kullanım (server/socket/index.ts):
//   import { wsConnectionLimitMiddleware } from './middleware/wsConnectionLimit';
//   io.use(wsConnectionLimitMiddleware(io));

import type { Server, Socket } from 'socket.io';
import { createLogger } from '../../lib/logger';
import { envSafeInt } from '../../lib/envNumbers';
import { cache } from '../../lib/redisAdapter';

const log = createLogger('wsConnectionLimit');

// Ortam değişkeninden al, varsayılan 10 (aynı IP'den max WS)
const MAX_WS_PER_IP = envSafeInt('MAX_WS_PER_IP', 10);
// Kimlik doğrulanmamış bağlantılar için daha sıkı limit (D5 — env.ts'te de validate edilir)
const MAX_UNAUTH_WS_PER_IP = envSafeInt('MAX_UNAUTH_WS_PER_IP', 3);
// Authenticated kullanıcı başına max bağlantı (çoklu sekme senaryosu)
const MAX_WS_PER_USER = envSafeInt('MAX_WS_PER_USER', 5);


const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);
const HANDSHAKE_LEASE_MS = 15_000;
const CONNECTION_LEASE_MS = 120_000;
const CONNECTION_HEARTBEAT_MS = 30_000;
const INSTANCE_ID = process.env.INSTANCE_ID || `node-${process.pid}`;

// Cluster-mode connection ownership is represented as expiring sorted-set
// members.  The score is the lease expiry timestamp, so every claim begins by
// pruning crashed/stale workers. Initial sockets live in the pre-auth set for a
// short bounded handshake lease; successful authentication atomically moves
// the member to a user set and extends the total-IP lease.
const CLAIM_HANDSHAKE_LUA = `
local now = tonumber(ARGV[2])
local expiry = tonumber(ARGV[3])
local maxTotal = tonumber(ARGV[4])
local maxUnauth = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local total = redis.call('ZCARD', KEYS[1])
if total >= maxTotal then return {'ip', tostring(total)} end
local unauth = redis.call('ZCARD', KEYS[2])
if unauth >= maxUnauth then return {'unauth', tostring(unauth)} end
redis.call('ZADD', KEYS[1], expiry, ARGV[1])
redis.call('ZADD', KEYS[2], expiry, ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[6]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[7]))
return {'ok', tostring(total + 1), tostring(unauth + 1)}
`;

const PROMOTE_USER_LUA = `
local now = tonumber(ARGV[2])
local expiry = tonumber(ARGV[3])
local maxUser = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) or not redis.call('ZSCORE', KEYS[2], ARGV[1]) then
  return {'expired', '0'}
end
if redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZADD', KEYS[1], expiry, ARGV[1])
  redis.call('ZADD', KEYS[3], expiry, ARGV[1])
  return {'ok', tostring(redis.call('ZCARD', KEYS[3]))}
end
local userCount = redis.call('ZCARD', KEYS[3])
if userCount >= maxUser then return {'user', tostring(userCount)} end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], expiry, ARGV[1])
redis.call('ZADD', KEYS[3], expiry, ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[6]))
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[5]))
return {'ok', tostring(userCount + 1)}
`;

const REFRESH_LEASE_LUA = `
local now = tonumber(ARGV[2])
local expiry = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) or not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], expiry, ARGV[1])
redis.call('ZADD', KEYS[2], expiry, ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
`;

const RELEASE_LEASE_LUA = `
for i = 1, #KEYS do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1
`;

function parseSharedResult(raw: unknown): { status: string; count: number } {
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('Invalid Redis connection-limit result');
  const status = String(raw[0]);
  const count = Number(raw[1]);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Redis connection-limit count');
  return { status, count };
}


interface SocketWithUserId extends Socket {
  userId?: string;
  /** Server-internal auth transition hook. Never exposed as a client event. */
  _bridgeMarkAuthenticated?: (userId: string) => boolean | Promise<boolean>;
  /** Release a pre-auth/authenticated quota reservation when a later middleware rejects the handshake. */
  _bridgeReleaseConnectionLimit?: () => void | Promise<void>;
}

// ════════════════════════════════════════════════════════════════════════════
// KABUL YOLU MALIYETI: O(N) → O(1)  (P1 sinifi olceklenme kusuru)
// ════════════════════════════════════════════════════════════════════════════
// ONCEKI HALI her YENI baglantida SU ISI yapiyordu:
//
//     const sockets = [...io.sockets.sockets.values()];              // O(N) kopya
//     const ipSockets = sockets.filter(s => getClientIp(s) === ip);  // O(N) ayristirma
//
// ...ve kimlik dogrulama gecisinde AYNI taramayi bir kez daha. Yani tek bir
// baglantiyi kabul etmenin maliyeti o anda BAGLI OLAN soket sayisiyla
// dogrusal buyuyordu; N soketlik bir rampanin toplam maliyeti O(N^2) idi.
//
// OLCULDU (scripts/ws-limit-scaling.cjs, gercek middleware uzerinde):
//
//     N        rampa       N doluyken TEK kabul
//     100      10.2 ms     50.60 us
//     500      55.3 ms     214.33 us
//     2000     859.0 ms    826.56 us      <- tek kabul 0.83 ms olay dongusu
//
// N 20x buyudugunde kabul basina maliyet 16.3x buyudu — dogrusal.
//
// NEDEN ONEMLI: bu is SENKRON ve olay dongusu uzerinde. Kitlesel yeniden
// baglanmada (dagitim, ag kesintisi, tasiyici degisimi) kabul yolu dongude
// yuzlerce ms tutar; bu sirada mesaj teslimi ve heartbeat CALISMAZ. Heartbeat
// kaciran istemciler yeniden baglanir — yani firtina KENDINI BESLER. 500 soket
// olcumunde gozlenen coku tam olarak bu sarmaldi.
//
// COZUM: sayim artimli tutulur.
//   * ilk kez gorulen anahtar GERCEK taramayla tohumlanir (onceden dolu bir
//     io haritasi da dogru sayilir),
//   * sonrasi O(1) artir/azalt,
//   * sayac limite ULASTIGINDA reddetmeden ONCE bir kez daha gercek tarama
//     yapilir — sayac kaymasi yuzunden MESRU bir kullanici asla reddedilmez.
//
// Yani hizli yol O(1), reddetme karari ise DAIMA gercek duruma dayanir.

/**
 * IP ve kullanıcı başına WS bağlantı sayısını sınırlayan middleware.
 * MAX_UNAUTH_WS_PER_IP: Kimlik doğrulanmamış bağlantılar için daha sıkı limit.
 * MAX_WS_PER_IP: Toplam (auth + unauth) IP başına üst sınır.
 * MAX_WS_PER_USER: Authenticated kullanıcı başına tab/cihaz limiti.
 */
export function wsConnectionLimitMiddleware(io: Server) {
  if (REDIS_CONFIGURED) {
    return (socket: SocketWithUserId, next: (err?: Error) => void) => {
      const ip = getClientIp(socket);
      const member = `${INSTANCE_ID}:${socket.id}`;
      const totalKey = `bridge:ws-limit:ip-total:${ip}`;
      const unauthKey = `bridge:ws-limit:ip-unauth:${ip}`;
      let secondaryKey = unauthKey;
      let authenticatedUserId: string | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const release = async (): Promise<void> => {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        try {
          await cache.luaEvalAuthoritative(RELEASE_LEASE_LUA, [totalKey, secondaryKey], [member]);
        } catch (err) {
          log.warn({ event: 'ws_limit_release_failed', ip, socketId: socket.id, err }, 'Shared WS lease release failed');
        }
      };

      const abort = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await release();
      };

      void (async () => {
        try {
          const now = Date.now();
          const raw = await cache.luaEvalAuthoritative(
            CLAIM_HANDSHAKE_LUA,
            [totalKey, unauthKey],
            [
              member,
              String(now),
              String(now + HANDSHAKE_LEASE_MS),
              String(MAX_WS_PER_IP),
              String(MAX_UNAUTH_WS_PER_IP),
              String(CONNECTION_LEASE_MS * 2),
              String(HANDSHAKE_LEASE_MS * 2),
            ],
          );
          const claim = parseSharedResult(raw);
          if (claim.status === 'ip') {
            log.warn({ event: 'ws_limit_ip', ip, count: claim.count, limit: MAX_WS_PER_IP });
            return next(new Error('TOO_MANY_CONNECTIONS_FROM_IP'));
          }
          if (claim.status === 'unauth') {
            log.warn({ event: 'ws_limit_unauth_ip', ip, count: claim.count, limit: MAX_UNAUTH_WS_PER_IP });
            return next(new Error('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP'));
          }
          if (claim.status !== 'ok') throw new Error(`Unexpected WS lease claim status: ${claim.status}`);

          socket._bridgeReleaseConnectionLimit = abort;
          socket.once('disconnect', () => { void abort(); });
          socket._bridgeMarkAuthenticated = async (userId: string): Promise<boolean> => {
            if (!userId || closed) return false;
            if (authenticatedUserId !== null) return authenticatedUserId === userId;
            const userKey = `bridge:ws-limit:user:${userId}`;
            try {
              const at = Date.now();
              const promoted = parseSharedResult(await cache.luaEvalAuthoritative(
                PROMOTE_USER_LUA,
                [totalKey, unauthKey, userKey],
                [
                  member,
                  String(at),
                  String(at + CONNECTION_LEASE_MS),
                  String(MAX_WS_PER_USER),
                  String(CONNECTION_LEASE_MS * 2),
                  String(HANDSHAKE_LEASE_MS * 2),
                ],
              ));
              if (promoted.status !== 'ok') {
                if (promoted.status === 'user') {
                  log.warn({ event: 'ws_limit_user', userId, count: promoted.count, limit: MAX_WS_PER_USER });
                } else {
                  log.warn({ event: 'ws_limit_handshake_expired', userId, socketId: socket.id });
                }
                await abort();
                return false;
              }
              secondaryKey = userKey;
              authenticatedUserId = userId;
              heartbeat = setInterval(() => {
                void (async () => {
                  if (closed) return;
                  try {
                    const t = Date.now();
                    const refreshed = await cache.luaEvalAuthoritative(
                      REFRESH_LEASE_LUA,
                      [totalKey, secondaryKey],
                      [member, String(t), String(t + CONNECTION_LEASE_MS), String(CONNECTION_LEASE_MS * 2)],
                    );
                    if (refreshed !== 1 && refreshed !== '1') throw new Error('Shared WS lease expired');
                  } catch (err) {
                    log.error({ event: 'ws_limit_heartbeat_failed', userId, socketId: socket.id, err }, 'Shared WS connection authority lost');
                    await abort();
                    socket.emit('error', { code: 'CONNECTION_LIMIT_UNAVAILABLE', message: 'Connection authority unavailable' });
                    socket.disconnect(true);
                  }
                })();
              }, CONNECTION_HEARTBEAT_MS);
              heartbeat.unref?.();
              return true;
            } catch (err) {
              log.error({ event: 'ws_limit_promote_failed', userId, socketId: socket.id, err }, 'Shared WS user-limit authority unavailable');
              await abort();
              throw err;
            }
          };

          log.debug({ event: 'ws_connect_allow_shared', ip, count: claim.count });
          next();
        } catch (err) {
          log.error({ event: 'ws_limit_authority_unavailable', ip, socketId: socket.id, err }, 'Shared WS connection-limit authority unavailable');
          await abort();
          next(new Error('CONNECTION_LIMIT_UNAVAILABLE'));
        }
      })();
    };
  }
  // Bu sayaclar io ORNEGINE baglidir (modul duzeyinde degil): ayri io
  // ornekleri ve testler birbirinin durumunu kirletmez.
  const ipToplam = new Map<string, number>();
  const ipKimliksiz = new Map<string, number>();
  const kullaniciSoketleri = new Map<string, Set<string>>();
  // Dogrulama taramasinin SON yapildigi an (IP basina).
  const sonDogrulama = new Map<string, number>();

  // ── Dogrulama taramasi da SINIRLANMALI ────────────────────────────────────
  // Sayac limite ulastiginda gercek durumu dogrulamak MESRU kullaniciyi
  // kaymadan korur — ama bu tarama O(N)'dir. Sinirlanmazsa saldirgan
  // limitine kadar baglanti park edip ardindan sel gibi deneme yaparak her
  // denemede O(N) is yaptirabilirdi: reddetme yolu DoS yukselticiye donerdi.
  //
  // Bu yuzden tarama IP basina en fazla DOGRULAMA_ARALIGI_MS'de bir yapilir.
  // Arada sayaca guvenilir; olasi bir kayma en gec bu sure icinde onarilir.
  const DOGRULAMA_ARALIGI_MS = 1000;

  const artir = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const azalt = (m: Map<string, number>, k: string) => {
    const v = (m.get(k) ?? 0) - 1;
    if (v > 0) m.set(k, v); else m.delete(k);
  };

  /** GERCEK tarama — yalnizca tohumlama ve limit dogrulamasinda kullanilir. */
  function gercekSayim(ip: string): { toplam: number; kimliksiz: number } {
    let toplam = 0, kimliksiz = 0;
    for (const s of io.sockets.sockets.values()) {
      if (getClientIp(s as SocketWithUserId) !== ip) continue;
      toplam++;
      if (!(s as SocketWithUserId).userId) kimliksiz++;
    }
    return { toplam, kimliksiz };
  }

  function tohumla(ip: string): void {
    if (ipToplam.has(ip) || ipKimliksiz.has(ip)) return;
    const g = gercekSayim(ip);
    if (g.toplam > 0) ipToplam.set(ip, g.toplam);
    if (g.kimliksiz > 0) ipKimliksiz.set(ip, g.kimliksiz);
    sonDogrulama.set(ip, Date.now());
  }

  /**
   * Limit sinirinda gercek durumu dogrular — ama IP basina en fazla
   * DOGRULAMA_ARALIGI_MS'de bir kez. Tarama yapildiysa `true` doner.
   */
  function dogrula(ip: string): boolean {
    const simdi = Date.now();
    if (simdi - (sonDogrulama.get(ip) ?? 0) < DOGRULAMA_ARALIGI_MS) return false;
    const g = gercekSayim(ip);
    ipToplam.set(ip, g.toplam);
    ipKimliksiz.set(ip, g.kimliksiz);
    sonDogrulama.set(ip, simdi);
    return true;
  }

  return (socket: SocketWithUserId, next: (err?: Error) => void) => {
    const ip = getClientIp(socket);

    tohumla(ip);

    // ── Toplam IP limiti ────────────────────────────────────────────────────
    let ipCount = ipToplam.get(ip) ?? 0;
    if (ipCount >= MAX_WS_PER_IP) {
      // Sayac kaymis olabilir; REDDETMEDEN once gercegi dogrula (sinirli).
      if (dogrula(ip)) ipCount = ipToplam.get(ip) ?? 0;
      if (ipCount >= MAX_WS_PER_IP) {
        log.warn({ event: 'ws_limit_ip', ip, count: ipCount, limit: MAX_WS_PER_IP });
        return next(new Error('TOO_MANY_CONNECTIONS_FROM_IP'));
      }
    }

    // ── Kimlik doğrulanmamış bağlantı limiti ────────────────────────────────
    // Bu middleware auth'dan ÖNCE çalışır; handshake.auth.token yalnızca
    // kullanıcı kontrollü bir stringdir ve kimlik kanıtı DEĞİLDİR. Token
    // varlığına bakarak bu limiti atlamak saldırganın herhangi bir sahte token
    // ile pre-auth kotasını MAX_WS_PER_IP seviyesine genişletmesine izin verirdi.
    let unauthCount = ipKimliksiz.get(ip) ?? 0;
    if (unauthCount >= MAX_UNAUTH_WS_PER_IP) {
      if (dogrula(ip)) unauthCount = ipKimliksiz.get(ip) ?? 0;
      if (unauthCount >= MAX_UNAUTH_WS_PER_IP) {
        log.warn({ event: 'ws_limit_unauth_ip', ip, count: unauthCount, limit: MAX_UNAUTH_WS_PER_IP });
        return next(new Error('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP'));
      }
    }

    // ── KABUL EDILDI: sayaclari artir ───────────────────────────────────────
    // Soket bu noktada henuz `userId` tasimaz; bu yuzden KIMLIKSIZ sayilir —
    // eski kodun `!s.userId` filtresiyle ayni anlam.
    artir(ipToplam, ip);
    artir(ipKimliksiz, ip);
    let kimlikli = false;
    let sahipId: string | null = null;
    let countedTotal = true;
    let countedUnauth = true;
    const handshakeTimer = setTimeout(() => {
      if (kimlikli) return;
      if (countedTotal) { azalt(ipToplam, ip); countedTotal = false; }
      if (countedUnauth) { azalt(ipKimliksiz, ip); countedUnauth = false; }
    }, HANDSHAKE_LEASE_MS);
    handshakeTimer.unref?.();

    let released = false;
    const releaseLocalReservation = (): void => {
      if (released) return;
      released = true;
      clearTimeout(handshakeTimer);
      if (countedTotal) { azalt(ipToplam, ip); countedTotal = false; }
      if (countedUnauth) { azalt(ipKimliksiz, ip); countedUnauth = false; }
      if (sahipId) {
        const kume = kullaniciSoketleri.get(sahipId);
        if (kume) {
          kume.delete(socket.id);
          if (kume.size === 0) kullaniciSoketleri.delete(sahipId);
        }
      }
    };
    socket._bridgeReleaseConnectionLimit = releaseLocalReservation;
    socket.once('disconnect', releaseLocalReservation);

    // Auth tamamlandıktan sonra kullanıcı bazlı kontrol için SERVER-INTERNAL hook.
    //
    // GÜVENLİK SINIRI: Bu geçiş bir Socket.IO event'i OLAMAZ. `socket.on/once`
    // ile `userAuthenticated` dinlemek client'ın keyfi bir userId göndererek
    // başka kullanıcının connection-limit kümesini manipüle etmesine izin
    // verirdi. Ayrıca server-side `socket.emit('userAuthenticated')` client'a
    // giden bir hazır sinyalidir; local callback çağrısı değildir.
    //
    // JWT middleware doğrulanmış kimliği bu property üzerinden doğrudan
    // bildirir. Client bu fonksiyona protokol üzerinden erişemez.
    socket._bridgeMarkAuthenticated = (userId: string): boolean => {
      if (!userId) return false;
      if (kimlikli) return sahipId === userId;
      // Authentication that did not finish within the bounded handshake lease
      // must restart; otherwise a connection could escape both pre-auth and
      // authenticated accounting after the lease was released.
      if (!countedTotal || !countedUnauth) return false;
      clearTimeout(handshakeTimer);
      kimlikli = true;
      azalt(ipKimliksiz, ip);
      countedUnauth = false;
      sahipId = userId;

      let kume = kullaniciSoketleri.get(userId);
      if (!kume) {
        // Bu kullanici icin ilk kez: gercek durumdan tohumla.
        kume = new Set<string>();
        for (const s of io.sockets.sockets.values()) {
          if ((s as SocketWithUserId).userId === userId) kume.add(s.id);
        }
        kullaniciSoketleri.set(userId, kume);
      }
      kume.add(socket.id);

      const userCount = [...kume].filter(id => id !== socket.id).length;

      if (userCount >= MAX_WS_PER_USER) {
        log.warn({
          event: 'ws_limit_user',
          userId,
          count: userCount,
          limit: MAX_WS_PER_USER,
        });
        // Eski bağlantıyı kapat (LIFO — en eski bağlantı korunur).
        // Yalnizca BU kullanicinin soketlerine bakilir: O(kullanici soketi),
        // tum sunucu O(N) degil.
        const oldestSocket = [...kume]
          .filter(id => id !== socket.id)
          .map(id => io.sockets.sockets.get(id) as SocketWithUserId | undefined)
          .filter((s): s is SocketWithUserId => Boolean(s))
          .sort((a, b) => {
            const ta = (a.handshake as unknown as { time?: number }).time ?? 0;
            const tb = (b.handshake as unknown as { time?: number }).time ?? 0;
            return ta - tb;
          })[0];

        if (oldestSocket) {
          log.info({
            event: 'ws_evict_oldest',
            userId,
            evictedId: oldestSocket.id,
          });
          oldestSocket.emit('error', { code: 'SESSION_REPLACED', message: 'Yeni bir sekme/cihazdan bağlandınız' });
          oldestSocket.disconnect(true);
        }
      }
      return true;
    };

    log.debug({ event: 'ws_connect_allow', ip, ipCount });
    next();
  };
}

/**
 * Socket'ten gerçek istemci IP'sini alır.
 * HAProxy/nginx arkasında X-Forwarded-For'a bakar.
 * TRUSTED_PROXY_COUNT ortam değişkeni ile proxy sayısı ayarlanır (varsayılan: 1).
 * Tek proxy varsayımı ile ilk IP alınırsa IP spoofing riski doğar;
 * TRUSTED_PROXY_COUNT bu riski azaltır.
 */
// ════════════════════════════════════════════════════════════════════════════
// KANONIK COZUMLEYICIYE DEVREDILDI (P1 sinifi — DORDUNCU kopya)
// ════════════════════════════════════════════════════════════════════════════
// Burada AYRI bir X-Forwarded-For yorumu vardi ve iki yonden hatalilydi:
//
//   1. VARSAYILAN GUVEN: TRUSTED_PROXY_COUNT varsayilani '1' idi. Dogrudan
//      internete acik bir kurulumda bu, HER istemcinin kendi IP'sini
//      uydurabilmesi demekti.
//   2. GUVENSIZ GERI DUSUS: beklenenden az hop varsa `hops[0]`a — yani tam
//      olarak saldirganin yazdigi degere — dusuyordu.
//
// SONUC: `MAX_WS_PER_IP` (10) ve `MAX_UNAUTH_WS_PER_IP` (3) sahtelenebilir
// bir anahtara baglaniyordu. Saldirgan her baglantida XFF'i degistirerek
// WS baglanti limitini TAMAMEN atlayabilir ve kaynak tuketimi yaratabilirdi.
//
// Ayni kusur sinifi bu programda HTTP tarafinda zaten kapatilmisti; bu,
// atlanan KARDES YOLDU. Guven modeli ve gerekce: lib/clientIp.ts
import { getClientIp as canonicalClientIp } from '../../lib/clientIp';

function getClientIp(socket: Socket): string {
  return canonicalClientIp({
    headers: socket.handshake.headers,
    socket:  { remoteAddress: socket.handshake.address },
  });
}
