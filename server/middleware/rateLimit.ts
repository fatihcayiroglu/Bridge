// server/middleware/rateLimit.ts
// Sliding-window rate limiter
// Redis-backed store (falls back to in-memory when Redis unavailable)
// Tekrarlı ihlallerde otomatik geçici IP ban entegrasyonu
//
// Granülerlik stratejisi:
//   • IP-only   → kimlik doğrulanmamış endpoint'ler (login, register)
//   • User-only → kullanıcıya özel kotalar (upload, messages, ai)
//   • IP+User   → ikili limit; biri aşılınca 429 (çoğu endpoint)
//   • Global    → tüm istekler için arka plan güvenlik ağı
//
// Sprint 41 NOT: IP+User dual-key implementasyonu TAMAMLANDI.
//   Roadmap'teki 'rate limit dual-key eksik' maddesi kapatıldı.
//   Ayrıca: ihlal sayısı eşiği aşılınca otomatik IP ban aktif (bkz. ipBan.ts).
//   Bu davranış DEPLOYMENT_GUIDE.md'ye dokümante edilmeli.

import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';
import { tryRequire } from '../lib/_optional-require';
import { envSafeInt } from '../lib/envNumbers';
import { RL_GLOBAL_MAX_DEFAULT } from '../lib/rateLimitDefaults';

// ── Opsiyonel modüller (metrics + ipBan) ──────────────────────
// Bu modüller her deploy'da bulunmayabilir; tryRequire null döndürür, middleware çalışmaya devam eder.
interface MetricsModule {
  trackRateLimitHit: (req: Request, category: string) => void;
  _bumpAnomalyCounter: () => void;
  trackAutoBan: (category: string) => void;
}
interface IpBanModule {
  getBan: (ip: string) => Promise<unknown>;
  banIp:  (ip: string, opts: Record<string, unknown>) => Promise<void>;
}
const _metrics = tryRequire<MetricsModule>('./metrics', require);
const _ipBan   = tryRequire<IpBanModule>('./ipBan', require);

// NOT: proxy guven modelinin TEK sahibi `lib/clientIp.ts`. Buradaki eski
// kopya, kanonik cozumleyiciye gecisten sonra olu kalmisti.


interface LimitConfig {
  max:      number;
  windowMs: number;
}

const DEFAULTS: Record<string, LimitConfig> = {
  register:       { max: envSafeInt('RL_REGISTER_MAX', 5),   windowMs: envSafeInt('RL_REGISTER_WIN', 60_000)  },
  login:          { max: envSafeInt('RL_LOGIN_MAX', 10),  windowMs: envSafeInt('RL_LOGIN_WIN', 60_000)  },
  adminSetup:     { max: envSafeInt('RL_ADMIN_SETUP_MAX', 20), windowMs: envSafeInt('RL_ADMIN_SETUP_WIN', 300_000) },
  refresh:        { max: envSafeInt('RL_REFRESH_MAX', 30),  windowMs: envSafeInt('RL_REFRESH_WIN', 60_000)  },
  changePassword: { max: envSafeInt('RL_CHGPWD_MAX', 3),   windowMs: envSafeInt('RL_CHGPWD_WIN', 300_000) },
  upload:         { max: envSafeInt('RL_UPLOAD_MAX', 20),  windowMs: envSafeInt('RL_UPLOAD_WIN', 60_000)  },
  messages:       { max: envSafeInt('RL_MESSAGES_MAX', 30),  windowMs: envSafeInt('RL_MESSAGES_WIN', 60_000)  },
  react:          { max: envSafeInt('RL_REACT_MAX', 60),  windowMs: envSafeInt('RL_REACT_WIN', 60_000)  },
  settings:       { max: envSafeInt('RL_SETTINGS_MAX', 10),  windowMs: envSafeInt('RL_SETTINGS_WIN', 60_000)  },
  search:         { max: envSafeInt('RL_SEARCH_MAX', 20),  windowMs: envSafeInt('RL_SEARCH_WIN', 60_000)  },
  ai:             { max: envSafeInt('RL_AI_MAX', 10),  windowMs: envSafeInt('RL_AI_WIN', 60_000)  },
  'ai.stream':    { max: envSafeInt('RL_AI_STREAM_MAX', 5),   windowMs: envSafeInt('RL_AI_STREAM_WIN', 60_000)  },
  invite:         { max: envSafeInt('RL_INVITE_MAX', 10),  windowMs: envSafeInt('RL_INVITE_WIN', 60_000)  },
  twoFactor:      { max: envSafeInt('RL_2FA_MAX', 5),   windowMs: envSafeInt('RL_2FA_WIN', 300_000) },
  webauthn:       { max: envSafeInt('RL_WEBAUTHN_MAX', 20), windowMs: envSafeInt('RL_WEBAUTHN_WIN', 300_000) },
  dm:             { max: envSafeInt('RL_DM_MAX', 20),  windowMs: envSafeInt('RL_DM_WIN', 60_000)  },
  global:         { max: envSafeInt('RL_GLOBAL_MAX', RL_GLOBAL_MAX_DEFAULT), windowMs: envSafeInt('RL_GLOBAL_WIN', 60_000)  },
  friends:        { max: envSafeInt('RL_FRIENDS_MAX', 20),  windowMs: envSafeInt('RL_FRIENDS_WIN', 60_000)  },
  servers:        { max: envSafeInt('RL_SERVERS_MAX', 10),  windowMs: envSafeInt('RL_SERVERS_WIN', 60_000)  },
  // CSRF jeton uretimi. Gercek istemci sekme basina BIR jeton alir ve onu
  // onbellekler; yalnizca 403 sonrasi yeniler. 20/5dk fazlasiyla yeterlidir.
  // NEDEN SINIR GEREKIYOR: jetonlar artik jeton basina anahtar olarak
  // saklanir (es zamanli sekmeler icin — bkz. lib/security.ts). Ureticiye
  // sinir konmazsa kimligi dogrulanmis bir istemci Redis'te anahtar
  // sisirebilir. TTL(1sa) x bu sinir = kullanici basina en fazla ~240 anahtar.
  csrf:           { max: envSafeInt('RL_CSRF_MAX', 20),  windowMs: envSafeInt('RL_CSRF_WIN', 300_000) },
  // Arama BAGLAM onizlemesi. `search` ile ayni kotayi PAYLASMAZ ve bu bir
  // gevsetme DEGILDIR — iki ucun maliyeti ve kullanim profili farklidir:
  //   · /search        → FTS taramasi, kullanici SORGU YAZDIKCA calisir
  //   · /search/context→ birincil anahtar araması + iki kucuk aralik taramasi,
  //                      kullanici sonuclar arasinda GEZINDIKCE calisir
  // Onizleme secili sonuca gore yuklenir; klavyeyle on sonuc arasinda gezinen
  // bir kullanici arama kotasini tuketirdi. Yetki denetimi AYNIDIR.
  searchContext:  { max: envSafeInt('RL_SEARCH_CTX_MAX', 60),  windowMs: envSafeInt('RL_SEARCH_CTX_WIN', 60_000)  },
  roles:          { max: envSafeInt('RL_ROLES_MAX', 20),  windowMs: envSafeInt('RL_ROLES_WIN', 60_000)  },
  channels:       { max: envSafeInt('RL_CHANNELS_MAX', 20),  windowMs: envSafeInt('RL_CHANNELS_WIN', 60_000)  },
  polls:          { max: envSafeInt('RL_POLLS_MAX', 10),  windowMs: envSafeInt('RL_POLLS_WIN', 60_000)  },
  webhooks:       { max: envSafeInt('RL_WEBHOOKS_MAX', 15),  windowMs: envSafeInt('RL_WEBHOOKS_WIN', 60_000)  },
  federation:     { max: envSafeInt('RL_FEDERATION_MAX', 30),  windowMs: envSafeInt('RL_FEDERATION_WIN', 60_000)  },
  moderation:     { max: envSafeInt('RL_MODERATION_MAX', 30),  windowMs: envSafeInt('RL_MODERATION_WIN', 60_000)  },
  email:          { max: envSafeInt('RL_EMAIL_MAX', 5),   windowMs: envSafeInt('RL_EMAIL_WIN', 300_000) },
  bots:           { max: envSafeInt('RL_BOTS_MAX', 20),  windowMs: envSafeInt('RL_BOTS_WIN', 60_000)  },
  write:          { max: envSafeInt('RL_WRITE_MAX', 30),  windowMs: envSafeInt('RL_WRITE_WIN', 60_000)  },
  // Sprint 108: voice-state endpoint — mute/deaf güncellemeleri burst'e açık; kısıtlı tutulur
  voiceState:     { max: envSafeInt('RL_VOICE_STATE_MAX', 30),  windowMs: envSafeInt('RL_VOICE_STATE_WIN', 10_000)   },
  // Sprint 121 FIX 25: serverEvents.ts'de limits.api kullanılıyor — eksik tanım eklendi
  api:            { max: envSafeInt('RL_API_MAX', 60),  windowMs: envSafeInt('RL_API_WIN', 60_000)  },
  serverEvents:   { max: envSafeInt('RL_SERVER_EVENTS_MAX', 20), windowMs: envSafeInt('RL_SERVER_EVENTS_WIN', 60_000) },
};

// ── STORE: Redis-backed with in-memory fallback ──────────────

interface RedisClient {
  multi(): {
    zAdd(key: string, members: { score: number; value: string }[]): unknown;
    zRemRangeByScore(key: string, min: string, max: number): unknown;
    zCard(key: string): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<unknown[]>;
  };
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  on(event: string, cb: () => void): void;
  connect(): Promise<void>;
}

// Sprint 121 FIX 24: Bağımsız Redis client yerine redisAdapter paylaşımlı client kullanılıyor
import { redisClient as _sharedRedisClient, isRedisAvailable, cache as _sharedCache, redisAuthoritativeCommand } from '../lib/redisAdapter';
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);
import { getClientIp } from '../lib/clientIp';

type RedisOperationResult<T> = { used: false } | { used: true; value: T };

async function runRateLimitRedis<T>(
  operation: string,
  command: (client: RedisClient) => Promise<T>,
): Promise<RedisOperationResult<T>> {
  if (REDIS_CONFIGURED) {
    const value = await redisAuthoritativeCommand(`rate limit ${operation}`, raw =>
      command(raw as RedisClient));
    return { used: true, value };
  }

  // Deliberate no-Redis/single-node mode may still have an optional client in
  // tests or local deployments. It is acceleration only; failures may fall
  // back to the process-local store because no shared authority was promised.
  if (!isRedisAvailable()) return { used: false };
  const client = _sharedRedisClient() as RedisClient | null;
  if (!client) return { used: false };
  return { used: true, value: await command(client) };
}

const memStore = new Map<string, number[]>();
const MAX_STORE_SIZE = 100_000;

async function hitRedis(key: string, windowMs: number): Promise<number | null> {
  try {
    const now = Date.now();
    const windowSec = Math.ceil(windowMs / 1000);
    const member = `${now}:${Math.random()}`;
    const result = await runRateLimitRedis('sliding window', async client => {
      const pipe = client.multi();
      pipe.zAdd(key, [{ score: now, value: member }]);
      pipe.zRemRangeByScore(key, '-inf', now - windowMs);
      pipe.zCard(key);
      pipe.expire(key, windowSec + 1);
      const results = await pipe.exec();
      return results[2] as number;
    });
    return result.used ? result.value : null;
  } catch (error) {
    logger.warn({ event: 'ratelimit.redis.error', err: error instanceof Error ? error.message : String(error) },
      REDIS_CONFIGURED ? 'Redis rate-limit operation failed; rejecting request.' : 'Redis rate-limit operation failed; switching to in-memory fallback.');
    if (REDIS_CONFIGURED) throw error;
    return null;
  }
}

function hitMemory(key: string, windowMs: number): number {
  if (memStore.size > MAX_STORE_SIZE) pruneMemStore();
  const now = Date.now();
  const hits = (memStore.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  memStore.set(key, hits);
  return hits.length;
}

const HTTP_AUTO_BAN_THRESHOLD   = envSafeInt('RL_HTTP_AUTO_BAN_THRESHOLD', 10);
const HTTP_AUTO_BAN_DURATION_MS = envSafeInt('RL_HTTP_AUTO_BAN_DURATION', 10 * 60_000);

interface ViolationRecord {
  count: number;
  firstAt: number;
}

const _httpViolationsMem = new Map<string, ViolationRecord>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _httpViolationsMem) {
    if (now - rec.firstAt > 3_600_000) _httpViolationsMem.delete(ip);
  }
}, 10 * 60_000).unref();

const VIOLATION_KEY_TTL = 3600;

export async function getViolationRecord(ip: string): Promise<ViolationRecord | null> {
  try {
    const result = await runRateLimitRedis('get violation', client => client.get(`rl:violations:${ip}`));
    if (result.used) {
      if (!result.value) return null;
      return JSON.parse(result.value) as ViolationRecord;
    }
  } catch (err) {
    if (REDIS_CONFIGURED) throw err;
  }
  return _httpViolationsMem.get(ip) || null;
}

export async function setViolationRecord(ip: string, rec: ViolationRecord): Promise<void> {
  try {
    const result = await runRateLimitRedis('set violation', client =>
      client.set(`rl:violations:${ip}`, JSON.stringify(rec), { EX: VIOLATION_KEY_TTL }));
    if (result.used) return;
  } catch (err) {
    if (REDIS_CONFIGURED) throw err;
  }
  _httpViolationsMem.set(ip, rec);
}

export async function deleteViolationRecord(ip: string): Promise<void> {
  try {
    const result = await runRateLimitRedis('delete violation', client => client.del(`rl:violations:${ip}`));
    if (result.used) {
      _httpViolationsMem.delete(ip);
      return;
    }
  } catch (err) {
    if (REDIS_CONFIGURED) throw err;
  }
  _httpViolationsMem.delete(ip);
}


async function incrementViolationCount(ip: string): Promise<number> {
  const now = Date.now();
  if (REDIS_CONFIGURED || isRedisAvailable()) {
    try {
      // Atomic across HTTP workers/nodes. When Redis is configured this call
      // is authoritative and must throw rather than dilute into a per-node
      // violation counter if Redis has already been marked unavailable.
      return await _sharedCache.increment(`httpviolation:${ip}`, VIOLATION_KEY_TTL);
    } catch (err) {
      logger.warn({ event: 'ratelimit.violation.redis.error', err: err instanceof Error ? err.message : String(err) },
        REDIS_CONFIGURED
          ? 'Redis violation counter failed; shared authority remains mandatory.'
          : 'Redis violation counter failed; using process-local fallback.');
      if (REDIS_CONFIGURED) throw err;
    }
  }
  const rec = _httpViolationsMem.get(ip) ?? { count: 0, firstAt: now };
  rec.count += 1;
  if (rec.count === 1) rec.firstAt = now;
  _httpViolationsMem.set(ip, rec);
  return rec.count;
}

// ── Granülerlik modu ─────────────────────────────────────────────
// 'ip'          → Yalnızca IP bazlı (kimlik doğrulanmamış: login, register)
// 'user'        → Yalnızca user-ID bazlı (oturum açık: upload, ai)
// 'combined'    → IP+user: her ikisi de kontrol edilir, biri aşılınca 429 (varsayılan)
// 'ip-only'     → Authenticated bile olsa sadece IP (federation ping vb.)
// 'per-user-ip' → user+IP kombinasyonu: VPN dönüşümü + çok hesap saldırısına karşı
//                 Aynı kullanıcının farklı IP'lerden spam yapmasını da engeller
type RateLimitMode = 'ip' | 'user' | 'combined' | 'ip-only' | 'per-user-ip';

/**
 * `combined` modda IP anahtarinin tavanini kullanici kotasinin kac kati
 * yapacagi. Paylasilan NAT arkasindaki mesru kullanicilarin birbirini
 * kilitlemesini onler; IP yine de sinirsiz degildir.
 */
const SHARED_IP_CEILING_FACTOR = envSafeInt('RL_SHARED_IP_FACTOR', 20);

interface RateLimitOptions {
  /** @deprecated 'mode' kullanın — geriye dönük uyumluluk için korunuyor */
  userOnly?: boolean;
  /** Granülerlik modu. Varsayılan: userOnly=true → 'user', userOnly=false → 'combined' */
  mode?: RateLimitMode;
  /**
   * `req.user` henüz yokken kimliği sağlar — kimlik doğrulamadan ÖNCE bağlanan
   * sınırlayıcılar için (küresel `/api`). Yalnızca DOĞRULANMIŞ bir kimlik
   * döndürmelidir; `null` anonim demektir ve IP tavanı aynen uygulanır.
   */
  identify?: (req: Request) => string | null;
}

export function rateLimit(
  max: number,
  windowMs: number,
  keyPrefix = '',
  opts: RateLimitOptions = {}
) {
  // Geriye dönük uyumluluk: userOnly → mode dönüşümü
  const mode: RateLimitMode = opts.mode ?? (opts.userOnly ? 'user' : 'combined');

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip  = getClientIp(req);
    const uid = (req as Request & { user?: { id: string } }).user?.id || opts.identify?.(req) || '';

    // ── Anahtar(lar) ve HER ANAHTARIN KENDI TAVANI ───────────
    // ══════════════════════════════════════════════════════════════════════
    // PAYLASILAN IP'DE YAN HASAR — KATMANLI TAVAN
    // ══════════════════════════════════════════════════════════════════════
    // `combined` modu ONCEDEN her iki anahtari da AYNI `max` degeriyle
    // olcuyordu (`Math.max(ipCount, userCount) > max`). Sonuc: kimligi
    // dogrulanmis TEK bir kullanici, paylasilan IP kovasini tuketip AYNI
    // NAT arkasindaki ILGISIZ kullanicilari kilitleyebiliyordu.
    //
    // GERCEK SENARYO (kod incelemesiyle dogrulandi): `csrf` siniri 5 dakikada
    // 20'dir ve `combined` modda calisir. Bir ofis/yurt/universite NAT'i
    // arkasindaki 20 kullanici uygulamayi actiginda 20 jeton uretilir;
    // 21. mesru kullanici 429 alir. Ayni sinif `servers` (10/dk),
    // `search` ve `friends` uclarinda da gecerlidir.
    //
    // COZUM (IP korumasi KALDIRILMAZ): kimlik dogrulanmis isteklerde IP
    // anahtari genis bir ACIL DURUM TAVANI olur, gercek kota ise KULLANICI
    // anahtarindadir. Boylece:
    //   · tek kullanici komsularini ac birakamaz,
    //   · IP hala sinirsiz degildir (kacak istemci/botnet yine yakalanir),
    //   · kimlik DOGRULANMAMIS istekte IP tavani AYNEN sikidir.
    //
    // Carpan ortamdan ayarlanabilir; varsayilan muhafazakardir.
    let keyed: Array<{ key: string; limit: number }>;
    switch (mode) {
      case 'ip':
        keyed = [{ key: `rl:${keyPrefix}:ip:${ip}`, limit: max }];
        break;
      case 'user':
        keyed = uid
          ? [{ key: `rl:${keyPrefix}:u:${uid}`, limit: max }]
          : [{ key: `rl:${keyPrefix}:ip:${ip}`, limit: max }];
        break;
      case 'ip-only':
        keyed = [{ key: `rl:${keyPrefix}:ip:${ip}`, limit: max }];
        break;
      case 'per-user-ip':
        // user+IP birleşik anahtar: hem kullanıcı kotasını hem IP başına kotayı takip eder
        // VPN dönüşüm saldırılarına ve çok hesaplı kötüye kullanıma karşı etkili
        keyed = uid
          ? [
              { key: `rl:${keyPrefix}:u:${uid}`, limit: max },
              { key: `rl:${keyPrefix}:uip:${uid}:${ip}`, limit: max },
            ]
          : [{ key: `rl:${keyPrefix}:ip:${ip}`, limit: max }];
        break;
      case 'combined':
      default:
        keyed = uid
          ? [
              // ACIL DURUM tavani — komsulari korur ama IP'yi sinirsiz birakmaz.
              // AYRI anahtar (`ipa`): kimlikli trafik, anonim istegin sayacina
              // yazilirsa meşgul bir NAT'ta giris/kayit gibi kimliksiz uclar
              // 429 alir (Final21 F21-11-04, e2e'de olculdu). Anonim tavan
              // `ip` anahtarinda aynen `max` kalir.
              { key: `rl:${keyPrefix}:ipa:${ip}`, limit: max * SHARED_IP_CEILING_FACTOR },
              // GERCEK kota: kullanici basina.
              { key: `rl:${keyPrefix}:u:${uid}`, limit: max },
            ]
          : [{ key: `rl:${keyPrefix}:ip:${ip}`, limit: max }];
    }

    // ── PAYLASILAN IP ADALETI (v1.124) ───────────────────────
    // OLCULDU: her istek, KENDI kotasi kontrol edilmeden ONCE hem hesap hem
    // IP sayacini artiriyordu. Sonuc, ayni NAT arkasindaki komsular icin
    // haksizdi: kendi kotasini coktan asmis bir kullanicinin REDDEDILEN
    // istekleri bile paylasilan IP butcesini tuketmeye devam ediyordu.
    //
    // Regresyon testi bunu somut olarak gosterdi (tests/shared-ip-fairness):
    // bir kotuye kullananin taskini sonrasinda AYNI IP'deki temiz bir
    // kullanicinin 4 istekten 0'i geciyordu.
    //
    // DUZELTME: kimligi dogrulanmis trafikte once HESAP kotasi olculur.
    // Hesap kendi kotasini asmissa istek reddedilir ve IP toplamina
    // DOKUNULMAZ — boylece bir kullanici komsularinin butcesini tuketemez.
    //
    // GUVENLIK GEVSETILMEDI:
    //   · anonim trafik  → yalnizca IP anahtari, aynen eskisi gibi
    //   · kota ICINDEKI hesaplar → IP toplamina sayilmaya DEVAM eder,
    //     dolayisiyla cok-hesapli taskin hâlâ tavana carpar
    //   · degisen tek sey: ZATEN reddedilmis istekler artik ceza olarak
    //     baskalarinin butcesini yakmaz
    // `combined` modda son anahtar HESAP kotasidir (yukaridaki siralama).
    const accountIdx = keyed.length - 1;
    const ipIdx = 0;
    // Anahtarlar BIR KEZ alinir. Dizi indekslemesi `noUncheckedIndexedAccess`
    // altinda `undefined` verebilir ve bir hiz siniri yolunda `undefined.limit`
    // ile karsilastirma yapmak sessizce HER ISTEGI GECIRIRDI. Varlik denetimi
    // AYRI bir `if` degil, `accountFirst` kosulunun parcasidir: boylece
    // TypeScript blok icinde daraltma yapar ve ULASILAMAYAN bir dal olusmaz.
    // Anahtar kumesi bozuksa akis asagidaki genel yola duser; orada eksik
    // sayac "asilmis" sayilir (fail-closed).
    const accountKey = keyed[accountIdx];
    const ipKey = keyed[ipIdx];
    const accountFirst = keyed.length > 1 && accountKey !== undefined && ipKey !== undefined;
    let counts: number[];
    try {
      if (accountFirst) {
        let accountCount = await hitRedis(accountKey.key, windowMs);
        if (accountCount === null) accountCount = hitMemory(accountKey.key, windowMs);

        if (accountCount > accountKey.limit) {
          // Hesap kendi kotasini asti: IP toplamini ARTIRMADAN reddet.
          counts = [];
          counts[accountIdx] = accountCount;
          counts[ipIdx] = 0;                     // IP butcesi harcanmadi
          const retryAfterSelf = Math.ceil(windowMs / 1000);
          res.set('X-RateLimit-Limit', String(max));
          res.set('X-RateLimit-Remaining', '0');
          res.set('Retry-After', String(retryAfterSelf));
          try { _metrics?.trackRateLimitHit(req, keyPrefix); } catch { /* metrik opsiyonel */ }
          logger.warn({ event: 'ratelimit.account_quota', prefix: keyPrefix, count: accountCount, limit: accountKey.limit },
            'Account exceeded its own quota; shared IP budget NOT charged.');
          res.status(429).json({ error: 'Çok fazla istek. Lütfen biraz bekleyin.' });
          return;
        }

        let ipCount = await hitRedis(ipKey.key, windowMs);
        if (ipCount === null) ipCount = hitMemory(ipKey.key, windowMs);
        counts = [];
        counts[ipIdx] = ipCount;
        counts[accountIdx] = accountCount;
      } else {
        counts = await Promise.all(keyed.map(async ({ key }) => {
          let c = await hitRedis(key, windowMs);
          if (c === null) c = hitMemory(key, windowMs);
          return c;
        }));
      }
    } catch (error) {
      logger.error({ event: 'ratelimit.authority_unavailable', err: error instanceof Error ? error.message : String(error) },
        'Configured Redis rate-limit authority is unavailable; request rejected fail-closed.');
      res.set('Retry-After', '1');
      res.status(503).json({ error: 'Rate limit service temporarily unavailable' });
      return;
    }
    const keys = keyed.map(k => k.key);
    // Her anahtar KENDI tavaniyla karsilastirilir.
    // Sayac okunamiyorsa `undefined > limit` HER ZAMAN false olur ve istek
    // sessizce GECERDI. Eksik sayac = asilmis kabul edilir (fail-closed).
    const exceeded = keyed.some((k, i) => (counts[i] ?? Number.POSITIVE_INFINITY) > k.limit);
    // Basliklar KULLANICI kotasini yansitir (anlamli olan budur); kimlik
    // yoksa tek anahtarin kendisi kullanilir.
    const budgetIdx = keyed.length > 1 ? keyed.length - 1 : 0;
    const count = counts[budgetIdx] ?? 0;
    const budgetLimit = keyed[budgetIdx]?.limit ?? max;

    const remaining = Math.max(0, budgetLimit - count);
    const resetAt   = Math.ceil((Date.now() + windowMs) / 1000);

    res.set('X-RateLimit-Limit',     String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset',     String(resetAt));
    // RFC 6585 policy header — client'a mod bilgisi ver
    res.set('X-RateLimit-Policy',    `${max};w=${Math.ceil(windowMs / 1000)};mode=${mode};keys=${keys.length}`);

    if (exceeded) {
      const retryAfter = Math.ceil(windowMs / 1000);
      res.set('Retry-After', String(retryAfter));

      // _metrics top-level'da yüklendi; yoksa null
      if (_metrics) {
        try {
          _metrics.trackRateLimitHit(req, keyPrefix);
          _metrics._bumpAnomalyCounter();
        } catch { /* non-fatal */ }
      }

      try {
        const violationCount = await incrementViolationCount(ip);

        if (violationCount >= HTTP_AUTO_BAN_THRESHOLD) {
          if (_ipBan) {
            const existing = await _ipBan.getBan(ip);
            if (!existing) {
              await _ipBan.banIp(ip, {
                reason:     `Otomatik ban: HTTP rate limit (${keyPrefix}) ${violationCount}x aşıldı`,
                durationMs: HTTP_AUTO_BAN_DURATION_MS,
                adminId:    'system',
              });
              if (_metrics) { try { _metrics.trackAutoBan(keyPrefix); } catch { /* ignore */ } }
              logger.warn(
                { ip, prefix: keyPrefix, durationMinutes: HTTP_AUTO_BAN_DURATION_MS / 60_000, event: 'ratelimit.auto_ban.applied' },
                'Automatic HTTP IP ban applied due to repeated rate-limit violations.'
              );
              await deleteViolationRecord(ip);
              await _sharedCache.del(`httpviolation:${ip}`).catch(() => undefined);
            }
          }
        }
      } catch (banErr) {
        logger.error({ err: banErr, event: 'ratelimit.auto_ban.failed' }, 'Failed to apply automatic IP ban.');
      }

      res.status(429).json({
        error: `Too many requests. Retry in ${retryAfter} seconds.`,
        retryAfter,
      });
      return;
    }
    next();
  };
}

const maxWindow = Math.max(...Object.values(DEFAULTS).map(d => d.windowMs));

export function pruneMemStore(): void {
  const cutoff = Date.now() - maxWindow;
  for (const [key, hits] of memStore) {
    const fresh = hits.filter(t => t > cutoff);
    if (!fresh.length) memStore.delete(key); else memStore.set(key, fresh);
  }
}

setInterval(pruneMemStore, 5 * 60_000).unref();

/**
 * @internal — YALNIZCA TESTLERDE.
 *
 * `pruneMemStore` yalnizca EN UZUN pencereden daha eski girisleri atar; 5
 * dakikalik 2FA penceresi gibi uzun pencerelerde ayni sureci paylasan testler
 * birbirinin sayacini miras alir. Bunun sonucu sessiz bir olcum kaybidir: bir
 * suit icinde ilk birkac test gecer, sonrakiler 429 alir ve "urun bozuk"
 * gibi gorunur.
 *
 * Uretim davranisi DEGISMEZ; bu fonksiyonun hicbir uretim cagirani yoktur.
 */
export function _resetRateLimitStoreForTest(): void {
  memStore.clear();
  _httpViolationsMem.clear();
}

// ── Kısa yardımcılar ─────────────────────────────────────────
// _ip  → yalnızca IP (kimlik doğrulanmamış endpointler: login, register, 2FA)
// _u   → yalnızca user-ID (oturum açık, kişisel kota: upload, ai, messages)
// _c   → combined IP+user (genel authenticated endpointler)
// _uip → per-user-IP: user+IP kombinasyonu (VPN dönüşüm + çok hesap saldırılarına karşı)
/**
 * Yapilandirma araması TEK yerde ve KESIN yapilir.
 *
 * Eskiden her yardimci `DEFAULTS[key].max` yaziyordu; `noUncheckedIndexedAccess`
 * altinda bu `undefined.max` olabilir. Bir yazim hatasi (`_ip('logn')`)
 * uretimde ANINDA cokerdi ve hangi limitin bozuk oldugu belli olmazdi.
 * Simdi eksik anahtar, hangi anahtar oldugunu soyleyen acik bir hata verir.
 */
function limitConfig(key: string): LimitConfig {
  const config = DEFAULTS[key];
  if (!config) throw new Error(`[rateLimit] Tanımsız limit anahtarı: ${key}`);
  return config;
}

const _ip  = (key: string) => () => { const c = limitConfig(key); return rateLimit(c.max, c.windowMs, key, { mode: 'ip' }); };
const _u   = (key: string) => () => { const c = limitConfig(key); return rateLimit(c.max, c.windowMs, key, { mode: 'user' }); };
const _c   = (key: string) => () => { const c = limitConfig(key); return rateLimit(c.max, c.windowMs, key, { mode: 'combined' }); };
const _uip = (key: string) => () => { const c = limitConfig(key); return rateLimit(c.max, c.windowMs, key, { mode: 'per-user-ip' }); };

export const limits = {
  // IP-only: henüz kimlik doğrulanmamış — user-ID yok
  register:       _ip('register'),
  login:          _ip('login'),
  adminSetup:     _ip('adminSetup'),
  twoFactor:      _ip('twoFactor'),
  webauthn:       _ip('webauthn'),
  email:          _ip('email'),
  invite:         _ip('invite'),

  // User-only: kişisel kota, VPN arkasındaki kullanıcılar sorunsuz erişsin
  upload:         _u('upload'),
  messages:       _u('messages'),
  react:          _u('react'),
  settings:       _u('settings'),
  dm:             _u('dm'),
  ai:             _uip('ai'),
  'ai.stream':    _uip('ai.stream'),
  write:          _u('write'),
  search:         _c('search'),

  // Combined: hem IP hem user-ID izlenir — ikisi de aşılınca 429
  refresh:        _c('refresh'),
  changePassword: _c('changePassword'),
  friends:        _c('friends'),
  servers:        _c('servers'),
  csrf:           _c('csrf'),
  searchContext:  _c('searchContext'),
  roles:          _c('roles'),
  channels:       _c('channels'),
  polls:          _c('polls'),
  webhooks:       _c('webhooks'),
  moderation:     _uip('moderation'),  // per-user-IP: moderasyon işlemlerinde VPN atlatma engeli
  bots:           _c('bots'),
  federation:     _c('federation'),
  global:         _c('global'),
  // `general` KALDIRILDI (Final21 Faz 19): `global` önekini paylaşan ikinci bir sınırlayıcıydı;
  // uygulama çapındaki /api sınırlayıcısı zaten her rotaya uygulanır, rota düzeyinde tekrar
  // bağlanması her isteği küresel bütçeden İKİ kez düşürüyordu (tests/route-limiter-no-double-count).
  // Sprint 108: voice-state per-user — kullanıcı başına izlenir (IP değil)
  voiceState:     _u('voiceState'),
  // Sprint 121 FIX 25: serverEvents.ts / genel API endpoint'leri için
  api:            _c('api'),
  serverEvents:   _c('serverEvents'),
};
