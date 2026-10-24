// client/js/core/api-fetch.ts
// Faz 4 — Uygulamanın tek HTTP istemcisi: auth header + access-token yenileme.
//
// Sorun (canlı yakalandı): ACCESS_TOKEN_TTL dolunca tüm çağrılar 401 dönüyordu;
// modern katmanda yenileme yoktu. The historical pre-Svelte api-fetch implementation
// bunu paylaşılan tek promise + tek retry ile çözüyordu — davranış buraya taşındı.
//
// Backend sözleşmesi (server/routes/auth.ts:272-290):
//   POST /api/refresh  → httpOnly `bridge_refresh` cookie (veya body.refreshToken)
//                      → 200 { token } | 401 { error, reason }
//
// Kurallar: aynı anda N adet 401 → TEK refresh; her istek en fazla BİR kez retry;
// refresh başarısızsa mevcut logout akışına düşülür. Yeni window.* global yok.

import { getAPI, toServerUrl } from './globals.ts';
import { readToken, saveToken, logout } from './auth-compat.ts';
import {
  storageAvailable, tryAcquireLease, releaseLease, publishResult, waitForOtherTab,
} from './refresh-coordinator.ts';
import { createLogger } from './logger.ts';
import { BridgeRegistry } from './bridge-registry.ts';
import {
  STEP_UP_HEADER, grantFor, obtainStepUp, readStepUpRefusal, scopeForRequest, type StepUpHooks,
} from './step-up.ts';

const log = createLogger('ApiFetch');

/** Aynı anda tek yenileme — diğer çağrılar bu promise'i bekler. */
let _refreshPromise: Promise<boolean> | null = null;
let _authGeneration = 0;
let _refreshJob: { generation: number; controller: AbortController } | null = null;
/** Yenileme kalıcı olarak başarısızsa tekrar tekrar denenmesin. */
let _refreshDisabled = false;
/**
 * `false` tek başına oturumun gerçekten geçersiz olduğunu söylemez.
 * 503/429/ağ kesintisi gibi durumlarda refresh yapılamamıştır ama kullanıcının
 * refresh cookie'sinin geçersiz olduğuna dair kanıt YOKTUR. Bu ayrım olmadan
 * geçici bir bağımlılık arızası kullanıcıyı gereksiz yere oturumdan atıyordu.
 */
let _lastRefreshFailure: 'none' | 'transient' | 'permanent' | 'anonymous' = 'none';

export function isRefreshInFlight(): boolean {
  return _refreshPromise !== null;
}

export function wasLastRefreshFailureTransient(): boolean {
  return _lastRefreshFailure === 'transient';
}

/**
 * HİÇ oturum açılmamış ziyaretçi. Sunucu `POST /api/refresh` için 400
 * ("refreshToken required") döner: ortada reddedilen bir kimlik YOKTUR, çünkü hiç
 * sunulmamıştır. Bu ayrım olmadan ilk ziyaret "oturum süresi doldu" sayılıyor ve her
 * istek için ayrı bir çıkış denemesi + uyarı üretiyordu (ölçüldü: tek ziyarette 9 uyarı,
 * 8 gereksiz 401 ve başarısız bir `POST /api/logout`).
 */
export function wasLastRefreshAnonymous(): boolean {
  return _lastRefreshFailure === 'anonymous';
}

/** Test/oturum sıfırlama için — yeni girişten sonra yenileme tekrar denenebilir. */
export function resetRefreshState(): void {
  _authGeneration += 1;
  _refreshJob?.controller.abort();
  _refreshJob = null;
  _refreshPromise = null;
  _refreshDisabled = false;
  _lastRefreshFailure = 'none';
}

// ── YENİ OTURUM ESKİ BAŞARISIZLIĞI SİLER ────────────────────────────────────
// `_refreshDisabled` kalıcı bir yenileme reddinden sonra AÇIK kalıyordu ve hiçbir
// üretim yolu onu temizlemiyordu (`resetRefreshState` yalnızca testlerden
// çağrılıyordu). Giriş bir SPA geçişidir — sayfa YENİDEN YÜKLENMEZ — yani oturumsuz
// ziyarette alınan 400 ("refreshToken required") giriş yaptıktan SONRA da geçerli
// sayılıyordu: kişinin ilk jeton süresi dolduğunda sessizce yenilenmek yerine
// OTURUMU KAPATILIYORDU. Kimlik doğrulandığı an durum sıfırlanır.
if (typeof document !== 'undefined') {
  // CSRF jetonu bir KİMLİĞE bağlıdır: yeni oturum öncekinin jetonunu taşımaz.
  const resetSession = (): void => { resetRefreshState(); resetCsrfState(); };
  // Reset before ordinary consumers, regardless of dynamic import order; an
  // earlier sign-in consumer may immediately start the new session's requests.
  document.addEventListener('bridge:auth-success', resetSession, { capture: true });
  document.addEventListener('bridge:auth-logout', resetSession, { capture: true });
  document.addEventListener('bridge:auth-transition', resetSession, { capture: true });
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * SEKME-ICI *VE* SEKMELER-ARASI TEK UCUS
 * ════════════════════════════════════════════════════════════════════════════
 * `_refreshPromise` yalnizca BU sekmedeki es zamanli 401'leri birlestirir.
 * Iki SEKME ayni anda 401 alirsa ikisi de `POST /api/refresh` gonderirdi ve
 * ikisi de ayni httpOnly `bridge_refresh` cerezini tasirdi:
 *
 *     sekme A -> rotasyonu kazanir
 *     sekme B -> sunucu token'i `used` gorur -> REPLAY -> TUM AILE IPTAL
 *     sonuc   -> kullanici HER IKI sekmede de oturumdan atilir
 *
 * Bu, gercek PostgreSQL ile dogrulanmis sunucu davranisinin dogrudan sonucu.
 * Sunucu tarafi DEGISMEZ (replay korumasi dogru ve kasitli); yalnizca AYNI
 * TARAYICIDAKI sekmeler tekillestirilir: kirayi kazanan sekme istegi yapar,
 * digerleri bekleyip paylasilan `localStorage` token'ini yeniden okur.
 *
 * Calinmis token senaryosu ETKILENMEZ: saldirgan bizim `localStorage`imizi
 * paylasmaz, dolayisiyla sunucu onu yine replay olarak gorur.
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (_refreshDisabled) {
    // Sınıflandırma KORUNUR: bir kez "oturum yok" denmişse, sonraki her istek için
    // bunu "süresi dolmuş oturum"a çevirmek aynı gürültüyü geri getirirdi.
    if (_lastRefreshFailure !== 'anonymous') _lastRefreshFailure = 'permanent';
    return false;
  }
  if (_refreshPromise) return _refreshPromise;

  const job = { generation: _authGeneration, controller: new AbortController() };
  _refreshJob = job;
  const current = (): boolean => _refreshJob === job && job.generation === _authGeneration;
  let succeeded = false;
  const work = (async (): Promise<boolean> => {
    _lastRefreshFailure = 'none';
    const tokenBefore = readToken();
    const startedAt = Date.now();
    // Depolama erisilemezse (gizli sekme/kota) koordinasyon atlanir ve eski
    // sekme-ici davranisa dusulur -- en kotu durumda bugunku durum.
    const coordinated = storageAvailable();
    let isLeaseOwner = true;

    if (coordinated) {
      isLeaseOwner = tryAcquireLease();
      if (!isLeaseOwner) {
        // Baska bir sekme zaten yeniliyor: ISTEK GONDERME, sonucu bekle.
        const otherSucceeded = await waitForOtherTab(startedAt);
        if (!current()) return false;
        if (otherSucceeded) {
          const refreshed = readToken();
          if (refreshed && refreshed !== tokenBefore) {
            log.info('Access token baska bir sekme tarafindan yenilendi');
            succeeded = true;
            return true;
          }
        }
        // Diger sekme basarisiz oldu ya da zaman asimi: kirayi devralip
        // kendimiz deneriz. Kilitlenme yok; en kotu durumda eski davranis.
        isLeaseOwner = tryAcquireLease();
        if (!isLeaseOwner) {
          log.warn('Yenileme kirasi alinamadi; bu tur atlaniyor.');
          _lastRefreshFailure = 'transient';
          return false;
        }
      }
    }

    try {
      const response = await fetch(`${getAPI()}/api/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include', // httpOnly bridge_refresh cookie'si için zorunlu
        body: JSON.stringify({}),
        signal: job.controller.signal,
      });
      if (!current()) return false;

      if (!response.ok) {
        // Yalnızca istemcinin kimlik bilgisinin gerçekten reddedildiği
        // durumlar oturumu kalıcı olarak geçersiz kılar. 429/5xx geçicidir.
        // 400 = "refreshToken required": ortada cookie YOK, yani reddedilmiş bir kimlik de
        // yok. 401/403 ise gerçekten reddedilmiş bir kimliktir.
        const anonymous = response.status === 400;
        const permanent = anonymous || response.status === 401 || response.status === 403;
        _lastRefreshFailure = anonymous ? 'anonymous' : (permanent ? 'permanent' : 'transient');
        if (permanent) _refreshDisabled = true;
        if (anonymous) log.info('Oturum yok — kimlik gerektiren istek reddedildi');
        else log.warn(`Access token yenilenemedi (HTTP ${response.status})`);
        return false;
      }

      const data = await response.json() as { token?: unknown };
      if (!current()) return false;
      if (typeof data.token !== 'string' || !data.token) {
        // 2xx fakat bozuk gövde bir sunucu/proxy sözleşme arızasıdır; kullanıcının
        // oturumunun geçersiz olduğunu kanıtlamaz. Oturumu silmek yerine tekrar
        // denenebilir bir bağımlılık hatası olarak kalır.
        _lastRefreshFailure = 'transient';
        return false;
      }

      saveToken(data.token); // mevcut depolama sözleşmesi — yeni anahtar üretilmez
      _lastRefreshFailure = 'none';
      log.info('Access token yenilendi');
      succeeded = true;
      return true;
    } catch (error) {
      if (!current()) return false;
      _lastRefreshFailure = 'transient';
      log.warn('Refresh isteği başarısız', error);
      return false;
    }
  })();

  // Kira sahibiysek sonucu yayinla ve kirayi birak; bekleyen sekmeler ANINDA
  // uyanir. Hata durumunda da yayinlanir, aksi halde digerleri zaman asimini
  // beklerdi.
  // Finish coordination before resolving the shared promise. Superseded work
  // must not publish a result, release a newer lease, or clear its promise.
  _refreshPromise = work.finally(() => {
    if (!current()) return;
    try {
      if (storageAvailable()) {
        try { publishResult(succeeded); } finally { releaseLease(); }
      }
    } finally {
      _refreshPromise = null;
      _refreshJob = null;
    }
  });

  return _refreshPromise;
}

function withAuth(init: RequestInit, token: string | null, csrf?: string | null, stepUp?: string | null): RequestInit {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (csrf) headers.set('X-CSRF-Token', csrf);
  // P7 B2: a step-up grant travels ONLY in this explicit header, never in storage or a cookie.
  if (stepUp) headers.set(STEP_UP_HEADER, stepUp);
  return { ...init, headers, credentials: init.credentials ?? 'include' };
}

// ─── CSRF ─────────────────────────────────────────────────────────────────────
// CANLI YAKALANDI: sunucu, Bearer taşıyan TÜM mutasyon isteklerinde CSRF jetonu
// zorunlu kılıyor (server/middleware/csrf.ts). Kanıt (canlı ürün):
//   POST /api/servers/:sid/leave  jetonsuz → 403 {"error":"CSRF token missing"}
//   aynı istek  X-CSRF-Token ile → 400 {"error":"Owner cannot leave …"}
// Buna rağmen uygulamanın TEK HTTP istemcisi olan bu dosyada CSRF YOKTU.
// Yalnızca `EmptyServerStart.svelte` kendi özel `getCsrfToken()`ini taşıyordu.
// Sonuç: `apiFetch` üzerinden yapılan HER mutasyon üretimde 403 alıyordu —
// davet oluşturma, kanal oluşturma, sunucudan ayrılma dahil. Testlerde
// görünmüyordu çünkü testler `fetch`i taklit ediyor.
//
// DÜZELTME KANONİK YERDE: ikinci bir CSRF sahibi yaratmak yerine jeton bu tek
// istemciye eklendi.
//
// NEDEN ÖNCEDEN DEĞİL DE TEPKİSEL: jetonu her mutasyondan önce çekmek her
// çağrıya fazladan bir gidiş-dönüş eklerdi. Bunun yerine önbellekteki jeton
// varsa iliştirilir; yoksa istek gönderilir ve YALNIZ sunucu CSRF yüzünden
// reddederse jeton alınıp istek BİR kez tekrarlanır. Böylece oturumda yalnız
// ilk mutasyon fazladan tur atar, jeton döndürüldüğünde de akış kendini onarır.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let _csrfToken: string | null = null;
let _csrfPromise: Promise<string | null> | null = null;
let _csrfGeneration = 0;
let _csrfController: AbortController | null = null;

/** Test/oturum sıfırlama — yeni girişten sonra jeton yeniden alınır. */
export function resetCsrfState(): void {
  _csrfGeneration += 1;
  _csrfController?.abort();
  _csrfController = null;
  _csrfToken = null;
  _csrfPromise = null;
}

/** Kanonik uç: `GET /api/csrf-token` → { token }. Aynı anda TEK istek. */
async function fetchCsrfToken(): Promise<string | null> {
  if (_csrfPromise) return _csrfPromise;
  const generation = _csrfGeneration;
  const controller = new AbortController();
  _csrfController = controller;
  const current = (): boolean => generation === _csrfGeneration;

  _csrfPromise = (async (): Promise<string | null> => {
    try {
      const res = await fetch(`${getAPI()}/api/csrf-token`, withAuth({ method: 'GET', signal: controller.signal }, readToken()));
      if (!current()) return null;
      if (!res.ok) return null;
      const data = await res.json() as { token?: unknown };
      if (!current()) return null;
      _csrfToken = typeof data.token === 'string' && data.token ? data.token : null;
      return _csrfToken;
    } catch (error) {
      if (!current()) return null;
      log.warn('CSRF jetonu alınamadı', error);
      return null;
    } finally {
      if (current()) { _csrfPromise = null; _csrfController = null; }
    }
  })();

  return _csrfPromise;
}

/** 403'ün SEBEBİ CSRF mi? Gövde klonlanır — çağıranın yanıtı tüketilmez. */
async function isCsrfFailure(res: Response): Promise<boolean> {
  try {
    const body = await res.clone().json() as { error?: unknown };
    return typeof body.error === 'string' && /csrf/i.test(body.error);
  } catch {
    return false;
  }
}

export interface TypedResponse<T> extends Response {
  typed(): Promise<T>;
}
interface AuthRequestContext {
  generation: number;
  terminalLogoutGeneration?: number;
  accountDeletion: boolean;
}

// A successful DELETE /api/account may revoke the current socket session
// *before* its HTTP acknowledgement arrives. A normal cancellation would then
// conceal the only proof that the caller may erase the deleted account's local
// data. Keep that proof out of response headers/bodies: servers and proxies
// cannot forge this client-owned, per-Response marker.
const confirmedAccountDeletions = new WeakSet<Response>();
export function isConfirmedAccountDeletion(response: Response): boolean {
  return response.status === 409 && confirmedAccountDeletions.has(response);
}

/**
 * Auth'lu fetch. 401 alırsa bir kez token yeniler ve isteği BİR kez tekrarlar.
 * Yenileme başarısızsa oturum kapatılır ve 401 yanıtı çağırana döner.
 *
 * P7 B2: a `403 STEP_UP_REQUIRED` refusal is handed to the step-up owner
 * (`step-up.ts`), which supplies a grant it holds or asks for ONE proof; the
 * request is then sent once more with that grant. Cancel returns the original 403.
 */
export async function apiFetch<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<TypedResponse<T>> {
  const generation = _authGeneration;
  const method = String(init.method ?? 'GET').toUpperCase();
  const context: AuthRequestContext = {
    generation,
    accountDeletion: method === 'DELETE' && url === '/api/account',
  };
  const attach = (res: Response): TypedResponse<T> => {
    const typed = res as TypedResponse<T>;
    typed.typed = async () => (await res.json()) as T;
    return typed;
  };
  const attachCurrent = (res: Response): TypedResponse<T> => {
    // A refusal that ended THIS session still returns its original 401. It
    // cannot be mistaken for cancellation or carried into another signed-in
    // account. Other superseded responses remain content-free cancellations.
    const ownTerminalRefusal = res.status === 401 &&
      context.terminalLogoutGeneration === _authGeneration && !readToken();
    if (generation !== _authGeneration && !ownTerminalRefusal) {
      const cancelled = sessionChangedResponse();
      if (context.accountDeletion && (res.ok || confirmedAccountDeletions.has(res))) {
        confirmedAccountDeletions.add(cancelled);
      }
      return attach(cancelled);
    }
    return attach(res);
  };

  // Final21 Faz 19 (19-28): sunucu-göreli yol paketlenmiş mobil uygulamada API kökenine bağlanır (web: aynen).
  const target   = toServerUrl(url);
  const mutating = !SAFE_METHODS.has(method);

  // ── ANONYMOUS_SHORT_CIRCUIT ──────────────────────────────────────────────
  // Oturum olmadığı ZATEN belirlendiyse (refresh 400 = ortada kimlik yok) ve elde
  // erişim jetonu da yoksa, bu istek yalnızca 401 üretebilir. Göndermek istemciye
  // konsol hatası, sunucuya ölçümlerde sahte 401 trafiği yazar. Giriş yapılınca
  // `resetRefreshState()` bu durumu temizler ve istekler normal akar.
  if (!readToken() && wasLastRefreshAnonymous()) {
    return attach(new Response(JSON.stringify({ error: 'NOT_AUTHENTICATED' }), {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  // A grant this client already holds for the action's scope rides along up front.
  const scope = scopeForRequest(method, target);
  const held = scope ? grantFor(scope) : null;
  let response = await sendAuthed(target, init, mutating, held, context);
  if (generation !== _authGeneration) return attachCurrent(response);

  const refusal = await readStepUpRefusal(response);
  if (generation !== _authGeneration) return attachCurrent(response);
  if (refusal) {
    let grant: string | null = null;
    try {
      grant = await obtainStepUp(refusal, held, STEP_UP_HOOKS);
    } catch (error) {
      log.warn('Step-up proof could not be obtained', error);
    }
    if (generation !== _authGeneration) return attach(sessionChangedResponse());
    if (grant) response = await sendAuthed(target, init, mutating, grant, context);
  }
  return attachCurrent(response);
}

/** Proofs go through this same client (CSRF, refresh) and are never step-up protected themselves. */
const STEP_UP_HOOKS: StepUpHooks = {
  send: (path, body) => apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  signInAgain: () => { logout(); },
};

function sessionChangedResponse(): Response {
  return new Response(JSON.stringify({ error: 'AUTH_SESSION_CHANGED' }), {
    status: 409, headers: { 'Content-Type': 'application/json' },
  });
}

async function sendAuthed(target: string, init: RequestInit, mutating: boolean, stepUp: string | null, context: AuthRequestContext): Promise<Response> {
  const changed = (): boolean => context.generation !== _authGeneration;
  const preserveDeletionAck = (response: Response): boolean => context.accountDeletion && response.ok;
  if (changed()) return sessionChangedResponse();
  // ── ILK MUTASYON: JETONU REDDİ BEKLEMEDEN AL ─────────────────────────────
  // Önbellekte jeton yokken istek göndermek, oturumun ilk mutasyonunda GARANTİLİ bir
  // 403 üretiyordu (ölçüldü: her girişte PATCH 403 → jeton → PATCH 200, konsolda kırmızı
  // hata). Jeton yalnızca YOKKEN ve oturum AÇIKKEN önceden alınır; sonraki mutasyonlar
  // önbellekteki jetonu kullanır ve döndürme onarımı aşağıda aynen durur.
  if (mutating && !_csrfToken && readToken()) await fetchCsrfToken();
  if (changed()) return sessionChangedResponse();

  let response = await fetch(target, withAuth(init, readToken(), mutating ? _csrfToken : null, stepUp));
  if (changed()) return preserveDeletionAck(response) ? response : sessionChangedResponse();

  // CSRF reddi → jetonu tazele ve isteği BİR kez tekrarla (jeton döndürülmüş
  // olabilir). Yalnız mutasyonlarda ve yalnız sebep gerçekten CSRF ise.
  if (mutating && response.status === 403 && await isCsrfFailure(response)) {
    if (changed()) return sessionChangedResponse();
    _csrfToken = null;
    const fresh = await fetchCsrfToken();
    if (changed()) return sessionChangedResponse();
    if (fresh) response = await fetch(target, withAuth(init, readToken(), fresh, stepUp));
  }
  if (changed()) return preserveDeletionAck(response) ? response : sessionChangedResponse();

  if (response.status !== 401) return response;

  // Tek retry — ikinci 401'de tekrar refresh döngüsü başlatılmaz.
  const refreshed = await refreshAccessToken();
  if (changed()) return sessionChangedResponse();
  if (!refreshed) {
    if (wasLastRefreshFailureTransient()) {
      // KAPATILAN GÜVENİLİRLİK KUSURU:
      // refresh endpoint'i 503/429 olduğunda veya ağ kesildiğinde eski kod
      // bunu "oturum geçersiz" sanıp logout() çağırıyordu. Oysa kimlik bilgisi
      // reddedilmemiştir. Çağırana geçici bağımlılık hatası verilir; token ve
      // refresh cookie korunur, böylece UI yeniden deneyebilir.
      log.warn('Access token yenileme geçici olarak kullanılamıyor — oturum korunuyor');
      return new Response(JSON.stringify({ error: 'AUTH_REFRESH_TEMPORARILY_UNAVAILABLE' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
      });
    }
    if (wasLastRefreshAnonymous()) {
      // Giriş yapılmamış: 401 doğru yanıttır ve çağıranın işidir. Burada çıkış
      // yapmak, hiç var olmayan bir oturumu kapatmaya çalışmaktır.
      return response;
    }
    log.warn('Oturum süresi doldu — çıkış yapılıyor');
    logout();
    context.terminalLogoutGeneration = _authGeneration;
    return response;
  }

  response = await fetch(target, withAuth(init, readToken(), mutating ? _csrfToken : null, stepUp));
  if (changed()) return preserveDeletionAck(response) ? response : sessionChangedResponse();
  if (response.status === 401) {
    log.warn('Yenilemeden sonra da 401 — oturum kapatılıyor');
    _refreshDisabled = true;
    logout();
    context.terminalLogoutGeneration = _authGeneration;
  }
  return response;
}

export default apiFetch;

// ─── KANONİK REGISTRY KAYDI ───────────────────────────────────────────────────
// CANLI ÜRÜNDE YAKALANDI: on bileşen HTTP istemcisine
//     BridgeRegistry.get('apiFetch')
// ile ulaşıyor, ANCAK `register('apiFetch', …)` çağrısı KOD TABANINDA HİÇ YOKTU.
// Sonuç: üretimde `get()` her zaman `undefined` dönüyor, bileşenler kendi
// `catch` bloklarına düşüp genel bir hata metni gösteriyordu.
//
// Neden testlerde görünmedi: testler kendi sahte `apiFetch`ini registry'ye
// KAYDEDİYOR. Yani sözleşme yalnızca test ortamında vardı — üretimde yoktu.
// Bu, "testte yeşil, üründe kırık" sınıfının ikinci örneğidir (birincisi CSRF).
//
// ÖLÇÜM (canlı, tarayıcı): sunucu menüsü açıldığında
// `GET /:sid/me/permissions` isteği HİÇ oluşmuyordu; davet oluşturma da
// isteğe çıkmadan hata veriyordu.
//
// Kayıt BURADA yapılır çünkü kanonik sahip bu modüldür; ikinci bir HTTP
// istemcisi ÜRETİLMEZ. `Map.set` üzerine yazdığı için testlerin enjekte ettiği
// sahte istemci davranışı DEĞİŞMEZ.
BridgeRegistry.register('apiFetch', apiFetch);
