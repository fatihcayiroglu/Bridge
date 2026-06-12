// client/js/webauthn.ts
// WebAuthn / Passkey client-side yönetimi
// Face ID, Touch ID, YubiKey, Windows Hello ile giriş/kayıt
//
// KULLANIM:
//   openPasskeySettings()      — modal aç (güvenlik ayarları)
//   passkeyLogin(username)     — giriş akışını başlat
//   window.BridgeWebAuthn      — public API

'use strict';

import { BridgeRegistry } from './core/bridge-registry.ts';
import { getAPI } from './core/globals.ts';

const API = getAPI(); // Sprint 33: global API var yerine

// ── Base64URL helpers ──────────────────────────────────────────────────────────

function b64uDecode(str) {
  const pad    = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  const bin    = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function b64uEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ArrayBuffer / Uint8Array → Base64URL
function ab2b64u(ab) {
  return b64uEncode(ab instanceof ArrayBuffer ? new Uint8Array(ab) : ab);
}

// ── WebAuthn Desteği Kontrolü ──────────────────────────────────────────────────

function isWebAuthnSupported() {
  return !!(
    typeof PublicKeyCredential !== "undefined" &&
    navigator.credentials?.create &&
    navigator.credentials?.get
  );
}

async function isPlatformAuthenticatorAvailable() {
  if (!isWebAuthnSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// ── Credential kayıt (Register) ────────────────────────────────────────────────

async function registerPasskey(credentialName) {
  if (!isWebAuthnSupported()) {
    throw new Error('Bu tarayıcı WebAuthn desteklemiyor.');
  }

  // 1. Server'dan challenge al
  const beginRes = await apiFetch(`${API}/api/webauthn/register/begin`, {
    method: 'POST',
  });
  const beginData = await beginRes.json();
  if (!beginRes.ok) throw new Error(beginData.error || 'Challenge alınamadı');

  // 2. PublicKeyCredentialCreationOptions'ı hazırla
  const creationOptions = {
    challenge:  b64uDecode(beginData.challenge),
    rp:         beginData.rp,
    user: {
      id:          b64uDecode(beginData.user.id),
      name:        beginData.user.name,
      displayName: beginData.user.displayName,
    },
    pubKeyCredParams:       beginData.pubKeyCredParams,
    timeout:                beginData.timeout || 60000,
    attestation:            beginData.attestation || 'none',
    authenticatorSelection: beginData.authenticatorSelection || {},
    excludeCredentials: (beginData.excludeCredentials || []).map(c => ({
      type: c.type,
      id:   b64uDecode(c.id),
      transports: c.transports || [],
    })),
  };

  // 3. Tarayıcı credential dialog'unu aç
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: creationOptions });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('İşlem iptal edildi veya zaman aşımına uğradı.');
    if (err.name === 'InvalidStateError') throw new Error('Bu cihaz zaten kayıtlı.');
    throw new Error(`Kayıt hatası: ${err.message}`);
  }

  // 4. Server'a doğrula ve kaydet
  const completePayload = {
    credential: {
      id:   credential.id,
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      response: {
        clientDataJSON:    ab2b64u(credential.response.clientDataJSON),
        attestationObject: ab2b64u(credential.response.attestationObject),
        transports: credential.response.getTransports?.() || [],
      },
    },
    name: credentialName || null,
  };

  const completeRes = await apiFetch(`${API}/api/webauthn/register/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(completePayload),
  });
  const completeData = await completeRes.json();
  if (!completeRes.ok) throw new Error(completeData.error || 'Kayıt tamamlanamadı');

  return completeData;
}

// ── Giriş (Authenticate) ───────────────────────────────────────────────────────

async function passkeyLogin(username) {
  if (!isWebAuthnSupported()) {
    throw new Error('Bu tarayıcı WebAuthn desteklemiyor.');
  }

  // 1. Challenge al
  const beginRes = await fetch(`${API}/api/webauthn/login/begin`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username: username || null }),
  });
  const beginData = await beginRes.json();
  if (!beginRes.ok) throw new Error(beginData.error || 'Challenge alınamadı');

  // 2. PublicKeyCredentialRequestOptions hazırla
  const requestOptions = {
    challenge:        b64uDecode(beginData.challenge),
    rpId:             beginData.rpId,
    timeout:          beginData.timeout || 60000,
    userVerification: beginData.userVerification || 'preferred',
    allowCredentials: (beginData.allowCredentials || []).map(c => ({
      type: c.type,
      id:   b64uDecode(c.id),
      transports: c.transports || [],
    })),
  };

  // 3. Doğrulama dialog'u
  let assertion;
  try {
    assertion = await navigator.credentials.get({ publicKey: requestOptions });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('İşlem iptal edildi veya zaman aşımına uğradı.');
    throw new Error(`Kimlik doğrulama hatası: ${err.message}`);
  }

  // 4. Server'a doğrula
  const completePayload = {
    credential: {
      id:   assertion.id,
      type: assertion.type,
      response: {
        clientDataJSON:    ab2b64u(assertion.response.clientDataJSON),
        authenticatorData: ab2b64u(assertion.response.authenticatorData),
        signature:         ab2b64u(assertion.response.signature),
        userHandle:        assertion.response.userHandle ? ab2b64u(assertion.response.userHandle) : null,
      },
    },
  };

  const completeRes = await fetch(`${API}/api/webauthn/login/complete`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(completePayload),
  });
  const completeData = await completeRes.json();
  if (!completeRes.ok) throw new Error(completeData.error || 'Giriş doğrulanamadı');

  // 5. Token'ları kaydet ve UI'yı güncelle
  if (completeData.token) {
    localStorage.setItem('token', completeData.token);
    if (completeData.refreshToken) localStorage.setItem('refreshToken', completeData.refreshToken);

    // Normal giriş akışını tetikle
    currentUser = completeData.user;
    document.dispatchEvent(new CustomEvent('bridge:login', { detail: completeData.user }));
  }

  return completeData;
}

// ── Credential Listesi ─────────────────────────────────────────────────────────

async function listPasskeys() {
  const res  = await apiFetch(`${API}/api/webauthn/credentials`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Liste alınamadı');
  return data;
}

async function renamePasskey(id, newName) {
  const res = await apiFetch(`${API}/api/webauthn/credentials/${id}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name: newName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

async function deletePasskey(id) {
  const res = await apiFetch(`${API}/api/webauthn/credentials/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// ── Settings Modal ─────────────────────────────────────────────────────────────

async function openPasskeySettings() {
  const existing = document.getElementById('passkey-modal');
  if (existing) { existing.remove(); return; }

  const [supported, platformAvail] = await Promise.all([
    Promise.resolve(isWebAuthnSupported()),
    isPlatformAuthenticatorAvailable(),
  ]);

  const modal = document.createElement('div');
  modal.id = 'passkey-modal';
  modal.className = 'modal-overlay';

  const deviceIcon = platformAvail ? 'ğŸ”‘ Face ID / Touch ID' : 'ğŸ” Güvenlik Anahtarı';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:500px;width:95%;">
      <h2>ğŸ”‘ Passkey Yönetimi</h2>

      ${!supported ? `
        <div style="background:#3a1a1a;border:1px solid #e8432d;border-radius:8px;padding:14px;color:#e8432d;">
          âš ï¸ Bu tarayıcı WebAuthn / Passkey desteklemiyor.
        </div>
      ` : `
        <div style="background:#1e1f22;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px;color:var(--text-muted);">
          Cihaz doğrulama: <strong style="color:var(--text-normal);">${deviceIcon}</strong>
          ${platformAvail
            ? '<br>Platform doğrulayıcı mevcut — Face ID, Touch ID veya Windows Hello kullanılabilir.'
            : '<br>Harici güvenlik anahtarı (YubiKey vb.) kullanın.'}
        </div>

        <div id="passkey-list" style="margin-bottom:16px;">
          <div style="color:var(--text-muted);text-align:center;padding:20px;">Yükleniyor...</div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
          <button class="btn" id="passkey-add-btn" onclick="showAddPasskeyForm()" style="flex:1;">
            + Yeni Passkey Ekle
          </button>
        </div>

        <div id="passkey-add-form" style="display:none;background:#1e1f22;border-radius:8px;padding:14px;margin-bottom:16px;">
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:8px;">
            Cihaza anlamlı bir isim ver (ör: "iPhone 15", "YubiKey"):
          </p>
          <input id="passkey-name-input" class="input" placeholder="Cihaz adı (isteğe bağlı)"
            style="width:100%;margin-bottom:10px;" maxlength="64" />
          <div style="display:flex;gap:8px;">
            <button class="btn btn-secondary" onclick="document.getElementById('passkey-add-form').style.display='none'">İptal</button>
            <button class="btn" onclick="addNewPasskey()" style="flex:1;">
              ğŸ”‘ Kayıt Yap
            </button>
          </div>
          <div id="passkey-add-error" style="color:#e8432d;font-size:12px;margin-top:8px;display:none;"></div>
        </div>
      `}

      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('passkey-modal').remove()">Kapat</button>
      </div>
    </div>`;

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);

  if (supported) {
    await refreshPasskeyList();
  }
}

async function refreshPasskeyList() {
  const listEl = document.getElementById('passkey-list');
  if (!listEl) return;

  try {
    const creds = await listPasskeys();

    if (!creds.length) {
      listEl.innerHTML = `
        <div style="background:#1e1f22;border-radius:8px;padding:14px;text-align:center;color:var(--text-muted);font-size:13px;">
          Henüz passkey eklenmemiş.<br>
          <span style="font-size:12px;">Passkey ile şifresiz, güvenli giriş yapabilirsin.</span>
        </div>`;
      return;
    }

    listEl.innerHTML = creds.map(c => `
      <div id="passkey-item-${c.id}" style="display:flex;align-items:center;gap:10px;padding:10px;background:#1e1f22;border-radius:8px;margin-bottom:6px;">
        <div style="font-size:20px;">${getDeviceIcon(c.deviceType)}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;color:var(--text-normal);font-size:14px;">${escHtml(c.name)}</div>
          <div style="font-size:11px;color:var(--text-muted);">
            Eklendi: ${formatDate(c.createdAt)}
            ${c.lastUsedAt ? ` Â· Son kullanım: ${formatDate(c.lastUsedAt)}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-secondary" style="padding:4px 8px;font-size:12px;"
            onclick="promptRenamePasskey('${c.id}', '${escHtml(c.name).replace(/'/g, "\\'")}')">âœï¸</button>
          <button class="btn" style="padding:4px 8px;font-size:12px;background:#e8432d;"
            onclick="confirmDeletePasskey('${c.id}', '${escHtml(c.name).replace(/'/g, "\\'")}')">ğŸ—‘ï¸</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<div style="color:#e8432d;font-size:13px;">Hata: ${escHtml(String(err?.message ?? err))}</div>`;
  }
}

function getDeviceIcon(deviceType = '') {
  if (/yubikey/i.test(deviceType)) return 'ğŸ”';
  if (/iphone|ios|face id|touch id/i.test(deviceType)) return 'ğŸ“±';
  if (/android/i.test(deviceType)) return 'ğŸ¤–';
  if (/windows|hello/i.test(deviceType)) return 'ğŸ’»';
  if (/platform/i.test(deviceType)) return 'ğŸ–¥ï¸';
  return 'ğŸ”‘';
}

function showAddPasskeyForm() {
  const form = document.getElementById('passkey-add-form');
  if (form) {
    form.style.display = '';
    document.getElementById('passkey-name-input')?.focus();
  }
}

async function addNewPasskey() {
  const nameInput = document.getElementById('passkey-name-input');
  const errorEl   = document.getElementById('passkey-add-error');
  const name      = nameInput?.value?.trim() || '';

  if (errorEl) errorEl.style.display = 'none';

  const btn = document.querySelector('#passkey-add-form .btn:last-child');
  if (btn) { btn.textContent = 'Kayıt yapılıyor...'; btn.disabled = true; }

  try {
    const result = await registerPasskey(name);
    if (btn) { btn.textContent = 'ğŸ”‘ Kayıt Yap'; btn.disabled = false; }
    const formEl = document.getElementById('passkey-add-form');
    if (formEl) formEl.style.display = 'none';
    if (nameInput) nameInput.value = '';

    showToast(`✅ "${result.name}" passkey eklendi!`, 'success');
    await refreshPasskeyList();
  } catch (err) {
    if (btn) { btn.textContent = 'ğŸ”‘ Kayıt Yap'; btn.disabled = false; }
    if (errorEl) {
      errorEl.textContent = err.message;
      errorEl.style.display = '';
    }
  }
}

function promptRenamePasskey(id, currentName) {
  const newName = prompt(`Yeni isim girin:`, currentName);
  if (!newName?.trim() || newName === currentName) return;

  renamePasskey(id, newName.trim()).then(() => {
    showToast('✅ İsim güncellendi', 'success');
    refreshPasskeyList();
  }).catch(err => {
    showToast(`âŒ Hata: ${err.message}`, 'error');
  });
}

function confirmDeletePasskey(id, name) {
  if (!confirm(`"${name}" passkey'ini silmek istediğine emin misin?`)) return;

  deletePasskey(id).then(() => {
    showToast('✅ Passkey silindi', 'success');
    refreshPasskeyList();
  }).catch(err => {
    showToast(`âŒ Hata: ${err.message}`, 'error');
  });
}

// ── Giriş sayfasına Passkey butonu ekle ────────────────────────────────────────

function injectPasskeyLoginButton() {
  if (!isWebAuthnSupported()) return;

  const loginCard = document.querySelector('.login-card, .auth-card, #login-form');
  if (!loginCard || document.getElementById('passkey-login-btn')) return;

  const divider = document.createElement('div');
  divider.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0;';
  divider.innerHTML = `
    <div style="flex:1;height:1px;background:var(--border-color,#3f4147);"></div>
    <span style="font-size:12px;color:var(--text-muted);">veya</span>
    <div style="flex:1;height:1px;background:var(--border-color,#3f4147);"></div>`;

  const btn = document.createElement('button');
  btn.id        = 'passkey-login-btn';
  btn.className = 'btn btn-secondary';
  btn.style.cssText = 'width:100%;display:flex;align-items:center;justify-content:center;gap:8px;';
  btn.innerHTML = `<span style="font-size:18px;">ğŸ”‘</span> Passkey ile Giriş Yap`;
  btn.onclick   = async () => {
    const usernameEl = document.getElementById('login-username') || document.querySelector('input[name="username"]');
    const username   = usernameEl?.value?.trim() || null;

    btn.textContent = 'Bekleniyor...';
    btn.disabled    = true;

    try {
      await passkeyLogin(username);
      // bridge:login event'i tetiklenecek, normal akış devam eder
    } catch (err) {
      btn.innerHTML = `<span style="font-size:18px;">ğŸ”‘</span> Passkey ile Giriş Yap`;
      btn.disabled  = false;
      showToast(`âŒ ${err.message}`, 'error');
    }
  };

  // Submit butonundan sonra ekle
  const submitBtn = loginCard.querySelector('button[type="submit"], .btn-login, #login-btn');
  if (submitBtn) {
    submitBtn.parentNode.insertBefore(divider, submitBtn.nextSibling);
    submitBtn.parentNode.insertBefore(btn, divider.nextSibling);
  } else {
    loginCard.appendChild(divider);
    loginCard.appendChild(btn);
  }
}

// ── Yardımcı fonksiyonlar ──────────────────────────────────────────────────────

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('tr-TR', { year: 'numeric', month: 'short', day: 'numeric' });
}

// escHtml — utils.js'ten gelir, buradaki kopya kaldırıldı

// showToast — core/ui.js'de tanımlı değilse fallback
function showPasskeyToast(msg, type = 'info') {
  if (typeof showToast === 'function') return showToast(msg, type);
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:80px;right:20px;padding:10px 16px;border-radius:8px;
    background:${type==='success'?'#23a55a':type==='error'?'#e8432d':'#2d9cdb'};
    color:#fff;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.4);`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Public API ─────────────────────────────────────────────────────────────────

// Sprint 33: window.BridgeWebAuthn → BridgeRegistry
BridgeRegistry.register('BridgeWebAuthn', {
  isSupported:      isWebAuthnSupported,
  isPlatformAvail:  isPlatformAuthenticatorAvailable,
  registerPasskey,
  passkeyLogin,
  listPasskeys,
  renamePasskey,
  deletePasskey,
} as unknown as (...args: unknown[]) => unknown);

// window.BridgeWebAuthn köprüsü — index.html onclick tüketicisi var (passkeyLogin, registerPasskey).
// Sprint 81 hedefi: index.html'i BridgeRegistry.call() veya ESM import'a geçince kaldırılır.
(window as unknown as Record<string, unknown>).BridgeWebAuthn =
  BridgeRegistry.get('BridgeWebAuthn');

// Giriş sayfasında otomatik passkey butonu ekle
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(injectPasskeyLoginButton, 500);
});

// Auth event'leri dinle — giriş sayfası göründüğünde butonu ekle
document.addEventListener('bridge:show-login', () => {
  setTimeout(injectPasskeyLoginButton, 100);
});

