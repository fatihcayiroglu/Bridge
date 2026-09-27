// server/lib/e2e.ts Uçtan Uca Şifreleme (E2EE)
// Signal Protocol'dan ilham alınmıştır
// 
// MİMARİ:
//   - Her kullanıcının bir public/private anahtar çifti var
//   - Public keyler sunucuda saklanır (plaintext)
//   - Private keyler SADECE istemcide kalır (sunucuya gönderilmez)
//   - DM şifrelemesi: alıcının public key'i ile şifrele
//   - Sunucu şifreli içeriği göremez
//
// KULLANIM (client-side):
//   const { generateKeyPair, encryptMessage, decryptMessage } = window.BridgeE2E;

import express from 'express';
const router  = express.Router();
import { Users } from '../db/repositories';
import { authMiddleware } from '../middleware/auth';
import { evaluateDmAccess } from './dmAccessPolicy';

const E2E_ALGORITHMS = new Set(['X25519', 'P-256']);
const MAX_KEY_ID = 2_147_483_647;

function validKeyId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_KEY_ID;
}

function validBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validSignedPreKey(value: unknown): value is { keyId: number; publicKey: string; signature: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every((key) => ['keyId', 'publicKey', 'signature'].includes(key)) &&
    validKeyId(v.keyId) && validBoundedString(v.publicKey, 256) && validBoundedString(v.signature, 512);
}

function validOneTimePreKey(value: unknown): value is { keyId: number; publicKey: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every((key) => ['keyId', 'publicKey'].includes(key)) &&
    validKeyId(v.keyId) && validBoundedString(v.publicKey, 256);
}
// SUNUCU TARAFI: Sadece public key saklama/alma
// Private key asla sunucuya gelmez
// ─────────────────────────────────────────────────────────────

// POST /api/e2e/keys — kullanıcının public key'ini kaydet
router.post('/keys', authMiddleware, async (req, res) => {
  const { publicKey, keyVersion = 1, algorithm = 'X25519' } = req.body;
  if (!publicKey) return res.status(400).json({ error: 'publicKey required' });
  if (!validBoundedString(publicKey, 200))
    return res.status(400).json({ error: 'Invalid publicKey format' });
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || keyVersion > MAX_KEY_ID)
    return res.status(400).json({ error: 'Invalid keyVersion' });
  if (typeof algorithm !== 'string' || !E2E_ALGORITHMS.has(algorithm))
    return res.status(400).json({ error: 'Invalid algorithm' });

  await Users.updateWhere(
    { _id: req.user.id },
    { $set: {
      e2ePublicKey:   publicKey,
      e2eKeyVersion:  keyVersion,
      e2eAlgorithm:   algorithm,
      e2eKeyUpdatedAt: Date.now(),
    }}
  );

  res.json({ ok: true, message: 'Public key registered. Private key never leaves your device.' });
});

// GET /api/e2e/keys/:userId — bir kullanıcının public key'ini al
router.get('/keys/:userId', authMiddleware, async (req, res) => {
  const user = await Users.findById(String(req.params.userId ?? ''));
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.e2ePublicKey) {
    return res.json({ hasKey: false, message: 'User has not set up E2EE yet' });
  }

  res.json({
    hasKey:     true,
    userId:     user._id,
    publicKey:  user.e2ePublicKey,
    keyVersion: user.e2eKeyVersion || 1,
    algorithm:  user.e2eAlgorithm || 'X25519',
    updatedAt:  user.e2eKeyUpdatedAt,
  });
});

// GET /api/e2e/keys/batch — birden fazla kullanıcının public key'ini al
router.post('/keys/batch', authMiddleware, async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length > 50)
    return res.status(400).json({ error: 'userIds must be array, max 50' });

  const users = await Users.findByIds(userIds);
  const result: Record<string, { hasKey: true; publicKey: string; keyVersion: number; algorithm: string } | { hasKey: false }> = {};
  users.forEach(u => {
    result[u._id] = u.e2ePublicKey ? {
      hasKey:     true,
      publicKey:  u.e2ePublicKey,
      keyVersion: u.e2eKeyVersion || 1,
      algorithm:  u.e2eAlgorithm || 'X25519',
    } : { hasKey: false };
  });

  res.json(result);
});

// DELETE /api/e2e/keys — E2EE'yi kapat (key sil)
router.delete('/keys', authMiddleware, async (req, res) => {
  await Users.updateWhere(
    { _id: req.user.id },
    { $set: { e2ePublicKey: null, e2eKeyUpdatedAt: Date.now() } }
  );
  res.json({ ok: true, message: 'E2EE keys removed' });
});

/**
 * GET /api/e2e/feature-status — üretim özellik bayrağı (kimlik gerekmez)
 *
 * ── FAZ D0: VARSAYILAN KAPALI (AÇIK RIZA GEREKİR) ─────────────────────────
 * Bayrak Sprint 115'te varsayılan AÇIK yapılmıştı. Ölçülen gerçek şuydu:
 * istemci HİÇBİR şifreleme yapmıyor — `crypto.subtle` yok, `encryptedContent`
 * üretilmiyor, sunucudaki anahtar değişim olaylarını (`channel:e2ee:setup`,
 * `keys:get`, `keys:add`) çağıran TEK BİR istemci dosyası yok ve cihaz
 * kimliği/anahtar dağıtımı için tablo yok. Yani bayrak açıkken kullanıcıya
 * "uçtan uca şifreleme aktif" denip mesajlar DÜZ METİN olarak saklanıyordu.
 *
 * Eksik bir özellik olmaktan farklı olarak bu YANILTICIDIR: kullanıcı hassas
 * bilgiyi şifreli sanarak paylaşabilir. Bu yüzden bayrak açık rıza ister.
 *
 * Arka uç iskelesi (anahtar değişim rotaları/olayları, `encryptedContent`/`iv`
 * sütunları, migration'lar) KASITLI olarak korunur — gelecekteki gerçek
 * mimari için gereklidir. Durum: E2EE = ARCHITECTURE_REQUIRED.
 */
router.get('/feature-status', (_req, res) => {
  res.json({ enabled: process.env.BRIDGE_E2EE_ENABLED === 'true' });
});

// GET /api/e2e/status — E2EE durumu
router.get('/status', authMiddleware, async (req, res) => {
  const user = await Users.findById(req.user.id);
  const enabled = !!user?.e2ePublicKey;
  res.json({
    enabled,
    keyVersion: enabled ? (user?.e2eKeyVersion || 1) : null,
    algorithm:  enabled ? (user?.e2eAlgorithm || 'X25519') : null,
    updatedAt:  enabled ? (user?.e2eKeyUpdatedAt || null) : null,
    info: 'Your private key never leaves your device. The server only stores your public key.',
  });
});

// ─────────────────────────────────────────────────────────────
// X3DH — Extended Triple Diffie-Hellman (Signal Protocol)
// Sunucu: signed prekey + one-time prekey bundle saklama
// ─────────────────────────────────────────────────────────────
// Kullanıcı başına prekey bundle kaydeder:
//   identityKey (uzun ömürlü), signedPreKey + signature, oneTimePreKeys[]
// Mesaj göndericisi bundle'ı alır, X3DH ile paylaşılan sır türetir.

// POST /api/e2e/prekeys — prekey bundle yükle
router.post('/prekeys', authMiddleware, async (req, res) => {
  const {
    identityKey,    // base64 — uzun ömürlü kimlik anahtarı (public)
    signedPreKey,   // { keyId, publicKey, signature } — sunucuda imzalanmış
    oneTimePreKeys, // [{ keyId, publicKey }, ...] — tek kullanımlık
  } = req.body;

  if (!identityKey || !signedPreKey?.publicKey || !signedPreKey?.signature) {
    return res.status(400).json({ error: 'identityKey, signedPreKey (publicKey+signature) gerekli' });
  }
  if (!validBoundedString(identityKey, 256)) {
    return res.status(400).json({ error: 'Geçersiz identityKey' });
  }
  if (!validSignedPreKey(signedPreKey)) {
    return res.status(400).json({ error: 'Geçersiz signedPreKey' });
  }
  if (oneTimePreKeys !== undefined && !Array.isArray(oneTimePreKeys)) {
    return res.status(400).json({ error: 'oneTimePreKeys array olmalı' });
  }

  // one-time prekey sayısı sınırı; malformed entries are rejected instead of
  // being persisted and failing later during a security-sensitive key fetch.
  if (Array.isArray(oneTimePreKeys) && oneTimePreKeys.length > 100) {
    return res.status(400).json({ error: 'En fazla 100 oneTimePreKey yüklenebilir' });
  }
  const otpks = Array.isArray(oneTimePreKeys) ? oneTimePreKeys : [];
  if (!otpks.every(validOneTimePreKey)) {
    return res.status(400).json({ error: 'Geçersiz oneTimePreKey' });
  }
  const keyIds = new Set(otpks.map((key) => key.keyId));
  const publicKeys = new Set(otpks.map((key) => key.publicKey));
  if (keyIds.size !== otpks.length || publicKeys.size !== otpks.length) {
    return res.status(400).json({ error: 'oneTimePreKey kimlikleri ve anahtarları benzersiz olmalı' });
  }

  await Users.updateWhere({ _id: req.user.id }, {
    $set: {
      x3dhIdentityKey:   identityKey,
      x3dhSignedPreKey:  signedPreKey,
      x3dhOneTimePreKeys: otpks,
      x3dhUpdatedAt:     Date.now(),
    },
  });

  res.json({ ok: true, oneTimePreKeysStored: otpks.length });
});

// GET /api/e2e/prekeys/:userId — prekey bundle al (bir one-time key tüketilir)
router.get('/prekeys/:userId', authMiddleware, async (req, res) => {
  const targetId = String(req.params.userId ?? '');
  const target = await Users.findById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (targetId !== req.user.id) {
    const access = await evaluateDmAccess(req.user.id, target);
    if (!access.allowed) return res.status(403).json({ error: 'DM key access is not allowed' });
  }
  const bundle = await Users.consumeX3dhPreKeyBundle(targetId);
  if (!bundle) return res.status(404).json({ error: 'User not found' });
  if (bundle.invalidState) return res.status(503).json({ error: 'Stored X3DH bundle is invalid' });

  if (!validBoundedString(bundle.identityKey, 256) || !validSignedPreKey(bundle.signedPreKey)) {
    return res.json({ hasBundle: false, message: 'Kullanıcı X3DH prekey bundle kurmamış' });
  }
  if (bundle.oneTimePreKey !== null && !validOneTimePreKey(bundle.oneTimePreKey)) {
    return res.status(503).json({ error: 'Stored X3DH bundle is invalid' });
  }

  res.json({
    hasBundle:    true,
    userId:       bundle._id,
    identityKey:  bundle.identityKey,
    signedPreKey: bundle.signedPreKey,
    oneTimePreKey: bundle.oneTimePreKey, // null olabilir — gönderici bunu handle etmeli
    remainingOneTimeKeys: bundle.remainingOneTimeKeys,
  });
});

// GET /api/e2e/prekeys/:userId/count — kaç one-time prekey kaldı (replenish sinyali)
router.get('/prekeys/:userId/count', authMiddleware, async (req, res) => {
  if (req.user.id !== String(req.params.userId ?? '')) return res.status(403).json({ error: 'Forbidden' });
  const user = await Users.findById(String(req.params.userId ?? ''));
  const stored = user?.x3dhOneTimePreKeys;
  if (stored !== undefined && (!Array.isArray(stored) || stored.length > 100 || !stored.every(validOneTimePreKey))) {
    return res.status(503).json({ error: 'Stored X3DH prekey state is invalid' });
  }
  const count = Array.isArray(stored) ? stored.length : 0;
  res.json({
    count,
    needsReplenish: count < 10, // < 10 kalınca istemciye bildir
  });
});

export { router };
// Aşağıdaki kodu client/js/core/e2e.js dosyasına kopyala:
/*
// client/js/core/e2e.ts İstemci Tarafı E2EE
// Web Crypto API kullanır (tüm modern tarayıcılarda desteklenir)

window.BridgeE2E = (() => {
  const DB_NAME    = 'BridgeE2E';
  const DB_VERSION = 1;
  const STORE_NAME = 'keys';

  // IndexedDB'ye private key'i sakla (localStorage'dan güvenli)
  async function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function savePrivateKey(userId: string, privateKey: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ id: `pk_${userId}`, privateKey });
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function loadPrivateKey(userId: string): Promise<string | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(`pk_${userId}`);
      req.onsuccess = () => resolve(req.result?.privateKey || null);
      req.onerror   = () => reject(req.error);
    });
  }

  // Anahtar çifti üret (X25519 / ECDH)
  async function generateKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, // P-256 geniş destek için
      true,
      ['deriveKey', 'deriveBits']
    );

    const publicKeyRaw  = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    return {
      publicKey:  btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw))),
      privateKey: btoa(String.fromCharCode(...new Uint8Array(privateKeyRaw))),
      keyPair,
    };
  }

  // Mesaj şifrele (alıcının public key'i ile)
  async function encryptMessage(plaintext: string, recipientPublicKeyB64: string): Promise<string> {
    // Alıcının public key'ini import et
    const recipientKeyData = Uint8Array.from(atob(recipientPublicKeyB64), c => c.charCodeAt(0));
    const recipientKey = await crypto.subtle.importKey(
      'spki', recipientKeyData, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );

    // Ephemeral anahtar çifti üret (her mesaj için farklı)
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
    );

    // Paylaşılan sır türet
    const sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: recipientKey },
      ephemeral.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    // AES-GCM ile şifrele
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded);

    // Ephemeral public key'i export et
    const ephPublicRaw = await crypto.subtle.exportKey('spki', ephemeral.publicKey);
    const ephPublicB64 = btoa(String.fromCharCode(...new Uint8Array(ephPublicRaw)));

    return {
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
      iv:         btoa(String.fromCharCode(...iv)),
      ephPublicKey: ephPublicB64,
      version:    1,
    };
  }

  // Mesaj şifre çöz (kendi private key'i ile)
  async function decryptMessage(encrypted: string, myPrivateKeyB64: string): Promise<string> {
    const { ciphertext, iv: ivB64, ephPublicKey } = encrypted;

    // Kendi private key'ini import et
    const privateKeyData = Uint8Array.from(atob(myPrivateKeyB64), c => c.charCodeAt(0));
    const myPrivateKey = await crypto.subtle.importKey(
      'pkcs8', privateKeyData, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']
    );

    // Ephemeral public key'i import et
    const ephKeyData = Uint8Array.from(atob(ephPublicKey), c => c.charCodeAt(0));
    const ephKey = await crypto.subtle.importKey(
      'spki', ephKeyData, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );

    // Paylaşılan sır türet
    const sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: ephKey },
      myPrivateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    // Şifre çöz
    const iv          = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const ciphertextBuf = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const plainBuf    = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, ciphertextBuf);

    return new TextDecoder().decode(plainBuf);
  }

  // Kurulum: anahtar çifti oluştur ve sunucuya public key gönder
  async function setup(userId: string, apiToken: string, apiBase: string): Promise<void> {
    const existing = await loadPrivateKey(userId);
    if (existing) {
      logger.debug({ event: 'e2e.key_exists' }, 'E2EE anahtarı zaten mevcut.');
      return { alreadySetup: true };
    }

    const { publicKey, privateKey } = await generateKeyPair();

    // Private key'i IndexedDB'ye kaydet
    await savePrivateKey(userId, privateKey);

    // Public key'i sunucuya gönder
    const res = await fetch(`${apiBase}/api/e2e/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ publicKey, algorithm: 'P-256' }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error('Failed to register public key');

    logger.info({ event: 'e2e.setup_complete' }, 'E2EE kurulumu tamamlandı.');
    return { success: true };
  }

  // DM şifreleme için yardımcı
  async function encryptDM(plaintext: string, recipientId: string, myUserId: string, apiToken: string, apiBase: string): Promise<string> {
    // Alıcının public key'ini al
    const res = await fetch(`${apiBase}/api/e2e/keys/${recipientId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (!data.hasKey) return { encrypted: false, content: plaintext }; // E2EE kurmamış

    const encrypted = await encryptMessage(plaintext, data.publicKey);
    return { encrypted: true, e2e: encrypted, content: '🔒 Şifreli mesaj' };
  }

  async function decryptDM(e2eData: Record<string, unknown>, myUserId: string): Promise<string> {
    const privateKey = await loadPrivateKey(myUserId);
    if (!privateKey) return null; // Key bulunamadı
    return decryptMessage(e2eData, privateKey);
  }

  return { generateKeyPair, encryptMessage, decryptMessage, setup, encryptDM, decryptDM, savePrivateKey, loadPrivateKey };
})();
*/
