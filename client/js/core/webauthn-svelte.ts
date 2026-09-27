// client/js/core/webauthn-svelte.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KANONIK WEBAUTHN / PASSKEY SAHIBI
// ════════════════════════════════════════════════════════════════════════════
// NEDEN YENI DOSYA — eski `js/webauthn.ts` NEDEN DIRILTILMEDI
// ────────────────────────────────────────────────────────────────────────────
// Kabuk (`index.html`) iki GORUNUR passkey dugmesi gosteriyor ve sunucu
// WebAuthn'i tam destekliyor (6 rota, mount edilmis, iki test dosyasi). Ama
// `js/webauthn.ts` HICBIR giris noktasindan import edilmiyordu: dugmeler
// `ReferenceError` uretip sessizce hicbir sey yapmiyordu.
//
// O dosya OLDUGU GIBI paketlenemezdi; olculen sorunlar:
//   * dugme etiketlerinde mojibake (cift kodlanmis emoji)
//   * tanimsiz `showToast` cagrisi (kendi `showPasskeyToast` yardimcisi
//     dururken)
//   * `injectPasskeyLoginButton()` ile IKINCI bir passkey dugmesi enjekte
//     etmesi — kabukta zaten sabit iki dugme varken
//   * `usernameEl?.value` gibi tip guvenli olmayan eski kalintilar
//
// Bu yuzden yetenek KANONIK mimariye yeniden yazildi:
//   * tek sahip, ikinci bir auth mimarisi yok
//   * dugme ENJEKSIYONU YOK — kabuktaki mevcut dugmeler tek giristir
//   * oturum kurulumu `auth-compat.startApp` ile yapilir (ayri oturum yolu yok)
//   * hata bildirimi `showAuthMsg` ile (giris ekraninin kanonik kanali)
//
// ── SUNUCU SOZLESMESI (routes/webauthn.ts) ──────────────────────────────────
//   POST /api/webauthn/register/begin     (kimlikli)  -> options
//   POST /api/webauthn/register/complete  (kimlikli)  { credential, name }
//   POST /api/webauthn/login/begin                    { username }
//   POST /api/webauthn/login/complete                 { credential }
//        -> { ok, token, user } + httpOnly bridge_refresh cookie
// Tum ikili alanlar base64url dizeleridir.

import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
import { getAPI } from './globals.ts';
import { apiFetch } from './api-fetch.ts';
import { showAuthMsg, startApp } from './auth-compat.ts';
import { safeApiErrorMessage } from './api-error.ts';
import { t } from './i18n/index.ts';

const log = createLogger('WebAuthn');
const API = getAPI();
let registrationInFlight = false;
let loginInFlight = false;

// ── base64url <-> ArrayBuffer ───────────────────────────────────────────────
// WebAuthn API ikili veri ister; sunucu base64url dizeleri konusur.

function b64uToBuf(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function bufToB64u(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Destek tespiti ──────────────────────────────────────────────────────────

export function isSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential === 'function'
    && typeof navigator !== 'undefined'
    && Boolean(navigator.credentials?.create)
    && Boolean(navigator.credentials?.get);
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isSupported()) return false;
  try {
    const fn = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    return typeof fn === 'function' ? await fn.call(window.PublicKeyCredential) : false;
  } catch { return false; }
}

// ── Hata metni ──────────────────────────────────────────────────────────────
// Kullaniciya YAPILABILIR bir sey soylenir; ham DOMException adi degil.

class PasskeyFlowError extends Error {
  constructor(message: string) { super(message); this.name = 'PasskeyFlowError'; }
}

function hataMetni(err: unknown): string {
  const ad = (err as { name?: string })?.name ?? '';
  if (ad === 'NotAllowedError')   return t('passkey_cancelled_or_timed_out', 'Passkey isteği iptal edildi veya zaman aşımına uğradı.');
  if (ad === 'InvalidStateError') return t('passkey_already_registered', 'Bu cihaz için zaten bir passkey kayıtlı.');
  if (ad === 'SecurityError')     return t('passkey_security_error', 'Passkey bu adres için kullanılamıyor.');
  if (ad === 'AbortError')        return t('passkey_cancelled', 'Passkey isteği iptal edildi.');
  if (err instanceof PasskeyFlowError) return err.message;
  return safeApiErrorMessage(err, t('passkey_action_failed', 'Passkey işlemi tamamlanamadı.'), { report: true });
}

/** Sunucu gövdesini güvenle okur; HTML/boş yanıt JSON gibi ayrıştırılmaz. */
async function govde(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown>; }
  catch { return {}; }
}

// ── KAYIT ───────────────────────────────────────────────────────────────────

export async function registerPasskey(name?: string): Promise<boolean> {
  if (!isSupported()) {
    showAuthMsg(t('passkey_unsupported', 'Bu tarayıcı passkey desteklemiyor.'));
    return false;
  }
  if (registrationInFlight) {
    showAuthMsg(t('passkey_registration_busy', 'Bir passkey kaydı zaten devam ediyor.'));
    return false;
  }
  registrationInFlight = true;
  try {
    const baslaRes = await apiFetch(`${API}/api/webauthn/register/begin`, {
      method: 'POST', redirect: 'error',
    });
    const opts = await govde(baslaRes as unknown as Response);
    if (!baslaRes.ok) {
      showAuthMsg(safeApiErrorMessage(baslaRes, t('passkey_registration_start_failed', 'Passkey kaydı başlatılamadı.'), { report: true }));
      return false;
    }
    if (typeof opts.challenge !== 'string') {
      throw new PasskeyFlowError(t('passkey_invalid_server_request', 'Sunucu geçerli bir passkey isteği döndürmedi.'));
    }

    const hariclenen = Array.isArray(opts.excludeCredentials) ? opts.excludeCredentials : [];
    const publicKey: PublicKeyCredentialCreationOptions = {
      challenge: b64uToBuf(opts.challenge),
      rp: opts.rp as PublicKeyCredentialRpEntity,
      user: {
        ...(opts.user as { name: string; displayName: string }),
        id: b64uToBuf((opts.user as { id: string }).id),
      },
      pubKeyCredParams: opts.pubKeyCredParams as PublicKeyCredentialParameters[],
      timeout: typeof opts.timeout === 'number' ? opts.timeout : 60_000,
      attestation: opts.attestation as AttestationConveyancePreference,
      authenticatorSelection: opts.authenticatorSelection as AuthenticatorSelectionCriteria,
      excludeCredentials: hariclenen.map((c) => ({
        type: 'public-key' as const,
        id: b64uToBuf((c as { id: string }).id),
        transports: (c as { transports?: AuthenticatorTransport[] }).transports,
      })),
    };

    const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyFlowError(t('passkey_create_failed', 'Passkey oluşturulamadı.'));
    const resp = cred.response as AuthenticatorAttestationResponse;

    const tamamRes = await apiFetch(`${API}/api/webauthn/register/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      body: JSON.stringify({
        name,
        credential: {
          id: cred.id,
          authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
          response: {
            clientDataJSON: bufToB64u(resp.clientDataJSON),
            attestationObject: bufToB64u(resp.attestationObject),
            transports: typeof resp.getTransports === 'function' ? resp.getTransports() : [],
          },
        },
      }),
    });
    // Registration has no session payload to consume; the body is still drained
    // so a keep-alive connection is not left with an unread response.
    await govde(tamamRes as unknown as Response);
    if (!tamamRes.ok) {
      showAuthMsg(safeApiErrorMessage(tamamRes, t('passkey_verification_failed', 'Passkey doğrulanamadı.'), { report: true }));
      return false;
    }
    showAuthMsg(t('passkey_saved', 'Passkey kaydedildi.'), 'success');
    log.info('passkey kaydedildi');
    return true;
  } catch (err) {
    log.warn('passkey kaydı başarısız', err);
    showAuthMsg(hataMetni(err));
    return false;
  } finally {
    registrationInFlight = false;
  }
}

// ── GIRIS ───────────────────────────────────────────────────────────────────

export async function passkeyLogin(username?: string | null): Promise<boolean> {
  if (!isSupported()) {
    showAuthMsg(t('passkey_unsupported', 'Bu tarayıcı passkey desteklemiyor.'));
    return false;
  }
  if (loginInFlight) {
    showAuthMsg(t('passkey_login_busy', 'Bir passkey girişi zaten devam ediyor.'));
    return false;
  }
  loginInFlight = true;
  try {
    const baslaRes = await fetch(`${API}/api/webauthn/login/begin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      redirect: 'error',
      body: JSON.stringify({ username: username || undefined }),
    });
    const opts = await govde(baslaRes);
    if (!baslaRes.ok) {
      showAuthMsg(safeApiErrorMessage(baslaRes, t('passkey_login_start_failed', 'Passkey girişi başlatılamadı.'), { report: true }));
      return false;
    }
    if (typeof opts.challenge !== 'string') {
      throw new PasskeyFlowError(t('passkey_invalid_server_request', 'Sunucu geçerli bir passkey isteği döndürmedi.'));
    }

    const izinli = Array.isArray(opts.allowCredentials) ? opts.allowCredentials : [];
    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: b64uToBuf(opts.challenge),
      rpId: typeof opts.rpId === 'string' ? opts.rpId : undefined,
      timeout: typeof opts.timeout === 'number' ? opts.timeout : 60_000,
      userVerification: (opts.userVerification as UserVerificationRequirement) ?? 'preferred',
      allowCredentials: izinli.map((c) => ({
        type: 'public-key' as const,
        id: b64uToBuf((c as { id: string }).id),
        transports: (c as { transports?: AuthenticatorTransport[] }).transports,
      })),
    };

    const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyFlowError(t('passkey_get_failed', 'Passkey alınamadı.'));
    const resp = cred.response as AuthenticatorAssertionResponse;

    const tamamRes = await fetch(`${API}/api/webauthn/login/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      redirect: 'error',
      body: JSON.stringify({
        credential: {
          id: cred.id,
          response: {
            clientDataJSON: bufToB64u(resp.clientDataJSON),
            authenticatorData: bufToB64u(resp.authenticatorData),
            signature: bufToB64u(resp.signature),
            userHandle: bufToB64u(resp.userHandle),
          },
        },
      }),
    });
    const sonuc = await govde(tamamRes);
    if (!tamamRes.ok) {
      showAuthMsg(safeApiErrorMessage(tamamRes, t('passkey_login_verify_failed', 'Passkey girişi doğrulanamadı.'), { report: true }));
      return false;
    }

    // OTURUM KURULUMU KANONIKTIR: parola girisiyle AYNI yol kullanilir.
    // Ayri bir oturum kurma yolu, ikinci bir auth mimarisi demek olurdu.
    if (typeof sonuc.token !== 'string' || !sonuc.user) {
      throw new PasskeyFlowError(t('passkey_invalid_session', 'Sunucu geçerli bir oturum döndürmedi.'));
    }
    await startApp(sonuc.token, sonuc.user as never);
    log.info('passkey ile giriş yapıldı');
    return true;
  } catch (err) {
    log.warn('passkey girişi başarısız', err);
    showAuthMsg(hataMetni(err));
    return false;
  } finally {
    loginInFlight = false;
  }
}

// ── Kimlik bilgisi yönetimi (ayarlar yüzeyi için) ───────────────────────────

export async function listPasskeys(): Promise<unknown[]> {
  try {
    const res = await apiFetch(`${API}/api/webauthn/credentials`, { redirect: 'error' });
    const payload = await govde(res as unknown as Response);
    const list = payload.credentials ?? payload;
    return Array.isArray(list) ? list : [];
  } catch (err) {
    log.warn('passkey listesi alınamadı', err);
    return [];
  }
}

export async function deletePasskey(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const res = await apiFetch(`${API}/api/webauthn/credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      redirect: 'error',
    });
    return res.ok;
  } catch (err) {
    log.warn('passkey silinemedi', err);
    return false;
  }
}

// ── Kayıt ───────────────────────────────────────────────────────────────────
// Kabuk (`index.html`) `data-auth-action="passkey-login"`
// kullanıyor. Global köprü BU YÜZDEN vardır ve KANONIK sahibe bağlıdır —
// ölü bir global değildir. Kabuk ESM'e geçtiğinde köprü kaldırılabilir.
const API_YUZEYI = {
  isSupported,
  isPlatformAvail: isPlatformAuthenticatorAvailable,
  registerPasskey,
  passkeyLogin,
  listPasskeys,
  deletePasskey,
};

BridgeRegistry.register('BridgeWebAuthn', API_YUZEYI as unknown as (...args: unknown[]) => unknown);
(globalThis as unknown as Record<string, unknown>).BridgeWebAuthn = API_YUZEYI;

export const BridgeWebAuthn = API_YUZEYI;
