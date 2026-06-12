// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/E2ePanel.svelte
//              client/js/core/e2e-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/e2e.ts — İstemci Tarafı Uçtan Uca Şifreleme
// Web Crypto API kullanır — tüm modern tarayıcılarda çalışır
// Private key ASLA sunucuya gönderilmez, sadece IndexedDB'de kalır

'use strict';
import { BridgeRegistry } from './bridge-registry.js';
import { getMe } from './globals.js';

// ── Global bildirimler ────────────────────────────────────────────────────────
declare const API: string;
declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function toast(msg: string, type: string): void;

// ── Yardımcı fonksiyonlar (modül seviyesi — IIFE ve dışarıdan kullanılır) ────
export function bufToB64(buf: ArrayBuffer | ArrayBufferView): string {
  const ab = buf instanceof ArrayBuffer ? buf : (buf as ArrayBufferView & { buffer: ArrayBuffer }).buffer;
  return btoa(String.fromCharCode(...new Uint8Array(ab)));
}

export function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ── Tipler ───────────────────────────────────────────────────────────────────
interface E2EStatus {
  ready: boolean;
  enabled: boolean;
}

interface KeyPair {
  publicKey: string;
  privateKey: string;
}

interface EncryptedPayload {
  ct: string;
  iv: string;
  epk: string;
  v: number;
}

interface X3DHHeader {
  EK_A_pub: string;
  SPK_B_keyId: number;
  OPK_B_keyId: number | null;
}

interface X3DHSession {
  recipientId: string;
  EK_A_pub: string;
  SPK_B_keyId: number;
  OPK_B_keyId: number | null;
  IK_B: string;
  establishedAt: number;
}

interface PreKeyBundle {
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature?: string };
  oneTimePreKey?: { keyId: number; publicKey: string };
  hasBundle: boolean;
}

// ── IIFE ─────────────────────────────────────────────────────────────────────
const _BridgeE2E = (() => {
  const DB_NAME    = 'BridgeE2E';
  const DB_VERSION = 1;
  const STORE_NAME = 'keys';
  let _status: E2EStatus = { ready: false, enabled: false };

  // apiFetch — auth.js'de tanımlı global; eksikse erken hata ver
  function _apiFetch(url: string, opts?: RequestInit): Promise<Response> {
    if (typeof apiFetch !== 'function') {
      throw new Error('[E2EE] apiFetch bulunamadı — auth.js, e2e.js\'den önce yüklenmeli');
    }
    return apiFetch(url, opts);
  }

  // ── IndexedDB ──────────────────────────────────────────────
  async function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        (e.target as IDBOpenDBRequest).result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
      req.onerror   = (e) => reject((e.target as IDBOpenDBRequest).error);
    });
  }

  async function savePrivateKey(userId: string, privateKeyB64: string): Promise<void> {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ id: `pk_${userId}`, key: privateKeyB64 });
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function loadPrivateKey(userId: string): Promise<string | null> {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(`pk_${userId}`);
        req.onsuccess = () => resolve((req.result as { key?: string } | undefined)?.key ?? null);
        req.onerror   = () => resolve(null);
      });
    } catch { return null; }
  }

  async function deletePrivateKey(userId: string): Promise<void> {
    const db = await openDB();
    return new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(`pk_${userId}`);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  }

  // ── ANAHTAR ÜRETİMİ ───────────────────────────────────────
  async function generateKeyPair(): Promise<KeyPair> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const publicKeyBuf  = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyBuf = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    return { publicKey: bufToB64(publicKeyBuf), privateKey: bufToB64(privateKeyBuf) };
  }

  async function generateSigningKeyPair(): Promise<KeyPair> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicKeyBuf  = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyBuf = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    return { publicKey: bufToB64(publicKeyBuf), privateKey: bufToB64(privateKeyBuf) };
  }

  // ── ŞİFRELEME ─────────────────────────────────────────────
  async function encryptMessage(plaintext: string, recipientPublicKeyB64: string): Promise<EncryptedPayload> {
    const recipientKey = await crypto.subtle.importKey(
      'spki', b64ToBuf(recipientPublicKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
    );
    const sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: recipientKey },
      ephemeral.privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    const iv      = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ctBuf   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded);
    const ephPubBuf = await crypto.subtle.exportKey('spki', ephemeral.publicKey);
    return { ct: bufToB64(ctBuf), iv: bufToB64(iv), epk: bufToB64(ephPubBuf), v: 1 };
  }

  // ── ŞİFRE ÇÖZME ───────────────────────────────────────────
  async function decryptMessage(encrypted: EncryptedPayload, privateKeyB64: string): Promise<string> {
    const { ct, iv, epk } = encrypted;
    const myPrivateKey = await crypto.subtle.importKey(
      'pkcs8', b64ToBuf(privateKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']
    );
    const ephKey = await crypto.subtle.importKey(
      'spki', b64ToBuf(epk),
      { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: ephKey },
      myPrivateKey,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(iv) }, sharedKey, b64ToBuf(ct)
    );
    return new TextDecoder().decode(plainBuf);
  }

  // ── KURULUM ───────────────────────────────────────────────
  async function setup(userId: string): Promise<{ alreadySetup: boolean } | { success: boolean }> {
    const existing = await loadPrivateKey(userId);
    if (existing) {
      _status = { ready: true, enabled: true };
      return { alreadySetup: true };
    }
    const { publicKey, privateKey } = await generateKeyPair();
    await savePrivateKey(userId, privateKey);
    await _x3dhSave(`identity_pub_${userId}`, publicKey);
    const signingPair = await generateSigningKeyPair();
    await _x3dhSave(`signing_priv_${userId}`, signingPair.privateKey);
    await _x3dhSave(`signing_pub_${userId}`,  signingPair.publicKey);
    const res = await _apiFetch(`${API}/api/e2e/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey, algorithm: 'P-256' }),
    });
    if (!res.ok) throw new Error('Failed to register public key');
    _status = { ready: true, enabled: true };
    toast('🔑 Uçtan uca şifreleme aktif!', 'success');
    window.dispatchEvent(new CustomEvent('bridge:e2e:ready', { detail: { userId } }));
    return { success: true };
  }

  async function disable(userId: string): Promise<void> {
    await deletePrivateKey(userId);
    await _apiFetch(`${API}/api/e2e/keys`, { method: 'DELETE' });
    _status = { ready: false, enabled: false };
    toast('🔓 Şifreleme devre dışı bırakıldı', 'info');
  }

  // ── DM YARDIMCILARI ───────────────────────────────────────
  async function encryptDM(
    plaintext: string,
    recipientId: string,
    _myUserId: string,
  ): Promise<{ encrypted: false; content: string } | { encrypted: true; e2e: EncryptedPayload; content: string }> {
    if (!_status.enabled) return { encrypted: false, content: plaintext };
    const res  = await _apiFetch(`${API}/api/e2e/keys/${recipientId}`);
    const data = await res.json() as { hasKey: boolean; publicKey: string };
    if (!data.hasKey) return { encrypted: false, content: plaintext };
    const encrypted = await encryptMessage(plaintext, data.publicKey);
    return { encrypted: true, e2e: encrypted, content: '🔒 Şifreli mesaj' };
  }

  async function decryptDM(e2eData: EncryptedPayload, myUserId: string): Promise<string | null> {
    const privateKey = await loadPrivateKey(myUserId);
    if (!privateKey) return null;
    try {
      return await decryptMessage(e2eData, privateKey);
    } catch (err) {
      log.warn('[E2EE] Şifre çözme başarısız:', (err as Error).message);
      return null;
    }
  }

  // ── UI ────────────────────────────────────────────────────
  async function openE2ESettings(): Promise<void> {
    const userId = (getMe() as Record<string, unknown> | null)?.id as string | undefined;
    if (!userId) return toast('Giriş yapmanız gerekiyor', 'error');
    const existing = await loadPrivateKey(userId);
    const enabled  = !!existing;
    const modal = document.createElement('div');
    modal.id = 'e2e-settings-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:95%;">
        <h2 style="margin-bottom:4px;">🔑 Uçtan Uca Şifreleme</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">
          Mesajlarınız şifrelenir ve sadece siz ve karşı taraf okuyabilir.
          Sunucu içeriği hiçbir zaman göremez.
        </p>
        <div style="background:var(--bg-3);border-radius:8px;padding:16px;margin-bottom:16px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <span style="font-size:24px;">${enabled ? '🟢' : '⭕'}</span>
            <div>
              <div style="font-weight:700;">${enabled ? 'Aktif' : 'Devre Dışı'}</div>
              <div style="color:var(--text-muted);font-size:12px;">
                ${enabled ? "DM'leriniz şifreleniyor" : 'Şifreleme başlatılmamış'}
              </div>
            </div>
          </div>
          ${enabled ? '<div style="font-size:12px;color:var(--text-muted);background:var(--bg-2);padding:8px;border-radius:6px;">✅ Private key cihazınızda güvende<br>✅ Sunucu mesajlarınızı okuyamaz<br>✅ Her mesaj için benzersiz şifreleme (Forward Secrecy)</div>' : ''}
        </div>
        ${enabled ? `
        <div style="border-top:1px solid var(--border);padding-top:16px;margin-bottom:16px;">
          <div style="font-weight:600;margin-bottom:10px;">🗝️ Anahtar Yönetimi</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
            Private key'inizi yedekleyerek başka cihazlarda kullanabilirsiniz.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn" style="flex:1;min-width:140px;" data-bridge-action="e2e:exportKey">📥 Key'i İndir (.pem)</button>
            <label class="btn btn-secondary" style="flex:1;min-width:140px;cursor:pointer;text-align:center;">
              📤 Key'i Yükle
              <input type="file" accept=".pem,.txt" style="display:none" data-bridge-action="e2e:importKey">
            </label>
          </div>
        </div>` : ''}
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('e2e-settings-modal').remove()">Kapat</button>
          ${enabled
            ? `<button class="btn" style="background:var(--red);" data-bridge-action="e2e:disable" data-bridge-uid="${userId}">🔓 Devre Dışı Bırak</button>`
            : `<button class="btn" data-bridge-action="e2e:enable" data-bridge-uid="${userId}">🔑 Şifrelemeyi Etkinleştir</button>`
          }
        </div>
      </div>`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
  }

  async function _exportKey(): Promise<void> {
    const userId = (getMe() as Record<string, unknown> | null)?.id as string | undefined;
    if (!userId) return;
    const key = await loadPrivateKey(userId);
    if (!key) return toast('Private key bulunamadı', 'error');
    const pem = `-----BEGIN BRIDGE PRIVATE KEY-----\n${key}\n-----END BRIDGE PRIVATE KEY-----`;
    const blob = new Blob([pem], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `bridge-e2e-key-${userId.slice(-6)}.pem`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    toast('Key indirildi — güvenli bir yerde saklayın!', 'success');
  }

  async function _importKey(input: HTMLInputElement): Promise<void> {
    const userId = (getMe() as Record<string, unknown> | null)?.id as string | undefined;
    if (!userId || !input.files?.[0]) return;
    const text = await input.files[0].text();
    const b64  = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    if (!b64) return toast('Geçersiz key dosyası', 'error');
    try {
      await crypto.subtle.importKey(
        'pkcs8', b64ToBuf(b64),
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
      );
      await savePrivateKey(userId, b64);
      _status = { ready: true, enabled: true };
      toast('✅ Key başarıyla yüklendi!', 'success');
      document.getElementById('e2e-settings-modal')?.remove();
      const btn = document.getElementById('btn-e2e');
      if (btn) btn.textContent = '🔑';
    } catch {
      toast('❌ Geçersiz key — bu cihaz için üretilmiş bir Bridge key dosyası seçin', 'error');
    }
  }

  function getStatus(): E2EStatus { return _status; }

  // ── X3DH — Signal Protocol Initial Key Agreement ──────────
  const X3DH_DB_STORE = 'x3dh';
  const X3DH_DB_VER   = 2;

  async function _openX3DHDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, X3DH_DB_VER);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME))
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(X3DH_DB_STORE))
          db.createObjectStore(X3DH_DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
      req.onerror   = (e) => reject((e.target as IDBOpenDBRequest).error);
    });
  }

  async function _x3dhSave(key: string, value: unknown): Promise<void> {
    const db = await _openX3DHDB();
    const tx = db.transaction(X3DH_DB_STORE, 'readwrite');
    return new Promise<void>((res, rej) => {
      const req = tx.objectStore(X3DH_DB_STORE).put({ id: key, value });
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  async function _x3dhLoad(key: string): Promise<string | null> {
    try {
      const db = await _openX3DHDB();
      return new Promise((res) => {
        const tx  = db.transaction(X3DH_DB_STORE, 'readonly');
        const req = tx.objectStore(X3DH_DB_STORE).get(key);
        req.onsuccess = () => res((req.result as { value?: string } | undefined)?.value ?? null);
        req.onerror   = () => res(null);
      });
    } catch { return null; }
  }

  async function _ecdhBits(privateKeyB64: string, publicKeyB64: string): Promise<ArrayBuffer> {
    const privKey = await crypto.subtle.importKey(
      'pkcs8', b64ToBuf(privateKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
    );
    const pubKey = await crypto.subtle.importKey(
      'spki', b64ToBuf(publicKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    return crypto.subtle.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
  }

  async function _hkdf(inputMaterial: ArrayBuffer, info = 'BridgeX3DH-v1'): Promise<CryptoKey> {
    const ikm = await crypto.subtle.importKey(
      'raw', inputMaterial, { name: 'HKDF' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(info),
      },
      ikm,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  async function x3dhSetup(userId: string): Promise<{ ok: true }> {
    const myIdentityPrivB64 = await loadPrivateKey(userId);
    if (!myIdentityPrivB64) throw new Error('Önce E2E kurulumu yapın');

    const spkPair = await generateKeyPair();
    const otpKeys: Array<{ keyId: number; publicKey: string; _privateKey: string }> = [];
    for (let i = 0; i < 20; i++) {
      const kp = await generateKeyPair();
      otpKeys.push({ keyId: i, publicKey: kp.publicKey, _privateKey: kp.privateKey });
    }

    await _x3dhSave(`spk_priv_${userId}`, spkPair.privateKey);
    for (const k of otpKeys) {
      await _x3dhSave(`otpk_priv_${userId}_${k.keyId}`, k._privateKey);
    }

    let signature = '';
    const signingPrivB64 = await _x3dhLoad(`signing_priv_${userId}`);

    async function _signSpk(privB64: string): Promise<string> {
      const signingKey = await crypto.subtle.importKey(
        'pkcs8', b64ToBuf(privB64),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
      );
      const sigBuf = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, signingKey, b64ToBuf(spkPair.publicKey)
      );
      return bufToB64(sigBuf);
    }

    if (signingPrivB64) {
      try { signature = await _signSpk(signingPrivB64); }
      catch (e) {
        log.warn('[X3DH] Signing hatası:', (e as Error).message);
        signature = 'sign-error';
      }
    } else {
      log.warn('[X3DH] Signing key bulunamadı — yeni ECDSA key pair üretiliyor');
      const newSigning = await generateSigningKeyPair();
      await _x3dhSave(`signing_priv_${userId}`, newSigning.privateKey);
      await _x3dhSave(`signing_pub_${userId}`,  newSigning.publicKey);
      try { signature = await _signSpk(newSigning.privateKey); }
      catch (e) {
        signature = 'sign-error';
        log.warn('[X3DH] Fallback signing hatası:', (e as Error).message);
      }
    }

    const identityPublicKey = await _x3dhLoad(`identity_pub_${userId}`);
    if (!identityPublicKey) throw new Error('Identity public key bulunamadı — önce E2E setup çalıştırın');

    await _apiFetch(`${API}/api/e2e/prekeys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identityKey:    identityPublicKey,
        signedPreKey:   { keyId: 0, publicKey: spkPair.publicKey, signature },
        oneTimePreKeys: otpKeys.map(k => ({ keyId: k.keyId, publicKey: k.publicKey })),
      }),
    });

    return { ok: true };
  }

  async function x3dhSend(
    recipientId: string,
    myUserId: string,
  ): Promise<{ masterKey: CryptoKey; header: X3DHHeader } | null> {
    const res  = await _apiFetch(`${API}/api/e2e/prekeys/${recipientId}`);
    const data = await res.json() as PreKeyBundle;
    if (!data.hasBundle) return null;

    const { identityKey: IK_B, signedPreKey: SPK_B, oneTimePreKey: OPK_B } = data;
    const IK_A_priv = await loadPrivateKey(myUserId);
    if (!IK_A_priv) throw new Error('Gönderici kimlik key bulunamadı');

    const EK_A = await generateKeyPair();
    const dh1  = await _ecdhBits(IK_A_priv,      SPK_B.publicKey);
    const dh2  = await _ecdhBits(EK_A.privateKey, IK_B);
    const dh3  = await _ecdhBits(EK_A.privateKey, SPK_B.publicKey);

    let combined: Uint8Array;
    if (OPK_B) {
      const dh4 = await _ecdhBits(EK_A.privateKey, OPK_B.publicKey);
      combined = new Uint8Array([
        ...new Uint8Array(dh1), ...new Uint8Array(dh2),
        ...new Uint8Array(dh3), ...new Uint8Array(dh4),
      ]);
    } else {
      combined = new Uint8Array([
        ...new Uint8Array(dh1), ...new Uint8Array(dh2), ...new Uint8Array(dh3),
      ]);
    }

    const masterKey = await _hkdf(combined.buffer);

    const session: X3DHSession = {
      recipientId,
      EK_A_pub:      EK_A.publicKey,
      SPK_B_keyId:   SPK_B.keyId,
      OPK_B_keyId:   OPK_B?.keyId ?? null,
      IK_B,
      establishedAt: Date.now(),
    };
    await _x3dhSave(`session_${myUserId}_${recipientId}`, session);

    return {
      masterKey,
      header: { EK_A_pub: EK_A.publicKey, SPK_B_keyId: SPK_B.keyId, OPK_B_keyId: OPK_B?.keyId ?? null },
    };
  }

  async function x3dhReceive(
    senderId: string,
    myUserId: string,
    header: X3DHHeader,
  ): Promise<{ masterKey: CryptoKey }> {
    const { EK_A_pub, SPK_B_keyId, OPK_B_keyId } = header;
    const myIdentityPriv = await loadPrivateKey(myUserId);
    const mySPKPriv      = await _x3dhLoad(`spk_priv_${myUserId}`);
    if (!myIdentityPriv || !mySPKPriv) throw new Error('Alıcı prekey bulunamadı');

    const senderRes  = await _apiFetch(`${API}/api/e2e/keys/${senderId}`);
    const senderData = await senderRes.json() as { hasKey: boolean; publicKey: string };
    if (!senderData.hasKey) throw new Error('Gönderici identity key bulunamadı');

    const dh1 = await _ecdhBits(mySPKPriv,      senderData.publicKey);
    const dh2 = await _ecdhBits(myIdentityPriv, EK_A_pub);
    const dh3 = await _ecdhBits(mySPKPriv,      EK_A_pub);

    let combined: Uint8Array;
    if (OPK_B_keyId !== null) {
      const myOTPKPriv = await _x3dhLoad(`otpk_priv_${myUserId}_${OPK_B_keyId}`);
      if (!myOTPKPriv) throw new Error('One-time prekey bulunamadı (zaten kullanılmış?)');
      const dh4 = await _ecdhBits(myOTPKPriv, EK_A_pub);
      combined  = new Uint8Array([
        ...new Uint8Array(dh1), ...new Uint8Array(dh2),
        ...new Uint8Array(dh3), ...new Uint8Array(dh4),
      ]);
    } else {
      combined = new Uint8Array([
        ...new Uint8Array(dh1), ...new Uint8Array(dh2), ...new Uint8Array(dh3),
      ]);
    }

    return { masterKey: await _hkdf(combined.buffer) };
  }

  async function x3dhCheckReplenish(userId: string): Promise<void> {
    try {
      const res  = await _apiFetch(`${API}/api/e2e/prekeys/${userId}/count`);
      const data = await res.json() as { needsReplenish: boolean };
      if (data.needsReplenish) await x3dhSetup(userId);
    } catch { /* sessizce geç */ }
  }

  async function autoInit(userId: string): Promise<void> {
    const key = await loadPrivateKey(userId);
    if (key) {
      _status = { ready: true, enabled: true };
      setTimeout(() => x3dhCheckReplenish(userId), 3000);
      window.dispatchEvent(new CustomEvent('bridge:e2e:ready', { detail: { userId } }));
    }
  }

  return {
    setup, disable, encryptDM, decryptDM,
    encryptMessage, decryptMessage,
    generateKeyPair, generateSigningKeyPair,
    openE2ESettings, autoInit, getStatus,
    savePrivateKey, loadPrivateKey,
    _exportKey, _importKey,
    x3dhSetup, x3dhSend, x3dhReceive, x3dhCheckReplenish,
  };
})();

// Sprint 42: Ses E2E modülü e2e-voice.ts'e taşındı
import './e2e-voice.js';

import { createLogger } from './logger.js';
const log = createLogger('E2EE');


// BridgeRegistry kayıtları
BridgeRegistry.register('BridgeE2E', _BridgeE2E as unknown as (...a: unknown[]) => unknown);
(window as Window & { BridgeE2E: typeof _BridgeE2E }).BridgeE2E = _BridgeE2E;
