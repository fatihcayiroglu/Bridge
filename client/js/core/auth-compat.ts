// client/js/core/auth-compat.ts
// HTML'deki legacy auth handler'ları için geçiş katmanı.

import { readableTextOn } from './avatar-color.ts';
import { getAPI } from './globals.ts';
import { createLogger } from './logger.ts';
import { BridgeRegistry } from './bridge-registry.ts';
import { t } from './i18n/index.ts';
import { ApiResponseError, safeApiErrorMessage } from './api-error.ts';
import { registrationProblem, type RegistrationProblem } from './registration-rules.ts';
import { pushTargetsForLogout } from './push-installation.ts';
import { rememberSignInGrants } from './step-up.ts';

type AuthTab = 'login' | 'register';

type AuthUser = {
  _id?: string;
  id?: string;
  username?: string;
  displayName?: string;
  avatarColor?: string;
  /** Varlik durumu — sunucu allowlist'i: online | idle | dnd | offline. */
  status?: string;
  /** Ozel durum (sema: users.statusText / users.statusEmoji). */
  statusText?: string;
  statusEmoji?: string;
  /** Kullanicinin SECTIGI varlik (Ayarlar > Profil): online | idle | dnd | offline (gorunmez). */
  presenceStatus?: string;
  [key: string]: unknown;
};

type AuthPayload = {
  token?: unknown;
  user?: unknown;
  error?: unknown;
  message?: unknown;
  requiresTwoFactor?: unknown;
  tempToken?: unknown;
  /** P7 B2: one short-lived step-up grant per scope; kept in memory only. */
  stepUp?: unknown;
};

const log = createLogger('AuthCompat');

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function text(id: string): string {
  return el<HTMLInputElement>(id)?.value.trim() ?? '';
}

/** Oturum token'ı — SocketManager.svelte de aynı depolama anahtarlarını kullanır. */
export function readToken(): string | null {
  try {
    return localStorage.getItem('token') || localStorage.getItem('bridge_token');
  } catch {
    return null;
  }
}

/** Access token'ı mevcut depolama sözleşmesiyle yazar — api-fetch.ts yenileme sonrası kullanır. */
export function saveToken(token: string): void {
  try {
    localStorage.setItem('token', token);
    localStorage.setItem('bridge_token', token);
  } catch {
    // Depolama kapalıysa geçerli sayfa oturumu yine çalışabilir.
  }
}

function purgeLegacyRefreshTokens(): void {
  try {
    // Historical builds exposed refresh tokens to JavaScript under these keys.
    // Browser sessions now use only the httpOnly `bridge_refresh` cookie.
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('bridge_refresh_token');
  } catch {
    // Storage may be unavailable (privacy mode / test environment).
  }
}

// One-time migration cleanup for users upgrading from legacy builds.
purgeLegacyRefreshTokens();

function clearToken(): void {
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('bridge_token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('bridge_refresh_token');
  } catch {
    // no-op
  }
}

type AuthFlowKind = 'login' | 'register' | 'twoFactor' | 'sso' | 'recovery';

class AuthFlowError extends Error {
  constructor(message: string) { super(message); this.name = 'AuthFlowError'; }
}

/**
 * Authentication responses use endpoint-specific product language instead of
 * reflecting arbitrary backend `error`/`message` bodies into the DOM. This is
 * both safer (no stack/SQL/proxy leakage) and clearer than generic HTTP text.
 */
function authResponseText(response: Response, fallback: string, flow: AuthFlowKind): string {
  if (response.status === 429) return t('auth_too_many_attempts', 'Çok fazla deneme yapıldı. Biraz bekleyip tekrar dene.');
  if (response.status >= 500) return t('auth_service_unavailable', 'Kimlik doğrulama hizmeti şu anda kullanılamıyor. Birazdan tekrar dene.');

  if (flow === 'login' && (response.status === 400 || response.status === 401))
    return t('auth_invalid_credentials', 'Kullanıcı adı veya şifre hatalı.');
  if (flow === 'register' && response.status === 409)
    return t('auth_username_taken', 'Bu kullanıcı adı zaten kullanılıyor.');
  if (flow === 'register' && response.status === 400)
    return t('auth_invalid_registration', 'Kayıt bilgileri geçersiz. Kullanıcı adı ve şifreyi kontrol et.');
  if (flow === 'twoFactor' && (response.status === 400 || response.status === 401))
    return t('auth_invalid_code', 'Doğrulama kodu geçersiz veya süresi dolmuş.');
  if (flow === 'sso' && response.status >= 400 && response.status < 500)
    return t('auth_sso_invalid', 'SSO oturumu geçersiz veya süresi dolmuş. Lütfen yeniden giriş yap.');
  return fallback;
}

function authExceptionText(error: unknown, fallback: string): string {
  if (error instanceof AuthFlowError) return error.message;
  return safeApiErrorMessage(error, fallback, { report: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUser(value: unknown): value is AuthUser {
  if (!isRecord(value)) return false;
  return [value._id, value.id, value.username]
    .some(identity => typeof identity === 'string' && identity.trim().length > 0);
}

export function showAuthMsg(message: string, type: 'error' | 'success' = 'error'): void {
  const node = el<HTMLElement>('auth-msg');
  if (!node) return;
  node.className = type === 'success' ? 'auth-success' : 'auth-error';
  node.textContent = message;
  node.style.display = '';
}

let pendingTwoFactorToken: string | null = null;
let authTransition = 0;

function beginAuthTransition(): number {
  authTransition += 1;
  return authTransition;
}

function isCurrentAuthTransition(transition: number): boolean {
  return transition === authTransition;
}

function setTwoFactorStep(active: boolean): void {
  const credentials = el<HTMLElement>('login-credentials');
  const secondFactor = el<HTMLElement>('twofactor-login-form');
  if (credentials) credentials.style.display = active ? 'none' : '';
  if (secondFactor) secondFactor.style.display = active ? '' : 'none';
  if (active) el<HTMLInputElement>('l-2fa-code')?.focus();
}

export function cancelTwoFactorLogin(): void {
  beginAuthTransition();
  pendingTwoFactorToken = null;
  const code = el<HTMLInputElement>('l-2fa-code');
  if (code) code.value = '';
  setTwoFactorStep(false);
}

export async function completeTwoFactorLogin(): Promise<void> {
  const code = text('l-2fa-code');
  if (!pendingTwoFactorToken || !code) {
    showAuthMsg(t('ui_dogrulama_kodunu_girin', 'Doğrulama kodunu girin.'));
    return;
  }
  const tempToken = pendingTwoFactorToken;
  const transition = beginAuthTransition();
  setBusy('#twofactor-login-form .btn-primary', true, t('auth_verify', 'Doğrula'));
  try {
    const { response, payload } = await postAuth('/api/2fa/check', {
      tempToken,
      code,
    });
    if (!isCurrentAuthTransition(transition)) return;
    if (!response.ok) {
      showAuthMsg(authResponseText(response, t('auth_twofactor_failed', 'İki adımlı doğrulama başarısız.'), 'twoFactor'));
      return;
    }
    if (typeof payload.token !== 'string' || !isUser(payload.user)) {
      throw new AuthFlowError(t('auth_session_failed', 'Oturum kurulamadı. Lütfen tekrar dene.'));
    }
    pendingTwoFactorToken = null;
    await startApp(payload.token, payload.user, payload.stepUp);
  } catch (error) {
    if (isCurrentAuthTransition(transition)) {
      showAuthMsg(authExceptionText(error, t('auth_twofactor_failed', 'İki adımlı doğrulama başarısız.')));
    }
  } finally {
    setBusy('#twofactor-login-form .btn-primary', false, t('auth_verify', 'Doğrula'));
  }
}

export function switchAuthTab(tab: AuthTab): void {
  cancelTwoFactorLogin();
  document.querySelectorAll<HTMLElement>('.auth-tab').forEach((node, index) => {
    node.classList.toggle('active', (tab === 'login' && index === 0) || (tab === 'register' && index === 1));
  });
  const loginForm = el<HTMLElement>('login-form');
  const registerForm = el<HTMLElement>('register-form');
  if (loginForm) loginForm.style.display = tab === 'login' ? '' : 'none';
  if (registerForm) registerForm.style.display = tab === 'register' ? '' : 'none';
  const message = el<HTMLElement>('auth-msg');
  if (message) message.style.display = 'none';
}

// NOT: `label` MUTLAKA cevrilmis metin olmalidir. Bu cagrilar eskiden sabit
// `'Sign In'` / `'Create Account'` gonderiyordu; butonlar `data-i18n` ile
// cevrildigi icin, islem bitince metin INGILIZCEYE geri doniyordu.
function setBusy(selector: string, busy: boolean, label: string): void {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy
    ? (selector.includes('login') ? t('auth_signing_in', 'Giriş yapılıyor…') : t('auth_creating_account', 'Hesap oluşturuluyor…'))
    : label;
}

async function postAuth(path: string, body: Record<string, string>): Promise<{ response: Response; payload: AuthPayload }> {
  const response = await fetch(`${getAPI()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    redirect: 'error',
    body: JSON.stringify(body),
  });

  let payload: AuthPayload = {};
  try {
    payload = await response.json() as AuthPayload;
  } catch {
    // Sunucu JSON dışı hata döndürürse genel mesaj kullanılacak.
  }
  return { response, payload };
}

// Kullanici panelinin son cizildigi kullanici ve canli soket durumu (U-04). `null`: henuz
// bilinmiyor (oturum acilisi) — o anda secilen durum gosterilir, soket bagi gelince kesinlesir.
let panelUser: AuthUser | null = null;
let panelSocketLive: boolean | null = null;
if (typeof document !== 'undefined') {
  const redraw = (live: boolean) => () => {
    panelSocketLive = live;
    if (panelUser) updateUserPanel(panelUser);
  };
  document.addEventListener('bridge:socket-ready', redraw(true));
  document.addEventListener('bridge:socket-reconnected', redraw(true));
  document.addEventListener('bridge:socket-disconnected', redraw(false));
}

export function updateUserPanel(user: AuthUser): void {
  const name = typeof user.displayName === 'string' && user.displayName
    ? user.displayName
    : typeof user.username === 'string' ? user.username : t('ui_bridge_user');

  const avatar = el<HTMLElement>('my-avatar');
  const username = el<HTMLElement>('my-username');

  if (avatar) {
    avatar.textContent = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'B';
    if (typeof user.avatarColor === 'string' && user.avatarColor) {
      // Arka plan kullanıcı seçimidir; metin rengi CSS'te sabit beyazdı ve
      // açık renklerde WCAG 1.4.3'ü ihlal ediyordu (ölçüldü: #00aff4 üzerinde
      // 2.48:1). Okunabilir mürekkep arka planın parlaklığından hesaplanır.
      avatar.style.background = user.avatarColor;
      avatar.style.color = readableTextOn(user.avatarColor);
    }
  }
  // ── FAZ K1 — DOCK VARLIK DURUMU ARTIK GERCEK ──────────────────────────────
  // BULUNAN KUSUR: kabuk `#my-status-dot`u sabit `online` sinifiyla ve
  // `#my-tag`i sabit "Online" metniyle basiyordu; HICBIR kod bunlari
  // guncellemiyordu (canli olcum: /api/me `status:"offline"` donerken dock
  // yesil nokta + "Online" gosteriyordu). Kullaniciya kendi durumu hakkinda
  // YANLIS bilgi veriliyordu.
  //
  // Artik tek kaynak sunucudan gelen kullanicidir. Ozel durum metni varsa
  // (statusEmoji/statusText — sema: users.statusText/statusEmoji) ikinci
  // satirda o gosterilir; yoksa gercek varlik etiketi yazilir.
  const PRESENCE_LABEL: Record<string, string> = {
    online:  t('presence_online', 'Çevrimiçi'),
    idle:    t('presence_idle', 'Boşta'),
    dnd:     t('presence_dnd', 'Rahatsız etmeyin'),
    offline: t('presence_offline', 'Çevrimdışı'),
  };
  // Final21 UX (U-04): `user.status` bir HTTP YANITININ ANLIK GÖRÜNTÜSÜDÜR. Sunucu oluşturma
  // soketi kısa süreliğine kapatıp açıyor; aradaki `/api/me` yanıtı `status: offline` döndü
  // ve panel, üye listesi kullanıcıyı çevrimiçi gösterirken, yeniden yüklemeye dek
  // "Çevrimdışı" kaldı (ölçüldü: tools/ux/probe-self-presence.cjs). Panel artık canlı
  // bağlantıya bağlıdır: bağlıyken kullanıcının SEÇTİĞİ durum (presenceStatus), bağlantı
  // yokken çevrimdışı. Seçim yoksa (eski yanıt) anlık görüntüye düşülür.
  panelUser = user;
  const chosen = typeof user.presenceStatus === 'string' && user.presenceStatus in PRESENCE_LABEL
    ? user.presenceStatus
    : typeof user.status === 'string' && user.status in PRESENCE_LABEL ? user.status : 'offline';
  const status = panelSocketLive === false ? 'offline' : chosen;

  const dot = el<HTMLElement>('my-status-dot');
  if (dot) {
    dot.classList.remove('online', 'idle', 'dnd', 'offline');
    dot.classList.add(status);
    dot.dataset.status = status;
  }

  const tag = el<HTMLElement>('my-tag');
  if (tag) {
    const emoji = typeof user.statusEmoji === 'string' ? user.statusEmoji.trim() : '';
    const text  = typeof user.statusText  === 'string' ? user.statusText.trim()  : '';
    const custom = [emoji, text].filter(Boolean).join(' ');
    const label = PRESENCE_LABEL[status]!;
    tag.textContent = custom || label;
    // Ozel durum gosteriliyorsa gercek varlik yine de erisilebilir kalmali.
    tag.title = custom ? `${custom} — ${label}` : label;
  }

  if (username) {
    username.textContent = name;
    // CANLI OLCUM (1366/1536/1920 hepsinde ayni): kimlik sutununa yalnizca
    // ~48px kaliyor (avatar + dort kontrol 255px'lik paneli paylasiyor), oysa
    // ornek ad 121px istiyor. Ad ellipsis ile kesiliyor ve TAM HALI HICBIR
    // YERDE GORULEMIYORDU. Duzen riski almadan adi geri kazandirmak icin
    // yerel baslik (tooltip) verilir.
    username.title = name;
  }
}

export async function startApp(token: string, user: AuthUser, stepUp?: unknown): Promise<void> {
  if (!token || !isUser(user)) throw new Error('Geçersiz oturum yanıtı.');

  // P7 B2: a fresh sign-in is a fresh proof — its step-up grants are held in
  // memory for their short lifetime. A restored session (page reload) carries
  // none, and any grant of an earlier session is dropped either way.
  rememberSignInGrants(stepUp);

  // Any successfully validated session supersedes pending restore/login work.
  beginAuthTransition();
  // Yeni oturum: bir sonraki gerçek süre dolumu yine temiz bir çıkış yapabilsin.
  _loggingOut = false;

  saveToken(token);
  updateUserPanel(user);

  (globalThis as Record<string, unknown>).currentUser = user;
  (globalThis as Record<string, unknown>).me = user;

  // Faz 8.2: AppState tek durum sahibidir ama `setMe` HİÇ çağrılmıyordu —
  // `getMe()` production'da her zaman null dönüyordu. Kullanıcı bazlı taslak
  // izolasyonu (ve onboarding anahtarı) doğru kimliği buradan alır.
  BridgeRegistry.call('setMe', user);

  const authScreen = el<HTMLElement>('auth-screen');
  const app = el<HTMLElement>('app');
  if (authScreen) authScreen.style.display = 'none';
  if (app) app.style.display = 'flex';

  document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: user }));
}

export async function login(): Promise<void> {
  const username = text('l-username');
  const password = el<HTMLInputElement>('l-password')?.value ?? '';
  if (!username || !password) {
    showAuthMsg(t('adm_all_required'));
    return;
  }

  const transition = beginAuthTransition();
  setBusy('#login-form .btn-primary', true, t('sign_in'));
  try {
    const { response, payload } = await postAuth('/api/login', { username, password });
    if (!isCurrentAuthTransition(transition)) return;
    if (response.status === 202 && payload.requiresTwoFactor === true && typeof payload.tempToken === 'string') {
      pendingTwoFactorToken = payload.tempToken;
      setTwoFactorStep(true);
      showAuthMsg(t('auth_enter_2fa_or_backup', 'Doğrulama uygulamanızdaki kodu veya yedek kodu girin.'), 'success');
      return;
    }
    if (!response.ok) {
      showAuthMsg(authResponseText(response, t('auth_login_failed', 'Giriş başarısız.'), 'login'));
      return;
    }
    if (typeof payload.token !== 'string' || !isUser(payload.user)) {
      throw new AuthFlowError(t('auth_session_failed', 'Oturum kurulamadı. Lütfen tekrar dene.'));
    }
    await startApp(payload.token, payload.user, payload.stepUp);
  } catch (error) {
    if (isCurrentAuthTransition(transition)) {
      showAuthMsg(authExceptionText(error, t('auth_connection_failed', 'Sunucuya bağlanılamadı. İnternet bağlantını kontrol edip tekrar dene.')));
    }
  } finally {
    setBusy('#login-form .btn-primary', false, t('sign_in'));
  }
}

/** Anahtarlar LİTERAL kalır: i18n kullanım kapısı her anahtarın kaynakta görünmesini ister. */
function registrationProblemText(problem: RegistrationProblem): string {
  switch (problem) {
    case 'username_length': return t('auth_err_username_length');
    case 'username_chars':  return t('auth_err_username_chars');
    case 'password_short':  return t('auth_err_password_short');
    case 'password_long':   return t('auth_err_password_long');
  }
}

export async function register(): Promise<void> {
  const username = text('r-username');
  const displayName = text('r-displayname');
  const password = el<HTMLInputElement>('r-password')?.value ?? '';
  if (!username || !password) {
    showAuthMsg(t('adm_all_required'));
    return;
  }
  // Sunucunun kuralları istek atılmadan denetlenir ve HANGİ kuralın ihlal edildiği
  // söylenir. Eskiden form "min. 6" diyor, sunucu 8'in altını reddediyordu ve kişi yalnız
  // "Kayıt bilgileri geçersiz" görüyordu (Final21 Faz 18, canlı doğrulandı).
  const problem = registrationProblem(username, password);
  if (problem) {
    showAuthMsg(registrationProblemText(problem));
    return;
  }

  const transition = beginAuthTransition();
  setBusy('#register-form .btn-primary', true, t('create_account'));
  try {
    const { response, payload } = await postAuth('/api/register', { username, password, displayName });
    if (!isCurrentAuthTransition(transition)) return;
    if (!response.ok) {
      showAuthMsg(authResponseText(response, t('auth_register_failed', 'Kayıt oluşturulamadı.'), 'register'));
      return;
    }
    if (typeof payload.token !== 'string' || !isUser(payload.user)) {
      throw new AuthFlowError(t('auth_session_failed', 'Oturum kurulamadı. Lütfen tekrar dene.'));
    }
    await startApp(payload.token, payload.user, payload.stepUp);
  } catch (error) {
    if (isCurrentAuthTransition(transition)) {
      showAuthMsg(authExceptionText(error, t('auth_connection_failed', 'Sunucuya bağlanılamadı. İnternet bağlantını kontrol edip tekrar dene.')));
    }
  } finally {
    setBusy('#register-form .btn-primary', false, t('create_account'));
  }
}

// ── ÇIKIŞ İDEMPOTANLIĞI — TEK OTURUM, TEK GEÇİŞ ─────────────────────────────
// CANLI GÖZLEM (denetim): oturum süresi dolduğunda konsol bir HATA FIRTINASI
// üretiyordu — "çıkış yapılıyor" ~10 kez, kanal listesi mount hatası ~8 kez.
// KÖK NEDEN: `api-fetch.ts` içindeki `refreshAccessToken()` tek-uçuşlu (doğru),
// ama refresh başarısız olunca UÇUŞTAKİ HER 401 çağıranı ayrı ayrı `logout()`
// çağırıyor. `logout()` idempotent değildi: her çağrı bir `POST /api/logout`,
// bir `bridge:auth-logout` olayı (dinleyicilerde ardışık temizlik), DOM takası
// ve `switchAuthTab` yürütüyordu. N eşzamanlı 401 → N tam çıkış → fırtına.
// Çözüm: çıkış tek seferliktir. Bayrak yeni oturum kurulunca (`startApp`)
// sıfırlanır; böylece sonraki gerçek bir süre dolumu yine temiz çalışır.
let _loggingOut = false;

/** Test/kurtarma için görünür sıfırlama (yalnızca `startApp` çağırır). */
export function resetLogoutGuard(): void { _loggingOut = false; }

export function logout(): void {
  // Aynı oturum için ikinci ve sonraki çağrılar sessizce yok sayılır.
  if (_loggingOut) return;
  _loggingOut = true;
  // Çıkıştan sonra gelen soket olayı önceki kullanıcıyı panele yeniden çizmesin (U-04).
  panelUser = null;
  panelSocketLive = null;

  beginAuthTransition();
  // ══════════════════════════════════════════════════════════════════════
  // P4 — ÇIKIŞ OTURUMU GERÇEKTEN BİTİRİR
  // ══════════════════════════════════════════════════════════════════════
  // Yenileme çerezi `/api/refresh` yoluna kapsamlıdır; tarayıcı onu
  // `/api/logout`a HİÇ göndermez. O uç 307 ile `/api/refresh/logout`a
  // yönlendirir; ama bu istek `redirect: 'error'` taşıdığı için yönlendirme
  // izlenmiyordu (servis çalışanı altında 503 "çevrimdışı" dönüyordu).
  // ÖLÇÜLDÜ (gerçek Chromium): çıkıştan sonra `/api/refresh` → 200 — oturum
  // yaşıyordu. İstek artık doğrudan kapsamlı uca gider. Gövde, bu kurulumun
  // push hedeflerini adlandırır; sunucu yalnızca oturumun KENDİ kullanıcısına
  // ait olanları siler (bkz. server/routes/auth.ts endPushForInstallation).
  void fetch(`${getAPI()}/api/refresh/logout`, {
    method: 'POST', credentials: 'include', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ push: pushTargetsForLogout() }),
  }).catch(() => {});
  clearToken();

  // Faz 8.2: oturum kimliği bırakılır ve çıkış duyurulur. Öncesinde hiçbir
  // olay yayınlanmıyordu; taslak gibi kullanıcıya özel görünür durumlar
  // ekranda kalıp bir sonraki kullanıcıya sızabiliyordu.
  (globalThis as Record<string, unknown>).currentUser = null;
  (globalThis as Record<string, unknown>).me = null;
  BridgeRegistry.call('setMe', null);

  const app = el<HTMLElement>('app');
  const authScreen = el<HTMLElement>('auth-screen');
  if (app) app.style.display = 'none';
  if (authScreen) authScreen.style.display = '';

  switchAuthTab('login');
  document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
}

async function restoreSession(): Promise<void> {
  const token = readToken();
  if (!token) return;
  const transition = authTransition;

  try {
    // Faz 7: ham fetch yerine apiFetch — access token süresi dolmuşsa (15 dk)
    // refresh cookie'si ile yenileyip isteği bir kez tekrarlar. Eskiden 401
    // alınca token siliniyordu ve kullanıcı geçerli oturumu varken giriş
    // ekranına düşüyordu. Dinamik import: api-fetch.ts bu modülü import ettiği
    // için statik import döngü yaratırdı.
    const { apiFetch } = await import('./api-fetch.ts');
    let response = await apiFetch(`${getAPI()}/api/me`, { redirect: 'error' });
    if (!isCurrentAuthTransition(transition)) return;

    // ══════════════════════════════════════════════════════════════════════
    // KAPATILAN GERÇEK KUSUR — GEÇİCİ HATA "ÇIKIŞ YAPILMIŞ" GİBİ GÖRÜNÜYORDU
    // ══════════════════════════════════════════════════════════════════════
    // Burada koşulsuz `if (!response.ok) return;` vardı. `return` demek
    // `startApp` HİÇ çağrılmaz demektir; kullanıcı GEÇERLİ bir token'ı varken
    // giriş ekranında kalır.
    //
    // 401/403 için bu doğrudur — `apiFetch` zaten `logout()` çağırmıştır.
    // Ama 429 (hız sınırı) ve 5xx GEÇİCİDİR ve oturumun bittiği anlamına
    // GELMEZ. Kullanıcı yalnızca beklemelidir.
    //
    // ÖLÇÜLDÜ (gerçek tarayıcı): açılışta `/api/servers`, `/api/dm` ve
    // `/api/rtc/ice-config` 429 döndüğünde sayfa "Giriş Yap / Hesap Oluştur"
    // ekranını gösterdi; `#app` `display:none` kaldı ve `localStorage`da
    // geçerli token DURUYORDU.
    //
    // Bu, daha önce `EmptyServerStart` içinde kapatılan kusurla AYNI sınıftır:
    // başarısız bir istek, olumsuz bir GERÇEK sanılıyordu.
    const TRANSIENT_RETRIES = 3;
    for (let attempt = 0; attempt < TRANSIENT_RETRIES && !response.ok; attempt++) {
      const transient = response.status === 429 || response.status >= 500;
      if (!transient) break;
      // Hız sınırı penceresine saygı: artan bekleme.
      const waitMs = 1_000 * Math.pow(2, attempt);
      log.warn(`Oturum doğrulaması geçici olarak başarısız (${response.status}) — `
        + `${waitMs} ms sonra yeniden denenecek`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      if (!isCurrentAuthTransition(transition)) return;
      response = await apiFetch(`${getAPI()}/api/me`, { redirect: 'error' });
      if (!isCurrentAuthTransition(transition)) return;
    }

    // Yenileme de başarısızsa apiFetch zaten logout() çağırmıştır.
    if (!response.ok) return;

    const payload = await response.json() as unknown;
    const user = isRecord(payload) && isUser(payload.user)
      ? (payload as { user: AuthUser }).user
      : payload;

    // Yenileme olduysa depodaki token güncellenmiştir.
    if (isUser(user) && isCurrentAuthTransition(transition)) {
      await startApp(readToken() ?? token, user);
    }
  } catch (error) {
    log.warn('Oturum geri yüklenemedi', error);
  }
}

/**
 * Completes the one-time server-side SSO handoff.
 *
 * Provider callbacks deliberately put no bearer token in the URL. The
 * short-lived HttpOnly handoff cookie is consumed by exactly one POST, then we
 * resolve `/api/me` with the returned access token and enter the same
 * `startApp` path used by password, 2FA and passkey login.
 *
 * @returns true when this document is the callback route (success or handled
 * failure), false on every ordinary application route.
 */
export async function consumeSsoSessionHandoff(): Promise<boolean> {
  const callbackPath = window.location.pathname.replace(/\/+$/, '') || '/';
  if (callbackPath !== '/sso-callback') return false;
  const transition = beginAuthTransition();

  try {
    // This endpoint is single-use. In particular, never auto-retry a 401: the
    // server consumes invalid/replayed handoffs on the first POST as well.
    const response = await fetch(`${getAPI()}/api/sso/session`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'include',
      redirect: 'error',
    });
    if (!isCurrentAuthTransition(transition)) return true;
    let payload: AuthPayload = {};
    try { payload = await response.json() as AuthPayload; } catch { /* generic error below */ }

    if (!response.ok) {
      showAuthMsg(authResponseText(response, t('auth_sso_complete_failed', 'SSO oturumu tamamlanamadı. Lütfen yeniden deneyin.'), 'sso'));
      return true;
    }
    if (typeof payload.token !== 'string' || !payload.token) {
      throw new AuthFlowError(t('auth_sso_session_failed', 'SSO oturumu kurulamadı. Lütfen yeniden giriş yap.'));
    }

    const token = payload.token;
    const meResponse = await fetch(`${getAPI()}/api/me`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'include',
      redirect: 'error',
    });
    if (!isCurrentAuthTransition(transition)) return true;

    let mePayload: unknown = null;
    try { mePayload = await meResponse.json() as unknown; } catch { /* validated below */ }
    if (!meResponse.ok) {
      throw new ApiResponseError(meResponse);
    }
    const user = isRecord(mePayload) && isUser(mePayload.user)
      ? (mePayload as { user: AuthUser }).user
      : mePayload;
    if (!isUser(user)) {
      throw new AuthFlowError(t('auth_sso_user_unverified', 'SSO kullanıcı oturumu doğrulanamadı.'));
    }

    if (!isCurrentAuthTransition(transition)) return true;
    await startApp(token, user, payload.stepUp);
    return true;
  } catch (error) {
    showAuthMsg(authExceptionText(error, t('auth_sso_complete_failed_short', 'SSO oturumu tamamlanamadı.')));
    return true;
  } finally {
    // The handoff is consumed even on failure. Remove the callback path so a
    // reload does not present a stale/replay-looking URL or repeat the POST.
    window.history.replaceState(null, '', '/');
  }
}


// ── Final21 UX (U-01): hesap kurtarma ─────────────────────────────────────────
// Sunucuda şifre sıfırlama vardı (`/api/email/forgot`, `/api/email/reset-password`) ama
// istemcide HİÇBİR giriş noktası yoktu: girişte "şifremi unuttum" yoktu, e-postadaki
// `/reset-password?token=…` bağlantısı API 404 JSON'una düşüyordu ve kullanıcının e-posta
// ekleyebileceği bir yer de yoktu. Şifresini unutan herkes hesabını KAYBEDİYORDU.
type RecoveryView = 'none' | 'forgot' | 'reset';
let resetToken: string | null = null;

function setRecoveryView(view: RecoveryView): void {
  const show = (id: string, visible: boolean) => { const node = el<HTMLElement>(id); if (node) node.style.display = visible ? '' : 'none'; };
  show('login-credentials', view === 'none');
  show('forgot-form', view === 'forgot');
  show('reset-form', view === 'reset');
  const tabs = document.querySelector<HTMLElement>('.auth-tabs');
  if (tabs) tabs.style.display = view === 'none' ? '' : 'none';
  const message = el<HTMLElement>('auth-msg');
  if (message) message.style.display = 'none';
  const focusId = view === 'forgot' ? 'f-email' : view === 'reset' ? 'rp-password' : 'l-username';
  el<HTMLInputElement>(focusId)?.focus();
}

export function openForgotPassword(): void {
  switchAuthTab('login');
  setRecoveryView('forgot');
}

function leaveRecovery(): void {
  if (resetToken || window.location.pathname === '/reset-password') {
    resetToken = null;
    window.history.replaceState(null, '', '/');
  }
  setRecoveryView('none');
}

export async function sendResetLink(): Promise<void> {
  const email = text('f-email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showAuthMsg(t('auth_forgot_invalid', 'Geçerli bir e-posta adresi gir.'));
    return;
  }
  const button = document.querySelector<HTMLButtonElement>('#forgot-form .btn-primary');
  if (button) button.disabled = true;
  try {
    const { response } = await postAuth('/api/email/forgot', { email });
    // Sunucu yanıtı adres kayıtlı olsa da olmasa da AYNIDIR (hesap var mı sızdırılmaz);
    // kullanıcıya da aynı, dürüst mesaj gösterilir.
    if (!response.ok) { showAuthMsg(authResponseText(response, t('auth_service_unavailable', 'Kimlik doğrulama hizmeti şu anda kullanılamıyor. Birazdan tekrar dene.'), 'recovery')); return; }
    showAuthMsg(t('auth_forgot_sent', 'Bu adres doğrulanmış bir hesaba aitse sıfırlama bağlantısı gönderildi (1 saat geçerli). Kurtarma e-postası eklemediysen bu Bridge sunucusunun yöneticisine başvur.'), 'success');
  } catch (error) {
    showAuthMsg(authExceptionText(error, t('auth_service_unavailable', 'Kimlik doğrulama hizmeti şu anda kullanılamıyor. Birazdan tekrar dene.')));
  } finally {
    if (button) button.disabled = false;
  }
}

export async function saveNewPassword(): Promise<void> {
  const password = el<HTMLInputElement>('rp-password')?.value ?? '';
  // Sunucuyla aynı sınırlar (routes/email.ts): 8–128 karakter.
  if (password.length < 8) { showAuthMsg(t('auth_err_password_short', 'Şifre en az 8 karakter olmalı.')); return; }
  if (password.length > 128) { showAuthMsg(t('auth_err_password_long', 'Şifre en fazla 128 karakter olabilir.')); return; }
  if (!resetToken) {
    showAuthMsg(t('auth_reset_invalid', 'Bu bağlantı geçersiz ya da süresi dolmuş. Yeni bir sıfırlama bağlantısı iste.'));
    return;
  }
  const button = document.querySelector<HTMLButtonElement>('#reset-form .btn-primary');
  if (button) button.disabled = true;
  try {
    const { response } = await postAuth('/api/email/reset-password', { token: resetToken, newPassword: password });
    if (!response.ok) {
      showAuthMsg(response.status === 400
        ? t('auth_reset_invalid', 'Bu bağlantı geçersiz ya da süresi dolmuş. Yeni bir sıfırlama bağlantısı iste.')
        : authResponseText(response, t('auth_service_unavailable', 'Kimlik doğrulama hizmeti şu anda kullanılamıyor. Birazdan tekrar dene.'), 'recovery'));
      return;
    }
    const input = el<HTMLInputElement>('rp-password');
    if (input) input.value = '';
    leaveRecovery();
    showAuthMsg(t('auth_reset_done', 'Şifren güncellendi. Yeni şifrenle giriş yap.'), 'success');
  } catch (error) {
    showAuthMsg(authExceptionText(error, t('auth_service_unavailable', 'Kimlik doğrulama hizmeti şu anda kullanılamıyor. Birazdan tekrar dene.')));
  } finally {
    if (button) button.disabled = false;
  }
}

/** E-postadaki sıfırlama bağlantısı: oturum geri yüklenmez, sıfırlama formu açılır. */
function consumeResetLink(): boolean {
  if (window.location.pathname !== '/reset-password') return false;
  const token = new URLSearchParams(window.location.search).get('token');
  // Jeton adres çubuğunda kalmasın (geçmiş, ekran paylaşımı); bellekte tutulur.
  window.history.replaceState(null, '', '/reset-password');
  resetToken = token && token.length <= 256 ? token : null;
  setRecoveryView('reset');
  if (!resetToken) showAuthMsg(t('auth_reset_invalid', 'Bu bağlantı geçersiz ya da süresi dolmuş. Yeni bir sıfırlama bağlantısı iste.'));
  return true;
}

/** Doğrulama bağlantısı uygulamaya `/?email=verified` ile döner. */
function consumeEmailVerifiedFlag(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('email') !== 'verified') return;
  params.delete('email');
  const rest = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
  const message = t('email_verified_toast', 'E-posta adresin doğrulandı.');
  if (BridgeRegistry.has('toast')) BridgeRegistry.call('toast', message, 'success');
  else showAuthMsg(message, 'success');
}

let authShellEventsBound = false;

function bindAuthShellEvents(): void {
  if (authShellEventsBound) return;
  authShellEventsBound = true;

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-auth-action],[data-auth-tab]') : null;
    if (!target) return;
    const tab = target.dataset.authTab;
    if (tab === 'login' || tab === 'register') { switchAuthTab(tab); return; }
    switch (target.dataset.authAction) {
      case 'login': void login(); break;
      case 'complete-2fa': void completeTwoFactorLogin(); break;
      case 'cancel-2fa': cancelTwoFactorLogin(); break;
      case 'register': void register(); break;
      case 'forgot': openForgotPassword(); break;
      case 'forgot-send': void sendResetLink(); break;
      case 'reset-save': void saveNewPassword(); break;
      case 'recovery-back': leaveRecovery(); break;
      case 'passkey-login': {
        const api = (globalThis as typeof globalThis & { BridgeWebAuthn?: { passkeyLogin?: () => unknown } }).BridgeWebAuthn;
        void api?.passkeyLogin?.();
        break;
      }
      case 'passkey-register': {
        const api = (globalThis as typeof globalThis & { BridgeWebAuthn?: { registerPasskey?: () => unknown } }).BridgeWebAuthn;
        void api?.registerPasskey?.();
        break;
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    switch (target?.dataset.authEnter) {
      case 'login': void login(); break;
      case 'complete-2fa': void completeTwoFactorLogin(); break;
      case 'register': void register(); break;
      case 'forgot-send': void sendResetLink(); break;
      case 'reset-save': void saveNewPassword(); break;
    }
  });
}

async function bootstrapAuthentication(): Promise<void> {
  if (consumeResetLink()) return;
  if (!await consumeSsoSessionHandoff()) await restoreSession();
  consumeEmailVerifiedFlag();
}

Object.assign(globalThis as Record<string, unknown>, {
  switchAuthTab,
  showAuthMsg,
  login,
  completeTwoFactorLogin,
  cancelTwoFactorLogin,
  register,
  logout,
  startApp,
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { bindAuthShellEvents(); void bootstrapAuthentication(); }, { once: true });
} else {
  bindAuthShellEvents();
  void bootstrapAuthentication();
}
