// @ts-nocheck
// server/lib/e2e.js Uçtan Uca Şifreleme (E2EE)
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

const crypto = require('crypto');
const express = require('express');
const router  = express.Router();
const { Users } = require('../db/repositories');
const { authMiddleware } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// ─────────────────────────────────────────────────────────────
// SUNUCU TARAFI: Sadece public key saklama/alma
// Private key asla sunucuya gelmez
// ─────────────────────────────────────────────────────────────

// POST /api/e2e/keys — kullanıcının public key'ini kaydet
router.post('/keys', authMiddleware, asyncHandler(async (req, res) => {
  const { publicKey, keyVersion = 1, algorithm = 'X25519' } = req.body;
  if (!publicKey) return res.status(400).json({ error: 'publicKey required' });
  if (typeof publicKey !== 'string' || publicKey.length > 200)
    return res.status(400).json({ error: 'Invalid publicKey format' });

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
}));

// GET /api/e2e/keys/:userId — bir kullanıcının public key'ini al
router.get('/keys/:userId', authMiddleware, asyncHandler(async (req, res) => {
  const user = await Users.findById(req.params.userId);
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
}));

// GET /api/e2e/keys/batch — birden fazla kullanıcının public key'ini al
router.post('/keys/batch', authMiddleware, asyncHandler(async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length > 50)
    return res.status(400).json({ error: 'userIds must be array, max 50' });

  const users = await Users.findByIds(userIds);
  const result = {};
  users.forEach(u => {
    result[u._id] = u.e2ePublicKey ? {
      hasKey:     true,
      publicKey:  u.e2ePublicKey,
      keyVersion: u.e2eKeyVersion || 1,
      algorithm:  u.e2eAlgorithm || 'X25519',
    } : { hasKey: false };
  });

  res.json(result);
}));

// DELETE /api/e2e/keys — E2EE'yi kapat (key sil)
router.delete('/keys', authMiddleware, asyncHandler(async (req, res) => {
  await Users.updateWhere(
    { _id: req.user.id },
    { $set: { e2ePublicKey: null, e2eKeyVersion: null, e2eAlgorithm: null } }
  );
  res.json({ ok: true, message: 'E2EE keys removed' });
}));

// GET /api/e2e/status — E2EE durumu
router.get('/status', authMiddleware, asyncHandler(async (req, res) => {
  const user = await Users.findById(req.user.id);
  res.json({
    enabled:    !!user?.e2ePublicKey,
    keyVersion: user?.e2eKeyVersion || null,
    algorithm:  user?.e2eAlgorithm || null,
    updatedAt:  user?.e2eKeyUpdatedAt || null,
    info: 'Your private key never leaves your device. The server only stores your public key.',
  });
}));

// ─────────────────────────────────────────────────────────────
// X3DH — Extended Triple Diffie-Hellman (Signal Protocol)
// Sunucu: signed prekey + one-time prekey bundle saklama
// ─────────────────────────────────────────────────────────────
// Kullanıcı başına prekey bundle kaydeder:
//   identityKey (uzun ömürlü), signedPreKey + signature, oneTimePreKeys[]
// Mesaj göndericisi bundle'ı alır, X3DH ile paylaşılan sır türetir.

// POST /api/e2e/prekeys — prekey bundle yükle
router.post('/prekeys', authMiddleware, asyncHandler(async (req, res) => {
  const {
    identityKey,    // base64 — uzun ömürlü kimlik anahtarı (public)
    signedPreKey,   // { keyId, publicKey, signature } — sunucuda imzalanmış
    oneTimePreKeys, // [{ keyId, publicKey }, ...] — tek kullanımlık
  } = req.body;

  if (!identityKey || !signedPreKey?.publicKey || !signedPreKey?.signature) {
    return res.status(400).json({ error: 'identityKey, signedPreKey (publicKey+signature) gerekli' });
  }
  if (typeof identityKey !== 'string' || identityKey.length > 256) {
    return res.status(400).json({ error: 'Geçersiz identityKey' });
  }

  // one-time prekey sayısı sınırı
  const otpks = Array.isArray(oneTimePreKeys)
    ? oneTimePreKeys.slice(0, 100)
    : [];

  await Users.updateWhere({ _id: req.user.id }, {
    $set: {
      x3dhIdentityKey:   identityKey,
      x3dhSignedPreKey:  signedPreKey,
      x3dhOneTimePreKeys: otpks,
      x3dhUpdatedAt:     Date.now(),
    },
  });

  res.json({ ok: true, oneTimePreKeysStored: otpks.length });
}));

// GET /api/e2e/prekeys/:userId — prekey bundle al (bir one-time key tüketilir)
router.get('/prekeys/:userId', authMiddleware, asyncHandler(async (req, res) => {
  const user = await Users.findById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.x3dhIdentityKey) {
    return res.json({ hasBundle: false, message: 'Kullanıcı X3DH prekey bundle kurmamış' });
  }

  // Bir one-time prekey tüket (varsa)
  let oneTimePreKey = null;
  const otpks = user.x3dhOneTimePreKeys || [];
  if (otpks.length > 0) {
    oneTimePreKey = otpks[0];
    // Kullanılan one-time key'i listeden çıkar
    await Users.updateWhere({ _id: user._id }, {
      $set: { x3dhOneTimePreKeys: otpks.slice(1) },
    });
  }

  res.json({
    hasBundle:    true,
    userId:       user._id,
    identityKey:  user.x3dhIdentityKey,
    signedPreKey: user.x3dhSignedPreKey,
    oneTimePreKey,                        // null olabilir — gönderici bunu handle etmeli
    remainingOneTimeKeys: otpks.length - (oneTimePreKey ? 1 : 0),
  });
}));

// GET /api/e2e/prekeys/:userId/count — kaç one-time prekey kaldı (replenish sinyali)
router.get('/prekeys/:userId/count', authMiddleware, asyncHandler(async (req, res) => {
  if (req.user.id !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });
  const user = await Users.findById(req.params.userId);
  const count = user?.x3dhOneTimePreKeys?.length ?? 0;
  res.json({
    count,
    needsReplenish: count < 10, // < 10 kalınca istemciye bildir
  });
}));

module.exports = { router };
// Aşağıdaki kodu client/js/core/e2e.js dosyasına kopyala:
/*
// client/js/core/e2e.js İstemci Tarafı E2EE
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

  async function savePrivateKey(userId, privateKey) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ id: `pk_${userId}`, privateKey });
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function loadPrivateKey(userId) {
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
  async function encryptMessage(plaintext, recipientPublicKeyB64) {
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
  async function decryptMessage(encrypted, myPrivateKeyB64) {
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
  async function setup(userId, apiToken, apiBase) {
    const existing = await loadPrivateKey(userId);
    if (existing) {
      console.log('[E2EE] Key already exists for this user');
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
    });

    if (!res.ok) throw new Error('Failed to register public key');

    console.log('[E2EE] ✅ Setup complete. Private key stays on your device.');
    return { success: true };
  }

  // DM şifreleme için yardımcı
  async function encryptDM(plaintext, recipientId, myUserId, apiToken, apiBase) {
    // Alıcının public key'ini al
    const res = await fetch(`${apiBase}/api/e2e/keys/${recipientId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const data = await res.json();
    if (!data.hasKey) return { encrypted: false, content: plaintext }; // E2EE kurmamış

    const encrypted = await encryptMessage(plaintext, data.publicKey);
    return { encrypted: true, e2e: encrypted, content: '🔒 Şifreli mesaj' };
  }

  async function decryptDM(e2eData, myUserId) {
    const privateKey = await loadPrivateKey(myUserId);
    if (!privateKey) return null; // Key bulunamadı
    return decryptMessage(e2eData, privateKey);
  }

  return { generateKeyPair, encryptMessage, decryptMessage, setup, encryptDM, decryptDM, savePrivateKey, loadPrivateKey };
})();
*/
